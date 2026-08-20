//! Native save dialog and lifecycle for one active data export.

use std::{
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
    state: Mutex<DataExportJobsState>,
}

#[derive(Default)]
struct DataExportJobsState {
    starting: bool,
    starts_blocked: bool,
    active: Option<Arc<ActiveDataExportJob>>,
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
    fn reserve_start(&self) -> Result<(), DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        if state.starts_blocked {
            return Err(DataExportCommandError::Cancelled);
        }
        let running = state
            .active
            .as_ref()
            .map(|job| job.is_running())
            .transpose()?
            .unwrap_or(false);
        if state.starting || running {
            return Err(DataExportCommandError::AlreadyRunning);
        }
        state.starting = true;
        Ok(())
    }

    fn release_start(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.starting = false;
        }
    }

    fn install(&self, job: Arc<ActiveDataExportJob>) -> Result<(), DataExportCommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        state.starting = false;
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
        let job = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.active.clone());
        if let Some(job) = job {
            job.cancel();
            job.wait_until_finished();
        }
    }

    pub(crate) fn block_starts(&self) -> Result<(), DataExportCommandError> {
        self.state
            .lock()
            .map(|mut state| state.starts_blocked = true)
            .map_err(|_| DataExportCommandError::QueryFailed)
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
        if session.view_revision != view_revision {
            return Err(DataExportCommandError::ViewChanged);
        }
        Ok((
            session.path.clone(),
            session.view.as_ref().map(|view| view.export_snapshot()),
        ))
    }

    fn install_export_job(
        &self,
        generation: u64,
        view_revision: u64,
        job: Arc<ActiveDataExportJob>,
    ) -> Result<(), DataExportCommandError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DataExportCommandError::QueryFailed)?;
        if export_session(&state, generation)?.view_revision != view_revision {
            return Err(DataExportCommandError::ViewChanged);
        }
        self.data_exports.install(job)
    }
}

fn export_session(
    state: &OpenedSourceState,
    generation: u64,
) -> Result<&OpenedSourceSession, DataExportCommandError> {
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
    jobs.reserve_start()?;
    let source_path = match opened_source.export_source_path(generation) {
        Ok(path) => path,
        Err(error) => {
            jobs.release_start();
            return Err(error);
        }
    };
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
        Err(_) => {
            jobs.release_start();
            return Err(DataExportCommandError::Unsupported);
        }
    };
    let Some(selected) = selected else {
        jobs.release_start();
        return Ok(None);
    };
    let target_path = match selected.into_path() {
        Ok(path) => path,
        Err(_) => {
            jobs.release_start();
            return Err(DataExportCommandError::Unsupported);
        }
    };
    let (source_path, view) = match opened_source.export_source(generation, view_revision) {
        Ok(source) => source,
        Err(error) => {
            jobs.release_start();
            return Err(error);
        }
    };
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
        Err(_) => {
            jobs.release_start();
            return Err(DataExportCommandError::QueryEngineUnavailable);
        }
    };
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            let Some(failure) = DataExportFailureCode::from_error(error) else {
                jobs.release_start();
                return Err(DataExportCommandError::Cancelled);
            };
            let job = Arc::new(ActiveDataExportJob::failed(
                id,
                generation,
                file_name,
                target_path,
                failure,
            ));
            if let Err(error) =
                opened_source.install_export_job(generation, view_revision, Arc::clone(&job))
            {
                jobs.release_start();
                return Err(error);
            }
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
    if let Err(error) =
        opened_source.install_export_job(generation, view_revision, Arc::clone(&job))
    {
        jobs.release_start();
        return Err(error);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = reader.export();
        job.finish(result);
    });

    get_data_export_status(opened_source)
}

#[tauri::command]
pub(crate) fn get_data_export_status(
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<Option<DataExportStatus>, DataExportCommandError> {
    let jobs = &opened_source.data_exports;
    let job = jobs
        .state
        .lock()
        .map_err(|_| DataExportCommandError::QueryFailed)?
        .active
        .clone();
    job.map(|job| job.status()).transpose()
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

        assert_eq!(jobs.reserve_start(), Ok(()));
        assert!(matches!(
            jobs.reserve_start(),
            Err(DataExportCommandError::AlreadyRunning)
        ));
        jobs.release_start();

        let job = test_running_job(1);
        jobs.install(Arc::clone(&job)).expect("install running job");
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
            jobs.reserve_start(),
            Err(DataExportCommandError::AlreadyRunning)
        ));

        job.cancel();
        worker.join().expect("export worker");
        assert_eq!(jobs.reserve_start(), Ok(()));
    }

    #[test]
    fn blocks_new_exports_while_an_update_is_restarting_the_application() {
        let jobs = DataExportJobs::default();

        jobs.block_starts().expect("block export starts");
        assert_eq!(jobs.reserve_start(), Err(DataExportCommandError::Cancelled));

        jobs.allow_starts();
        assert_eq!(jobs.reserve_start(), Ok(()));
    }

    #[test]
    fn opening_another_source_keeps_the_running_export() {
        let opened_source = OpenedSource::default();
        open_test_source(&opened_source, "exporting.parquet");
        let job = test_running_job(1);
        opened_source
            .data_exports
            .install(Arc::clone(&job))
            .expect("install running job");

        open_test_source(&opened_source, "second.parquet");

        assert!(!job.cancel_requested.load(Ordering::Acquire));
        job.finish(Ok(42));
    }

    #[test]
    fn the_close_confirmation_covers_only_the_exports_of_one_source() {
        let jobs = DataExportJobs::default();
        let job = test_running_job(2);
        jobs.install(Arc::clone(&job)).expect("install running job");

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
            opened_source.install_export_job(closed.generation, 0, test_running_job(1)),
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
    fn a_stale_export_cannot_start_after_the_view_changes() {
        let opened_source = OpenedSource::default();
        let opened = open_test_source(&opened_source, "view.parquet");
        opened_source
            .state
            .lock()
            .expect("opened source")
            .session_mut(opened.generation)
            .expect("session")
            .view_revision = 2;

        assert!(matches!(
            opened_source.install_export_job(opened.generation, 1, test_running_job(1)),
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
        jobs.install(Arc::clone(&job)).expect("install running job");
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
        jobs.install(Arc::clone(&job)).expect("install running job");

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
}
