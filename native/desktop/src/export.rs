//! Native save dialog and lifecycle for one active data export.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;
use viewda_data_engine::{
    DataExportCancellation, DataExportError, DataExportProgress, DataExportReader,
    DataExportRequest, PreparedDataViewExport,
};

use crate::{OpenedSource, OpenedSourceSession, OpenedSourceState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DataExportScope {
    Selection,
    View,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DataExportFailureCode {
    NotFound,
    PermissionDenied,
    NotParquet,
    CorruptSource,
    InvalidRequest,
    Unsupported,
    DiskFull,
    ResourceExhausted,
    QueryFailed,
    QueryEngineUnavailable,
}

impl DataExportFailureCode {
    fn from_error(error: DataExportError) -> Option<Self> {
        Some(match error {
            DataExportError::NotFound => Self::NotFound,
            DataExportError::PermissionDenied => Self::PermissionDenied,
            DataExportError::NotParquet => Self::NotParquet,
            DataExportError::CorruptSource => Self::CorruptSource,
            DataExportError::InvalidRequest => Self::InvalidRequest,
            DataExportError::Unsupported => Self::Unsupported,
            DataExportError::DiskFull => Self::DiskFull,
            DataExportError::ResourceExhausted => Self::ResourceExhausted,
            DataExportError::QueryFailed => Self::QueryFailed,
            DataExportError::QueryEngineUnavailable => Self::QueryEngineUnavailable,
            DataExportError::Cancelled => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub(crate) enum DataExportCommandError {
    NoSourceOpen,
    SourceChanged,
    ViewChanged,
    AlreadyRunning,
    NotFound,
    PermissionDenied,
    InvalidRequest,
    Unsupported,
    QueryFailed,
    QueryEngineUnavailable,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DataExportStatus {
    Running {
        id: u64,
        file_name: String,
        bytes_written: u64,
    },
    Completed {
        id: u64,
        file_name: String,
        bytes_written: u64,
    },
    Cancelled {
        id: u64,
        file_name: String,
        bytes_written: u64,
    },
    Failed {
        id: u64,
        file_name: String,
        bytes_written: u64,
        error: DataExportFailureCode,
    },
}

#[derive(Default)]
pub(crate) struct DataExportJobs {
    next_id: AtomicU64,
    next_reservation_id: AtomicU64,
    state: Mutex<DataExportJobsState>,
    reservation_finished: Condvar,
}

#[derive(Default)]
struct DataExportJobsState {
    starting: Option<StartingDataExport>,
    starts_blocked: bool,
    temporary_start_blocks: usize,
    closing_generations: HashMap<u64, usize>,
    active: Option<Arc<ActiveDataExportJob>>,
}

struct StartingDataExport {
    id: u64,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

struct DataExportReservation<'a> {
    jobs: &'a DataExportJobs,
    id: u64,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

pub(crate) struct SourceCloseReservation<'a> {
    jobs: &'a DataExportJobs,
    generation: u64,
}

struct TemporaryDataExportDrain<'a> {
    jobs: &'a DataExportJobs,
}

impl Drop for DataExportReservation<'_> {
    fn drop(&mut self) {
        self.jobs.release_reservation(self.id);
    }
}

impl Drop for SourceCloseReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.jobs.state.lock()
            && let Some(count) = state.closing_generations.get_mut(&self.generation)
        {
            *count -= 1;
            if *count == 0 {
                state.closing_generations.remove(&self.generation);
            }
        }
    }
}

impl Drop for TemporaryDataExportDrain<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.jobs.state.lock() {
            state.temporary_start_blocks -= 1;
        }
    }
}

impl SourceCloseReservation<'_> {
    pub(crate) fn cancel_and_wait(&self) {
        self.jobs.cancel_source_and_wait(self.generation);
    }
}

struct ActiveDataExportJob {
    id: u64,
    /// Opened source this export reads, so closing that source can cancel it.
    generation: u64,
    file_name: String,
    target_path: PathBuf,
    progress: Option<DataExportProgress>,
    cancellation: Option<DataExportCancellation>,
    cancel_requested: AtomicBool,
    state: Mutex<DataExportExecutionState>,
    finished: Condvar,
}

struct DataExportCompletion {
    job: Arc<ActiveDataExportJob>,
    finished: bool,
}

impl DataExportCompletion {
    fn new(job: Arc<ActiveDataExportJob>) -> Self {
        Self {
            job,
            finished: false,
        }
    }

    fn finish(mut self, result: Result<u64, DataExportError>) {
        self.job.finish(result);
        self.finished = true;
    }
}

impl Drop for DataExportCompletion {
    fn drop(&mut self) {
        if !self.finished {
            self.job.finish(Err(DataExportError::QueryFailed));
        }
    }
}

#[derive(Clone, Copy)]
enum DataExportExecutionState {
    Running,
    Completed,
    Cancelled,
    Failed(DataExportFailureCode),
}

impl ActiveDataExportJob {
    fn running(
        id: u64,
        generation: u64,
        file_name: String,
        target_path: PathBuf,
        reader: &DataExportReader,
    ) -> Self {
        Self {
            id,
            generation,
            file_name,
            target_path,
            progress: Some(reader.progress()),
            cancellation: Some(reader.cancellation()),
            cancel_requested: AtomicBool::new(false),
            state: Mutex::new(DataExportExecutionState::Running),
            finished: Condvar::new(),
        }
    }

    fn failed(
        id: u64,
        generation: u64,
        file_name: String,
        target_path: PathBuf,
        error: DataExportFailureCode,
    ) -> Self {
        Self {
            id,
            generation,
            file_name,
            target_path,
            progress: None,
            cancellation: None,
            cancel_requested: AtomicBool::new(false),
            state: Mutex::new(DataExportExecutionState::Failed(error)),
            finished: Condvar::new(),
        }
    }

    fn status(&self) -> Result<DataExportStatus, DataExportCommandError> {
        let state = *self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        let bytes_written = self
            .progress
            .as_ref()
            .map_or(0, DataExportProgress::bytes_written);
        let common = (self.id, self.file_name.clone(), bytes_written);
        Ok(match state {
            DataExportExecutionState::Running => DataExportStatus::Running {
                id: common.0,
                file_name: common.1,
                bytes_written: common.2,
            },
            DataExportExecutionState::Completed => DataExportStatus::Completed {
                id: common.0,
                file_name: common.1,
                bytes_written: common.2,
            },
            DataExportExecutionState::Cancelled => DataExportStatus::Cancelled {
                id: common.0,
                file_name: common.1,
                bytes_written: common.2,
            },
            DataExportExecutionState::Failed(error) => DataExportStatus::Failed {
                id: common.0,
                file_name: common.1,
                bytes_written: common.2,
                error,
            },
        })
    }

    fn is_running(&self) -> Result<bool, DataExportCommandError> {
        self.state
            .lock()
            .map(|state| matches!(*state, DataExportExecutionState::Running))
            .map_err(|_| DataExportCommandError::QueryFailed)
    }

    fn finish(&self, result: Result<u64, DataExportError>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        *state = match result {
            Ok(_) => DataExportExecutionState::Completed,
            Err(DataExportError::Cancelled) => DataExportExecutionState::Cancelled,
            Err(error) => DataExportExecutionState::Failed(
                DataExportFailureCode::from_error(error)
                    .expect("non-cancelled export failures have a wire code"),
            ),
        };
        self.finished.notify_all();
    }

    fn cancel(&self) {
        self.cancel_requested.store(true, Ordering::Release);
        if let Some(cancellation) = &self.cancellation {
            cancellation.cancel();
        }
    }

    fn wait_until_finished(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        while matches!(*state, DataExportExecutionState::Running) {
            let Ok(next) = self.finished.wait(state) else {
                return;
            };
            state = next;
        }
    }
}

impl DataExportJobs {
    fn reserve_start(
        &self,
        generation: u64,
    ) -> Result<DataExportReservation<'_>, DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        if state.starts_blocked
            || state.temporary_start_blocks > 0
            || state.closing_generations.contains_key(&generation)
        {
            return Err(DataExportCommandError::Cancelled);
        }
        let running = state
            .active
            .as_ref()
            .map(|job| job.is_running())
            .transpose()?
            .unwrap_or(false);
        if state.starting.is_some() || running {
            return Err(DataExportCommandError::AlreadyRunning);
        }
        let id = self.next_reservation_id.fetch_add(1, Ordering::Relaxed) + 1;
        let cancelled = Arc::new(AtomicBool::new(false));
        state.starting = Some(StartingDataExport {
            id,
            generation,
            cancelled: Arc::clone(&cancelled),
        });
        Ok(DataExportReservation {
            jobs: self,
            id,
            generation,
            cancelled,
        })
    }

    fn release_reservation(&self, id: u64) {
        if let Ok(mut state) = self.state.lock()
            && state.starting.as_ref().is_some_and(|start| start.id == id)
        {
            state.starting = None;
            self.reservation_finished.notify_all();
        }
    }

    fn install(
        &self,
        reservation: &DataExportReservation<'_>,
        job: Arc<ActiveDataExportJob>,
    ) -> Result<(), DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        let owns_start = state.starting.as_ref().is_some_and(|start| {
            start.id == reservation.id && start.generation == reservation.generation
        });
        if !owns_start {
            job.cancel();
            return Err(DataExportCommandError::Cancelled);
        }
        state.starting = None;
        self.reservation_finished.notify_all();
        if state.starts_blocked
            || state.temporary_start_blocks > 0
            || state.closing_generations.contains_key(&job.generation)
            || reservation.cancelled.load(Ordering::Acquire)
        {
            job.cancel();
            return Err(DataExportCommandError::Cancelled);
        }
        state.active = Some(job);
        Ok(())
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub(crate) fn running_file_names(&self) -> Result<Vec<String>, DataExportCommandError> {
        Ok(self
            .running_job()?
            .map(|job| vec![job.file_name.clone()])
            .unwrap_or_default())
    }

    /// Running export targets of one opened source, for its close confirmation.
    #[cfg(test)]
    pub(crate) fn running_file_names_for(
        &self,
        generation: u64,
    ) -> Result<Vec<String>, DataExportCommandError> {
        Ok(self
            .running_job()?
            .filter(|job| job.generation == generation)
            .map(|job| vec![job.file_name.clone()])
            .unwrap_or_default())
    }

    pub(crate) fn begin_source_close(
        &self,
        generation: u64,
    ) -> Result<(SourceCloseReservation<'_>, Vec<String>), DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        let file_names = match state.active.as_ref() {
            Some(job) if job.generation == generation && job.is_running()? => {
                vec![job.file_name.clone()]
            }
            _ => Vec::new(),
        };
        *state.closing_generations.entry(generation).or_default() += 1;
        if let Some(start) = state
            .starting
            .as_ref()
            .filter(|start| start.generation == generation)
        {
            start.cancelled.store(true, Ordering::Release);
        }
        drop(state);
        Ok((
            SourceCloseReservation {
                jobs: self,
                generation,
            },
            file_names,
        ))
    }

    fn cancel_source_and_wait(&self, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(start) = state
            .starting
            .as_ref()
            .filter(|start| start.generation == generation)
        {
            start.cancelled.store(true, Ordering::Release);
        }
        let job = state
            .active
            .clone()
            .filter(|job| job.generation == generation);
        while state
            .starting
            .as_ref()
            .is_some_and(|start| start.generation == generation)
        {
            let Ok(next) = self.reservation_finished.wait(state) else {
                return;
            };
            state = next;
        }
        drop(state);
        if let Some(job) = job {
            job.cancel();
            job.wait_until_finished();
            if let Ok(mut state) = self.state.lock()
                && state
                    .active
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &job))
            {
                state.active.take();
            }
        }
    }

    fn running_job(&self) -> Result<Option<Arc<ActiveDataExportJob>>, DataExportCommandError> {
        let job = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?
            .active
            .clone();
        match job {
            Some(job) if job.is_running()? => Ok(Some(job)),
            _ => Ok(None),
        }
    }

    pub(crate) fn cancel_all_and_wait(&self) {
        let _ = self.block_starts_and_wait();
        self.cancel_active_and_wait();
    }

    pub(crate) fn drain_temporarily<T>(
        &self,
        cleanup: impl FnOnce() -> T,
    ) -> Result<T, DataExportCommandError> {
        let _drain = self.begin_temporary_drain()?;
        self.cancel_active_and_wait();
        Ok(cleanup())
    }

    fn cancel_active_and_wait(&self) {
        let job = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.active.clone());
        if let Some(job) = job {
            job.cancel();
            job.wait_until_finished();
            if let Ok(mut state) = self.state.lock()
                && state
                    .active
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &job))
            {
                state.active.take();
            }
        }
    }

    fn begin_temporary_drain(
        &self,
    ) -> Result<TemporaryDataExportDrain<'_>, DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        state.temporary_start_blocks += 1;
        if let Some(start) = &state.starting {
            start.cancelled.store(true, Ordering::Release);
        }
        while state.starting.is_some() {
            state = self
                .reservation_finished
                .wait(state)
                .map_err(|_| DataExportCommandError::QueryFailed)?;
        }
        Ok(TemporaryDataExportDrain { jobs: self })
    }

    pub(crate) fn block_starts_and_wait(&self) -> Result<(), DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        state.starts_blocked = true;
        if let Some(start) = &state.starting {
            start.cancelled.store(true, Ordering::Release);
        }
        while state.starting.is_some() {
            state = self
                .reservation_finished
                .wait(state)
                .map_err(|_| DataExportCommandError::QueryFailed)?;
        }
        Ok(())
    }

    pub(crate) fn allow_starts(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.starts_blocked = false;
        }
    }
}

impl OpenedSource {
    fn export_source_path(&self, generation: u64) -> Result<PathBuf, DataExportCommandError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::Unsupported)?;
        Ok(export_session(&state, generation)?.path.clone())
    }

    fn export_source(
        &self,
        generation: u64,
        view_revision: u64,
    ) -> Result<(PathBuf, Option<PreparedDataViewExport>), DataExportCommandError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::Unsupported)?;
        let session = export_session(&state, generation)?;
        drop(state);
        let session_state = session
            .state
            .lock()
            .map_err(|_| DataExportCommandError::Unsupported)?;
        if session_state.view_revision != view_revision {
            return Err(DataExportCommandError::ViewChanged);
        }
        Ok((
            session.path.clone(),
            session_state
                .view
                .as_ref()
                .map(|view| view.export_snapshot()),
        ))
    }

    fn reserve_export_start(
        &self,
        generation: u64,
    ) -> Result<DataExportReservation<'_>, DataExportCommandError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::Unsupported)?;
        export_session(&state, generation)?;
        self.data_exports.reserve_start(generation)
    }

    fn install_export_job(
        &self,
        reservation: &DataExportReservation<'_>,
        generation: u64,
        view_revision: u64,
        job: Arc<ActiveDataExportJob>,
    ) -> Result<(), DataExportCommandError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        let session = export_session(&state, generation)?;
        drop(state);
        if session
            .state
            .lock()
            .map_err(|_| DataExportCommandError::Unsupported)?
            .view_revision
            != view_revision
        {
            return Err(DataExportCommandError::ViewChanged);
        }
        self.data_exports.install(reservation, job)
    }
}

fn export_session(
    state: &OpenedSourceState,
    generation: u64,
) -> Result<Arc<OpenedSourceSession>, DataExportCommandError> {
    state.session(generation).ok_or_else(|| {
        state.missing_session(
            DataExportCommandError::NoSourceOpen,
            DataExportCommandError::SourceChanged,
        )
    })
}

#[tauri::command]
pub(crate) async fn start_data_export(
    app: tauri::AppHandle,
    generation: u64,
    view_revision: u64,
    scope: DataExportScope,
    request: DataExportRequest,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<Option<DataExportStatus>, DataExportCommandError> {
    let jobs = &opened_source.data_exports;
    let source_path = opened_source.export_source_path(generation)?;
    let suggested_name = default_export_name(&source_path, scope);
    let selected = match tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("CSV", &["csv"])
            .set_file_name(suggested_name)
            .blocking_save_file()
    })
    .await
    {
        Ok(selected) => selected,
        Err(_) => return Err(DataExportCommandError::Unsupported),
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let target_path = match selected.into_path() {
        Ok(path) => path,
        Err(_) => return Err(DataExportCommandError::Unsupported),
    };
    let reservation = opened_source.reserve_export_start(generation)?;
    let (source_path, view) = opened_source.export_source(generation, view_revision)?;
    let file_name = target_path.file_name().map_or_else(
        || "export.csv".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let id = jobs.next_id();
    let reader = match tauri::async_runtime::spawn_blocking({
        let target_path = target_path.clone();
        move || DataExportReader::new(source_path, target_path, request, view)
    })
    .await
    {
        Ok(reader) => reader,
        Err(_) => return Err(DataExportCommandError::QueryEngineUnavailable),
    };
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            let Some(failure) = DataExportFailureCode::from_error(error) else {
                return Err(DataExportCommandError::Cancelled);
            };
            let job = Arc::new(ActiveDataExportJob::failed(
                id,
                generation,
                file_name,
                target_path,
                failure,
            ));
            opened_source.install_export_job(
                &reservation,
                generation,
                view_revision,
                Arc::clone(&job),
            )?;
            return job.status().map(Some);
        }
    };
    let job = Arc::new(ActiveDataExportJob::running(
        id,
        generation,
        file_name,
        target_path,
        &reader,
    ));
    opened_source.install_export_job(&reservation, generation, view_revision, Arc::clone(&job))?;
    drop(reservation);
    tauri::async_runtime::spawn_blocking(move || {
        let completion = DataExportCompletion::new(job);
        completion.finish(reader.export());
    });

    get_data_export_status(generation, opened_source)
}

#[tauri::command]
pub(crate) fn get_data_export_status(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<Option<DataExportStatus>, DataExportCommandError> {
    let jobs = &opened_source.data_exports;
    let job = jobs
        .state
        .lock()
        .map_err(|_| DataExportCommandError::QueryFailed)?
        .active
        .clone();
    job.filter(|job| job.generation == generation)
        .map(|job| job.status())
        .transpose()
}

#[tauri::command]
pub(crate) fn cancel_data_export(
    id: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<bool, DataExportCommandError> {
    let jobs = &opened_source.data_exports;
    let job = jobs
        .state
        .lock()
        .map_err(|_| DataExportCommandError::QueryFailed)?
        .active
        .as_ref()
        .filter(|job| job.id == id)
        .cloned();
    let Some(job) = job else {
        return Ok(false);
    };
    if !job.is_running()? {
        return Ok(false);
    }
    job.cancel();
    Ok(true)
}

#[tauri::command]
pub(crate) fn dismiss_data_export(
    id: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<bool, DataExportCommandError> {
    let jobs = &opened_source.data_exports;
    let mut state = jobs
        .state
        .lock()
        .map_err(|_| DataExportCommandError::QueryFailed)?;
    let dismissible = state
        .active
        .as_ref()
        .filter(|job| job.id == id)
        .map(|job| job.is_running().map(|running| !running))
        .transpose()?
        .unwrap_or(false);
    if dismissible {
        state.active.take();
    }
    Ok(dismissible)
}

#[tauri::command]
pub(crate) fn reveal_data_export(
    id: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<(), DataExportCommandError> {
    let jobs = &opened_source.data_exports;
    let job = jobs
        .state
        .lock()
        .map_err(|_| DataExportCommandError::QueryFailed)?
        .active
        .as_ref()
        .filter(|job| job.id == id)
        .cloned()
        .ok_or(DataExportCommandError::InvalidRequest)?;
    let completed = job
        .state
        .lock()
        .map(|state| matches!(*state, DataExportExecutionState::Completed))
        .map_err(|_| DataExportCommandError::QueryFailed)?;
    if !completed {
        return Err(DataExportCommandError::InvalidRequest);
    }
    fs::metadata(&job.target_path).map_err(classify_reveal_error)?;
    tauri_plugin_opener::reveal_item_in_dir(&job.target_path)
        .map_err(|_| DataExportCommandError::Unsupported)
}

fn classify_reveal_error(error: io::Error) -> DataExportCommandError {
    match error.kind() {
        io::ErrorKind::NotFound => DataExportCommandError::NotFound,
        io::ErrorKind::PermissionDenied => DataExportCommandError::PermissionDenied,
        _ => DataExportCommandError::Unsupported,
    }
}

fn default_export_name(source_path: &Path, scope: DataExportScope) -> String {
    let stem = source_path.file_stem().map_or_else(
        || "export".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );
    let suffix = match scope {
        DataExportScope::Selection => "selection",
        DataExportScope::View => "view",
    };
    format!("{stem}-{suffix}.csv")
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::tests::open_test_source;

    #[test]
    fn suggests_scope_specific_csv_names_without_exposing_the_directory() {
        let source = Path::new("/private/data/example.parquet");

        assert_eq!(
            default_export_name(source, DataExportScope::Selection),
            "example-selection.csv"
        );
        assert_eq!(
            default_export_name(source, DataExportScope::View),
            "example-view.csv"
        );
    }

    #[test]
    fn command_errors_keep_stable_wire_codes() {
        assert_eq!(
            serde_json::to_value(DataExportCommandError::AlreadyRunning)
                .expect("serializable command error"),
            serde_json::json!({ "code": "alreadyRunning" })
        );
    }

    #[test]
    fn export_status_keeps_camel_case_wire_fields() {
        let statuses = [
            DataExportStatus::Running {
                id: 7,
                file_name: "orders-view.csv".to_owned(),
                bytes_written: 12_400,
            },
            DataExportStatus::Completed {
                id: 7,
                file_name: "orders-view.csv".to_owned(),
                bytes_written: 2_500_000,
            },
        ];

        assert_eq!(
            serde_json::to_value(statuses).expect("serializable export statuses"),
            serde_json::json!([
                {
                    "state": "running",
                    "id": 7,
                    "fileName": "orders-view.csv",
                    "bytesWritten": 12_400
                },
                {
                    "state": "completed",
                    "id": 7,
                    "fileName": "orders-view.csv",
                    "bytesWritten": 2_500_000
                }
            ])
        );
    }

    #[test]
    fn rejects_a_second_command_start_while_the_export_worker_is_running() {
        let jobs = DataExportJobs::default();

        let reservation = jobs.reserve_start(1).expect("reserve export");
        assert!(matches!(
            jobs.reserve_start(1),
            Err(DataExportCommandError::AlreadyRunning)
        ));
        drop(reservation);

        let job = test_running_job(1);
        install_test_job(&jobs, Arc::clone(&job));
        let worker_ready = Arc::new(Barrier::new(2));
        let worker = {
            let job = Arc::clone(&job);
            let worker_ready = Arc::clone(&worker_ready);
            std::thread::spawn(move || {
                worker_ready.wait();
                while !job.cancel_requested.load(Ordering::Acquire) {
                    std::thread::yield_now();
                }
                job.finish(Err(DataExportError::Cancelled));
            })
        };
        worker_ready.wait();
        assert!(matches!(
            jobs.reserve_start(1),
            Err(DataExportCommandError::AlreadyRunning)
        ));

        job.cancel();
        worker.join().expect("export worker");
        assert!(jobs.reserve_start(1).is_ok());
    }

    #[test]
    fn failed_update_releases_its_export_start_barrier() {
        let jobs = DataExportJobs::default();

        jobs.block_starts_and_wait().expect("block export starts");
        assert!(matches!(
            jobs.reserve_start(1),
            Err(DataExportCommandError::Cancelled)
        ));

        jobs.allow_starts();
        assert!(jobs.reserve_start(1).is_ok());
    }

    #[test]
    fn temporary_drain_allows_future_exports_after_cleanup() {
        let jobs = DataExportJobs::default();

        jobs.drain_temporarily(|| {
            assert!(matches!(
                jobs.reserve_start(1),
                Err(DataExportCommandError::Cancelled)
            ));
        })
        .expect("temporary export drain");

        assert!(jobs.reserve_start(1).is_ok());
    }

    #[test]
    fn permanent_shutdown_keeps_future_exports_blocked() {
        let jobs = DataExportJobs::default();

        jobs.cancel_all_and_wait();

        assert!(matches!(
            jobs.reserve_start(1),
            Err(DataExportCommandError::Cancelled)
        ));
    }

    #[test]
    fn opening_another_source_keeps_the_running_export() {
        let opened_source = OpenedSource::default();
        open_test_source(&opened_source, "exporting.parquet");
        let job = test_running_job(1);
        install_test_job(&opened_source.data_exports, Arc::clone(&job));

        open_test_source(&opened_source, "second.parquet");

        assert!(!job.cancel_requested.load(Ordering::Acquire));
        job.finish(Ok(42));
    }

    #[test]
    fn the_close_confirmation_covers_only_the_exports_of_one_source() {
        let jobs = DataExportJobs::default();
        let job = test_running_job(2);
        install_test_job(&jobs, Arc::clone(&job));

        assert_eq!(
            jobs.running_file_names_for(2).expect("running exports"),
            vec!["example-view.csv"]
        );
        assert!(
            jobs.running_file_names_for(1)
                .expect("other source exports")
                .is_empty()
        );

        job.finish(Ok(42));
    }

    #[test]
    fn a_stale_export_cannot_start_after_its_source_closed() {
        let opened_source = OpenedSource::default();
        let closed = open_test_source(&opened_source, "closed.parquet");
        open_test_source(&opened_source, "second.parquet");
        assert!(
            opened_source
                .close(closed.generation)
                .expect("opened source state")
        );

        assert!(matches!(
            opened_source.reserve_export_start(closed.generation),
            Err(DataExportCommandError::SourceChanged)
        ));
        assert!(
            opened_source
                .data_exports
                .state
                .lock()
                .expect("export jobs")
                .active
                .is_none()
        );
    }

    #[test]
    fn source_close_barrier_rejects_an_export_installed_after_the_snapshot() {
        let jobs = DataExportJobs::default();
        let reservation = jobs.reserve_start(7).expect("reserve export start");
        let (close, names) = jobs.begin_source_close(7).expect("begin close");
        assert!(names.is_empty());

        let job = test_running_job(7);
        assert_eq!(
            jobs.install(&reservation, Arc::clone(&job)),
            Err(DataExportCommandError::Cancelled)
        );
        assert!(job.cancel_requested.load(Ordering::Acquire));
        assert!(jobs.state.lock().expect("export state").active.is_none());

        assert!(matches!(
            jobs.reserve_start(7),
            Err(DataExportCommandError::Cancelled)
        ));
        drop(close);
        let second = jobs.reserve_start(8).expect("reserve second export");
        drop(reservation);
        assert!(matches!(
            jobs.reserve_start(9),
            Err(DataExportCommandError::AlreadyRunning)
        ));
        drop(second);
    }

    #[test]
    fn source_close_cancels_and_waits_for_export_construction() {
        let jobs = DataExportJobs::default();
        let reservation = jobs.reserve_start(7).expect("reserve construction");
        let cancelled = Arc::clone(&reservation.cancelled);
        let (close, _) = jobs.begin_source_close(7).expect("begin close");

        std::thread::scope(|scope| {
            let closing = scope.spawn(move || close.cancel_and_wait());
            while !cancelled.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            assert!(!closing.is_finished());
            drop(reservation);
            closing.join().expect("source close");
        });

        let state = jobs.state.lock().expect("export state");
        assert!(state.starting.is_none());
        assert!(state.active.is_none());
        assert!(state.closing_generations.is_empty());
    }

    #[test]
    fn global_block_cancels_and_waits_for_export_construction() {
        let jobs = DataExportJobs::default();
        let reservation = jobs.reserve_start(7).expect("reserve construction");
        let cancelled = Arc::clone(&reservation.cancelled);

        std::thread::scope(|scope| {
            let blocking = scope.spawn(|| jobs.block_starts_and_wait());
            while !cancelled.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            assert!(!blocking.is_finished());
            drop(reservation);
            blocking
                .join()
                .expect("global block")
                .expect("block starts");
        });

        assert!(matches!(
            jobs.reserve_start(8),
            Err(DataExportCommandError::Cancelled)
        ));
        let state = jobs.state.lock().expect("export state");
        assert!(state.starting.is_none());
        assert!(state.active.is_none());
    }

    #[test]
    fn duplicate_source_close_keeps_the_first_barrier_until_every_close_finishes() {
        let jobs = DataExportJobs::default();
        let (first, _) = jobs.begin_source_close(7).expect("first close");
        let (second, _) = jobs.begin_source_close(7).expect("second close");

        drop(second);
        assert!(matches!(
            jobs.reserve_start(7),
            Err(DataExportCommandError::Cancelled)
        ));
        drop(first);
        assert!(jobs.reserve_start(7).is_ok());
    }

    #[test]
    fn completed_source_closes_leave_no_export_bookkeeping() {
        let jobs = DataExportJobs::default();
        for generation in 1..=64 {
            let job = test_running_job(generation);
            install_test_job(&jobs, Arc::clone(&job));
            job.finish(Ok(42));
            let (close, _) = jobs
                .begin_source_close(generation)
                .expect("begin source close");
            close.cancel_and_wait();
            drop(close);
        }

        let state = jobs.state.lock().expect("export state");
        assert!(state.starting.is_none());
        assert!(state.active.is_none());
        assert!(state.closing_generations.is_empty());
    }

    #[test]
    fn export_worker_panic_still_releases_waiters() {
        let job = test_running_job(7);
        let completion_job = Arc::clone(&job);
        let panicked = std::panic::catch_unwind(move || {
            let _completion = DataExportCompletion::new(completion_job);
            panic!("simulated export panic");
        });

        assert!(panicked.is_err());
        job.wait_until_finished();
        assert!(matches!(
            job.status(),
            Ok(DataExportStatus::Failed {
                error: DataExportFailureCode::QueryFailed,
                ..
            })
        ));
    }

    #[test]
    fn a_stale_export_cannot_start_after_the_view_changes() {
        let opened_source = OpenedSource::default();
        let opened = open_test_source(&opened_source, "view.parquet");
        opened_source
            .state
            .lock()
            .expect("opened source")
            .session(opened.generation)
            .expect("session")
            .state
            .lock()
            .expect("session state")
            .view_revision = 2;

        let reservation = opened_source
            .reserve_export_start(opened.generation)
            .expect("reserve export");
        assert!(matches!(
            opened_source.install_export_job(
                &reservation,
                opened.generation,
                1,
                test_running_job(opened.generation)
            ),
            Err(DataExportCommandError::ViewChanged)
        ));
        assert!(
            opened_source
                .data_exports
                .state
                .lock()
                .expect("export jobs")
                .active
                .is_none()
        );
    }

    #[test]
    fn reveal_errors_distinguish_missing_and_denied_targets() {
        assert_eq!(
            classify_reveal_error(io::Error::new(io::ErrorKind::NotFound, "missing")),
            DataExportCommandError::NotFound
        );
        assert_eq!(
            classify_reveal_error(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
            DataExportCommandError::PermissionDenied
        );
    }

    #[test]
    fn shutdown_waits_for_the_cancelled_export_worker() {
        let jobs = Arc::new(DataExportJobs::default());
        let job = test_running_job(1);
        install_test_job(&jobs, Arc::clone(&job));
        let shutdown_jobs = Arc::clone(&jobs);
        let shutdown = std::thread::spawn(move || shutdown_jobs.cancel_all_and_wait());

        while !job.cancel_requested.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
        assert!(!shutdown.is_finished());

        job.finish(Err(DataExportError::Cancelled));
        shutdown.join().expect("shutdown wait");
    }

    #[test]
    fn close_guard_reports_only_running_export_targets() {
        let jobs = DataExportJobs::default();
        let job = test_running_job(1);
        install_test_job(&jobs, Arc::clone(&job));

        assert_eq!(
            jobs.running_file_names().expect("running exports"),
            vec!["example-view.csv"]
        );

        job.finish(Ok(42));

        assert!(
            jobs.running_file_names()
                .expect("finished exports")
                .is_empty()
        );
    }

    fn test_running_job(generation: u64) -> Arc<ActiveDataExportJob> {
        Arc::new(ActiveDataExportJob {
            id: 1,
            generation,
            file_name: "example-view.csv".to_owned(),
            target_path: PathBuf::from("example-view.csv"),
            progress: None,
            cancellation: None,
            cancel_requested: AtomicBool::new(false),
            state: Mutex::new(DataExportExecutionState::Running),
            finished: Condvar::new(),
        })
    }

    fn install_test_job(jobs: &DataExportJobs, job: Arc<ActiveDataExportJob>) {
        let reservation = jobs
            .reserve_start(job.generation)
            .expect("reserve test export");
        jobs.install(&reservation, job)
            .expect("install test export");
    }
}
