//! Commands for the footer-only structure view.
//!
//! A bounded MRU cache retains decoded footers and Structure readers by source
//! generation. Sessions own identity and jobs; commands clone a cached handle
//! before doing work so eviction never invalidates an active command.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use serde::Serialize;
use viewda_data_engine::{
    MAX_BLOOM_PROBE_VALUE_BYTES, SourceIdentity, SourceSnapshot, StructureBloomProbe,
    StructureByteUnit, StructureCancellation, StructureChunkDetails, StructureColumnPage,
    StructureColumnSort, StructureError, StructureKeyValue, StructureLayout, StructureLensTotals,
    StructureLoadProgress, StructureLoadSnapshot, StructureReader, StructureRowGroupPage,
    StructureRowGroupSort, StructureSortDirection, StructureSummary,
};

use crate::{OpenedSource, OpenedSourceSession, SessionWork};

// Each entry owns a file handle and decoded metadata; bound both dimensions.
const STRUCTURE_CACHE_MAX_ENTRIES: usize = 8;
const STRUCTURE_CACHE_MAX_FOOTER_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
enum CachedStructure {
    Snapshot(Arc<SourceSnapshot>),
    Reader(Arc<StructureReader>),
    #[cfg(test)]
    Placeholder,
}

struct StructureCacheEntry {
    generation: u64,
    footer_bytes: u64,
    value: CachedStructure,
}

/// Bounded strong ownership of decoded Structure metadata for every open source.
#[derive(Default)]
pub(crate) struct StructureCache {
    entries: VecDeque<StructureCacheEntry>,
    footer_bytes: u64,
}

impl StructureCache {
    fn get(&mut self, generation: u64) -> Option<CachedStructure> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.generation == generation)?;
        let entry = self.entries.remove(index)?;
        let value = entry.value.clone();
        self.entries.push_back(entry);
        Some(value)
    }

    pub(crate) fn touch(&mut self, generation: u64) -> bool {
        self.get(generation).is_some()
    }

    pub(crate) fn remember_snapshot(
        &mut self,
        generation: u64,
        source_identity: Option<&SourceIdentity>,
        snapshot: Arc<SourceSnapshot>,
    ) -> bool {
        if source_identity != Some(snapshot.identity()) {
            return false;
        }
        if !self.touch(generation) {
            self.insert(
                generation,
                snapshot.footer_bytes(),
                CachedStructure::Snapshot(snapshot),
            );
        }
        true
    }

    fn replace_with_reader(&mut self, generation: u64, reader: Arc<StructureReader>) {
        self.insert(
            generation,
            reader.summary().footer_bytes,
            CachedStructure::Reader(reader),
        );
    }

    pub(crate) fn remove(&mut self, generation: u64) {
        let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.generation == generation)
        else {
            return;
        };
        if let Some(entry) = self.entries.remove(index) {
            self.footer_bytes = self
                .footer_bytes
                .checked_sub(entry.footer_bytes)
                .expect("Structure cache byte accounting stays balanced");
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.footer_bytes = 0;
    }

    fn insert(&mut self, generation: u64, footer_bytes: u64, value: CachedStructure) {
        self.remove(generation);
        assert!(
            footer_bytes <= STRUCTURE_CACHE_MAX_FOOTER_BYTES,
            "the data engine bounds every retained footer"
        );
        while self.entries.len() >= STRUCTURE_CACHE_MAX_ENTRIES
            || self
                .footer_bytes
                .checked_add(footer_bytes)
                .is_none_or(|total| total > STRUCTURE_CACHE_MAX_FOOTER_BYTES)
        {
            let entry = self
                .entries
                .pop_front()
                .expect("an individually bounded entry eventually fits the cache");
            self.footer_bytes = self
                .footer_bytes
                .checked_sub(entry.footer_bytes)
                .expect("Structure cache byte accounting stays balanced");
        }
        self.footer_bytes = self
            .footer_bytes
            .checked_add(footer_bytes)
            .expect("the cache budget prevents byte accounting overflow");
        self.entries.push_back(StructureCacheEntry {
            generation,
            footer_bytes,
            value,
        });
    }

    #[cfg(test)]
    fn insert_placeholder(&mut self, generation: u64, footer_bytes: u64) {
        self.insert(generation, footer_bytes, CachedStructure::Placeholder);
    }

    #[cfg(test)]
    fn generations(&self) -> Vec<u64> {
        self.entries.iter().map(|entry| entry.generation).collect()
    }
}

/// Stable failures exposed by every structure command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub(crate) enum StructureCommandError {
    NoSourceOpen,
    SourceChanged,
    NotLoaded,
    Cancelled,
    NotFound,
    PermissionDenied,
    NotParquet,
    CorruptFooter,
    Unsupported,
    UnknownRowGroup,
    UnknownColumn,
    UnknownKeyValue,
    InvalidProbeValue,
    UnsupportedProbeColumn,
}

impl From<StructureError> for StructureCommandError {
    fn from(error: StructureError) -> Self {
        match error {
            StructureError::NotFound => Self::NotFound,
            StructureError::PermissionDenied => Self::PermissionDenied,
            StructureError::SourceChanged => Self::SourceChanged,
            StructureError::NotParquet => Self::NotParquet,
            StructureError::CorruptFooter => Self::CorruptFooter,
            StructureError::Unsupported => Self::Unsupported,
            StructureError::Cancelled => Self::Cancelled,
            StructureError::UnknownRowGroup => Self::UnknownRowGroup,
            StructureError::UnknownColumn => Self::UnknownColumn,
            StructureError::UnknownKeyValue => Self::UnknownKeyValue,
            StructureError::InvalidProbeValue => Self::InvalidProbeValue,
            StructureError::UnsupportedProbeColumn => Self::UnsupportedProbeColumn,
        }
    }
}

struct ActiveStructureJob {
    generation: u64,
    request: Option<String>,
    progress: StructureLoadProgress,
    cancellation: StructureCancellation,
}

/// The one footer parse and the one bloom probe that may be in flight per source.
#[derive(Default)]
pub(crate) struct StructureJobs {
    load: Mutex<Option<ActiveStructureJob>>,
    probe: Mutex<Option<ActiveStructureJob>>,
}

impl StructureJobs {
    /// Registers a job and cancels whichever job it replaces.
    ///
    /// A replaced job recognises itself by its own cancellation flag, so it never
    /// clears the registry entry its successor now owns.
    fn start(
        slot: &Mutex<Option<ActiveStructureJob>>,
        generation: u64,
        request: Option<&str>,
    ) -> Result<ActiveStructureJob, StructureCommandError> {
        let job = ActiveStructureJob {
            generation,
            request: request.map(str::to_owned),
            progress: StructureLoadProgress::default(),
            cancellation: StructureCancellation::default(),
        };
        let previous = slot
            .lock()
            .map_err(|_| StructureCommandError::Unsupported)?
            .replace(ActiveStructureJob {
                generation,
                request: job.request.clone(),
                progress: job.progress.clone(),
                cancellation: job.cancellation.clone(),
            });
        if let Some(previous) = previous {
            previous.cancellation.cancel();
        }
        Ok(job)
    }

    fn finish(slot: &Mutex<Option<ActiveStructureJob>>, job: &ActiveStructureJob) {
        if job.cancellation.is_cancelled() {
            return;
        }
        if let Ok(mut active) = slot.lock()
            && active.as_ref().is_some_and(|current| {
                current.generation == job.generation && current.request == job.request
            })
        {
            active.take();
        }
    }

    fn cancel(slot: &Mutex<Option<ActiveStructureJob>>, generation: u64, request: Option<&str>) {
        let Ok(mut active) = slot.lock() else {
            return;
        };
        if active.as_ref().is_some_and(|current| {
            current.generation == generation && current.request.as_deref() == request
        }) && let Some(job) = active.take()
        {
            job.cancellation.cancel();
        }
    }

    /// Stops every structure job, used when the opened source is replaced or closed.
    pub(crate) fn cancel_all(&self) {
        for slot in [&self.load, &self.probe] {
            if let Ok(mut active) = slot.lock()
                && let Some(job) = active.take()
            {
                job.cancellation.cancel();
            }
        }
    }
}

fn start_session_job(
    session: &OpenedSourceSession,
    slot: &Mutex<Option<ActiveStructureJob>>,
    request: Option<&str>,
) -> Result<ActiveStructureJob, StructureCommandError> {
    let job = StructureJobs::start(slot, session.generation, request)?;
    let closing = session
        .lifecycle
        .state
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?
        .closing;
    if closing {
        StructureJobs::cancel(slot, session.generation, request);
        return Err(StructureCommandError::Cancelled);
    }
    Ok(job)
}

fn capture_session(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<(Arc<OpenedSourceSession>, SessionWork), StructureCommandError> {
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| StructureCommandError::Unsupported)?;
        state.session(generation).ok_or_else(|| {
            state.missing_session(
                StructureCommandError::NoSourceOpen,
                StructureCommandError::SourceChanged,
            )
        })?
    };
    let work = session.begin_work().map_err(|error| match error {
        viewda_data_engine::DataWindowError::Cancelled => StructureCommandError::Cancelled,
        _ => StructureCommandError::Unsupported,
    })?;
    Ok((session, work))
}

fn cached_structure(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<Option<CachedStructure>, StructureCommandError> {
    Ok(opened_source
        .structure_cache
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?
        .get(generation))
}

enum StructureLoadRequest {
    Cached(Arc<StructureReader>),
    Start {
        snapshot: Option<Arc<SourceSnapshot>>,
        job: ActiveStructureJob,
    },
}

fn register_structure_load(
    opened_source: &OpenedSource,
    session: &OpenedSourceSession,
) -> Result<StructureLoadRequest, StructureCommandError> {
    let cached = {
        let mut cache = opened_source
            .structure_cache
            .lock()
            .map_err(|_| StructureCommandError::Unsupported)?;
        let cached = cache.get(session.generation);
        if matches!(
            cached,
            Some(CachedStructure::Snapshot(ref snapshot))
                if session.source_identity.as_ref() != Some(snapshot.identity())
        ) {
            cache.remove(session.generation);
            return Err(StructureCommandError::SourceChanged);
        }
        cached
    };
    match cached {
        Some(CachedStructure::Reader(reader)) => Ok(StructureLoadRequest::Cached(reader)),
        cached => Ok(StructureLoadRequest::Start {
            snapshot: match cached {
                Some(CachedStructure::Snapshot(snapshot)) => Some(snapshot),
                None => None,
                #[cfg(test)]
                Some(CachedStructure::Placeholder) => None,
                Some(CachedStructure::Reader(_)) => unreachable!("reader handled above"),
            },
            job: start_session_job(session, &session.structure_jobs.load, None)?,
        }),
    }
}

fn structure_reader_and_job(
    opened_source: &OpenedSource,
    session: &OpenedSourceSession,
    request: &str,
    slot: &Mutex<Option<ActiveStructureJob>>,
) -> Result<(Arc<StructureReader>, ActiveStructureJob), StructureCommandError> {
    let reader = structure_reader(opened_source, session.generation)?;
    let job = start_session_job(session, slot, Some(request))?;
    Ok((reader, job))
}

fn structure_reader(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<Arc<StructureReader>, StructureCommandError> {
    match cached_structure(opened_source, generation)? {
        Some(CachedStructure::Reader(reader)) => Ok(reader),
        Some(CachedStructure::Snapshot(_)) | None => Err(StructureCommandError::NotLoaded),
        #[cfg(test)]
        Some(CachedStructure::Placeholder) => Err(StructureCommandError::NotLoaded),
    }
}

fn install_structure(
    opened_source: &OpenedSource,
    session: &OpenedSourceSession,
    reader: StructureReader,
    validate_reopened_source: bool,
) -> Result<Arc<StructureReader>, StructureCommandError> {
    if validate_reopened_source {
        validate_structure_source(session)?;
    }
    let state = opened_source
        .state
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?;
    if state.session(session.generation).is_none() {
        return Err(StructureCommandError::Cancelled);
    }
    let reader = Arc::new(reader);
    opened_source
        .structure_cache
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?
        .replace_with_reader(session.generation, Arc::clone(&reader));
    Ok(reader)
}

struct StructureLoadOutcome {
    snapshot: Option<Arc<SourceSnapshot>>,
    reader: Result<StructureReader, StructureCommandError>,
    reopened: bool,
}

fn validate_structure_source(session: &OpenedSourceSession) -> Result<(), StructureCommandError> {
    session
        .validate_source_identity()
        .map_err(|_| StructureCommandError::SourceChanged)
}

fn build_structure_reader(
    session: &OpenedSourceSession,
    cached_snapshot: Option<Arc<SourceSnapshot>>,
    progress: &StructureLoadProgress,
    cancellation: &StructureCancellation,
) -> StructureLoadOutcome {
    let reopened = cached_snapshot.is_none();
    let snapshot = match cached_snapshot {
        Some(snapshot) if session.source_identity.as_ref() == Some(snapshot.identity()) => snapshot,
        Some(_) => {
            return StructureLoadOutcome {
                snapshot: None,
                reader: Err(StructureCommandError::SourceChanged),
                reopened,
            };
        }
        None => {
            if let Err(error) = validate_structure_source(session) {
                return StructureLoadOutcome {
                    snapshot: None,
                    reader: Err(error),
                    reopened,
                };
            }
            match SourceSnapshot::open_cancellable(&session.path, |_| !cancellation.is_cancelled())
            {
                Ok(Some(snapshot))
                    if session
                        .source_identity
                        .as_ref()
                        .is_none_or(|identity| identity == snapshot.identity()) =>
                {
                    Arc::new(snapshot)
                }
                Ok(Some(_)) => {
                    return StructureLoadOutcome {
                        snapshot: None,
                        reader: Err(StructureCommandError::SourceChanged),
                        reopened,
                    };
                }
                Ok(None) => {
                    return StructureLoadOutcome {
                        snapshot: None,
                        reader: Err(StructureCommandError::Cancelled),
                        reopened,
                    };
                }
                Err(error) => {
                    return StructureLoadOutcome {
                        snapshot: None,
                        reader: Err(StructureCommandError::from(StructureError::from(error))),
                        reopened,
                    };
                }
            }
        }
    };
    let mut reader = StructureReader::from_snapshot(&snapshot, progress, cancellation)
        .map_err(StructureCommandError::from);
    if reopened
        && reader.is_ok()
        && let Err(error) = validate_structure_source(session)
    {
        reader = Err(error);
    }
    StructureLoadOutcome {
        snapshot: Some(snapshot),
        reader,
        reopened,
    }
}

fn restore_structure_snapshot(
    opened_source: &OpenedSource,
    session: &OpenedSourceSession,
    snapshot: Option<Arc<SourceSnapshot>>,
    reopened: bool,
) -> Result<(), StructureCommandError> {
    let Some(snapshot) = snapshot else {
        return Ok(());
    };
    if reopened && validate_structure_source(session).is_err() {
        return Ok(());
    }
    let state = opened_source
        .state
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?;
    if state.session(session.generation).is_some() {
        opened_source
            .structure_cache
            .lock()
            .map_err(|_| StructureCommandError::Unsupported)?
            .remember_snapshot(
                session.generation,
                session.source_identity.as_ref(),
                snapshot,
            );
    }
    Ok(())
}

/// Parses the footer of the opened source and caches it for every later query.
#[tauri::command]
pub(crate) async fn get_structure_summary(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureSummary, StructureCommandError> {
    let (session, _work) = capture_session(&opened_source, generation)?;
    let (snapshot, job) = match register_structure_load(&opened_source, &session)? {
        StructureLoadRequest::Cached(reader) => return Ok(reader.summary().clone()),
        StructureLoadRequest::Start { snapshot, job } => (snapshot, job),
    };
    let progress = job.progress.clone();
    let cancellation = job.cancellation.clone();
    let fallback_snapshot = snapshot.clone();
    let worker_session = Arc::clone(&session);
    let result = tauri::async_runtime::spawn_blocking(move || {
        build_structure_reader(&worker_session, snapshot, &progress, &cancellation)
    })
    .await;
    StructureJobs::finish(&session.structure_jobs.load, &job);
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(_) => {
            restore_structure_snapshot(
                &opened_source,
                &session,
                fallback_snapshot.clone(),
                fallback_snapshot.is_none(),
            )?;
            return Err(StructureCommandError::Unsupported);
        }
    };
    if job.cancellation.is_cancelled() {
        restore_structure_snapshot(&opened_source, &session, outcome.snapshot, outcome.reopened)?;
        return Err(StructureCommandError::Cancelled);
    }
    let reopened = outcome.reopened;
    let reader = match outcome.reader {
        Ok(reader) => reader,
        Err(error) => {
            restore_structure_snapshot(
                &opened_source,
                &session,
                outcome.snapshot,
                outcome.reopened,
            )?;
            return Err(error);
        }
    };
    Ok(
        install_structure(&opened_source, &session, reader, reopened)?
            .summary()
            .clone(),
    )
}

/// Reports how far the running footer parse has come.
#[tauri::command]
pub(crate) fn get_structure_load_progress(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Option<StructureLoadSnapshot> {
    let session = opened_source.state.lock().ok()?.session(generation)?;
    session
        .structure_jobs
        .load
        .lock()
        .ok()?
        .as_ref()
        .filter(|job| job.generation == generation)
        .map(|job| job.progress.snapshot())
}

/// Interrupts the running footer parse for an opened-source generation.
#[tauri::command]
pub(crate) fn cancel_structure_load(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) {
    if let Some(session) = opened_source
        .state
        .lock()
        .ok()
        .and_then(|state| state.session(generation))
    {
        StructureJobs::cancel(&session.structure_jobs.load, generation, None);
    }
}

/// Returns the legend totals of every structure lens.
#[tauri::command]
pub(crate) fn get_structure_lens_totals(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureLensTotals, StructureCommandError> {
    let (_session, _work) = capture_session(&opened_source, generation)?;
    Ok(structure_reader(&opened_source, generation)?
        .lens_totals()
        .clone())
}

/// Returns a bounded window of rows in one whole-file column order.
#[tauri::command]
pub(crate) async fn get_structure_layout(
    generation: u64,
    unit: StructureByteUnit,
    row_offset: usize,
    row_limit: usize,
    column_limit: usize,
    focused_column: Option<usize>,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureLayout, StructureCommandError> {
    let (_session, work) = capture_session(&opened_source, generation)?;
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        reader.layout(unit, row_offset, row_limit, column_limit, focused_column)
    })
    .await
    .map_err(|_| StructureCommandError::Unsupported)
}

/// Returns a bounded window of the row-group table.
#[tauri::command]
pub(crate) async fn get_structure_row_groups(
    generation: u64,
    unit: StructureByteUnit,
    sort: StructureRowGroupSort,
    direction: StructureSortDirection,
    offset: usize,
    limit: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureRowGroupPage, StructureCommandError> {
    let (_session, work) = capture_session(&opened_source, generation)?;
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        reader.row_group_page(unit, sort, direction, offset, limit)
    })
    .await
    .map_err(|_| StructureCommandError::Unsupported)
}

/// Returns a bounded window of the columns table.
#[tauri::command]
pub(crate) async fn get_structure_columns(
    generation: u64,
    unit: StructureByteUnit,
    sort: StructureColumnSort,
    direction: StructureSortDirection,
    offset: usize,
    limit: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureColumnPage, StructureCommandError> {
    let (_session, work) = capture_session(&opened_source, generation)?;
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        reader.column_page(unit, sort, direction, offset, limit)
    })
    .await
    .map_err(|_| StructureCommandError::Unsupported)
}

/// Returns everything the chunk panel states about one column chunk.
#[tauri::command]
pub(crate) fn get_structure_chunk(
    generation: u64,
    row_group_index: usize,
    column_index: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureChunkDetails, StructureCommandError> {
    let (_session, _work) = capture_session(&opened_source, generation)?;
    structure_reader(&opened_source, generation)?
        .chunk_details(row_group_index, column_index)
        .map_err(StructureCommandError::from)
}

/// Returns one key-value metadata value, which the summary deliberately omits.
#[tauri::command]
pub(crate) fn get_structure_key_value(
    generation: u64,
    index: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureKeyValue, StructureCommandError> {
    let (_session, _work) = capture_session(&opened_source, generation)?;
    structure_reader(&opened_source, generation)?
        .key_value(index)
        .map_err(StructureCommandError::from)
}

/// Returns the source row a row group starts at, for opening Data there.
#[tauri::command]
pub(crate) fn get_structure_row_offset(
    generation: u64,
    row_group_index: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<u64, StructureCommandError> {
    let (session, _work) = capture_session(&opened_source, generation)?;
    session
        .validate_source_identity()
        .map_err(|_| StructureCommandError::SourceChanged)?;
    structure_reader(&opened_source, generation)?
        .first_row_offset(row_group_index)
        .map_err(StructureCommandError::from)
}

/// Builds the bounded, path-free Markdown digest copied from Structure mode.
#[tauri::command]
pub(crate) async fn get_structure_report(
    generation: u64,
    unit: StructureByteUnit,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<String, StructureCommandError> {
    let (_session, work) = capture_session(&opened_source, generation)?;
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        reader.report(unit)
    })
    .await
    .map_err(|_| StructureCommandError::Unsupported)
}

/// Asks a bounded run of row groups whether their bloom filters admit a value.
#[tauri::command]
pub(crate) async fn probe_structure_bloom_filter(
    generation: u64,
    request: String,
    column_index: usize,
    value: String,
    offset: usize,
    limit: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureBloomProbe, StructureCommandError> {
    if value.len() > MAX_BLOOM_PROBE_VALUE_BYTES {
        return Err(StructureCommandError::InvalidProbeValue);
    }
    let (session, work) = capture_session(&opened_source, generation)?;
    let (reader, job) = structure_reader_and_job(
        &opened_source,
        &session,
        &request,
        &session.structure_jobs.probe,
    )?;
    let cancellation = job.cancellation.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        reader.probe_bloom_filter(column_index, &value, offset, limit, &cancellation)
    })
    .await;
    StructureJobs::finish(&session.structure_jobs.probe, &job);
    if job.cancellation.is_cancelled() {
        return Err(StructureCommandError::Cancelled);
    }

    result
        .map_err(|_| StructureCommandError::Unsupported)?
        .map_err(StructureCommandError::from)
}

/// Interrupts the running bloom probe for an opened-source generation.
#[tauri::command]
pub(crate) fn cancel_structure_bloom_probe(
    generation: u64,
    request: String,
    opened_source: tauri::State<'_, OpenedSource>,
) {
    if let Some(session) = opened_source
        .state
        .lock()
        .ok()
        .and_then(|state| state.session(generation))
    {
        StructureJobs::cancel(&session.structure_jobs.probe, generation, Some(&request));
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use viewda_data_engine::{
        SourceSummary, StructureBloomProbeOutcome, StructureBloomProbeResult,
        StructureChunkStatistics, StructureCodecTotal, StructureColumnSummary,
        StructureKeyValueEntry, StructureLayoutColumn, StructureLayoutRow, StructureLayoutSegment,
        StructureLayoutTail, StructureLensTotal, StructurePresenceTotals, StructureRatioStep,
        StructureRowGroupSummary, inspect_local_source_snapshot,
    };

    use super::*;
    use crate::SourceOpenIntent;

    #[test]
    fn command_errors_keep_stable_wire_codes() {
        let codes = [
            StructureCommandError::NoSourceOpen,
            StructureCommandError::SourceChanged,
            StructureCommandError::NotLoaded,
            StructureCommandError::Cancelled,
            StructureCommandError::NotFound,
            StructureCommandError::PermissionDenied,
            StructureCommandError::NotParquet,
            StructureCommandError::CorruptFooter,
            StructureCommandError::Unsupported,
            StructureCommandError::UnknownRowGroup,
            StructureCommandError::UnknownColumn,
            StructureCommandError::UnknownKeyValue,
            StructureCommandError::InvalidProbeValue,
            StructureCommandError::UnsupportedProbeColumn,
        ];

        assert_eq!(
            serde_json::to_value(codes).expect("serializable command errors"),
            serde_json::json!([
                { "code": "noSourceOpen" },
                { "code": "sourceChanged" },
                { "code": "notLoaded" },
                { "code": "cancelled" },
                { "code": "notFound" },
                { "code": "permissionDenied" },
                { "code": "notParquet" },
                { "code": "corruptFooter" },
                { "code": "unsupported" },
                { "code": "unknownRowGroup" },
                { "code": "unknownColumn" },
                { "code": "unknownKeyValue" },
                { "code": "invalidProbeValue" },
                { "code": "unsupportedProbeColumn" }
            ])
        );
    }

    #[test]
    fn engine_failures_map_onto_command_codes() {
        assert_eq!(
            StructureCommandError::from(StructureError::CorruptFooter),
            StructureCommandError::CorruptFooter
        );
        assert_eq!(
            StructureCommandError::from(StructureError::Cancelled),
            StructureCommandError::Cancelled
        );
        assert_eq!(
            StructureCommandError::from(StructureError::UnsupportedProbeColumn),
            StructureCommandError::UnsupportedProbeColumn
        );
    }

    #[test]
    fn the_file_card_summary_keeps_its_camel_case_wire_shape() {
        let summary = StructureSummary {
            compressed_bytes: 2_000,
            uncompressed_bytes: 6_000,
            compression_ratio: Some(3.0),
            format_version: 2,
            created_by: Some("parquet-mr version 1.13.1".to_owned()),
            row_count: 96,
            row_group_count: 8,
            column_count: 12,
            rows_per_row_group: Some(12.0),
            footer_bytes: 1_312,
            codecs: vec!["snappy".to_owned(), "zstd".to_owned()],
            chunk_count: 96,
            chunks_with_statistics: 96,
            chunks_with_bloom_filter: 8,
            unreadable_row_group_count: 1,
            key_value_count: 3,
            key_value_metadata: vec![StructureKeyValueEntry {
                index: 0,
                key: "pandas".to_owned(),
                value_bytes: Some(4_096),
            }],
            strings_truncated: false,
        };

        assert_eq!(
            serde_json::to_value(summary).expect("serializable summary"),
            serde_json::json!({
                "compressedBytes": 2_000,
                "uncompressedBytes": 6_000,
                "compressionRatio": 3.0,
                "formatVersion": 2,
                "createdBy": "parquet-mr version 1.13.1",
                "rowCount": 96,
                "rowGroupCount": 8,
                "columnCount": 12,
                "rowsPerRowGroup": 12.0,
                "footerBytes": 1_312,
                "codecs": ["snappy", "zstd"],
                "chunkCount": 96,
                "chunksWithStatistics": 96,
                "chunksWithBloomFilter": 8,
                "unreadableRowGroupCount": 1,
                "keyValueCount": 3,
                "keyValueMetadata": [
                    { "index": 0, "key": "pandas", "valueBytes": 4_096 }
                ],
                "stringsTruncated": false
            })
        );
    }

    #[test]
    fn lens_legends_keep_their_camel_case_wire_shape() {
        let totals = StructureLensTotals {
            codecs: vec![StructureCodecTotal {
                codec: "zstd".to_owned(),
                total: StructureLensTotal {
                    chunk_count: 4,
                    compressed_bytes: 100,
                    uncompressed_bytes: 400,
                },
            }],
            ratio_steps: vec![
                StructureRatioStep {
                    max_ratio: Some(1.1),
                    total: StructureLensTotal {
                        chunk_count: 1,
                        compressed_bytes: 90,
                        uncompressed_bytes: 95,
                    },
                },
                StructureRatioStep {
                    max_ratio: None,
                    total: StructureLensTotal {
                        chunk_count: 3,
                        compressed_bytes: 10,
                        uncompressed_bytes: 305,
                    },
                },
            ],
            unrated: StructureLensTotal {
                chunk_count: 2,
                compressed_bytes: 0,
                uncompressed_bytes: 64,
            },
            statistics: StructurePresenceTotals {
                present: StructureLensTotal {
                    chunk_count: 4,
                    compressed_bytes: 100,
                    uncompressed_bytes: 400,
                },
                absent: StructureLensTotal::default(),
            },
            bloom_filters: StructurePresenceTotals {
                present: StructureLensTotal::default(),
                absent: StructureLensTotal {
                    chunk_count: 4,
                    compressed_bytes: 100,
                    uncompressed_bytes: 400,
                },
            },
        };

        assert_eq!(
            serde_json::to_value(totals).expect("serializable lens totals"),
            serde_json::json!({
                "codecs": [{
                    "codec": "zstd",
                    "total": {
                        "chunkCount": 4,
                        "compressedBytes": 100,
                        "uncompressedBytes": 400
                    }
                }],
                "ratioSteps": [
                    {
                        "maxRatio": 1.1,
                        "total": {
                            "chunkCount": 1,
                            "compressedBytes": 90,
                            "uncompressedBytes": 95
                        }
                    },
                    {
                        "maxRatio": null,
                        "total": {
                            "chunkCount": 3,
                            "compressedBytes": 10,
                            "uncompressedBytes": 305
                        }
                    }
                ],
                "unrated": {
                    "chunkCount": 2,
                    "compressedBytes": 0,
                    "uncompressedBytes": 64
                },
                "statistics": {
                    "present": {
                        "chunkCount": 4,
                        "compressedBytes": 100,
                        "uncompressedBytes": 400
                    },
                    "absent": {
                        "chunkCount": 0,
                        "compressedBytes": 0,
                        "uncompressedBytes": 0
                    }
                },
                "bloomFilters": {
                    "present": {
                        "chunkCount": 0,
                        "compressedBytes": 0,
                        "uncompressedBytes": 0
                    },
                    "absent": {
                        "chunkCount": 4,
                        "compressedBytes": 100,
                        "uncompressedBytes": 400
                    }
                }
            })
        );
    }

    #[test]
    fn layout_rows_keep_their_camel_case_wire_shape() {
        let layout = StructureLayout {
            columns: vec![StructureLayoutColumn {
                column_index: 3,
                column_name: "profile.city".to_owned(),
            }],
            remaining_column_count: 11,
            overview: Vec::new(),
            rows: vec![StructureLayoutRow {
                index: 2,
                compressed_bytes: 500,
                uncompressed_bytes: 1_500,
                is_readable: true,
                has_layout_facts: true,
                segments: vec![StructureLayoutSegment {
                    column_index: 3,
                    column_name: "profile.city".to_owned(),
                    compressed_bytes: 400,
                    uncompressed_bytes: 1_200,
                    compression_ratio: Some(3.0),
                    share: 0.8,
                    codec: "zstd".to_owned(),
                    encodings: vec!["PLAIN".to_owned(), "RLE_DICTIONARY".to_owned()],
                    has_statistics: true,
                    has_bloom_filter: false,
                    has_page_index: true,
                }],
                tail: Some(StructureLayoutTail {
                    column_count: 11,
                    compressed_bytes: 100,
                    uncompressed_bytes: 300,
                    share: 0.2,
                    has_bloom_filter: true,
                }),
            }],
        };

        assert_eq!(
            serde_json::to_value(layout).expect("serializable layout"),
            serde_json::json!({
                "columns": [{
                    "columnIndex": 3,
                    "columnName": "profile.city"
                }],
                "remainingColumnCount": 11,
                "overview": [],
                "rows": [{
                    "index": 2,
                    "compressedBytes": 500,
                    "uncompressedBytes": 1_500,
                    "isReadable": true,
                    "hasLayoutFacts": true,
                    "segments": [{
                        "columnIndex": 3,
                        "columnName": "profile.city",
                        "compressedBytes": 400,
                        "uncompressedBytes": 1_200,
                        "compressionRatio": 3.0,
                        "share": 0.8,
                        "codec": "zstd",
                        "encodings": ["PLAIN", "RLE_DICTIONARY"],
                        "hasStatistics": true,
                        "hasBloomFilter": false,
                        "hasPageIndex": true
                    }],
                    "tail": {
                        "columnCount": 11,
                        "compressedBytes": 100,
                        "uncompressedBytes": 300,
                        "share": 0.2,
                        "hasBloomFilter": true
                    }
                }]
            })
        );
    }

    #[test]
    fn table_pages_keep_their_camel_case_wire_shape() {
        let row_groups = StructureRowGroupPage {
            offset: 0,
            total_count: 2,
            row_groups: vec![StructureRowGroupSummary {
                index: 0,
                row_count: 12,
                compressed_bytes: 500,
                uncompressed_bytes: 1_500,
                compression_ratio: Some(3.0),
                chunk_count: 12,
                chunks_with_bloom_filter: 1,
                is_readable: false,
                has_layout_facts: true,
            }],
        };
        let columns = StructureColumnPage {
            offset: 0,
            total_count: 1,
            columns: vec![StructureColumnSummary {
                name: "id".to_owned(),
                physical_type: "INT64".to_owned(),
                logical_type: None,
                compressed_bytes: 500,
                uncompressed_bytes: 1_500,
                compression_ratio: Some(3.0),
                encodings: vec!["PLAIN".to_owned()],
                cumulative_share: 1.0,
            }],
        };

        assert_eq!(
            serde_json::to_value(row_groups).expect("serializable row-group page"),
            serde_json::json!({
                "offset": 0,
                "totalCount": 2,
                "rowGroups": [{
                    "index": 0,
                    "rowCount": 12,
                    "compressedBytes": 500,
                    "uncompressedBytes": 1_500,
                    "compressionRatio": 3.0,
                    "chunkCount": 12,
                    "chunksWithBloomFilter": 1,
                    "isReadable": false,
                    "hasLayoutFacts": true
                }]
            })
        );
        assert_eq!(
            serde_json::to_value(columns).expect("serializable column page"),
            serde_json::json!({
                "offset": 0,
                "totalCount": 1,
                "columns": [{
                    "name": "id",
                    "physicalType": "INT64",
                    "logicalType": null,
                    "compressedBytes": 500,
                    "uncompressedBytes": 1_500,
                    "compressionRatio": 3.0,
                    "encodings": ["PLAIN"],
                    "cumulativeShare": 1.0
                }]
            })
        );
    }

    #[test]
    fn chunk_details_keep_their_camel_case_wire_shape() {
        let details = StructureChunkDetails {
            column_index: 2,
            column_name: "profile.city".to_owned(),
            physical_type: "BYTE_ARRAY".to_owned(),
            codec: "snappy".to_owned(),
            encodings: vec!["RLE_DICTIONARY".to_owned()],
            value_count: 1_000,
            compressed_bytes: 400,
            uncompressed_bytes: 1_200,
            compression_ratio: Some(3.0),
            data_page_offset: 4_120,
            dictionary_page_offset: Some(4_000),
            bloom_filter_bytes: Some(2_048),
            has_bloom_filter: true,
            column_has_bloom_filter: true,
            has_page_index: true,
            has_offset_index: false,
            statistics: Some(StructureChunkStatistics {
                minimum: Some("Helsinki".to_owned()),
                maximum: Some("Kyoto".to_owned()),
                minimum_is_exact: true,
                maximum_is_exact: false,
                null_count: Some(3),
                distinct_count: None,
            }),
        };

        assert_eq!(
            serde_json::to_value(details).expect("serializable chunk details"),
            serde_json::json!({
                "columnIndex": 2,
                "columnName": "profile.city",
                "physicalType": "BYTE_ARRAY",
                "codec": "snappy",
                "encodings": ["RLE_DICTIONARY"],
                "valueCount": 1_000,
                "compressedBytes": 400,
                "uncompressedBytes": 1_200,
                "compressionRatio": 3.0,
                "dataPageOffset": 4_120,
                "dictionaryPageOffset": 4_000,
                "bloomFilterBytes": 2_048,
                "hasBloomFilter": true,
                "columnHasBloomFilter": true,
                "hasPageIndex": true,
                "hasOffsetIndex": false,
                "statistics": {
                    "minimum": "Helsinki",
                    "maximum": "Kyoto",
                    "minimumIsExact": true,
                    "maximumIsExact": false,
                    "nullCount": 3,
                    "distinctCount": null
                }
            })
        );
    }

    #[test]
    fn probes_progress_and_key_values_keep_their_camel_case_wire_shape() {
        let probe = StructureBloomProbe {
            offset: 0,
            total_count: 3,
            row_groups: vec![
                StructureBloomProbeResult {
                    index: 0,
                    outcome: StructureBloomProbeOutcome::MayContain,
                },
                StructureBloomProbeResult {
                    index: 1,
                    outcome: StructureBloomProbeOutcome::DefinitelyAbsent,
                },
                StructureBloomProbeResult {
                    index: 2,
                    outcome: StructureBloomProbeOutcome::NoFilter,
                },
            ],
        };

        assert_eq!(
            serde_json::to_value(probe).expect("serializable probe"),
            serde_json::json!({
                "offset": 0,
                "totalCount": 3,
                "rowGroups": [
                    { "index": 0, "outcome": "mayContain" },
                    { "index": 1, "outcome": "definitelyAbsent" },
                    { "index": 2, "outcome": "noFilter" }
                ]
            })
        );
        assert_eq!(
            serde_json::to_value(StructureLoadSnapshot {
                completed_row_groups: 40,
                total_row_groups: 96,
                completed_chunks: 400,
                total_chunks: 960,
            })
            .expect("serializable progress"),
            serde_json::json!({
                "completedRowGroups": 40,
                "totalRowGroups": 96,
                "completedChunks": 400,
                "totalChunks": 960
            })
        );
        assert_eq!(
            serde_json::to_value(StructureKeyValue {
                index: 0,
                key: "pandas".to_owned(),
                value: Some("{}".to_owned()),
                is_truncated: true,
            })
            .expect("serializable key-value"),
            serde_json::json!({
                "index": 0,
                "key": "pandas",
                "value": "{}",
                "isTruncated": true
            })
        );
    }

    #[test]
    fn command_arguments_arrive_in_camel_case() {
        assert_eq!(
            serde_json::from_value::<StructureByteUnit>(serde_json::json!("uncompressed"))
                .expect("byte unit"),
            StructureByteUnit::Uncompressed
        );
        assert_eq!(
            serde_json::from_value::<StructureSortDirection>(serde_json::json!("descending"))
                .expect("sort direction"),
            StructureSortDirection::Descending
        );
        assert_eq!(
            serde_json::from_value::<StructureRowGroupSort>(serde_json::json!("bloomFilters"))
                .expect("row-group sort"),
            StructureRowGroupSort::BloomFilters
        );
        assert_eq!(
            serde_json::from_value::<StructureColumnSort>(serde_json::json!("compressionRatio"))
                .expect("column sort"),
            StructureColumnSort::CompressionRatio
        );
    }

    #[test]
    fn a_new_job_cancels_the_one_it_replaces() {
        let jobs = StructureJobs::default();

        let first = StructureJobs::start(&jobs.load, 1, None).expect("first job registers");
        let second = StructureJobs::start(&jobs.load, 1, None).expect("second job registers");

        assert!(first.cancellation.is_cancelled());
        assert!(!second.cancellation.is_cancelled());

        StructureJobs::finish(&jobs.load, &first);
        assert!(
            jobs.load.lock().expect("job registry").is_some(),
            "a cancelled job never clears its successor's entry"
        );

        StructureJobs::finish(&jobs.load, &second);
        assert!(jobs.load.lock().expect("job registry").is_none());
    }

    #[test]
    fn probe_cancellation_only_reaches_the_named_request() {
        let jobs = StructureJobs::default();
        let first =
            StructureJobs::start(&jobs.probe, 4, Some("request-a")).expect("first job registers");
        let second =
            StructureJobs::start(&jobs.probe, 4, Some("request-b")).expect("second job registers");

        assert!(first.cancellation.is_cancelled());
        StructureJobs::cancel(&jobs.probe, 4, Some("request-a"));
        assert!(!second.cancellation.is_cancelled());
        assert!(jobs.probe.lock().expect("job registry").is_some());

        StructureJobs::cancel(&jobs.probe, 4, Some("request-b"));
        assert!(second.cancellation.is_cancelled());
        assert!(jobs.probe.lock().expect("job registry").is_none());
    }

    #[test]
    fn closing_a_source_stops_every_structure_job() {
        let jobs = StructureJobs::default();
        let load = StructureJobs::start(&jobs.load, 1, None).expect("load registers");
        let probe = StructureJobs::start(&jobs.probe, 1, Some("probe")).expect("probe registers");

        jobs.cancel_all();

        assert!(load.cancellation.is_cancelled());
        assert!(probe.cancellation.is_cancelled());
    }

    #[test]
    fn structure_cache_is_bounded_by_count_and_exact_footer_bytes() {
        let mut cache = StructureCache::default();
        cache.insert_placeholder(1, STRUCTURE_CACHE_MAX_FOOTER_BYTES);
        assert_eq!(cache.generations(), vec![1]);
        assert_eq!(cache.footer_bytes, STRUCTURE_CACHE_MAX_FOOTER_BYTES);

        cache.insert_placeholder(2, 1);
        assert_eq!(cache.generations(), vec![2]);
        assert_eq!(cache.footer_bytes, 1);

        cache.insert_placeholder(2, STRUCTURE_CACHE_MAX_FOOTER_BYTES / 2);
        assert_eq!(cache.generations(), vec![2]);
        assert_eq!(
            cache.footer_bytes,
            STRUCTURE_CACHE_MAX_FOOTER_BYTES / 2,
            "replacing a generation never double-counts its footer"
        );

        let mut cache = StructureCache::default();
        for generation in 1..=STRUCTURE_CACHE_MAX_ENTRIES as u64 {
            cache.insert_placeholder(generation, 0);
        }
        assert!(cache.touch(1));
        cache.insert_placeholder(9, 0);
        assert_eq!(cache.generations(), vec![3, 4, 5, 6, 7, 8, 1, 9]);
        assert_eq!(cache.footer_bytes, 0);
    }

    #[test]
    fn duplicate_activation_touches_cache_and_close_removes_only_its_generation() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let first_path = directory.path().join("first.parquet");
        let second_path = directory.path().join("second.parquet");
        write_empty_parquet(&first_path);
        write_empty_parquet(&second_path);
        let opened_source = OpenedSource::default();
        let first = install_snapshot(&opened_source, first_path.clone());
        let second = install_snapshot(&opened_source, second_path);

        let reopened = install_snapshot(&opened_source, first_path);
        assert_eq!(reopened.generation, first.generation);
        assert_eq!(
            opened_source
                .structure_cache
                .lock()
                .expect("Structure cache")
                .generations(),
            vec![second.generation, first.generation]
        );

        assert!(opened_source.close(first.generation).expect("close first"));
        assert_eq!(
            opened_source
                .structure_cache
                .lock()
                .expect("Structure cache")
                .generations(),
            vec![second.generation]
        );
    }

    #[test]
    fn reopening_a_replaced_path_creates_and_then_reuses_the_new_identity() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let path = directory.path().join("source.parquet");
        write_empty_parquet(&path);
        let opened_source = OpenedSource::default();
        let first = install_snapshot(&opened_source, path.clone());
        let first_session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(first.generation)
            .expect("first source session");

        let replacement = directory.path().join("replacement.parquet");
        write_empty_parquet(&replacement);
        fs::rename(replacement, &path).expect("replace source path");
        let second = install_snapshot(&opened_source, path.clone());

        assert_ne!(second.generation, first.generation);
        assert_eq!(
            validate_structure_source(&first_session),
            Err(StructureCommandError::SourceChanged),
            "the replaced path never changes the identity owned by A"
        );
        let second_session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(second.generation)
            .expect("second source session");
        assert_eq!(validate_structure_source(&second_session), Ok(()));
        assert_ne!(
            first_session.source_identity,
            second_session.source_identity
        );
        assert_eq!(
            opened_source
                .structure_cache
                .lock()
                .expect("Structure cache")
                .generations(),
            vec![first.generation, second.generation]
        );

        let reopened = install_snapshot(&opened_source, path);
        assert_eq!(reopened.generation, second.generation);
        assert_eq!(
            opened_source
                .state
                .lock()
                .expect("source state")
                .sessions
                .len(),
            2,
            "a later open of B reactivates B without resurrecting A"
        );
    }

    #[test]
    fn a_snapshot_with_another_identity_cannot_enter_or_load_from_the_cache() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let first_path = directory.path().join("first.parquet");
        let second_path = directory.path().join("second.parquet");
        write_empty_parquet(&first_path);
        write_empty_parquet(&second_path);
        let opened_source = OpenedSource::default();
        let first = install_snapshot(&opened_source, first_path);
        let session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(first.generation)
            .expect("source session");
        let (_, second_snapshot) =
            inspect_local_source_snapshot(&second_path).expect("second snapshot");
        let second_snapshot = Arc::new(second_snapshot);

        {
            let mut cache = opened_source
                .structure_cache
                .lock()
                .expect("Structure cache");
            cache.remove(first.generation);
            assert!(!cache.remember_snapshot(
                first.generation,
                session.source_identity.as_ref(),
                Arc::clone(&second_snapshot),
            ));
            assert!(!cache.generations().contains(&first.generation));

            // Simulate a poisoned old cache entry to defend the load seam too.
            cache.insert(
                first.generation,
                second_snapshot.footer_bytes(),
                CachedStructure::Snapshot(Arc::clone(&second_snapshot)),
            );
        }

        assert!(matches!(
            register_structure_load(&opened_source, &session),
            Err(StructureCommandError::SourceChanged)
        ));
        assert!(
            !opened_source
                .structure_cache
                .lock()
                .expect("Structure cache")
                .generations()
                .contains(&first.generation),
            "a rejected snapshot is removed before any later command can use it"
        );
        assert_eq!(
            build_structure_reader(
                &session,
                Some(second_snapshot),
                &StructureLoadProgress::default(),
                &StructureCancellation::default(),
            )
            .reader
            .err(),
            Some(StructureCommandError::SourceChanged)
        );
    }

    #[test]
    fn cache_miss_reopens_only_the_same_source_identity() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let path = directory.path().join("source.parquet");
        write_empty_parquet(&path);
        let opened_source = OpenedSource::default();
        let opened = install_snapshot(&opened_source, path.clone());
        let cached_snapshot = {
            let mut cache = opened_source
                .structure_cache
                .lock()
                .expect("Structure cache");
            let snapshot = match cache.get(opened.generation) {
                Some(CachedStructure::Snapshot(snapshot)) => snapshot,
                _ => panic!("source open caches its footer snapshot"),
            };
            cache.remove(opened.generation);
            snapshot
        };
        let session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(opened.generation)
            .expect("source session");

        let reader = build_structure_reader(
            &session,
            None,
            &StructureLoadProgress::default(),
            &StructureCancellation::default(),
        )
        .reader
        .expect("an evicted source reopens transparently");
        install_structure(&opened_source, &session, reader, true)
            .expect("reopened reader installs");
        assert!(matches!(
            opened_source
                .structure_cache
                .lock()
                .expect("Structure cache")
                .get(opened.generation),
            Some(CachedStructure::Reader(_))
        ));

        let replacement = directory.path().join("replacement.parquet");
        write_empty_parquet(&replacement);
        fs::rename(replacement, path).expect("replace source path");
        assert!(
            build_structure_reader(
                &session,
                Some(cached_snapshot),
                &StructureLoadProgress::default(),
                &StructureCancellation::default(),
            )
            .reader
            .is_ok(),
            "a retained snapshot still owns the file that was opened"
        );
        assert_eq!(
            build_structure_reader(
                &session,
                None,
                &StructureLoadProgress::default(),
                &StructureCancellation::default(),
            )
            .reader
            .err(),
            Some(StructureCommandError::SourceChanged),
            "an evicted source never publishes a replacement file"
        );
    }

    #[test]
    fn cache_miss_rejects_an_in_place_source_change() {
        use std::io::Write;

        let directory = tempfile::tempdir().expect("fixture directory");
        let path = directory.path().join("source.parquet");
        write_empty_parquet(&path);
        let opened_source = OpenedSource::default();
        let opened = install_snapshot(&opened_source, path.clone());
        opened_source
            .structure_cache
            .lock()
            .expect("Structure cache")
            .remove(opened.generation);
        let session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(opened.generation)
            .expect("source session");
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open source for mutation")
            .write_all(&[0])
            .expect("mutate source in place");

        assert_eq!(
            build_structure_reader(
                &session,
                None,
                &StructureLoadProgress::default(),
                &StructureCancellation::default(),
            )
            .reader
            .err(),
            Some(StructureCommandError::SourceChanged)
        );
    }

    #[test]
    fn closing_one_source_cancels_only_its_structure_jobs() {
        let opened_source = OpenedSource::default();
        let first = opened_source
            .install(
                None,
                PathBuf::from("first.parquet"),
                empty_source_summary("first.parquet"),
                SourceOpenIntent::Explicit,
            )
            .expect("first source installs")
            .expect("first source opens");
        let second = opened_source
            .install(
                None,
                PathBuf::from("second.parquet"),
                empty_source_summary("second.parquet"),
                SourceOpenIntent::Explicit,
            )
            .expect("second source installs")
            .expect("second source opens");
        let (first_session, second_session) = {
            let state = opened_source.state.lock().expect("source state");
            (
                state.session(first.generation).expect("first session"),
                state.session(second.generation).expect("second session"),
            )
        };
        let first_job =
            StructureJobs::start(&first_session.structure_jobs.load, first.generation, None)
                .expect("first load registers");
        let second_job =
            StructureJobs::start(&second_session.structure_jobs.load, second.generation, None)
                .expect("second load registers");

        assert!(opened_source.close(first.generation).expect("close first"));

        assert!(first_job.cancellation.is_cancelled());
        assert!(!second_job.cancellation.is_cancelled());
        assert!(
            opened_source
                .state
                .lock()
                .expect("source state")
                .session(second.generation)
                .is_some()
        );
    }

    #[test]
    fn a_job_registered_after_close_starts_is_rejected() {
        let opened_source = OpenedSource::default();
        let opened = opened_source
            .install(
                None,
                PathBuf::from("closing.parquet"),
                empty_source_summary("closing.parquet"),
                SourceOpenIntent::Explicit,
            )
            .expect("source installs")
            .expect("source opens");
        let session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(opened.generation)
            .expect("source session");
        let _work = session.begin_work().expect("work registers before close");
        session.lifecycle.start_closing();

        assert!(matches!(
            register_structure_load(&opened_source, &session),
            Err(StructureCommandError::Cancelled)
        ));
        assert!(
            session
                .structure_jobs
                .load
                .lock()
                .expect("load registry")
                .is_none()
        );
    }

    fn empty_source_summary(display_name: &str) -> SourceSummary {
        SourceSummary {
            display_name: display_name.to_owned(),
            size_bytes: 8,
            row_count: 0,
            row_group_count: 0,
            column_count: 0,
            schema: Vec::new(),
            schema_node_count: 0,
            schema_is_truncated: false,
            strings_truncated: false,
        }
    }

    fn install_snapshot(opened_source: &OpenedSource, path: PathBuf) -> crate::OpenedSourceInfo {
        let (summary, snapshot) = inspect_local_source_snapshot(&path).expect("fixture snapshot");
        opened_source
            .install_with_snapshot(
                None,
                path,
                summary,
                Some(snapshot),
                SourceOpenIntent::Explicit,
                None,
            )
            .expect("source install")
            .expect("source opens")
    }

    fn write_empty_parquet(path: &std::path::Path) {
        const EMPTY_PARQUET: &[u8] = &[
            80, 65, 82, 49, 21, 2, 25, 28, 72, 6, 115, 99, 104, 101, 109, 97, 21, 0, 0, 22, 0, 25,
            12, 40, 25, 112, 97, 114, 113, 117, 101, 116, 45, 114, 115, 32, 118, 101, 114, 115,
            105, 111, 110, 32, 53, 56, 46, 52, 46, 48, 25, 12, 0, 49, 0, 0, 0, 80, 65, 82, 49,
        ];
        fs::write(path, EMPTY_PARQUET).expect("write empty Parquet fixture");
    }
}
