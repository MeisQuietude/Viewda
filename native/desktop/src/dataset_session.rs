//! Dataset descriptors and desktop session lifecycle.
//!
//! The module owns fixed folder and explicit-file membership, progressive
//! discovery and inspection, and the commands that expose dataset state. The
//! shared opened-source registry remains in the desktop adapter.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, BufReader, Read as _, Write as _},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

#[cfg(test)]
use std::sync::atomic::AtomicUsize;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};

use serde::{Deserialize, Serialize};
use tauri::{Emitter as _, Manager as _};
use tauri_plugin_dialog::DialogExt as _;
use viewda_data_engine::{
    DataWindowError, DatasetDiscovery, DatasetDiscoveryProgress, DatasetError,
    DatasetInspectionInterruptHandle, DatasetInspectionProgress, DatasetInspector,
    DatasetMemberPage, DatasetPartitionPage, DatasetSource, DatasetSummary,
    DatasetWindowInterruptHandle, DatasetWindowReader, SchemaField, SourceError, SourceSummary,
};

use crate::recents::{RecentSourcesStore, ResolvedRecentSource};

use crate::{
    ClientSourceOpenStatus, DataViewJobsState, DataWindowCommandError, DataWindowSessionError,
    OpenSourceError, OpenedSource, OpenedSourceInfo, OpenedSourceKind, OpenedSourceSession,
    OpenedSourceSessionState, OpenedSourceState, SessionLifecycle, SessionWindowReader,
    SourceOpenIntent, SourceOpenPublication, StructureJobs, TextValueSuggestionJobsState,
    bounded_wire_label, bounded_wire_schema_with_marker, recents,
};

pub(crate) fn open_dataset_descriptor_for_request(
    app: &tauri::AppHandle,
    descriptor: SourceDescriptor,
    request: u64,
) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    Ok(inspect_dataset_for_request(
        opened_source.inner(),
        descriptor,
        recents::state_path(app).ok().as_deref(),
        Some(DatasetNativeNotifier::Native(app.clone())),
        SourceOpenIntent::Explicit,
        SourceOpenPublication {
            request,
            client_attempt: None,
            reload_generation: None,
        },
        true,
    )?
    .map(publish_dataset_open))
}

pub(crate) fn open_explicit_files_for_request(
    app: &tauri::AppHandle,
    paths: Vec<PathBuf>,
    request: u64,
) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    let Some(descriptor) = SourceDescriptor::explicit_files_while(paths, || {
        opened_source
            .source_open_is_current(request)
            .unwrap_or(false)
    })?
    else {
        return Ok(None);
    };
    Ok(inspect_dataset_for_request(
        opened_source.inner(),
        descriptor,
        recents::state_path(app).ok().as_deref(),
        Some(DatasetNativeNotifier::Native(app.clone())),
        SourceOpenIntent::Explicit,
        SourceOpenPublication {
            request,
            client_attempt: None,
            reload_generation: None,
        },
        true,
    )?
    .map(publish_dataset_open))
}

pub(crate) struct DatasetInspectionInstall {
    pub(crate) preview: viewda_data_engine::DatasetPreview,
    pub(crate) reader: DatasetWindowReader,
    pub(crate) interrupt: DatasetInspectionInterruptHandle,
}

struct DatasetSessionInstall {
    state: DatasetSessionState,
    summary: SourceSummary,
    member_count: Option<u64>,
    ignored_file_count: Option<u64>,
}

pub(crate) struct DatasetRecentRegistration {
    store: RecentSourcesStore,
    path: PathBuf,
    recorded: AtomicBool,
}

#[derive(Clone)]
pub(crate) enum DatasetNativeNotifier {
    Native(tauri::AppHandle),
    #[cfg(test)]
    Counter(Arc<AtomicUsize>),
}

impl DatasetNativeNotifier {
    fn recent_sources_changed(&self) {
        match self {
            Self::Native(app) => {
                let _ = crate::recent_sources_changed(app);
            }
            #[cfg(test)]
            Self::Counter(count) => {
                count.fetch_add(1, Ordering::AcqRel);
            }
        }
    }

    fn dataset_status_changed(&self, generation: u64) {
        match self {
            Self::Native(app) => {
                let _ = app.emit(
                    "dataset-status-changed",
                    DatasetStatusChangedEvent { generation },
                );
            }
            #[cfg(test)]
            Self::Counter(count) => {
                count.fetch_add(1, Ordering::AcqRel);
            }
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasetStatusChangedEvent {
    generation: u64,
}

impl DatasetRecentRegistration {
    fn record_once(&self, descriptor: &SourceDescriptor) -> bool {
        if self
            .recorded
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        let recorded = match descriptor {
            SourceDescriptor::Folder(root) => self.store.record_path(&self.path, root),
            SourceDescriptor::ExplicitFiles { root, manifest } => {
                self.store
                    .record_explicit_files(&self.path, root, manifest.path())
            }
            SourceDescriptor::File(_) => return false,
        };
        match recorded {
            Ok(_) => true,
            Err(_) => {
                self.recorded.store(false, Ordering::Release);
                false
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    content = "source",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SourceDescriptor {
    File(PathBuf),
    Folder(PathBuf),
    ExplicitFiles {
        root: PathBuf,
        manifest: ExplicitFileManifest,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct ExplicitFileManifest(Arc<ExplicitFileManifestFile>);

impl ExplicitFileManifest {
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0.path
    }
}

#[derive(Debug)]
struct ExplicitFileManifestFile {
    path: PathBuf,
    cleanup: AtomicBool,
}

impl Drop for ExplicitFileManifestFile {
    fn drop(&mut self) {
        if self.cleanup.load(Ordering::Acquire) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl PartialEq for ExplicitFileManifest {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || files_equal(&self.0.path, &other.0.path).unwrap_or(false)
    }
}

impl Eq for ExplicitFileManifest {}

impl Serialize for ExplicitFileManifest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.path.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ExplicitFileManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let path = PathBuf::deserialize(deserializer)?;
        Ok(Self(Arc::new(ExplicitFileManifestFile {
            path,
            cleanup: AtomicBool::new(false),
        })))
    }
}

pub(crate) fn dataset_window_command_error(error: DatasetError) -> DataWindowCommandError {
    match error {
        DatasetError::Window { error } => error.into(),
        DatasetError::Cancelled => DataWindowError::Cancelled.into(),
        error => DataWindowCommandError::Dataset(error),
    }
}

pub(crate) fn dataset_query_reader(
    dataset: &DatasetSessionState,
) -> Result<Arc<Mutex<DatasetWindowReader>>, DataWindowCommandError> {
    match &dataset.phase {
        DatasetSessionPhase::Discovering(discovering) => discovering
            .sample_reader
            .as_ref()
            .map(Arc::clone)
            .ok_or(DataWindowSessionError::NotReady.into()),
        DatasetSessionPhase::Inspecting(inspecting) => Ok(Arc::clone(&inspecting.sample_reader)),
        DatasetSessionPhase::Ready { reader, .. } => Ok(Arc::clone(reader)),
        DatasetSessionPhase::Failed(error) => Err(dataset_window_command_error(error.clone())),
    }
}

pub(crate) fn session_query_facts<'a>(
    session: &'a OpenedSourceSession,
    state: &'a OpenedSourceSessionState,
) -> Result<(&'a [SchemaField], usize, u64), DataWindowCommandError> {
    match &state.reader {
        SessionWindowReader::File(_) => Ok((
            &session.schema,
            session.summary.schema_node_count,
            session.summary.row_count,
        )),
        SessionWindowReader::Dataset(dataset) => {
            match &dataset.phase {
                DatasetSessionPhase::Discovering(discovering) => {
                    let summary = discovering.sample_summary.as_ref().ok_or(
                        DataWindowCommandError::Session(DataWindowSessionError::NotReady),
                    )?;
                    Ok((
                        &summary.schema,
                        summary.schema.iter().map(schema_node_count).sum(),
                        summary.row_count,
                    ))
                }
                DatasetSessionPhase::Ready { summary, .. } => Ok((
                    &summary.schema,
                    summary.schema.iter().map(schema_node_count).sum(),
                    summary.row_count,
                )),
                DatasetSessionPhase::Inspecting(inspecting) => Ok((
                    &inspecting.sample_summary.schema,
                    inspecting
                        .sample_summary
                        .schema
                        .iter()
                        .map(schema_node_count)
                        .sum(),
                    inspecting.sample_summary.row_count,
                )),
                DatasetSessionPhase::Failed(error) => {
                    Err(dataset_window_command_error(error.clone()))
                }
            }
        }
    }
}

pub(crate) struct DatasetSessionState {
    pub(crate) source: Option<DatasetSource>,
    pub(crate) preview: Option<Arc<Vec<u8>>>,
    pub(crate) phase: DatasetSessionPhase,
}

pub(crate) enum DatasetSessionPhase {
    Discovering(DatasetDiscoveringSession),
    Inspecting(Box<DatasetInspectingSession>),
    Ready {
        summary: DatasetSummary,
        reader: Arc<Mutex<DatasetWindowReader>>,
        interrupt: DatasetWindowInterruptHandle,
    },
    Failed(DatasetError),
}

impl OpenedSourceSessionState {
    fn reset_query_state(&mut self) {
        self.cancel_jobs();
        self.view = None;
        self.data_view_jobs = DataViewJobsState::default();
        self.text_suggestion_reader = None;
        self.text_suggestion_jobs = TextValueSuggestionJobsState::default();
        self.statistics_cache.clear();
        self.statistics_job = None;
        self.statistics_construction = None;
    }
}

pub(crate) struct DatasetDiscoveringSession {
    pub(crate) progress: DatasetDiscoveryProgress,
    pub(crate) sample_summary: Option<DatasetSummary>,
    pub(crate) sample_reader: Option<Arc<Mutex<DatasetWindowReader>>>,
    pub(crate) sample_reader_interrupt: Option<DatasetWindowInterruptHandle>,
}

pub(crate) struct DatasetInspectingSession {
    pub(crate) progress: DatasetInspectionProgress,
    pub(crate) sample_summary: DatasetSummary,
    pub(crate) interrupt: DatasetInspectionInterruptHandle,
    pub(crate) sample_reader: Arc<Mutex<DatasetWindowReader>>,
    pub(crate) sample_reader_interrupt: DatasetWindowInterruptHandle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DatasetSessionStatus {
    Discovering {
        progress: DatasetDiscoveryStatus,
        sample_summary: Option<DatasetSummaryStatus>,
    },
    Inspecting {
        progress: DatasetInspectionStatus,
        sample_summary: DatasetSummaryStatus,
    },
    Ready {
        summary: DatasetSummaryStatus,
    },
    Failed {
        error: DatasetError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatasetInspectionStatus {
    completed_member_count: u64,
    total_member_count: u64,
    row_count: u64,
    row_group_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatasetDiscoveryStatus {
    scanned_entry_count: u64,
    discovered_member_count: u64,
    ignored_file_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatasetSummaryStatus {
    display_name: String,
    member_count: u64,
    ignored_file_count: u64,
    size_bytes: u64,
    row_count: u64,
    row_group_count: u64,
    column_count: usize,
    schema: Vec<SchemaField>,
    schema_node_count: usize,
    schema_is_truncated: bool,
    strings_truncated: bool,
    schema_drift_member_count: u64,
    partition_column_indices: Vec<u32>,
    provenance_column_index: u32,
}

impl OpenedSourceSession {
    fn record_dataset_recent(&self) {
        if self
            .dataset_recent_registration
            .as_ref()
            .is_some_and(|registration| registration.record_once(&self.descriptor))
            && let Some(notifier) = &self.dataset_native_notifier
        {
            notifier.recent_sources_changed();
        }
    }

    fn notify_dataset_status_changed(&self) {
        if let Some(notifier) = &self.dataset_native_notifier {
            notifier.dataset_status_changed(self.generation);
        }
    }

    fn dataset_status(&self) -> Result<DatasetSessionStatus, DataWindowError> {
        let state = self.lock_state()?;
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            return Err(DataWindowError::Unsupported);
        };
        match &dataset.phase {
            DatasetSessionPhase::Discovering(discovering) => {
                Ok(DatasetSessionStatus::Discovering {
                    progress: DatasetDiscoveryStatus::from(&discovering.progress),
                    sample_summary: discovering
                        .sample_summary
                        .as_ref()
                        .map(DatasetSummaryStatus::from),
                })
            }
            DatasetSessionPhase::Inspecting(inspecting) => Ok(DatasetSessionStatus::Inspecting {
                progress: DatasetInspectionStatus::from(&inspecting.progress),
                sample_summary: DatasetSummaryStatus::from(&inspecting.sample_summary),
            }),
            DatasetSessionPhase::Ready { summary, .. } => Ok(DatasetSessionStatus::Ready {
                summary: DatasetSummaryStatus::from(summary),
            }),
            DatasetSessionPhase::Failed(error) => Ok(DatasetSessionStatus::Failed {
                error: error.clone(),
            }),
        }
    }
}

impl From<&DatasetInspectionProgress> for DatasetInspectionStatus {
    fn from(progress: &DatasetInspectionProgress) -> Self {
        Self {
            completed_member_count: progress.completed_member_count,
            total_member_count: progress.total_member_count,
            row_count: progress.row_count,
            row_group_count: progress.row_group_count,
        }
    }
}

impl From<&DatasetDiscoveryProgress> for DatasetDiscoveryStatus {
    fn from(progress: &DatasetDiscoveryProgress) -> Self {
        Self {
            scanned_entry_count: progress.scanned_entry_count,
            discovered_member_count: progress.discovered_member_count,
            ignored_file_count: progress.ignored_file_count,
        }
    }
}

impl From<&DatasetSummary> for DatasetSummaryStatus {
    fn from(summary: &DatasetSummary) -> Self {
        let schema_node_count = summary.schema.iter().map(schema_node_count).sum();
        let (schema, schema_strings_truncated) = bounded_wire_schema_with_marker(&summary.schema);
        let (display_name, display_name_truncated) = bounded_wire_label(&summary.display_name);
        let schema_is_truncated = schema_node_count > schema.len();
        Self {
            display_name,
            member_count: summary.member_count,
            ignored_file_count: summary.ignored_file_count,
            size_bytes: summary.size_bytes,
            row_count: summary.row_count,
            row_group_count: summary.row_group_count,
            column_count: summary.schema.iter().map(schema_leaf_count).sum(),
            schema,
            schema_node_count,
            schema_is_truncated,
            strings_truncated: schema_strings_truncated || display_name_truncated,
            schema_drift_member_count: summary.schema_drift_member_count,
            partition_column_indices: summary.partition_column_indices.clone(),
            provenance_column_index: summary.provenance_column_index,
        }
    }
}

impl SourceDescriptor {
    pub(crate) fn from_recent(source: ResolvedRecentSource) -> Result<Self, SourceError> {
        Ok(match source {
            ResolvedRecentSource::Path(path) if path.is_dir() => Self::Folder(path),
            ResolvedRecentSource::Path(path) => Self::File(path),
            ResolvedRecentSource::ExplicitFiles { root, manifest } => {
                let manifest = ExplicitFileManifest::session_copy(&manifest)?;
                manifest.validate()?;
                Self::ExplicitFiles { root, manifest }
            }
        })
    }

    fn canonicalized_dataset(self) -> Result<Self, DatasetError> {
        match self {
            Self::Folder(root) => std::fs::canonicalize(root)
                .map(Self::Folder)
                .map_err(|error| match error.kind() {
                    io::ErrorKind::NotFound => DatasetError::NotFound,
                    io::ErrorKind::PermissionDenied => DatasetError::PermissionDenied,
                    _ => DatasetError::Unsupported,
                }),
            descriptor => Ok(descriptor),
        }
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        match self {
            Self::File(path) | Self::Folder(path) => path,
            Self::ExplicitFiles { root, .. } => root,
        }
    }

    pub(crate) fn kind(&self) -> OpenedSourceKind {
        match self {
            Self::File(_) => OpenedSourceKind::File,
            Self::Folder(_) => OpenedSourceKind::FolderDataset,
            Self::ExplicitFiles { .. } => OpenedSourceKind::FileDataset,
        }
    }

    #[cfg(test)]
    fn reopen_dataset_while(
        &self,
        keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetSource, DatasetError> {
        match self {
            Self::Folder(root) => DatasetSource::open_folder_cancellable(root, keep_going),
            Self::ExplicitFiles { root, manifest } => {
                DatasetSource::open_file_selection_cancellable(root, manifest.paths()?, keep_going)
            }
            Self::File(_) => Err(DatasetError::Unsupported),
        }
    }

    fn begin_dataset_discovery(&self) -> Result<DatasetDiscovery<'static>, DatasetError> {
        match self {
            Self::Folder(root) => DatasetSource::begin_folder(root),
            Self::ExplicitFiles { root, manifest } => {
                DatasetSource::begin_file_selection(root, manifest.paths()?)
            }
            Self::File(_) => Err(DatasetError::Unsupported),
        }
    }

    #[cfg(test)]
    pub(crate) fn reopen_dataset(&self) -> Result<DatasetSource, DatasetError> {
        self.reopen_dataset_while(|| true)
    }

    #[cfg(test)]
    pub(crate) fn explicit_files(paths: Vec<PathBuf>) -> Result<Self, SourceError> {
        Self::explicit_files_while(paths, || true)?.ok_or(SourceError::Unsupported)
    }

    pub(crate) fn explicit_files_while(
        paths: Vec<PathBuf>,
        keep_going: impl FnMut() -> bool,
    ) -> Result<Option<Self>, SourceError> {
        let mut paths = paths;
        paths.sort();
        let root = common_parent(&paths).unwrap_or_default();
        let Some(manifest) = ExplicitFileManifest::new_while(&paths, keep_going)? else {
            return Ok(None);
        };
        Ok(Some(Self::ExplicitFiles { root, manifest }))
    }

    pub(crate) fn restart_copy(&self, directory: &std::path::Path) -> Result<Self, SourceError> {
        match self {
            Self::ExplicitFiles { root, manifest } => Ok(Self::ExplicitFiles {
                root: root.clone(),
                manifest: manifest.restart_copy(directory)?,
            }),
            descriptor => Ok(descriptor.clone()),
        }
    }

    pub(crate) fn adopt_restart_manifest(
        &self,
        directory: &std::path::Path,
    ) -> Result<Self, SourceError> {
        match self {
            Self::ExplicitFiles { root, manifest } => Ok(Self::ExplicitFiles {
                root: root.clone(),
                manifest: manifest.adopt_restart_copy(directory)?,
            }),
            descriptor => Ok(descriptor.clone()),
        }
    }
}

impl ExplicitFileManifest {
    fn session_copy(source: &std::path::Path) -> Result<Self, SourceError> {
        Self::copy_into(source, &std::env::temp_dir(), "selection")
    }

    fn new_while(
        paths: &[PathBuf],
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Option<Self>, SourceError> {
        let (mut file, path) = create_manifest_file("selection")?;
        let result = (|| {
            for path in paths {
                if !keep_going() {
                    return Ok(None);
                }
                let path = path.to_str().ok_or(SourceError::Unsupported)?.as_bytes();
                let length = u32::try_from(path.len()).map_err(|_| SourceError::Unsupported)?;
                file.write_all(&length.to_le_bytes())
                    .and_then(|_| file.write_all(path))
                    .map_err(|_| SourceError::Unsupported)?;
            }
            file.flush()
                .map(|()| Some(()))
                .map_err(|_| SourceError::Unsupported)
        })();
        match result {
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            Ok(None) => {
                drop(file);
                let _ = fs::remove_file(&path);
                return Ok(None);
            }
            Ok(Some(())) => {}
        }
        Ok(Some(Self(Arc::new(ExplicitFileManifestFile {
            path,
            cleanup: AtomicBool::new(true),
        }))))
    }

    fn paths(&self) -> Result<ExplicitFileManifestPaths, DatasetError> {
        let file = File::open(&self.0.path).map_err(|_| DatasetError::NotFound)?;
        Ok(ExplicitFileManifestPaths {
            reader: BufReader::new(file),
            finished: false,
        })
    }

    fn validate(&self) -> Result<(), SourceError> {
        for path in self.paths().map_err(|_| SourceError::Unsupported)? {
            path.map_err(|_| SourceError::Unsupported)?;
        }
        Ok(())
    }

    fn restart_copy(&self, directory: &std::path::Path) -> Result<Self, SourceError> {
        Self::copy_into(&self.0.path, directory, "selection-restart")
    }

    fn copy_into(
        source_path: &std::path::Path,
        directory: &std::path::Path,
        label: &str,
    ) -> Result<Self, SourceError> {
        let mut source = File::open(source_path).map_err(|_| SourceError::NotFound)?;
        let (mut target, path) = create_manifest_file_in(directory, label)?;
        let result = io::copy(&mut source, &mut target)
            .and_then(|_| target.flush())
            .map_err(|_| SourceError::Unsupported);
        if let Err(error) = result {
            drop(target);
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self(Arc::new(ExplicitFileManifestFile {
            path,
            cleanup: AtomicBool::new(true),
        })))
    }

    fn adopt_restart_copy(&self, directory: &std::path::Path) -> Result<Self, SourceError> {
        let path = &self.0.path;
        let valid_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with("viewda-selection-restart-") && name.ends_with(".manifest")
            });
        if path.parent() != Some(directory) || !valid_name {
            return Err(SourceError::Unsupported);
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| SourceError::NotFound)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(SourceError::Unsupported);
        }
        Ok(Self(Arc::new(ExplicitFileManifestFile {
            path: path.to_path_buf(),
            cleanup: AtomicBool::new(true),
        })))
    }

    pub(crate) fn preserve_restart_copy(&self) {
        self.0.cleanup.store(false, Ordering::Release);
    }
}

fn create_manifest_file(label: &str) -> Result<(File, PathBuf), SourceError> {
    create_manifest_file_in(&std::env::temp_dir(), label)
}

fn create_manifest_file_in(
    directory: &std::path::Path,
    label: &str,
) -> Result<(File, PathBuf), SourceError> {
    let mut directory_builder = fs::DirBuilder::new();
    directory_builder.recursive(true);
    #[cfg(unix)]
    directory_builder.mode(0o700);
    directory_builder
        .create(directory)
        .map_err(|_| SourceError::Unsupported)?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1_024 {
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(
            "viewda-{label}-{}-{sequence}.manifest",
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SourceError::Unsupported),
        }
    }
    Err(SourceError::Unsupported)
}

struct ExplicitFileManifestPaths {
    reader: BufReader<File>,
    finished: bool,
}

impl Iterator for ExplicitFileManifestPaths {
    type Item = Result<PathBuf, DatasetError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        let mut length = [0_u8; 4];
        match self.reader.read(&mut length[..1]) {
            Ok(0) => {
                self.finished = true;
                return None;
            }
            Ok(1) => {}
            Ok(_) => unreachable!("one-byte manifest read"),
            Err(_) => return Some(Err(DatasetError::Unsupported)),
        }
        if self.reader.read_exact(&mut length[1..]).is_err() {
            self.finished = true;
            return Some(Err(DatasetError::Unsupported));
        }
        let length = u32::from_le_bytes(length) as usize;
        if length > 1024 * 1024 {
            self.finished = true;
            return Some(Err(DatasetError::Unsupported));
        }
        let mut path = Vec::new();
        if path.try_reserve_exact(length).is_err() {
            self.finished = true;
            return Some(Err(DatasetError::Unsupported));
        }
        path.resize(length, 0);
        if self.reader.read_exact(&mut path).is_err() {
            self.finished = true;
            return Some(Err(DatasetError::Unsupported));
        }
        Some(
            String::from_utf8(path)
                .map(PathBuf::from)
                .map_err(|_| DatasetError::Unsupported),
        )
    }
}

fn files_equal(left: &std::path::Path, right: &std::path::Path) -> io::Result<bool> {
    let mut left = BufReader::new(File::open(left)?);
    let mut right = BufReader::new(File::open(right)?);
    let mut left_buffer = [0_u8; 8192];
    let mut right_buffer = [0_u8; 8192];
    loop {
        let left_read = left.read(&mut left_buffer)?;
        let right_read = right.read(&mut right_buffer)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn common_parent(paths: &[PathBuf]) -> Option<PathBuf> {
    let first = paths.first()?.parent()?;
    let mut root = first.to_path_buf();
    while paths.iter().any(|path| {
        !path
            .parent()
            .is_some_and(|parent| parent.starts_with(&root))
    }) {
        if !root.pop() {
            return Some(root);
        }
    }
    while root
        .file_name()
        .and_then(|component| component.to_str())
        .is_some_and(|component| {
            component
                .split_once('=')
                .is_some_and(|(key, _)| !key.is_empty())
        })
    {
        if !root.pop() {
            break;
        }
    }
    Some(root)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum DatasetCommandError {
    Session(DatasetSessionCommandError),
    Dataset(DatasetError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub(crate) enum DatasetSessionCommandError {
    NoSourceOpen,
    SourceChanged,
    NotDataset,
    NotReady,
}

impl From<DatasetError> for DatasetCommandError {
    fn from(error: DatasetError) -> Self {
        Self::Dataset(error)
    }
}

pub(crate) fn missing_data_window_session(state: &OpenedSourceState) -> DataWindowCommandError {
    DataWindowCommandError::Session(state.missing_session(
        DataWindowSessionError::NoSourceOpen,
        DataWindowSessionError::SourceChanged,
    ))
}

fn dataset_session(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<Arc<OpenedSourceSession>, DatasetCommandError> {
    let state = opened_source
        .state
        .lock()
        .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
    let session = state.session(generation).ok_or_else(|| {
        DatasetCommandError::Session(state.missing_session(
            DatasetSessionCommandError::NoSourceOpen,
            DatasetSessionCommandError::SourceChanged,
        ))
    })?;
    if session.kind == OpenedSourceKind::File {
        return Err(DatasetCommandError::Session(
            DatasetSessionCommandError::NotDataset,
        ));
    }
    Ok(session)
}

#[cfg(test)]
fn dataset_progress_source_summary(
    source: &DatasetSource,
    progress: &DatasetInspectionProgress,
) -> Result<SourceSummary, SourceError> {
    let (size_bytes, schema) = match &progress.summary {
        Some(summary) => (summary.size_bytes, summary.schema.clone()),
        None => (0, progress.schema.clone().unwrap_or_default()),
    };
    let row_group_count =
        usize::try_from(progress.row_group_count).map_err(|_| SourceError::Unsupported)?;
    let schema_node_count = schema.iter().map(schema_node_count).sum();
    let column_count = schema.iter().map(schema_leaf_count).sum();
    let (bounded_schema, schema_strings_truncated) = bounded_wire_schema_with_marker(&schema);
    let (display_name, display_name_truncated) = bounded_wire_label(source.display_name());
    let schema_is_truncated = schema_node_count > bounded_schema.len();
    Ok(SourceSummary {
        display_name,
        size_bytes,
        row_count: progress.row_count,
        row_group_count,
        column_count,
        schema: bounded_schema,
        schema_node_count,
        schema_is_truncated,
        strings_truncated: schema_strings_truncated || display_name_truncated,
    })
}

fn completed_dataset_source_summary(
    summary: &DatasetSummary,
) -> Result<SourceSummary, SourceError> {
    let row_group_count =
        usize::try_from(summary.row_group_count).map_err(|_| SourceError::Unsupported)?;
    let schema_node_count = summary.schema.iter().map(schema_node_count).sum();
    let column_count = summary.schema.iter().map(schema_leaf_count).sum();
    let (schema, schema_strings_truncated) = bounded_wire_schema_with_marker(&summary.schema);
    let (display_name, display_name_truncated) = bounded_wire_label(&summary.display_name);
    Ok(SourceSummary {
        display_name,
        size_bytes: summary.size_bytes,
        row_count: summary.row_count,
        row_group_count,
        column_count,
        schema_is_truncated: schema_node_count > schema.len(),
        schema,
        schema_node_count,
        strings_truncated: schema_strings_truncated || display_name_truncated,
    })
}

fn discovering_dataset_source_summary(descriptor: &SourceDescriptor) -> SourceSummary {
    let display_name = descriptor
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map_or_else(|| "Dataset/".to_owned(), |name| format!("{name}/"));
    SourceSummary {
        display_name,
        size_bytes: 0,
        row_count: 0,
        row_group_count: 0,
        column_count: 0,
        schema: Vec::new(),
        schema_node_count: 0,
        schema_is_truncated: false,
        strings_truncated: false,
    }
}

fn schema_node_count(field: &SchemaField) -> usize {
    1usize.saturating_add(field.children.iter().map(schema_node_count).sum())
}

fn schema_leaf_count(field: &SchemaField) -> usize {
    if field.children.is_empty() {
        1
    } else {
        field.children.iter().map(schema_leaf_count).sum()
    }
}

impl OpenedSource {
    fn activate_dataset_descriptor(
        &self,
        descriptor: &SourceDescriptor,
        intent: SourceOpenIntent,
        publication: SourceOpenPublication<'_>,
    ) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
        let candidates = {
            let state = self.lock_state()?;
            if publication.request != state.open_request {
                return Ok(None);
            }
            state.sessions.clone()
        };
        let Some(generation) = candidates
            .iter()
            .find(|session| session.descriptor == *descriptor)
            .map(|session| session.generation)
        else {
            return Ok(None);
        };
        let session = {
            let mut state = self.lock_state()?;
            if publication.request != state.open_request {
                return Ok(None);
            }
            if let Some(client_attempt) = publication.client_attempt
                && !state.client_open_attempt.as_ref().is_some_and(|attempt| {
                    attempt.id == client_attempt
                        && attempt.open_request == publication.request
                        && matches!(
                            attempt.status,
                            ClientSourceOpenStatus::Pending | ClientSourceOpenStatus::Published
                        )
                })
            {
                return Ok(None);
            }
            if intent == SourceOpenIntent::Restore && state.blocks_restore {
                return Ok(None);
            }
            let Some(index) = state
                .sessions
                .iter()
                .position(|session| session.generation == generation)
            else {
                return Ok(None);
            };
            if intent == SourceOpenIntent::Explicit {
                state.blocks_restore = true;
            }
            let session = Arc::clone(&state.sessions[index]);
            state.activate(session.generation);
            if let Some(attempt) = publication.client_attempt
                && let Some(client_open) = state
                    .client_open_attempt
                    .as_mut()
                    .filter(|client_open| client_open.id == attempt)
            {
                client_open.status = ClientSourceOpenStatus::Published;
            }
            session
        };
        let state = session.lock_state().map_err(|_| SourceError::Unsupported)?;
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            return Ok(None);
        };
        let summary = match &dataset.phase {
            DatasetSessionPhase::Ready { summary, .. } => {
                completed_dataset_source_summary(summary)?
            }
            DatasetSessionPhase::Discovering(_)
            | DatasetSessionPhase::Inspecting(_)
            | DatasetSessionPhase::Failed(_) => session.summary.clone(),
        };
        let dataset_facts = match &dataset.phase {
            DatasetSessionPhase::Discovering(_) => None,
            _ => dataset
                .source
                .as_ref()
                .map(|source| (source.member_count(), source.ignored_file_count())),
        };
        Ok(Some(OpenedSourceInfo {
            generation: session.generation,
            kind: session.kind,
            dataset_member_count: dataset_facts.map(|facts| facts.0),
            dataset_ignored_file_count: dataset_facts.map(|facts| facts.1),
            summary,
        }))
    }
}

impl OpenedSource {
    #[cfg(test)]
    pub(crate) fn install_dataset(
        &self,
        descriptor: SourceDescriptor,
        source: DatasetSource,
        inspection: DatasetInspectionInstall,
        native_notifier: Option<DatasetNativeNotifier>,
        intent: SourceOpenIntent,
        publication: SourceOpenPublication<'_>,
    ) -> Result<Option<(OpenedSourceInfo, Arc<OpenedSourceSession>)>, OpenSourceError> {
        let summary = dataset_progress_source_summary(&source, &inspection.preview.progress)?;
        let preview_summary = inspection.reader.summary().clone();
        let reader_interrupt = inspection.reader.interrupt_handle();
        let preview_reader = Arc::new(Mutex::new(inspection.reader));
        let member_count = source.member_count();
        let ignored_file_count = source.ignored_file_count();
        self.install_dataset_state(
            None,
            native_notifier,
            descriptor,
            DatasetSessionInstall {
                state: DatasetSessionState {
                    source: Some(source),
                    preview: Some(Arc::new(inspection.preview.arrow_ipc)),
                    phase: DatasetSessionPhase::Inspecting(Box::new(DatasetInspectingSession {
                        progress: inspection.preview.progress,
                        sample_summary: preview_summary,
                        interrupt: inspection.interrupt,
                        sample_reader: preview_reader,
                        sample_reader_interrupt: reader_interrupt,
                    })),
                },
                summary,
                member_count: Some(member_count),
                ignored_file_count: Some(ignored_file_count),
            },
            intent,
            publication,
        )
    }

    fn install_discovering_dataset(
        &self,
        recent_sources_path: Option<&std::path::Path>,
        native_notifier: Option<DatasetNativeNotifier>,
        descriptor: SourceDescriptor,
        progress: DatasetDiscoveryProgress,
        intent: SourceOpenIntent,
        publication: SourceOpenPublication<'_>,
    ) -> Result<Option<(OpenedSourceInfo, Arc<OpenedSourceSession>)>, OpenSourceError> {
        let summary = discovering_dataset_source_summary(&descriptor);
        self.install_dataset_state(
            recent_sources_path,
            native_notifier,
            descriptor,
            DatasetSessionInstall {
                state: DatasetSessionState {
                    source: None,
                    preview: None,
                    phase: DatasetSessionPhase::Discovering(DatasetDiscoveringSession {
                        progress,
                        sample_summary: None,
                        sample_reader: None,
                        sample_reader_interrupt: None,
                    }),
                },
                summary,
                member_count: None,
                ignored_file_count: None,
            },
            intent,
            publication,
        )
    }

    fn install_dataset_state(
        &self,
        recent_sources_path: Option<&std::path::Path>,
        native_notifier: Option<DatasetNativeNotifier>,
        descriptor: SourceDescriptor,
        install: DatasetSessionInstall,
        intent: SourceOpenIntent,
        publication: SourceOpenPublication<'_>,
    ) -> Result<Option<(OpenedSourceInfo, Arc<OpenedSourceSession>)>, OpenSourceError> {
        let path = descriptor.path().to_path_buf();
        let kind = descriptor.kind();
        let candidates = {
            let state = self.lock_state()?;
            state.sessions.iter().map(Arc::clone).collect::<Vec<_>>()
        };
        // Explicit selections may have large disk-backed manifests. Compare them
        // without holding the open-source lock used by close and source switching.
        let existing_generation = candidates
            .iter()
            .find(|session| session.descriptor == descriptor)
            .map(|session| session.generation);
        let mut state = self.lock_state()?;
        if publication.request != state.open_request {
            return Ok(None);
        }
        if publication.reload_generation.is_some_and(|generation| {
            !state
                .sessions
                .iter()
                .any(|session| session.generation == generation)
        }) {
            return Ok(None);
        }
        if let Some(client_attempt) = publication.client_attempt
            && !state.client_open_attempt.as_ref().is_some_and(|attempt| {
                attempt.id == client_attempt
                    && attempt.open_request == publication.request
                    && matches!(
                        attempt.status,
                        ClientSourceOpenStatus::Pending | ClientSourceOpenStatus::Published
                    )
            })
        {
            return Ok(None);
        }
        if intent == SourceOpenIntent::Restore && state.blocks_restore {
            return Ok(None);
        }
        if intent == SourceOpenIntent::Explicit {
            state.blocks_restore = true;
        }
        let generation = state
            .generation
            .checked_add(1)
            .ok_or(SourceError::Unsupported)?;
        state.generation = generation;
        let dataset_recent_registration =
            recent_sources_path.map(|path| DatasetRecentRegistration {
                store: self.recents.clone(),
                path: path.to_path_buf(),
                recorded: AtomicBool::new(false),
            });
        let session = Arc::new(OpenedSourceSession {
            generation,
            path,
            descriptor: descriptor.clone(),
            kind,
            summary: install.summary.clone(),
            schema: install.summary.schema.clone(),
            source_identity: None,
            dataset_recent_registration,
            dataset_native_notifier: native_notifier,
            state: Mutex::new(OpenedSourceSessionState {
                reader: SessionWindowReader::Dataset(install.state),
                view_revision: 0,
                view: None,
                view_interrupt: None,
                text_suggestion_reader: None,
                statistics_cache: HashMap::new(),
                data_view_jobs: DataViewJobsState::default(),
                text_suggestion_jobs: TextValueSuggestionJobsState::default(),
                statistics_job: None,
                statistics_construction: None,
                structure_member_ordinal: 0,
                structure_member_request: 0,
            }),
            lifecycle: Arc::new(SessionLifecycle::default()),
            structure_jobs: StructureJobs::default(),
        });
        let existing = existing_generation.and_then(|generation| {
            state
                .sessions
                .iter()
                .position(|existing| existing.generation == generation)
        });
        let replaced = existing.map(|index| state.sessions.remove(index));
        if let Some(previous) = &replaced {
            previous.lifecycle.start_closing();
        }
        state.sessions.insert(0, Arc::clone(&session));
        if let Some(attempt) = publication.client_attempt
            && let Some(client_open) = state
                .client_open_attempt
                .as_mut()
                .filter(|client_open| client_open.id == attempt)
        {
            client_open.status = ClientSourceOpenStatus::Published;
        }
        drop(state);
        if let Some(previous) = replaced {
            if let Ok(mut cache) = self.structure_cache.lock() {
                cache.remove(previous.generation);
            }
            self.data_exports
                .cancel_source_and_wait(previous.generation);
            previous.close_and_wait();
        }
        Ok(Some((
            OpenedSourceInfo {
                generation,
                kind,
                dataset_member_count: install.member_count,
                dataset_ignored_file_count: install.ignored_file_count,
                summary: install.summary,
            },
            session,
        )))
    }
}

const DATASET_PREVIEW_ROWS: u32 = 256;
const DATASET_DISCOVERY_BATCH_ENTRIES: u32 = 32;
const DATASET_INSPECTION_BATCH_MEMBERS: u32 = 32;

pub(crate) enum DatasetOpenResult {
    Existing(OpenedSourceInfo),
    Discovering(
        OpenedSourceInfo,
        Arc<OpenedSourceSession>,
        Box<DatasetDiscovery<'static>>,
    ),
}

pub(crate) fn publish_dataset_open(opened: DatasetOpenResult) -> OpenedSourceInfo {
    match opened {
        DatasetOpenResult::Existing(info) => info,
        DatasetOpenResult::Discovering(info, session, discovery) => {
            spawn_dataset_discovery(session, *discovery);
            info
        }
    }
}

pub(crate) fn inspect_dataset_for_request(
    opened_source: &OpenedSource,
    descriptor: SourceDescriptor,
    recent_sources_path: Option<&std::path::Path>,
    native_notifier: Option<DatasetNativeNotifier>,
    intent: SourceOpenIntent,
    publication: SourceOpenPublication<'_>,
    reuse_existing: bool,
) -> Result<Option<DatasetOpenResult>, OpenSourceError> {
    if !opened_source.source_open_is_current(publication.request)? {
        return Ok(None);
    }
    let descriptor = descriptor.canonicalized_dataset()?;
    if reuse_existing
        && let Some(info) =
            opened_source.activate_dataset_descriptor(&descriptor, intent, publication)?
    {
        return Ok(Some(DatasetOpenResult::Existing(info)));
    }
    let discovery = descriptor.begin_dataset_discovery()?;
    let progress = discovery.progress()?;
    Ok(opened_source
        .install_discovering_dataset(
            recent_sources_path,
            native_notifier,
            descriptor,
            progress,
            intent,
            publication,
        )?
        .map(|(info, session)| DatasetOpenResult::Discovering(info, session, Box::new(discovery))))
}

fn prepare_dataset_inspection(
    source: DatasetSource,
    session: &OpenedSourceSession,
) -> Result<(DatasetInspectionInstall, DatasetInspector), DatasetError> {
    let mut inspector = source.inspector();
    let interrupt = inspector.interrupt_handle();
    let preview =
        inspector.preview_while(DATASET_PREVIEW_ROWS, || session.lifecycle.wants_work())?;
    let reader = inspector.take_preview_reader()?;
    Ok((
        DatasetInspectionInstall {
            preview,
            reader,
            interrupt,
        },
        inspector,
    ))
}

pub(crate) fn spawn_dataset_discovery(
    session: Arc<OpenedSourceSession>,
    mut discovery: DatasetDiscovery<'static>,
) {
    let failure_session = Arc::clone(&session);
    spawn_supervised_dataset_worker(failure_session, move || {
        let Ok(_work) = session.begin_work() else {
            return;
        };
        loop {
            let progress = match discovery.advance_while(DATASET_DISCOVERY_BATCH_ENTRIES, || {
                session.lifecycle.wants_work()
            }) {
                Ok(progress) => progress,
                Err(DatasetError::Cancelled) => return,
                Err(error) => {
                    let _ = publish_dataset_failure(&session, error);
                    return;
                }
            };
            if !publish_dataset_discovery_progress(&session, progress).unwrap_or(false) {
                return;
            }
            if !progress.complete {
                let sample_source = match discovery.next_preview_candidate() {
                    Ok(Some(source)) => source,
                    Ok(None) => continue,
                    Err(error) => {
                        let _ = publish_dataset_failure(&session, error);
                        return;
                    }
                };
                let (sample, _) = match prepare_dataset_inspection(sample_source.clone(), &session)
                {
                    Ok(sample) => sample,
                    Err(DatasetError::Cancelled) => return,
                    Err(error) => {
                        let _ = publish_dataset_failure(&session, error);
                        return;
                    }
                };
                let should_publish = match discovery.commit_preview_candidate(&sample.preview) {
                    Ok(should_publish) => should_publish,
                    Err(error) => {
                        let _ = publish_dataset_failure(&session, error);
                        return;
                    }
                };
                if !should_publish {
                    continue;
                }
                if !publish_dataset_sample(&session, sample_source, sample).unwrap_or(false) {
                    return;
                }
            }
            if progress.complete {
                break;
            }
        }
        let source = match discovery.into_source_while(|| session.lifecycle.wants_work()) {
            Ok(source) => source,
            Err(DatasetError::Cancelled) => return,
            Err(error) => {
                let _ = publish_dataset_failure(&session, error);
                return;
            }
        };
        let (inspection, inspector) = match prepare_dataset_inspection(source.clone(), &session) {
            Ok(inspection) => inspection,
            Err(DatasetError::Cancelled) => return,
            Err(error) => {
                let _ = publish_dataset_failure(&session, error);
                return;
            }
        };
        if !publish_dataset_inspection(&session, source, inspection).unwrap_or(false) {
            return;
        }
        run_dataset_inspection(&session, inspector);
    });
}

fn spawn_supervised_dataset_worker(
    session: Arc<OpenedSourceSession>,
    worker: impl FnOnce() + Send + 'static,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let completed = tauri::async_runtime::spawn_blocking(worker).await;
        if completed.is_err() {
            let _ = publish_dataset_failure(&session, DatasetError::Unsupported);
        }
    })
}

fn publish_dataset_discovery_progress(
    session: &OpenedSourceSession,
    progress: DatasetDiscoveryProgress,
) -> Result<bool, DataWindowError> {
    session.with_open_state(|state| {
        let SessionWindowReader::Dataset(dataset) = &mut state.reader else {
            return false;
        };
        let DatasetSessionPhase::Discovering(discovering) = &mut dataset.phase else {
            return false;
        };
        discovering.progress = progress;
        true
    })
}

fn publish_dataset_sample(
    session: &OpenedSourceSession,
    source: DatasetSource,
    sample: DatasetInspectionInstall,
) -> Result<bool, DataWindowError> {
    let summary = sample.reader.summary().clone();
    let reader_interrupt = sample.reader.interrupt_handle();
    let reader = Arc::new(Mutex::new(sample.reader));
    let published = session.with_open_state(|state| {
        let SessionWindowReader::Dataset(dataset) = &mut state.reader else {
            return false;
        };
        let DatasetSessionPhase::Discovering(discovering) = &mut dataset.phase else {
            return false;
        };
        if discovering.sample_reader.is_some() {
            return false;
        }
        dataset.source = Some(source);
        dataset.preview = Some(Arc::new(sample.preview.arrow_ipc));
        discovering.sample_summary = Some(summary);
        discovering.sample_reader = Some(reader);
        discovering.sample_reader_interrupt = Some(reader_interrupt);
        true
    })?;
    if published {
        session.record_dataset_recent();
    }
    Ok(published)
}

fn publish_dataset_inspection(
    session: &OpenedSourceSession,
    source: DatasetSource,
    inspection: DatasetInspectionInstall,
) -> Result<bool, DataWindowError> {
    let DatasetInspectionInstall {
        preview,
        reader: fallback_reader,
        interrupt,
    } = inspection;
    let progress = preview.progress;
    let fallback_preview = Arc::new(preview.arrow_ipc);
    let fallback_summary = fallback_reader.summary().clone();
    let fallback_reader_interrupt = fallback_reader.interrupt_handle();
    let fallback_reader = Arc::new(Mutex::new(fallback_reader));
    let published = session.with_open_state(|state| {
        let SessionWindowReader::Dataset(dataset) = &mut state.reader else {
            return false;
        };
        let DatasetSessionPhase::Discovering(discovering) = &mut dataset.phase else {
            return false;
        };
        let sample = match (
            discovering.sample_summary.take(),
            discovering.sample_reader.take(),
            discovering.sample_reader_interrupt.take(),
            dataset.preview.is_some(),
        ) {
            (Some(summary), Some(reader), Some(reader_interrupt), true) => {
                (summary, reader, reader_interrupt)
            }
            (None, None, None, false) => {
                dataset.preview = Some(fallback_preview);
                (fallback_summary, fallback_reader, fallback_reader_interrupt)
            }
            _ => return false,
        };
        dataset.source = Some(source);
        dataset.phase = DatasetSessionPhase::Inspecting(Box::new(DatasetInspectingSession {
            progress,
            sample_summary: sample.0,
            interrupt,
            sample_reader: sample.1,
            sample_reader_interrupt: sample.2,
        }));
        true
    })?;
    if published {
        session.record_dataset_recent();
    }
    Ok(published)
}

fn run_dataset_inspection(session: &OpenedSourceSession, mut inspector: DatasetInspector) {
    let completed = loop {
        let progress = match inspector.advance(DATASET_INSPECTION_BATCH_MEMBERS) {
            Ok(progress) => progress,
            Err(DatasetError::Cancelled) => return,
            Err(error) => {
                let _ = publish_dataset_failure(session, error);
                return;
            }
        };
        let is_complete = progress.summary.is_some();
        if session
            .with_open_state(|state| {
                let SessionWindowReader::Dataset(dataset) = &mut state.reader else {
                    return false;
                };
                let DatasetSessionPhase::Inspecting(inspecting) = &mut dataset.phase else {
                    return false;
                };
                inspecting.progress = progress;
                true
            })
            .ok()
            != Some(true)
        {
            return;
        }
        if is_complete {
            break inspector.into_window_reader();
        }
    };
    match completed {
        Ok(reader) => {
            let _ = publish_completed_dataset_reader(session, reader);
        }
        Err(DatasetError::Cancelled) => {}
        Err(error) => {
            let _ = publish_dataset_failure(session, error);
        }
    }
}

pub(crate) fn publish_dataset_failure(
    session: &OpenedSourceSession,
    error: DatasetError,
) -> Result<bool, DataWindowError> {
    let published = session.with_open_state(|state| {
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            return false;
        };
        if matches!(dataset.phase, DatasetSessionPhase::Failed(_)) {
            return false;
        }
        state.reset_query_state();
        let SessionWindowReader::Dataset(dataset) = &mut state.reader else {
            unreachable!("checked above");
        };
        dataset.phase = DatasetSessionPhase::Failed(error);
        true
    })?;
    if published {
        session.notify_dataset_status_changed();
    }
    Ok(published)
}

pub(crate) fn recover_latched_dataset_error(
    session: &OpenedSourceSession,
    reader: Option<&Arc<Mutex<DatasetWindowReader>>>,
    error: DataWindowError,
) -> Result<Option<DatasetError>, DataWindowError> {
    if !matches!(
        error,
        DataWindowError::SourceChanged
            | DataWindowError::CorruptSource
            | DataWindowError::PermissionDenied
    ) {
        return Ok(None);
    }
    let Some(reader) = reader else {
        return Ok(None);
    };
    let Err(error) = reader
        .lock()
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?
        .latched_source_change()
    else {
        return Ok(None);
    };
    let _ = publish_dataset_failure(session, error.clone())?;
    Ok(Some(error))
}

fn publish_completed_dataset_reader(
    session: &OpenedSourceSession,
    reader: DatasetWindowReader,
) -> Result<bool, DataWindowError> {
    let summary = reader.summary().clone();
    let interrupt = reader.interrupt_handle();
    let reader = Arc::new(Mutex::new(reader));
    let published = session.with_open_state(|state| {
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            return false;
        };
        if !matches!(dataset.phase, DatasetSessionPhase::Inspecting(_)) {
            return false;
        }
        state.reset_query_state();
        let SessionWindowReader::Dataset(dataset) = &mut state.reader else {
            unreachable!("checked above");
        };
        dataset.phase = DatasetSessionPhase::Ready {
            summary,
            reader,
            interrupt,
        };
        true
    })?;
    if published {
        session.record_dataset_recent();
    }
    Ok(published)
}

/// Opens one folder as a fixed dataset and publishes a bounded early sample.
#[tauri::command]
pub(crate) async fn open_local_folder(
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
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let selected = command_app.dialog().file().blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let root = selected
            .into_path()
            .map_err(|_| DatasetError::Unsupported)?;
        inspect_dataset_for_request(
            command_app.state::<OpenedSource>().inner(),
            SourceDescriptor::Folder(root),
            recents::state_path(&command_app).ok().as_deref(),
            Some(DatasetNativeNotifier::Native(command_app.clone())),
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request: open_request,
                client_attempt: Some(&job_attempt),
                reload_generation: None,
            },
            true,
        )
    })
    .await
    .map_err(|_| DatasetError::Unsupported)?;
    app.state::<OpenedSource>()
        .finish_client_source_open(&attempt)?;
    if let Some(opened) = opened? {
        return Ok(Some(publish_dataset_open(opened)));
    }
    Ok(None)
}

#[tauri::command]
pub(crate) async fn get_dataset_status(
    generation: u64,
    app: tauri::AppHandle,
) -> Result<DatasetSessionStatus, DatasetCommandError> {
    let session = dataset_session(app.state::<OpenedSource>().inner(), generation)?;
    tauri::async_runtime::spawn_blocking(move || session.dataset_status())
        .await
        .map_err(|_| DatasetError::Unsupported)?
        .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))
}

#[tauri::command]
pub(crate) async fn get_dataset_preview(
    generation: u64,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, DatasetCommandError> {
    let session = dataset_session(app.state::<OpenedSource>().inner(), generation)?;
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let preview = {
            let state = session.lock_state().map_err(|_| {
                DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged)
            })?;
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                return Err(DatasetCommandError::Session(
                    DatasetSessionCommandError::NotDataset,
                ));
            };
            dataset
                .preview
                .as_ref()
                .map(Arc::clone)
                .ok_or(DatasetCommandError::Session(
                    DatasetSessionCommandError::NotReady,
                ))?
        };
        Ok::<_, DatasetCommandError>(preview.as_ref().clone())
    })
    .await
    .map_err(|_| DatasetError::Unsupported)??;
    Ok(tauri::ipc::Response::new(preview))
}

#[tauri::command]
pub(crate) async fn get_dataset_members(
    generation: u64,
    offset: u64,
    limit: u32,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<DatasetMemberPage, DatasetCommandError> {
    let session = dataset_session(&opened_source, generation)?;
    let _work = session
        .begin_work()
        .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
    let source = {
        let state = session
            .state
            .lock()
            .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            unreachable!("dataset sessions retain dataset state");
        };
        dataset.source.clone().ok_or(DatasetCommandError::Session(
            DatasetSessionCommandError::NotReady,
        ))?
    };
    tauri::async_runtime::spawn_blocking(move || source.member_page(offset, limit))
        .await
        .map_err(|_| DatasetError::Unsupported)?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn get_dataset_partitions(
    generation: u64,
    parent: Vec<viewda_data_engine::PartitionValue>,
    after: Option<viewda_data_engine::PartitionValue>,
    limit: u32,
    opened_source: tauri::State<'_, OpenedSource>,
) -> Result<DatasetPartitionPage, DatasetCommandError> {
    let session = dataset_session(&opened_source, generation)?;
    let _work = session
        .begin_work()
        .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
    let source = {
        let state = session
            .state
            .lock()
            .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            unreachable!("dataset sessions retain dataset state");
        };
        dataset.source.clone().ok_or(DatasetCommandError::Session(
            DatasetSessionCommandError::NotReady,
        ))?
    };
    tauri::async_runtime::spawn_blocking(move || {
        source.partition_page(&parent, after.as_ref(), limit)
    })
    .await
    .map_err(|_| DatasetError::Unsupported)?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn get_dataset_schema_drift_members(
    generation: u64,
    offset: u64,
    limit: u32,
    app: tauri::AppHandle,
) -> Result<DatasetMemberPage, DatasetCommandError> {
    let session = dataset_session(app.state::<OpenedSource>().inner(), generation)?;
    let _work = session
        .begin_work()
        .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
    let reader = {
        let state = session
            .state
            .lock()
            .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?;
        let SessionWindowReader::Dataset(dataset) = &state.reader else {
            unreachable!("dataset sessions retain dataset state");
        };
        match &dataset.phase {
            DatasetSessionPhase::Ready { reader, .. } => Arc::clone(reader),
            DatasetSessionPhase::Discovering(_) | DatasetSessionPhase::Inspecting(_) => Err(
                DatasetCommandError::Session(DatasetSessionCommandError::NotReady),
            )?,
            DatasetSessionPhase::Failed(error) => return Err(error.clone().into()),
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        reader
            .lock()
            .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))?
            .schema_drift_page(offset, limit)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| DatasetError::Unsupported)?
}

#[tauri::command]
pub(crate) async fn cancel_dataset_inspection(
    generation: u64,
    app: tauri::AppHandle,
) -> Result<bool, DatasetCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        cancel_dataset_inspection_for(app.state::<OpenedSource>().inner(), generation)
    })
    .await
    .map_err(|_| DatasetError::Unsupported)?
}

fn cancel_dataset_inspection_for(
    opened_source: &OpenedSource,
    generation: u64,
) -> Result<bool, DatasetCommandError> {
    let _session = dataset_session(opened_source, generation)?;
    opened_source
        .close(generation)
        .map_err(|_| DatasetCommandError::Session(DatasetSessionCommandError::SourceChanged))
}

#[cfg(test)]
pub(crate) mod tests {
    use std::fs;

    use arrow_array::{Int64Array, RecordBatch};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    #[cfg(unix)]
    use viewda_data_engine::{
        ColumnStatisticsError, ColumnStatisticsReader, DataFilter, DataFilterOperator, DataSort,
        DataSortDirection, DataViewBuilder, DataViewError, DataViewMemoryLimit,
        TextValueSuggestionsReader,
    };

    use super::*;
    #[cfg(unix)]
    use crate::reserve_data_view_construction;
    use crate::{
        RecentSourceError, clear_statistics_construction, fetch_opened_source_window,
        map_dataset_window_result, open_recent_source_at_path,
    };

    pub(crate) fn install_test_dataset(
        opened_source: &OpenedSource,
        root: &std::path::Path,
    ) -> (Arc<OpenedSourceSession>, DatasetInspector, OpenedSourceInfo) {
        install_test_dataset_with_notifier(opened_source, root, None)
    }

    pub(crate) fn install_test_dataset_with_notifier(
        opened_source: &OpenedSource,
        root: &std::path::Path,
        native_notifier: Option<DatasetNativeNotifier>,
    ) -> (Arc<OpenedSourceSession>, DatasetInspector, OpenedSourceInfo) {
        let descriptor = SourceDescriptor::Folder(root.to_path_buf())
            .canonicalized_dataset()
            .expect("canonical dataset test fixture");
        let source = descriptor.reopen_dataset().expect("dataset discovery");
        let mut inspector = source.inspector();
        let interrupt = inspector.interrupt_handle();
        let preview = inspector.preview(16).expect("dataset preview");
        let preview_reader = inspector.take_preview_reader().expect("preview reader");
        let request = opened_source.begin_source_open().expect("open request");
        let (info, session) = opened_source
            .install_dataset(
                descriptor,
                source,
                DatasetInspectionInstall {
                    preview,
                    reader: preview_reader,
                    interrupt,
                },
                native_notifier,
                SourceOpenIntent::Explicit,
                SourceOpenPublication {
                    request,
                    client_attempt: None,
                    reload_generation: None,
                },
            )
            .expect("dataset install")
            .expect("current request");
        (session, inspector, info)
    }

    #[cfg(unix)]
    fn ready_permission_dataset() -> (
        tempfile::TempDir,
        PathBuf,
        Arc<OpenedSourceSession>,
        Arc<Mutex<DatasetWindowReader>>,
    ) {
        let directory = tempfile::tempdir().expect("dataset directory");
        let member = directory.path().join("private.parquet");
        write_test_parquet(&member, &[1, 2]);
        let opened_source = OpenedSource::default();
        let (session, inspector, _) = install_test_dataset(&opened_source, directory.path());
        let reader = inspector.into_window_reader().expect("completed reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));
        let reader = {
            let state = session.lock_state().expect("session state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            let DatasetSessionPhase::Ready { reader, .. } = &dataset.phase else {
                panic!("ready dataset");
            };
            Arc::clone(reader)
        };
        (directory, member, session, reader)
    }

    fn install_test_discovery(
        opened_source: &OpenedSource,
        root: &std::path::Path,
        recent_sources_path: Option<&std::path::Path>,
        native_notifier: Option<DatasetNativeNotifier>,
    ) -> (
        Arc<OpenedSourceSession>,
        DatasetDiscovery<'static>,
        OpenedSourceInfo,
    ) {
        let request = opened_source.begin_source_open().expect("open request");
        let opened = inspect_dataset_for_request(
            opened_source,
            SourceDescriptor::Folder(root.to_path_buf()),
            recent_sources_path,
            native_notifier,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request,
                client_attempt: None,
                reload_generation: None,
            },
            false,
        )
        .expect("begin dataset")
        .expect("current request");
        let DatasetOpenResult::Discovering(info, session, discovery) = opened else {
            panic!("new dataset must begin with discovery");
        };
        (session, *discovery, info)
    }

    #[test]
    fn dataset_discovery_publishes_before_consuming_entries_and_cancel_wins_the_race() {
        let directory = tempfile::tempdir().expect("dataset directory");
        for index in 0..40 {
            fs::write(
                directory.path().join(format!("part-{index:02}.parquet")),
                b"footer intentionally absent",
            )
            .expect("lazy member");
        }
        let opened_source = OpenedSource::default();
        let (session, mut discovery, info) =
            install_test_discovery(&opened_source, directory.path(), None, None);

        assert_eq!(info.dataset_member_count, None);
        assert_eq!(info.dataset_ignored_file_count, None);
        assert!(matches!(
            session.dataset_status().expect("discovering status"),
            DatasetSessionStatus::Discovering {
                progress: DatasetDiscoveryStatus {
                    scanned_entry_count: 0,
                    discovered_member_count: 0,
                    ignored_file_count: 0,
                },
                sample_summary: None,
            }
        ));

        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation)
                .expect("cancel discovery")
        );
        assert_eq!(
            discovery.advance_while(1, || session.lifecycle.wants_work()),
            Err(DatasetError::Cancelled)
        );
        assert_eq!(
            publish_dataset_discovery_progress(
                &session,
                DatasetDiscoveryProgress {
                    scanned_entry_count: 1,
                    discovered_member_count: 1,
                    ignored_file_count: 0,
                    complete: false,
                },
            ),
            Err(DataWindowError::Cancelled)
        );
    }

    #[cfg(unix)]
    #[test]
    fn discovery_publishes_the_first_fixed_sample_before_full_inspection() {
        let directory = tempfile::tempdir().expect("dataset directory");
        let first = directory.path().join("part-00.parquet");
        write_test_parquet(&first, &[1]);
        for index in 1..33 {
            fs::hard_link(
                &first,
                directory.path().join(format!("part-{index:02}.parquet")),
            )
            .expect("sample member");
        }
        let opened_source = OpenedSource::default();
        let (session, mut discovery, info) =
            install_test_discovery(&opened_source, directory.path(), None, None);

        let progress = discovery.advance(1).expect("sample discovery step");
        assert!(!progress.complete);
        assert!(publish_dataset_discovery_progress(&session, progress).expect("publish progress"));
        let sample_source = discovery
            .next_preview_candidate()
            .expect("sample candidate")
            .expect("ready candidate");
        assert_eq!(sample_source.member_count(), 1);
        let (sample, _) =
            prepare_dataset_inspection(sample_source.clone(), &session).expect("sample preview");
        assert!(
            discovery
                .commit_preview_candidate(&sample.preview)
                .expect("commit sample")
        );
        assert!(publish_dataset_sample(&session, sample_source, sample).expect("publish sample"));
        assert!(matches!(
            session.dataset_status().expect("sample status"),
            DatasetSessionStatus::Discovering {
                sample_summary: Some(_),
                ..
            }
        ));
        assert!(
            fetch_opened_source_window(
                &session,
                0,
                0,
                1,
                &[viewda_data_engine::FieldPath::from("value")]
            )
            .is_ok()
        );
        let (sample_reader, sample_facts, sample_preview, construction) = {
            let mut state = session.lock_state().expect("sample state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            let reader = dataset_query_reader(dataset).expect("sample reader");
            let facts = session_query_facts(&session, &state)
                .map(|(schema, nodes, rows)| (schema.to_vec(), nodes, rows))
                .expect("sample facts");
            let preview = Arc::clone(dataset.preview.as_ref().expect("sample preview"));
            let construction = reserve_data_view_construction(&mut state.data_view_jobs, 1)
                .expect("sample view construction");
            (reader, facts, preview, construction)
        };

        while !discovery.advance(32).expect("finish discovery").complete {}
        let source = discovery.into_source().expect("full source");
        assert_eq!(source.member_count(), 33);
        let (inspection, mut inspector) =
            prepare_dataset_inspection(source.clone(), &session).expect("full preview");
        assert!(
            publish_dataset_inspection(&session, source, inspection)
                .expect("publish full inspection")
        );
        let inspecting_reader = {
            let state = session.lock_state().expect("inspecting state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            assert!(Arc::ptr_eq(
                dataset.preview.as_ref().expect("inspecting sample preview"),
                &sample_preview
            ));
            assert_eq!(
                session_query_facts(&session, &state)
                    .map(|(schema, nodes, rows)| (schema.to_vec(), nodes, rows))
                    .expect("inspecting sample facts"),
                sample_facts
            );
            dataset_query_reader(dataset).expect("inspecting sample reader")
        };
        assert!(Arc::ptr_eq(&inspecting_reader, &sample_reader));
        assert!(!construction.load(Ordering::Acquire));
        assert!(matches!(
            session.dataset_status().expect("late inspecting poll"),
            DatasetSessionStatus::Inspecting {
                progress,
                sample_summary,
            } if progress.total_member_count == 33 && sample_summary.member_count == 1
        ));
        let sample_view = {
            let reader = inspecting_reader.lock().expect("sample reader lock");
            DataViewBuilder::for_dataset(
                &reader,
                &[DataFilter {
                    field_path: viewda_data_engine::FieldPath::from("value"),
                    json_target: None,
                    operator: DataFilterOperator::Equals,
                    values: vec!["1".to_owned()],
                    match_case: false,
                }],
                &[DataSort {
                    field_path: viewda_data_engine::FieldPath::from("value"),
                    json_target: None,
                    direction: viewda_data_engine::DataSortDirection::Descending,
                }],
                viewda_data_engine::DataViewMemoryLimit::Mb384,
            )
            .expect("sample view builder")
            .build()
            .expect("sample view during inspection")
        };
        assert_eq!(sample_view.row_count(), 1);

        while inspector
            .advance(32)
            .expect("complete full inspection")
            .summary
            .is_none()
        {}
        let ready_reader = inspector.into_window_reader().expect("ready reader");
        assert!(publish_completed_dataset_reader(&session, ready_reader).expect("publish ready"));
        let ready_reader = {
            let state = session.lock_state().expect("ready state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            dataset_query_reader(dataset).expect("ready reader")
        };
        assert!(!Arc::ptr_eq(&ready_reader, &sample_reader));
        assert!(construction.load(Ordering::Acquire));
        assert!(matches!(
            session.dataset_status().expect("ready status"),
            DatasetSessionStatus::Ready { summary }
                if summary.member_count == 33 && summary.row_count == 33
        ));
        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation)
                .expect("close ready dataset")
        );
    }

    #[test]
    fn discovery_keeps_an_empty_candidate_until_a_later_batch_has_rows() {
        let directory = tempfile::tempdir().expect("dataset directory");
        let empty = directory.path().join("part-00.parquet");
        let nonempty = directory.path().join("part-01.parquet");
        let later = directory.path().join("part-02.parquet");
        write_test_parquet(&empty, &[]);
        write_test_parquet(&nonempty, &[1]);
        write_test_parquet(&later, &[2]);
        let descriptor = SourceDescriptor::explicit_files(vec![empty, nonempty, later])
            .expect("explicit dataset descriptor");
        let opened_source = OpenedSource::default();
        let request = opened_source.begin_source_open().expect("source request");
        let opened = inspect_dataset_for_request(
            &opened_source,
            descriptor,
            None,
            None,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request,
                client_attempt: None,
                reload_generation: None,
            },
            false,
        )
        .expect("begin dataset")
        .expect("current request");
        let DatasetOpenResult::Discovering(info, session, mut discovery) = opened else {
            panic!("explicit dataset must begin with discovery");
        };

        let first = discovery.advance(1).expect("empty discovery batch");
        assert!(!first.complete);
        assert!(publish_dataset_discovery_progress(&session, first).expect("first progress"));
        let first_source = discovery
            .next_preview_candidate()
            .expect("first candidate")
            .expect("empty candidate source");
        let (first_sample, _) =
            prepare_dataset_inspection(first_source, &session).expect("empty candidate inspection");
        assert_eq!(first_sample.preview.progress.row_count, 0);
        assert!(
            !discovery
                .commit_preview_candidate(&first_sample.preview)
                .expect("retain empty candidate")
        );
        assert!(matches!(
            session.dataset_status().expect("empty candidate status"),
            DatasetSessionStatus::Discovering {
                sample_summary: None,
                ..
            }
        ));

        let second = discovery.advance(1).expect("nonempty discovery batch");
        assert!(!second.complete);
        assert!(publish_dataset_discovery_progress(&session, second).expect("second progress"));
        let second_source = discovery
            .next_preview_candidate()
            .expect("grown candidate")
            .expect("candidate with rows");
        let (second_sample, _) = prepare_dataset_inspection(second_source.clone(), &session)
            .expect("nonempty candidate inspection");
        assert_eq!(second_sample.preview.progress.row_count, 1);
        assert!(
            discovery
                .commit_preview_candidate(&second_sample.preview)
                .expect("commit candidate with rows")
        );
        assert!(publish_dataset_sample(&session, second_source, second_sample).expect("publish"));
        assert!(matches!(
            session.dataset_status().expect("published sample status"),
            DatasetSessionStatus::Discovering {
                sample_summary: Some(summary),
                ..
            } if summary.member_count == 2 && summary.row_count == 1
        ));
        assert!(
            fetch_opened_source_window(
                &session,
                0,
                0,
                1,
                &[viewda_data_engine::FieldPath::from("value")]
            )
            .is_ok()
        );

        let continued = discovery.advance(1).expect("continued discovery");
        assert_eq!(continued.discovered_member_count, 3);
        assert!(!continued.complete);
        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation)
                .expect("close discovery")
        );
    }

    #[test]
    fn late_first_poll_of_a_small_dataset_receives_its_inspecting_sample() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1, 2]);
        write_test_parquet(&directory.path().join("b.parquet"), &[3]);
        let opened_source = OpenedSource::default();
        let (session, mut discovery, info) =
            install_test_discovery(&opened_source, directory.path(), None, None);
        loop {
            let progress = discovery.advance(32).expect("discovery step");
            assert!(publish_dataset_discovery_progress(&session, progress).expect("progress"));
            if progress.complete {
                break;
            }
        }
        let source = discovery.into_source().expect("full source");
        let (inspection, _inspector) =
            prepare_dataset_inspection(source.clone(), &session).expect("full preview");

        assert!(publish_dataset_inspection(&session, source, inspection).expect("inspection"));

        assert!(matches!(
            session.dataset_status().expect("late first poll"),
            DatasetSessionStatus::Inspecting {
                progress,
                sample_summary,
            } if progress.total_member_count == 2
                && sample_summary.member_count == 2
                && sample_summary.row_count == 2
        ));
        assert!(
            fetch_opened_source_window(
                &session,
                0,
                0,
                2,
                &[viewda_data_engine::FieldPath::from("value")]
            )
            .is_ok()
        );
        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation)
                .expect("close inspection")
        );
    }

    #[test]
    fn valid_folder_records_one_recent_after_its_first_sample() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let folder = directory.path().join("folder");
        fs::create_dir(&folder).expect("dataset folder");
        write_test_parquet(&folder.join("part.parquet"), &[1]);
        let recent_sources_path = directory.path().join("folder-recents.json");
        let opened_source = OpenedSource::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let (session, mut discovery, info) = install_test_discovery(
            &opened_source,
            &folder,
            Some(recent_sources_path.as_path()),
            Some(DatasetNativeNotifier::Counter(Arc::clone(&notifications))),
        );

        assert_eq!(info.dataset_member_count, None);
        assert_eq!(notifications.load(Ordering::Acquire), 0);
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );
        while !discovery.advance(32).expect("discovery step").complete {}
        let source = discovery.into_source().expect("dataset source");
        let (inspection, inspector) =
            prepare_dataset_inspection(source.clone(), &session).expect("valid sample");
        assert!(publish_dataset_inspection(&session, source, inspection).expect("inspection"));
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-1"),
            Ok(fs::canonicalize(&folder).expect("canonical folder"))
        );
        assert_eq!(notifications.load(Ordering::Acquire), 1);
        assert!(
            publish_completed_dataset_reader(
                &session,
                inspector.into_window_reader().expect("completed reader")
            )
            .expect("ready publication")
        );
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-2"),
            Err(RecentSourceError::UnknownRecent)
        );
        assert_eq!(notifications.load(Ordering::Acquire), 1);
    }

    #[test]
    fn invalid_and_cancelled_folders_do_not_become_recent() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let invalid_folder = directory.path().join("invalid");
        fs::create_dir(&invalid_folder).expect("invalid folder");
        fs::write(invalid_folder.join("part.parquet"), b"footer absent").expect("invalid member");
        let invalid_recents = directory.path().join("invalid-recents.json");
        let opened_source = OpenedSource::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let (invalid_session, mut discovery, _) = install_test_discovery(
            &opened_source,
            &invalid_folder,
            Some(&invalid_recents),
            Some(DatasetNativeNotifier::Counter(Arc::clone(&notifications))),
        );
        while !discovery.advance(32).expect("discovery step").complete {}
        let source = discovery.into_source().expect("invalid source membership");
        assert!(matches!(
            prepare_dataset_inspection(source, &invalid_session),
            Err(DatasetError::InvalidMember { .. })
        ));
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&invalid_recents, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );
        assert_eq!(notifications.load(Ordering::Acquire), 0);

        let cancelled_folder = directory.path().join("cancelled");
        fs::create_dir(&cancelled_folder).expect("cancelled folder");
        write_test_parquet(&cancelled_folder.join("part.parquet"), &[1]);
        let cancelled_recents = directory.path().join("cancelled-recents.json");
        let (cancelled_session, _discovery, info) = install_test_discovery(
            &opened_source,
            &cancelled_folder,
            Some(&cancelled_recents),
            Some(DatasetNativeNotifier::Counter(Arc::clone(&notifications))),
        );
        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation).expect("cancel dataset")
        );
        assert!(!cancelled_session.lifecycle.wants_work());
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&cancelled_recents, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );
        assert_eq!(notifications.load(Ordering::Acquire), 0);
    }

    #[test]
    fn failed_recent_write_notifies_only_after_a_later_successful_retry() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let folder = directory.path().join("folder");
        fs::create_dir(&folder).expect("dataset folder");
        write_test_parquet(&folder.join("part.parquet"), &[1]);
        let blocked_parent = directory.path().join("blocked");
        fs::write(&blocked_parent, b"not a directory").expect("blocked recent parent");
        let recent_sources_path = blocked_parent.join("recents.json");
        let opened_source = OpenedSource::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let (session, mut discovery, _) = install_test_discovery(
            &opened_source,
            &folder,
            Some(&recent_sources_path),
            Some(DatasetNativeNotifier::Counter(Arc::clone(&notifications))),
        );
        while !discovery.advance(32).expect("discovery step").complete {}
        let source = discovery.into_source().expect("dataset source");
        let (inspection, inspector) =
            prepare_dataset_inspection(source.clone(), &session).expect("valid sample");

        assert!(publish_dataset_inspection(&session, source, inspection).expect("inspection"));
        assert_eq!(notifications.load(Ordering::Acquire), 0);
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );

        fs::remove_file(&blocked_parent).expect("remove blocked parent");
        fs::create_dir(&blocked_parent).expect("create recent parent");
        assert!(
            publish_completed_dataset_reader(
                &session,
                inspector.into_window_reader().expect("completed reader")
            )
            .expect("ready publication")
        );
        assert_eq!(notifications.load(Ordering::Acquire), 1);
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-1"),
            Ok(fs::canonicalize(folder).expect("canonical folder"))
        );
    }

    #[test]
    fn explicit_selection_does_not_replace_file_recents() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let folder = directory.path().join("folder");
        fs::create_dir(&folder).expect("dataset folder");
        let opened_source = OpenedSource::default();

        let explicit_recent_sources_path = directory.path().join("explicit-recents.json");
        let existing = directory.path().join("existing.parquet");
        fs::write(&existing, b"existing recent").expect("existing recent");
        opened_source
            .recents
            .record_path(&explicit_recent_sources_path, &existing)
            .expect("record existing recent");
        let first = folder.join("first.parquet");
        let second = folder.join("second.parquet");
        fs::write(&first, b"footer absent").expect("first selected member");
        fs::write(&second, b"footer absent").expect("second selected member");
        let descriptor = SourceDescriptor::explicit_files(vec![first, second])
            .expect("explicit dataset descriptor");
        let request = opened_source.begin_source_open().expect("explicit request");
        let opened = inspect_dataset_for_request(
            &opened_source,
            descriptor,
            Some(&explicit_recent_sources_path),
            None,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request,
                client_attempt: None,
                reload_generation: None,
            },
            false,
        )
        .expect("begin explicit dataset")
        .expect("current explicit request");
        let DatasetOpenResult::Discovering(info, _, _) = opened else {
            panic!("explicit dataset must begin with discovery");
        };
        assert_eq!(info.dataset_member_count, None);
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&explicit_recent_sources_path, "recent-1"),
            Ok(fs::canonicalize(existing).expect("canonical existing recent"))
        );
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&explicit_recent_sources_path, "recent-2"),
            Err(RecentSourceError::UnknownRecent)
        );
    }

    #[test]
    fn open_recent_dispatches_a_folder_to_progressive_dataset_discovery() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let folder = directory.path().join("dataset");
        fs::create_dir(&folder).expect("dataset folder");
        write_test_parquet(&folder.join("part.parquet"), &[1]);
        let recent_sources_path = directory.path().join("recents.json");
        let opened_source = OpenedSource::default();
        opened_source
            .recents
            .record_path(&recent_sources_path, &folder)
            .expect("record folder recent");

        let (opened_path, info) =
            open_recent_source_at_path(&recent_sources_path, &opened_source, "recent-1")
                .expect("open folder recent");

        assert_eq!(
            opened_path,
            fs::canonicalize(&folder).expect("canonical folder")
        );
        assert_eq!(info.kind, OpenedSourceKind::FolderDataset);
        assert_eq!(info.dataset_member_count, None);
        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation)
                .expect("close recent dataset")
        );
    }

    #[test]
    fn dataset_preview_publishes_before_one_atomic_ready_upgrade() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1, 2]);
        write_test_parquet(&directory.path().join("b.parquet"), &[3]);
        let opened_source = OpenedSource::default();
        let (session, mut inspector, info) = install_test_dataset(&opened_source, directory.path());

        assert_eq!(info.kind, OpenedSourceKind::FolderDataset);
        assert_eq!(info.dataset_member_count, Some(2));
        assert!(matches!(
            session.dataset_status().expect("dataset status"),
            DatasetSessionStatus::Inspecting { progress, .. }
                if progress.completed_member_count == 1 && progress.total_member_count == 2
        ));
        let preview = {
            let state = session.lock_state().expect("session state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            dataset
                .preview
                .as_ref()
                .expect("installed early sample")
                .as_ref()
                .clone()
        };
        assert!(!preview.is_empty());
        let state = session.lock_state().expect("session state");
        let (schema, _, row_count) = session_query_facts(&session, &state).expect("preview facts");
        assert_eq!(schema[0].name, "value");
        assert_eq!(row_count, 2);
        drop(state);
        assert!(
            fetch_opened_source_window(
                &session,
                0,
                0,
                2,
                &[viewda_data_engine::FieldPath::from("value")]
            )
            .is_ok()
        );

        inspector.advance(32).expect("remaining footer batch");
        let reader = inspector.into_window_reader().expect("completed reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));
        let summary = match session.dataset_status().expect("ready status") {
            DatasetSessionStatus::Ready { summary } => summary,
            _ => panic!("dataset must upgrade atomically to ready"),
        };
        let projection = (0..summary.schema.len())
            .rev()
            .map(|index| viewda_data_engine::FieldPath::from(summary.schema[index].name.as_str()))
            .collect::<Vec<_>>();
        assert!(fetch_opened_source_window(&session, 0, 0, 2, &projection).is_ok());
    }

    #[test]
    fn closing_a_provisional_dataset_blocks_a_late_ready_publication() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let (session, inspector, info) = install_test_dataset(&opened_source, directory.path());
        let reader = inspector
            .into_window_reader()
            .expect("preview completed reader");

        assert!(opened_source.close(info.generation).expect("close dataset"));
        assert_eq!(
            publish_completed_dataset_reader(&session, reader),
            Err(DataWindowError::Cancelled)
        );
        assert!(
            opened_source
                .lock_state()
                .expect("source state")
                .session(info.generation)
                .is_none()
        );
    }

    #[test]
    fn cancelling_as_inspection_completes_still_closes_the_dataset() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let (session, inspector, info) = install_test_dataset(&opened_source, directory.path());
        let reader = inspector.into_window_reader().expect("completed reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));

        assert!(
            cancel_dataset_inspection_for(&opened_source, info.generation)
                .expect("cancel closes ready race")
        );
        assert!(
            opened_source
                .lock_state()
                .expect("source state")
                .session(info.generation)
                .is_none()
        );
    }

    #[test]
    fn ready_status_snapshot_does_not_wait_for_the_query_reader() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let (session, inspector, _) = install_test_dataset(&opened_source, directory.path());
        let reader = inspector.into_window_reader().expect("completed reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));
        let reader = {
            let state = session.lock_state().expect("session state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            let DatasetSessionPhase::Ready { reader, .. } = &dataset.phase else {
                panic!("ready dataset");
            };
            Arc::clone(reader)
        };
        let _reader_guard = reader.lock().expect("hold query reader");

        assert!(matches!(
            session.dataset_status().expect("non-blocking status"),
            DatasetSessionStatus::Ready { .. }
        ));
    }

    #[test]
    fn dataset_failure_notifies_once_after_the_lifecycle_transition() {
        assert_eq!(
            serde_json::to_value(DatasetStatusChangedEvent { generation: 17 })
                .expect("status event JSON"),
            serde_json::json!({ "generation": 17 })
        );
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let (session, mut discovery, _) = install_test_discovery(
            &opened_source,
            directory.path(),
            None,
            Some(DatasetNativeNotifier::Counter(Arc::clone(&notifications))),
        );
        while !discovery.advance(32).expect("discovery step").complete {}
        let source = discovery.into_source().expect("dataset source");
        let (inspection, inspector) =
            prepare_dataset_inspection(source.clone(), &session).expect("dataset preview");
        assert!(publish_dataset_inspection(&session, source, inspection).expect("inspection"));
        assert!(
            publish_completed_dataset_reader(
                &session,
                inspector.into_window_reader().expect("completed reader"),
            )
            .expect("ready publication")
        );
        assert_eq!(notifications.load(Ordering::Acquire), 0);

        let error = DatasetError::InvalidMember {
            member: "a.parquet".to_owned(),
        };
        assert!(publish_dataset_failure(&session, error.clone()).expect("first failure"));
        assert_eq!(notifications.load(Ordering::Acquire), 1);
        assert!(!publish_dataset_failure(&session, error).expect("repeated failure"));
        assert_eq!(notifications.load(Ordering::Acquire), 1);
    }

    #[test]
    fn discovery_worker_panic_publishes_a_stable_failed_status() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let (session, _, _) = install_test_dataset_with_notifier(
            &opened_source,
            directory.path(),
            Some(DatasetNativeNotifier::Counter(Arc::clone(&notifications))),
        );

        tauri::async_runtime::block_on(spawn_supervised_dataset_worker(
            Arc::clone(&session),
            || panic!("injected discovery panic"),
        ))
        .expect("supervisor task");

        assert_eq!(
            session.dataset_status().expect("failed status"),
            DatasetSessionStatus::Failed {
                error: DatasetError::Unsupported,
            }
        );
        assert_eq!(notifications.load(Ordering::Acquire), 1);
    }

    #[test]
    fn background_failure_keeps_only_the_relative_member_name() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        fs::write(directory.path().join("b.parquet"), b"not parquet").expect("damaged member");
        let opened_source = OpenedSource::default();
        let (session, mut inspector, _) = install_test_dataset(&opened_source, directory.path());
        let error = inspector.advance(32).expect_err("damaged second member");
        assert_eq!(
            error,
            DatasetError::InvalidMember {
                member: "b.parquet".to_owned(),
            }
        );
        assert!(publish_dataset_failure(&session, error.clone()).expect("failure publication"));
        assert_eq!(
            session.dataset_status().expect("failed status"),
            DatasetSessionStatus::Failed { error }
        );
        let serialized = serde_json::to_string(&session.dataset_status().expect("failed status"))
            .expect("status JSON");
        assert!(!serialized.contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn ready_member_failures_publish_the_exact_failed_status() {
        let failures = [
            DatasetError::SourceChanged {
                member: "year=2026/changed.parquet".to_owned(),
            },
            DatasetError::InvalidMember {
                member: "year=2026/damaged.parquet".to_owned(),
            },
            DatasetError::MemberPermissionDenied {
                member: "year=2026/private.parquet".to_owned(),
            },
        ];

        for error in failures {
            let directory = tempfile::tempdir().expect("dataset directory");
            write_test_parquet(&directory.path().join("a.parquet"), &[1]);
            let opened_source = OpenedSource::default();
            let (session, inspector, _) = install_test_dataset(&opened_source, directory.path());
            let reader = inspector.into_window_reader().expect("completed reader");
            assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));

            assert_eq!(
                map_dataset_window_result(
                    &session,
                    Err(DataWindowCommandError::Dataset(error.clone())),
                    None,
                ),
                Err(DataWindowCommandError::Dataset(error.clone()))
            );
            assert_eq!(
                serde_json::to_value(session.dataset_status().expect("failed status"))
                    .expect("status JSON"),
                serde_json::json!({
                    "state": "failed",
                    "error": serde_json::to_value(error).expect("error JSON"),
                })
            );
        }
    }

    #[test]
    fn ordinary_window_failures_leave_a_ready_dataset_open() {
        for error in [DataWindowError::Cancelled, DataWindowError::QueryFailed] {
            let directory = tempfile::tempdir().expect("dataset directory");
            write_test_parquet(&directory.path().join("a.parquet"), &[1]);
            let opened_source = OpenedSource::default();
            let (session, inspector, _) = install_test_dataset(&opened_source, directory.path());
            let reader = inspector.into_window_reader().expect("completed reader");
            assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));

            assert_eq!(
                map_dataset_window_result(
                    &session,
                    Err(DataWindowCommandError::Engine(error)),
                    None,
                ),
                Err(DataWindowCommandError::Engine(error))
            );
            assert!(matches!(
                session.dataset_status().expect("ready status"),
                DatasetSessionStatus::Ready { .. }
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn engine_permission_error_recovers_the_latched_dataset_member_failure() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().expect("dataset directory");
        let member = directory.path().join("private.parquet");
        write_test_parquet(&member, &[1]);
        let opened_source = OpenedSource::default();
        let (session, inspector, _) = install_test_dataset(&opened_source, directory.path());
        let reader = inspector.into_window_reader().expect("completed reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));
        let reader = {
            let state = session.lock_state().expect("session state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            let DatasetSessionPhase::Ready { reader, .. } = &dataset.phase else {
                panic!("ready dataset");
            };
            Arc::clone(reader)
        };

        fs::set_permissions(&member, fs::Permissions::from_mode(0o000))
            .expect("remove member access");
        let latched = reader.lock().expect("dataset reader").fetch(0, 1);
        fs::set_permissions(&member, fs::Permissions::from_mode(0o600))
            .expect("restore member access");
        let expected = DatasetError::MemberPermissionDenied {
            member: "private.parquet".to_owned(),
        };
        assert_eq!(latched, Err(expected.clone()));

        assert_eq!(
            map_dataset_window_result(
                &session,
                Err(DataWindowCommandError::Engine(
                    DataWindowError::PermissionDenied,
                )),
                Some(&reader),
            ),
            Err(DataWindowCommandError::Dataset(expected.clone()))
        );
        assert_eq!(
            session.dataset_status().expect("failed status"),
            DatasetSessionStatus::Failed {
                error: expected.clone(),
            }
        );
        assert_eq!(
            serde_json::to_value(session.dataset_status().expect("failed status"))
                .expect("status JSON"),
            serde_json::json!({
                "state": "failed",
                "error": {
                    "code": "memberPermissionDenied",
                    "member": "private.parquet",
                },
            })
        );
    }

    #[test]
    fn unlatched_engine_permission_error_keeps_the_dataset_ready() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("part.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let (session, inspector, _) = install_test_dataset(&opened_source, directory.path());
        let reader = inspector.into_window_reader().expect("completed reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));
        let reader = {
            let state = session.lock_state().expect("session state");
            let SessionWindowReader::Dataset(dataset) = &state.reader else {
                panic!("dataset session");
            };
            let DatasetSessionPhase::Ready { reader, .. } = &dataset.phase else {
                panic!("ready dataset");
            };
            Arc::clone(reader)
        };

        assert_eq!(
            map_dataset_window_result(
                &session,
                Err(DataWindowCommandError::Engine(
                    DataWindowError::PermissionDenied,
                )),
                Some(&reader),
            ),
            Err(DataWindowCommandError::Engine(
                DataWindowError::PermissionDenied,
            ))
        );
        assert!(matches!(
            session.dataset_status().expect("ready status"),
            DatasetSessionStatus::Ready { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn filtered_sorted_view_permission_failure_publishes_the_exact_dataset_latch() {
        use std::os::unix::fs::PermissionsExt as _;

        let (_directory, member, session, reader) = ready_permission_dataset();
        fs::set_permissions(&member, fs::Permissions::from_mode(0o000))
            .expect("remove member access");
        let error = {
            let reader = reader.lock().expect("dataset reader");
            match DataViewBuilder::for_dataset(
                &reader,
                &[DataFilter {
                    field_path: viewda_data_engine::FieldPath::from("value"),
                    json_target: None,
                    operator: DataFilterOperator::Equals,
                    values: vec!["1".to_owned()],
                    match_case: false,
                }],
                &[DataSort {
                    field_path: viewda_data_engine::FieldPath::from("value"),
                    json_target: None,
                    direction: DataSortDirection::Descending,
                }],
                DataViewMemoryLimit::Mb384,
            ) {
                Ok(builder) => match builder.build() {
                    Ok(_) => panic!("permission failure"),
                    Err(error) => error,
                },
                Err(error) => error,
            }
        };
        fs::set_permissions(&member, fs::Permissions::from_mode(0o600))
            .expect("restore member access");
        assert_eq!(
            error,
            DataViewError::Engine(DataWindowError::PermissionDenied)
        );
        let expected = DatasetError::MemberPermissionDenied {
            member: "private.parquet".to_owned(),
        };
        assert_eq!(
            recover_latched_dataset_error(
                &session,
                Some(&reader),
                DataWindowError::PermissionDenied
            )
            .expect("recover dataset latch"),
            Some(expected.clone())
        );
        assert_eq!(
            session.dataset_status().expect("failed status"),
            DatasetSessionStatus::Failed { error: expected }
        );
    }

    #[cfg(unix)]
    #[test]
    fn suggestion_fetch_permission_failure_publishes_the_exact_dataset_latch() {
        use std::os::unix::fs::PermissionsExt as _;

        let (_directory, member, session, reader) = ready_permission_dataset();
        let (suggestions, column) = {
            let reader = reader.lock().expect("dataset reader");
            (
                TextValueSuggestionsReader::for_dataset(&reader)
                    .expect("dataset suggestion reader"),
                reader
                    .summary()
                    .schema
                    .last()
                    .expect("provenance column")
                    .clone(),
            )
        };
        fs::set_permissions(&member, fs::Permissions::from_mode(0o000))
            .expect("remove member access");
        let error = suggestions
            .fetch(
                "private",
                &viewda_data_engine::FieldPath::from(column.name.as_str()),
                DataFilterOperator::TextContains,
                &suggestions.interrupt_handle(),
            )
            .expect_err("permission failure");
        fs::set_permissions(&member, fs::Permissions::from_mode(0o600))
            .expect("restore member access");
        assert_eq!(error, DataWindowError::PermissionDenied);
        let expected = DatasetError::MemberPermissionDenied {
            member: "private.parquet".to_owned(),
        };
        assert_eq!(
            recover_latched_dataset_error(&session, Some(&reader), error)
                .expect("recover dataset latch"),
            Some(expected.clone())
        );
        assert_eq!(
            session.dataset_status().expect("failed status"),
            DatasetSessionStatus::Failed { error: expected }
        );
    }

    #[cfg(unix)]
    #[test]
    fn statistics_fetch_permission_failure_publishes_the_exact_dataset_latch() {
        use std::os::unix::fs::PermissionsExt as _;

        let (_directory, member, session, reader) = ready_permission_dataset();
        let statistics = {
            let reader = reader.lock().expect("dataset reader");
            ColumnStatisticsReader::for_dataset(&reader).expect("dataset statistics reader")
        };
        fs::set_permissions(&member, fs::Permissions::from_mode(0o000))
            .expect("remove member access");
        let error = statistics
            .fetch(&viewda_data_engine::FieldPath::from("value"), true)
            .expect_err("permission failure");
        fs::set_permissions(&member, fs::Permissions::from_mode(0o600))
            .expect("restore member access");
        assert_eq!(error, ColumnStatisticsError::PermissionDenied);
        let category = crate::column_statistics_dataset_error(error).expect("recoverable category");
        let expected = DatasetError::MemberPermissionDenied {
            member: "private.parquet".to_owned(),
        };
        assert_eq!(
            recover_latched_dataset_error(&session, Some(&reader), category)
                .expect("recover dataset latch"),
            Some(expected.clone())
        );
        assert_eq!(
            session.dataset_status().expect("failed status"),
            DatasetSessionStatus::Failed { error: expected }
        );
    }

    #[test]
    fn dataset_status_reports_a_latched_ready_source_change() {
        let directory = tempfile::tempdir().expect("temporary directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        write_test_parquet(&directory.path().join("b.parquet"), &[2]);
        let opened_source = OpenedSource::default();
        let (session, mut inspector, _) = install_test_dataset(&opened_source, directory.path());
        while inspector
            .advance(32)
            .expect("dataset inspection")
            .summary
            .is_none()
        {}
        let reader = inspector.into_window_reader().expect("dataset reader");
        assert!(publish_completed_dataset_reader(&session, reader).expect("ready publication"));
        fs::remove_file(directory.path().join("b.parquet")).expect("remove member");
        let error = fetch_opened_source_window(
            &session,
            0,
            1,
            1,
            &[viewda_data_engine::FieldPath::from("value")],
        )
        .expect_err("removed member must fail the frame");
        assert_eq!(
            error,
            DataWindowCommandError::Dataset(DatasetError::SourceChanged {
                member: "b.parquet".to_owned(),
            })
        );

        assert!(matches!(
            session.dataset_status().expect("dataset status"),
            DatasetSessionStatus::Failed {
                error: DatasetError::SourceChanged { member }
            } if member == "b.parquet"
        ));
    }

    #[test]
    fn folder_membership_changes_only_when_the_descriptor_reopens() {
        let directory = tempfile::tempdir().expect("dataset directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let descriptor = SourceDescriptor::Folder(directory.path().to_path_buf());
        let frozen = descriptor.reopen_dataset().expect("first discovery");
        write_test_parquet(&directory.path().join("b.parquet"), &[2]);

        assert_eq!(frozen.member_count(), 1);
        assert_eq!(
            descriptor
                .reopen_dataset()
                .expect("reload discovery")
                .member_count(),
            2
        );
    }

    #[test]
    fn repeated_dataset_open_activates_fixed_membership_until_reload() {
        let directory = tempfile::tempdir().expect("temporary directory");
        write_test_parquet(&directory.path().join("a.parquet"), &[1]);
        let opened_source = OpenedSource::default();
        let (_, _, first) = install_test_dataset(&opened_source, directory.path());
        write_test_parquet(&directory.path().join("b.parquet"), &[2]);
        let descriptor = SourceDescriptor::Folder(directory.path().to_path_buf());

        let repeat_request = opened_source.begin_source_open().expect("repeat request");
        let repeated = inspect_dataset_for_request(
            &opened_source,
            descriptor.clone(),
            None,
            None,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request: repeat_request,
                client_attempt: None,
                reload_generation: None,
            },
            true,
        )
        .expect("repeat open")
        .expect("existing dataset");
        let DatasetOpenResult::Existing(repeated) = repeated else {
            panic!("repeat open must not inspect a new composition");
        };
        assert_eq!(repeated.generation, first.generation);
        assert_eq!(repeated.dataset_member_count, Some(1));

        let reload_request = opened_source.begin_source_open().expect("reload request");
        let reloaded = inspect_dataset_for_request(
            &opened_source,
            descriptor,
            None,
            None,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request: reload_request,
                client_attempt: None,
                reload_generation: Some(first.generation),
            },
            false,
        )
        .expect("reload")
        .expect("new dataset generation");
        let DatasetOpenResult::Discovering(reloaded, _, mut discovery) = reloaded else {
            panic!("reload must discover the descriptor again");
        };
        assert_ne!(reloaded.generation, first.generation);
        assert_eq!(reloaded.dataset_member_count, None);
        while !discovery.advance(32).expect("reload discovery").complete {}
        assert_eq!(
            discovery
                .into_source()
                .expect("reloaded source")
                .member_count(),
            2
        );
    }

    #[test]
    fn explicit_dataset_descriptor_ignores_selection_order() {
        let first = PathBuf::from("/data/a.parquet");
        let second = PathBuf::from("/data/b.parquet");

        assert_eq!(
            SourceDescriptor::explicit_files(vec![first.clone(), second.clone()])
                .expect("first manifest"),
            SourceDescriptor::explicit_files(vec![second, first]).expect("second manifest")
        );
    }

    #[test]
    fn explicit_dataset_descriptor_keeps_the_common_root_for_source_details() {
        let descriptor = SourceDescriptor::explicit_files(vec![
            PathBuf::from("/data/one/a.parquet"),
            PathBuf::from("/data/two/b.parquet"),
        ])
        .expect("file manifest");

        assert_eq!(descriptor.path(), std::path::Path::new("/data"));
        assert_eq!(descriptor.kind(), OpenedSourceKind::FileDataset);
    }

    #[test]
    fn explicit_dataset_descriptor_reports_the_hive_dataset_root() {
        let descriptor = SourceDescriptor::explicit_files(vec![
            PathBuf::from("/data/year=2026/month=07/a.parquet"),
            PathBuf::from("/data/year=2026/month=07/b.parquet"),
        ])
        .expect("file manifest");

        assert_eq!(descriptor.path(), std::path::Path::new("/data"));
    }

    #[test]
    fn cancelled_manifest_creation_stops_before_serializing_every_path() {
        let mut checks = 0;
        let descriptor = SourceDescriptor::explicit_files_while(
            vec![
                PathBuf::from("/data/a.parquet"),
                PathBuf::from("/data/b.parquet"),
            ],
            || {
                checks += 1;
                checks == 1
            },
        )
        .expect("cancelled manifest creation");

        assert!(descriptor.is_none());
        assert_eq!(checks, 2);
    }

    #[cfg(unix)]
    #[test]
    fn explicit_manifest_is_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let descriptor = SourceDescriptor::explicit_files(vec![PathBuf::from("/data/a.parquet")])
            .expect("file manifest");
        let SourceDescriptor::ExplicitFiles { manifest, .. } = descriptor else {
            unreachable!("explicit selection creates a manifest");
        };
        let mode = fs::metadata(&manifest.0.path)
            .expect("manifest metadata")
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn recent_explicit_selection_reopens_exactly_after_history_removal() {
        let directory = tempfile::tempdir().expect("dataset directory");
        let physical_root = directory.path().join("physical");
        fs::create_dir(&physical_root).expect("physical dataset directory");
        #[cfg(unix)]
        let dataset_root = {
            use std::os::unix::fs::symlink;

            let logical_root = directory.path().join("dataset-link");
            symlink(&physical_root, &logical_root).expect("logical dataset link");
            logical_root
        };
        #[cfg(not(unix))]
        let dataset_root = physical_root;
        let selected = dataset_root.join("selected.parquet");
        let sibling = dataset_root.join("sibling.parquet");
        write_test_parquet(&selected, &[1]);
        write_test_parquet(&sibling, &[2]);
        let original = SourceDescriptor::explicit_files(vec![selected])
            .expect("explicit selection descriptor");
        let SourceDescriptor::ExplicitFiles { root, manifest } = &original else {
            unreachable!("explicit selection creates a manifest");
        };
        let state_path = directory.path().join("config/recents.json");
        let store = RecentSourcesStore::default();
        store
            .record_explicit_files(&state_path, root, manifest.path())
            .expect("persistent recent selection");
        let resolved = store
            .resolve_path(&state_path, "recent-1")
            .expect("resolved recent selection");
        let ResolvedRecentSource::ExplicitFiles { root, .. } = &resolved else {
            unreachable!("recent selection remains explicit");
        };
        assert_eq!(
            root,
            &std::path::absolute(&dataset_root).expect("absolute logical root")
        );
        let reopened =
            SourceDescriptor::from_recent(resolved).expect("cleanup-owned session descriptor");
        let SourceDescriptor::ExplicitFiles {
            manifest: session_manifest,
            ..
        } = &reopened
        else {
            unreachable!("recent selection remains explicit");
        };
        let session_manifest_path = session_manifest.path().to_path_buf();

        store
            .remove_path(&state_path, "recent-1")
            .expect("remove recent history");
        assert!(session_manifest_path.exists());
        assert_eq!(
            store.resolve_path(&state_path, "recent-1").err(),
            Some(crate::RecentSourceError::UnknownRecent)
        );

        for source in [
            reopened.reopen_dataset().expect("open exact selection"),
            reopened.reopen_dataset().expect("reload exact selection"),
        ] {
            assert_eq!(source.member_count(), 1);
            let page = source.member_page(0, 2).expect("selected member page");
            assert_eq!(page.total, 1);
            assert_eq!(page.members[0].relative_path, "selected.parquet");
        }
    }

    #[test]
    fn stale_statistics_cleanup_preserves_the_newer_reservation() {
        let stale = Arc::new(AtomicBool::new(false));
        let current = Arc::new(AtomicBool::new(false));
        let mut active = Some(Arc::clone(&current));

        clear_statistics_construction(&mut active, &stale);

        assert!(active.is_some_and(|marker| Arc::ptr_eq(&marker, &current)));
    }

    #[test]
    fn streamed_explicit_selection_preserves_constant_hive_partitions() {
        let directory = tempfile::tempdir().expect("dataset directory");
        let parent = directory.path().join("year=2026/month=07");
        fs::create_dir_all(&parent).expect("partition directory");
        let first = parent.join("a.parquet");
        let second = parent.join("b.parquet");
        write_test_parquet(&first, &[1]);
        write_test_parquet(&second, &[2]);
        let descriptor =
            SourceDescriptor::explicit_files(vec![first, second]).expect("explicit manifest");

        let source = descriptor.reopen_dataset().expect("streamed selection");
        let page = source.member_page(0, 2).expect("member page");

        assert_eq!(page.members[0].partitions[0].key, "year");
        assert_eq!(page.members[0].partitions[0].value, "2026");
        assert_eq!(page.members[0].partitions[1].key, "month");
        assert_eq!(page.members[0].partitions[1].value, "07");
    }

    #[test]
    fn deserialized_manifest_never_deletes_its_referenced_path() {
        let file = tempfile::NamedTempFile::new().expect("user file");
        let path = file.path().to_path_buf();
        let manifest: ExplicitFileManifest =
            serde_json::from_value(serde_json::json!(path)).expect("manifest path");

        drop(manifest);

        assert!(path.exists());
    }

    #[test]
    fn manifest_reader_rejects_an_unbounded_record_before_allocation() {
        let mut file = tempfile::NamedTempFile::new().expect("manifest");
        file.write_all(&u32::MAX.to_le_bytes())
            .expect("oversized record");
        file.flush().expect("manifest flush");
        let manifest = ExplicitFileManifest(Arc::new(ExplicitFileManifestFile {
            path: file.path().to_path_buf(),
            cleanup: AtomicBool::new(false),
        }));

        assert!(matches!(
            manifest.paths().expect("manifest reader").next(),
            Some(Err(DatasetError::Unsupported))
        ));
    }

    #[test]
    fn every_dataset_status_variant_has_a_stable_wire_shape() {
        let summary = DatasetSummaryStatus {
            display_name: "sample/".to_owned(),
            member_count: 2,
            ignored_file_count: 1,
            size_bytes: 8,
            row_count: 3,
            row_group_count: 1,
            column_count: 1,
            schema: Vec::new(),
            schema_node_count: 0,
            schema_is_truncated: false,
            strings_truncated: false,
            schema_drift_member_count: 0,
            partition_column_indices: Vec::new(),
            provenance_column_index: 1,
        };
        let progress = DatasetDiscoveryProgress {
            scanned_entry_count: 7,
            discovered_member_count: 2,
            ignored_file_count: 5,
            complete: false,
        };
        assert_eq!(
            serde_json::to_value(DatasetSessionStatus::Discovering {
                progress: DatasetDiscoveryStatus::from(&progress),
                sample_summary: None,
            })
            .expect("discovering JSON"),
            serde_json::json!({
                "state": "discovering",
                "progress": {
                    "scannedEntryCount": 7,
                    "discoveredMemberCount": 2,
                    "ignoredFileCount": 5,
                },
                "sampleSummary": null,
            })
        );
        assert_eq!(
            serde_json::to_value(DatasetSessionStatus::Inspecting {
                progress: DatasetInspectionStatus {
                    completed_member_count: 2,
                    total_member_count: 4,
                    row_count: 3,
                    row_group_count: 1,
                },
                sample_summary: summary.clone(),
            })
            .expect("inspecting JSON"),
            serde_json::json!({
                "state": "inspecting",
                "progress": {
                    "completedMemberCount": 2,
                    "totalMemberCount": 4,
                    "rowCount": 3,
                    "rowGroupCount": 1,
                },
                "sampleSummary": {
                    "displayName": "sample/",
                    "memberCount": 2,
                    "ignoredFileCount": 1,
                    "sizeBytes": 8,
                    "rowCount": 3,
                    "rowGroupCount": 1,
                    "columnCount": 1,
                    "schema": [],
                    "schemaNodeCount": 0,
                    "schemaIsTruncated": false,
                    "stringsTruncated": false,
                    "schemaDriftMemberCount": 0,
                    "partitionColumnIndices": [],
                    "provenanceColumnIndex": 1,
                },
            })
        );
        assert_eq!(
            serde_json::to_value(DatasetSessionStatus::Ready {
                summary: summary.clone(),
            })
            .expect("ready JSON"),
            serde_json::json!({
                "state": "ready",
                "summary": {
                    "displayName": "sample/",
                    "memberCount": 2,
                    "ignoredFileCount": 1,
                    "sizeBytes": 8,
                    "rowCount": 3,
                    "rowGroupCount": 1,
                    "columnCount": 1,
                    "schema": [],
                    "schemaNodeCount": 0,
                    "schemaIsTruncated": false,
                    "stringsTruncated": false,
                    "schemaDriftMemberCount": 0,
                    "partitionColumnIndices": [],
                    "provenanceColumnIndex": 1,
                },
            })
        );
        assert_eq!(
            serde_json::to_value(DatasetSessionStatus::Failed {
                error: DatasetError::Cancelled,
            })
            .expect("failed JSON"),
            serde_json::json!({
                "state": "failed",
                "error": { "code": "cancelled" },
            })
        );
        assert_eq!(
            serde_json::to_value(DatasetSessionStatus::Failed {
                error: DatasetError::MemberPermissionDenied {
                    member: "partition/private.parquet".to_owned(),
                },
            })
            .expect("member permission JSON"),
            serde_json::json!({
                "state": "failed",
                "error": {
                    "code": "memberPermissionDenied",
                    "member": "partition/private.parquet",
                },
            })
        );
        assert_eq!(
            serde_json::to_value(DatasetSessionStatus::Failed {
                error: DatasetError::DuplicatePartitionKey {
                    key: "year".to_owned(),
                    member: "year=2026/year=2025/part.parquet".to_owned(),
                },
            })
            .expect("duplicate partition key JSON"),
            serde_json::json!({
                "state": "failed",
                "error": {
                    "code": "duplicatePartitionKey",
                    "key": "year",
                    "member": "year=2026/year=2025/part.parquet",
                },
            })
        );

        let sample = serde_json::to_value(DatasetSessionStatus::Discovering {
            progress: DatasetDiscoveryStatus::from(&progress),
            sample_summary: Some(summary),
        })
        .expect("sample JSON");
        assert_eq!(sample["state"], "discovering");
        assert_eq!(sample["sampleSummary"]["memberCount"], 2);
    }

    #[test]
    fn dataset_ready_status_bounds_wide_schema_on_the_wire() {
        let full_schema = (0..300)
            .map(|index| SchemaField {
                name: format!("column_{index}"),
                physical_type: "INT64".to_owned(),
                logical_type: None,
                children: Vec::new(),
            })
            .collect::<Vec<_>>();
        let status = DatasetSummaryStatus {
            display_name: "wide/".to_owned(),
            member_count: 1,
            ignored_file_count: 0,
            size_bytes: 1,
            row_count: 1,
            row_group_count: 1,
            column_count: 300,
            schema: bounded_wire_schema_with_marker(&full_schema).0,
            schema_node_count: full_schema.len(),
            schema_is_truncated: true,
            strings_truncated: false,
            schema_drift_member_count: 0,
            partition_column_indices: Vec::new(),
            provenance_column_index: 300,
        };
        let value = serde_json::to_value(status).expect("dataset status JSON");

        assert_eq!(value["schema"].as_array().map(Vec::len), Some(256));
        assert_eq!(value["schemaNodeCount"], 300);
        assert_eq!(value["columnCount"], 300);
        assert_eq!(value["schemaIsTruncated"], true);
    }

    #[test]
    fn dataset_wire_schema_marks_long_utf8_names_as_truncated() {
        let mut schema = (0..256)
            .map(|index| SchemaField {
                name: format!("column_{index}"),
                physical_type: "INT64".to_owned(),
                logical_type: None,
                children: Vec::new(),
            })
            .collect::<Vec<_>>();
        schema.push(SchemaField {
            name: "late".to_owned(),
            physical_type: "GROUP".to_owned(),
            logical_type: None,
            children: vec![SchemaField {
                name: "д".repeat(100),
                physical_type: "BYTE_ARRAY".to_owned(),
                logical_type: Some("STRING".to_owned()),
                children: Vec::new(),
            }],
        });

        let (bounded, strings_truncated) = bounded_wire_schema_with_marker(&schema);

        assert!(strings_truncated);
        assert_eq!(bounded.len(), 256);
    }

    pub(crate) fn write_test_parquet(path: &std::path::Path, values: &[i64]) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "value",
            DataType::Int64,
            false,
        )]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![Arc::new(Int64Array::from(values.to_vec()))],
        )
        .expect("test batch");
        let file = fs::File::create(path).expect("test Parquet file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("test Parquet writer");
        writer.write(&batch).expect("test Parquet rows");
        writer.close().expect("test Parquet footer");
    }
}
