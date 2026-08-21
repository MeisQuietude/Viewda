//! Tauri adapter for the Viewda desktop application.

mod default_application;
mod export;
mod launch;
mod recents;
mod structure;
mod theme;
mod updates;
mod view_settings;

use std::{
    collections::{HashMap, VecDeque, hash_map::Entry},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
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
use serde::{Deserialize, Serialize};
use structure::{
    StructureCache, StructureJobs, cancel_structure_bloom_probe, cancel_structure_load,
    get_structure_chunk, get_structure_columns, get_structure_key_value, get_structure_layout,
    get_structure_lens_totals, get_structure_load_progress, get_structure_report,
    get_structure_row_groups, get_structure_row_offset, get_structure_summary,
    probe_structure_bloom_filter,
};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use theme::{apply_saved_theme, get_theme_preference, set_theme_preference, sync_system_theme};
use thiserror::Error;
use updates::{
    PendingUpdate, UpdateError, UpdateInfo, UpdateProgress, UpdateStateStore, check_for_update,
    check_for_update_with_state, discard_pending_update, get_update_settings,
    install_pending_update as install_pending_update_without_restart, open_releases_page,
    set_update_settings, take_post_update_state,
};
use view_settings::{DataViewSettings, get_data_view_settings, set_data_view_settings};
use viewda_data_engine::{
    ColumnStatistics, ColumnStatisticsError, ColumnStatisticsReader, DataFilter,
    DataFilterOperator, DataSort, DataViewBuilder, DataViewError, DataViewInterruptHandle,
    DataViewResourceDiagnostics, DataWindowError, DataWindowReader, EngineError, EngineStatus,
    PreparedDataView, SchemaField, SourceError, SourceIdentity, SourceOpenPhase, SourceSnapshot,
    SourceSummary, StatisticsInterruptHandle, TextValueSuggestions,
    TextValueSuggestionsInterruptHandle, TextValueSuggestionsReader, engine_status,
    inspect_local_source_snapshot_cancellable,
};

const OPEN_SOURCE_MENU_ID: &str = "open-local-source";
const CLOSE_SOURCE_MENU_ID: &str = "close-source";
const OPEN_RECENT_MENU_ID: &str = "open-recent";
const OPEN_RECENT_MENU_PREFIX: &str = "open-recent:";
const CLEAR_RECENT_MENU_ID: &str = "clear-recent";
const SETTINGS_MENU_ID: &str = "settings";
const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";
const OPEN_SOURCE_REQUESTED_EVENT: &str = "open-source-requested";
const CLOSE_SOURCE_REQUESTED_EVENT: &str = "close-source-requested";
const RECENT_SOURCES_CHANGED_EVENT: &str = "recent-sources-changed";
const SETTINGS_REQUESTED_EVENT: &str = "settings-requested";
const UPDATE_AVAILABLE_EVENT: &str = "update-available";
const DATA_EXPORT_CLOSE_REQUESTED_EVENT: &str = "data-export-close-requested";
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "quit";

#[derive(Default)]
struct DataExportCloseDialog {
    state: Arc<Mutex<DataExportCloseDialogState>>,
}

#[derive(Default)]
enum DataExportCloseDialogState {
    #[default]
    Idle,
    Pending(PendingDataExportCloseDialog),
    Resolving,
}

struct DataExportCloseResolution {
    state: Arc<Mutex<DataExportCloseDialogState>>,
    pending: Option<PendingDataExportCloseDialog>,
}

#[derive(Default)]
struct RecentSourcesMenu(Mutex<Option<Submenu<tauri::Wry>>>);

impl DataExportCloseDialog {
    fn try_open<F>(
        &self,
        copy: DataExportCloseDialogCopy,
        action: DataExportShutdownAction,
        on_decision: F,
    ) -> bool
    where
        F: FnOnce(bool) + Send + 'static,
    {
        let Ok(mut state) = self.state.lock() else {
            on_decision(false);
            return false;
        };
        if !matches!(*state, DataExportCloseDialogState::Idle) {
            drop(state);
            on_decision(false);
            return false;
        }
        *state = DataExportCloseDialogState::Pending(PendingDataExportCloseDialog {
            copy,
            action,
            on_decision: Box::new(on_decision),
        });
        true
    }

    fn copy(&self) -> Option<DataExportCloseDialogCopy> {
        let state = self.state.lock().ok()?;
        match &*state {
            DataExportCloseDialogState::Pending(pending) => Some(pending.copy.clone()),
            DataExportCloseDialogState::Idle | DataExportCloseDialogState::Resolving => None,
        }
    }

    fn begin_resolution(&self) -> Option<DataExportCloseResolution> {
        let mut state = self.state.lock().ok()?;
        let pending = match std::mem::replace(&mut *state, DataExportCloseDialogState::Resolving) {
            DataExportCloseDialogState::Pending(pending) => pending,
            previous => {
                *state = previous;
                return None;
            }
        };
        Some(DataExportCloseResolution {
            state: Arc::clone(&self.state),
            pending: Some(pending),
        })
    }
}

impl DataExportCloseResolution {
    fn action(&self) -> DataExportShutdownAction {
        self.pending.as_ref().expect("pending resolution").action
    }

    fn decide(mut self, decision: bool) {
        let pending = self.pending.take().expect("pending resolution");
        (pending.on_decision)(decision);
    }
}

impl Drop for DataExportCloseResolution {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            *state = DataExportCloseDialogState::Idle;
        }
    }
}

struct PendingDataExportCloseDialog {
    copy: DataExportCloseDialogCopy,
    action: DataExportShutdownAction,
    on_decision: Box<dyn FnOnce(bool) + Send>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataExportCloseDialogCopy {
    message: String,
    destructive_button: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DataExportShutdownAction {
    Close,
    CloseWindow,
    CloseSource,
    RestartForUpdate,
}

#[derive(Default)]
pub(crate) struct OpenedSource {
    state: Arc<Mutex<OpenedSourceState>>,
    structure_cache: Mutex<StructureCache>,
    recents: RecentSourcesStore,
    data_exports: DataExportJobs,
    source_open_decode: Mutex<()>,
    source_open_progress: Mutex<Option<ActiveSourceOpenProgress>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SourceOpenProgressPhase {
    Waiting,
    ReadingFooter,
    DecodingFooter,
    Summarizing,
}

struct ActiveSourceOpenProgress {
    request: u64,
    phase: SourceOpenProgressPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientSourceOpenStatus {
    Pending,
    Cancelled,
    Published,
}

#[derive(Debug, Clone)]
struct ClientSourceOpenAttempt {
    id: String,
    open_request: u64,
    status: ClientSourceOpenStatus,
}

const RECENT_CLIENT_SOURCE_OPEN_ATTEMPTS: usize = 16;

#[derive(Clone, Copy)]
struct SourceOpenPublication<'a> {
    request: u64,
    client_attempt: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SourceOpenCancelOutcome {
    Cancelled,
    Published,
}

#[derive(Default)]
struct OpenedSourceState {
    generation: u64,
    open_request: u64,
    client_open_attempt: Option<ClientSourceOpenAttempt>,
    cancelled_client_open_before_registration: Option<String>,
    recent_client_open_attempts: VecDeque<ClientSourceOpenAttempt>,
    /// Open sessions in most-recently-used order; the first one is the active source.
    sessions: Vec<Arc<OpenedSourceSession>>,
    blocks_restore: bool,
}

impl OpenedSourceState {
    fn session(&self, generation: u64) -> Option<Arc<OpenedSourceSession>> {
        self.sessions
            .iter()
            .find(|session| session.generation == generation)
            .map(Arc::clone)
    }

    /// Tells a window without sources apart from a source that has since been closed.
    fn missing_session<T>(&self, no_source_open: T, source_changed: T) -> T {
        if self.sessions.is_empty() {
            no_source_open
        } else {
            source_changed
        }
    }

    fn activate(&mut self, generation: u64) -> bool {
        let Some(index) = self
            .sessions
            .iter()
            .position(|session| session.generation == generation)
        else {
            return false;
        };
        let session = self.sessions.remove(index);
        self.sessions.insert(0, session);
        true
    }
}

/// One opened source with the reading state and the jobs that belong to it.
struct OpenedSourceSession {
    generation: u64,
    path: PathBuf,
    summary: SourceSummary,
    schema: Vec<SchemaField>,
    schema_node_count: usize,
    source_identity: Option<SourceIdentity>,
    state: Mutex<OpenedSourceSessionState>,
    structure_jobs: StructureJobs,
    lifecycle: Arc<SessionLifecycle>,
}

struct OpenedSourceSessionState {
    view_revision: u64,
    view: Option<PreparedDataView>,
    reader: DataWindowReader,
    text_suggestion_reader: Option<Arc<TextValueSuggestionsReader>>,
    statistics_cache: HashMap<usize, ColumnStatistics>,
    data_view_jobs: DataViewJobsState,
    text_suggestion_jobs: TextValueSuggestionJobsState,
    statistics_job: Option<Arc<ColumnStatisticsJob>>,
}

impl OpenedSourceSession {
    fn validate_source_identity(&self) -> Result<(), DataWindowSessionError> {
        match &self.source_identity {
            Some(identity) => identity
                .validate_path(&self.path)
                .map_err(|_| DataWindowSessionError::SourceChanged),
            None => Ok(()),
        }
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, OpenedSourceSessionState>, DataWindowError> {
        self.state.lock().map_err(|_| DataWindowError::Unsupported)
    }

    fn begin_work(&self) -> Result<SessionWork, DataWindowError> {
        self.lifecycle.begin()
    }

    fn with_open_state<T>(
        &self,
        action: impl FnOnce(&mut OpenedSourceSessionState) -> T,
    ) -> Result<T, DataWindowError> {
        let lifecycle = self
            .lifecycle
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        if lifecycle.closing {
            return Err(DataWindowError::Cancelled);
        }
        let mut state = self.lock_state()?;
        Ok(action(&mut state))
    }

    fn close_and_wait(&self) {
        self.lifecycle.start_closing();
        self.structure_jobs.cancel_all();
        if let Ok(mut state) = self.state.lock() {
            state.cancel_jobs();
        }
        self.lifecycle.wait_until_idle();
    }
}

impl OpenedSourceSessionState {
    fn text_suggestion_reader(
        &mut self,
        path: &std::path::Path,
    ) -> Result<Arc<TextValueSuggestionsReader>, DataWindowError> {
        if self.text_suggestion_reader.is_none() {
            self.text_suggestion_reader = Some(Arc::new(TextValueSuggestionsReader::new(
                path.to_path_buf(),
            )?));
        }
        self.text_suggestion_reader
            .as_ref()
            .map(Arc::clone)
            .ok_or(DataWindowError::QueryEngineUnavailable)
    }

    /// Interrupts every job this session owns; each command then reports cancellation.
    fn cancel_jobs(&mut self) {
        if let Some(job) = self.data_view_jobs.active.take() {
            job.cancel();
        }
        if let Some(job) = self.text_suggestion_jobs.active.take() {
            job.cancel();
        }
        if let Some(job) = self.statistics_job.take() {
            job.cancel();
        }
    }
}

#[derive(Default)]
struct SessionLifecycle {
    state: Mutex<SessionLifecycleState>,
    idle: Condvar,
}

#[derive(Default)]
struct SessionLifecycleState {
    closing: bool,
    workers: usize,
}

impl SessionLifecycle {
    fn begin(self: &Arc<Self>) -> Result<SessionWork, DataWindowError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        if state.closing {
            return Err(DataWindowError::Cancelled);
        }
        state.workers = state
            .workers
            .checked_add(1)
            .ok_or(DataWindowError::Unsupported)?;
        Ok(SessionWork(Arc::clone(self)))
    }

    fn start_closing(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closing = true;
        }
    }

    fn wait_until_idle(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        while state.workers != 0 {
            let Ok(next) = self.idle.wait(state) else {
                return;
            };
            state = next;
        }
    }
}

struct SessionWork(Arc<SessionLifecycle>);

impl Drop for SessionWork {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.workers = state.workers.saturating_sub(1);
            if state.workers == 0 {
                self.0.idle.notify_all();
            }
        }
    }
}

#[derive(Default)]
struct DataViewJobsState {
    watermark: Option<u64>,
    active: Option<ActiveDataViewJob>,
}

struct ActiveDataViewJob {
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
    if jobs
        .watermark
        .is_some_and(|revision| next.view_revision <= revision)
    {
        next.cancel();
        return Err(DataWindowError::Cancelled);
    }
    jobs.watermark = Some(next.view_revision);
    if let Some(previous) = jobs.active.replace(next) {
        previous.cancel();
    }
    Ok(())
}

fn finish_data_view_job(
    jobs: &mut DataViewJobsState,
    view_revision: u64,
    interrupt: &Arc<DataViewInterruptHandle>,
) -> bool {
    let is_current = jobs.active.as_ref().is_some_and(|active| {
        active.view_revision == view_revision && Arc::ptr_eq(&active.interrupt, interrupt)
    }) && jobs.watermark == Some(view_revision);
    if is_current {
        jobs.active.take();
    }
    is_current
}

fn cancel_data_view_job(
    jobs: &mut DataViewJobsState,
    view_revision: u64,
) -> Option<ActiveDataViewJob> {
    if !jobs
        .watermark
        .is_some_and(|revision| revision >= view_revision)
    {
        jobs.watermark = Some(view_revision);
    }
    if jobs
        .active
        .as_ref()
        .is_some_and(|active| active.view_revision == view_revision)
    {
        jobs.active.take()
    } else {
        None
    }
}

#[derive(Default)]
struct TextValueSuggestionJobsState {
    watermark: Option<u64>,
    active: Option<ActiveTextValueSuggestionJob>,
}

struct ActiveTextValueSuggestionJob {
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
    if jobs
        .watermark
        .is_some_and(|revision| next.suggestion_revision <= revision)
    {
        next.cancel();
        return Err(DataWindowError::Cancelled);
    }
    jobs.watermark = Some(next.suggestion_revision);
    if let Some(previous) = jobs.active.replace(next) {
        previous.cancel();
    }
    Ok(())
}

fn finish_text_value_suggestion_job(
    jobs: &mut TextValueSuggestionJobsState,
    suggestion_revision: u64,
    interrupt: &Arc<TextValueSuggestionsInterruptHandle>,
) -> bool {
    let is_current = jobs.active.as_ref().is_some_and(|active| {
        active.suggestion_revision == suggestion_revision
            && Arc::ptr_eq(&active.interrupt, interrupt)
    }) && jobs.watermark == Some(suggestion_revision);
    if is_current {
        jobs.active.take();
    }
    is_current
}

fn cancel_text_value_suggestion_job(
    jobs: &mut TextValueSuggestionJobsState,
    suggestion_revision: u64,
) -> Option<ActiveTextValueSuggestionJob> {
    if !jobs
        .watermark
        .is_some_and(|revision| revision >= suggestion_revision)
    {
        jobs.watermark = Some(suggestion_revision);
    }
    if jobs
        .active
        .as_ref()
        .is_some_and(|active| active.suggestion_revision == suggestion_revision)
    {
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

/// One open source as the file switcher and the titlebar list it.
///
/// The full path is part of this shape on purpose: the switcher shows it as a
/// tooltip, and files with the same name are only distinguishable by it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedSourceEntry {
    generation: u64,
    name: String,
    directory: String,
    path: String,
    active: bool,
}

const MAX_SOURCE_SCHEMA_PAGE_COLUMNS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceSchemaPage {
    offset: usize,
    total_count: usize,
    columns: Vec<SchemaField>,
}

const MAX_SOURCE_SCHEMA_PAGE_NODES: usize = 256;
const MAX_SOURCE_SCHEMA_PAGE_PATH_COMPONENTS: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceSchemaNodeCursor {
    path: Vec<usize>,
    leaf_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceSchemaNode {
    path: Vec<usize>,
    name: String,
    physical_type: String,
    logical_type: Option<String>,
    has_children: bool,
    leaf_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceSchemaNodePage {
    nodes: Vec<SourceSchemaNode>,
    next_cursor: Option<SourceSchemaNodeCursor>,
    total_count: usize,
}

fn bounded_source_schema_field(field: &SchemaField) -> SchemaField {
    const MAX_LABEL_BYTES: usize = 128;
    let mut end = field.name.len().min(MAX_LABEL_BYTES);
    while !field.name.is_char_boundary(end) {
        end -= 1;
    }
    let name = if end == field.name.len() {
        field.name.clone()
    } else {
        let ellipsis_bytes = '…'.len_utf8();
        let mut prefix_end = MAX_LABEL_BYTES.saturating_sub(ellipsis_bytes);
        while !field.name.is_char_boundary(prefix_end) {
            prefix_end -= 1;
        }
        format!("{}…", &field.name[..prefix_end])
    };
    SchemaField {
        name,
        physical_type: field.physical_type.clone(),
        logical_type: field.logical_type.clone(),
        children: Vec::new(),
    }
}

fn source_schema_page(
    session: &OpenedSourceSession,
    offset: usize,
    limit: usize,
) -> Result<SourceSchemaPage, DataWindowCommandError> {
    if limit == 0 || limit > MAX_SOURCE_SCHEMA_PAGE_COLUMNS || offset > session.schema.len() {
        return Err(DataWindowError::Unsupported.into());
    }
    let end = offset.saturating_add(limit).min(session.schema.len());
    Ok(SourceSchemaPage {
        offset,
        total_count: session.schema.len(),
        columns: session.schema[offset..end]
            .iter()
            .map(bounded_source_schema_field)
            .collect(),
    })
}

fn source_schema_node_page(
    session: &OpenedSourceSession,
    cursor: Option<SourceSchemaNodeCursor>,
    limit: usize,
) -> Result<SourceSchemaNodePage, DataWindowCommandError> {
    if limit == 0 || limit > MAX_SOURCE_SCHEMA_PAGE_NODES {
        return Err(DataWindowError::Unsupported.into());
    }
    let mut cursor = cursor.or_else(|| {
        (!session.schema.is_empty()).then_some(SourceSchemaNodeCursor {
            path: vec![0],
            leaf_index: 0,
        })
    });
    let mut nodes = Vec::with_capacity(limit);
    let mut path_components = 0_usize;
    while let Some(current) = cursor.clone() {
        let field = schema_field_at_path(&session.schema, &current.path)
            .ok_or(DataWindowError::Unsupported)?;
        let next_components = path_components.saturating_add(current.path.len());
        if !nodes.is_empty() && next_components > MAX_SOURCE_SCHEMA_PAGE_PATH_COMPONENTS {
            break;
        }
        if current.path.len() > MAX_SOURCE_SCHEMA_PAGE_PATH_COMPONENTS {
            return Err(DataWindowError::Unsupported.into());
        }
        let has_children = !field.children.is_empty();
        nodes.push(SourceSchemaNode {
            path: current.path.clone(),
            name: bounded_source_schema_field(field).name,
            physical_type: field.physical_type.clone(),
            logical_type: field.logical_type.clone(),
            has_children,
            leaf_index: (!has_children).then_some(current.leaf_index),
        });
        path_components = next_components;
        cursor = next_schema_cursor(&session.schema, current, has_children);
        if nodes.len() == limit {
            break;
        }
    }
    Ok(SourceSchemaNodePage {
        nodes,
        next_cursor: cursor,
        total_count: session.schema_node_count,
    })
}

fn schema_field_at_path<'a>(schema: &'a [SchemaField], path: &[usize]) -> Option<&'a SchemaField> {
    let (&first, rest) = path.split_first()?;
    let mut field = schema.get(first)?;
    for &index in rest {
        field = field.children.get(index)?;
    }
    Some(field)
}

fn next_schema_cursor(
    schema: &[SchemaField],
    mut cursor: SourceSchemaNodeCursor,
    has_children: bool,
) -> Option<SourceSchemaNodeCursor> {
    if has_children {
        cursor.path.push(0);
        return Some(cursor);
    }
    cursor.leaf_index = cursor.leaf_index.saturating_add(1);
    loop {
        let index = cursor.path.pop()?;
        let siblings = if cursor.path.is_empty() {
            schema
        } else {
            &schema_field_at_path(schema, &cursor.path)?.children
        };
        if index + 1 < siblings.len() {
            cursor.path.push(index + 1);
            return Some(cursor);
        }
    }
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

fn missing_data_window_session(state: &OpenedSourceState) -> DataWindowCommandError {
    DataWindowCommandError::Session(state.missing_session(
        DataWindowSessionError::NoSourceOpen,
        DataWindowSessionError::SourceChanged,
    ))
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
            ColumnStatisticsError::SourceChanged => Self::SourceChanged,
            ColumnStatisticsError::NotParquet => Self::NotParquet,
            ColumnStatisticsError::CorruptSource => Self::CorruptSource,
            ColumnStatisticsError::Unsupported => Self::Unsupported,
            ColumnStatisticsError::ResourceExhausted => Self::ResourceExhausted,
            ColumnStatisticsError::QueryFailed => Self::QueryFailed,
            ColumnStatisticsError::QueryEngineUnavailable => Self::QueryEngineUnavailable,
        }
    }
}

impl From<DataWindowError> for ColumnStatisticsCommandError {
    fn from(error: DataWindowError) -> Self {
        match error {
            DataWindowError::Cancelled => Self::Cancelled,
            DataWindowError::NotFound => Self::NotFound,
            DataWindowError::PermissionDenied => Self::PermissionDenied,
            DataWindowError::SourceChanged => Self::SourceChanged,
            DataWindowError::NotParquet => Self::NotParquet,
            DataWindowError::CorruptSource => Self::CorruptSource,
            DataWindowError::ResourceExhausted => Self::ResourceExhausted,
            DataWindowError::QueryFailed => Self::QueryFailed,
            DataWindowError::QueryEngineUnavailable => Self::QueryEngineUnavailable,
            DataWindowError::Unsupported
            | DataWindowError::WindowTooLarge
            | DataWindowError::InvalidFilter
            | DataWindowError::InvalidSort
            | DataWindowError::EncodingFailed => Self::Unsupported,
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
    fn remember_client_source_open_terminal(
        state: &mut OpenedSourceState,
        attempt: ClientSourceOpenAttempt,
    ) {
        if let Some(index) = state
            .recent_client_open_attempts
            .iter()
            .position(|recent| recent.id == attempt.id)
        {
            state.recent_client_open_attempts.remove(index);
        }
        state.recent_client_open_attempts.push_back(attempt);
        while state.recent_client_open_attempts.len() > RECENT_CLIENT_SOURCE_OPEN_ATTEMPTS {
            state.recent_client_open_attempts.pop_front();
        }
    }

    fn finish_client_source_open(&self, attempt: &str) -> Result<(), OpenSourceError> {
        let mut state = self.lock_state()?;
        let Some(mut current) = state
            .client_open_attempt
            .take_if(|current| current.id == attempt)
        else {
            return Ok(());
        };
        if current.status == ClientSourceOpenStatus::Pending {
            current.status = ClientSourceOpenStatus::Cancelled;
        }
        Self::remember_client_source_open_terminal(&mut state, current);
        Ok(())
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, OpenedSourceState>, OpenSourceError> {
        self.state
            .lock()
            .map_err(|_| RecentSourceError::Storage.into())
    }

    fn mark_explicit(&self) -> Result<(), OpenSourceError> {
        self.lock_state()?.blocks_restore = true;
        Ok(())
    }

    /// Opens a source as the active one, keeping every already open source.
    ///
    /// The same file identity at the same path activates its existing session,
    /// so its reading state and its running jobs survive.
    #[cfg(test)]
    fn install(
        &self,
        recent_sources_path: Option<&std::path::Path>,
        path: PathBuf,
        summary: SourceSummary,
        intent: SourceOpenIntent,
    ) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
        self.install_with_snapshot(recent_sources_path, path, summary, None, intent, None)
    }

    fn install_with_snapshot(
        &self,
        recent_sources_path: Option<&std::path::Path>,
        path: PathBuf,
        summary: SourceSummary,
        source_snapshot: Option<SourceSnapshot>,
        intent: SourceOpenIntent,
        publication: Option<SourceOpenPublication<'_>>,
    ) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
        let source_snapshot = source_snapshot.map(Arc::new);
        let mut state = self.lock_state()?;
        if publication.is_some_and(|publication| publication.request != state.open_request) {
            return Ok(None);
        }
        if let Some((publication, client_attempt)) = publication.and_then(|publication| {
            publication
                .client_attempt
                .map(|client_attempt| (publication, client_attempt))
        }) && !state.client_open_attempt.as_ref().is_some_and(|attempt| {
            attempt.id == client_attempt
                && attempt.open_request == publication.request
                && attempt.status == ClientSourceOpenStatus::Pending
        }) {
            return Ok(None);
        }
        if intent == SourceOpenIntent::Restore && state.blocks_restore {
            return Ok(None);
        }
        if let Some(snapshot) = source_snapshot.as_ref() {
            snapshot.validate_for_install(&path)?;
        }
        if intent == SourceOpenIntent::Explicit {
            state.blocks_restore = true;
        }
        let opened = state
            .sessions
            .iter()
            .find(|session| {
                session.path == path
                    && session.source_identity.as_ref()
                        == source_snapshot.as_ref().map(|snapshot| snapshot.identity())
            })
            .map(|session| OpenedSourceInfo {
                generation: session.generation,
                summary: session.summary.clone(),
            });
        let info = match opened {
            Some(info) => {
                state.activate(info.generation);
                info
            }
            None => {
                let generation = state
                    .generation
                    .checked_add(1)
                    .ok_or(SourceError::Unsupported)?;
                if generation > 9_007_199_254_740_991 {
                    return Err(SourceError::Unsupported.into());
                }
                let source_identity = source_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.identity().clone());
                let schema = source_snapshot.as_ref().map_or_else(
                    || summary.schema.clone(),
                    |snapshot| snapshot.query_schema(),
                );
                state.generation = generation;
                state.sessions.insert(
                    0,
                    Arc::new(OpenedSourceSession {
                        generation,
                        path: path.clone(),
                        summary: summary.clone(),
                        schema,
                        schema_node_count: summary.schema_node_count,
                        source_identity,
                        state: Mutex::new(OpenedSourceSessionState {
                            reader: DataWindowReader::new(path.clone()),
                            view_revision: 0,
                            view: None,
                            text_suggestion_reader: None,
                            statistics_cache: HashMap::new(),
                            data_view_jobs: DataViewJobsState::default(),
                            text_suggestion_jobs: TextValueSuggestionJobsState::default(),
                            statistics_job: None,
                        }),
                        structure_jobs: StructureJobs::default(),
                        lifecycle: Arc::new(SessionLifecycle::default()),
                    }),
                );
                OpenedSourceInfo {
                    generation,
                    summary,
                }
            }
        };
        let source_identity = state
            .session(info.generation)
            .and_then(|session| session.source_identity.clone());
        if let Some(attempt) = publication.and_then(|publication| publication.client_attempt)
            && let Some(client_open) = state
                .client_open_attempt
                .as_mut()
                .filter(|client_open| client_open.id == attempt)
        {
            client_open.status = ClientSourceOpenStatus::Published;
        }
        if let Some(recent_sources_path) = recent_sources_path {
            // Recorded under the source lock so a restore racing an explicit open
            // cannot invert the history order. The source is open either way, so
            // history stays best-effort.
            let _ = self.recents.record_path(recent_sources_path, &path);
        }
        if let Ok(mut cache) = self.structure_cache.lock() {
            if let Some(snapshot) = source_snapshot {
                cache.remember_snapshot(info.generation, source_identity.as_ref(), snapshot);
            } else {
                cache.touch(info.generation);
            }
        }
        drop(state);
        Ok(Some(info))
    }

    fn begin_source_open(&self) -> Result<u64, OpenSourceError> {
        let mut state = self.lock_state()?;
        if let Some(mut attempt) = state.client_open_attempt.take() {
            if attempt.status == ClientSourceOpenStatus::Pending {
                attempt.status = ClientSourceOpenStatus::Cancelled;
            }
            Self::remember_client_source_open_terminal(&mut state, attempt);
        }
        state.open_request = state
            .open_request
            .checked_add(1)
            .ok_or(SourceError::Unsupported)?;
        let request = state.open_request;
        drop(state);
        self.source_open_progress
            .lock()
            .map_err(|_| SourceError::Unsupported)?
            .take();
        Ok(request)
    }

    fn begin_client_source_open(&self, attempt: &str) -> Result<Option<u64>, OpenSourceError> {
        let mut state = self.lock_state()?;
        if state.cancelled_client_open_before_registration.as_deref() == Some(attempt) {
            state.cancelled_client_open_before_registration = None;
            let open_request = state.open_request;
            Self::remember_client_source_open_terminal(
                &mut state,
                ClientSourceOpenAttempt {
                    id: attempt.to_owned(),
                    open_request,
                    status: ClientSourceOpenStatus::Cancelled,
                },
            );
            return Ok(None);
        }
        if let Some(mut previous) = state.client_open_attempt.take() {
            if previous.status == ClientSourceOpenStatus::Pending {
                previous.status = ClientSourceOpenStatus::Cancelled;
            }
            Self::remember_client_source_open_terminal(&mut state, previous);
        }
        state.open_request = state
            .open_request
            .checked_add(1)
            .ok_or(SourceError::Unsupported)?;
        let request = state.open_request;
        state.client_open_attempt = Some(ClientSourceOpenAttempt {
            id: attempt.to_owned(),
            open_request: request,
            status: ClientSourceOpenStatus::Pending,
        });
        drop(state);
        self.source_open_progress
            .lock()
            .map_err(|_| SourceError::Unsupported)?
            .take();
        Ok(Some(request))
    }

    fn cancel_source_open(
        &self,
        attempt: &str,
    ) -> Result<SourceOpenCancelOutcome, OpenSourceError> {
        let mut state = self.lock_state()?;
        let current = state
            .client_open_attempt
            .as_ref()
            .filter(|current| current.id == attempt)
            .cloned();
        match current {
            Some(ClientSourceOpenAttempt {
                status: ClientSourceOpenStatus::Published,
                ..
            }) => return Ok(SourceOpenCancelOutcome::Published),
            Some(ClientSourceOpenAttempt {
                status: ClientSourceOpenStatus::Cancelled,
                ..
            }) => return Ok(SourceOpenCancelOutcome::Cancelled),
            None => {
                if let Some(terminal) = state
                    .recent_client_open_attempts
                    .iter()
                    .find(|terminal| terminal.id == attempt)
                {
                    return Ok(match terminal.status {
                        ClientSourceOpenStatus::Published => SourceOpenCancelOutcome::Published,
                        ClientSourceOpenStatus::Pending | ClientSourceOpenStatus::Cancelled => {
                            SourceOpenCancelOutcome::Cancelled
                        }
                    });
                }
                state.cancelled_client_open_before_registration = Some(attempt.to_owned());
                return Ok(SourceOpenCancelOutcome::Cancelled);
            }
            Some(ClientSourceOpenAttempt {
                status: ClientSourceOpenStatus::Pending,
                ..
            }) => {}
        }
        let mut current = state
            .client_open_attempt
            .take()
            .expect("the pending client source open was matched above");
        if current.open_request == state.open_request {
            state.open_request = state
                .open_request
                .checked_add(1)
                .ok_or(SourceError::Unsupported)?;
        }
        current.status = ClientSourceOpenStatus::Cancelled;
        Self::remember_client_source_open_terminal(&mut state, current);
        drop(state);
        self.source_open_progress
            .lock()
            .map_err(|_| SourceError::Unsupported)?
            .take();
        Ok(SourceOpenCancelOutcome::Cancelled)
    }

    fn source_open_is_current(&self, request: u64) -> Result<bool, OpenSourceError> {
        Ok(self.lock_state()?.open_request == request)
    }

    fn set_source_open_progress(
        &self,
        request: u64,
        phase: SourceOpenProgressPhase,
    ) -> Result<bool, OpenSourceError> {
        if !self.source_open_is_current(request)? {
            return Ok(false);
        }
        *self
            .source_open_progress
            .lock()
            .map_err(|_| SourceError::Unsupported)? =
            Some(ActiveSourceOpenProgress { request, phase });
        Ok(true)
    }

    fn clear_source_open_progress(&self, request: u64) -> Result<(), OpenSourceError> {
        let mut progress = self
            .source_open_progress
            .lock()
            .map_err(|_| SourceError::Unsupported)?;
        if progress
            .as_ref()
            .is_some_and(|active| active.request == request)
        {
            progress.take();
        }
        Ok(())
    }

    fn source_open_progress(&self) -> Result<Option<SourceOpenProgressPhase>, OpenSourceError> {
        let request = self.lock_state()?.open_request;
        Ok(self
            .source_open_progress
            .lock()
            .map_err(|_| SourceError::Unsupported)?
            .as_ref()
            .filter(|active| active.request == request)
            .map(|active| active.phase))
    }

    fn run_source_open_job<T>(
        &self,
        request: u64,
        operation: impl FnOnce(
            &mut dyn FnMut(SourceOpenPhase) -> bool,
        ) -> Result<Option<T>, OpenSourceError>,
    ) -> Result<Option<T>, OpenSourceError> {
        self.set_source_open_progress(request, SourceOpenProgressPhase::Waiting)?;
        let decode_guard = self
            .source_open_decode
            .lock()
            .map_err(|_| SourceError::Unsupported)?;
        if !self.source_open_is_current(request)? {
            drop(decode_guard);
            self.clear_source_open_progress(request)?;
            return Ok(None);
        }
        let mut keep_going = |phase| {
            let phase = match phase {
                SourceOpenPhase::ReadingFooter => SourceOpenProgressPhase::ReadingFooter,
                SourceOpenPhase::DecodingFooter => SourceOpenProgressPhase::DecodingFooter,
                SourceOpenPhase::Summarizing => SourceOpenProgressPhase::Summarizing,
            };
            self.set_source_open_progress(request, phase)
                .unwrap_or(false)
        };
        let result = operation(&mut keep_going);
        drop(decode_guard);
        self.clear_source_open_progress(request)?;
        result
    }

    /// Drops one session, interrupting the jobs and releasing the state it owns.
    fn close(&self, generation: u64) -> Result<bool, OpenSourceError> {
        let mut state = self.lock_state()?;
        let Some(index) = state
            .sessions
            .iter()
            .position(|session| session.generation == generation)
        else {
            return Ok(false);
        };
        let session = state.sessions.remove(index);
        drop(state);
        if let Ok(mut cache) = self.structure_cache.lock() {
            cache.remove(generation);
        }
        session.close_and_wait();
        Ok(true)
    }

    /// Open source paths in most-recently-used order, the active source first.
    pub(crate) fn open_paths(&self) -> Result<Vec<PathBuf>, OpenSourceError> {
        Ok(self
            .lock_state()?
            .sessions
            .iter()
            .map(|session| session.path.clone())
            .collect())
    }

    fn blocks_restore(&self) -> Result<bool, OpenSourceError> {
        Ok(self.lock_state()?.blocks_restore)
    }

    fn cancel_all_jobs(&self) -> Result<(), OpenSourceError> {
        let sessions = self.lock_state()?.sessions.clone();
        for session in sessions {
            session.close_and_wait();
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn close_all(&self) -> Result<(), OpenSourceError> {
        let sessions = {
            let mut state = self.lock_state()?;
            std::mem::take(&mut state.sessions)
        };
        if let Ok(mut cache) = self.structure_cache.lock() {
            cache.clear();
        }
        for session in sessions {
            session.close_and_wait();
        }
        Ok(())
    }
}

fn should_prevent_exit(is_macos: bool, code: Option<i32>, has_running_exports: bool) -> bool {
    (is_macos && code.is_none()) || (code != Some(tauri::RESTART_EXIT_CODE) && has_running_exports)
}

fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .expect("main window config is required");
    tauri::WebviewWindowBuilder::from_config(app, config)?
        .enable_clipboard_access()
        .build()
}

#[cfg(target_os = "macos")]
fn ensure_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Ok(window) = create_main_window(app) {
        let _ = window.show();
        let _ = window.set_focus();
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
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let _work = session.begin_work()?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        fetch_opened_source_window(
            &session,
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
    session: &OpenedSourceSession,
    view_revision: u64,
    row_offset: u64,
    row_count: u32,
    source_indices: &[u32],
) -> Result<Vec<u8>, DataWindowCommandError> {
    let mut state = session.lock_state()?;
    if state.view_revision != view_revision {
        return Err(DataWindowCommandError::Session(
            DataWindowSessionError::ViewChanged,
        ));
    }
    match &state.view {
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
                state
                    .reader
                    .fetch(row_offset, row_count)
                    .map_err(Into::into)
            } else {
                state
                    .reader
                    .fetch_columns(row_offset, row_count, source_indices)
                    .map_err(Into::into)
            }
        }
    }
}

/// Returns one bounded page of top-level Data columns.
#[tauri::command]
fn get_source_schema_page(
    generation: u64,
    offset: usize,
    limit: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<SourceSchemaPage, DataWindowCommandError> {
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let _work = session.begin_work()?;
    source_schema_page(&session, offset, limit)
}

/// Returns one bounded DFS page for the Structure schema outline.
#[tauri::command]
fn get_source_schema_node_page(
    generation: u64,
    cursor: Option<SourceSchemaNodeCursor>,
    limit: usize,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<SourceSchemaNodePage, DataWindowCommandError> {
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let _work = session.begin_work()?;
    source_schema_node_page(&session, cursor, limit)
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
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let _work = session.begin_work()?;
    let builder = DataViewBuilder::with_memory_limit(
        session.path.clone(),
        &filters,
        &sort,
        settings.memory_limit,
    )?;
    let interrupt = Arc::new(builder.interrupt_handle());
    session.with_open_state(|state| {
        register_data_view_job(
            &mut state.data_view_jobs,
            ActiveDataViewJob {
                interrupt: Arc::clone(&interrupt),
                view_revision,
            },
        )
    })??;

    let result = tauri::async_runtime::spawn_blocking(move || builder.build()).await;
    let cancelled = interrupt.is_cancelled();
    let mut state = session.lock_state()?;
    let is_current = finish_data_view_job(&mut state.data_view_jobs, view_revision, &interrupt);
    if cancelled || !is_current {
        return Err(DataWindowError::Cancelled.into());
    }
    let view = result.map_err(|_| DataWindowError::QueryEngineUnavailable)??;
    if view_revision <= state.view_revision {
        return Err(DataWindowError::Cancelled.into());
    }
    let status = DataViewStatus {
        revision: view_revision,
        row_count: view.row_count(),
    };
    state.view_revision = view_revision;
    state.view = Some(view);
    Ok(status)
}

fn activate_direct_data_view(
    opened_source: &OpenedSource,
    generation: u64,
    view_revision: u64,
) -> Result<DataViewStatus, DataWindowCommandError> {
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let mut state = session.lock_state()?;
    if view_revision <= state.view_revision {
        return Err(DataWindowError::Cancelled.into());
    }
    if state
        .data_view_jobs
        .watermark
        .is_some_and(|revision| view_revision <= revision)
    {
        return Err(DataWindowError::Cancelled.into());
    }
    state.data_view_jobs.watermark = Some(view_revision);
    if let Some(active) = state.data_view_jobs.active.take() {
        active.cancel();
    }
    let status = DataViewStatus {
        revision: view_revision,
        row_count: session.summary.row_count,
    };
    state.view_revision = view_revision;
    state.view = None;
    Ok(status)
}

/// Returns the native view revision and count used by current grid windows.
#[tauri::command]
fn get_data_view_status(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<DataViewStatus, DataWindowCommandError> {
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let state = session.lock_state()?;
    Ok(DataViewStatus {
        revision: state.view_revision,
        row_count: state
            .view
            .as_ref()
            .map_or(session.summary.row_count, PreparedDataView::row_count),
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
        let session = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?
            .session(generation);
        let Some(session) = session else {
            return Ok(());
        };
        cancel_data_view_job(&mut session.lock_state()?.data_view_jobs, view_revision)
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
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        let missing = missing_data_window_session(&state);
        state.session(generation).ok_or(missing)?
    };
    let _work = session.begin_work()?;
    let column = session
        .summary
        .schema
        .get(column_index)
        .cloned()
        .ok_or(DataWindowError::InvalidFilter)?;
    let reader = session
        .lock_state()?
        .text_suggestion_reader(&session.path)?;
    let interrupt = Arc::new(reader.interrupt_handle());
    session.with_open_state(|state| {
        register_text_value_suggestion_job(
            &mut state.text_suggestion_jobs,
            ActiveTextValueSuggestionJob {
                suggestion_revision,
                interrupt: Arc::clone(&interrupt),
            },
        )
    })??;

    let request_interrupt = Arc::clone(&interrupt);
    let result = tauri::async_runtime::spawn_blocking(move || {
        reader.fetch(&prefix, &column, operator, &request_interrupt)
    })
    .await;
    let cancelled = interrupt.is_cancelled();
    let is_current = {
        let mut state = session.lock_state()?;
        finish_text_value_suggestion_job(
            &mut state.text_suggestion_jobs,
            suggestion_revision,
            &interrupt,
        )
    };

    if cancelled || !is_current {
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
        let session = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?
            .session(generation);
        let Some(session) = session else {
            return Ok(());
        };
        cancel_text_value_suggestion_job(
            &mut session.lock_state()?.text_suggestion_jobs,
            suggestion_revision,
        )
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
) -> Result<ColumnStatistics, ColumnStatisticsCommandError> {
    let session = {
        let state = opened_source
            .state
            .lock()
            .map_err(|_| ColumnStatisticsCommandError::Unsupported)?;
        state.session(generation).ok_or_else(|| {
            state.missing_session(
                ColumnStatisticsCommandError::NoSourceOpen,
                ColumnStatisticsCommandError::SourceChanged,
            )
        })?
    };
    let _work = session
        .begin_work()
        .map_err(ColumnStatisticsCommandError::from)?;
    let request = statistics_request(&session, column_index, include_min_max)?;
    let (path, column_name) = match request {
        ColumnStatisticsRequest::Cached(statistics) => {
            cancel_active_statistics_job(&opened_source, generation)?;
            return Ok(statistics);
        }
        ColumnStatisticsRequest::Scan { path, column_name } => (path, column_name),
    };
    let reader = ColumnStatisticsReader::new(path)?;
    let job = Arc::new(ColumnStatisticsJob {
        cancelled: AtomicBool::new(false),
        interrupt: reader.interrupt_handle(),
    });
    {
        let previous = session
            .with_open_state(|state| state.statistics_job.replace(Arc::clone(&job)))
            .map_err(ColumnStatisticsCommandError::from)?;
        if let Some(previous) = previous {
            previous.cancel();
        }
    }

    let result =
        tauri::async_runtime::spawn_blocking(move || reader.fetch(&column_name, include_min_max))
            .await;
    {
        let mut state = session
            .lock_state()
            .map_err(ColumnStatisticsCommandError::from)?;
        if state
            .statistics_job
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &job))
        {
            state.statistics_job.take();
        }
    }
    let cancelled = job.cancelled.load(Ordering::Acquire);

    if cancelled {
        return Err(ColumnStatisticsCommandError::Cancelled);
    }
    let statistics = result
        .map_err(|_| ColumnStatisticsCommandError::QueryEngineUnavailable)?
        .map_err(ColumnStatisticsCommandError::from)?;
    cache_statistics(&session, column_index, statistics.clone())?;
    Ok(statistics)
}

fn statistics_request(
    session: &OpenedSourceSession,
    column_index: usize,
    include_min_max: bool,
) -> Result<ColumnStatisticsRequest, ColumnStatisticsCommandError> {
    let state = session
        .lock_state()
        .map_err(ColumnStatisticsCommandError::from)?;
    if let Some(statistics) = state
        .statistics_cache
        .get(&column_index)
        .filter(|statistics| !include_min_max || statistics.min_max_computed)
    {
        return Ok(ColumnStatisticsRequest::Cached(statistics.clone()));
    }
    let column_name = session
        .summary
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
    session: &OpenedSourceSession,
    column_index: usize,
    statistics: ColumnStatistics,
) -> Result<(), ColumnStatisticsCommandError> {
    if session.schema.get(column_index).is_none() {
        return Err(ColumnStatisticsCommandError::UnsupportedColumn);
    }
    let mut state = session
        .lock_state()
        .map_err(ColumnStatisticsCommandError::from)?;
    match state.statistics_cache.entry(column_index) {
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
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<(), ColumnStatisticsCommandError> {
    let session = opened_source
        .state
        .lock()
        .map_err(|_| ColumnStatisticsCommandError::Unsupported)?
        .session(generation);
    let active = session
        .map(|session| {
            session
                .lock_state()
                .map(|mut state| state.statistics_job.take())
        })
        .transpose()
        .map_err(ColumnStatisticsCommandError::from)?
        .flatten();
    if let Some(active) = active {
        active.cancel();
    }
    Ok(())
}

/// Interrupts the active statistics scan of one opened source.
#[tauri::command]
fn cancel_column_statistics(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<(), ColumnStatisticsCommandError> {
    cancel_active_statistics_job(&opened_source, generation)
}

/// Owns the native file dialog and passes the selected path directly to data-engine.
///
/// Rust owns file selection and reading; the webview receives the canonical
/// path later only for switcher search, tooltip, and explicit path actions.
/// Cancellation returns `Ok(None)` — it is a normal outcome, not an error.
#[tauri::command]
async fn open_local_source(
    app: tauri::AppHandle,
    attempt: String,
) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
    let Some(open_request) = app
        .state::<OpenedSource>()
        .begin_client_source_open(&attempt)?
    else {
        return Ok(None);
    };
    let command_app = app.clone();
    let job_attempt = attempt.clone();
    // blocking_pick_file would stall the async runtime thread.
    let inspected = tauri::async_runtime::spawn_blocking(move || {
        let selected = command_app
            .dialog()
            .file()
            .add_filter("Parquet", &["parquet"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| SourceError::Unsupported)?;

        let opened_source = command_app.state::<OpenedSource>();
        let recent_sources_path = recents::state_path(&command_app).ok();
        inspect_selected_source_at_path_for_request(
            recent_sources_path.as_deref(),
            opened_source.inner(),
            path,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request: open_request,
                client_attempt: Some(&job_attempt),
            },
        )
    })
    .await;
    app.state::<OpenedSource>()
        .finish_client_source_open(&attempt)?;
    let inspected = inspected.map_err(|_| SourceError::Unsupported)??;

    if inspected.is_some() {
        let _ = recent_sources_changed(&app);
    }
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
    let open_request = opened_source.begin_source_open()?;
    inspect_selected_source_at_path_for_request(
        recent_sources_path,
        opened_source,
        path,
        intent,
        SourceOpenPublication {
            request: open_request,
            client_attempt: None,
        },
    )
}

fn inspect_selected_source_at_path_for_request(
    recent_sources_path: Option<&std::path::Path>,
    opened_source: &OpenedSource,
    path: PathBuf,
    intent: SourceOpenIntent,
    publication: SourceOpenPublication<'_>,
) -> Result<Option<(PathBuf, OpenedSourceInfo)>, OpenSourceError> {
    if !opened_source.source_open_is_current(publication.request)? {
        return Ok(None);
    }
    if intent == SourceOpenIntent::Restore && opened_source.blocks_restore()? {
        return Ok(None);
    }
    let inspected = opened_source.run_source_open_job(publication.request, |keep_going| {
        inspect_local_source_snapshot_cancellable(&path, keep_going).map_err(Into::into)
    });
    let (summary, snapshot) = match inspected {
        Ok(Some(inspected)) => inspected,
        Ok(None) => return Ok(None),
        Err(_) if intent == SourceOpenIntent::Restore && opened_source.blocks_restore()? => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    remember_inspected_source_with_snapshot(
        recent_sources_path,
        opened_source,
        path,
        summary,
        snapshot,
        intent,
        publication,
    )
}

fn remember_inspected_source_with_snapshot(
    recent_sources_path: Option<&std::path::Path>,
    opened_source: &OpenedSource,
    path: PathBuf,
    summary: SourceSummary,
    snapshot: SourceSnapshot,
    intent: SourceOpenIntent,
    publication: SourceOpenPublication<'_>,
) -> Result<Option<(PathBuf, OpenedSourceInfo)>, OpenSourceError> {
    let canonical_path = std::fs::canonicalize(&path).unwrap_or(path);
    let source = opened_source.install_with_snapshot(
        recent_sources_path,
        canonical_path.clone(),
        summary,
        Some(snapshot),
        intent,
        Some(publication),
    )?;
    Ok(source.map(|source| (canonical_path, source)))
}

#[cfg(test)]
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

/// Returns recent display metadata, including canonical paths for the switcher.
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
    attempt: String,
) -> Result<OpenedSourceInfo, OpenSourceError> {
    let Some(open_request) = app
        .state::<OpenedSource>()
        .begin_client_source_open(&attempt)?
    else {
        return Err(SourceError::Unsupported.into());
    };
    let command_app = app.clone();
    let job_attempt = attempt.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let opened_source = command_app.state::<OpenedSource>();
        open_recent_source_at_path_for_request(
            &recents::state_path(&command_app)?,
            opened_source.inner(),
            &id,
            SourceOpenPublication {
                request: open_request,
                client_attempt: Some(&job_attempt),
            },
        )
    })
    .await;
    app.state::<OpenedSource>()
        .finish_client_source_open(&attempt)?;
    let result = result.map_err(|_| SourceError::Unsupported)?;
    let _ = recent_sources_changed(&app);
    result.map(|(_, source)| source)
}

pub(crate) fn open_recent_source_with_app(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<(PathBuf, OpenedSourceInfo), OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    let open_request = opened_source.begin_source_open()?;
    open_recent_source_at_path_for_request(
        &recents::state_path(app)?,
        opened_source.inner(),
        id,
        SourceOpenPublication {
            request: open_request,
            client_attempt: None,
        },
    )
}

#[cfg(test)]
fn open_recent_source_at_path(
    recent_sources_path: &std::path::Path,
    opened_source: &OpenedSource,
    id: &str,
) -> Result<(PathBuf, OpenedSourceInfo), OpenSourceError> {
    let open_request = opened_source.begin_source_open()?;
    open_recent_source_at_path_for_request(
        recent_sources_path,
        opened_source,
        id,
        SourceOpenPublication {
            request: open_request,
            client_attempt: None,
        },
    )
}

fn open_recent_source_at_path_for_request(
    recent_sources_path: &std::path::Path,
    opened_source: &OpenedSource,
    id: &str,
    publication: SourceOpenPublication<'_>,
) -> Result<(PathBuf, OpenedSourceInfo), OpenSourceError> {
    let path = opened_source
        .recents
        .path_for_id_path(recent_sources_path, id)?;
    let result = inspect_selected_source_at_path_for_request(
        Some(recent_sources_path),
        opened_source,
        path,
        SourceOpenIntent::Explicit,
        publication,
    )
    .and_then(require_explicit_source);
    if result == Err(SourceError::NotFound.into()) {
        // Preserve the existing source error even if cleaning a damaged store fails.
        let _ = opened_source.recents.remove_path(recent_sources_path, id);
    }
    result
}

#[tauri::command]
fn cancel_source_open(
    attempt: String,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<SourceOpenCancelOutcome, OpenSourceError> {
    opened_source.cancel_source_open(&attempt)
}

#[tauri::command]
fn get_source_open_progress(
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<Option<SourceOpenProgressPhase>, OpenSourceError> {
    opened_source.source_open_progress()
}

/// Forgets one recent source without touching the sources that are open.
#[tauri::command]
async fn remove_recent_source(app: tauri::AppHandle, id: String) -> Result<(), RecentSourceError> {
    let command_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let opened_source = command_app.state::<OpenedSource>();
        opened_source
            .recents
            .remove_path(&recents::state_path(&command_app)?, &id)
    })
    .await
    .map_err(|_| RecentSourceError::Storage)??;
    recent_sources_changed(&app)
}

/// Empties the recent-source history shared by every surface that lists it.
#[tauri::command]
async fn clear_recent_sources(app: tauri::AppHandle) -> Result<(), RecentSourceError> {
    let command_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let opened_source = command_app.state::<OpenedSource>();
        opened_source
            .recents
            .clear_path(&recents::state_path(&command_app)?)
    })
    .await
    .map_err(|_| RecentSourceError::Storage)??;
    recent_sources_changed(&app)
}

pub(crate) fn recent_sources_changed(app: &tauri::AppHandle) -> Result<(), RecentSourceError> {
    sync_recent_sources_menu(app)?;
    let _ = app.emit(RECENT_SOURCES_CHANGED_EVENT, ());
    Ok(())
}

fn sync_recent_sources_menu(app: &tauri::AppHandle) -> Result<(), RecentSourceError> {
    let submenu = app
        .state::<RecentSourcesMenu>()
        .0
        .lock()
        .map_err(|_| RecentSourceError::Storage)?
        .clone();
    let Some(submenu) = submenu else {
        return Ok(());
    };
    while !submenu
        .items()
        .map_err(|_| RecentSourceError::Storage)?
        .is_empty()
    {
        submenu
            .remove_at(0)
            .map_err(|_| RecentSourceError::Storage)?;
    }
    let recents = app.state::<OpenedSource>().recents.list(app)?;
    for recent in &recents {
        let item = MenuItemBuilder::with_id(
            format!("{OPEN_RECENT_MENU_PREFIX}{}", recent.id),
            format!("{} — {}", recent.name, recent.directory),
        )
        .build(app)
        .map_err(|_| RecentSourceError::Storage)?;
        submenu
            .append(&item)
            .map_err(|_| RecentSourceError::Storage)?;
    }
    if !recents.is_empty() {
        let separator =
            PredefinedMenuItem::separator(app).map_err(|_| RecentSourceError::Storage)?;
        submenu
            .append(&separator)
            .map_err(|_| RecentSourceError::Storage)?;
    }
    let clear = MenuItemBuilder::with_id(CLEAR_RECENT_MENU_ID, "Clear Recent")
        .enabled(!recents.is_empty())
        .build(app)
        .map_err(|_| RecentSourceError::Storage)?;
    submenu
        .append(&clear)
        .map_err(|_| RecentSourceError::Storage)
}

/// Lists the open sources, most recently used first, for the switcher and titlebar.
#[tauri::command]
fn list_opened_sources(
    app: tauri::AppHandle,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<Vec<OpenedSourceEntry>, OpenSourceError> {
    let home = app
        .path()
        .home_dir()
        .ok()
        .and_then(|home| std::fs::canonicalize(home).ok());
    let state = opened_source.lock_state()?;
    Ok(state
        .sessions
        .iter()
        .enumerate()
        .map(|(index, session)| OpenedSourceEntry {
            generation: session.generation,
            name: session.summary.display_name.clone(),
            directory: recents::display_directory(&session.path, home.as_deref()),
            path: session.path.to_string_lossy().into_owned(),
            active: index == 0,
        })
        .collect())
}

/// Makes one open source the active and most recently used one.
#[tauri::command]
fn activate_opened_source(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<(), DataWindowCommandError> {
    {
        let mut state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        if !state.activate(generation) {
            return Err(missing_data_window_session(&state));
        }
    }
    opened_source
        .structure_cache
        .lock()
        .map_err(|_| DataWindowError::Unsupported)?
        .touch(generation);
    Ok(())
}

/// Cycles the native MRU list atomically, so rapid shortcuts cannot use stale UI state.
#[tauri::command]
fn cycle_opened_source(
    reverse: bool,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<Option<u64>, DataWindowCommandError> {
    let generation = {
        let mut state = opened_source
            .state
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?;
        cycle_opened_source_state(&mut state, reverse)
    };
    if let Some(generation) = generation {
        opened_source
            .structure_cache
            .lock()
            .map_err(|_| DataWindowError::Unsupported)?
            .touch(generation);
    }
    Ok(generation)
}

fn cycle_opened_source_state(state: &mut OpenedSourceState, reverse: bool) -> Option<u64> {
    if state.sessions.len() <= 1 {
        return state.sessions.first().map(|session| session.generation);
    }
    let index = if reverse { state.sessions.len() - 1 } else { 1 };
    let generation = state.sessions[index].generation;
    state.activate(generation);
    Some(generation)
}

#[tauri::command]
fn reveal_opened_source(
    generation: u64,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<(), OpenSourceError> {
    let path = opened_source
        .lock_state()?
        .session(generation)
        .map(|session| session.path.clone())
        .ok_or(RecentSourceError::UnknownRecent)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_| RecentSourceError::Storage.into())
}

/// Closes one open source and reports whether it closed.
///
/// A running export is confirmed first: declining leaves the source open and
/// the export running.
#[tauri::command]
async fn close_opened_source(
    app: tauri::AppHandle,
    generation: u64,
) -> Result<bool, DataWindowCommandError> {
    let opened_source = app.state::<OpenedSource>();
    let (close_reservation, file_names) = opened_source
        .data_exports
        .begin_source_close(generation)
        .map_err(|_| DataWindowError::Unsupported)?;
    if !confirm_data_export_cancellation(&app, file_names, DataExportShutdownAction::CloseSource)
        .await
    {
        return Ok(false);
    }
    close_reservation.cancel_and_wait();
    let closed = opened_source
        .close(generation)
        .map_err(|_| DataWindowError::Unsupported);
    if closed? {
        return Ok(true);
    }
    let state = opened_source
        .lock_state()
        .map_err(|_| DataWindowError::Unsupported)?;
    Err(missing_data_window_session(&state))
}

/// Routes the close shortcut: the active file while one is open, the window otherwise.
///
/// Rust owns the open set, so the decision cannot be left to the webview. Closing
/// the file goes back to the UI, which owns the confirmation for a running export.
fn request_source_close(app: &tauri::AppHandle) {
    let active_generation = app
        .state::<OpenedSource>()
        .lock_state()
        .ok()
        .and_then(|state| state.sessions.first().map(|session| session.generation));
    if let Some(generation) = active_generation {
        // The frontend receiver can already be gone while the app is shutting down.
        let _ = app.emit(CLOSE_SOURCE_REQUESTED_EVENT, generation);
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
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

fn data_export_close_dialog_copy(
    file_names: &[String],
    action: DataExportShutdownAction,
) -> DataExportCloseDialogCopy {
    debug_assert!(!file_names.is_empty());
    let (consequence, destructive_button) = match action {
        DataExportShutdownAction::Close => ("close Viewda", "Close Viewda"),
        DataExportShutdownAction::CloseWindow => ("close this window", "Close Window"),
        DataExportShutdownAction::CloseSource => ("close this file", "Close File"),
        DataExportShutdownAction::RestartForUpdate => ("restart Viewda", "Restart Viewda"),
    };
    let message = match file_names {
        [file_name] => format!(
            "\u{201c}{file_name}\u{201d} is still being exported. If you {consequence} now, the unfinished file will be deleted."
        ),
        _ => format!(
            "{} exports are still running. If you {consequence} now, their unfinished files will be deleted.",
            file_names.len()
        ),
    };

    DataExportCloseDialogCopy {
        message,
        destructive_button,
    }
}

fn request_data_export_close_confirmation<F>(
    app: &tauri::AppHandle,
    file_names: Vec<String>,
    action: DataExportShutdownAction,
    on_decision: F,
) where
    F: FnOnce(bool) + Send + 'static,
{
    let copy = data_export_close_dialog_copy(&file_names, action);
    if !app
        .state::<DataExportCloseDialog>()
        .try_open(copy.clone(), action, on_decision)
    {
        return;
    }
    let _ = app.emit(DATA_EXPORT_CLOSE_REQUESTED_EVENT, copy);
}

#[tauri::command]
fn get_pending_data_export_close_dialog(
    dialog: tauri::State<'_, DataExportCloseDialog>,
) -> Option<DataExportCloseDialogCopy> {
    dialog.copy()
}

#[tauri::command]
async fn resolve_data_export_close_dialog(app: tauri::AppHandle, cancel_export: bool) -> bool {
    let dialog = app.state::<DataExportCloseDialog>();
    let Some(resolution) = dialog.begin_resolution() else {
        return false;
    };

    if !cancel_export {
        resolution.decide(false);
        return true;
    }
    match resolution.action() {
        DataExportShutdownAction::CloseSource => resolution.decide(true),
        DataExportShutdownAction::CloseWindow => {
            let cancellation_app = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let opened_source = cancellation_app.state::<OpenedSource>();
                opened_source
                    .data_exports
                    .drain_temporarily(|| resolution.decide(true))
            })
            .await;
        }
        DataExportShutdownAction::Close | DataExportShutdownAction::RestartForUpdate => {
            let cancellation_app = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                cancellation_app
                    .state::<OpenedSource>()
                    .data_exports
                    .cancel_all_and_wait();
                resolution.decide(true);
            })
            .await;
        }
    }
    true
}

fn window_close_action(keeps_running_after_close: bool) -> DataExportShutdownAction {
    if keeps_running_after_close {
        DataExportShutdownAction::CloseWindow
    } else {
        DataExportShutdownAction::Close
    }
}

async fn confirm_data_export_cancellation(
    app: &tauri::AppHandle,
    file_names: Vec<String>,
    action: DataExportShutdownAction,
) -> bool {
    if file_names.is_empty() {
        return true;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    request_data_export_close_confirmation(app, file_names, action, move |cancel_export| {
        let _ = sender.send(cancel_export);
    });
    tauri::async_runtime::spawn_blocking(move || receiver.recv().unwrap_or(false))
        .await
        .unwrap_or(false)
}

fn running_data_export_file_names(app: &tauri::AppHandle) -> Vec<String> {
    app.state::<OpenedSource>()
        .data_exports
        .running_file_names()
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn request_application_exit(app: &tauri::AppHandle, exit_code: i32) {
    let file_names = running_data_export_file_names(app);
    if file_names.is_empty() {
        app.exit(exit_code);
        return;
    }

    let exit_app = app.clone();
    request_data_export_close_confirmation(
        app,
        file_names,
        DataExportShutdownAction::Close,
        move |cancel_export| {
            if cancel_export {
                exit_app.exit(exit_code);
            }
        },
    );
}

fn finish_shutdown(app: &tauri::AppHandle) {
    let _ = app.state::<OpenedSource>().cancel_all_jobs();
    app.state::<OpenedSource>()
        .data_exports
        .cancel_all_and_wait();
}

#[tauri::command]
async fn install_pending_update(
    app: tauri::AppHandle,
    on_progress: tauri::ipc::Channel<UpdateProgress>,
) -> Result<bool, UpdateError> {
    if !confirm_data_export_cancellation(
        &app,
        running_data_export_file_names(&app),
        DataExportShutdownAction::RestartForUpdate,
    )
    .await
    {
        return Ok(false);
    }
    app.state::<OpenedSource>()
        .data_exports
        .block_starts_and_wait()
        .map_err(|_| UpdateError::Unavailable)?;
    let result = install_pending_update_without_restart(
        app.clone(),
        app.state::<PendingUpdate>(),
        app.state::<UpdateStateStore>(),
        app.state::<OpenedSource>(),
        on_progress,
    )
    .await;
    if let Err(error) = result {
        app.state::<OpenedSource>().data_exports.allow_starts();
        return Err(error);
    }
    app.restart()
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
        .manage(RecentSourcesMenu::default())
        .manage(DataExportCloseDialog::default())
        .manage(PendingOpenedSource::default())
        .manage(PendingUpdate::default())
        .manage(UpdateStateStore::default())
        .setup(|app| {
            create_main_window(app.handle())?;
            apply_saved_theme(app.handle(), &app.state::<UpdateStateStore>());
            // Tauri's path resolver becomes available during setup, after the menu is built.
            let _ = sync_recent_sources_menu(app.handle());
            #[cfg(not(target_os = "macos"))]
            {
                let cwd = std::env::current_dir().unwrap_or_default();
                open_from_args(app.handle(), std::env::args_os(), &cwd);
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
            let open_recent =
                SubmenuBuilder::with_id(app, OPEN_RECENT_MENU_ID, "Open Recent").build()?;
            if let Ok(mut stored) = app.state::<RecentSourcesMenu>().0.lock() {
                *stored = Some(open_recent.clone());
            }
            let close_source = MenuItemBuilder::with_id(CLOSE_SOURCE_MENU_ID, "Close File")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let check_for_updates =
                MenuItemBuilder::with_id(CHECK_FOR_UPDATES_MENU_ID, "Check for Updates…")
                    .build(app)?;
            #[cfg(target_os = "macos")]
            let quit =
                MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {}", app.package_info().name))
                    .accelerator("Cmd+Q")
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
                file_menu.prepend_items(&[
                    &open_source,
                    &open_recent,
                    &close_source,
                    &open_separator,
                ])?;
                #[cfg(not(target_os = "macos"))]
                {
                    let update_separator = PredefinedMenuItem::separator(app)?;
                    file_menu.prepend_items(&[
                        &open_source,
                        &open_recent,
                        &close_source,
                        &open_separator,
                        &settings,
                        &check_for_updates,
                        &update_separator,
                    ])?;
                }
            } else {
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&open_source)
                    .item(&open_recent)
                    .separator();
                #[cfg(not(target_os = "macos"))]
                let file_menu = file_menu
                    .item(&settings)
                    .item(&check_for_updates)
                    .separator();
                let file_menu = file_menu.item(&close_source);
                // Elsewhere the predefined item keeps its own Alt+F4; on macOS it
                // would claim Cmd+W, which belongs to Close File.
                #[cfg(not(target_os = "macos"))]
                let file_menu = file_menu.close_window().quit();
                let file_menu = file_menu.build()?;
                menu.prepend(&file_menu)?;
            }

            // The default Window submenu ends with a predefined Close Window on
            // Cmd+W. Viewda gives that shortcut to Close File, which closes the
            // window once the last file is gone.
            #[cfg(target_os = "macos")]
            if let Some(window_menu) = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu)
                    if submenu.text().is_ok_and(|text| text == "Window") =>
                {
                    Some(submenu)
                }
                _ => None,
            }) {
                let close_position = window_menu.items()?.len().saturating_sub(1);
                let _ = window_menu.remove_at(close_position)?;
            }

            #[cfg(target_os = "macos")]
            if let Some(app_menu) = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu) => Some(submenu),
                _ => None,
            }) {
                let separator = PredefinedMenuItem::separator(app)?;
                // The default application menu starts with About + separator.
                app_menu.insert_items(&[&settings, &check_for_updates, &separator], 2)?;

                // Tauri's pinned default menu ends with a predefined Quit item.
                // On macOS that item calls `terminate:` and bypasses ExitRequested,
                // so replace it with an event-producing item the export guard owns.
                // Dock Quit and system logout/shutdown still call `terminate:` directly.
                // Tauri exposes no preventable event for those paths, so they cannot show this guard.
                let quit_position = app_menu.items()?.len().saturating_sub(1);
                let _ = app_menu.remove_at(quit_position)?;
                app_menu.insert(&quit, quit_position)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            if event.id() == QUIT_MENU_ID {
                request_application_exit(app, 0);
                return;
            }
            if event.id() == OPEN_SOURCE_MENU_ID {
                // The frontend receiver can already be gone while the app is shutting down.
                let _ = app.emit(OPEN_SOURCE_REQUESTED_EVENT, ());
            } else if event.id() == CLOSE_SOURCE_MENU_ID {
                request_source_close(app);
            } else if event.id() == CLEAR_RECENT_MENU_ID {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = clear_recent_sources(app).await;
                });
            } else if let Some(id) = event.id().0.strip_prefix(OPEN_RECENT_MENU_PREFIX) {
                launch::open_recent(app, id);
            } else if event.id() == SETTINGS_MENU_ID {
                let _ = app.emit(SETTINGS_REQUESTED_EVENT, ());
            } else if event.id() == CHECK_FOR_UPDATES_MENU_ID {
                check_for_updates_from_menu(app);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                launch::open_dropped_paths(window.app_handle(), paths.clone());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let file_names = running_data_export_file_names(window.app_handle());
                if file_names.is_empty() {
                    return;
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                let window = window.clone();
                request_data_export_close_confirmation(
                    &app,
                    file_names,
                    window_close_action(cfg!(target_os = "macos")),
                    move |cancel_export| {
                        if cancel_export {
                            let _ = window.close();
                        }
                    },
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_status,
            open_local_source,
            cancel_source_open,
            get_source_open_progress,
            get_recent_sources,
            open_recent_source,
            remove_recent_source,
            clear_recent_sources,
            list_opened_sources,
            activate_opened_source,
            cycle_opened_source,
            close_opened_source,
            reveal_opened_source,
            take_opened_source,
            get_default_application_status,
            set_default_application,
            get_data_window,
            get_source_schema_page,
            get_source_schema_node_page,
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
            get_structure_summary,
            get_structure_load_progress,
            cancel_structure_load,
            get_structure_lens_totals,
            get_structure_layout,
            get_structure_row_groups,
            get_structure_columns,
            get_structure_chunk,
            get_structure_key_value,
            get_structure_row_offset,
            get_structure_report,
            probe_structure_bloom_filter,
            cancel_structure_bloom_probe,
            get_update_settings,
            set_update_settings,
            get_data_view_settings,
            set_data_view_settings,
            get_theme_preference,
            set_theme_preference,
            sync_system_theme,
            get_pending_data_export_close_dialog,
            resolve_data_export_close_dialog,
            check_for_update,
            discard_pending_update,
            install_pending_update,
            take_post_update_state,
            open_releases_page
        ])
        .build(tauri::generate_context!())
        .expect("Viewda desktop runtime failed")
        .run(|app, event| {
            match &event {
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    let file_names = running_data_export_file_names(app);
                    if should_prevent_exit(cfg!(target_os = "macos"), *code, !file_names.is_empty())
                    {
                        api.prevent_exit();
                        if !file_names.is_empty() {
                            let dialog_app = app.clone();
                            let exit_app = app.clone();
                            let exit_code = code.unwrap_or(0);
                            request_data_export_close_confirmation(
                                &dialog_app,
                                file_names,
                                DataExportShutdownAction::Close,
                                move |cancel_export| {
                                    if cancel_export {
                                        exit_app.exit(exit_code);
                                    }
                                },
                            );
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    finish_shutdown(app);
                }
                _ => {}
            }
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::WindowEvent { label, event, .. }
                    if label == "main" && matches!(event, tauri::WindowEvent::Destroyed) =>
                {
                    let opened_source = app.state::<OpenedSource>();
                    let _ = opened_source
                        .data_exports
                        .drain_temporarily(|| opened_source.close_all());
                }
                tauri::RunEvent::Opened { urls } => {
                    ensure_main_window(app);
                    for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
                        open_path(app, path);
                    }
                }
                tauri::RunEvent::Reopen {
                    has_visible_windows: false,
                    ..
                } => {
                    ensure_main_window(app);
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use viewda_data_engine::SchemaField;

    use super::*;

    #[test]
    fn macos_keeps_running_after_the_last_window_closes() {
        assert!(should_prevent_exit(true, None, false));
        assert!(!should_prevent_exit(false, None, false));
        assert!(should_prevent_exit(false, None, true));
        assert!(!should_prevent_exit(
            true,
            Some(tauri::RESTART_EXIT_CODE),
            true
        ));
        assert_eq!(
            window_close_action(true),
            DataExportShutdownAction::CloseWindow
        );
        assert_eq!(window_close_action(false), DataExportShutdownAction::Close);
    }

    #[test]
    fn native_mru_cycles_single_and_rapid_requests_atomically() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        assert_eq!(
            cycle_opened_source_state(
                &mut opened_source.state.lock().expect("source state"),
                false,
            ),
            Some(first.generation)
        );
        let second = open_test_source(&opened_source, "second.parquet");
        let third = open_test_source(&opened_source, "third.parquet");
        let mut state = opened_source.state.lock().expect("source state");
        assert_eq!(
            cycle_opened_source_state(&mut state, false),
            Some(second.generation)
        );
        assert_eq!(
            cycle_opened_source_state(&mut state, false),
            Some(third.generation)
        );
        assert_eq!(
            cycle_opened_source_state(&mut state, true),
            Some(first.generation)
        );
    }

    #[test]
    fn close_waits_for_registered_worker_resources_without_holding_global_state() {
        let opened_source = Arc::new(OpenedSource::default());
        let opened = open_test_source(&opened_source, "slow.parquet");
        let session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(opened.generation)
            .expect("session");
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _work = session.begin_work().expect("registered worker");
            let temporary = tempfile::tempdir().expect("temporary preparation directory");
            ready_tx.send(temporary.path().to_path_buf()).unwrap();
            release_rx.recv().unwrap();
            drop(temporary);
        });
        let temporary_path = ready_rx.recv().unwrap();
        let closing_source = Arc::clone(&opened_source);
        let close = std::thread::spawn(move || {
            closing_source
                .close(opened.generation)
                .expect("close source")
        });

        while !session_is_closing(&opened_source, opened.generation) {
            std::thread::yield_now();
        }
        assert!(!close.is_finished());
        assert!(opened_source.open_paths().expect("open paths").is_empty());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(close.join().unwrap());
        assert!(!temporary_path.exists());
    }

    #[test]
    fn one_session_fetch_lock_does_not_block_other_session_lifecycle() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        let second = open_test_source(&opened_source, "second.parquet");
        let second_session = opened_source
            .state
            .lock()
            .expect("source state")
            .session(second.generation)
            .expect("second session");
        let _blocked_fetch = second_session.lock_state().expect("session fetch lock");

        assert!(
            opened_source
                .state
                .lock()
                .expect("source state")
                .activate(first.generation)
        );
        assert_eq!(opened_source.open_paths().expect("open paths").len(), 2);
        assert!(opened_source.close(first.generation).expect("close first"));
    }

    fn session_is_closing(opened_source: &OpenedSource, generation: u64) -> bool {
        opened_source
            .state
            .lock()
            .ok()
            .and_then(|state| state.session(generation))
            .and_then(|session| {
                session
                    .lifecycle
                    .state
                    .lock()
                    .ok()
                    .map(|state| state.closing)
            })
            .unwrap_or(true)
    }

    #[test]
    fn close_dialog_names_one_running_export_with_concise_actions() {
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::Close,
        );

        assert_eq!(copy.destructive_button, "Close Viewda");
        assert_eq!(
            copy.message,
            "\u{201c}orders-view.csv\u{201d} is still being exported. If you close Viewda now, the unfinished file will be deleted."
        );
    }

    #[test]
    fn close_dialog_copy_keeps_its_frontend_wire_shape() {
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::Close,
        );

        assert_eq!(
            serde_json::to_value(copy).expect("close-dialog copy JSON"),
            serde_json::json!({
                "message": "\u{201c}orders-view.csv\u{201d} is still being exported. If you close Viewda now, the unfinished file will be deleted.",
                "destructiveButton": "Close Viewda",
            })
        );
    }

    #[test]
    fn close_dialog_summarizes_several_running_exports_once() {
        let copy = data_export_close_dialog_copy(
            &[
                "orders-view.csv".to_owned(),
                "customers-view.csv".to_owned(),
            ],
            DataExportShutdownAction::Close,
        );

        assert_eq!(copy.destructive_button, "Close Viewda");
        assert_eq!(
            copy.message,
            "2 exports are still running. If you close Viewda now, their unfinished files will be deleted."
        );
    }

    #[test]
    fn close_source_dialog_is_about_the_file_and_not_the_application() {
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::CloseSource,
        );

        assert_eq!(copy.destructive_button, "Close File");
        assert_eq!(
            copy.message,
            "\u{201c}orders-view.csv\u{201d} is still being exported. If you close this file now, the unfinished file will be deleted."
        );
    }

    #[test]
    fn update_restart_dialog_explains_that_the_export_will_be_cancelled() {
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::RestartForUpdate,
        );

        assert_eq!(copy.destructive_button, "Restart Viewda");
        assert_eq!(
            copy.message,
            "\u{201c}orders-view.csv\u{201d} is still being exported. If you restart Viewda now, the unfinished file will be deleted."
        );
    }

    #[test]
    fn close_dialog_keeps_one_pending_decision_and_declines_duplicates() {
        let dialog = DataExportCloseDialog::default();
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::Close,
        );
        let (first_sender, first_receiver) = std::sync::mpsc::sync_channel(1);
        let (second_sender, second_receiver) = std::sync::mpsc::sync_channel(1);

        assert!(dialog.try_open(
            copy.clone(),
            DataExportShutdownAction::Close,
            move |decision| first_sender.send(decision).unwrap(),
        ));
        assert!(!dialog.try_open(
            copy.clone(),
            DataExportShutdownAction::Close,
            move |decision| second_sender.send(decision).unwrap(),
        ));
        assert!(!second_receiver.recv().unwrap());
        assert_eq!(dialog.copy().unwrap().message, copy.message);

        dialog.begin_resolution().unwrap().decide(false);
        assert!(!first_receiver.recv().unwrap());

        assert!(dialog.try_open(copy, DataExportShutdownAction::Close, |_| {}));
    }

    #[test]
    fn close_dialog_rejects_new_work_until_the_callback_finishes() {
        let dialog = DataExportCloseDialog::default();
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::Close,
        );
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (first_tx, first_rx) = mpsc::sync_channel(1);
        assert!(dialog.try_open(
            copy.clone(),
            DataExportShutdownAction::Close,
            move |decision| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                first_tx.send(decision).unwrap();
            },
        ));
        let resolution = dialog.begin_resolution().expect("begin resolution");

        std::thread::scope(|scope| {
            let resolving = scope.spawn(move || resolution.decide(true));
            entered_rx.recv().expect("callback entered");

            let (rejected_tx, rejected_rx) = mpsc::sync_channel(1);
            assert!(!dialog.try_open(
                copy.clone(),
                DataExportShutdownAction::Close,
                move |decision| rejected_tx.send(decision).unwrap(),
            ));
            assert!(!rejected_rx.recv().expect("rejected dialog decision"));
            assert!(dialog.begin_resolution().is_none());

            release_tx.send(()).unwrap();
            resolving.join().expect("resolve dialog");
        });

        assert!(first_rx.recv().expect("first dialog decision"));
        assert!(dialog.try_open(copy, DataExportShutdownAction::Close, |_| {}));
    }

    #[test]
    fn close_dialog_resolution_releases_its_slot_when_the_callback_panics() {
        let dialog = DataExportCloseDialog::default();
        let copy = data_export_close_dialog_copy(
            &["orders-view.csv".to_owned()],
            DataExportShutdownAction::Close,
        );
        assert!(
            dialog.try_open(copy.clone(), DataExportShutdownAction::Close, |_| panic!(
                "simulated callback panic"
            ),)
        );

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            dialog.begin_resolution().unwrap().decide(true);
        }));

        assert!(result.is_err());
        assert!(dialog.try_open(copy, DataExportShutdownAction::Close, |_| {}));
    }

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
            column_count: 0,
            schema: Vec::new(),
            schema_node_count: 0,
            schema_is_truncated: false,
            strings_truncated: false,
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
            opened_source.open_paths().expect("opened-source state"),
            vec![opened.0]
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
            })
            .expect("text suggestions JSON"),
            serde_json::json!({
                "values": ["Alpha"],
                "isPartial": true
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
            column_count: 0,
            schema: Vec::new(),
            schema_node_count: 0,
            schema_is_truncated: false,
            strings_truncated: false,
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
        assert_eq!(opened_source.open_paths(), Ok(vec![launched]));
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
            column_count: 0,
            schema: Vec::new(),
            schema_node_count: 0,
            schema_is_truncated: false,
            strings_truncated: false,
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
    fn direct_open_supersedes_a_client_attempt_without_late_cancel_staling_it() {
        let opened_source = OpenedSource::default();
        let client_request = opened_source
            .begin_client_source_open("client-a")
            .expect("client source open")
            .expect("registered client source open");
        let direct_request = opened_source
            .begin_source_open()
            .expect("direct source open");

        assert_eq!(
            opened_source.cancel_source_open("client-a"),
            Ok(SourceOpenCancelOutcome::Cancelled)
        );
        assert!(
            !opened_source
                .source_open_is_current(client_request)
                .expect("client request state")
        );
        assert!(
            opened_source
                .source_open_is_current(direct_request)
                .expect("direct request state")
        );

        let installed = opened_source
            .install_with_snapshot(
                None,
                PathBuf::from("direct.parquet"),
                test_summary("direct.parquet"),
                None,
                SourceOpenIntent::Explicit,
                Some(SourceOpenPublication {
                    request: direct_request,
                    client_attempt: None,
                }),
            )
            .expect("direct source install")
            .expect("direct source publishes");
        let state = opened_source.lock_state().expect("source state");
        assert_eq!(state.sessions[0].generation, installed.generation);
        assert_eq!(state.sessions[0].path, PathBuf::from("direct.parquet"));
    }

    #[test]
    fn cancel_and_publish_keep_deterministic_open_attempt_outcomes() {
        let opened_source = OpenedSource::default();
        let cancelled = opened_source
            .begin_client_source_open("cancelled")
            .expect("client source open")
            .expect("registered client source open");
        assert_eq!(
            opened_source.cancel_source_open("cancelled"),
            Ok(SourceOpenCancelOutcome::Cancelled)
        );
        assert!(
            opened_source
                .install_with_snapshot(
                    None,
                    PathBuf::from("cancelled.parquet"),
                    test_summary("cancelled.parquet"),
                    None,
                    SourceOpenIntent::Explicit,
                    Some(SourceOpenPublication {
                        request: cancelled,
                        client_attempt: Some("cancelled"),
                    }),
                )
                .expect("cancelled publication is discarded")
                .is_none()
        );

        let published = opened_source
            .begin_client_source_open("published")
            .expect("client source open")
            .expect("registered client source open");
        let source = opened_source
            .install_with_snapshot(
                None,
                PathBuf::from("published.parquet"),
                test_summary("published.parquet"),
                None,
                SourceOpenIntent::Explicit,
                Some(SourceOpenPublication {
                    request: published,
                    client_attempt: Some("published"),
                }),
            )
            .expect("published source install")
            .expect("published source");
        assert_eq!(
            opened_source.cancel_source_open("published"),
            Ok(SourceOpenCancelOutcome::Published)
        );
        assert_eq!(source.generation, 1);
    }

    #[test]
    fn client_open_attempt_tracking_is_bounded() {
        let opened_source = OpenedSource::default();
        for index in 0..100 {
            assert_eq!(
                opened_source.cancel_source_open(&format!("early-{index}")),
                Ok(SourceOpenCancelOutcome::Cancelled)
            );
        }
        assert_eq!(opened_source.begin_client_source_open("early-99"), Ok(None));

        for index in 0..(RECENT_CLIENT_SOURCE_OPEN_ATTEMPTS * 3) {
            let attempt = format!("terminal-{index}");
            opened_source
                .begin_client_source_open(&attempt)
                .expect("client source open")
                .expect("registered client source open");
            opened_source
                .finish_client_source_open(&attempt)
                .expect("client source open finish");
        }
        let current_request = opened_source
            .begin_client_source_open("current")
            .expect("current source open")
            .expect("registered current source open");
        assert_eq!(
            opened_source.cancel_source_open("terminal-47"),
            Ok(SourceOpenCancelOutcome::Cancelled)
        );

        let state = opened_source.lock_state().expect("source state");
        assert_eq!(
            state.recent_client_open_attempts.len(),
            RECENT_CLIENT_SOURCE_OPEN_ATTEMPTS
        );
        assert!(state.cancelled_client_open_before_registration.is_none());
        assert_eq!(state.open_request, current_request);
        assert_eq!(
            state
                .client_open_attempt
                .as_ref()
                .map(|attempt| attempt.id.as_str()),
            Some("current")
        );
    }

    #[test]
    fn schema_pages_distinguish_top_level_completion_from_nested_truncation() {
        let nested_children = (0..300)
            .map(|index| SchemaField {
                name: format!("nested_{index}"),
                physical_type: "INT64".into(),
                logical_type: None,
                children: Vec::new(),
            })
            .collect::<Vec<_>>();
        let opened_source = OpenedSource::default();
        let opened = opened_source
            .install(
                None,
                PathBuf::from("nested-schema.parquet"),
                SourceSummary {
                    display_name: "nested-schema.parquet".into(),
                    size_bytes: 8,
                    row_count: 0,
                    row_group_count: 0,
                    column_count: 301,
                    schema: vec![
                        SchemaField {
                            name: "prefix".into(),
                            physical_type: "INT64".into(),
                            logical_type: None,
                            children: Vec::new(),
                        },
                        SchemaField {
                            name: "wrapper".into(),
                            physical_type: "GROUP".into(),
                            logical_type: None,
                            children: nested_children,
                        },
                    ],
                    schema_node_count: 302,
                    schema_is_truncated: true,
                    strings_truncated: false,
                },
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("source is accepted");
        let session = opened_source
            .lock_state()
            .expect("source state")
            .session(opened.generation)
            .expect("source session");

        let top_level = source_schema_page(&session, 2, 256).expect("top-level page");
        assert_eq!(top_level.total_count, 2);
        assert!(top_level.columns.is_empty());
        let first = source_schema_node_page(&session, None, 256).expect("first DFS page");
        let second =
            source_schema_node_page(&session, first.next_cursor, 256).expect("continued DFS page");
        assert_eq!(first.nodes.len(), 256);
        assert_eq!(second.nodes.len(), 46);
        assert_eq!(second.nodes.last().expect("last node").path, [1, 299]);
        assert!(second.next_cursor.is_none());
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
    fn a_second_source_reads_alongside_the_first_until_it_is_closed() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        let second = open_test_source(&opened_source, "second.parquet");
        assert!(second.generation > first.generation);

        {
            let state = opened_source.state.lock().expect("opened source state");
            for generation in [first.generation, second.generation] {
                let session = state.session(generation).expect("opened session");
                assert_eq!(
                    fetch_opened_source_window(&session, 0, 0, 1, &[]),
                    Err(DataWindowCommandError::Engine(DataWindowError::Unsupported))
                );
            }
        }

        assert!(
            opened_source
                .close(first.generation)
                .expect("opened source state")
        );
        let state = opened_source.state.lock().expect("opened source state");
        assert_eq!(
            missing_data_window_session(&state),
            DataWindowCommandError::Session(DataWindowSessionError::SourceChanged)
        );
    }

    #[test]
    fn opening_a_source_puts_it_in_front_of_the_most_recently_used_order() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        let second = open_test_source(&opened_source, "second.parquet");
        let third = open_test_source(&opened_source, "third.parquet");

        assert_eq!(
            open_generations(&opened_source),
            [third.generation, second.generation, first.generation]
        );

        assert!(
            opened_source
                .state
                .lock()
                .expect("opened source state")
                .activate(first.generation)
        );
        assert_eq!(
            open_generations(&opened_source),
            [first.generation, third.generation, second.generation]
        );

        assert!(
            !opened_source
                .state
                .lock()
                .expect("opened source state")
                .activate(first.generation + 100)
        );
    }

    #[test]
    fn reopening_an_open_path_activates_its_session_instead_of_a_second_one() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        open_test_source(&opened_source, "second.parquet");

        let reopened = open_test_source(&opened_source, "first.parquet");

        assert_eq!(reopened.generation, first.generation);
        assert_eq!(reopened.summary, first.summary);
        assert_eq!(
            opened_source.open_paths().expect("opened source state"),
            [
                PathBuf::from("first.parquet"),
                PathBuf::from("second.parquet")
            ]
        );
    }

    #[test]
    fn closing_the_active_source_activates_the_next_most_recently_used_one() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        let second = open_test_source(&opened_source, "second.parquet");
        let third = open_test_source(&opened_source, "third.parquet");

        assert!(
            opened_source
                .close(third.generation)
                .expect("opened source state")
        );

        assert_eq!(
            open_generations(&opened_source),
            [second.generation, first.generation]
        );
        assert!(
            !opened_source
                .close(third.generation)
                .expect("opened source state")
        );
    }

    #[test]
    fn closing_a_source_interrupts_only_the_jobs_it_owns() {
        let opened_source = OpenedSource::default();
        let closed = open_test_source(&opened_source, "closed.parquet");
        let kept = open_test_source(&opened_source, "kept.parquet");
        let closed_view = register_test_view_job(&opened_source, closed.generation);
        let kept_view = register_test_view_job(&opened_source, kept.generation);
        let closed_suggestions = register_test_suggestion_job(&opened_source, closed.generation);
        let kept_suggestions = register_test_suggestion_job(&opened_source, kept.generation);
        let closed_statistics = register_test_statistics_job(&opened_source, closed.generation);
        let kept_statistics = register_test_statistics_job(&opened_source, kept.generation);

        assert!(
            opened_source
                .close(closed.generation)
                .expect("opened source state")
        );

        assert!(closed_view.is_cancelled());
        assert!(closed_suggestions.is_cancelled());
        assert!(closed_statistics.cancelled.load(Ordering::Acquire));
        assert!(!kept_view.is_cancelled());
        assert!(!kept_suggestions.is_cancelled());
        assert!(!kept_statistics.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn opening_another_source_leaves_running_jobs_alone() {
        let opened_source = OpenedSource::default();
        let first = open_test_source(&opened_source, "first.parquet");
        let view = register_test_view_job(&opened_source, first.generation);
        let suggestions = register_test_suggestion_job(&opened_source, first.generation);
        let statistics = register_test_statistics_job(&opened_source, first.generation);

        open_test_source(&opened_source, "second.parquet");

        assert!(!view.is_cancelled());
        assert!(!suggestions.is_cancelled());
        assert!(!statistics.cancelled.load(Ordering::Acquire));
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
                    column_count: 2,
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
                    schema_node_count: 2,
                    schema_is_truncated: false,
                    strings_truncated: false,
                },
                SourceOpenIntent::Explicit,
            )
            .expect("source state")
            .expect("source is accepted");
        let state = opened_source.state.lock().expect("opened source state");
        let session = state.session(opened.generation).expect("opened session");

        assert_eq!(
            fetch_opened_source_window(&session, 0, 0, 1, &[]),
            Err(DataWindowCommandError::Engine(DataWindowError::Unsupported))
        );
        assert_eq!(
            fetch_opened_source_window(&session, 0, 0, 1, &[1]),
            Err(DataWindowCommandError::Engine(DataWindowError::NotFound))
        );
    }

    #[test]
    fn reuses_one_text_suggestion_reader_per_open_source() {
        let opened_source = OpenedSource::default();
        let source = open_test_source(&opened_source, "source.parquet");
        let reader = |generation| {
            let session = opened_source
                .state
                .lock()
                .expect("source state")
                .session(generation)
                .expect("opened session");
            session
                .lock_state()
                .expect("session state")
                .text_suggestion_reader(&session.path)
                .expect("suggestion reader")
        };

        let first = reader(source.generation);
        let second = reader(source.generation);
        assert!(Arc::ptr_eq(&first, &second));

        let other = open_test_source(&opened_source, "other.parquet");
        assert!(!Arc::ptr_eq(&first, &reader(other.generation)));
        assert!(Arc::ptr_eq(&first, &reader(source.generation)));
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
                view_revision: 2,
                interrupt: Arc::clone(&current),
            },
        )
        .expect("current revision");
        assert_eq!(
            register_data_view_job(
                &mut jobs,
                ActiveDataViewJob {
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
                view_revision: 3,
                interrupt: Arc::clone(&next),
            },
        )
        .expect("new revision");
        assert!(current.is_cancelled());
        assert!(!next.is_cancelled());
        assert_eq!(jobs.watermark, Some(3));
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
                view_revision: 3,
                interrupt: Arc::clone(&interrupt),
            },
        )
        .expect("initial revision");

        assert!(finish_data_view_job(&mut jobs, 3, &interrupt));

        assert_eq!(jobs.watermark, Some(3));
        assert!(jobs.active.is_none());
        for revision in [2, 3] {
            let late = DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[])
                .expect("late builder");
            let late = Arc::new(late.interrupt_handle());
            assert_eq!(
                register_data_view_job(
                    &mut jobs,
                    ActiveDataViewJob {
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
            let reader = TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"))
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
                suggestion_revision: 2,
                interrupt: Arc::clone(&current),
            },
        )
        .expect("current revision");
        assert_eq!(
            register_text_value_suggestion_job(
                &mut jobs,
                ActiveTextValueSuggestionJob {
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
                suggestion_revision: 3,
                interrupt: Arc::clone(&next),
            },
        )
        .expect("new revision");
        assert!(current.is_cancelled());
        assert!(!next.is_cancelled());
        assert_eq!(jobs.watermark, Some(3));
    }

    #[test]
    fn completed_text_suggestion_revision_keeps_the_monotonic_watermark() {
        let make_interrupt = || {
            let reader = TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"))
                .expect("suggestion reader");
            Arc::new(reader.interrupt_handle())
        };
        let interrupt = make_interrupt();
        let mut jobs = TextValueSuggestionJobsState::default();
        register_text_value_suggestion_job(
            &mut jobs,
            ActiveTextValueSuggestionJob {
                suggestion_revision: 3,
                interrupt: Arc::clone(&interrupt),
            },
        )
        .expect("initial revision");

        assert!(finish_text_value_suggestion_job(&mut jobs, 3, &interrupt));
        assert_eq!(jobs.watermark, Some(3));
        assert!(jobs.active.is_none());

        let late = make_interrupt();
        assert_eq!(
            register_text_value_suggestion_job(
                &mut jobs,
                ActiveTextValueSuggestionJob {
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
        let reader = TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"))
            .expect("suggestion reader");
        let late = Arc::new(reader.interrupt_handle());
        let mut jobs = TextValueSuggestionJobsState::default();

        assert!(cancel_text_value_suggestion_job(&mut jobs, 3).is_none());
        assert_eq!(
            register_text_value_suggestion_job(
                &mut jobs,
                ActiveTextValueSuggestionJob {
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
        let opened = open_test_source(&opened_source, "source.parquet");

        activate_direct_data_view(&opened_source, opened.generation, 5).expect("newer direct view");
        opened_source
            .state
            .lock()
            .expect("opened source state")
            .session(opened.generation)
            .expect("opened session")
            .lock_state()
            .expect("session state")
            .data_view_jobs
            .watermark = None;

        assert_eq!(
            activate_direct_data_view(&opened_source, opened.generation, 4),
            Err(DataWindowCommandError::Engine(DataWindowError::Cancelled))
        );
        let state = opened_source.state.lock().expect("opened source state");
        let session = state.session(opened.generation).expect("opened session");
        let session_state = session.lock_state().expect("session state");
        assert_eq!(session_state.view_revision, 5);
        assert!(session_state.view.is_none());
    }

    #[test]
    fn cancellation_watermark_covers_cancel_before_registration() {
        let mut jobs = DataViewJobsState::default();

        assert!(cancel_data_view_job(&mut jobs, 3).is_none());
        let late =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("late builder");
        let late = Arc::new(late.interrupt_handle());
        assert_eq!(
            register_data_view_job(
                &mut jobs,
                ActiveDataViewJob {
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
                view_revision: 4,
                interrupt: Arc::clone(&current),
            },
        )
        .expect("newer revision");
        cancel_data_view_job(&mut jobs, 4)
            .expect("active revision")
            .cancel();
        assert!(current.is_cancelled());
        assert!(jobs.active.is_none());
        assert_eq!(jobs.watermark, Some(4));
    }

    #[test]
    fn statistics_resolve_only_columns_from_the_matching_native_session() {
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".into(),
            size_bytes: 8,
            row_count: 1,
            row_group_count: 1,
            column_count: 1,
            schema: vec![SchemaField {
                name: "trusted_name".into(),
                physical_type: "INT64".into(),
                logical_type: None,
                children: Vec::new(),
            }],
            schema_node_count: 1,
            schema_is_truncated: false,
            strings_truncated: false,
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
        let session = state.session(opened.generation).expect("opened session");

        assert_eq!(
            statistics_request(&session, 0, true),
            Ok(ColumnStatisticsRequest::Scan {
                path: PathBuf::from("source.parquet"),
                column_name: "trusted_name".to_owned(),
            })
        );
        assert_eq!(
            statistics_request(&session, 1, true),
            Err(ColumnStatisticsCommandError::UnsupportedColumn)
        );
        assert!(state.session(opened.generation + 1).is_none());
    }

    #[test]
    fn statistics_cache_reuses_a_session_result_and_upgrades_min_max() {
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".into(),
            size_bytes: 8,
            row_count: 1,
            row_group_count: 1,
            column_count: 1,
            schema: vec![SchemaField {
                name: "label".into(),
                physical_type: "BYTE_ARRAY".into(),
                logical_type: Some("String".into()),
                children: Vec::new(),
            }],
            schema_node_count: 1,
            schema_is_truncated: false,
            strings_truncated: false,
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
        let state = opened_source.state.lock().expect("opened source state");
        let session = state.session(opened.generation).expect("opened session");
        let summary_statistics = ColumnStatistics {
            minimum: None,
            maximum: None,
            min_max_computed: false,
            null_share: 0.25,
            approximate_distinct_count: 31_300_000,
        };

        cache_statistics(&session, 0, summary_statistics.clone())
            .expect("summary statistics should be cached");
        assert_eq!(
            statistics_request(&session, 0, false),
            Ok(ColumnStatisticsRequest::Cached(summary_statistics))
        );
        assert!(matches!(
            statistics_request(&session, 0, true),
            Ok(ColumnStatisticsRequest::Scan { .. })
        ));

        let full_statistics = ColumnStatistics {
            minimum: Some("a".into()),
            maximum: Some("z".into()),
            min_max_computed: true,
            null_share: 0.25,
            approximate_distinct_count: 31_300_000,
        };
        cache_statistics(&session, 0, full_statistics.clone())
            .expect("full statistics should replace the summary");
        assert_eq!(
            statistics_request(&session, 0, true),
            Ok(ColumnStatisticsRequest::Cached(full_statistics))
        );

        drop(state);
        let second = opened_source
            .install(
                None,
                PathBuf::from("second.parquet"),
                summary,
                SourceOpenIntent::Explicit,
            )
            .expect("second source state")
            .expect("second source is accepted");
        assert!(
            opened_source
                .close(opened.generation)
                .expect("opened source state")
        );
        let state = opened_source.state.lock().expect("opened source state");
        assert!(state.session(opened.generation).is_none());
        let second_session = state.session(second.generation).expect("second session");
        assert!(matches!(
            statistics_request(&second_session, 0, false),
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

    #[test]
    fn open_sources_keep_their_frontend_wire_shape() {
        let entry = OpenedSourceEntry {
            generation: 3,
            name: "trips.parquet".to_owned(),
            directory: "~/Data/2026".to_owned(),
            path: "/home/analyst/Data/2026/trips.parquet".to_owned(),
            active: true,
        };

        assert_eq!(
            serde_json::to_value(entry).expect("open source JSON"),
            serde_json::json!({
                "generation": 3,
                "name": "trips.parquet",
                "directory": "~/Data/2026",
                "path": "/home/analyst/Data/2026/trips.parquet",
                "active": true,
            })
        );
    }

    fn test_summary(display_name: &str) -> SourceSummary {
        SourceSummary {
            display_name: display_name.to_owned(),
            size_bytes: 8,
            row_count: 1,
            row_group_count: 1,
            column_count: 0,
            schema: Vec::new(),
            schema_node_count: 0,
            schema_is_truncated: false,
            strings_truncated: false,
        }
    }

    pub(crate) fn open_test_source(opened_source: &OpenedSource, path: &str) -> OpenedSourceInfo {
        opened_source
            .install(
                None,
                PathBuf::from(path),
                test_summary(path),
                SourceOpenIntent::Explicit,
            )
            .expect("opened source state")
            .expect("explicit source is accepted")
    }

    fn open_generations(opened_source: &OpenedSource) -> Vec<u64> {
        opened_source
            .state
            .lock()
            .expect("opened source state")
            .sessions
            .iter()
            .map(|session| session.generation)
            .collect()
    }

    fn register_test_view_job(
        opened_source: &OpenedSource,
        generation: u64,
    ) -> Arc<DataViewInterruptHandle> {
        let builder =
            DataViewBuilder::new(PathBuf::from("view.parquet"), &[], &[]).expect("view builder");
        let interrupt = Arc::new(builder.interrupt_handle());
        let session = opened_source
            .state
            .lock()
            .expect("opened source state")
            .session(generation)
            .expect("opened session");
        register_data_view_job(
            &mut session.lock_state().expect("session state").data_view_jobs,
            ActiveDataViewJob {
                view_revision: 1,
                interrupt: Arc::clone(&interrupt),
            },
        )
        .expect("view job");
        interrupt
    }

    fn register_test_suggestion_job(
        opened_source: &OpenedSource,
        generation: u64,
    ) -> Arc<TextValueSuggestionsInterruptHandle> {
        let reader = TextValueSuggestionsReader::new(PathBuf::from("suggestions.parquet"))
            .expect("suggestion reader");
        let interrupt = Arc::new(reader.interrupt_handle());
        let session = opened_source
            .state
            .lock()
            .expect("opened source state")
            .session(generation)
            .expect("opened session");
        register_text_value_suggestion_job(
            &mut session
                .lock_state()
                .expect("session state")
                .text_suggestion_jobs,
            ActiveTextValueSuggestionJob {
                suggestion_revision: 1,
                interrupt: Arc::clone(&interrupt),
            },
        )
        .expect("suggestion job");
        interrupt
    }

    fn register_test_statistics_job(
        opened_source: &OpenedSource,
        generation: u64,
    ) -> Arc<ColumnStatisticsJob> {
        let reader =
            ColumnStatisticsReader::new(PathBuf::from("statistics.parquet")).expect("reader");
        let job = Arc::new(ColumnStatisticsJob {
            cancelled: AtomicBool::new(false),
            interrupt: reader.interrupt_handle(),
        });
        opened_source
            .state
            .lock()
            .expect("opened source state")
            .session(generation)
            .expect("opened session")
            .lock_state()
            .expect("session state")
            .statistics_job = Some(Arc::clone(&job));
        job
    }
}
