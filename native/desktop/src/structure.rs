//! Commands for the footer-only structure view.
//!
//! Source open retains its one decoded footer and file handle on the session.
//! Structure adds cancellable per-chunk facts to that snapshot, then keeps the
//! resulting reader for the tables, layout, chunk panel, and bloom probes.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use viewda_data_engine::{
    DatasetError, DatasetMemberSummary, SourceSnapshot, StructureBloomProbe, StructureByteUnit,
    StructureCancellation, StructureChunkDetails, StructureColumnPage, StructureColumnSort,
    StructureError, StructureKeyValue, StructureLayout, StructureLensTotals, StructureLoadProgress,
    StructureLoadSnapshot, StructureReader, StructureRowGroupPage, StructureRowGroupSort,
    StructureSortDirection, StructureSummary,
};

use crate::{DatasetSessionPhase, OpenedSource, OpenedSourceSession, SessionWindowReader};

/// Stable failures exposed by every structure command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub(crate) enum StructureCommandError {
    NoSourceOpen,
    SourceChanged,
    NotReady,
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
    ) -> Result<ActiveStructureJob, StructureCommandError> {
        let job = ActiveStructureJob {
            generation,
            progress: StructureLoadProgress::default(),
            cancellation: StructureCancellation::default(),
        };
        let previous = slot
            .lock()
            .map_err(|_| StructureCommandError::Unsupported)?
            .replace(ActiveStructureJob {
                generation,
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
            && active
                .as_ref()
                .is_some_and(|current| current.generation == job.generation)
        {
            active.take();
        }
    }

    fn cancel(slot: &Mutex<Option<ActiveStructureJob>>, generation: u64) {
        let Ok(mut active) = slot.lock() else {
            return;
        };
        if active
            .as_ref()
            .is_some_and(|current| current.generation == generation)
            && let Some(job) = active.take()
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

fn structure_session(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<Arc<OpenedSourceSession>, StructureCommandError> {
    let state = opened_source
        .state
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?;
    state.session(generation).ok_or_else(|| {
        state.missing_session(
            StructureCommandError::NoSourceOpen,
            StructureCommandError::SourceChanged,
        )
    })
}

fn map_session_error(error: viewda_data_engine::DataWindowError) -> StructureCommandError {
    match error {
        viewda_data_engine::DataWindowError::Cancelled => StructureCommandError::Cancelled,
        _ => StructureCommandError::Unsupported,
    }
}

enum StructureLoadRequest {
    Cached(Arc<StructureReader>),
    Start {
        snapshot: StructureSnapshotPlan,
        job: ActiveStructureJob,
    },
}

enum StructureSnapshotPlan {
    File(Option<Arc<SourceSnapshot>>),
    Dataset {
        reader: Arc<Mutex<viewda_data_engine::DatasetWindowReader>>,
        ordinal: u64,
    },
}

fn map_dataset_error(error: DatasetError) -> StructureCommandError {
    match error {
        DatasetError::SourceChanged { .. } => StructureCommandError::SourceChanged,
        DatasetError::InvalidMember { .. } => StructureCommandError::CorruptFooter,
        DatasetError::Cancelled => StructureCommandError::Cancelled,
        DatasetError::NotFound => StructureCommandError::NotFound,
        DatasetError::PermissionDenied => StructureCommandError::PermissionDenied,
        _ => StructureCommandError::Unsupported,
    }
}

fn register_structure_load(
    session: &OpenedSourceSession,
    generation: u64,
) -> Result<StructureLoadRequest, StructureCommandError> {
    // Closing takes the lifecycle lock before cancelling jobs. Registration
    // under that lock is therefore either rejected or visible to cancellation.
    session
        .with_open_state(|state| match &state.structure {
            Some(reader) => Ok(StructureLoadRequest::Cached(Arc::clone(reader))),
            None => {
                let snapshot = match &state.reader {
                    SessionWindowReader::File(_) => {
                        StructureSnapshotPlan::File(state.source_snapshot.as_ref().map(Arc::clone))
                    }
                    SessionWindowReader::Dataset(dataset) => match &dataset.phase {
                        DatasetSessionPhase::Ready { reader, .. } => {
                            StructureSnapshotPlan::Dataset {
                                reader: Arc::clone(reader),
                                ordinal: state.structure_member_ordinal,
                            }
                        }
                        DatasetSessionPhase::Inspecting { .. } => {
                            return Err(StructureCommandError::NotReady);
                        }
                        DatasetSessionPhase::Failed(error) => {
                            return Err(map_dataset_error(error.clone()));
                        }
                    },
                };
                Ok(StructureLoadRequest::Start {
                    snapshot,
                    job: StructureJobs::start(&session.structure_jobs.load, generation)?,
                })
            }
        })
        .map_err(map_session_error)?
}

fn structure_reader_and_job(
    session: &OpenedSourceSession,
    generation: u64,
) -> Result<(Arc<StructureReader>, ActiveStructureJob), StructureCommandError> {
    session
        .with_open_state(|state| {
            let reader = state
                .structure
                .as_ref()
                .map(Arc::clone)
                .ok_or(StructureCommandError::NotLoaded)?;
            let job = StructureJobs::start(&session.structure_jobs.probe, generation)?;
            Ok((reader, job))
        })
        .map_err(map_session_error)?
}

fn structure_reader(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<Arc<StructureReader>, StructureCommandError> {
    let session = structure_session(opened_source, generation)?;
    let state = session
        .state
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?;
    state
        .structure
        .as_ref()
        .map(Arc::clone)
        .ok_or(StructureCommandError::NotLoaded)
}

fn install_structure(
    opened_source: &OpenedSource,
    generation: u64,
    reader: StructureReader,
    member_ordinal: Option<u64>,
) -> Result<Arc<StructureReader>, StructureCommandError> {
    let session = structure_session(opened_source, generation)?;
    session
        .with_open_state(|state| {
            if member_ordinal.is_some_and(|ordinal| ordinal != state.structure_member_ordinal) {
                return Err(StructureCommandError::Cancelled);
            }
            state.source_snapshot.take();
            Ok(Arc::clone(state.structure.insert(Arc::new(reader))))
        })
        .map_err(map_session_error)?
}

/// Parses the footer of the opened source and caches it for every later query.
#[tauri::command]
pub(crate) async fn get_structure_summary(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureSummary, StructureCommandError> {
    let session = structure_session(&opened_source, generation)?;
    let _work = session.begin_work().map_err(map_session_error)?;
    let (snapshot_plan, job) = match register_structure_load(&session, generation)? {
        StructureLoadRequest::Cached(reader) => return Ok(reader.summary().clone()),
        StructureLoadRequest::Start { snapshot, job } => (snapshot, job),
    };
    let member_ordinal = match &snapshot_plan {
        StructureSnapshotPlan::File(_) => None,
        StructureSnapshotPlan::Dataset { ordinal, .. } => Some(*ordinal),
    };
    let progress = job.progress.clone();
    let cancellation = job.cancellation.clone();
    let lifecycle = Arc::clone(&session.lifecycle);
    let result = tauri::async_runtime::spawn_blocking(move || match snapshot_plan {
        StructureSnapshotPlan::File(snapshot) => {
            let snapshot = snapshot.ok_or(StructureCommandError::Unsupported)?;
            StructureReader::from_snapshot(&snapshot, &progress, &cancellation)
                .map_err(StructureCommandError::from)
        }
        StructureSnapshotPlan::Dataset { reader, ordinal } => {
            if cancellation.is_cancelled() {
                return Err(StructureCommandError::Cancelled);
            }
            let snapshot = reader
                .lock()
                .map_err(|_| StructureCommandError::Unsupported)?
                .member_snapshot_while(ordinal, || {
                    !cancellation.is_cancelled() && lifecycle.wants_work()
                })
                .map_err(map_dataset_error)?;
            if cancellation.is_cancelled() {
                return Err(StructureCommandError::Cancelled);
            }
            let reader =
                StructureReader::from_snapshot(snapshot.snapshot(), &progress, &cancellation)
                    .map_err(StructureCommandError::from)?;
            snapshot
                .validate_while(|| !cancellation.is_cancelled() && lifecycle.wants_work())
                .map_err(map_dataset_error)?;
            Ok(reader)
        }
    })
    .await;
    StructureJobs::finish(&session.structure_jobs.load, &job);
    if job.cancellation.is_cancelled() {
        return Err(StructureCommandError::Cancelled);
    }

    let reader = result.map_err(|_| StructureCommandError::Unsupported)??;
    Ok(
        install_structure(&opened_source, generation, reader, member_ordinal)?
            .summary()
            .clone(),
    )
}

/// Selects one fixed dataset member and clears only this session's Structure cache.
#[tauri::command]
pub(crate) fn select_dataset_structure_member(
    generation: u64,
    ordinal: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<DatasetMemberSummary, StructureCommandError> {
    let session = structure_session(&opened_source, generation)?;
    let member = session
        .with_open_state(|state| {
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                return Err(StructureCommandError::Unsupported);
            };
            let page = dataset
                .source
                .member_page(ordinal, 1)
                .map_err(map_dataset_error)?;
            let member = page
                .members
                .into_iter()
                .next()
                .ok_or(StructureCommandError::Unsupported)?;
            if state.structure_member_ordinal == ordinal {
                return Ok(member);
            }
            session.structure_jobs.cancel_all();
            state.structure = None;
            state.structure_member_ordinal = ordinal;
            Ok(member)
        })
        .map_err(map_session_error)??;
    Ok(member)
}

/// Reports how far the running footer parse has come.
#[tauri::command]
pub(crate) fn get_structure_load_progress(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Option<StructureLoadSnapshot> {
    let session = structure_session(&opened_source, generation).ok()?;
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
    if let Ok(session) = structure_session(&opened_source, generation) {
        StructureJobs::cancel(&session.structure_jobs.load, generation);
    }
}

/// Returns the legend totals of every structure lens.
#[tauri::command]
pub(crate) fn get_structure_lens_totals(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureLensTotals, StructureCommandError> {
    Ok(structure_reader(&opened_source, generation)?
        .lens_totals()
        .clone())
}

/// Returns a bounded window of layout rows with their largest segments.
#[tauri::command]
pub(crate) async fn get_structure_layout(
    generation: u64,
    unit: StructureByteUnit,
    row_offset: usize,
    row_limit: usize,
    segment_limit: usize,
    focused_column: Option<usize>,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureLayout, StructureCommandError> {
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        reader.layout(unit, row_offset, row_limit, segment_limit, focused_column)
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
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
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
    let reader = structure_reader(&opened_source, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
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
    let session = structure_session(&opened_source, generation)?;
    session
        .validate_source_identity()
        .map_err(|_| StructureCommandError::SourceChanged)?;
    let (structure, dataset) = {
        let state = session
            .state
            .lock()
            .map_err(|_| StructureCommandError::Unsupported)?;
        let structure = state
            .structure
            .as_ref()
            .map(Arc::clone)
            .ok_or(StructureCommandError::NotLoaded)?;
        let dataset = match &state.reader {
            SessionWindowReader::File(_) => None,
            SessionWindowReader::Dataset(dataset) => match &dataset.phase {
                DatasetSessionPhase::Ready { reader, .. } => {
                    Some((Arc::clone(reader), state.structure_member_ordinal))
                }
                DatasetSessionPhase::Inspecting { .. } => {
                    return Err(StructureCommandError::NotReady);
                }
                DatasetSessionPhase::Failed(error) => {
                    return Err(map_dataset_error(error.clone()));
                }
            },
        };
        (structure, dataset)
    };
    let local_offset = structure
        .first_row_offset(row_group_index)
        .map_err(StructureCommandError::from)?;
    let Some((reader, ordinal)) = dataset else {
        return Ok(local_offset);
    };
    let member_offset = reader
        .lock()
        .map_err(|_| StructureCommandError::Unsupported)?
        .member_row_offset_while(ordinal, || session.lifecycle.wants_work())
        .map_err(map_dataset_error)?;
    let offset = member_offset
        .checked_add(local_offset)
        .ok_or(StructureCommandError::Unsupported)?;
    session
        .with_open_state(|state| {
            if state.structure_member_ordinal != ordinal
                || !state
                    .structure
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &structure))
            {
                return Err(StructureCommandError::Cancelled);
            }
            Ok(())
        })
        .map_err(map_session_error)??;
    Ok(offset)
}

/// Builds the bounded, path-free Markdown digest copied from Structure mode.
#[tauri::command]
pub(crate) fn get_structure_report(
    generation: u64,
    unit: StructureByteUnit,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<String, StructureCommandError> {
    Ok(structure_reader(&opened_source, generation)?.report(env!("CARGO_PKG_VERSION"), unit))
}

/// Asks a bounded run of row groups whether their bloom filters admit a value.
#[tauri::command]
pub(crate) async fn probe_structure_bloom_filter(
    generation: u64,
    column_index: usize,
    value: String,
    offset: usize,
    limit: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<StructureBloomProbe, StructureCommandError> {
    let session = structure_session(&opened_source, generation)?;
    let _work = session.begin_work().map_err(map_session_error)?;
    let (reader, job) = structure_reader_and_job(&session, generation)?;
    let cancellation = job.cancellation.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    opened_source: tauri::State<'_, OpenedSource>,
) {
    if let Ok(session) = structure_session(&opened_source, generation) {
        StructureJobs::cancel(&session.structure_jobs.probe, generation);
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, sync::Arc, thread};

    use viewda_data_engine::{
        SourceSummary, StructureBloomProbeOutcome, StructureBloomProbeResult,
        StructureChunkStatistics, StructureCodecTotal, StructureColumnSummary,
        StructureKeyValueEntry, StructureLayoutRow, StructureLayoutSegment, StructureLayoutTail,
        StructureLensTotal, StructurePresenceTotals, StructureRatioStep, StructureRowGroupSummary,
    };

    use super::*;
    use crate::SourceOpenIntent;

    #[test]
    fn command_errors_keep_stable_wire_codes() {
        let codes = [
            StructureCommandError::NoSourceOpen,
            StructureCommandError::SourceChanged,
            StructureCommandError::NotReady,
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
                { "code": "notReady" },
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
            offset: 2,
            total_count: 9,
            max_compressed_bytes: 900,
            max_uncompressed_bytes: 2_700,
            overview: Vec::new(),
            rows: vec![StructureLayoutRow {
                index: 2,
                compressed_bytes: 500,
                uncompressed_bytes: 1_500,
                is_readable: true,
                segments: vec![StructureLayoutSegment {
                    column_index: 3,
                    column_name: "profile.city".to_owned(),
                    compressed_bytes: 400,
                    uncompressed_bytes: 1_200,
                    compression_ratio: Some(3.0),
                    codec: "zstd".to_owned(),
                    encodings: vec!["PLAIN".to_owned(), "RLE_DICTIONARY".to_owned()],
                    has_statistics: true,
                    has_bloom_filter: false,
                    has_page_index: true,
                }],
                tail: Some(StructureLayoutTail {
                    segment_count: 11,
                    compressed_bytes: 100,
                    uncompressed_bytes: 300,
                }),
            }],
        };

        assert_eq!(
            serde_json::to_value(layout).expect("serializable layout"),
            serde_json::json!({
                "offset": 2,
                "totalCount": 9,
                "maxCompressedBytes": 900,
                "maxUncompressedBytes": 2_700,
                "overview": [],
                "rows": [{
                    "index": 2,
                    "compressedBytes": 500,
                    "uncompressedBytes": 1_500,
                    "isReadable": true,
                    "segments": [{
                        "columnIndex": 3,
                        "columnName": "profile.city",
                        "compressedBytes": 400,
                        "uncompressedBytes": 1_200,
                        "compressionRatio": 3.0,
                        "codec": "zstd",
                        "encodings": ["PLAIN", "RLE_DICTIONARY"],
                        "hasStatistics": true,
                        "hasBloomFilter": false,
                        "hasPageIndex": true
                    }],
                    "tail": {
                        "segmentCount": 11,
                        "compressedBytes": 100,
                        "uncompressedBytes": 300
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
            total_compressed_bytes: 500,
            total_uncompressed_bytes: 1_500,
            columns: vec![StructureColumnSummary {
                index: 0,
                name: "id".to_owned(),
                physical_type: "INT64".to_owned(),
                logical_type: None,
                compressed_bytes: 500,
                uncompressed_bytes: 1_500,
                compression_ratio: Some(3.0),
                encodings: vec!["PLAIN".to_owned()],
                share: 1.0,
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
                "totalCompressedBytes": 500,
                "totalUncompressedBytes": 1_500,
                "columns": [{
                    "index": 0,
                    "name": "id",
                    "physicalType": "INT64",
                    "logicalType": null,
                    "compressedBytes": 500,
                    "uncompressedBytes": 1_500,
                    "compressionRatio": 3.0,
                    "encodings": ["PLAIN"],
                    "share": 1.0,
                    "cumulativeShare": 1.0
                }]
            })
        );
    }

    #[test]
    fn chunk_details_keep_their_camel_case_wire_shape() {
        let details = StructureChunkDetails {
            row_group_index: 1,
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
                "rowGroupIndex": 1,
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
            column_index: 1,
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
                "columnIndex": 1,
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

        let first = StructureJobs::start(&jobs.load, 1).expect("first job registers");
        let second = StructureJobs::start(&jobs.load, 1).expect("second job registers");

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
    fn cancellation_only_reaches_the_named_generation() {
        let jobs = StructureJobs::default();
        let job = StructureJobs::start(&jobs.probe, 4).expect("job registers");

        StructureJobs::cancel(&jobs.probe, 5);
        assert!(!job.cancellation.is_cancelled());

        StructureJobs::cancel(&jobs.probe, 4);
        assert!(job.cancellation.is_cancelled());
        assert!(jobs.probe.lock().expect("job registry").is_none());
    }

    #[test]
    fn closing_a_source_stops_every_structure_job() {
        let jobs = StructureJobs::default();
        let load = StructureJobs::start(&jobs.load, 1).expect("load registers");
        let probe = StructureJobs::start(&jobs.probe, 1).expect("probe registers");

        jobs.cancel_all();

        assert!(load.cancellation.is_cancelled());
        assert!(probe.cancellation.is_cancelled());
    }

    #[test]
    fn source_close_cannot_miss_a_registering_structure_job() {
        let opened_source = Arc::new(OpenedSource::default());
        opened_source
            .install(
                None,
                PathBuf::from("first.parquet"),
                empty_source_summary("first.parquet"),
                SourceOpenIntent::Explicit,
            )
            .expect("first source installs");
        let session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(1)
            .expect("source session");
        let load_slot = session
            .structure_jobs
            .load
            .lock()
            .expect("load registry locks");

        let registering_session = Arc::clone(&session);
        let registering = thread::spawn(move || register_structure_load(&registering_session, 1));
        for _ in 0..10_000 {
            if session.lifecycle.state.try_lock().is_err() {
                break;
            }
            thread::yield_now();
        }
        assert!(
            session.lifecycle.state.try_lock().is_err(),
            "registration keeps the session lifecycle locked until its job is visible"
        );

        let closing_source = Arc::clone(&opened_source);
        let closing = thread::spawn(move || closing_source.close(1));
        drop(load_slot);

        let request = registering
            .join()
            .expect("registration thread completes")
            .expect("current generation registers");
        closing
            .join()
            .expect("close thread completes")
            .expect("source closes");
        let StructureLoadRequest::Start { job, .. } = request else {
            panic!("an unloaded source starts a job");
        };
        assert!(
            job.cancellation.is_cancelled(),
            "close observes and cancels the registered job"
        );
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
}
