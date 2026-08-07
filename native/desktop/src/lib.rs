//! Tauri adapter for the Viewda desktop application.

mod default_application;
mod export;
mod launch;
mod recents;
mod theme;
mod updates;
mod view_settings;

use std::{
    collections::{HashMap, hash_map::Entry},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[cfg(not(target_os = "macos"))]
use std::ffi::OsString;

use default_application::{get_default_application_status, set_default_application};
use export::{
    DataExportJobs, cancel_data_export, dismiss_data_export, get_data_export_status,
    reveal_data_export, start_data_export,
};
#[cfg(not(target_os = "macos"))]
use launch::open_from_args;
#[cfg(target_os = "macos")]
use launch::open_path;
use launch::{PendingOpenedSource, take_opened_source};
use recents::{RecentSource, RecentSourceError, RecentSourcesStore};
use serde::Serialize;
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use theme::{apply_saved_theme, get_theme_preference, set_theme_preference, sync_system_theme};
use thiserror::Error;
use updates::{
    PendingUpdate, UpdateError, UpdateInfo, UpdateStateStore, check_for_update,
    check_for_update_with_state, discard_pending_update, get_update_settings,
    install_pending_update, open_releases_page, set_update_settings, take_post_update_state,
};
use view_settings::{DataViewSettings, get_data_view_settings, set_data_view_settings};
use viewda_data_engine::{
    ColumnStatistics, ColumnStatisticsError, ColumnStatisticsReader, DataFilter,
    DataFilterOperator, DataSort, DataViewBuilder, DataViewError, DataViewInterruptHandle,
    DataViewResourceDiagnostics, DataWindowError, DataWindowReader, EngineError, EngineStatus,
    PreparedDataView, SchemaField, SourceError, SourceSummary, StatisticsInterruptHandle,
    TextValueSuggestions, TextValueSuggestionsInterruptHandle, TextValueSuggestionsReader,
    engine_status, inspect_local_source,
};

const OPEN_SOURCE_MENU_ID: &str = "open-local-source";
const SETTINGS_MENU_ID: &str = "settings";
const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";
const OPEN_SOURCE_REQUESTED_EVENT: &str = "open-source-requested";
const SETTINGS_REQUESTED_EVENT: &str = "settings-requested";
const UPDATE_AVAILABLE_EVENT: &str = "update-available";

#[derive(Default)]
pub(crate) struct OpenedSource {
    state: Arc<Mutex<OpenedSourceState>>,
    recents: RecentSourcesStore,
    data_views: DataViewJobs,
    data_exports: DataExportJobs,
    text_suggestions: TextValueSuggestionJobs,
}

#[derive(Default)]
struct OpenedSourceState {
    generation: u64,
    session: Option<OpenedSourceSession>,
    blocks_restore: bool,
}

struct OpenedSourceSession {
    generation: u64,
    path: PathBuf,
    schema: Vec<SchemaField>,
    source_row_count: u64,
    view_revision: u64,
    view: Option<PreparedDataView>,
    reader: DataWindowReader,
    statistics_cache: HashMap<(u64, usize), ColumnStatistics>,
}

#[derive(Default)]
struct DataViewJobs {
    state: Mutex<DataViewJobsState>,
}

#[derive(Default)]
struct DataViewJobsState {
    watermark: Option<(u64, u64)>,
    active: Option<ActiveDataViewJob>,
}

struct ActiveDataViewJob {
    generation: u64,
    view_revision: u64,
    interrupt: Arc<DataViewInterruptHandle>,
}

impl ActiveDataViewJob {
    fn cancel(&self) {
        self.interrupt.interrupt();
    }
}

fn register_data_view_job(
    jobs: &mut DataViewJobsState,
    next: ActiveDataViewJob,
) -> Result<(), DataWindowError> {
    if jobs.watermark.is_some_and(|(generation, revision)| {
        generation == next.generation && next.view_revision <= revision
    }) {
        next.cancel();
        return Err(DataWindowError::Cancelled);
    }
    jobs.watermark = Some((next.generation, next.view_revision));
    if let Some(previous) = jobs.active.replace(next) {
        previous.cancel();
    }
    Ok(())
}

fn finish_data_view_job(
    jobs: &mut DataViewJobsState,
    generation: u64,
    view_revision: u64,
    interrupt: &Arc<DataViewInterruptHandle>,
) -> bool {
    let is_current = jobs.active.as_ref().is_some_and(|active| {
        active.generation == generation
            && active.view_revision == view_revision
            && Arc::ptr_eq(&active.interrupt, interrupt)
    }) && jobs.watermark == Some((generation, view_revision));
    if is_current {
        jobs.active.take();
    }
    is_current
}

fn cancel_data_view_job(
    jobs: &mut DataViewJobsState,
    generation: u64,
    view_revision: u64,
) -> Option<ActiveDataViewJob> {
    if !jobs
        .watermark
        .is_some_and(|(watermark_generation, revision)| {
            watermark_generation == generation && revision >= view_revision
        })
    {
        jobs.watermark = Some((generation, view_revision));
    }
    if jobs.active.as_ref().is_some_and(|active| {
        active.generation == generation && active.view_revision == view_revision
    }) {
        jobs.active.take()
    } else {
        None
    }
}

#[derive(Default)]
struct TextValueSuggestionJobs {
    state: Mutex<TextValueSuggestionJobsState>,
}

#[derive(Default)]
struct TextValueSuggestionJobsState {
    watermark: Option<(u64, u64)>,
    active: Option<ActiveTextValueSuggestionJob>,
}

struct ActiveTextValueSuggestionJob {
    generation: u64,
    suggestion_revision: u64,
    interrupt: Arc<TextValueSuggestionsInterruptHandle>,
}

impl ActiveTextValueSuggestionJob {
    fn cancel(&self) {
        self.interrupt.interrupt();
    }
}

fn register_text_value_suggestion_job(
    jobs: &mut TextValueSuggestionJobsState,
    next: ActiveTextValueSuggestionJob,
) -> Result<(), DataWindowError> {
    if jobs.watermark.is_some_and(|(generation, revision)| {
        generation == next.generation && next.suggestion_revision <= revision
    }) {
        next.cancel();
        return Err(DataWindowError::Cancelled);
    }
    jobs.watermark = Some((next.generation, next.suggestion_revision));
    if let Some(previous) = jobs.active.replace(next) {
        previous.cancel();
    }
    Ok(())
}

fn finish_text_value_suggestion_job(
    jobs: &mut TextValueSuggestionJobsState,
    generation: u64,
    suggestion_revision: u64,
    interrupt: &Arc<TextValueSuggestionsInterruptHandle>,
) -> bool {
    let is_current = jobs.active.as_ref().is_some_and(|active| {
        active.generation == generation
            && active.suggestion_revision == suggestion_revision
            && Arc::ptr_eq(&active.interrupt, interrupt)
    }) && jobs.watermark == Some((generation, suggestion_revision));
    if is_current {
        jobs.active.take();
    }
    is_current
}

fn cancel_text_value_suggestion_job(
    jobs: &mut TextValueSuggestionJobsState,
    generation: u64,
    suggestion_revision: u64,
) -> Option<ActiveTextValueSuggestionJob> {
    if !jobs
        .watermark
        .is_some_and(|(watermark_generation, revision)| {
            watermark_generation == generation && revision >= suggestion_revision
        })
    {
        jobs.watermark = Some((generation, suggestion_revision));
    }
    if jobs.active.as_ref().is_some_and(|active| {
        active.generation == generation && active.suggestion_revision == suggestion_revision
    }) {
        jobs.active.take()
    } else {
        None
    }
}

#[derive(Debug, PartialEq)]
enum ColumnStatisticsRequest {
    Cached(ColumnStatistics),
    Scan { path: PathBuf, column_name: String },
}

#[derive(Default)]
struct ColumnStatisticsJobs {
    active: Mutex<Option<ActiveColumnStatisticsJob>>,
}

struct ActiveColumnStatisticsJob {
    generation: u64,
    job: Arc<ColumnStatisticsJob>,
}

struct ColumnStatisticsJob {
    cancelled: AtomicBool,
    interrupt: StatisticsInterruptHandle,
}

impl ColumnStatisticsJob {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.interrupt.interrupt();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedSourceInfo {
    generation: u64,
    #[serde(flatten)]
    summary: SourceSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataViewStatus {
    revision: u64,
    row_count: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataViewResourceCommandDiagnostics {
    application_version: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
    #[serde(flatten)]
    engine: DataViewResourceDiagnostics,
}

impl From<DataViewResourceDiagnostics> for DataViewResourceCommandDiagnostics {
    fn from(engine: DataViewResourceDiagnostics) -> Self {
        Self {
            application_version: env!("CARGO_PKG_VERSION"),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            engine,
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
enum DataViewResourceCommandError {
    MemoryExhausted {
        diagnostics: DataViewResourceCommandDiagnostics,
    },
    TemporaryStorageExhausted {
        diagnostics: DataViewResourceCommandDiagnostics,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum DataWindowCommandError {
    Session(DataWindowSessionError),
    Engine(DataWindowError),
    ViewResource(Box<DataViewResourceCommandError>),
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
enum DataWindowSessionError {
    NoSourceOpen,
    SourceChanged,
    ViewChanged,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
enum ColumnStatisticsCommandError {
    NoSourceOpen,
    SourceChanged,
    UnsupportedColumn,
    Cancelled,
    NotFound,
    PermissionDenied,
    NotParquet,
    CorruptSource,
    Unsupported,
    ResourceExhausted,
    QueryFailed,
    QueryEngineUnavailable,
}

impl From<ColumnStatisticsError> for ColumnStatisticsCommandError {
    fn from(error: ColumnStatisticsError) -> Self {
        match error {
            ColumnStatisticsError::NotFound => Self::NotFound,
            ColumnStatisticsError::PermissionDenied => Self::PermissionDenied,
            ColumnStatisticsError::NotParquet => Self::NotParquet,
            ColumnStatisticsError::CorruptSource => Self::CorruptSource,
            ColumnStatisticsError::Unsupported => Self::Unsupported,
            ColumnStatisticsError::ResourceExhausted => Self::ResourceExhausted,
            ColumnStatisticsError::QueryFailed => Self::QueryFailed,
            ColumnStatisticsError::QueryEngineUnavailable => Self::QueryEngineUnavailable,
        }
    }
}

impl From<DataWindowError> for DataWindowCommandError {
    fn from(error: DataWindowError) -> Self {
        Self::Engine(error)
    }
}

impl From<DataViewError> for DataWindowCommandError {
    fn from(error: DataViewError) -> Self {
        match error {
            DataViewError::Engine(error) => Self::Engine(error),
            DataViewError::MemoryExhausted(diagnostics) => {
                Self::ViewResource(Box::new(DataViewResourceCommandError::MemoryExhausted {
                    diagnostics: (*diagnostics).into(),
                }))
            }
            DataViewError::TemporaryStorageExhausted(diagnostics) => Self::ViewResource(Box::new(
                DataViewResourceCommandError::TemporaryStorageExhausted {
                    diagnostics: (*diagnostics).into(),
                },
            )),
        }
    }
}

/// Stable failures exposed by every source-opening command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(untagged)]
enum OpenSourceError {
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error(transparent)]
    Recent(#[from] RecentSourceError),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceOpenIntent {
    Explicit,
    Restore,
}

impl OpenedSource {
    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, OpenedSourceState>, OpenSourceError> {
        self.state
            .lock()
            .map_err(|_| RecentSourceError::Storage.into())
    }

    fn mark_explicit(&self) -> Result<(), OpenSourceError> {
        self.lock_state()?.blocks_restore = true;
        Ok(())
    }

    fn install(
        &self,
        recent_sources_path: Option<&std::path::Path>,
        path: PathBuf,
        summary: SourceSummary,
        intent: SourceOpenIntent,
    ) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
        let mut state = self.lock_state()?;
        if intent == SourceOpenIntent::Restore && state.blocks_restore {
            return Ok(None);
        }
        self.cancel_data_views()?;
        self.data_exports.cancel_all();
        self.cancel_text_suggestions()?;
        let generation = state
            .generation
            .checked_add(1)
            .ok_or(SourceError::Unsupported)?;
        state.generation = generation;
        let schema = summary.schema.clone();
        state.session = Some(OpenedSourceSession {
            generation,
            reader: DataWindowReader::new(path.clone()),
            path,
            schema,
            source_row_count: summary.row_count,
            view_revision: 0,
            view: None,
            statistics_cache: HashMap::new(),
        });
        if intent == SourceOpenIntent::Explicit {
            state.blocks_restore = true;
        }
        if let Some(recent_sources_path) = recent_sources_path {
            // Keep source state and recents in the same order when restore races an explicit open.
            // The source is already open; history remains best-effort.
            let path = &state.session.as_ref().ok_or(SourceError::Unsupported)?.path;
            let _ = self.recents.record_path(recent_sources_path, path);
        }
        Ok(Some(OpenedSourceInfo {
            generation,
            summary,
        }))
    }

    pub(crate) fn current_path(&self) -> Result<Option<PathBuf>, OpenSourceError> {
        Ok(self
            .lock_state()?
            .session
            .as_ref()
            .map(|session| session.path.clone()))
    }

    fn blocks_restore(&self) -> Result<bool, OpenSourceError> {
        Ok(self.lock_state()?.blocks_restore)
    }

    fn cancel_data_views(&self) -> Result<(), OpenSourceError> {
        let mut jobs = self
            .data_views
            .state
            .lock()
            .map_err(|_| RecentSourceError::Storage)?;
        let active = jobs.active.take();
        jobs.watermark = None;
        drop(jobs);
        if let Some(active) = active {
            active.cancel();
        }
        Ok(())
    }

    fn cancel_text_suggestions(&self) -> Result<(), OpenSourceError> {
        let mut jobs = self
            .text_suggestions
            .state
            .lock()
            .map_err(|_| RecentSourceError::Storage)?;
        let active = jobs.active.take();
        jobs.watermark = None;
        drop(jobs);
        if let Some(active) = active {
            active.cancel();
        }
        Ok(())
    }
}

/// Reports whether the shell-independent engine is linked and responsive.
#[tauri::command]
fn get_engine_status() -> Result<EngineStatus, EngineError> {
    engine_status()
}

/// Returns a bounded row window as a raw Arrow IPC response.
#[tauri::command]
async fn get_data_window(
    generation: u64,
    view_revision: u64,
    row_offset: u64,
    row_count: u32,
    source_indices: Vec<u32>,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<tauri::ipc::Response, DataWindowCommandError> {
    let state = Arc::clone(&opened_source.state);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let mut state = state.lock().map_err(|_| DataWindowError::Unsupported)?;
        fetch_opened_source_window(
            &mut state,
            generation,
            view_revision,
            row_offset,
            row_count,
            &source_indices,
        )
    })
    .await
    .map_err(|_| DataWindowError::QueryEngineUnavailable)??;

    Ok(tauri::ipc::Response::new(bytes))
}

fn fetch_opened_source_window(
    state: &mut OpenedSourceState,
    generation: u64,
    view_revision: u64,
    row_offset: u64,
    row_count: u32,
    source_indices: &[u32],
) -> Result<Vec<u8>, DataWindowCommandError> {
    let session = state
        .session
        .as_mut()
        .ok_or(DataWindowCommandError::Session(
            DataWindowSessionError::NoSourceOpen,
        ))?;
    if session.generation != generation {
        return Err(DataWindowCommandError::Session(
            DataWindowSessionError::SourceChanged,
        ));
    }
    if session.view_revision != view_revision {
        return Err(DataWindowCommandError::Session(
            DataWindowSessionError::ViewChanged,
        ));
    }
    match &session.view {
        Some(view) => view
            .fetch_window_columns(row_offset, row_count, source_indices)
            .map_err(Into::into),
        None => {
            // The session installs its schema and reader from the same source generation.
            // Keep this predicate aligned with DataWindowReader::fetch_columns: this fast path
            // avoids parsing the footer, while the reader still protects direct library callers.
            let identity_projection = !source_indices.is_empty()
                && source_indices.len() == session.schema.len()
                && source_indices
                    .iter()
                    .enumerate()
                    .all(|(index, source_index)| usize::try_from(*source_index) == Ok(index));
            if identity_projection {
                session
                    .reader
                    .fetch(row_offset, row_count)
                    .map_err(Into::into)
            } else {
                session
                    .reader
                    .fetch_columns(row_offset, row_count, source_indices)
                    .map_err(Into::into)
            }
        }
    }
}

/// Prepares one filtered and sorted position index, then atomically publishes it.
#[tauri::command]
async fn prepare_data_view(
    generation: u64,
    view_revision: u64,
    filters: Vec<DataFilter>,
    sort: Vec<DataSort>,
    settings: DataViewSettings,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<DataViewStatus, DataWindowCommandError> {
    if filters.is_empty() && sort.is_empty() {
        return activate_direct_data_view(&opened_source, generation, view_revision);
    }
    let path = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let session = state
            .session
            .as_ref()
            .ok_or(DataWindowCommandError::Session(
                DataWindowSessionError::NoSourceOpen,
            ))?;
        if session.generation != generation {
            return Err(DataWindowCommandError::Session(
                DataWindowSessionError::SourceChanged,
            ));
        }
        session.path.clone()
    };
    let builder = DataViewBuilder::with_memory_limit(path, &filters, &sort, settings.memory_limit)?;
    let interrupt = Arc::new(builder.interrupt_handle());
    {
        // Registration shares the source -> view lock order with source replacement.
        // A replacement therefore either sees and cancels this job, or wins first and
        // makes this generation stale before preparation can start.
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let session = state
            .session
            .as_ref()
            .ok_or(DataWindowCommandError::Session(
                DataWindowSessionError::NoSourceOpen,
            ))?;
        if session.generation != generation {
            return Err(DataWindowCommandError::Session(
                DataWindowSessionError::SourceChanged,
            ));
        }
        let mut jobs = opened_source
            .data_views
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        register_data_view_job(
            &mut jobs,
            ActiveDataViewJob {
                generation,
                interrupt: Arc::clone(&interrupt),
                view_revision,
            },
        )?;
    }

    let result = tauri::async_runtime::spawn_blocking(move || builder.build()).await;
    let cancelled = interrupt.is_cancelled();
    let mut state = opened_source
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    let mut jobs = opened_source
        .data_views
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    let is_current = finish_data_view_job(&mut jobs, generation, view_revision, &interrupt);
    drop(jobs);
    if cancelled || !is_current {
        return Err(DataWindowError::Cancelled.into());
    }
    let view = result.map_err(|_| DataWindowError::QueryEngineUnavailable)??;
    let session = state
        .session
        .as_mut()
        .ok_or(DataWindowCommandError::Session(
            DataWindowSessionError::NoSourceOpen,
        ))?;
    if session.generation != generation {
        return Err(DataWindowCommandError::Session(
            DataWindowSessionError::SourceChanged,
        ));
    }
    if view_revision <= session.view_revision {
        return Err(DataWindowError::Cancelled.into());
    }
    let status = DataViewStatus {
        revision: view_revision,
        row_count: view.row_count(),
    };
    session.view_revision = view_revision;
    session.view = Some(view);
    Ok(status)
}

fn activate_direct_data_view(
    opened_source: &OpenedSource,
    generation: u64,
    view_revision: u64,
) -> Result<DataViewStatus, DataWindowCommandError> {
    let mut state = opened_source
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    let session = state
        .session
        .as_mut()
        .ok_or(DataWindowCommandError::Session(
            DataWindowSessionError::NoSourceOpen,
        ))?;
    if session.generation != generation {
        return Err(DataWindowCommandError::Session(
            DataWindowSessionError::SourceChanged,
        ));
    }
    if view_revision <= session.view_revision {
        return Err(DataWindowError::Cancelled.into());
    }
    let mut jobs = opened_source
        .data_views
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    if jobs
        .watermark
        .is_some_and(|(watermark_generation, revision)| {
            watermark_generation == generation && view_revision <= revision
        })
    {
        return Err(DataWindowError::Cancelled.into());
    }
    jobs.watermark = Some((generation, view_revision));
    if let Some(active) = jobs.active.take() {
        active.cancel();
    }
    let status = DataViewStatus {
        revision: view_revision,
        row_count: session.source_row_count,
    };
    session.view_revision = view_revision;
    session.view = None;
    Ok(status)
}

/// Returns the native view revision and count used by current grid windows.
#[tauri::command]
fn get_data_view_status(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<DataViewStatus, DataWindowCommandError> {
    let state = opened_source
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    let session = state
        .session
        .as_ref()
        .ok_or(DataWindowCommandError::Session(
            DataWindowSessionError::NoSourceOpen,
        ))?;
    if session.generation != generation {
        return Err(DataWindowCommandError::Session(
            DataWindowSessionError::SourceChanged,
        ));
    }
    Ok(DataViewStatus {
        revision: session.view_revision,
        row_count: session
            .view
            .as_ref()
            .map_or(session.source_row_count, PreparedDataView::row_count),
    })
}

/// Interrupts one preparation revision without touching a newer request.
#[tauri::command]
fn cancel_data_view(
    generation: u64,
    view_revision: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<(), DataWindowCommandError> {
    let active = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        if !state
            .session
            .as_ref()
            .is_some_and(|session| session.generation == generation)
        {
            return Ok(());
        }
        let mut jobs = opened_source
            .data_views
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        cancel_data_view_job(&mut jobs, generation, view_revision)
    };
    if let Some(active) = active {
        active.cancel();
    }
    Ok(())
}

/// Suggests actual text values on an isolated connection so typing stays responsive.
#[tauri::command]
async fn get_text_value_suggestions(
    generation: u64,
    suggestion_revision: u64,
    column_index: usize,
    prefix: String,
    operator: DataFilterOperator,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<TextValueSuggestions, DataWindowCommandError> {
    let (path, column) = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let session = state
            .session
            .as_ref()
            .ok_or(DataWindowCommandError::Session(
                DataWindowSessionError::NoSourceOpen,
            ))?;
        if session.generation != generation {
            return Err(DataWindowCommandError::Session(
                DataWindowSessionError::SourceChanged,
            ));
        }
        let column = session
            .schema
            .get(column_index)
            .cloned()
            .ok_or(DataWindowError::InvalidFilter)?;
        (session.path.clone(), column)
    };
    let reader = TextValueSuggestionsReader::new(path, prefix)?;
    let interrupt = Arc::new(reader.interrupt_handle());
    {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let session = state
            .session
            .as_ref()
            .ok_or(DataWindowCommandError::Session(
                DataWindowSessionError::NoSourceOpen,
            ))?;
        if session.generation != generation {
            return Err(DataWindowCommandError::Session(
                DataWindowSessionError::SourceChanged,
            ));
        }
        let mut jobs = opened_source
            .text_suggestions
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        register_text_value_suggestion_job(
            &mut jobs,
            ActiveTextValueSuggestionJob {
                generation,
                suggestion_revision,
                interrupt: Arc::clone(&interrupt),
            },
        )?;
    }

    let result =
        tauri::async_runtime::spawn_blocking(move || reader.fetch(&column, operator)).await;
    let cancelled = interrupt.is_cancelled();
    let state = opened_source
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    let source_is_current = state
        .session
        .as_ref()
        .is_some_and(|session| session.generation == generation);
    let mut jobs = opened_source
        .text_suggestions
        .state
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?;
    let is_current =
        finish_text_value_suggestion_job(&mut jobs, generation, suggestion_revision, &interrupt);
    drop(jobs);
    drop(state);

    if cancelled || !source_is_current || !is_current {
        Err(DataWindowError::Cancelled.into())
    } else {
        result
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?
            .map_err(Into::into)
    }
}

/// Interrupts one suggestion revision without touching a newer request.
#[tauri::command]
fn cancel_text_value_suggestions(
    generation: u64,
    suggestion_revision: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<(), DataWindowCommandError> {
    let active = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        if !state
            .session
            .as_ref()
            .is_some_and(|session| session.generation == generation)
        {
            return Ok(());
        }
        let mut jobs = opened_source
            .text_suggestions
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        cancel_text_value_suggestion_job(&mut jobs, generation, suggestion_revision)
    };
    if let Some(active) = active {
        active.cancel();
    }
    Ok(())
}

/// Computes statistics on a separate, cancellable query connection.
#[tauri::command]
async fn get_column_statistics(
    generation: u64,
    column_index: usize,
    include_min_max: bool,
    opened_source: tauri::State<'_, OpenedSource>,
    statistics_jobs: tauri::State<'_, ColumnStatisticsJobs>,
) -> Result<ColumnStatistics, ColumnStatisticsCommandError> {
    let request = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| ColumnStatisticsCommandError::Unsupported)?;
        statistics_request(&state, generation, column_index, include_min_max)?
    };
    let (path, column_name) = match request {
        ColumnStatisticsRequest::Cached(statistics) => {
            cancel_active_statistics_job(&statistics_jobs, generation)?;
            return Ok(statistics);
        }
        ColumnStatisticsRequest::Scan { path, column_name } => (path, column_name),
    };
    let reader = ColumnStatisticsReader::new(path)?;
    let job = Arc::new(ColumnStatisticsJob {
        cancelled: AtomicBool::new(false),
        interrupt: reader.interrupt_handle(),
    });
    let previous = statistics_jobs
        .active
        .lock()
        .map_err(|_| ColumnStatisticsCommandError::Unsupported)?
        .replace(ActiveColumnStatisticsJob {
            generation,
            job: Arc::clone(&job),
        });
    if let Some(previous) = previous {
        previous.job.cancel();
    }

    let result =
        tauri::async_runtime::spawn_blocking(move || reader.fetch(&column_name, include_min_max))
            .await;
    let mut active = statistics_jobs
        .active
        .lock()
        .map_err(|_| ColumnStatisticsCommandError::Unsupported)?;
    if active
        .as_ref()
        .is_some_and(|current| current.generation == generation && Arc::ptr_eq(&current.job, &job))
    {
        active.take();
    }
    drop(active);
    let cancelled = job.cancelled.load(Ordering::Acquire);

    if cancelled {
        return Err(ColumnStatisticsCommandError::Cancelled);
    }
    let statistics = result
        .map_err(|_| ColumnStatisticsCommandError::QueryEngineUnavailable)?
        .map_err(ColumnStatisticsCommandError::from)?;
    let mut state = opened_source
        .state
        .lock()
        .map_err(|_| ColumnStatisticsCommandError::Unsupported)?;
    cache_statistics(&mut state, generation, column_index, statistics.clone())?;
    Ok(statistics)
}

fn statistics_request(
    state: &OpenedSourceState,
    generation: u64,
    column_index: usize,
    include_min_max: bool,
) -> Result<ColumnStatisticsRequest, ColumnStatisticsCommandError> {
    let session = state
        .session
        .as_ref()
        .ok_or(ColumnStatisticsCommandError::NoSourceOpen)?;
    if session.generation != generation {
        return Err(ColumnStatisticsCommandError::SourceChanged);
    }
    if let Some(statistics) = session
        .statistics_cache
        .get(&(generation, column_index))
        .filter(|statistics| !include_min_max || statistics.min_max_computed)
    {
        return Ok(ColumnStatisticsRequest::Cached(statistics.clone()));
    }
    let column_name = session
        .schema
        .get(column_index)
        .ok_or(ColumnStatisticsCommandError::UnsupportedColumn)?
        .name
        .clone();
    Ok(ColumnStatisticsRequest::Scan {
        path: session.path.clone(),
        column_name,
    })
}

fn cache_statistics(
    state: &mut OpenedSourceState,
    generation: u64,
    column_index: usize,
    statistics: ColumnStatistics,
) -> Result<(), ColumnStatisticsCommandError> {
    let session = state
        .session
        .as_mut()
        .ok_or(ColumnStatisticsCommandError::NoSourceOpen)?;
    if session.generation != generation {
        return Err(ColumnStatisticsCommandError::SourceChanged);
    }
    if session.schema.get(column_index).is_none() {
        return Err(ColumnStatisticsCommandError::UnsupportedColumn);
    }
    match session.statistics_cache.entry((generation, column_index)) {
        Entry::Vacant(entry) => {
            entry.insert(statistics);
        }
        Entry::Occupied(mut entry)
            if statistics.min_max_computed || !entry.get().min_max_computed =>
        {
            entry.insert(statistics);
        }
        Entry::Occupied(_) => {}
    }
    Ok(())
}

fn cancel_active_statistics_job(
    statistics_jobs: &ColumnStatisticsJobs,
    generation: u64,
) -> Result<(), ColumnStatisticsCommandError> {
    let active = {
        let mut active = statistics_jobs
            .active
            .lock()
            .map_err(|_| ColumnStatisticsCommandError::Unsupported)?;
        if active
            .as_ref()
            .is_some_and(|active| active.generation == generation)
        {
            active.take()
        } else {
            None
        }
    };
    if let Some(active) = active {
        active.job.cancel();
    }
    Ok(())
}

/// Interrupts the active statistics scan for an opened-source generation.
#[tauri::command]
fn cancel_column_statistics(
    generation: u64,
    statistics_jobs: tauri::State<'_, ColumnStatisticsJobs>,
) -> Result<(), ColumnStatisticsCommandError> {
    cancel_active_statistics_job(&statistics_jobs, generation)
}

/// Owns the native file dialog and passes the selected path directly to data-engine.
///
/// The dialog lives on the Rust side on purpose: the plugin's JS `open()`
/// API would hand the raw path to the webview, and the UI must never see
/// paths or touch files. Cancellation returns `Ok(None)` — it is a normal
/// outcome, not an error.
#[tauri::command]
async fn open_local_source(
    app: tauri::AppHandle,
) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
    // blocking_pick_file would stall the async runtime thread.
    let inspected = tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("Parquet", &["parquet"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| SourceError::Unsupported)?;

        inspect_selected_source(&app, path, SourceOpenIntent::Explicit)
    })
    .await
    .map_err(|_| SourceError::Unsupported)??;

    Ok(inspected.map(|(_, source)| source))
}

fn inspect_selected_source(
    app: &tauri::AppHandle,
    path: PathBuf,
    intent: SourceOpenIntent,
) -> Result<Option<(PathBuf, OpenedSourceInfo)>, OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    let recent_sources_path = recents::state_path(app).ok();
    inspect_selected_source_at_path(
        recent_sources_path.as_deref(),
        opened_source.inner(),
        path,
        intent,
    )
}

fn inspect_selected_source_at_path(
    recent_sources_path: Option<&std::path::Path>,
    opened_source: &OpenedSource,
    path: PathBuf,
    intent: SourceOpenIntent,
) -> Result<Option<(PathBuf, OpenedSourceInfo)>, OpenSourceError> {
    if intent == SourceOpenIntent::Restore && opened_source.blocks_restore()? {
        return Ok(None);
    }
    let summary = match inspect_local_source(&path) {
        Ok(summary) => summary,
        Err(_) if intent == SourceOpenIntent::Restore && opened_source.blocks_restore()? => {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    remember_inspected_source(recent_sources_path, opened_source, path, summary, intent)
}

fn remember_inspected_source(
    recent_sources_path: Option<&std::path::Path>,
    opened_source: &OpenedSource,
    path: PathBuf,
    summary: SourceSummary,
    intent: SourceOpenIntent,
) -> Result<Option<(PathBuf, OpenedSourceInfo)>, OpenSourceError> {
    let canonical_path = std::fs::canonicalize(&path).unwrap_or(path);
    let source =
        opened_source.install(recent_sources_path, canonical_path.clone(), summary, intent)?;
    Ok(source.map(|source| (canonical_path, source)))
}

fn require_explicit_source(
    source: Option<(PathBuf, OpenedSourceInfo)>,
) -> Result<(PathBuf, OpenedSourceInfo), OpenSourceError> {
    debug_assert!(
        source.is_some(),
        "an explicit source open cannot be superseded by restore"
    );
    source.ok_or_else(|| SourceError::Unsupported.into())
}

/// Returns existing recent sources without exposing their paths.
#[tauri::command]
async fn get_recent_sources(app: tauri::AppHandle) -> Result<Vec<RecentSource>, RecentSourceError> {
    tauri::async_runtime::spawn_blocking(move || {
        let opened_source = app.state::<OpenedSource>();
        opened_source.recents.list(&app)
    })
    .await
    .map_err(|_| RecentSourceError::Storage)?
}

/// Reopens a Rust-owned recent source selected by its opaque identifier.
#[tauri::command]
async fn open_recent_source(
    app: tauri::AppHandle,
    id: String,
) -> Result<OpenedSourceInfo, OpenSourceError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || open_recent_source_with_app(&app, &id))
            .await
            .map_err(|_| SourceError::Unsupported)?;

    result.map(|(_, source)| source)
}

fn open_recent_source_with_app(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<(PathBuf, OpenedSourceInfo), OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    open_recent_source_at_path(&recents::state_path(app)?, opened_source.inner(), id)
}

fn open_recent_source_at_path(
    recent_sources_path: &std::path::Path,
    opened_source: &OpenedSource,
    id: &str,
) -> Result<(PathBuf, OpenedSourceInfo), OpenSourceError> {
    let path = opened_source
        .recents
        .path_for_id_path(recent_sources_path, id)?;
    let result = inspect_selected_source_at_path(
        Some(recent_sources_path),
        opened_source,
        path,
        SourceOpenIntent::Explicit,
    )
    .and_then(require_explicit_source);
    if result == Err(SourceError::NotFound.into()) {
        // Preserve the existing source error even if cleaning a damaged store fails.
        let _ = opened_source.recents.remove_path(recent_sources_path, id);
    }
    result
}

fn check_for_updates_from_menu(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = check_for_update_with_state(
            &app,
            app.state::<PendingUpdate>().inner(),
            app.state::<UpdateStateStore>().inner(),
            false,
            false,
        )
        .await;

        if let Ok(Some(update)) = &result {
            // The receiver can already be gone while the app is shutting down.
            let _ = app.emit(UPDATE_AVAILABLE_EVENT, update.clone());
            return;
        }

        if let Some((message, kind)) = manual_update_check_dialog(&result) {
            app.dialog()
                .message(message)
                .title("Viewda")
                .kind(kind)
                .show(|_| {});
        }
    });
}

fn manual_update_check_dialog(
    result: &Result<Option<UpdateInfo>, UpdateError>,
) -> Option<(&'static str, MessageDialogKind)> {
    match result {
        Ok(Some(_)) => None,
        Ok(None) => Some(("Viewda is up to date", MessageDialogKind::Info)),
        #[cfg(target_os = "linux")]
        Err(UpdateError::ManualInstall) => Some((
            "This package uses manual updates. Install the AppImage to update inside Viewda.",
            MessageDialogKind::Info,
        )),
        Err(_) => Some((
            "Could not check for updates. Try again later.",
            MessageDialogKind::Error,
        )),
    }
}

/// Starts the Viewda desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        open_from_args(
            app,
            args.into_iter().map(OsString::from),
            std::path::Path::new(&cwd),
        );
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(OpenedSource::default())
        .manage(ColumnStatisticsJobs::default())
        .manage(PendingOpenedSource::default())
        .manage(PendingUpdate::default())
        .manage(UpdateStateStore::default())
        .setup(|_app| {
            apply_saved_theme(_app.handle(), &_app.state::<UpdateStateStore>());
            #[cfg(not(target_os = "macos"))]
            {
                let cwd = std::env::current_dir().unwrap_or_default();
                open_from_args(_app.handle(), std::env::args_os(), &cwd);
            }
            Ok(())
        })
        .menu(|app| {
            // Built on top of the default menu, never a replacement: on
            // macOS the first submenu always becomes the application menu,
            // so a from-scratch menubar would silently drop Quit, Edit
            // (clipboard) and Window.
            let menu = Menu::default(app)?;
            let open_source = MenuItemBuilder::with_id(OPEN_SOURCE_MENU_ID, "Open File…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let check_for_updates =
                MenuItemBuilder::with_id(CHECK_FOR_UPDATES_MENU_ID, "Check for Updates…")
                    .build(app)?;
            // Lookup by title assumes Tauri's default menu is English;
            // revisit if menus are ever localized.
            let existing_file_menu = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu)
                    if submenu.text().is_ok_and(|text| text == "File") =>
                {
                    Some(submenu)
                }
                _ => None,
            });

            if let Some(file_menu) = existing_file_menu {
                let open_separator = PredefinedMenuItem::separator(app)?;
                #[cfg(target_os = "macos")]
                file_menu.prepend_items(&[&open_source, &open_separator])?;
                #[cfg(not(target_os = "macos"))]
                {
                    let update_separator = PredefinedMenuItem::separator(app)?;
                    file_menu.prepend_items(&[
                        &open_source,
                        &open_separator,
                        &settings,
                        &check_for_updates,
                        &update_separator,
                    ])?;
                }
            } else {
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&open_source)
                    .separator();
                #[cfg(not(target_os = "macos"))]
                let file_menu = file_menu
                    .item(&settings)
                    .item(&check_for_updates)
                    .separator();
                let file_menu = file_menu.close_window().quit().build()?;
                menu.prepend(&file_menu)?;
            }

            #[cfg(target_os = "macos")]
            if let Some(app_menu) = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu) => Some(submenu),
                _ => None,
            }) {
                let separator = PredefinedMenuItem::separator(app)?;
                // The default application menu starts with About + separator.
                app_menu.insert_items(&[&settings, &check_for_updates, &separator], 2)?;
            }

            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == OPEN_SOURCE_MENU_ID {
                // The frontend receiver can already be gone while the app is shutting down.
                let _ = app.emit(OPEN_SOURCE_REQUESTED_EVENT, ());
            } else if event.id() == SETTINGS_MENU_ID {
                let _ = app.emit(SETTINGS_REQUESTED_EVENT, ());
            } else if event.id() == CHECK_FOR_UPDATES_MENU_ID {
                check_for_updates_from_menu(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_status,
            open_local_source,
            get_recent_sources,
            open_recent_source,
            take_opened_source,
            get_default_application_status,
            set_default_application,
            get_data_window,
            prepare_data_view,
            get_data_view_status,
            cancel_data_view,
            start_data_export,
            get_data_export_status,
            cancel_data_export,
            dismiss_data_export,
            reveal_data_export,
            get_text_value_suggestions,
            cancel_text_value_suggestions,
            get_column_statistics,
            cancel_column_statistics,
            get_update_settings,
            set_update_settings,
            get_data_view_settings,
            set_data_view_settings,
            get_theme_preference,
            set_theme_preference,
            sync_system_theme,
            check_for_update,
            discard_pending_update,
            install_pending_update,
            take_post_update_state,
            open_releases_page
        ])
        .build(tauri::generate_context!())
        .expect("Viewda desktop runtime failed")
        .run(|app, event| {
            if matches!(
                &event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let _ = app.state::<OpenedSource>().cancel_data_views();
                app.state::<OpenedSource>()
                    .data_exports
                    .cancel_all_and_wait();
                let _ = app.state::<OpenedSource>().cancel_text_suggestions();
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event
                && let Some(path) = urls.into_iter().find_map(|url| url.to_file_path().ok())
            {
                open_path(app, path);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_is_owned_by_the_data_engine() {
        let status = get_engine_status().expect("packaged query engine should start");

        assert_eq!(status.name, "Viewda data engine");
        assert_eq!(status.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn view_resource_failures_serialize_safe_support_diagnostics() {
        let error = DataWindowCommandError::from(DataViewError::MemoryExhausted(Box::new(
            DataViewResourceDiagnostics {
                operation: viewda_data_engine::DataViewResourceOperation::Preparation,
                query_engine_version: "v1.5.5".into(),
                message: "Out of Memory Error: allocation failed".into(),
                memory_limit: "366.2 MiB".into(),
                max_temporary_directory_size: "45.0 GiB".into(),
                threads: 10,
                row_count: 3_514_000,
                source_size_bytes: 1_000_000_000,
                row_group_count: 29,
                column_count: 43,
                filter_count: 0,
                sort_columns: vec![viewda_data_engine::DataViewSortDiagnostic {
                    physical_type: "INT32".into(),
                    logical_type: Some("UInt16".into()),
                    direction: viewda_data_engine::DataSortDirection::Ascending,
                }],
            },
        )));

        let value = serde_json::to_value(error).expect("serialized view error");

        assert_eq!(value["code"], "memoryExhausted");
        assert_eq!(value["diagnostics"]["operation"], "preparation");
        assert_eq!(
            value["diagnostics"]["applicationVersion"],
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(
            value["diagnostics"]["operatingSystem"],
            std::env::consts::OS
        );
        assert_eq!(value["diagnostics"]["architecture"], std::env::consts::ARCH);
        assert_eq!(
            value["diagnostics"]["sortColumns"][0]["logicalType"],
            "UInt16"
        );
        assert!(!value.to_string().contains("source.parquet"));
    }

    #[test]
    fn selected_paths_cross_directly_into_the_data_engine() {
        let missing = PathBuf::from("/viewda-test/source-that-does-not-exist.parquet");
        let directory = tempfile::tempdir().expect("temporary directory");
        let opened_source = OpenedSource::default();

        assert_eq!(
            inspect_selected_source_at_path(
                Some(&directory.path().join("recents.json")),
                &opened_source,
                missing,
                SourceOpenIntent::Explicit,
            ),
            Err(SourceError::NotFound.into())
        );
    }

    #[test]
    fn opening_an_unknown_recent_id_returns_a_typed_error() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let opened_source = OpenedSource::default();

        assert_eq!(
            open_recent_source_at_path(
                &directory.path().join("recents.json"),
                &opened_source,
                "recent-that-does-not-exist",
            ),
            Err(RecentSourceError::UnknownRecent.into())
        );
    }

    #[test]
    fn history_write_failures_do_not_override_a_successful_inspection() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source_path = directory.path().join("source.parquet");
        std::fs::write(&source_path, b"already inspected by the caller").expect("source fixture");
        let blocked_parent = directory.path().join("not-a-directory");
        std::fs::write(&blocked_parent, b"file blocks recents.json").expect("blocked store");
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".to_owned(),
            size_bytes: 31,
            row_count: 1,
            row_group_count: 1,
            schema: Vec::new(),
        };

        let opened = remember_inspected_source(
            Some(&blocked_parent.join("recents.json")),
            &opened_source,
            source_path.clone(),
            summary.clone(),
            SourceOpenIntent::Explicit,
        )
        .expect("history storage is best-effort")
        .expect("explicit source is accepted");

        assert_eq!(
            opened.0,
            std::fs::canonicalize(source_path).expect("source path")
        );
        assert_eq!(opened.1.generation, 1);
        assert_eq!(opened.1.summary, summary);
        assert_eq!(
            opened_source.current_path().expect("opened-source state"),
            Some(opened.0)
        );
    }

    #[test]
    fn opening_a_recent_source_removes_it_when_the_file_disappeared() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let recent_sources_path = directory.path().join("recents.json");
        let source_path = directory.path().join("gone.parquet");
        let opened_source = OpenedSource::default();
        std::fs::write(&source_path, b"not inspected before removal").expect("source fixture");
        opened_source
            .recents
            .record_path(&recent_sources_path, &source_path)
            .expect("recent source");
        std::fs::remove_file(source_path).expect("remove source fixture");

        assert_eq!(
            open_recent_source_at_path(&recent_sources_path, &opened_source, "recent-1"),
            Err(SourceError::NotFound.into())
        );
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );
    }

    #[test]
    fn source_and_recent_errors_keep_their_flat_wire_format() {
        assert_eq!(
            serde_json::to_value(OpenSourceError::from(SourceError::NotFound))
                .expect("source error JSON"),
            serde_json::json!({ "code": "notFound" })
        );
        assert_eq!(
            serde_json::to_value(OpenSourceError::from(RecentSourceError::UnknownRecent))
                .expect("recent-source error JSON"),
            serde_json::json!({ "code": "unknownRecent" })
        );
    }

    #[test]
    fn data_filter_accepts_the_camel_case_match_case_flag() {
        let filter: DataFilter = serde_json::from_value(serde_json::json!({
            "columnIndex": 0,
            "operator": "textContains",
            "values": ["Alpha"],
            "matchCase": true
        }))
        .expect("camelCase filter JSON");

        assert!(filter.match_case);
    }

    #[test]
    fn text_suggestions_keep_the_camel_case_wire_shape() {
        assert_eq!(
            serde_json::to_value(TextValueSuggestions {
                values: vec!["Alpha".to_owned()],
                is_partial: true,
                scan_limit: 10_000,
            })
            .expect("text suggestions JSON"),
            serde_json::json!({
                "values": ["Alpha"],
                "isPartial": true,
                "scanLimit": 10_000
            })
        );
    }

    #[test]
    fn explicit_activation_prevents_restore_from_replacing_the_native_source() {
        let opened_source = OpenedSource::default();
        let launched = PathBuf::from("launched.parquet");
        let summary = SourceSummary {
            display_name: "source.parquet".to_owned(),
            size_bytes: 1,
            row_count: 1,
            row_group_count: 1,
            schema: Vec::new(),
        };

        opened_source
            .install(
                None,
                launched.clone(),
                summary.clone(),
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("explicit source is accepted");
        assert!(
            opened_source
                .install(
                    None,
                    PathBuf::from("restored.parquet"),
                    summary,
                    SourceOpenIntent::Restore,
                )
                .expect("source state")
                .is_none()
        );
        assert_eq!(opened_source.current_path(), Ok(Some(launched)));
    }

    #[test]
    fn restore_bumps_recents_only_when_it_becomes_the_opened_source() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let recent_sources_path = directory.path().join("recents.json");
        let restored_path = directory.path().join("restored.parquet");
        let explicit_path = directory.path().join("explicit.parquet");
        std::fs::write(&restored_path, b"restored source").expect("restored fixture");
        std::fs::write(&explicit_path, b"explicit source").expect("explicit fixture");
        let opened_source = OpenedSource::default();
        opened_source
            .recents
            .record_path(&recent_sources_path, &restored_path)
            .expect("restored recent");
        opened_source
            .recents
            .record_path(&recent_sources_path, &explicit_path)
            .expect("explicit recent");
        let summary = SourceSummary {
            display_name: "source.parquet".to_owned(),
            size_bytes: 1,
            row_count: 1,
            row_group_count: 1,
            schema: Vec::new(),
        };
        let first_recent_id = || {
            let stored: serde_json::Value = serde_json::from_slice(
                &std::fs::read(&recent_sources_path).expect("recent sources"),
            )
            .expect("recent sources JSON");
            stored["entries"][0]["id"]
                .as_str()
                .expect("recent source id")
                .to_owned()
        };

        assert!(
            remember_inspected_source(
                Some(&recent_sources_path),
                &opened_source,
                restored_path.clone(),
                summary.clone(),
                SourceOpenIntent::Restore,
            )
            .expect("restore source state")
            .is_some()
        );
        assert_eq!(first_recent_id(), "recent-1");

        remember_inspected_source(
            Some(&recent_sources_path),
            &opened_source,
            explicit_path,
            summary.clone(),
            SourceOpenIntent::Explicit,
        )
        .expect("explicit source state")
        .expect("explicit source is accepted");
        assert!(
            remember_inspected_source(
                Some(&recent_sources_path),
                &opened_source,
                restored_path,
                summary,
                SourceOpenIntent::Restore,
            )
            .expect("restore source state")
            .is_none()
        );
        assert_eq!(first_recent_id(), "recent-2");
    }

    #[test]
    fn a_window_request_without_a_source_has_a_stable_error() {
        assert_eq!(
            serde_json::to_value(DataWindowCommandError::Session(
                DataWindowSessionError::NoSourceOpen,
            ))
            .expect("session error is serializable"),
            serde_json::json!({ "code": "noSourceOpen" })
        );
    }

    #[test]
    fn a_stale_generation_cannot_read_the_replacement_source() {
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".into(),
            size_bytes: 8,
            row_count: 1,
            row_group_count: 1,
            schema: Vec::new(),
        };
        let first = opened_source
            .install(
                None,
                PathBuf::from("first.parquet"),
                summary.clone(),
                SourceOpenIntent::Explicit,
            )
            .expect("first source state")
            .expect("first source is accepted");
        let second = opened_source
            .install(
                None,
                PathBuf::from("second.parquet"),
                summary,
                SourceOpenIntent::Explicit,
            )
            .expect("replacement source state")
            .expect("replacement source is accepted");
        let mut state = opened_source.state.lock().expect("opened source state");

        assert!(second.generation > first.generation);
        assert_eq!(
            fetch_opened_source_window(&mut state, first.generation, 0, 0, 1, &[]),
            Err(DataWindowCommandError::Session(
                DataWindowSessionError::SourceChanged,
            ))
        );
    }

    #[test]
    fn direct_windows_validate_projection_before_reading_the_source() {
        let opened_source = OpenedSource::default();
        let opened = opened_source
            .install(
                None,
                PathBuf::from("missing-direct-projection-source.parquet"),
                SourceSummary {
                    display_name: "source.parquet".into(),
                    size_bytes: 8,
                    row_count: 1,
                    row_group_count: 1,
                    schema: vec![
                        SchemaField {
                            name: "value".into(),
                            physical_type: "INT64".into(),
                            logical_type: None,
                            children: Vec::new(),
                        },
                        SchemaField {
                            name: "other".into(),
                            physical_type: "INT64".into(),
                            logical_type: None,
                            children: Vec::new(),
                        },
                    ],
                },
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("source is accepted");
        let mut state = opened_source.state.lock().expect("opened source state");

        assert_eq!(
            fetch_opened_source_window(&mut state, opened.generation, 0, 0, 1, &[]),
            Err(DataWindowCommandError::Engine(DataWindowError::Unsupported))
        );
        assert_eq!(
            fetch_opened_source_window(&mut state, opened.generation, 0, 0, 1, &[1]),
            Err(DataWindowCommandError::Engine(DataWindowError::NotFound))
        );
    }

    #[test]
    fn replacing_the_source_interrupts_the_active_view_preparation() {
        let opened_source = OpenedSource::default();
        let builder =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("view builder");
        let interrupt = Arc::new(builder.interrupt_handle());
        opened_source
            .data_views
            .state
            .lock()
            .expect("view jobs")
            .active
            .replace(ActiveDataViewJob {
                generation: 1,
                view_revision: 3,
                interrupt: Arc::clone(&interrupt),
            });

        opened_source
            .install(
                None,
                PathBuf::from("replacement.parquet"),
                SourceSummary {
                    display_name: "replacement.parquet".into(),
                    size_bytes: 8,
                    row_count: 1,
                    row_group_count: 1,
                    schema: Vec::new(),
                },
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("replacement source is accepted");

        assert!(interrupt.is_cancelled());
        assert!(
            opened_source
                .data_views
                .state
                .lock()
                .expect("view jobs")
                .active
                .is_none()
        );
    }

    #[test]
    fn replacing_the_source_interrupts_active_text_suggestions() {
        let reader =
            TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"), "row".into())
                .expect("suggestion reader");
        let interrupt = Arc::new(reader.interrupt_handle());
        let opened_source = OpenedSource::default();
        opened_source
            .text_suggestions
            .state
            .lock()
            .expect("suggestion jobs")
            .active
            .replace(ActiveTextValueSuggestionJob {
                generation: 1,
                suggestion_revision: 3,
                interrupt: Arc::clone(&interrupt),
            });

        opened_source
            .install(
                None,
                PathBuf::from("replacement.parquet"),
                SourceSummary {
                    display_name: "replacement.parquet".into(),
                    size_bytes: 8,
                    row_count: 1,
                    row_group_count: 1,
                    schema: Vec::new(),
                },
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("replacement source is accepted");

        assert!(interrupt.is_cancelled());
        assert!(
            opened_source
                .text_suggestions
                .state
                .lock()
                .expect("suggestion jobs")
                .active
                .is_none()
        );
    }

    #[test]
    fn view_revision_watermark_rejects_late_builds_and_replaces_one_active_job() {
        let make_interrupt = || {
            let builder = DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[])
                .expect("view builder");
            Arc::new(builder.interrupt_handle())
        };
        let current = make_interrupt();
        let stale = make_interrupt();
        let next = make_interrupt();
        let mut jobs = DataViewJobsState::default();

        register_data_view_job(
            &mut jobs,
            ActiveDataViewJob {
                generation: 7,
                view_revision: 2,
                interrupt: Arc::clone(&current),
            },
        )
        .expect("current revision");
        assert_eq!(
            register_data_view_job(
                &mut jobs,
                ActiveDataViewJob {
                    generation: 7,
                    view_revision: 1,
                    interrupt: Arc::clone(&stale),
                },
            ),
            Err(DataWindowError::Cancelled)
        );
        assert!(stale.is_cancelled());
        assert!(!current.is_cancelled());

        register_data_view_job(
            &mut jobs,
            ActiveDataViewJob {
                generation: 7,
                view_revision: 3,
                interrupt: Arc::clone(&next),
            },
        )
        .expect("new revision");
        assert!(current.is_cancelled());
        assert!(!next.is_cancelled());
        assert_eq!(jobs.watermark, Some((7, 3)));
        assert!(
            jobs.active
                .as_ref()
                .is_some_and(|active| active.view_revision == 3)
        );
    }

    #[test]
    fn completed_view_revision_keeps_the_monotonic_watermark() {
        let builder =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("view builder");
        let interrupt = Arc::new(builder.interrupt_handle());
        let mut jobs = DataViewJobsState::default();
        register_data_view_job(
            &mut jobs,
            ActiveDataViewJob {
                generation: 7,
                view_revision: 3,
                interrupt: Arc::clone(&interrupt),
            },
        )
        .expect("initial revision");

        assert!(finish_data_view_job(&mut jobs, 7, 3, &interrupt));

        assert_eq!(jobs.watermark, Some((7, 3)));
        assert!(jobs.active.is_none());
        for revision in [2, 3] {
            let late = DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[])
                .expect("late builder");
            let late = Arc::new(late.interrupt_handle());
            assert_eq!(
                register_data_view_job(
                    &mut jobs,
                    ActiveDataViewJob {
                        generation: 7,
                        view_revision: revision,
                        interrupt: Arc::clone(&late),
                    },
                ),
                Err(DataWindowError::Cancelled)
            );
            assert!(late.is_cancelled());
        }

        let next =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("next builder");
        let next = Arc::new(next.interrupt_handle());
        register_data_view_job(
            &mut jobs,
            ActiveDataViewJob {
                generation: 7,
                view_revision: 4,
                interrupt: Arc::clone(&next),
            },
        )
        .expect("newer revision");
        assert!(!next.is_cancelled());
    }

    #[test]
    fn text_suggestion_revision_replaces_the_active_scan() {
        let make_interrupt = || {
            let reader =
                TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"), "row".into())
                    .expect("suggestion reader");
            Arc::new(reader.interrupt_handle())
        };
        let current = make_interrupt();
        let stale = make_interrupt();
        let next = make_interrupt();
        let mut jobs = TextValueSuggestionJobsState::default();

        register_text_value_suggestion_job(
            &mut jobs,
            ActiveTextValueSuggestionJob {
                generation: 7,
                suggestion_revision: 2,
                interrupt: Arc::clone(&current),
            },
        )
        .expect("current revision");
        assert_eq!(
            register_text_value_suggestion_job(
                &mut jobs,
                ActiveTextValueSuggestionJob {
                    generation: 7,
                    suggestion_revision: 1,
                    interrupt: Arc::clone(&stale),
                },
            ),
            Err(DataWindowError::Cancelled)
        );
        assert!(stale.is_cancelled());
        assert!(!current.is_cancelled());

        register_text_value_suggestion_job(
            &mut jobs,
            ActiveTextValueSuggestionJob {
                generation: 7,
                suggestion_revision: 3,
                interrupt: Arc::clone(&next),
            },
        )
        .expect("new revision");
        assert!(current.is_cancelled());
        assert!(!next.is_cancelled());
        assert_eq!(jobs.watermark, Some((7, 3)));
    }

    #[test]
    fn completed_text_suggestion_revision_keeps_the_monotonic_watermark() {
        let make_interrupt = || {
            let reader =
                TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"), "row".into())
                    .expect("suggestion reader");
            Arc::new(reader.interrupt_handle())
        };
        let interrupt = make_interrupt();
        let mut jobs = TextValueSuggestionJobsState::default();
        register_text_value_suggestion_job(
            &mut jobs,
            ActiveTextValueSuggestionJob {
                generation: 7,
                suggestion_revision: 3,
                interrupt: Arc::clone(&interrupt),
            },
        )
        .expect("initial revision");

        assert!(finish_text_value_suggestion_job(
            &mut jobs, 7, 3, &interrupt
        ));
        assert_eq!(jobs.watermark, Some((7, 3)));
        assert!(jobs.active.is_none());

        let late = make_interrupt();
        assert_eq!(
            register_text_value_suggestion_job(
                &mut jobs,
                ActiveTextValueSuggestionJob {
                    generation: 7,
                    suggestion_revision: 2,
                    interrupt: Arc::clone(&late),
                },
            ),
            Err(DataWindowError::Cancelled)
        );
        assert!(late.is_cancelled());
    }

    #[test]
    fn text_suggestion_cancellation_covers_a_request_before_registration() {
        let reader =
            TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"), "row".into())
                .expect("suggestion reader");
        let late = Arc::new(reader.interrupt_handle());
        let mut jobs = TextValueSuggestionJobsState::default();

        assert!(cancel_text_value_suggestion_job(&mut jobs, 7, 3).is_none());
        assert_eq!(
            register_text_value_suggestion_job(
                &mut jobs,
                ActiveTextValueSuggestionJob {
                    generation: 7,
                    suggestion_revision: 3,
                    interrupt: Arc::clone(&late),
                },
            ),
            Err(DataWindowError::Cancelled)
        );
        assert!(late.is_cancelled());
    }

    #[test]
    fn published_view_revision_never_moves_backwards_without_a_watermark() {
        let opened_source = OpenedSource::default();
        let opened = opened_source
            .install(
                None,
                PathBuf::from("source.parquet"),
                SourceSummary {
                    display_name: "source.parquet".into(),
                    size_bytes: 8,
                    row_count: 1,
                    row_group_count: 1,
                    schema: Vec::new(),
                },
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("source is accepted");

        activate_direct_data_view(&opened_source, opened.generation, 5).expect("newer direct view");
        opened_source
            .data_views
            .state
            .lock()
            .expect("view jobs")
            .watermark = None;

        assert_eq!(
            activate_direct_data_view(&opened_source, opened.generation, 4),
            Err(DataWindowCommandError::Engine(DataWindowError::Cancelled))
        );
        let state = opened_source.state.lock().expect("opened source state");
        let session = state.session.as_ref().expect("opened source session");
        assert_eq!(session.view_revision, 5);
        assert!(session.view.is_none());
    }

    #[test]
    fn cancellation_watermark_covers_cancel_before_registration() {
        let mut jobs = DataViewJobsState::default();

        assert!(cancel_data_view_job(&mut jobs, 7, 3).is_none());
        let late =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("late builder");
        let late = Arc::new(late.interrupt_handle());
        assert_eq!(
            register_data_view_job(
                &mut jobs,
                ActiveDataViewJob {
                    generation: 7,
                    view_revision: 3,
                    interrupt: Arc::clone(&late),
                },
            ),
            Err(DataWindowError::Cancelled)
        );
        assert!(late.is_cancelled());

        let current =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("current builder");
        let current = Arc::new(current.interrupt_handle());
        register_data_view_job(
            &mut jobs,
            ActiveDataViewJob {
                generation: 7,
                view_revision: 4,
                interrupt: Arc::clone(&current),
            },
        )
        .expect("newer revision");
        cancel_data_view_job(&mut jobs, 7, 4)
            .expect("active revision")
            .cancel();
        assert!(current.is_cancelled());
        assert!(jobs.active.is_none());
        assert_eq!(jobs.watermark, Some((7, 4)));
    }

    #[test]
    fn statistics_resolve_only_columns_from_the_matching_native_session() {
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".into(),
            size_bytes: 8,
            row_count: 1,
            row_group_count: 1,
            schema: vec![SchemaField {
                name: "trusted_name".into(),
                physical_type: "INT64".into(),
                logical_type: None,
                children: Vec::new(),
            }],
        };
        let opened = opened_source
            .install(
                None,
                PathBuf::from("source.parquet"),
                summary,
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("source is accepted");
        let state = opened_source.state.lock().expect("opened source state");

        assert_eq!(
            statistics_request(&state, opened.generation, 0, true),
            Ok(ColumnStatisticsRequest::Scan {
                path: PathBuf::from("source.parquet"),
                column_name: "trusted_name".to_owned(),
            })
        );
        assert_eq!(
            statistics_request(&state, opened.generation, 1, true),
            Err(ColumnStatisticsCommandError::UnsupportedColumn)
        );
        assert_eq!(
            statistics_request(&state, opened.generation + 1, 0, true),
            Err(ColumnStatisticsCommandError::SourceChanged)
        );
    }

    #[test]
    fn statistics_cache_reuses_a_session_result_and_upgrades_min_max() {
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".into(),
            size_bytes: 8,
            row_count: 1,
            row_group_count: 1,
            schema: vec![SchemaField {
                name: "label".into(),
                physical_type: "BYTE_ARRAY".into(),
                logical_type: Some("String".into()),
                children: Vec::new(),
            }],
        };
        let opened = opened_source
            .install(
                None,
                PathBuf::from("source.parquet"),
                summary.clone(),
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("source is accepted");
        let mut state = opened_source.state.lock().expect("opened source state");
        let summary_statistics = ColumnStatistics {
            minimum: None,
            maximum: None,
            min_max_computed: false,
            null_share: 0.25,
            approximate_distinct_count: 31_300_000,
        };

        cache_statistics(&mut state, opened.generation, 0, summary_statistics.clone())
            .expect("summary statistics should be cached");
        assert_eq!(
            statistics_request(&state, opened.generation, 0, false),
            Ok(ColumnStatisticsRequest::Cached(summary_statistics))
        );
        assert!(matches!(
            statistics_request(&state, opened.generation, 0, true),
            Ok(ColumnStatisticsRequest::Scan { .. })
        ));

        let full_statistics = ColumnStatistics {
            minimum: Some("a".into()),
            maximum: Some("z".into()),
            min_max_computed: true,
            null_share: 0.25,
            approximate_distinct_count: 31_300_000,
        };
        cache_statistics(&mut state, opened.generation, 0, full_statistics.clone())
            .expect("full statistics should replace the summary");
        assert_eq!(
            statistics_request(&state, opened.generation, 0, true),
            Ok(ColumnStatisticsRequest::Cached(full_statistics))
        );

        drop(state);
        let replacement = opened_source
            .install(
                None,
                PathBuf::from("replacement.parquet"),
                summary,
                SourceOpenIntent::Explicit,
            )
            .expect("replacement source state")
            .expect("replacement source is accepted");
        let state = opened_source.state.lock().expect("opened source state");
        assert_eq!(
            statistics_request(&state, opened.generation, 0, false),
            Err(ColumnStatisticsCommandError::SourceChanged)
        );
        assert!(matches!(
            statistics_request(&state, replacement.generation, 0, false),
            Ok(ColumnStatisticsRequest::Scan { .. })
        ));
    }

    #[test]
    fn cancelled_statistics_keep_a_stable_wire_error() {
        assert_eq!(
            serde_json::to_value(ColumnStatisticsCommandError::Cancelled)
                .expect("statistics error is serializable"),
            serde_json::json!({ "code": "cancelled" })
        );
    }

    #[test]
    fn manual_update_check_uses_native_messages_for_terminal_results() {
        assert_eq!(
            manual_update_check_dialog(&Ok(Some(UpdateInfo {
                version: "0.0.3".into(),
                current_version: "0.0.2".into(),
                is_downgrade: false,
            }))),
            None
        );
        assert_eq!(
            manual_update_check_dialog(&Ok(None)),
            Some(("Viewda is up to date", MessageDialogKind::Info))
        );
        assert_eq!(
            manual_update_check_dialog(&Err(UpdateError::Unavailable)),
            Some((
                "Could not check for updates. Try again later.",
                MessageDialogKind::Error
            ))
        );

        #[cfg(target_os = "linux")]
        assert_eq!(
            manual_update_check_dialog(&Err(UpdateError::ManualInstall)),
            Some((
                "This package uses manual updates. Install the AppImage to update inside Viewda.",
                MessageDialogKind::Info
            ))
        );
    }
}
