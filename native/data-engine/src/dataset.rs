//! Parquet datasets with fixed membership and bounded windows.

mod member_catalog;

use std::{
    any::Any,
    collections::HashMap,
    fs,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::SystemTime,
};

use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray, UInt32Array, UInt64Array};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use arrow_select::take::take;
use duckdb::{
    Config, Connection, Error as DuckDbError, InterruptHandle, appender_params_from_iter,
    params_from_iter, types::Value,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as _;
use tempfile::{NamedTempFile, TempDir, TempPath};
use thiserror::Error;

use parquet::arrow::{
    ArrowWriter, ProjectionMask,
    arrow_reader::{
        ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder, RowSelection,
    },
    parquet_to_arrow_schema_by_columns,
};
use parquet::file::metadata::PageIndexPolicy;

#[cfg(windows)]
use crate::source::windows_file_identity;

use crate::{
    DataFilter, DataFilterOperator, FieldPath, SchemaField,
    field_path::{
        field_path_expression, project_arrow_field_paths, resolve_field_path, validate_field_paths,
    },
    filter::{EMPTY_COLUMN_ALIAS, quote_column_alias, quote_identifier},
    json_path::{field_is_json, json_schema_sample_expression},
    source::{
        SourceError, SourceSnapshot, SourceSummary, inspect_local_source,
        inspect_local_source_for_dataset,
    },
    window::{DataWindowError, MAX_WINDOW_ROWS, classify_query_error, set_utc_session_timezone},
};
use member_catalog::{CATALOG_PAGE_MEMBERS, MemberCatalog, MemberCatalogBuilder};

#[cfg(test)]
use std::sync::atomic::AtomicUsize;

const MAX_MEMBER_PAGE_SIZE: u32 = 256;
const MAX_PREVIEW_MEMBERS: u64 = 32;
const MAX_PREVIEW_COLUMNS: usize = 256;
const MAX_PARTITION_DEPTH: usize = 256;
const MAX_DATASET_SCHEMA_NODES: usize = 4_096;
const MAX_DATASET_SCHEMA_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_EXPORT_SPARSE_ROWS: usize = 8_192;
pub(crate) const MAX_EXPORT_SPARSE_MEMBERS: usize = 256;
const DATASET_QUERY_MEMORY_LIMIT: &str = "384MB";
const PROVENANCE_COLUMN: &str = "file";
const HIVE_DEFAULT_PARTITION: &str = "__HIVE_DEFAULT_PARTITION__";

#[cfg(test)]
static SPARSE_SOURCE_ROW_GROUP_READS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static SPARSE_SOURCE_DECODED_ROWS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static SPARSE_SOURCE_COUNTER_LOCK: Mutex<()> = Mutex::new(());

/// A Hive partition key and its text value for one member.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionValue {
    /// Column name derived from a `key=value` directory component.
    pub key: String,
    /// Text after the first equals sign in that component.
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartitionColumnKind {
    Text,
    Int64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PartitionColumn {
    name: String,
    kind: PartitionColumnKind,
}

impl PartitionColumn {
    fn query_value<'a>(&self, raw: &'a str) -> Option<PartitionScalar<'a>> {
        if raw == HIVE_DEFAULT_PARTITION {
            return None;
        }
        Some(match self.kind {
            PartitionColumnKind::Text => PartitionScalar::Text(raw),
            PartitionColumnKind::Int64 => PartitionScalar::Int64(canonical_partition_i64(raw)?),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartitionScalar<'a> {
    Text(&'a str),
    Int64(i64),
}

#[derive(Debug, Clone)]
struct DatasetMember {
    ordinal: u64,
    path: PathBuf,
    relative_path: String,
    partitions: Vec<PartitionValue>,
    identity: MemberIdentity,
    row_count: Option<u64>,
}

#[derive(Debug, Clone)]
struct CachedDatasetFooter {
    identity: MemberIdentity,
    summary: SourceSummary,
    arrow_schema: Schema,
}

type DatasetFooterCache = Arc<Mutex<Vec<CachedDatasetFooter>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MemberIdentity {
    size_bytes: u64,
    modified: Option<SystemTime>,
    platform: PlatformFileIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlatformFileIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows {
        volume_serial_number: u64,
        file_id: [u8; 16],
    },
    #[cfg(not(any(unix, windows)))]
    Unavailable,
}

/// One bounded member-list item suitable for Structure or source details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMemberSummary {
    /// Stable zero-based position in the dataset's fixed member composition.
    pub ordinal: u64,
    /// Stable slash-separated path relative to the dataset's logical root.
    pub relative_path: String,
    /// Hive values derived from the member's parent directories.
    pub partitions: Vec<PartitionValue>,
}

/// One selected fixed member and its retained footer snapshot.
pub struct DatasetMemberSnapshot {
    snapshot: SourceSnapshot,
    source: DatasetSource,
    member: DatasetMember,
}

impl DatasetMemberSnapshot {
    /// Returns the retained footer snapshot used by Structure.
    pub fn snapshot(&self) -> &SourceSnapshot {
        &self.snapshot
    }

    /// Rechecks the selected catalog member and its retained snapshot.
    pub fn validate(&self) -> Result<(), DatasetError> {
        self.validate_while(|| true)
    }

    /// Rechecks the selected member while the caller still wants the work.
    pub fn validate_while(&self, mut keep_going: impl FnMut() -> bool) -> Result<(), DatasetError> {
        self.source.require_active()?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.source.ensure_member_unchanged(&self.member)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.snapshot
            .validate_for_install(&self.member.path)
            .map_err(|error| self.source.latch_member_error(error, &self.member))?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        Ok(())
    }
}

/// A bounded page of dataset members.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMemberPage {
    /// Zero-based member offset of this page.
    pub offset: u64,
    /// Total member count in the fixed composition.
    pub total: u64,
    /// Members in stable lexicographic path order.
    pub members: Vec<DatasetMemberSummary>,
}

/// One immediate child in a dataset's Hive partition tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetPartitionNode {
    /// Hive key and value represented by this tree node.
    pub partition: PartitionValue,
    /// Fixed-composition members below this node.
    pub member_count: u64,
}

/// A cursor-bounded page of immediate Hive partition children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetPartitionPage {
    /// Children ordered by ASCII-case-insensitive key, then exact value.
    pub nodes: Vec<DatasetPartitionNode>,
    /// Cursor to pass as `after` when more children are available.
    pub next_after: Option<PartitionValue>,
}

/// Aggregate facts produced by an incremental footer pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    /// Dataset label with the marker expected by source switchers.
    pub display_name: String,
    /// Files in the fixed dataset composition.
    pub member_count: u64,
    /// Files excluded from membership during discovery.
    pub ignored_file_count: u64,
    /// Sum of member sizes captured at open time.
    pub size_bytes: u64,
    /// Sum of rows recorded in member footers.
    pub row_count: u64,
    /// Sum of row groups recorded in member footers.
    pub row_group_count: u64,
    /// Physical union schema followed by uniquely named Hive and provenance columns.
    pub schema: Vec<SchemaField>,
    /// Members whose physical schema differs from the first member.
    pub schema_drift_member_count: u64,
    /// Indices of Hive columns available for exact member pruning.
    pub partition_column_indices: Vec<u32>,
    /// Index of the virtual provenance column, hidden by default by consumers.
    pub provenance_column_index: u32,
}

/// Stable dataset failures that can cross the data-engine boundary.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DatasetError {
    /// The dataset source cannot be found.
    #[error("The selected dataset source no longer exists.")]
    NotFound,
    /// The operating system denied source or member access.
    #[error("Viewda does not have permission to read the selected dataset source.")]
    PermissionDenied,
    /// Discovery found no supported member.
    #[error("The selected source does not contain any Parquet files.")]
    NoParquetFiles,
    /// A requested dataset page exceeds the bounded protocol limit.
    #[error("The requested dataset page is too large.")]
    PageTooLarge,
    /// One incremental footer step exceeds the bounded protocol limit.
    #[error("The requested dataset inspection step is too large.")]
    InspectionStepTooLarge,
    /// The caller cancelled incremental footer inspection.
    #[error("The dataset inspection was cancelled.")]
    Cancelled,
    /// A member schema cannot be reconciled with earlier members.
    #[error("Column '{column}' has an incompatible type in member '{member}'.")]
    SchemaConflict { column: String, member: String },
    /// A fixed member disappeared or changed after the dataset opened.
    #[error("Dataset member '{member}' changed on disk. Reload the dataset to continue.")]
    SourceChanged { member: String },
    /// A named member cannot be decoded.
    #[error("Dataset member '{member}' is damaged or unsupported.")]
    InvalidMember { member: String },
    /// The operating system denied access to one named member.
    #[error("Viewda does not have permission to read dataset member '{member}'.")]
    MemberPermissionDenied { member: String },
    /// One member repeats a case-insensitive Hive partition key.
    #[error("Dataset member '{member}' repeats Hive partition key '{key}'.")]
    DuplicatePartitionKey { key: String, member: String },
    /// A bounded query failed under the existing data-window contract.
    #[error("{error}")]
    Window { error: DataWindowError },
    /// The source shape or its paths cannot be represented safely.
    #[error("This dataset source is not supported.")]
    Unsupported,
}

impl From<DataWindowError> for DatasetError {
    fn from(error: DataWindowError) -> Self {
        Self::Window { error }
    }
}

/// One bounded update while the fixed dataset composition is being discovered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetDiscoveryProgress {
    /// Directory entries or explicit paths consumed by this open request.
    pub scanned_entry_count: u64,
    /// Parquet members captured in the disk-backed catalog so far.
    pub discovered_member_count: u64,
    /// Non-member files observed so far for a folder source.
    pub ignored_file_count: u64,
    /// Whether discovery reached its input boundary and the catalog can be frozen.
    pub complete: bool,
}

enum DatasetDiscoveryInput<'a> {
    Folder(FolderDiscovery),
    Explicit(Box<dyn Iterator<Item = Result<PathBuf, DatasetError>> + Send + 'a>),
}

enum DatasetDiscoveryEntry {
    Folder(Box<fs::DirEntry>),
    Explicit(PathBuf),
}

impl DatasetDiscoveryInput<'_> {
    fn next_entry(&mut self) -> Result<Option<DatasetDiscoveryEntry>, DatasetError> {
        match self {
            Self::Folder(discovery) => discovery
                .next_entry()
                .map(|entry| entry.map(Box::new).map(DatasetDiscoveryEntry::Folder)),
            Self::Explicit(paths) => paths
                .next()
                .transpose()
                .map(|path| path.map(DatasetDiscoveryEntry::Explicit)),
        }
    }

    fn descend(&mut self, path: &Path) -> Result<(), DatasetError> {
        let Self::Folder(discovery) = self else {
            return Err(DatasetError::Unsupported);
        };
        discovery.descend(path)
    }
}

struct FolderDiscovery {
    directories: Vec<fs::ReadDir>,
}

impl FolderDiscovery {
    fn new(root: &Path) -> Result<Self, DatasetError> {
        Ok(Self {
            directories: vec![fs::read_dir(root).map_err(map_discovery_error)?],
        })
    }

    fn next_entry(&mut self) -> Result<Option<fs::DirEntry>, DatasetError> {
        loop {
            let Some(directory) = self.directories.last_mut() else {
                return Ok(None);
            };
            match directory.next() {
                Some(entry) => return entry.map(Some).map_err(map_discovery_error),
                None => {
                    self.directories.pop();
                }
            }
        }
    }

    fn descend(&mut self, path: &Path) -> Result<(), DatasetError> {
        if self.directories.len() >= MAX_PARTITION_DEPTH {
            return Err(DatasetError::Unsupported);
        }
        self.directories
            .push(fs::read_dir(path).map_err(map_discovery_error)?);
        Ok(())
    }
}

/// Incrementally discovers one immutable dataset composition into a disk-backed catalog.
pub struct DatasetDiscovery<'a> {
    display_name: Option<String>,
    logical_root: PathBuf,
    root: PathBuf,
    input: DatasetDiscoveryInput<'a>,
    catalog: Option<MemberCatalogBuilder>,
    preview_members: Vec<DatasetMember>,
    footer_cache: DatasetFooterCache,
    #[cfg(test)]
    footer_reads: Arc<std::sync::atomic::AtomicU64>,
    #[cfg(test)]
    identity_checks: Arc<std::sync::atomic::AtomicU64>,
    preview_taken: bool,
    preview_candidate_member_count: usize,
    scanned_entry_count: u64,
    ignored_file_count: u64,
    complete: bool,
}

impl DatasetDiscovery<'_> {
    /// Consumes at most `entry_budget` directory entries or explicit paths.
    pub fn advance(&mut self, entry_budget: u32) -> Result<DatasetDiscoveryProgress, DatasetError> {
        self.advance_while(entry_budget, || true)
    }

    /// Advances discovery while the owning open request remains active.
    pub fn advance_while(
        &mut self,
        entry_budget: u32,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetDiscoveryProgress, DatasetError> {
        if entry_budget > MAX_MEMBER_PAGE_SIZE {
            return Err(DatasetError::PageTooLarge);
        }
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        if entry_budget == 0 || self.complete {
            return self.progress();
        }
        for _ in 0..entry_budget {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            let Some(entry) = self.input.next_entry()? else {
                self.complete = true;
                break;
            };
            self.scanned_entry_count = self
                .scanned_entry_count
                .checked_add(1)
                .ok_or(DatasetError::Unsupported)?;
            let member = match entry {
                DatasetDiscoveryEntry::Folder(entry) => {
                    let file_type = entry.file_type().map_err(map_discovery_error)?;
                    let path = entry.path();
                    if file_type.is_dir() {
                        self.input.descend(&path)?;
                        None
                    } else if file_type.is_file() && is_visible_parquet_path(&self.root, &path) {
                        Some(folder_dataset_member(&self.root, path, entry.as_ref())?)
                    } else {
                        if file_type.is_file()
                            || (file_type.is_symlink()
                                && is_visible_parquet_path(&self.root, &path))
                        {
                            self.ignored_file_count = self
                                .ignored_file_count
                                .checked_add(1)
                                .ok_or(DatasetError::Unsupported)?;
                        }
                        None
                    }
                }
                DatasetDiscoveryEntry::Explicit(path) => {
                    Some(explicit_dataset_member(&self.root, path)?)
                }
            };
            if let Some(member) = member {
                if !self.preview_taken && self.preview_members.len() < MAX_PREVIEW_MEMBERS as usize
                {
                    self.preview_members.push(member.clone());
                }
                self.catalog
                    .as_mut()
                    .ok_or(DatasetError::Unsupported)?
                    .push(member)?;
            }
        }
        self.progress()
    }

    /// Builds the next larger bounded early-sample candidate without consuming discovery state.
    pub fn next_preview_candidate(&mut self) -> Result<Option<DatasetSource>, DatasetError> {
        if self.preview_taken
            || self.preview_members.is_empty()
            || self.preview_members.len() == self.preview_candidate_member_count
        {
            return Ok(None);
        }
        self.preview_candidate_member_count = self.preview_members.len();
        let mut catalog = MemberCatalogBuilder::new()?;
        for member in &self.preview_members {
            catalog.push(member.clone())?;
        }
        let catalog = catalog.finish_while(|| true)?;
        let member_count = catalog.member_count();
        Ok(Some(DatasetSource {
            display_name: self.resolved_display_name(member_count),
            ignored_file_count: 0,
            logical_root: self.logical_root.clone(),
            root: self.root.clone(),
            catalog: Arc::new(catalog),
            latched_error: Arc::new(Mutex::new(None)),
            footer_cache: Arc::clone(&self.footer_cache),
            cache_footer_results: true,
            #[cfg(test)]
            footer_reads: Arc::clone(&self.footer_reads),
            #[cfg(test)]
            identity_checks: Arc::clone(&self.identity_checks),
        }))
    }

    /// Commits a candidate once it contains rows or exhausts the bounded member search.
    pub fn commit_preview_candidate(
        &mut self,
        preview: &DatasetPreview,
    ) -> Result<bool, DatasetError> {
        if self.preview_taken
            || self.preview_candidate_member_count == 0
            || preview.progress.total_member_count
                != u64::try_from(self.preview_candidate_member_count)
                    .map_err(|_| DatasetError::Unsupported)?
        {
            return Err(DatasetError::Unsupported);
        }
        if preview.progress.row_count == 0
            && preview.progress.completed_member_count < MAX_PREVIEW_MEMBERS
            && !self.complete
        {
            return Ok(false);
        }
        self.preview_taken = true;
        self.preview_members.clear();
        Ok(true)
    }

    /// Assigns deterministic ordinals and freezes the completed composition.
    pub fn into_source(self) -> Result<DatasetSource, DatasetError> {
        self.into_source_while(|| true)
    }

    /// Freezes the composition while the owning open request remains active.
    pub fn into_source_while(
        mut self,
        keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetSource, DatasetError> {
        if !self.complete {
            return Err(DatasetError::Unsupported);
        }
        let catalog = self
            .catalog
            .take()
            .ok_or(DatasetError::Unsupported)?
            .finish_while(keep_going)?;
        if catalog.member_count() == 0 {
            return Err(DatasetError::NoParquetFiles);
        }
        let member_count = catalog.member_count();
        let display_name = self.resolved_display_name(member_count);
        Ok(DatasetSource {
            display_name,
            ignored_file_count: self.ignored_file_count,
            logical_root: self.logical_root,
            root: self.root,
            catalog: Arc::new(catalog),
            latched_error: Arc::new(Mutex::new(None)),
            footer_cache: self.footer_cache,
            cache_footer_results: false,
            #[cfg(test)]
            footer_reads: self.footer_reads,
            #[cfg(test)]
            identity_checks: self.identity_checks,
        })
    }

    /// Returns cumulative discovery counters without consuming another input entry.
    pub fn progress(&self) -> Result<DatasetDiscoveryProgress, DatasetError> {
        Ok(DatasetDiscoveryProgress {
            scanned_entry_count: self.scanned_entry_count,
            discovered_member_count: self
                .catalog
                .as_ref()
                .ok_or(DatasetError::Unsupported)?
                .member_count()?,
            ignored_file_count: self.ignored_file_count,
            complete: self.complete,
        })
    }

    fn resolved_display_name(&self, member_count: u64) -> String {
        self.display_name
            .clone()
            .unwrap_or_else(|| format!("{member_count} files/"))
    }
}

/// One fixed dataset snapshot. Membership changes only when the caller opens it again.
#[derive(Debug, Clone)]
pub struct DatasetSource {
    display_name: String,
    ignored_file_count: u64,
    logical_root: PathBuf,
    root: PathBuf,
    catalog: Arc<MemberCatalog>,
    latched_error: Arc<Mutex<Option<DatasetError>>>,
    footer_cache: DatasetFooterCache,
    cache_footer_results: bool,
    #[cfg(test)]
    footer_reads: Arc<std::sync::atomic::AtomicU64>,
    #[cfg(test)]
    identity_checks: Arc<std::sync::atomic::AtomicU64>,
}

impl DatasetSource {
    /// Begins a folder open without enumerating its directory entries.
    pub fn begin_folder(root: &Path) -> Result<DatasetDiscovery<'static>, DatasetError> {
        let logical_root = std::path::absolute(root).map_err(map_discovery_error)?;
        logical_root.to_str().ok_or(DatasetError::Unsupported)?;
        let metadata = fs::metadata(&logical_root).map_err(map_discovery_error)?;
        if !metadata.is_dir() {
            return Err(DatasetError::Unsupported);
        }
        let display_name = logical_root
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .ok_or(DatasetError::Unsupported)?;
        let root = query_compatible_canonical_path(
            fs::canonicalize(&logical_root).map_err(map_discovery_error)?,
        )?;
        root.to_str().ok_or(DatasetError::Unsupported)?;
        Ok(DatasetDiscovery {
            display_name: Some(format!("{display_name}/")),
            input: DatasetDiscoveryInput::Folder(FolderDiscovery::new(&root)?),
            logical_root,
            root,
            catalog: Some(MemberCatalogBuilder::new()?),
            preview_members: Vec::with_capacity(MAX_PREVIEW_MEMBERS as usize),
            footer_cache: Arc::new(Mutex::new(Vec::with_capacity(MAX_PREVIEW_MEMBERS as usize))),
            #[cfg(test)]
            footer_reads: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            identity_checks: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            preview_taken: false,
            preview_candidate_member_count: 0,
            scanned_entry_count: 0,
            ignored_file_count: 0,
            complete: false,
        })
    }

    /// Begins a streamed explicit selection without consuming its paths.
    pub fn begin_file_selection<'a, I>(
        root: &Path,
        paths: I,
    ) -> Result<DatasetDiscovery<'a>, DatasetError>
    where
        I: IntoIterator<Item = Result<PathBuf, DatasetError>>,
        I::IntoIter: Send + 'a,
    {
        let mut root = std::path::absolute(root).map_err(map_discovery_error)?;
        while root
            .file_name()
            .and_then(|component| component.to_str())
            .is_some_and(is_hive_partition_component)
        {
            if !root.pop() {
                return Err(DatasetError::Unsupported);
            }
        }
        root.to_str().ok_or(DatasetError::Unsupported)?;
        let display_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .map(|name| format!("{name}/"));
        Ok(DatasetDiscovery {
            display_name,
            logical_root: root.clone(),
            root,
            input: DatasetDiscoveryInput::Explicit(Box::new(paths.into_iter())),
            catalog: Some(MemberCatalogBuilder::new()?),
            preview_members: Vec::with_capacity(MAX_PREVIEW_MEMBERS as usize),
            footer_cache: Arc::new(Mutex::new(Vec::with_capacity(MAX_PREVIEW_MEMBERS as usize))),
            #[cfg(test)]
            footer_reads: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            identity_checks: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            preview_taken: false,
            preview_candidate_member_count: 0,
            scanned_entry_count: 0,
            ignored_file_count: 0,
            complete: false,
        })
    }

    /// Discovers supported members without reading any Parquet footer.
    pub fn open_folder(root: &Path) -> Result<Self, DatasetError> {
        Self::open_folder_cancellable(root, || true)
    }

    /// Discovers a folder while polling cancellation between filesystem and catalog batches.
    pub fn open_folder_cancellable(
        root: &Path,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DatasetError> {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let mut discovery = Self::begin_folder(root)?;
        loop {
            let progress = discovery.advance_while(MAX_MEMBER_PAGE_SIZE, &mut keep_going)?;
            if progress.complete {
                break;
            }
        }
        discovery.into_source_while(keep_going)
    }

    /// Opens an explicit fixed set after deriving one common logical root.
    ///
    /// Logical absolute paths determine provenance, Hive values, and lexicographic
    /// order. Canonical targets determine reads, identities, and duplicate rejection.
    pub fn open_files(paths: &[PathBuf]) -> Result<Self, DatasetError> {
        Self::open_files_cancellable(paths, || true)
    }

    /// Opens explicit files while polling cancellation between members and catalog batches.
    pub fn open_files_cancellable(
        paths: &[PathBuf],
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DatasetError> {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        if paths.is_empty() {
            return Err(DatasetError::NoParquetFiles);
        }
        let root = explicit_common_parent(paths, &mut keep_going)?;
        Self::open_file_selection_cancellable(&root, paths.iter().cloned().map(Ok), keep_going)
    }

    /// Opens a streamed explicit selection rooted at `root` without collecting its paths.
    pub fn open_file_selection_cancellable<I>(
        root: &Path,
        paths: I,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DatasetError>
    where
        I: IntoIterator<Item = Result<PathBuf, DatasetError>>,
        I::IntoIter: Send,
    {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let mut discovery = Self::begin_file_selection(root, paths)?;
        loop {
            let progress = discovery.advance_while(MAX_MEMBER_PAGE_SIZE, &mut keep_going)?;
            if progress.complete {
                break;
            }
        }
        discovery.into_source_while(keep_going)
    }

    /// Dataset label with a trailing slash.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Number of members captured at open time.
    pub fn member_count(&self) -> u64 {
        self.catalog.member_count()
    }

    #[cfg(test)]
    fn footer_read_count(&self) -> u64 {
        self.footer_reads.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn identity_check_count(&self) -> u64 {
        self.identity_checks.load(Ordering::Relaxed)
    }

    /// Number of files excluded from membership at open time.
    pub fn ignored_file_count(&self) -> u64 {
        self.ignored_file_count
    }

    /// Returns a bounded page without exposing absolute filesystem paths.
    pub fn member_page(&self, offset: u64, limit: u32) -> Result<DatasetMemberPage, DatasetError> {
        if limit > MAX_MEMBER_PAGE_SIZE {
            return Err(DatasetError::PageTooLarge);
        }
        let members = self
            .catalog
            .page(offset.checked_sub(1), limit)?
            .members
            .into_iter()
            .map(|member| DatasetMemberSummary {
                ordinal: member.ordinal,
                relative_path: member.relative_path,
                partitions: member.partitions,
            })
            .collect();
        Ok(DatasetMemberPage {
            offset,
            total: self.member_count(),
            members,
        })
    }

    /// Returns immediate Hive children below an exact parent chain.
    ///
    /// Parent keys are matched without ASCII case sensitivity and values are
    /// matched exactly. Pass `next_after` from one page as `after` for the next.
    pub fn partition_page(
        &self,
        parent: &[PartitionValue],
        after: Option<&PartitionValue>,
        limit: u32,
    ) -> Result<DatasetPartitionPage, DatasetError> {
        if limit > MAX_MEMBER_PAGE_SIZE || parent.len() > MAX_PARTITION_DEPTH {
            return Err(DatasetError::PageTooLarge);
        }
        self.catalog.partition_page(parent, after, limit)
    }

    /// Creates a cancellable footer inspector that advances by a bounded member budget.
    pub fn inspector(&self) -> DatasetInspector {
        DatasetInspector::new(self.clone())
    }

    fn ensure_member_unchanged(&self, member: &DatasetMember) -> Result<(), DatasetError> {
        self.require_active()?;
        #[cfg(test)]
        self.identity_checks.fetch_add(1, Ordering::Relaxed);
        let metadata = fs::metadata(&member.path)
            .map_err(|error| self.latch_member_io_error(error, member))?;
        let identity = member_identity(&member.path, &metadata)
            .map_err(|error| self.latch_member_io_error(error, member))?;
        if !metadata.is_file() || identity != member.identity {
            return Err(self.latch_source_changed(&member.relative_path));
        }
        Ok(())
    }

    fn ensure_all_members_unchanged_while(
        &self,
        keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        self.ensure_member_prefix_unchanged_while(self.member_count(), keep_going)
    }

    fn ensure_members_unchanged_while(
        &self,
        members: &[DatasetMember],
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        for member in members {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            self.ensure_member_unchanged(member)?;
        }
        Ok(())
    }

    fn ensure_member_prefix_unchanged_while(
        &self,
        limit: u64,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        let mut after = None;
        loop {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            let page = self.catalog.page(after, CATALOG_PAGE_MEMBERS)?;
            for member in page
                .members
                .iter()
                .take_while(|member| member.ordinal < limit)
            {
                if !keep_going() {
                    return Err(DatasetError::Cancelled);
                }
                self.ensure_member_unchanged(member)?;
            }
            let Some(next) = page.next_ordinal.filter(|next| *next < limit) else {
                return Ok(());
            };
            after = Some(next);
        }
    }

    fn member(&self, ordinal: u64) -> Result<DatasetMember, DatasetError> {
        self.catalog
            .member(ordinal)?
            .ok_or(DatasetError::Unsupported)
    }

    fn target_matches_member(&self, target: &Path) -> Result<bool, DatasetError> {
        let absolute_target = std::path::absolute(target).map_err(map_target_error)?;
        match fs::metadata(&absolute_target) {
            Ok(metadata) => {
                let canonical_target = query_compatible_canonical_path(
                    fs::canonicalize(&absolute_target).map_err(map_target_error)?,
                )?;
                let platform = platform_file_identity(&absolute_target, &metadata)
                    .map_err(map_target_error)?;
                self.catalog
                    .contains_target(&canonical_target, Some(&platform))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.catalog.contains_target(&absolute_target, None)
            }
            Err(error) => Err(map_target_error(error)),
        }
    }

    fn require_active(&self) -> Result<(), DatasetError> {
        let latched = self
            .latched_error
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        latched.clone().map_or(Ok(()), Err)
    }

    fn take_cached_footer(
        &self,
        identity: MemberIdentity,
    ) -> Result<Option<(SourceSummary, Schema)>, DatasetError> {
        let mut cache = self
            .footer_cache
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        if self.cache_footer_results {
            return Ok(cache
                .iter()
                .find(|entry| entry.identity == identity)
                .map(|entry| (entry.summary.clone(), entry.arrow_schema.clone())));
        }
        Ok(cache
            .iter()
            .position(|entry| entry.identity == identity)
            .map(|index| cache.swap_remove(index))
            .map(|entry| (entry.summary, entry.arrow_schema)))
    }

    fn cache_footer(
        &self,
        identity: MemberIdentity,
        summary: &SourceSummary,
        arrow_schema: &Schema,
    ) -> Result<(), DatasetError> {
        if !self.cache_footer_results {
            return Ok(());
        }
        let mut cache = self
            .footer_cache
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        if cache.len() < MAX_PREVIEW_MEMBERS as usize
            && !cache.iter().any(|entry| entry.identity == identity)
        {
            cache.push(CachedDatasetFooter {
                identity,
                summary: summary.clone(),
                arrow_schema: arrow_schema.clone(),
            });
        }
        Ok(())
    }

    fn latch_source_changed(&self, member: &str) -> DatasetError {
        self.latch_error(DatasetError::SourceChanged {
            member: member.to_owned(),
        })
    }

    fn latch_member_error(&self, error: SourceError, member: &DatasetMember) -> DatasetError {
        self.latch_error(map_member_error(error, member))
    }

    fn latch_member_io_error(&self, error: std::io::Error, member: &DatasetMember) -> DatasetError {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            self.latch_error(DatasetError::MemberPermissionDenied {
                member: member.relative_path.clone(),
            })
        } else {
            self.latch_source_changed(&member.relative_path)
        }
    }

    fn latch_invalid_member(&self, member: &DatasetMember) -> DatasetError {
        self.latch_error(DatasetError::InvalidMember {
            member: member.relative_path.clone(),
        })
    }

    fn latch_error(&self, error: DatasetError) -> DatasetError {
        let Ok(mut latched) = self.latched_error.lock() else {
            return DatasetError::Unsupported;
        };
        latched.get_or_insert(error).clone()
    }
}

fn map_target_error(error: std::io::Error) -> DatasetError {
    match error.kind() {
        std::io::ErrorKind::NotFound => DatasetError::NotFound,
        std::io::ErrorKind::PermissionDenied => DatasetError::PermissionDenied,
        _ => DatasetError::Unsupported,
    }
}

/// One bounded update from incremental dataset inspection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInspectionProgress {
    /// Member footers processed so far.
    pub completed_member_count: u64,
    /// Members in the fixed composition.
    pub total_member_count: u64,
    /// Rows accumulated from completed footers.
    pub row_count: u64,
    /// Row groups accumulated from completed footers.
    pub row_group_count: u64,
    /// First incomplete visible schema reported by this inspector; final schema is in `summary`.
    pub schema: Option<Vec<SchemaField>>,
    /// Whether every member contributed to this schema.
    pub schema_complete: bool,
    /// Final facts once every footer has been released.
    pub summary: Option<DatasetSummary>,
}

/// Thread-safe cancellation for an incremental footer pass.
#[derive(Debug, Clone)]
pub struct DatasetInspectionInterruptHandle {
    cancelled: Arc<AtomicBool>,
}

impl DatasetInspectionInterruptHandle {
    /// Cancels between member footers; an active local footer read finishes first.
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

/// Incrementally merges member footers while retaining only aggregate schema and counts.
pub struct DatasetInspector {
    source: DatasetSource,
    next_member: u64,
    union_schema: Vec<SchemaField>,
    first_schema: Option<Vec<SchemaField>>,
    partition_columns: Vec<PartitionColumn>,
    partition_columns_loaded: bool,
    size_bytes: u64,
    row_count: u64,
    row_group_count: u64,
    drift_count: u64,
    initial_schema_reported: bool,
    preview_reader: Option<DatasetWindowReader>,
    cancelled: Arc<AtomicBool>,
    footer_cache: Option<(MemberIdentity, SourceSummary, Schema)>,
    union_arrow_schema: Option<Schema>,
}

impl DatasetInspector {
    fn new(source: DatasetSource) -> Self {
        Self {
            source,
            next_member: 0,
            union_schema: Vec::new(),
            first_schema: None,
            partition_columns: Vec::new(),
            partition_columns_loaded: false,
            size_bytes: 0,
            row_count: 0,
            row_group_count: 0,
            drift_count: 0,
            initial_schema_reported: false,
            preview_reader: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            footer_cache: None,
            union_arrow_schema: None,
        }
    }

    /// Returns a handle that can cancel the next or active inspection step.
    pub fn interrupt_handle(&self) -> DatasetInspectionInterruptHandle {
        DatasetInspectionInterruptHandle {
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Reads a bounded fixed early sample and keeps its query session for completion.
    pub fn preview(&mut self, row_count: u32) -> Result<DatasetPreview, DatasetError> {
        self.preview_while(row_count, || true)
    }

    /// Reads a bounded fixed early sample while the owning open request remains current.
    pub fn preview_while(
        &mut self,
        row_count: u32,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetPreview, DatasetError> {
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        if self.next_member != 0 || self.preview_reader.is_some() {
            return Err(DatasetError::Unsupported);
        }
        let progress = loop {
            let progress = self.advance_while(1, &mut keep_going)?;
            if progress.row_count > 0
                || progress.schema_complete
                || progress.completed_member_count >= MAX_PREVIEW_MEMBERS
            {
                break progress;
            }
        };
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let summary = self.current_summary()?;
        let member_limit =
            usize::try_from(self.next_member).map_err(|_| DatasetError::Unsupported)?;
        let arrow_schema = self.current_arrow_schema(&summary)?;
        let mut reader = DatasetWindowReader::from_parts(
            self.source.clone(),
            summary,
            self.partition_columns.clone(),
            arrow_schema,
            Some(member_limit),
        )?;
        let projection = reader.summary.schema
            [..reader.summary.schema.len().min(MAX_PREVIEW_COLUMNS)]
            .iter()
            .map(|field| FieldPath::from(field.name.as_str()))
            .collect::<Vec<_>>();
        let arrow_ipc = reader.fetch_fields_while(0, row_count, &projection, &mut keep_going)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.preview_reader = Some(reader);
        Ok(DatasetPreview {
            progress,
            arrow_ipc,
        })
    }

    /// Transfers the fixed early-sample reader used for windows during inspection.
    pub fn take_preview_reader(&mut self) -> Result<DatasetWindowReader, DatasetError> {
        self.preview_reader.take().ok_or(DatasetError::Unsupported)
    }

    /// Reads at most `member_budget` footers and returns current aggregate facts.
    pub fn advance(
        &mut self,
        member_budget: u32,
    ) -> Result<DatasetInspectionProgress, DatasetError> {
        self.advance_while(member_budget, || true)
    }

    /// Reads a bounded footer batch while the owning request remains current.
    pub fn advance_while(
        &mut self,
        member_budget: u32,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetInspectionProgress, DatasetError> {
        if member_budget == 0 || member_budget > MAX_MEMBER_PAGE_SIZE {
            return Err(DatasetError::InspectionStepTooLarge);
        }
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        if !self.partition_columns_loaded {
            self.partition_columns = self.source.catalog.partition_columns()?;
            self.partition_columns_loaded = true;
        }
        self.source.require_active()?;
        let end = self
            .next_member
            .saturating_add(u64::from(member_budget))
            .min(self.source.member_count());
        let page = self.source.catalog.page(
            self.next_member.checked_sub(1),
            u32::try_from(end - self.next_member).map_err(|_| DatasetError::Unsupported)?,
        )?;
        let mut inspection_facts = Vec::with_capacity(page.members.len());
        for member in page.members {
            if self.cancelled.load(Ordering::Acquire) || !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            if member.ordinal != self.next_member {
                return Err(DatasetError::Unsupported);
            }
            self.source.ensure_member_unchanged(&member)?;
            let (member_summary, member_arrow_schema, read_footer) =
                if let Some((_, summary, arrow_schema)) = self
                    .footer_cache
                    .as_ref()
                    .filter(|(identity, _, _)| *identity == member.identity)
                {
                    (summary.clone(), arrow_schema.clone(), false)
                } else if let Some((summary, arrow_schema)) =
                    self.source.take_cached_footer(member.identity)?
                {
                    (summary, arrow_schema, false)
                } else {
                    let (summary, arrow_schema) = inspect_local_source_for_dataset(&member.path)
                        .map_err(|error| self.source.latch_member_error(error, &member))?;
                    #[cfg(test)]
                    self.source.footer_reads.fetch_add(1, Ordering::Relaxed);
                    if !keep_going() {
                        return Err(DatasetError::Cancelled);
                    }
                    (summary, arrow_schema, true)
                };
            self.footer_cache = Some((
                member.identity,
                member_summary.clone(),
                member_arrow_schema.clone(),
            ));
            validate_member_schema(&member_summary.schema, &member.relative_path, "")?;
            if read_footer && self.source.cache_footer_results {
                if !keep_going() {
                    return Err(DatasetError::Cancelled);
                }
                self.source.ensure_member_unchanged(&member)?;
                self.source
                    .cache_footer(member.identity, &member_summary, &member_arrow_schema)?;
            }
            self.size_bytes = self
                .size_bytes
                .checked_add(member_summary.size_bytes)
                .ok_or(DatasetError::Unsupported)?;
            self.row_count = self
                .row_count
                .checked_add(member_summary.row_count)
                .ok_or(DatasetError::Unsupported)?;
            self.row_group_count = self
                .row_group_count
                .checked_add(member_summary.row_group_count as u64)
                .ok_or(DatasetError::Unsupported)?;
            let schema_drift = self
                .first_schema
                .as_ref()
                .is_some_and(|first| first != &member_summary.schema);
            let drift_rank = if schema_drift {
                let rank = self.drift_count;
                self.drift_count += 1;
                Some(rank)
            } else if self.first_schema.is_none() {
                self.first_schema = Some(member_summary.schema.clone());
                None
            } else {
                None
            };
            inspection_facts.push((self.next_member, member_summary.row_count, drift_rank));
            merge_schema(
                &mut self.union_schema,
                member_summary.schema,
                &member.relative_path,
            )?;
            self.union_arrow_schema = Some(match self.union_arrow_schema.take() {
                Some(schema) => merge_arrow_schemas(schema, member_arrow_schema)?,
                None => member_arrow_schema,
            });
            validate_dataset_schema_bounds(&self.union_schema, &self.partition_columns)?;
            self.next_member += 1;
        }
        self.source
            .catalog
            .record_inspection_batch(&inspection_facts)?;

        let schema_complete = self.next_member == self.source.member_count();
        let emit_initial_schema = !schema_complete && !self.initial_schema_reported;
        if emit_initial_schema {
            self.initial_schema_reported = true;
        }
        let mut progress_schema = None;
        let summary = if schema_complete {
            Some(self.current_summary()?)
        } else {
            if emit_initial_schema {
                progress_schema = Some(self.current_summary()?.schema);
            }
            None
        };
        Ok(DatasetInspectionProgress {
            completed_member_count: self.next_member,
            total_member_count: self.source.member_count(),
            row_count: self.row_count,
            row_group_count: self.row_group_count,
            schema: progress_schema,
            schema_complete,
            summary,
        })
    }

    fn current_summary(&self) -> Result<DatasetSummary, DatasetError> {
        let (schema, partition_column_indices, provenance_column_index) =
            visible_schema(&self.union_schema, &self.partition_columns)?;
        Ok(DatasetSummary {
            display_name: self.source.display_name.clone(),
            member_count: self.source.member_count(),
            ignored_file_count: self.source.ignored_file_count,
            size_bytes: self.size_bytes,
            row_count: self.row_count,
            row_group_count: self.row_group_count,
            schema,
            schema_drift_member_count: self.drift_count,
            partition_column_indices,
            provenance_column_index,
        })
    }

    fn current_arrow_schema(&self, summary: &DatasetSummary) -> Result<SchemaRef, DatasetError> {
        let schema = self
            .union_arrow_schema
            .as_ref()
            .ok_or(DatasetError::Unsupported)?;
        let mut fields = schema.fields.iter().cloned().collect::<Vec<_>>();
        for (column, schema_index) in self
            .partition_columns
            .iter()
            .zip(&summary.partition_column_indices)
        {
            let name = &summary.schema[*schema_index as usize].name;
            let data_type = match column.kind {
                PartitionColumnKind::Text => DataType::Utf8,
                PartitionColumnKind::Int64 => DataType::Int64,
            };
            fields.push(Arc::new(Field::new(name, data_type, true)));
        }
        let provenance = &summary.schema[summary.provenance_column_index as usize].name;
        fields.push(Arc::new(Field::new(provenance, DataType::Utf8, true)));
        Ok(Arc::new(Schema::new_with_metadata(
            fields,
            schema.metadata.clone(),
        )))
    }

    /// Consumes completed footer facts and binds the final Arrow schema once for future windows.
    pub fn into_window_reader(mut self) -> Result<DatasetWindowReader, DatasetError> {
        if self.next_member != self.source.member_count() {
            return Err(DatasetError::Unsupported);
        }
        self.source
            .ensure_all_members_unchanged_while(|| !self.cancelled.load(Ordering::Acquire))?;
        let summary = self.current_summary()?;
        let arrow_schema = self.current_arrow_schema(&summary)?;
        match self.preview_reader.take() {
            Some(reader) => reader.upgrade(summary, self.partition_columns, arrow_schema),
            None => DatasetWindowReader::from_parts(
                self.source,
                summary,
                self.partition_columns,
                arrow_schema,
                None,
            ),
        }
    }
}

/// Schema and rows from a bounded fixed early sample, including leading empty members.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetPreview {
    /// Inspection facts for the bounded sample; complete when it covers the dataset.
    pub progress: DatasetInspectionProgress,
    /// Bounded native-order rows from the inspected sample.
    pub arrow_ipc: Vec<u8>,
}

/// Reuses one DuckDB connection for windows from one fixed dataset snapshot.
pub struct DatasetWindowReader {
    connection: Connection,
    _temporary_directory: Option<TempDir>,
    interrupt: Arc<InterruptHandle>,
    interrupted: Arc<AtomicBool>,
    source: DatasetSource,
    summary: DatasetSummary,
    partition_columns: Vec<PartitionColumn>,
    member_limit: Option<usize>,
    arrow_schema: SchemaRef,
    filename_column: String,
    physical_column_count: usize,
    schema_seed: Option<NamedTempFile>,
}

struct DatasetQueryRows {
    schema: SchemaRef,
    batches: Vec<RecordBatch>,
}

#[derive(Clone, Copy)]
enum DatasetWindowProjection<'a> {
    All,
    Fields(&'a [FieldPath]),
    JsonSample(&'a FieldPath),
}

/// Cancels the active direct dataset query without taking its reader lock.
#[derive(Clone)]
pub struct DatasetWindowInterruptHandle {
    interrupt: Arc<InterruptHandle>,
    interrupted: Arc<AtomicBool>,
}

impl DatasetWindowInterruptHandle {
    /// Interrupts the active query and rejects later work on this reader.
    pub fn interrupt(&self) {
        self.interrupted.store(true, Ordering::Release);
        self.interrupt.interrupt();
    }
}

/// Completed dataset relation state reused by isolated query operations.
pub(crate) struct DatasetQuerySource {
    source: DatasetSource,
    summary: DatasetSummary,
    partition_columns: Vec<PartitionColumn>,
    filename_column: String,
    row_column: String,
    ordinal_column: String,
    physical_column_count: usize,
    arrow_schema: SchemaRef,
    member_limit: u64,
    schema_seed: NamedTempFile,
    bound_members: Mutex<Vec<DatasetMember>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DatasetRowPosition {
    pub(crate) member_ordinal: u64,
    pub(crate) native_row: u64,
    pub(crate) requested_order: u64,
}

pub(crate) struct DatasetSparseRows {
    _directory: TempDir,
    _files: Vec<TempPath>,
    relation_sql: String,
    requested_order_column: String,
    schema: SchemaRef,
    row_count: usize,
}

impl DatasetSparseRows {
    pub(crate) fn relation_sql(&self) -> &str {
        &self.relation_sql
    }

    pub(crate) fn requested_order_column(&self) -> &str {
        &self.requested_order_column
    }

    pub(crate) fn schema(&self) -> &SchemaRef {
        &self.schema
    }

    pub(crate) fn row_count(&self) -> usize {
        self.row_count
    }
}

pub(crate) struct DatasetBatchCursor {
    after_ordinal: Option<u64>,
    filters: Vec<DataFilter>,
    finished: bool,
}

#[derive(Clone)]
pub(crate) struct DatasetSessionToken {
    catalog: Arc<MemberCatalog>,
}

impl DatasetSessionToken {
    fn matches(&self, source: &DatasetSource) -> bool {
        Arc::ptr_eq(&self.catalog, &source.catalog)
    }
}

#[derive(Debug)]
pub(crate) enum DatasetSetupError {
    Dataset(DatasetError),
    Query(DuckDbError),
}

impl DatasetSetupError {
    fn into_dataset(self) -> DatasetError {
        match self {
            Self::Dataset(error) => error,
            Self::Query(error) => classify_query_error(error, false).into(),
        }
    }
}

impl From<DatasetError> for DatasetSetupError {
    fn from(error: DatasetError) -> Self {
        Self::Dataset(error)
    }
}

impl From<DuckDbError> for DatasetSetupError {
    fn from(error: DuckDbError) -> Self {
        Self::Query(error)
    }
}

impl DatasetQuerySource {
    pub(crate) fn candidate_batches(&self, filters: &[DataFilter]) -> DatasetBatchCursor {
        DatasetBatchCursor {
            after_ordinal: None,
            filters: filters.to_vec(),
            finished: false,
        }
    }

    pub(crate) fn bind_next_candidate_batch(
        &self,
        connection: &Connection,
        cursor: &mut DatasetBatchCursor,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<bool, DatasetSetupError> {
        while !cursor.finished {
            if !keep_going() {
                return Err(DatasetError::Cancelled.into());
            }
            let page = self
                .source
                .catalog
                .page(cursor.after_ordinal, CATALOG_PAGE_MEMBERS)?;
            cursor.after_ordinal = page.next_ordinal;
            cursor.finished = page
                .next_ordinal
                .is_none_or(|next| next >= self.member_limit);
            let candidates = page
                .members
                .into_iter()
                .filter(|member| member.ordinal < self.member_limit)
                .filter(|member| {
                    member_matches_prunable_filters(
                        member,
                        &self.summary,
                        &self.partition_columns,
                        &cursor.filters,
                    )
                })
                .collect::<Vec<_>>();
            if !candidates.is_empty() {
                self.bind_members(connection, &candidates)?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(crate) fn bound_row_count(
        &self,
        connection: &Connection,
    ) -> Result<u64, DatasetSetupError> {
        connection
            .query_row(
                "SELECT getvariable('__viewda_candidate_row_count')::UBIGINT",
                [],
                |row| row.get(0),
            )
            .map_err(DatasetSetupError::Query)
    }

    pub(crate) fn stage_candidate_batches(
        &self,
        connection: &Connection,
        filters: &[DataFilter],
        table: &str,
        query: (&str, &str),
        parameters: &[Value],
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetSetupError> {
        let (projection, where_clause) = query;
        let table = quote_identifier(table);
        self.bind_members(connection, &[])?;
        connection
            .execute_batch(&format!(
                "CREATE TEMP TABLE {table} AS SELECT {projection} FROM {} LIMIT 0",
                self.relation_sql(),
            ))
            .map_err(DatasetSetupError::Query)?;
        let mut cursor = self.candidate_batches(filters);
        while self.bind_next_candidate_batch(connection, &mut cursor, &mut keep_going)? {
            self.validate_bound_members_while(&mut keep_going)?;
            if !keep_going() {
                return Err(DatasetError::Cancelled.into());
            }
            let query = format!(
                "INSERT INTO {table} SELECT {projection} FROM {}{where_clause}",
                self.relation_sql(),
            );
            let result = connection.execute(&query, params_from_iter(parameters.iter()));
            if !keep_going() {
                return Err(DatasetError::Cancelled.into());
            }
            result.map_err(|error| {
                DatasetSetupError::Dataset(
                    self.classify_query_failure(error, !where_clause.is_empty()),
                )
            })?;
            self.validate_bound_members_while(&mut keep_going)?;
        }
        Ok(())
    }

    pub(crate) fn session_token(&self) -> DatasetSessionToken {
        DatasetSessionToken {
            catalog: Arc::clone(&self.source.catalog),
        }
    }

    pub(crate) fn matches_session(&self, token: &DatasetSessionToken) -> bool {
        token.matches(&self.source)
    }

    pub(crate) fn target_matches_member(&self, target: &Path) -> Result<bool, DatasetError> {
        self.source.target_matches_member(target)
    }
    pub(crate) fn schema(&self) -> &[SchemaField] {
        &self.summary.schema
    }

    pub(crate) fn projected_field_schema(
        &self,
        field_paths: &[FieldPath],
    ) -> Result<SchemaRef, DatasetError> {
        project_arrow_field_paths(&self.arrow_schema, field_paths)
            .ok_or_else(|| DataWindowError::Unsupported.into())
    }

    pub(crate) fn sparse_empty_relation_sql(&self) -> Result<String, DatasetError> {
        sparse_relation_sql(self.schema_seed.path(), std::iter::empty())
    }

    pub(crate) fn row_count(&self) -> u64 {
        self.summary.row_count
    }

    pub(crate) fn size_bytes(&self) -> u64 {
        self.summary.size_bytes
    }

    pub(crate) fn row_group_count(&self) -> Result<usize, DatasetError> {
        usize::try_from(self.summary.row_group_count).map_err(|_| DatasetError::Unsupported)
    }

    pub(crate) fn stage_sparse_window_while(
        &self,
        positions: &[DatasetRowPosition],
        field_paths: &[FieldPath],
        temporary_parent: &Path,
        keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetSparseRows, DatasetError> {
        self.stage_sparse_rows_while(
            positions,
            field_paths,
            temporary_parent,
            MAX_WINDOW_ROWS as usize,
            MAX_WINDOW_ROWS as usize,
            keep_going,
        )
    }

    pub(crate) fn stage_sparse_export_while(
        &self,
        positions: &[DatasetRowPosition],
        field_paths: &[FieldPath],
        temporary_parent: &Path,
        keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetSparseRows, DatasetError> {
        self.stage_sparse_rows_while(
            positions,
            field_paths,
            temporary_parent,
            MAX_EXPORT_SPARSE_ROWS,
            MAX_EXPORT_SPARSE_MEMBERS,
            keep_going,
        )
    }

    fn stage_sparse_rows_while(
        &self,
        positions: &[DatasetRowPosition],
        field_paths: &[FieldPath],
        temporary_parent: &Path,
        row_limit: usize,
        member_limit: usize,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetSparseRows, DatasetError> {
        self.source.require_active()?;
        if positions.is_empty() || positions.len() > row_limit {
            return Err(DatasetError::PageTooLarge);
        }
        let resolved = validate_field_paths(&self.summary.schema, field_paths)
            .ok_or(DataWindowError::Unsupported)?;
        let mut source_indices = resolved
            .iter()
            .map(|resolved| resolved.root_index)
            .collect::<Vec<_>>();
        source_indices.sort_unstable();
        source_indices.dedup();
        let schema = Arc::new(
            self.arrow_schema
                .project(&source_indices)
                .map_err(|_| DataWindowError::Unsupported)?,
        );
        let requested_order_column = unique_column_name(
            self.summary.schema.iter().map(|field| field.name.as_str()),
            "__viewda_requested_order",
        );
        let mut positions_by_member = HashMap::<u64, Vec<(u64, u64)>>::new();
        for position in positions {
            positions_by_member
                .entry(position.member_ordinal)
                .or_default()
                .push((position.native_row, position.requested_order));
        }
        if positions_by_member.len() > member_limit {
            return Err(DatasetError::PageTooLarge);
        }
        let ordinals = positions_by_member.keys().copied().collect::<Vec<_>>();
        let members = self.members_for_ordinals_while(&ordinals, &mut keep_going)?;
        self.source
            .ensure_members_unchanged_while(&members, &mut keep_going)?;
        *self
            .bound_members
            .lock()
            .map_err(|_| DatasetError::Unsupported)? = members.clone();

        let directory = create_sparse_directory(temporary_parent)?;
        let mut files = Vec::with_capacity(members.len());
        for member in &members {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            let mut member_positions = positions_by_member
                .remove(&member.ordinal)
                .ok_or(DatasetError::Unsupported)?;
            member_positions.sort_unstable_by_key(|(native_row, _)| *native_row);
            if member_positions
                .windows(2)
                .any(|pair| pair[0].0 == pair[1].0)
            {
                return Err(DatasetError::Unsupported);
            }
            let snapshot = SourceSnapshot::open(&member.path)
                .map_err(|error| self.source.latch_member_error(error, member))?;
            snapshot
                .validate_for_install(&member.path)
                .map_err(|error| self.source.latch_member_error(error, member))?;
            let metadata_file = snapshot
                .cloned_file()
                .map_err(|error| self.source.latch_member_error(error, member))?;
            let metadata = ArrowReaderMetadata::load(
                &metadata_file,
                ArrowReaderOptions::new().with_page_index_policy(PageIndexPolicy::Optional),
            )
            .map_err(|error| self.sparse_member_read_error(error.to_string(), member))?;
            let file = self.stage_sparse_member(
                member,
                &snapshot,
                &metadata,
                &member_positions,
                field_paths,
                &requested_order_column,
                directory.path(),
                &mut keep_going,
            )?;
            snapshot
                .validate_for_install(&member.path)
                .map_err(|error| self.source.latch_member_error(error, member))?;
            self.source.ensure_member_unchanged(member)?;
            files.push(file);
        }
        if !positions_by_member.is_empty() {
            return Err(DatasetError::Unsupported);
        }
        self.source
            .ensure_members_unchanged_while(&members, &mut keep_going)?;
        let relation_sql =
            sparse_relation_sql(self.schema_seed.path(), files.iter().map(TempPath::as_ref))?;
        Ok(DatasetSparseRows {
            _directory: directory,
            _files: files,
            relation_sql,
            requested_order_column,
            schema,
            row_count: positions.len(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn stage_sparse_member(
        &self,
        member: &DatasetMember,
        snapshot: &SourceSnapshot,
        metadata: &ArrowReaderMetadata,
        positions: &[(u64, u64)],
        field_paths: &[FieldPath],
        requested_order_column: &str,
        directory: &Path,
        keep_going: &mut impl FnMut() -> bool,
    ) -> Result<TempPath, DatasetError> {
        let total_rows = u64::try_from(metadata.metadata().file_metadata().num_rows())
            .map_err(|_| DatasetError::Unsupported)?;
        if member.row_count != Some(total_rows)
            || positions
                .last()
                .is_some_and(|(native_row, _)| *native_row >= total_rows)
        {
            return Err(self.source.latch_source_changed(&member.relative_path));
        }
        let mut virtual_columns = Vec::new();
        let mut physical_paths = Vec::new();
        let mut seen_virtual_indices = Vec::new();
        for field_path in field_paths {
            let resolved = resolve_field_path(&self.summary.schema, field_path)
                .ok_or(DataWindowError::Unsupported)?;
            let source_index = resolved.root_index;
            let expected = self
                .arrow_schema
                .fields()
                .get(source_index)
                .ok_or(DataWindowError::Unsupported)?;
            if source_index < self.physical_column_count {
                if let Some(physical_path) =
                    physical_member_field_path(metadata.schema(), field_path)?
                {
                    physical_paths.push(physical_path);
                }
            } else if !seen_virtual_indices.contains(&source_index) {
                seen_virtual_indices.push(source_index);
                virtual_columns.push(SparseVirtualColumn {
                    field: Arc::clone(expected),
                    value: self.sparse_virtual_value(member, source_index)?,
                });
            }
        }
        let (leaf_indices, projected_member_schema) =
            parquet_leaf_projection(metadata, &physical_paths)?;
        let physical_columns = projected_member_schema
            .fields()
            .iter()
            .map(|member_field| {
                let expected = self
                    .arrow_schema
                    .fields()
                    .iter()
                    .find(|field| field.name().eq_ignore_ascii_case(member_field.name()))
                    .ok_or(DataWindowError::Unsupported)?;
                Ok(SparsePhysicalColumn {
                    member_name: member_field.name().to_owned(),
                    field: Arc::new(
                        member_field
                            .as_ref()
                            .clone()
                            .with_name(expected.name().to_owned()),
                    ),
                })
            })
            .collect::<Result<Vec<_>, DatasetError>>()?;
        let mut fields = physical_columns
            .iter()
            .map(|column| Arc::clone(&column.field))
            .chain(
                virtual_columns
                    .iter()
                    .map(|column| Arc::clone(&column.field)),
            )
            .collect::<Vec<_>>();
        fields.push(Arc::new(Field::new(
            requested_order_column,
            DataType::UInt64,
            false,
        )));
        let staging_schema = Arc::new(Schema::new(fields));
        let temporary = NamedTempFile::new_in(directory).map_err(sparse_storage_error)?;
        let file = temporary.reopen().map_err(sparse_storage_error)?;
        let mut writer = ArrowWriter::try_new(file, Arc::clone(&staging_schema), None)
            .map_err(sparse_staging_error)?;

        let mut position_cursor = 0_usize;
        let mut row_group_start = 0_u64;
        for (row_group_index, row_group) in metadata.metadata().row_groups().iter().enumerate() {
            let row_group_rows =
                u64::try_from(row_group.num_rows()).map_err(|_| DatasetError::Unsupported)?;
            let row_group_end = row_group_start
                .checked_add(row_group_rows)
                .ok_or(DatasetError::Unsupported)?;
            let group_position_start = position_cursor;
            while position_cursor < positions.len() && positions[position_cursor].0 < row_group_end
            {
                if positions[position_cursor].0 < row_group_start {
                    return Err(DatasetError::Unsupported);
                }
                position_cursor += 1;
            }
            let group_positions = &positions[group_position_start..position_cursor];
            if group_positions.is_empty() {
                row_group_start = row_group_end;
                continue;
            }
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            if physical_columns.is_empty() {
                let orders = group_positions
                    .iter()
                    .map(|(_, requested_order)| *requested_order)
                    .collect::<Vec<_>>();
                let batch = sparse_staging_batch(
                    &staging_schema,
                    None,
                    &physical_columns,
                    &virtual_columns,
                    &[],
                    &orders,
                )?;
                writer.write(&batch).map_err(sparse_staging_error)?;
                row_group_start = row_group_end;
                continue;
            }

            let file = snapshot
                .cloned_file()
                .map_err(|error| self.source.latch_member_error(error, member))?;
            let use_row_selection = physical_columns
                .iter()
                .all(|column| !column.field.data_type().is_nested());
            let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, metadata.clone())
                .with_projection(ProjectionMask::leaves(
                    metadata.metadata().file_metadata().schema_descr(),
                    leaf_indices.iter().copied(),
                ))
                .with_row_groups(vec![row_group_index])
                .with_batch_size(MAX_WINDOW_ROWS as usize);
            let reader = if use_row_selection {
                let row_group_rows =
                    usize::try_from(row_group_rows).map_err(|_| DatasetError::Unsupported)?;
                let ranges = group_positions
                    .iter()
                    .map(|(native_row, _)| {
                        let start = usize::try_from(*native_row - row_group_start)
                            .map_err(|_| DatasetError::Unsupported)?;
                        let end = start.checked_add(1).ok_or(DatasetError::Unsupported)?;
                        Ok(start..end)
                    })
                    .collect::<Result<Vec<_>, DatasetError>>()?;
                reader.with_row_selection(RowSelection::from_consecutive_ranges(
                    ranges.into_iter(),
                    row_group_rows,
                ))
            } else {
                reader
            }
            .build()
            .map_err(|error| self.sparse_member_read_error(error.to_string(), member))?;
            #[cfg(test)]
            SPARSE_SOURCE_ROW_GROUP_READS.fetch_add(1, Ordering::Relaxed);
            let mut batch_start = row_group_start;
            let mut group_cursor = 0_usize;
            for batch in reader {
                if !keep_going() {
                    return Err(DatasetError::Cancelled);
                }
                let batch = batch
                    .map_err(|error| self.sparse_member_read_error(error.to_string(), member))?;
                let batch_rows =
                    u64::try_from(batch.num_rows()).map_err(|_| DatasetError::Unsupported)?;
                #[cfg(test)]
                SPARSE_SOURCE_DECODED_ROWS.fetch_add(batch.num_rows(), Ordering::Relaxed);
                let batch_position_start = group_cursor;
                let take_indices = if use_row_selection {
                    group_cursor = group_cursor
                        .checked_add(batch.num_rows())
                        .ok_or(DatasetError::Unsupported)?;
                    if group_cursor > group_positions.len() {
                        return Err(DatasetError::Unsupported);
                    }
                    (0..batch.num_rows())
                        .map(|index| u32::try_from(index).map_err(|_| DatasetError::Unsupported))
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    let batch_end = batch_start
                        .checked_add(batch_rows)
                        .ok_or(DatasetError::Unsupported)?;
                    while group_cursor < group_positions.len()
                        && group_positions[group_cursor].0 < batch_end
                    {
                        if group_positions[group_cursor].0 < batch_start {
                            return Err(DatasetError::Unsupported);
                        }
                        group_cursor += 1;
                    }
                    let indices = group_positions[batch_position_start..group_cursor]
                        .iter()
                        .map(|(native_row, _)| {
                            u32::try_from(*native_row - batch_start)
                                .map_err(|_| DatasetError::Unsupported)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    batch_start = batch_end;
                    indices
                };
                let batch_positions = &group_positions[batch_position_start..group_cursor];
                if !batch_positions.is_empty() {
                    let orders = batch_positions
                        .iter()
                        .map(|(_, requested_order)| *requested_order)
                        .collect::<Vec<_>>();
                    let staged = sparse_staging_batch(
                        &staging_schema,
                        Some(&batch),
                        &physical_columns,
                        &virtual_columns,
                        &take_indices,
                        &orders,
                    )?;
                    writer.write(&staged).map_err(sparse_staging_error)?;
                }
                if group_cursor == group_positions.len() {
                    break;
                }
            }
            if group_cursor != group_positions.len() {
                return Err(self.source.latch_source_changed(&member.relative_path));
            }
            row_group_start = row_group_end;
        }
        if position_cursor != positions.len() || row_group_start != total_rows {
            return Err(self.source.latch_source_changed(&member.relative_path));
        }
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        writer.close().map_err(sparse_staging_error)?;
        Ok(temporary.into_temp_path())
    }

    fn sparse_virtual_value(
        &self,
        member: &DatasetMember,
        source_index: usize,
    ) -> Result<SparseVirtualValue, DatasetError> {
        if source_index == self.summary.provenance_column_index as usize {
            return Ok(SparseVirtualValue::Text(Some(member.relative_path.clone())));
        }
        let partition_index = self
            .summary
            .partition_column_indices
            .iter()
            .position(|index| *index as usize == source_index)
            .ok_or(DatasetError::Unsupported)?;
        let partition_column = self
            .partition_columns
            .get(partition_index)
            .ok_or(DatasetError::Unsupported)?;
        let raw = member
            .partitions
            .iter()
            .find(|partition| partition.key.eq_ignore_ascii_case(&partition_column.name))
            .map(|partition| partition.value.as_str())
            .filter(|value| *value != HIVE_DEFAULT_PARTITION);
        Ok(match partition_column.kind {
            PartitionColumnKind::Text => SparseVirtualValue::Text(raw.map(str::to_owned)),
            PartitionColumnKind::Int64 => {
                SparseVirtualValue::Int64(raw.and_then(canonical_partition_i64))
            }
        })
    }

    fn sparse_member_read_error(&self, message: String, member: &DatasetMember) -> DatasetError {
        if classify_member_read_message(&message) == Some(DataWindowError::ResourceExhausted) {
            DataWindowError::ResourceExhausted.into()
        } else {
            self.source.latch_error(DatasetError::InvalidMember {
                member: member.relative_path.clone(),
            })
        }
    }

    pub(crate) fn redact_paths(&self, message: &str) -> String {
        if self.source.root.parent().is_none() {
            return "dataset query resource exhausted".to_owned();
        }
        let member_paths = match self.bound_members.lock() {
            Ok(members) => members
                .iter()
                .flat_map(|member| {
                    [
                        member.path.clone(),
                        self.source.logical_root.join(&member.relative_path),
                        self.source.root.join(&member.relative_path),
                    ]
                })
                .collect::<Vec<_>>(),
            Err(_) => return "dataset query resource exhausted".to_owned(),
        };
        let mut candidates = path_redaction_candidates(member_paths)
            .into_iter()
            .map(|path| (path, "<source member>"))
            .collect::<Vec<_>>();
        candidates.extend(
            path_redaction_candidates([&self.source.logical_root, &self.source.root])
                .into_iter()
                .map(|path| (path, "<source>")),
        );
        candidates.extend(
            path_redaction_candidates([self.schema_seed.path()])
                .into_iter()
                .map(|path| (path, "<temporary file>")),
        );
        replace_redaction_candidates(message, candidates)
    }

    #[cfg(test)]
    pub(crate) fn install(&self, connection: &Connection) -> Result<(), DatasetSetupError> {
        self.install_while(connection, || true)
    }

    pub(crate) fn install_while(
        &self,
        connection: &Connection,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetSetupError> {
        self.require_active_while(&mut keep_going)?;
        initialize_member_tables(connection, &self.summary, &self.partition_columns)?;
        let seed_path = self
            .schema_seed
            .path()
            .to_str()
            .ok_or(DatasetError::Unsupported)?;
        connection
            .execute(
                "SET VARIABLE __viewda_seed_path = ?",
                [Value::Text(seed_path.to_owned())],
            )
            .map_err(DatasetSetupError::Query)?;
        self.require_active_while(keep_going)?;
        Ok(())
    }

    fn bind_members(
        &self,
        connection: &Connection,
        candidates: &[DatasetMember],
    ) -> Result<(), DatasetSetupError> {
        bind_candidate_members(
            connection,
            &self.source,
            &self.summary,
            &self.partition_columns,
            candidates,
            Some(self.schema_seed.path()),
        )?;
        install_candidate_offsets(connection)?;
        *self
            .bound_members
            .lock()
            .map_err(|_| DatasetError::Unsupported)? = candidates.to_vec();
        Ok(())
    }

    pub(crate) fn relation_sql(&self) -> String {
        dataset_relation_sql(
            &self.summary,
            self.physical_column_count,
            &self.filename_column,
            Some((&self.row_column, &self.ordinal_column)),
            true,
        )
    }

    pub(crate) fn ordinal_column(&self) -> &str {
        &self.ordinal_column
    }

    pub(crate) fn row_column(&self) -> &str {
        &self.row_column
    }

    pub(crate) fn require_active(&self) -> Result<(), DatasetError> {
        self.source.require_active()
    }

    pub(crate) fn require_active_while(
        &self,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        self.source.require_active()?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.source.require_active()
    }

    pub(crate) fn validate_bound_members_while(
        &self,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        self.source.require_active()?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let members = self
            .bound_members
            .lock()
            .map_err(|_| DatasetError::Unsupported)?
            .clone();
        self.source
            .ensure_members_unchanged_while(&members, &mut keep_going)
    }

    pub(crate) fn classify_query_failure(
        &self,
        error: DuckDbError,
        filters_applied: bool,
    ) -> DatasetError {
        if let Err(latched) = self.require_active() {
            return latched;
        }
        match self.bound_members.lock() {
            Ok(candidates) => {
                diagnose_query_failure(&self.source, &candidates, error, filters_applied)
            }
            Err(_) => DatasetError::Unsupported,
        }
    }

    pub(crate) fn classify_lazy_query_failure(&self, panic: &(dyn Any + Send)) -> DatasetError {
        if let Err(latched) = self.require_active() {
            return latched;
        }
        match self.bound_members.lock() {
            Ok(candidates) => diagnose_lazy_query_failure(&self.source, &candidates, panic, false),
            Err(_) => DatasetError::Unsupported,
        }
    }

    fn members_for_ordinals_while(
        &self,
        ordinals: &[u64],
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<DatasetMember>, DatasetError> {
        let mut ordinals = ordinals.to_vec();
        ordinals.sort_unstable();
        ordinals.dedup();
        if ordinals.len() > MAX_WINDOW_ROWS as usize {
            return Err(DatasetError::PageTooLarge);
        }
        if ordinals
            .last()
            .is_some_and(|ordinal| *ordinal >= self.member_limit)
        {
            return Err(DatasetError::Unsupported);
        }
        let mut members = Vec::with_capacity(ordinals.len());
        for ordinal_batch in ordinals.chunks(CATALOG_PAGE_MEMBERS as usize) {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            let batch = self.source.catalog.members(ordinal_batch)?;
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            if batch.len() != ordinal_batch.len() {
                return Err(DatasetError::Unsupported);
            }
            members.extend(batch);
        }
        Ok(members)
    }
}

impl DatasetWindowReader {
    /// Returns a handle that stops an active direct query without locking the reader.
    pub fn interrupt_handle(&self) -> DatasetWindowInterruptHandle {
        DatasetWindowInterruptHandle {
            interrupt: Arc::clone(&self.interrupt),
            interrupted: Arc::clone(&self.interrupted),
        }
    }

    /// Returns the selected member's first row in frozen dataset order.
    ///
    /// The selected member is revalidated around its frozen catalog offset.
    pub fn member_row_offset(&self, ordinal: u64) -> Result<u64, DatasetError> {
        self.member_row_offset_while(ordinal, || true)
    }

    /// Returns a member offset while the caller still wants the work.
    pub fn member_row_offset_while(
        &self,
        ordinal: u64,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<u64, DatasetError> {
        self.source.require_active()?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let member = self.source.member(ordinal)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.source.ensure_member_unchanged(&member)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let offset = self.source.catalog.row_offset(ordinal)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.source.ensure_member_unchanged(&member)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        Ok(offset)
    }

    /// Opens one selected fixed member without exposing its absolute path.
    pub fn member_snapshot(&self, ordinal: u64) -> Result<DatasetMemberSnapshot, DatasetError> {
        self.member_snapshot_while(ordinal, || true)
    }

    /// Opens one selected member while the caller still wants the work.
    pub fn member_snapshot_while(
        &self,
        ordinal: u64,
        keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetMemberSnapshot, DatasetError> {
        self.member_snapshot_checked(ordinal, keep_going, || {})
    }

    fn member_snapshot_checked(
        &self,
        ordinal: u64,
        mut keep_going: impl FnMut() -> bool,
        after_open: impl FnOnce(),
    ) -> Result<DatasetMemberSnapshot, DatasetError> {
        self.source.require_active()?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let member = self.source.member(ordinal)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.source.ensure_member_unchanged(&member)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let snapshot = SourceSnapshot::open(&member.path)
            .map_err(|error| self.source.latch_member_error(error, &member))?;
        after_open();
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.source.ensure_member_unchanged(&member)?;
        snapshot
            .validate_for_install(&member.path)
            .map_err(|error| self.source.latch_member_error(error, &member))?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        Ok(DatasetMemberSnapshot {
            snapshot,
            source: self.source.clone(),
            member,
        })
    }

    /// Captures the completed fixed relation for an isolated prepared view.
    #[cfg(test)]
    pub(crate) fn query_source(&self) -> Result<DatasetQuerySource, DatasetError> {
        self.query_source_while(|| true)
    }

    pub(crate) fn query_source_while(
        &self,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetQuerySource, DatasetError> {
        self.source.require_active()?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let member_limit = self
            .member_limit
            .map_or(self.source.member_count(), |limit| limit as u64)
            .min(self.source.member_count());
        let names = || self.summary.schema.iter().map(|field| field.name.as_str());
        let filename_column = unique_column_name(names(), "__viewda_filename");
        let row_column = unique_column_name(names(), "__viewda_native_row");
        let ordinal_column = unique_column_name(names(), "__viewda_member_ordinal");
        let source = DatasetQuerySource {
            source: self.source.clone(),
            summary: self.summary.clone(),
            partition_columns: self.partition_columns.clone(),
            filename_column,
            row_column,
            ordinal_column,
            physical_column_count: self.physical_column_count,
            arrow_schema: Arc::clone(&self.arrow_schema),
            member_limit,
            schema_seed: write_schema_seed(&self.arrow_schema)?,
            bound_members: Mutex::new(Vec::new()),
        };
        source.require_active_while(keep_going)?;
        Ok(source)
    }
    fn from_parts(
        source: DatasetSource,
        summary: DatasetSummary,
        partition_columns: Vec<PartitionColumn>,
        arrow_schema: SchemaRef,
        member_limit: Option<usize>,
    ) -> Result<Self, DatasetError> {
        let temporary_directory = tempfile::Builder::new()
            .prefix("viewda-dataset-query-")
            .tempdir_in(source.catalog.temporary_directory_hint())
            .map_err(|_| DataWindowError::ResourceExhausted)?;
        let temporary_directory_path = temporary_directory
            .path()
            .to_str()
            .ok_or(DataWindowError::QueryEngineUnavailable)?;
        let config = Config::default()
            .enable_object_cache(false)
            .and_then(|config| config.max_memory(DATASET_QUERY_MEMORY_LIMIT))
            .and_then(|config| config.with("temp_directory", temporary_directory_path))
            .and_then(|config| config.with("threads", "1"))
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let interrupt = connection.interrupt_handle();
        let interrupted = Arc::new(AtomicBool::new(false));
        set_utc_session_timezone(&connection)?;
        connection
            .execute_batch(
                "SET parquet_metadata_cache = false; SET preserve_insertion_order = true",
            )
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let physical_column_count = summary
            .partition_column_indices
            .first()
            .copied()
            .unwrap_or(summary.provenance_column_index)
            as usize;
        let filename_column = unique_column_name(
            summary.schema.iter().map(|field| field.name.as_str()),
            "__viewda_filename",
        );
        initialize_member_tables(&connection, &summary, &partition_columns)
            .map_err(DatasetSetupError::into_dataset)?;
        let mut reader = Self {
            interrupt,
            interrupted,
            source,
            summary,
            partition_columns,
            connection,
            member_limit,
            arrow_schema,
            filename_column,
            physical_column_count,
            schema_seed: None,
            _temporary_directory: Some(temporary_directory),
        };
        reader.install_schema_seed()?;
        Ok(reader)
    }

    fn upgrade(
        mut self,
        summary: DatasetSummary,
        partition_columns: Vec<PartitionColumn>,
        arrow_schema: SchemaRef,
    ) -> Result<Self, DatasetError> {
        self.summary = summary;
        self.partition_columns = partition_columns;
        self.member_limit = None;
        self.physical_column_count =
            self.summary
                .partition_column_indices
                .first()
                .copied()
                .unwrap_or(self.summary.provenance_column_index) as usize;
        self.filename_column = unique_column_name(
            self.summary.schema.iter().map(|field| field.name.as_str()),
            "__viewda_filename",
        );
        self.schema_seed = None;
        self.arrow_schema = arrow_schema;
        self.install_schema_seed()?;
        Ok(self)
    }

    /// Returns the inspected union schema and aggregate footer facts.
    pub fn summary(&self) -> &DatasetSummary {
        &self.summary
    }

    /// Reports a previously detected member change without rescanning the dataset.
    pub fn latched_source_change(&self) -> Result<(), DatasetError> {
        self.source.require_active()
    }

    /// Returns a bounded page of members whose schema differs from the first member.
    pub fn schema_drift_page(
        &self,
        offset: u64,
        limit: u32,
    ) -> Result<DatasetMemberPage, DatasetError> {
        let (total, members) = self.source.catalog.drift_page(offset, limit)?;
        Ok(DatasetMemberPage {
            offset,
            total,
            members: members
                .into_iter()
                .map(|member| DatasetMemberSummary {
                    ordinal: member.ordinal,
                    relative_path: member.relative_path,
                    partitions: member.partitions,
                })
                .collect(),
        })
    }

    /// Reads a stable global window in fixed dataset order.
    ///
    /// Filtered or sorted windows use [`crate::DataViewBuilder::for_dataset`]
    /// so their position index is prepared once and reused while scrolling.
    pub fn fetch(&mut self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DatasetError> {
        self.fetch_while(row_offset, row_count, || true)
    }

    /// Reads a stable window while the caller still wants the work.
    pub fn fetch_while(
        &mut self,
        row_offset: u64,
        row_count: u32,
        keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        self.fetch_projection(
            row_offset,
            row_count,
            DatasetWindowProjection::All,
            keep_going,
        )
    }

    /// Reads selected addressable union-schema fields in the requested order.
    pub fn fetch_fields(
        &mut self,
        row_offset: u64,
        row_count: u32,
        field_paths: &[FieldPath],
    ) -> Result<Vec<u8>, DatasetError> {
        self.fetch_fields_while(row_offset, row_count, field_paths, || true)
    }

    /// Reads projected fields while the caller still wants the work.
    pub fn fetch_fields_while(
        &mut self,
        row_offset: u64,
        row_count: u32,
        field_paths: &[FieldPath],
        keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        validate_field_paths(&self.summary.schema, field_paths)
            .ok_or(DataWindowError::Unsupported)?;
        self.fetch_projection(
            row_offset,
            row_count,
            DatasetWindowProjection::Fields(field_paths),
            keep_going,
        )
    }

    /// Reads the first bounded, size-limited values from one Parquet JSON column.
    pub fn fetch_json_schema_sample_while(
        &mut self,
        field_path: &FieldPath,
        keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        let resolved = resolve_field_path(&self.summary.schema, field_path)
            .filter(|resolved| field_is_json(resolved.field))
            .ok_or(DataWindowError::Unsupported)?;
        if resolved.root_index >= self.physical_column_count {
            return Err(DataWindowError::Unsupported.into());
        }
        self.fetch_projection(
            0,
            crate::JSON_SCHEMA_SAMPLE_ROW_LIMIT,
            DatasetWindowProjection::JsonSample(field_path),
            keep_going,
        )
    }

    fn fetch_projection(
        &mut self,
        row_offset: u64,
        row_count: u32,
        projection: DatasetWindowProjection<'_>,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        let interrupted = Arc::clone(&self.interrupted);
        let mut wants_work = || !interrupted.load(Ordering::Acquire) && keep_going();
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        self.source.require_active()?;
        let projected_schema = match projection {
            DatasetWindowProjection::All => None,
            DatasetWindowProjection::Fields(paths) => Some(
                project_arrow_field_paths(&self.arrow_schema, paths)
                    .ok_or(DataWindowError::Unsupported)?,
            ),
            DatasetWindowProjection::JsonSample(path) => Some(
                project_arrow_field_paths(&self.arrow_schema, std::slice::from_ref(path))
                    .ok_or(DataWindowError::Unsupported)?,
            ),
        };
        let expected_schema = projected_schema.as_ref().unwrap_or(&self.arrow_schema);
        let mut writer: Option<(SchemaRef, StreamWriter<Vec<u8>>)> = None;
        let active_limit = self
            .member_limit
            .map_or(self.source.member_count(), |limit| limit as u64)
            .min(self.source.member_count());
        let mut after = None;
        let mut remaining_offset = row_offset;
        let mut remaining_count = u64::from(row_count);
        while remaining_count > 0 {
            if !wants_work() {
                return Err(DatasetError::Cancelled);
            }
            let (page_rows, next) = self
                .source
                .catalog
                .row_count_page(after, CATALOG_PAGE_MEMBERS)?;
            if remaining_offset >= page_rows {
                remaining_offset -= page_rows;
                let Some(next) = next.filter(|next| *next < active_limit) else {
                    break;
                };
                after = Some(next);
                continue;
            }
            let page = self.source.catalog.page(after, CATALOG_PAGE_MEMBERS)?;
            let candidates = page
                .members
                .into_iter()
                .filter(|member| member.ordinal < active_limit)
                .collect::<Vec<_>>();
            if !candidates.is_empty() {
                // Bracket the exact bounded path batch so replacements cannot publish mixed data.
                self.source
                    .ensure_members_unchanged_while(&candidates, &mut wants_work)?;
                self.bind_candidate_paths(&candidates)?;
                let batch_rows = candidates.iter().try_fold(0_u64, |total, member| {
                    total
                        .checked_add(member.row_count.ok_or(DatasetError::Unsupported)?)
                        .ok_or(DatasetError::Unsupported)
                })?;
                if remaining_offset >= batch_rows {
                    remaining_offset -= batch_rows;
                } else {
                    if !wants_work() {
                        return Err(DatasetError::Cancelled);
                    }
                    let rows = self.query_candidate_rows(
                        &candidates,
                        remaining_offset,
                        remaining_count,
                        projection,
                    )?;
                    validate_produced_arrow_schema(expected_schema, &rows.schema)?;
                    let writer = match &mut writer {
                        Some((schema, writer)) => {
                            if schema.as_ref() != rows.schema.as_ref() {
                                return Err(DataWindowError::EncodingFailed.into());
                            }
                            writer
                        }
                        None => {
                            let stream = StreamWriter::try_new(Vec::new(), rows.schema.as_ref())
                                .map_err(|_| DataWindowError::EncodingFailed)?;
                            &mut writer.insert((Arc::clone(&rows.schema), stream)).1
                        }
                    };
                    remaining_offset = 0;
                    for batch in rows.batches {
                        remaining_count = remaining_count.saturating_sub(batch.num_rows() as u64);
                        writer
                            .write(&batch)
                            .map_err(|_| DataWindowError::EncodingFailed)?;
                    }
                }
                self.source
                    .ensure_members_unchanged_while(&candidates, &mut wants_work)?;
            }
            let Some(next) = page.next_ordinal.filter(|next| *next < active_limit) else {
                break;
            };
            after = Some(next);
        }
        let mut writer = match writer {
            Some((_, writer)) => writer,
            None => StreamWriter::try_new(Vec::new(), expected_schema.as_ref())
                .map_err(|_| DataWindowError::EncodingFailed)?,
        };
        writer
            .finish()
            .map_err(|_| DataWindowError::EncodingFailed)?;
        let encoded = writer
            .into_inner()
            .map_err(|_| DataWindowError::EncodingFailed)?;
        if matches!(projection, DatasetWindowProjection::JsonSample(_))
            && encoded.len() > crate::JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT
        {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        Ok(encoded)
    }

    fn query_candidate_rows(
        &self,
        candidates: &[DatasetMember],
        row_offset: u64,
        row_count: u64,
        projection: DatasetWindowProjection<'_>,
    ) -> Result<DatasetQueryRows, DatasetError> {
        let query = self.query_sql(projection)?;
        let parameters = [
            Value::BigInt(i64::try_from(row_count).map_err(|_| DataWindowError::Unsupported)?),
            Value::BigInt(i64::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?),
        ];
        let mut statement = self.connection.prepare(&query).map_err(|error| {
            if self.interrupted.load(Ordering::Acquire) {
                DatasetError::Cancelled
            } else {
                diagnose_query_failure(&self.source, candidates, error, false)
            }
        })?;
        let batches = statement
            .stream_arrow(params_from_iter(parameters.iter()))
            .map_err(|error| {
                if self.interrupted.load(Ordering::Acquire) {
                    DatasetError::Cancelled
                } else {
                    diagnose_query_failure(&self.source, candidates, error, false)
                }
            })?;
        let schema = batches.get_schema();
        match catch_unwind(AssertUnwindSafe(|| batches.collect::<Vec<_>>())) {
            Ok(batches) => Ok(DatasetQueryRows { schema, batches }),
            Err(_) if self.interrupted.load(Ordering::Acquire) => Err(DatasetError::Cancelled),
            Err(panic) => Err(diagnose_lazy_query_failure(
                &self.source,
                candidates,
                panic.as_ref(),
                false,
            )),
        }
    }

    fn bind_candidate_paths(&self, candidates: &[DatasetMember]) -> Result<(), DatasetError> {
        bind_candidate_members(
            &self.connection,
            &self.source,
            &self.summary,
            &self.partition_columns,
            candidates,
            self.schema_seed.as_ref().map(NamedTempFile::path),
        )
        .map_err(DatasetSetupError::into_dataset)
    }

    #[cfg(test)]
    fn query_schema(&self, candidates: &[DatasetMember]) -> Result<SchemaRef, DatasetError> {
        let query = self.query_sql(DatasetWindowProjection::All)?;
        let mut statement = self
            .connection
            .prepare(&query)
            .map_err(|error| diagnose_query_failure(&self.source, candidates, error, false))?;
        let parameters = [Value::BigInt(0), Value::BigInt(0)];
        let batches = statement
            .stream_arrow(params_from_iter(parameters.iter()))
            .map_err(|error| diagnose_query_failure(&self.source, candidates, error, false))?;
        Ok(batches.get_schema())
    }

    #[cfg(test)]
    fn query_schema_checked(
        &self,
        candidates: &[DatasetMember],
        after_query: impl FnOnce(),
    ) -> Result<SchemaRef, DatasetError> {
        let schema = self.query_schema(candidates)?;
        after_query();
        self.source
            .ensure_members_unchanged_while(candidates, || true)?;
        Ok(schema)
    }

    fn install_schema_seed(&mut self) -> Result<(), DatasetError> {
        let seed = write_schema_seed(&self.arrow_schema)?;
        let seed_path = seed
            .path()
            .to_str()
            .ok_or(DatasetError::Unsupported)?
            .to_owned();
        self.connection
            .execute(
                "SET VARIABLE __viewda_seed_path = ?",
                [Value::Text(seed_path)],
            )
            .map_err(|error| classify_query_error(error, false))?;
        self.schema_seed = Some(seed);
        Ok(())
    }

    fn query_sql(&self, projection: DatasetWindowProjection<'_>) -> Result<String, DatasetError> {
        let relation = dataset_relation_sql(
            &self.summary,
            self.physical_column_count,
            &self.filename_column,
            None,
            self.schema_seed.is_some(),
        );
        let projection = match projection {
            DatasetWindowProjection::All => self
                .summary
                .schema
                .iter()
                .map(|field| quote_identifier(&field.name))
                .collect::<Vec<_>>()
                .join(", "),
            DatasetWindowProjection::Fields(paths) => paths
                .iter()
                .map(|path| {
                    let resolved = resolve_field_path(&self.summary.schema, path)
                        .ok_or(DataWindowError::Unsupported)?;
                    let root = quote_identifier(&self.summary.schema[resolved.root_index].name);
                    let expression = field_path_expression(&self.summary.schema, path, &root)
                        .ok_or(DataWindowError::Unsupported)?;
                    Ok(format!(
                        "{expression} AS {}",
                        quote_column_alias(path.leaf_name().ok_or(DataWindowError::Unsupported)?)
                    ))
                })
                .collect::<Result<Vec<_>, DataWindowError>>()?
                .join(", "),
            DatasetWindowProjection::JsonSample(path) => {
                let resolved = resolve_field_path(&self.summary.schema, path)
                    .filter(|resolved| field_is_json(resolved.field))
                    .ok_or(DataWindowError::Unsupported)?;
                let root = quote_identifier(&self.summary.schema[resolved.root_index].name);
                let field = field_path_expression(&self.summary.schema, path, &root)
                    .ok_or(DataWindowError::Unsupported)?;
                format!(
                    "{} AS {}",
                    json_schema_sample_expression(&field),
                    quote_column_alias(path.leaf_name().ok_or(DataWindowError::Unsupported)?),
                )
            }
        };
        Ok(format!(
            "SELECT {projection} FROM {relation} LIMIT ? OFFSET ?"
        ))
    }
}

struct SparsePhysicalColumn {
    member_name: String,
    field: Arc<Field>,
}

// Dataset union identity ignores ASCII case; Parquet physical projection does not.
fn physical_member_field_path(
    schema: &Schema,
    canonical_path: &FieldPath,
) -> Result<Option<FieldPath>, DatasetError> {
    let mut fields = schema.fields();
    let mut physical_segments = Vec::with_capacity(canonical_path.segments().len());
    for (index, segment) in canonical_path.segments().iter().enumerate() {
        let mut matches = fields
            .iter()
            .filter(|field| field.name().eq_ignore_ascii_case(segment));
        let Some(field) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() {
            return Err(DatasetError::Unsupported);
        }
        physical_segments.push(field.name().to_owned());
        if index + 1 < canonical_path.segments().len() {
            let DataType::Struct(children) = field.data_type() else {
                return Err(DatasetError::Unsupported);
            };
            fields = children;
        }
    }
    if physical_segments.is_empty() {
        return Err(DatasetError::Unsupported);
    }
    Ok(Some(FieldPath::new(physical_segments)))
}

fn parquet_leaf_projection(
    metadata: &ArrowReaderMetadata,
    field_paths: &[FieldPath],
) -> Result<(Vec<usize>, SchemaRef), DatasetError> {
    let descriptor = metadata.metadata().file_metadata().schema_descr();
    let leaf_indices = descriptor
        .columns()
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            field_paths
                .iter()
                .any(|path| {
                    let parts = column.path().parts();
                    parts.len() >= path.segments().len()
                        && parts
                            .iter()
                            .zip(path.segments())
                            .all(|(part, segment)| part == segment)
                })
                .then_some(index)
        })
        .collect::<Vec<_>>();
    let mask = ProjectionMask::leaves(descriptor, leaf_indices.iter().copied());
    let schema = parquet_to_arrow_schema_by_columns(
        descriptor,
        mask,
        metadata.metadata().file_metadata().key_value_metadata(),
    )
    .map_err(|_| DataWindowError::Unsupported)?;
    Ok((leaf_indices, Arc::new(schema)))
}

struct SparseVirtualColumn {
    field: Arc<Field>,
    value: SparseVirtualValue,
}

enum SparseVirtualValue {
    Text(Option<String>),
    Int64(Option<i64>),
}

fn sparse_staging_batch(
    schema: &SchemaRef,
    source: Option<&RecordBatch>,
    physical_columns: &[SparsePhysicalColumn],
    virtual_columns: &[SparseVirtualColumn],
    take_indices: &[u32],
    requested_orders: &[u64],
) -> Result<RecordBatch, DatasetError> {
    let row_count = requested_orders.len();
    if !physical_columns.is_empty() && take_indices.len() != row_count {
        return Err(DatasetError::Unsupported);
    }
    let take_indices = UInt32Array::from(take_indices.to_vec());
    let mut columns = physical_columns
        .iter()
        .map(|column| {
            let source = source.ok_or(DatasetError::Unsupported)?;
            let source_index = source
                .schema()
                .fields()
                .iter()
                .position(|field| field.name().eq_ignore_ascii_case(&column.member_name))
                .ok_or(DatasetError::Unsupported)?;
            take(source.column(source_index).as_ref(), &take_indices, None)
                .map_err(|_| DataWindowError::EncodingFailed.into())
        })
        .collect::<Result<Vec<ArrayRef>, DatasetError>>()?;
    columns.extend(virtual_columns.iter().map(|column| match &column.value {
        SparseVirtualValue::Text(value) => Arc::new(StringArray::from_iter(
            (0..row_count).map(|_| value.as_deref()),
        )) as ArrayRef,
        SparseVirtualValue::Int64(value) => {
            Arc::new(Int64Array::from_iter((0..row_count).map(|_| *value))) as ArrayRef
        }
    }));
    columns.push(Arc::new(UInt64Array::from(requested_orders.to_vec())) as ArrayRef);
    RecordBatch::try_new(Arc::clone(schema), columns)
        .map_err(|_| DataWindowError::EncodingFailed.into())
}

fn create_sparse_directory(parent: &Path) -> Result<TempDir, DatasetError> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("viewda-dataset-sparse-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent).map_err(sparse_storage_error)
}

fn sparse_relation_sql<'a>(
    schema_seed: &Path,
    paths: impl Iterator<Item = &'a Path>,
) -> Result<String, DatasetError> {
    let quote_path = |path: &Path| {
        path.to_str()
            .map(escape_glob_path)
            .map(|path| quote_string_literal(&path))
            .ok_or(DatasetError::Unsupported)
    };
    let paths = std::iter::once(quote_path(schema_seed))
        .chain(paths.map(quote_path))
        .collect::<Result<Vec<_>, _>>()?
        .join(", ");
    Ok(format!(
        "read_parquet([{paths}], union_by_name = true, hive_partitioning = false)"
    ))
}

fn sparse_storage_error(_error: std::io::Error) -> DatasetError {
    DataWindowError::ResourceExhausted.into()
}

fn sparse_staging_error(error: parquet::errors::ParquetError) -> DatasetError {
    if classify_member_read_message(&error.to_string()) == Some(DataWindowError::ResourceExhausted)
    {
        DataWindowError::ResourceExhausted.into()
    } else {
        DataWindowError::EncodingFailed.into()
    }
}

fn dataset_relation_sql(
    summary: &DatasetSummary,
    physical_column_count: usize,
    filename_column: &str,
    positions: Option<(&str, &str)>,
    has_schema_seed: bool,
) -> String {
    let physical_projection = summary.schema[..physical_column_count]
        .iter()
        .map(|field| {
            format!(
                "s.{} AS {}",
                quote_identifier(&field.name),
                quote_identifier(&field.name)
            )
        })
        .collect::<Vec<_>>();
    let partition_projection = summary.partition_column_indices.iter().enumerate().map(
        |(partition_index, schema_index)| {
            format!(
                "map_extract_value(getvariable('__viewda_partition_{partition_index}'), \
                 s.{filename}) AS {column}",
                filename = quote_identifier(filename_column),
                column = quote_identifier(&summary.schema[*schema_index as usize].name),
            )
        },
    );
    let provenance_projection = format!(
        "map_extract_value(getvariable('__viewda_relative_map'), s.{filename}) AS {}",
        quote_identifier(&summary.schema[summary.provenance_column_index as usize].name),
        filename = quote_identifier(filename_column),
    );
    let global_row_column = unique_column_name(
        summary.schema.iter().map(|field| field.name.as_str()),
        "__viewda_global_row",
    );
    let position_projection = positions.into_iter().flat_map(|(row, ordinal)| {
        [
            format!(
                "map_extract_value(getvariable('__viewda_ordinal_map'), s.{filename}) AS {}",
                quote_identifier(ordinal),
                filename = quote_identifier(filename_column),
            ),
            format!(
                "p.{global_row} - CAST(map_extract_value(\
                 getvariable('__viewda_candidate_start_map'), s.{filename}) AS BIGINT) AS {}",
                quote_identifier(row),
                global_row = quote_identifier(&global_row_column),
                filename = quote_identifier(filename_column),
            ),
        ]
    });
    let projection = physical_projection
        .into_iter()
        .chain(partition_projection)
        .chain([provenance_projection])
        .chain(position_projection)
        .collect::<Vec<_>>()
        .join(", ");
    let seed_filter = has_schema_seed.then(|| {
        format!(
            " WHERE s.{} <> getvariable('__viewda_seed_path')",
            quote_identifier(filename_column)
        )
    });
    let position_join = positions.map_or_else(String::new, |_| {
        format!(
            " POSITIONAL JOIN range(CAST(\
             getvariable('__viewda_candidate_row_count') AS BIGINT)) \
             p({})",
            quote_identifier(&global_row_column)
        )
    });
    format!(
        "(SELECT {projection} \
         FROM read_parquet(getvariable('__viewda_paths'), union_by_name = true, \
         hive_partitioning = false, filename = {filename_option}) \
         s{position_join}{seed_filter})",
        filename_option = quote_string_literal(filename_column),
        seed_filter = seed_filter.as_deref().unwrap_or(""),
    )
}

fn initialize_member_tables(
    connection: &Connection,
    summary: &DatasetSummary,
    partition_columns: &[PartitionColumn],
) -> Result<(), DatasetSetupError> {
    let partition_sql = summary
        .partition_column_indices
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let sql_type = match partition_columns
                .get(index)
                .ok_or(DatasetError::Unsupported)?
                .kind
            {
                PartitionColumnKind::Text => "VARCHAR",
                PartitionColumnKind::Int64 => "BIGINT",
            };
            Ok(format!(", \"__partition_{index}\" {sql_type}"))
        })
        .collect::<Result<Vec<_>, DatasetError>>()?
        .join("");
    connection
        .execute_batch(&format!(
            "CREATE TEMP TABLE __viewda_members (\
             __ordinal UBIGINT PRIMARY KEY, __path VARCHAR NOT NULL UNIQUE, \
             __relative VARCHAR NOT NULL, __row_count UBIGINT NOT NULL{partition_sql}); \
             CREATE TEMP TABLE __viewda_candidates (__ordinal UBIGINT PRIMARY KEY)"
        ))
        .map_err(DatasetSetupError::Query)?;
    Ok(())
}

fn append_member_metadata(
    connection: &Connection,
    members: &[DatasetMember],
    summary: &DatasetSummary,
    partition_columns: &[PartitionColumn],
    row_counts: &[u64],
) -> Result<(), DatasetSetupError> {
    if members.len() != row_counts.len() {
        return Err(DatasetError::Unsupported.into());
    }
    let mut appender = connection
        .appender("__viewda_members")
        .map_err(DatasetSetupError::Query)?;
    for (member, row_count) in members.iter().zip(row_counts) {
        let path = member.path.to_str().ok_or(DatasetError::Unsupported)?;
        let mut values = vec![
            Value::UBigInt(member.ordinal),
            Value::Text(path.to_owned()),
            Value::Text(member.relative_path.clone()),
            Value::UBigInt(*row_count),
        ];
        for (partition_index, _) in summary.partition_column_indices.iter().enumerate() {
            let column = partition_columns
                .get(partition_index)
                .ok_or(DatasetError::Unsupported)?;
            values.push(
                member
                    .partitions
                    .iter()
                    .find(|partition| partition.key.eq_ignore_ascii_case(&column.name))
                    .and_then(|partition| column.query_value(&partition.value))
                    .map_or(Value::Null, |value| match value {
                        PartitionScalar::Text(value) => Value::Text(value.to_owned()),
                        PartitionScalar::Int64(value) => Value::BigInt(value),
                    }),
            );
        }
        appender
            .append_row(appender_params_from_iter(values))
            .map_err(DatasetSetupError::Query)?;
    }
    appender.flush().map_err(DatasetSetupError::Query)?;
    Ok(())
}

fn install_member_maps(
    connection: &Connection,
    summary: &DatasetSummary,
) -> Result<(), DatasetSetupError> {
    connection
        .execute_batch(
            "SET VARIABLE __viewda_relative_map = (\
             SELECT map(list(__path ORDER BY __ordinal), list(__relative ORDER BY __ordinal)) \
             FROM __viewda_members)",
        )
        .map_err(DatasetSetupError::Query)?;
    for partition_index in 0..summary.partition_column_indices.len() {
        connection
            .execute_batch(&format!(
                "SET VARIABLE __viewda_partition_{partition_index} = (\
                 SELECT map(list(__path ORDER BY __ordinal), \
                 list({} ORDER BY __ordinal)) FROM __viewda_members)",
                quote_identifier(&format!("__partition_{partition_index}"))
            ))
            .map_err(DatasetSetupError::Query)?;
    }
    Ok(())
}

fn install_ordinal_map(connection: &Connection) -> Result<(), DatasetSetupError> {
    connection
        .execute_batch(
            "SET VARIABLE __viewda_ordinal_map = (\
             SELECT map(list(__path ORDER BY __ordinal), list(__ordinal ORDER BY __ordinal)) \
             FROM __viewda_members)",
        )
        .map_err(DatasetSetupError::Query)?;
    Ok(())
}

fn install_candidate_offsets(connection: &Connection) -> Result<(), DatasetSetupError> {
    connection
        .execute_batch(
            "SET VARIABLE __viewda_candidate_start_map = (\
             SELECT map(list(__path ORDER BY __ordinal), list(__start ORDER BY __ordinal)) \
             FROM (SELECT __path, __ordinal, coalesce(sum(__row_count) OVER (\
             ORDER BY __ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) __start \
             FROM __viewda_members JOIN __viewda_candidates USING (__ordinal))); \
             SET VARIABLE __viewda_candidate_row_count = (\
             SELECT coalesce(sum(__row_count), 0) FROM __viewda_members \
             JOIN __viewda_candidates USING (__ordinal))",
        )
        .map_err(DatasetSetupError::Query)?;
    Ok(())
}

fn bind_candidate_members(
    connection: &Connection,
    source: &DatasetSource,
    summary: &DatasetSummary,
    partition_columns: &[PartitionColumn],
    candidates: &[DatasetMember],
    schema_seed: Option<&Path>,
) -> Result<(), DatasetSetupError> {
    connection
        .execute_batch("DELETE FROM __viewda_candidates; DELETE FROM __viewda_members")
        .map_err(DatasetSetupError::Query)?;
    let missing_ordinals = candidates
        .iter()
        .filter(|member| member.row_count.is_none())
        .map(|member| member.ordinal)
        .collect::<Vec<_>>();
    let catalog_row_counts = source
        .catalog
        .row_counts(&missing_ordinals)?
        .into_iter()
        .collect::<HashMap<_, _>>();
    let row_counts = candidates
        .iter()
        .map(|member| {
            member
                .row_count
                .or_else(|| catalog_row_counts.get(&member.ordinal).copied())
                .ok_or(DatasetError::Unsupported)
        })
        .collect::<Result<Vec<_>, _>>()?;
    append_member_metadata(
        connection,
        candidates,
        summary,
        partition_columns,
        &row_counts,
    )?;
    install_member_maps(connection, summary)?;
    install_ordinal_map(connection)?;
    let mut appender = connection
        .appender("__viewda_candidates")
        .map_err(DatasetSetupError::Query)?;
    for member in candidates {
        appender
            .append_row([Value::UBigInt(member.ordinal)])
            .map_err(DatasetSetupError::Query)?;
    }
    appender.flush().map_err(DatasetSetupError::Query)?;
    drop(appender);

    bind_paths_variable(connection, candidates, schema_seed)?;
    Ok(())
}

fn bind_paths_variable(
    connection: &Connection,
    candidates: &[DatasetMember],
    schema_seed: Option<&Path>,
) -> Result<(), DatasetSetupError> {
    let mut paths = candidates
        .iter()
        .map(|member| member.path.to_str().ok_or(DatasetError::Unsupported))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(escape_glob_path)
        .collect::<Vec<_>>();
    if let Some(seed) = schema_seed {
        let seed = seed.to_str().ok_or(DatasetError::Unsupported)?;
        paths.push(escape_glob_path(seed));
    }
    connection
        .execute(
            "SET VARIABLE __viewda_paths = string_split(?, chr(0))",
            [Value::Text(paths.join("\0"))],
        )
        .map_err(DatasetSetupError::Query)?;
    Ok(())
}

fn write_schema_seed(schema: &SchemaRef) -> Result<NamedTempFile, DatasetError> {
    let seed = NamedTempFile::new().map_err(|_| DataWindowError::ResourceExhausted)?;
    let file = seed
        .reopen()
        .map_err(|_| DataWindowError::ResourceExhausted)?;
    write_schema_seed_to(file, schema)?;
    Ok(seed)
}

fn write_schema_seed_to(file: fs::File, schema: &SchemaRef) -> Result<(), DatasetError> {
    let mut writer = ArrowWriter::try_new(file, Arc::clone(schema), None)
        .map_err(|_| DataWindowError::ResourceExhausted)?;
    writer
        .write(&RecordBatch::new_empty(Arc::clone(schema)))
        .map_err(|_| DataWindowError::ResourceExhausted)?;
    writer
        .close()
        .map_err(|_| DataWindowError::ResourceExhausted)?;
    Ok(())
}

pub(crate) fn redact_path_aliases<I, P>(message: &str, paths: I, replacement: &str) -> String
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    replace_redaction_candidates(
        message,
        path_redaction_candidates(paths)
            .into_iter()
            .map(|path| (path, replacement)),
    )
}

fn path_redaction_candidates<I, P>(paths: I) -> Vec<String>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut variants = Vec::new();
    for path in paths {
        let path = path.as_ref();
        variants.push(path.to_path_buf());
        if let Ok(absolute) = std::path::absolute(path) {
            variants.push(absolute);
        }
        if let Ok(canonical) = fs::canonicalize(path) {
            variants.push(canonical);
        }
    }
    variants.sort_unstable();
    variants.dedup();

    variants
        .into_iter()
        .flat_map(|path| {
            let path = path.to_string_lossy().into_owned();
            [escape_glob_path(&path), path]
        })
        .filter(|path| !path.is_empty())
        .collect()
}

fn replace_redaction_candidates<'a>(
    message: &str,
    candidates: impl IntoIterator<Item = (String, &'a str)>,
) -> String {
    let mut candidates = candidates.into_iter().collect::<Vec<_>>();
    candidates.sort_unstable_by(|(left, _), (right, _)| {
        right.len().cmp(&left.len()).then_with(|| left.cmp(right))
    });
    candidates.dedup_by(|(left, _), (right, _)| left == right);
    candidates
        .into_iter()
        .fold(message.to_owned(), |message, (path, replacement)| {
            message.replace(&path, replacement)
        })
}

fn escape_glob_path(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for character in path.chars() {
        match character {
            '*' => escaped.push_str("[*]"),
            '?' => escaped.push_str("[?]"),
            '[' => escaped.push_str("[[]"),
            ']' => escaped.push_str("[]]"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn folder_dataset_member(
    root: &Path,
    path: PathBuf,
    entry: &fs::DirEntry,
) -> Result<DatasetMember, DatasetError> {
    let metadata = entry.metadata().map_err(map_discovery_error)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| DatasetError::Unsupported)?;
    let relative_path = slash_path(relative)?;
    let partitions = parse_partitions(relative, &relative_path)?;
    let identity = member_identity(&path, &metadata).map_err(map_discovery_error)?;
    Ok(DatasetMember {
        ordinal: 0,
        path,
        relative_path,
        partitions,
        identity,
        row_count: None,
    })
}

fn explicit_dataset_member(root: &Path, requested: PathBuf) -> Result<DatasetMember, DatasetError> {
    if !has_parquet_extension(&requested) {
        return Err(DatasetError::Unsupported);
    }
    let logical = std::path::absolute(requested).map_err(map_discovery_error)?;
    logical.to_str().ok_or(DatasetError::Unsupported)?;
    let path =
        query_compatible_canonical_path(fs::canonicalize(&logical).map_err(map_discovery_error)?)?;
    path.to_str().ok_or(DatasetError::Unsupported)?;
    let metadata = fs::metadata(&path).map_err(map_discovery_error)?;
    if !metadata.is_file() {
        return Err(DatasetError::Unsupported);
    }
    let relative = logical
        .strip_prefix(root)
        .map_err(|_| DatasetError::Unsupported)?;
    let relative_path = slash_path(relative)?;
    let partitions = parse_partitions(relative, &relative_path)?;
    let identity = member_identity(&path, &metadata).map_err(map_discovery_error)?;
    Ok(DatasetMember {
        ordinal: 0,
        path,
        relative_path,
        partitions,
        identity,
        row_count: None,
    })
}

fn is_visible_parquet_path(root: &Path, path: &Path) -> bool {
    let Some(relative) = path.strip_prefix(root).ok() else {
        return false;
    };
    relative
        .components()
        .all(|component| !component.as_os_str().to_string_lossy().starts_with('.'))
        && has_parquet_extension(path)
}

fn has_parquet_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("parquet"))
}

fn slash_path(path: &Path) -> Result<String, DatasetError> {
    path.components()
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .map(str::to_owned)
                .ok_or(DatasetError::Unsupported)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|components| components.join("/"))
}

fn explicit_common_parent(
    paths: &[PathBuf],
    keep_going: &mut dyn FnMut() -> bool,
) -> Result<PathBuf, DatasetError> {
    if !keep_going() {
        return Err(DatasetError::Cancelled);
    }
    let first = std::path::absolute(paths.first().ok_or(DatasetError::NoParquetFiles)?)
        .map_err(map_discovery_error)?;
    if !has_parquet_extension(&first) {
        return Err(DatasetError::Unsupported);
    }
    let mut common = first
        .parent()
        .ok_or(DatasetError::Unsupported)?
        .to_path_buf();
    for path in &paths[1..] {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        if !has_parquet_extension(path) {
            return Err(DatasetError::Unsupported);
        }
        let path = std::path::absolute(path).map_err(map_discovery_error)?;
        while !path.starts_with(&common) {
            if !common.pop() {
                return Err(DatasetError::Unsupported);
            }
        }
    }
    while common
        .file_name()
        .and_then(|component| component.to_str())
        .is_some_and(is_hive_partition_component)
    {
        if !common.pop() {
            return Err(DatasetError::Unsupported);
        }
    }
    Ok(common)
}

// Windows canonicalization returns verbatim paths, while DuckDB file functions
// accept the equivalent drive or UNC spelling used by ordinary discovered members.
// The round trip proves that Win32 normalization of trailing dots, spaces, or
// device-like components cannot redirect the ordinary spelling to another target.
#[cfg(windows)]
fn query_compatible_canonical_path(path: PathBuf) -> Result<PathBuf, DatasetError> {
    let value = path.to_str().ok_or(DatasetError::Unsupported)?;
    let Some(candidate) = windows_path_without_verbatim_prefix(value).map(PathBuf::from) else {
        return (!value.starts_with(r"\\?\"))
            .then_some(path)
            .ok_or(DatasetError::Unsupported);
    };
    let target = fs::canonicalize(&candidate).map_err(|_| DatasetError::Unsupported)?;
    (target == path)
        .then_some(candidate)
        .ok_or(DatasetError::Unsupported)
}

#[cfg(not(windows))]
fn query_compatible_canonical_path(path: PathBuf) -> Result<PathBuf, DatasetError> {
    Ok(path)
}

#[cfg(any(windows, test))]
fn windows_path_without_verbatim_prefix(path: &str) -> Option<String> {
    path.strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| {
            let path = path.strip_prefix(r"\\?\")?;
            let prefix = path.as_bytes().get(..3)?;
            (prefix[0].is_ascii_alphabetic()
                && prefix[1] == b':'
                && matches!(prefix[2], b'\\' | b'/'))
            .then(|| path.to_owned())
        })
}

fn is_hive_partition_component(component: &str) -> bool {
    component
        .split_once('=')
        .is_some_and(|(key, _)| !key.is_empty())
}

fn canonical_partition_i64(value: &str) -> Option<i64> {
    if value == "0" {
        return Some(0);
    }
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn unique_column_name<'a>(names: impl IntoIterator<Item = &'a str>, base: &str) -> String {
    let names = names.into_iter().collect::<Vec<_>>();
    let mut candidate = base.to_owned();
    let mut suffix = 1_u32;
    while names
        .iter()
        .any(|name| name.eq_ignore_ascii_case(&candidate))
    {
        candidate = format!("{base}_{suffix}");
        suffix += 1;
    }
    candidate
}

fn parse_partitions(
    relative_path: &Path,
    relative_member: &str,
) -> Result<Vec<PartitionValue>, DatasetError> {
    let mut partitions = Vec::new();
    let Some(parent) = relative_path.parent() else {
        return Ok(partitions);
    };
    for component in parent.components() {
        let component = component
            .as_os_str()
            .to_str()
            .ok_or(DatasetError::Unsupported)?;
        let Some((key, value)) = component.split_once('=') else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        if partitions
            .iter()
            .any(|item: &PartitionValue| item.key.eq_ignore_ascii_case(key))
        {
            return Err(DatasetError::DuplicatePartitionKey {
                key: key.to_owned(),
                member: relative_member.to_owned(),
            });
        }
        partitions.push(PartitionValue {
            key: key.to_owned(),
            value: value.to_owned(),
        });
    }
    Ok(partitions)
}

fn merge_schema(
    union: &mut Vec<SchemaField>,
    member_schema: Vec<SchemaField>,
    member: &str,
) -> Result<(), DatasetError> {
    merge_schema_at(union, member_schema, member, "")
}

fn validate_dataset_schema_bounds(
    schema: &[SchemaField],
    partition_columns: &[PartitionColumn],
) -> Result<(), DatasetError> {
    fn field_size(field: &SchemaField) -> (usize, usize) {
        field.children.iter().fold(
            (
                1,
                field.name.len()
                    + field.physical_type.len()
                    + field.logical_type.as_ref().map_or(0, String::len),
            ),
            |(nodes, bytes), child| {
                let (child_nodes, child_bytes) = field_size(child);
                (
                    nodes.saturating_add(child_nodes),
                    bytes.saturating_add(child_bytes),
                )
            },
        )
    }

    let (nodes, schema_bytes) = schema.iter().fold((1_usize, 0_usize), |total, field| {
        let field = field_size(field);
        (
            total.0.saturating_add(field.0),
            total.1.saturating_add(field.1),
        )
    });
    let nodes = nodes.saturating_add(partition_columns.len());
    let bytes = schema_bytes.saturating_add(
        partition_columns
            .iter()
            .map(|column| column.name.len())
            .sum::<usize>(),
    );
    if nodes > MAX_DATASET_SCHEMA_NODES || bytes > MAX_DATASET_SCHEMA_BYTES {
        Err(DatasetError::Unsupported)
    } else {
        Ok(())
    }
}

fn merge_arrow_schemas(left: Schema, right: Schema) -> Result<Schema, DatasetError> {
    let mut fields = left
        .fields
        .iter()
        .map(|field| {
            if right
                .fields
                .iter()
                .any(|incoming| incoming.name().eq_ignore_ascii_case(field.name()))
            {
                Arc::clone(field)
            } else {
                Arc::new(field.as_ref().clone().with_nullable(true))
            }
        })
        .collect::<Vec<_>>();
    for incoming in right.fields.iter() {
        if let Some(index) = fields
            .iter()
            .position(|field| field.name().eq_ignore_ascii_case(incoming.name()))
        {
            fields[index] = merge_arrow_fields(&fields[index], incoming)?;
        } else {
            fields.push(Arc::new(incoming.as_ref().clone().with_nullable(true)));
        }
    }
    Ok(Schema::new_with_metadata(fields, left.metadata))
}

fn merge_arrow_fields(left: &Arc<Field>, right: &Arc<Field>) -> Result<Arc<Field>, DatasetError> {
    let data_type = match (left.data_type(), right.data_type()) {
        (left, right) if left == right => left.clone(),
        (DataType::Utf8, DataType::LargeUtf8) | (DataType::LargeUtf8, DataType::Utf8) => {
            DataType::LargeUtf8
        }
        (DataType::Binary, DataType::LargeBinary)
        | (DataType::LargeBinary, DataType::Binary)
        | (DataType::Binary, DataType::FixedSizeBinary(_))
        | (DataType::FixedSizeBinary(_), DataType::Binary)
        | (DataType::LargeBinary, DataType::FixedSizeBinary(_))
        | (DataType::FixedSizeBinary(_), DataType::LargeBinary)
        | (DataType::FixedSizeBinary(_), DataType::FixedSizeBinary(_)) => DataType::LargeBinary,
        (DataType::Dictionary(_, left_value), right) => merge_arrow_data_types(left_value, right)?,
        (left, DataType::Dictionary(_, right_value)) => merge_arrow_data_types(left, right_value)?,
        (DataType::Int32, DataType::Int64) | (DataType::Int64, DataType::Int32) => DataType::Int64,
        (DataType::Float32, DataType::Float64) | (DataType::Float64, DataType::Float32) => {
            DataType::Float64
        }
        (DataType::Struct(left_fields), DataType::Struct(right_fields)) => {
            let nested = merge_arrow_schemas(
                Schema::new(left_fields.clone()),
                Schema::new(right_fields.clone()),
            )?;
            DataType::Struct(nested.fields)
        }
        (DataType::List(left_field), DataType::List(right_field)) => {
            DataType::List(merge_arrow_fields(left_field, right_field)?)
        }
        (DataType::LargeList(left_field), DataType::LargeList(right_field)) => {
            DataType::LargeList(merge_arrow_fields(left_field, right_field)?)
        }
        (
            DataType::FixedSizeList(left_field, left_size),
            DataType::FixedSizeList(right_field, right_size),
        ) if left_size == right_size => {
            DataType::FixedSizeList(merge_arrow_fields(left_field, right_field)?, *left_size)
        }
        (DataType::Map(left_field, left_sorted), DataType::Map(right_field, right_sorted))
            if left_sorted == right_sorted =>
        {
            DataType::Map(
                merge_arrow_map_entries(left_field, right_field)?,
                *left_sorted,
            )
        }
        _ => return Err(DatasetError::Unsupported),
    };
    Ok(Arc::new(
        left.as_ref()
            .clone()
            .with_data_type(data_type)
            .with_nullable(left.is_nullable() || right.is_nullable()),
    ))
}

fn merge_arrow_data_types(left: &DataType, right: &DataType) -> Result<DataType, DatasetError> {
    let left = Arc::new(Field::new("value", left.clone(), true));
    let right = Arc::new(Field::new("value", right.clone(), true));
    merge_arrow_fields(&left, &right).map(|field| field.data_type().clone())
}

pub(crate) fn validate_produced_arrow_schema(
    expected: &Schema,
    produced: &Schema,
) -> Result<(), DataWindowError> {
    if expected.fields().len() != produced.fields().len()
        || expected
            .fields()
            .iter()
            .zip(produced.fields())
            .any(|(expected, produced)| {
                (if expected.name().is_empty() {
                    produced.name() != EMPTY_COLUMN_ALIAS
                } else {
                    expected.name() != produced.name()
                }) || !arrow_data_types_are_compatible(expected.data_type(), produced.data_type())
            })
    {
        return Err(DataWindowError::EncodingFailed);
    }
    Ok(())
}

fn arrow_data_types_are_compatible(expected: &DataType, produced: &DataType) -> bool {
    if expected == produced {
        return true;
    }
    match (expected, produced) {
        (DataType::Dictionary(_, expected), produced) => {
            arrow_data_types_are_compatible(expected, produced)
        }
        (expected, DataType::Dictionary(_, produced)) => {
            arrow_data_types_are_compatible(expected, produced)
        }
        (
            DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View,
            DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View,
        )
        | (
            DataType::Binary
            | DataType::LargeBinary
            | DataType::BinaryView
            | DataType::FixedSizeBinary(_),
            DataType::Binary
            | DataType::LargeBinary
            | DataType::BinaryView
            | DataType::FixedSizeBinary(_),
        )
        | (DataType::Float16, DataType::Float32)
        | (DataType::Float32, DataType::Float16)
        | (DataType::Date32, DataType::Date64)
        | (DataType::Date64, DataType::Date32) => true,
        (DataType::Timestamp(_, expected_timezone), DataType::Timestamp(_, produced_timezone)) => {
            expected_timezone.is_some() == produced_timezone.is_some()
        }
        (
            DataType::Decimal128(expected_precision, expected_scale),
            DataType::Decimal128(produced_precision, produced_scale),
        ) => expected_scale == produced_scale && expected_precision <= produced_precision,
        (
            DataType::Decimal256(expected_precision, expected_scale),
            DataType::Decimal256(produced_precision, produced_scale),
        ) => expected_scale == produced_scale && expected_precision <= produced_precision,
        (DataType::List(expected), DataType::List(produced))
        | (DataType::LargeList(expected), DataType::LargeList(produced)) => {
            arrow_data_types_are_compatible(expected.data_type(), produced.data_type())
        }
        (
            DataType::FixedSizeList(expected, expected_size),
            DataType::FixedSizeList(produced, produced_size),
        ) => {
            expected_size == produced_size
                && arrow_data_types_are_compatible(expected.data_type(), produced.data_type())
        }
        (DataType::Struct(expected), DataType::Struct(produced)) => {
            expected.len() == produced.len()
                && expected
                    .iter()
                    .zip(produced)
                    .all(|(expected, produced)| arrow_fields_are_compatible(expected, produced))
        }
        (DataType::Map(expected, _), DataType::Map(produced, _)) => {
            arrow_data_types_are_compatible(expected.data_type(), produced.data_type())
        }
        _ => false,
    }
}

fn arrow_fields_are_compatible(expected: &Field, produced: &Field) -> bool {
    expected.name() == produced.name()
        && arrow_data_types_are_compatible(expected.data_type(), produced.data_type())
}

fn merge_arrow_map_entries(
    left: &Arc<Field>,
    right: &Arc<Field>,
) -> Result<Arc<Field>, DatasetError> {
    let (DataType::Struct(left_fields), DataType::Struct(right_fields)) =
        (left.data_type(), right.data_type())
    else {
        return Err(DatasetError::Unsupported);
    };
    if left_fields.len() != 2 || right_fields.len() != 2 {
        return Err(DatasetError::Unsupported);
    }
    let fields = vec![
        merge_arrow_fields(&left_fields[0], &right_fields[0])?,
        merge_arrow_fields(&left_fields[1], &right_fields[1])?,
    ];
    Ok(Arc::new(
        left.as_ref()
            .clone()
            .with_data_type(DataType::Struct(fields.into()))
            .with_nullable(left.is_nullable() || right.is_nullable()),
    ))
}

fn validate_member_schema(
    schema: &[SchemaField],
    member: &str,
    prefix: &str,
) -> Result<(), DatasetError> {
    for (index, field) in schema.iter().enumerate() {
        let qualified_name = if prefix.is_empty() {
            field.name.clone()
        } else {
            format!("{prefix}.{}", field.name)
        };
        if schema[..index]
            .iter()
            .any(|earlier| earlier.name.eq_ignore_ascii_case(&field.name))
        {
            return schema_conflict(&qualified_name, member);
        }
        validate_member_schema(&field.children, member, &qualified_name)?;
    }
    Ok(())
}

fn merge_schema_at(
    union: &mut Vec<SchemaField>,
    member_schema: Vec<SchemaField>,
    member: &str,
    prefix: &str,
) -> Result<(), DatasetError> {
    for field in member_schema {
        let qualified_name = if prefix.is_empty() {
            field.name.clone()
        } else {
            format!("{prefix}.{}", field.name)
        };
        if let Some(existing) = union
            .iter_mut()
            .find(|candidate| candidate.name.eq_ignore_ascii_case(&field.name))
        {
            merge_field(existing, field, member, &qualified_name)?;
        } else {
            union.push(field);
        }
    }
    Ok(())
}

fn visible_schema(
    union_schema: &[SchemaField],
    partition_columns: &[PartitionColumn],
) -> Result<(Vec<SchemaField>, Vec<u32>, u32), DatasetError> {
    let mut schema = union_schema.to_vec();
    let mut partition_column_indices = Vec::with_capacity(partition_columns.len());
    for column in partition_columns {
        let name = unique_column_name(schema.iter().map(|field| field.name.as_str()), &column.name);
        partition_column_indices
            .push(u32::try_from(schema.len()).map_err(|_| DatasetError::Unsupported)?);
        schema.push(match column.kind {
            PartitionColumnKind::Text => text_field(&name),
            PartitionColumnKind::Int64 => int64_field(&name),
        });
    }
    let provenance_name = unique_column_name(
        schema.iter().map(|field| field.name.as_str()),
        PROVENANCE_COLUMN,
    );
    let provenance_column_index =
        u32::try_from(schema.len()).map_err(|_| DatasetError::Unsupported)?;
    schema.push(text_field(&provenance_name));
    Ok((schema, partition_column_indices, provenance_column_index))
}

fn merge_field(
    existing: &mut SchemaField,
    incoming: SchemaField,
    member: &str,
    qualified_name: &str,
) -> Result<(), DatasetError> {
    if existing.physical_type == "GROUP" && incoming.physical_type == "GROUP" {
        if existing.logical_type != incoming.logical_type {
            return schema_conflict(qualified_name, member);
        }
        match existing.logical_type.as_deref() {
            Some("List") => {
                return merge_list_schema(existing, incoming, member, qualified_name);
            }
            Some("Map") => {
                return merge_map_schema(existing, incoming, member, qualified_name);
            }
            _ => {}
        }
        return merge_schema_at(
            &mut existing.children,
            incoming.children,
            member,
            qualified_name,
        );
    }
    if existing.logical_type != incoming.logical_type {
        return schema_conflict(qualified_name, member);
    }
    if existing.physical_type == incoming.physical_type {
        return Ok(());
    }
    let promoted = promote_numeric_type(&existing.physical_type, &incoming.physical_type)
        .ok_or_else(|| DatasetError::SchemaConflict {
            column: qualified_name.to_owned(),
            member: member.to_owned(),
        })?;
    existing.physical_type = promoted.to_owned();
    Ok(())
}

fn merge_list_schema(
    existing: &mut SchemaField,
    mut incoming: SchemaField,
    member: &str,
    qualified_name: &str,
) -> Result<(), DatasetError> {
    if existing.children.len() != 1 || incoming.children.len() != 1 {
        return schema_conflict(qualified_name, member);
    }
    let existing_wrapper = &mut existing.children[0];
    let incoming_wrapper = incoming.children.remove(0);
    if existing_wrapper.physical_type != "GROUP"
        || incoming_wrapper.physical_type != "GROUP"
        || existing_wrapper.children.len() != 1
        || incoming_wrapper.children.len() != 1
    {
        return schema_conflict(qualified_name, member);
    }
    let element_name = existing_wrapper.children[0].name.clone();
    let element_path = format!("{qualified_name}.{element_name}");
    merge_field(
        &mut existing_wrapper.children[0],
        incoming_wrapper
            .children
            .into_iter()
            .next()
            .ok_or_else(|| DatasetError::SchemaConflict {
                column: qualified_name.to_owned(),
                member: member.to_owned(),
            })?,
        member,
        &element_path,
    )
}

fn merge_map_schema(
    existing: &mut SchemaField,
    mut incoming: SchemaField,
    member: &str,
    qualified_name: &str,
) -> Result<(), DatasetError> {
    if existing.children.len() != 1 || incoming.children.len() != 1 {
        return schema_conflict(qualified_name, member);
    }
    let existing_wrapper = &mut existing.children[0];
    let incoming_wrapper = incoming.children.remove(0);
    if existing_wrapper.physical_type != "GROUP"
        || incoming_wrapper.physical_type != "GROUP"
        || existing_wrapper.children.len() != 2
        || incoming_wrapper.children.len() != 2
    {
        return schema_conflict(qualified_name, member);
    }
    for (existing_child, incoming_child) in existing_wrapper
        .children
        .iter_mut()
        .zip(incoming_wrapper.children)
    {
        let child_path = format!("{qualified_name}.{}", existing_child.name);
        merge_field(existing_child, incoming_child, member, &child_path)?;
    }
    Ok(())
}

fn promote_numeric_type(left: &str, right: &str) -> Option<&'static str> {
    match (left, right) {
        ("INT32", "INT64") | ("INT64", "INT32") => Some("INT64"),
        ("FLOAT", "DOUBLE") | ("DOUBLE", "FLOAT") => Some("DOUBLE"),
        _ => None,
    }
}

fn schema_conflict<T>(column: &str, member: &str) -> Result<T, DatasetError> {
    Err(DatasetError::SchemaConflict {
        column: column.to_owned(),
        member: member.to_owned(),
    })
}

fn text_field(name: &str) -> SchemaField {
    SchemaField {
        name: name.to_owned(),
        physical_type: "BYTE_ARRAY".to_owned(),
        logical_type: Some("String".to_owned()),
        children: Vec::new(),
    }
}

fn int64_field(name: &str) -> SchemaField {
    SchemaField {
        name: name.to_owned(),
        physical_type: "INT64".to_owned(),
        logical_type: None,
        children: Vec::new(),
    }
}

fn member_matches_prunable_filters(
    member: &DatasetMember,
    summary: &DatasetSummary,
    partition_columns: &[PartitionColumn],
    filters: &[DataFilter],
) -> bool {
    filters.iter().all(|filter| {
        let Some(resolved) = resolve_field_path(&summary.schema, &filter.field_path) else {
            return true;
        };
        let Ok(column_index) = u32::try_from(resolved.root_index) else {
            return true;
        };
        let is_partition = summary.partition_column_indices.contains(&column_index);
        if column_index != summary.provenance_column_index && !is_partition {
            return true;
        }
        let value = if column_index == summary.provenance_column_index {
            Some(member.relative_path.as_str())
        } else {
            let Some(partition_index) = summary
                .partition_column_indices
                .iter()
                .position(|index| *index == column_index)
            else {
                return true;
            };
            let Some(column) = partition_columns.get(partition_index) else {
                return true;
            };
            let value = member
                .partitions
                .iter()
                .find(|partition| partition.key.eq_ignore_ascii_case(&column.name))
                .and_then(|partition| column.query_value(&partition.value));
            return partition_filter_matches(value, column.kind, filter);
        };
        text_filter_matches(value, filter)
    })
}

#[cfg(test)]
fn candidate_members<'a>(
    members: &'a [DatasetMember],
    summary: &DatasetSummary,
    partition_columns: &[PartitionColumn],
    filters: &[DataFilter],
) -> Vec<&'a DatasetMember> {
    members
        .iter()
        .filter(|member| {
            member_matches_prunable_filters(member, summary, partition_columns, filters)
        })
        .collect()
}

fn diagnose_query_failure(
    source: &DatasetSource,
    candidates: &[DatasetMember],
    error: DuckDbError,
    has_filters: bool,
) -> DatasetError {
    let classified = classify_query_error(error, has_filters);
    if matches!(
        classified,
        DataWindowError::InvalidFilter | DataWindowError::ResourceExhausted
    ) {
        return DatasetError::Window { error: classified };
    }
    if let Err(diagnostic) = diagnose_candidate_members(source, candidates) {
        return diagnostic;
    }
    DatasetError::Window { error: classified }
}

fn diagnose_lazy_query_failure(
    source: &DatasetSource,
    candidates: &[DatasetMember],
    panic: &(dyn Any + Send),
    has_filters: bool,
) -> DatasetError {
    if let Some(message) = panic_message(panic) {
        if classify_member_read_message(message) == Some(DataWindowError::ResourceExhausted) {
            return DatasetError::Window {
                error: DataWindowError::ResourceExhausted,
            };
        }
        if has_filters
            && (message.contains("Conversion Error:") || message.contains("Could not convert"))
        {
            return DatasetError::Window {
                error: DataWindowError::InvalidFilter,
            };
        }
    }
    if let Err(diagnostic) = diagnose_candidate_members(source, candidates) {
        return diagnostic;
    }
    DatasetError::Window {
        error: DataWindowError::QueryFailed,
    }
}

fn panic_message(panic: &(dyn Any + Send)) -> Option<&str> {
    panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&'static str>().copied())
}

fn diagnose_candidate_members(
    source: &DatasetSource,
    candidates: &[DatasetMember],
) -> Result<(), DatasetError> {
    let mut connection = None;
    for member in candidates {
        source.ensure_member_unchanged(member)?;
        if let Err(error) = inspect_local_source(&member.path) {
            return Err(source.latch_member_error(error, member));
        }
        let connection = match &connection {
            Some(connection) => connection,
            None => connection.insert(Connection::open_in_memory().map_err(|_| {
                DatasetError::Window {
                    error: DataWindowError::QueryFailed,
                }
            })?),
        };
        match probe_member_data(connection, member) {
            Err(DataWindowError::CorruptSource | DataWindowError::NotParquet) => {
                source.ensure_member_unchanged(member)?;
                if let Err(error) = inspect_local_source(&member.path) {
                    return Err(source.latch_member_error(error, member));
                }
                return Err(source.latch_invalid_member(member));
            }
            Err(DataWindowError::ResourceExhausted) => {
                return Err(DatasetError::Window {
                    error: DataWindowError::ResourceExhausted,
                });
            }
            _ => {}
        }
    }
    Ok(())
}

fn probe_member_data(
    connection: &Connection,
    member: &DatasetMember,
) -> Result<(), DataWindowError> {
    let path = member.path.to_str().ok_or(DataWindowError::Unsupported)?;
    let mut statement = connection
        .prepare("SELECT * FROM read_parquet(?)")
        .map_err(classify_member_probe_error)?;
    let mut batches = statement
        .stream_arrow([Value::Text(escape_glob_path(path))])
        .map_err(classify_member_probe_error)?;
    catch_unwind(AssertUnwindSafe(|| {
        for batch in &mut batches {
            std::hint::black_box(batch.num_rows());
        }
    }))
    .map_err(|panic| {
        panic_message(panic.as_ref())
            .and_then(classify_member_read_message)
            .unwrap_or(DataWindowError::QueryFailed)
    })
}

fn classify_member_probe_error(error: DuckDbError) -> DataWindowError {
    let member_failure = match &error {
        DuckDbError::DuckDBFailure(_, Some(message)) => classify_member_read_message(message),
        _ => None,
    };
    let classified = classify_query_error(error, false);
    if classified != DataWindowError::QueryFailed {
        return classified;
    }
    member_failure.unwrap_or(classified)
}

fn classify_member_read_message(message: &str) -> Option<DataWindowError> {
    let message = message.to_ascii_lowercase();
    if message.contains("out of memory error:") {
        return Some(DataWindowError::ResourceExhausted);
    }
    (message.contains("parquet error:")
        || message.contains("tprotocolexception")
        || message.contains("decompress")
        || message.contains("checksum")
        || message.contains("io error")
        || message.contains("permission denied")
        || message.contains("could not open file")
        || message.contains("cannot open file"))
    .then_some(DataWindowError::CorruptSource)
}

fn text_filter_matches(value: Option<&str>, filter: &DataFilter) -> bool {
    match filter.operator {
        DataFilterOperator::Equals => value.is_some_and(|value| value == filter.values[0]),
        DataFilterOperator::NotEquals => value.is_some_and(|value| value != filter.values[0]),
        DataFilterOperator::OneOf => {
            value.is_some_and(|value| filter.values.iter().any(|item| item == value))
        }
        DataFilterOperator::IsNull => value.is_none(),
        DataFilterOperator::IsNotNull => value.is_some(),
        _ => true,
    }
}

fn partition_filter_matches(
    value: Option<PartitionScalar<'_>>,
    kind: PartitionColumnKind,
    filter: &DataFilter,
) -> bool {
    match kind {
        PartitionColumnKind::Text => text_filter_matches(
            value.and_then(|value| match value {
                PartitionScalar::Text(value) => Some(value),
                PartitionScalar::Int64(_) => None,
            }),
            filter,
        ),
        PartitionColumnKind::Int64 => {
            let value = value.and_then(|value| match value {
                PartitionScalar::Int64(value) => Some(value),
                PartitionScalar::Text(_) => None,
            });
            if filter.operator == DataFilterOperator::IsNull {
                return value.is_none();
            }
            if filter.operator == DataFilterOperator::IsNotNull {
                return value.is_some();
            }
            let Some(values) = filter
                .values
                .iter()
                .map(|value| value.parse::<i64>())
                .collect::<Result<Vec<_>, _>>()
                .ok()
            else {
                // DuckDB owns filter conversion errors. Keeping every candidate
                // prevents pruning from turning an invalid filter into empty data.
                return true;
            };
            match filter.operator {
                DataFilterOperator::Equals => value.is_some_and(|value| value == values[0]),
                DataFilterOperator::NotEquals => value.is_some_and(|value| value != values[0]),
                DataFilterOperator::GreaterThan => value.is_some_and(|value| value > values[0]),
                DataFilterOperator::GreaterThanOrEqual => {
                    value.is_some_and(|value| value >= values[0])
                }
                DataFilterOperator::LessThan => value.is_some_and(|value| value < values[0]),
                DataFilterOperator::LessThanOrEqual => {
                    value.is_some_and(|value| value <= values[0])
                }
                DataFilterOperator::OneOf => value.is_some_and(|value| values.contains(&value)),
                DataFilterOperator::Range => {
                    value.is_some_and(|value| values[0] <= value && value <= values[1])
                }
                _ => true,
            }
        }
    }
}

fn map_discovery_error(error: std::io::Error) -> DatasetError {
    match error.kind() {
        std::io::ErrorKind::NotFound => DatasetError::NotFound,
        std::io::ErrorKind::PermissionDenied => DatasetError::PermissionDenied,
        _ => DatasetError::Unsupported,
    }
}

fn member_identity(path: &Path, metadata: &fs::Metadata) -> Result<MemberIdentity, std::io::Error> {
    Ok(MemberIdentity {
        size_bytes: metadata.len(),
        modified: metadata.modified().ok(),
        platform: platform_file_identity(path, metadata)?,
    })
}

#[cfg(unix)]
fn platform_file_identity(
    _path: &Path,
    metadata: &fs::Metadata,
) -> Result<PlatformFileIdentity, std::io::Error> {
    Ok(PlatformFileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn platform_file_identity(
    path: &Path,
    _metadata: &fs::Metadata,
) -> Result<PlatformFileIdentity, std::io::Error> {
    let file = fs::File::open(path)?;
    let (volume_serial_number, file_id) = windows_file_identity(&file)?;
    Ok(PlatformFileIdentity::Windows {
        volume_serial_number,
        file_id,
    })
}

#[cfg(not(any(unix, windows)))]
fn platform_file_identity(
    _path: &Path,
    _metadata: &fs::Metadata,
) -> Result<PlatformFileIdentity, std::io::Error> {
    Ok(PlatformFileIdentity::Unavailable)
}

fn map_member_error(error: SourceError, member: &DatasetMember) -> DatasetError {
    match error {
        SourceError::NotFound | SourceError::SourceChanged => DatasetError::SourceChanged {
            member: member.relative_path.clone(),
        },
        SourceError::PermissionDenied => DatasetError::MemberPermissionDenied {
            member: member.relative_path.clone(),
        },
        SourceError::NotParquet | SourceError::CorruptFooter | SourceError::Unsupported => {
            DatasetError::InvalidMember {
                member: member.relative_path.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{FileTimes, OpenOptions},
        io::{Seek, SeekFrom, Write},
    };

    use arrow_array::{Int64Array, StringArray, StructArray};
    use arrow_schema::{Field, Fields};
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn sparse_nested_projection_matches_leaf_segments_case_sensitively() {
        let source = tempfile::NamedTempFile::new().expect("nested source");
        let profile_fields = Fields::from(vec![
            Field::new("city", DataType::Utf8, true),
            Field::new("City", DataType::Utf8, true),
            Field::new("zip", DataType::Int64, true),
        ]);
        let profile = StructArray::new(
            profile_fields.clone(),
            vec![
                Arc::new(StringArray::from(vec!["Oslo"])) as ArrayRef,
                Arc::new(StringArray::from(vec!["Bergen"])) as ArrayRef,
                Arc::new(Int64Array::from(vec![101])) as ArrayRef,
            ],
            None,
        );
        let schema = Arc::new(Schema::new(vec![
            Field::new("profile", DataType::Struct(profile_fields), true),
            Field::new("tail", DataType::Int64, true),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(profile) as ArrayRef,
                Arc::new(Int64Array::from(vec![9])) as ArrayRef,
            ],
        )
        .expect("nested batch");
        let file = fs::File::create(source.path()).expect("nested file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("nested writer");
        writer.write(&batch).expect("nested row");
        writer.close().expect("nested footer");
        let file = fs::File::open(source.path()).expect("nested source read");
        let metadata =
            ArrowReaderMetadata::load(&file, ArrowReaderOptions::new()).expect("nested metadata");

        let (indices, projected) =
            parquet_leaf_projection(&metadata, &[FieldPath::new(["profile", "city"])])
                .expect("leaf projection");
        let descriptor = metadata.metadata().file_metadata().schema_descr();
        let paths = indices
            .iter()
            .map(|index| descriptor.column(*index).path().parts().to_vec())
            .collect::<Vec<_>>();

        assert_eq!(indices, [0]);
        assert_eq!(paths, [vec!["profile".to_owned(), "city".to_owned()]]);
        let DataType::Struct(children) = projected.field(0).data_type() else {
            panic!("projected profile should stay a struct");
        };
        assert_eq!(
            children
                .iter()
                .map(|field| field.name())
                .collect::<Vec<_>>(),
            ["city"]
        );
    }

    #[test]
    fn query_source_redacts_every_internal_path_from_diagnostics() {
        let directory = tempdir().expect("dataset directory");
        let first = directory.path().join("br[ack].parquet");
        let second = directory.path().join("b.parquet");
        write_test_member(&first, 1);
        write_test_member(&second, 2);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(2).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let query_source = reader.query_source().expect("query source");
        let connection = Connection::open_in_memory().expect("query connection");
        query_source.install(&connection).expect("dataset install");
        let mut cursor = query_source.candidate_batches(&[]);
        assert!(
            query_source
                .bind_next_candidate_batch(&connection, &mut cursor, || true)
                .expect("member bind")
        );
        let first_escaped = escape_glob_path(first.to_string_lossy().as_ref());
        let canonical_first = fs::canonicalize(&first).expect("canonical member");
        let canonical_first_escaped = escape_glob_path(canonical_first.to_string_lossy().as_ref());
        let seed_escaped =
            escape_glob_path(query_source.schema_seed.path().to_string_lossy().as_ref());
        let canonical_seed =
            fs::canonicalize(query_source.schema_seed.path()).expect("canonical seed");
        let canonical_seed_escaped = escape_glob_path(canonical_seed.to_string_lossy().as_ref());
        let message = format!(
            "failed to read {}, {}, {}, {}, {}, {}, {}, {}, and {}",
            first.display(),
            first_escaped,
            canonical_first.display(),
            canonical_first_escaped,
            second.display(),
            query_source.schema_seed.path().display(),
            seed_escaped,
            canonical_seed.display(),
            canonical_seed_escaped,
        );

        let redacted = query_source.redact_paths(&message);

        assert_eq!(
            redacted,
            "failed to read <source member>, <source member>, <source member>, <source member>, <source member>, <temporary file>, <temporary file>, <temporary file>, and <temporary file>"
        );
    }

    #[test]
    fn redaction_boundary_handles_explicit_aliases_and_glob_spellings() {
        let original = PathBuf::from("logical/br[ack].parquet");
        let canonical = PathBuf::from("canonical/br[ack].parquet");
        let message = format!(
            "read {}, {}, {}, and {}",
            original.display(),
            escape_glob_path(original.to_string_lossy().as_ref()),
            canonical.display(),
            escape_glob_path(canonical.to_string_lossy().as_ref()),
        );

        assert_eq!(
            redact_path_aliases(&message, [&original, &canonical], "<source member>"),
            "read <source member>, <source member>, <source member>, and <source member>"
        );
    }

    #[test]
    fn sparse_member_files_are_bounded_and_cleaned_after_success_cancel_and_error() {
        let _counter_guard = SPARSE_SOURCE_COUNTER_LOCK
            .lock()
            .expect("sparse counter lock");
        let directory = tempdir().expect("dataset directory");
        let member_path = directory.path().join("part.parquet");
        write_test_member(&member_path, 7);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let query_source = reader.query_source().expect("query source");
        let temporary_parent = tempdir().expect("sparse parent");
        let positions = [DatasetRowPosition {
            member_ordinal: 0,
            native_row: 0,
            requested_order: 0,
        }];

        SPARSE_SOURCE_ROW_GROUP_READS.store(0, Ordering::Relaxed);
        SPARSE_SOURCE_DECODED_ROWS.store(0, Ordering::Relaxed);
        let rows = query_source
            .stage_sparse_window_while(
                &positions,
                &[FieldPath::from("value")],
                temporary_parent.path(),
                || true,
            )
            .expect("sparse rows");
        let sparse_directory = rows._directory.path().to_owned();
        assert_eq!(sparse_directory.parent(), Some(temporary_parent.path()));
        assert_eq!(rows._files.len(), 1);
        assert!(rows._files[0].exists());
        assert_eq!(SPARSE_SOURCE_ROW_GROUP_READS.load(Ordering::Relaxed), 1);
        assert_eq!(SPARSE_SOURCE_DECODED_ROWS.load(Ordering::Relaxed), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&sparse_directory)
                    .expect("sparse directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        drop(rows);
        assert!(!sparse_directory.exists());

        let mut saw_sparse_directory = false;
        let cancelled = query_source.stage_sparse_window_while(
            &positions,
            &[FieldPath::from("value")],
            temporary_parent.path(),
            || {
                let exists = fs::read_dir(temporary_parent.path())
                    .expect("sparse parent entries")
                    .next()
                    .is_some();
                if exists {
                    let keep_going = !saw_sparse_directory;
                    saw_sparse_directory = true;
                    keep_going
                } else {
                    true
                }
            },
        );
        assert!(matches!(cancelled, Err(DatasetError::Cancelled)));
        assert!(saw_sparse_directory);
        assert!(
            fs::read_dir(temporary_parent.path())
                .expect("sparse parent after cancellation")
                .next()
                .is_none()
        );

        corrupt_test_member_data(&member_path);
        assert!(matches!(
            query_source.stage_sparse_window_while(
                &positions,
                &[FieldPath::from("value")],
                temporary_parent.path(),
                || true,
            ),
            Err(DatasetError::InvalidMember { member }) if member == "part.parquet"
        ));
        assert!(
            fs::read_dir(temporary_parent.path())
                .expect("sparse parent after read failure")
                .next()
                .is_none()
        );
    }

    #[test]
    fn far_scalar_sparse_row_decodes_only_the_requested_row() {
        let _counter_guard = SPARSE_SOURCE_COUNTER_LOCK
            .lock()
            .expect("sparse counter lock");
        let directory = tempdir().expect("dataset directory");
        let member_path = directory.path().join("part.parquet");
        write_test_member_groups(&member_path, 2, 2_048);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let query_source = reader.query_source().expect("query source");
        let temporary_parent = tempdir().expect("sparse parent");
        SPARSE_SOURCE_ROW_GROUP_READS.store(0, Ordering::Relaxed);
        SPARSE_SOURCE_DECODED_ROWS.store(0, Ordering::Relaxed);

        let rows = query_source
            .stage_sparse_window_while(
                &[DatasetRowPosition {
                    member_ordinal: 0,
                    native_row: 4_095,
                    requested_order: 0,
                }],
                &[FieldPath::from("value")],
                temporary_parent.path(),
                || true,
            )
            .expect("far sparse row");

        assert_eq!(rows.row_count(), 1);
        assert_eq!(SPARSE_SOURCE_ROW_GROUP_READS.load(Ordering::Relaxed), 1);
        assert_eq!(SPARSE_SOURCE_DECODED_ROWS.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn root_dataset_resource_diagnostics_never_echo_member_paths() {
        let source = test_source(vec![member("a.parquet", "2025")], &[1]);
        let query_source = DatasetQuerySource {
            source: DatasetSource {
                logical_root: PathBuf::from(std::path::MAIN_SEPARATOR.to_string()),
                root: PathBuf::from(std::path::MAIN_SEPARATOR.to_string()),
                ..source
            },
            summary: DatasetSummary {
                display_name: "/".to_owned(),
                member_count: 1,
                ignored_file_count: 0,
                size_bytes: 0,
                row_count: 1,
                row_group_count: 1,
                schema: vec![text_field("value"), text_field("file")],
                schema_drift_member_count: 0,
                partition_column_indices: vec![],
                provenance_column_index: 1,
            },
            partition_columns: vec![],
            filename_column: "file".to_owned(),
            row_column: "row".to_owned(),
            ordinal_column: "ordinal".to_owned(),
            physical_column_count: 1,
            arrow_schema: Arc::new(Schema::empty()),
            member_limit: 1,
            schema_seed: write_schema_seed(&Arc::new(Schema::empty())).expect("schema seed"),
            bound_members: Mutex::new(Vec::new()),
        };

        let secret = "/private/unbound.parquet";
        let redacted = query_source.redact_paths(secret);
        assert_eq!(redacted, "dataset query resource exhausted");
        assert!(!redacted.contains(secret));
    }

    #[test]
    fn member_snapshot_rejects_and_latches_replacement_during_open() {
        let directory = tempdir().expect("dataset directory");
        let selected = directory.path().join("a.parquet");
        write_test_member(&selected, 1);
        write_test_member(&directory.path().join("b.parquet"), 2);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(2).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");

        let error = match reader.member_snapshot_checked(
            0,
            || true,
            || {
                let replacement = directory.path().join("replacement.parquet");
                write_test_member(&replacement, 3);
                fs::rename(replacement, &selected).expect("replace selected member");
            },
        ) {
            Ok(_) => panic!("replacement during snapshot open must fail"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            DatasetError::SourceChanged {
                member: "a.parquet".to_owned(),
            }
        );
        assert_eq!(reader.member_snapshot(0).err(), Some(error));
    }

    #[test]
    fn member_row_offset_has_constant_selected_member_io() {
        const MEMBER_COUNT: usize = 1_000;
        const SELECTED_ORDINAL: usize = 731;

        let directory = tempdir().expect("selected member directory");
        let selected_path = directory.path().join("selected.parquet");
        write_test_member(&selected_path, 1);
        let selected_metadata = fs::metadata(&selected_path).expect("selected member metadata");
        let selected_identity =
            member_identity(&selected_path, &selected_metadata).expect("selected identity");
        let members = (0..MEMBER_COUNT)
            .map(|ordinal| {
                let mut member = member(&format!("part-{ordinal:04}.parquet"), "2025");
                member.ordinal = ordinal as u64;
                if ordinal == SELECTED_ORDINAL {
                    member.path = selected_path.clone();
                    member.identity = selected_identity;
                }
                member
            })
            .collect::<Vec<_>>();
        let source = test_source(members, &vec![1; MEMBER_COUNT]);
        let catalog = Arc::clone(&source.catalog);
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        let interrupt = connection.interrupt_handle();
        let reader = DatasetWindowReader {
            source: source.clone(),
            summary: DatasetSummary {
                display_name: "dataset/".to_owned(),
                member_count: MEMBER_COUNT as u64,
                ignored_file_count: 0,
                size_bytes: 0,
                row_count: MEMBER_COUNT as u64,
                row_group_count: MEMBER_COUNT as u64,
                schema: Vec::new(),
                schema_drift_member_count: 0,
                partition_column_indices: Vec::new(),
                provenance_column_index: 0,
            },
            partition_columns: Vec::new(),
            connection,
            member_limit: None,
            arrow_schema: Arc::new(Schema::empty()),
            filename_column: "file".to_owned(),
            physical_column_count: 0,
            schema_seed: None,
            _temporary_directory: None,
            interrupt,
            interrupted: Arc::new(AtomicBool::new(false)),
        };

        assert_eq!(
            reader.member_row_offset(SELECTED_ORDINAL as u64),
            Ok(SELECTED_ORDINAL as u64)
        );
        assert_eq!(catalog.member_batch_query_count(), 1);
        assert_eq!(source.identity_check_count(), 2);
    }

    #[test]
    fn prepared_view_index_contains_only_dataset_row_positions() {
        let directory = tempdir().expect("dataset directory");
        write_test_member(&directory.path().join("a.parquet"), 2);
        write_test_member(&directory.path().join("b.parquet"), 1);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(2).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let view = crate::DataViewBuilder::for_dataset(
            &reader,
            &[],
            &[crate::DataSort {
                field_path: FieldPath::from("value"),
                json_target: None,
                direction: crate::DataSortDirection::Ascending,
            }],
            crate::DataViewMemoryLimit::Mb384,
        )
        .expect("dataset view builder")
        .build()
        .expect("prepared dataset view");
        let index = inspect_local_source(view.position_index_path()).expect("position index");

        assert_eq!(index.row_count, 2);
        assert_eq!(
            index
                .schema
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            ["__viewda_member_ordinal", "__viewda_native_row"]
        );
    }

    #[test]
    fn preview_session_is_upgraded_without_reprocessing_its_first_footer() {
        let directory = tempdir().expect("dataset directory");
        write_test_member(&directory.path().join("a.parquet"), 1);
        write_test_member(&directory.path().join("b.parquet"), 2);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();

        let preview = inspector.preview(1).expect("preview");
        assert_eq!(preview.progress.completed_member_count, 1);
        inspector
            .preview_reader
            .as_ref()
            .expect("preview reader")
            .connection
            .execute_batch("SET VARIABLE __viewda_session_marker = 71")
            .expect("session marker");
        assert_eq!(
            inspector
                .advance(1)
                .expect("second footer")
                .completed_member_count,
            2
        );
        let reader = inspector.into_window_reader().expect("upgraded reader");
        let marker = reader
            .connection
            .query_row("SELECT getvariable('__viewda_session_marker')", [], |row| {
                row.get::<_, i32>(0)
            })
            .expect("preserved session marker");

        assert_eq!(marker, 71);
        assert_eq!(reader.summary.row_count, 2);
    }

    #[test]
    fn thousand_distinct_members_share_sample_footers_with_one_full_pass() {
        let template_directory = tempdir().expect("template directory");
        let template = template_directory.path().join("template.parquet");
        write_test_member(&template, 1);
        let parquet = fs::read(template).expect("minimal Parquet bytes");
        let directory = tempdir().expect("dataset directory");
        for ordinal in 0..1_000 {
            fs::write(
                directory.path().join(format!("part-{ordinal:04}.parquet")),
                &parquet,
            )
            .expect("distinct member");
        }

        let mut discovery = DatasetSource::begin_folder(directory.path()).expect("begin discovery");
        discovery.advance(32).expect("bounded discovery");
        assert!(discovery.preview_members.len() <= MAX_PREVIEW_MEMBERS as usize);
        assert!(
            discovery
                .catalog
                .as_ref()
                .expect("active catalog")
                .pending_member_count()
                <= CATALOG_PAGE_MEMBERS as usize
        );
        let sample_source = discovery
            .next_preview_candidate()
            .expect("sample candidate")
            .expect("ready candidate");
        loop {
            let progress = discovery
                .advance(CATALOG_PAGE_MEMBERS)
                .expect("catalog page");
            assert!(
                discovery
                    .catalog
                    .as_ref()
                    .expect("active catalog")
                    .pending_member_count()
                    <= CATALOG_PAGE_MEMBERS as usize
            );
            if progress.complete {
                break;
            }
        }
        let full_source = discovery.into_source().expect("full source");

        let mut sample_inspector = sample_source.inspector();
        sample_inspector.preview(1).expect("bounded sample preview");
        let sample_reads = full_source.footer_read_count();
        assert!((1..=MAX_PREVIEW_MEMBERS).contains(&sample_reads));
        assert!(
            full_source.footer_cache.lock().expect("footer cache").len()
                <= MAX_PREVIEW_MEMBERS as usize
        );

        let mut full_inspector = full_source.inspector();
        full_inspector.preview(1).expect("full preview");
        while full_inspector
            .advance(CATALOG_PAGE_MEMBERS)
            .expect("full footer page")
            .summary
            .is_none()
        {}
        assert_eq!(full_source.footer_read_count(), 1_000);
        assert!(
            full_source
                .footer_cache
                .lock()
                .expect("footer cache")
                .is_empty()
        );

        let checks_before_publish = full_source.identity_check_count();
        let reader = full_inspector
            .into_window_reader()
            .expect("completed dataset reader");
        assert_eq!(reader.summary().member_count, 1_000);
        assert_eq!(full_source.footer_read_count(), 1_000);
        assert_eq!(
            full_source.identity_check_count() - checks_before_publish,
            1_000,
            "final publication validates the fixed composition once"
        );
        let identity_checks = full_source.identity_check_count();
        let query_source = reader.query_source().expect("isolated query source");
        let connection = Connection::open_in_memory().expect("query connection");
        query_source.install(&connection).expect("query install");
        query_source.require_active().expect("active query source");
        assert_eq!(
            full_source.identity_check_count(),
            identity_checks,
            "query setup and final publication do not rescan the fixed composition"
        );
    }

    #[test]
    fn growing_preview_candidates_reuse_empty_footers_before_the_full_pass() {
        let directory = tempdir().expect("dataset directory");
        let empty = directory.path().join("part-00.parquet");
        let nonempty = directory.path().join("part-01.parquet");
        let later = directory.path().join("part-02.parquet");
        write_test_member_values(&empty, &[]);
        write_test_member_values(&nonempty, &[1]);
        write_test_member_values(&later, &[2]);
        let mut discovery = DatasetSource::begin_file_selection(
            directory.path(),
            [empty, nonempty, later].into_iter().map(Ok),
        )
        .expect("begin discovery");

        discovery.advance(1).expect("first discovery batch");
        let first_source = discovery
            .next_preview_candidate()
            .expect("first candidate")
            .expect("empty candidate source");
        let first_preview = first_source
            .inspector()
            .preview(1)
            .expect("empty candidate preview");
        assert_eq!(first_source.footer_read_count(), 1);
        assert!(
            !discovery
                .commit_preview_candidate(&first_preview)
                .expect("retain empty candidate")
        );

        discovery.advance(1).expect("second discovery batch");
        let second_source = discovery
            .next_preview_candidate()
            .expect("grown candidate")
            .expect("candidate with rows");
        let second_preview = second_source
            .inspector()
            .preview(1)
            .expect("grown candidate preview");
        assert_eq!(second_preview.progress.row_count, 1);
        assert_eq!(second_source.footer_read_count(), 2);
        assert!(
            discovery
                .commit_preview_candidate(&second_preview)
                .expect("commit candidate")
        );

        assert!(
            !discovery
                .advance(1)
                .expect("third discovery batch")
                .complete
        );
        assert!(discovery.advance(1).expect("discovery eof").complete);
        let full_source = discovery.into_source().expect("full source");
        let mut full_inspector = full_source.inspector();
        while full_inspector
            .advance(CATALOG_PAGE_MEMBERS)
            .expect("full footer pass")
            .summary
            .is_none()
        {}
        assert_eq!(full_source.footer_read_count(), 3);
        assert!(
            full_source
                .footer_cache
                .lock()
                .expect("footer cache")
                .is_empty()
        );
    }

    #[test]
    fn preview_stops_when_the_owning_open_request_is_cancelled() {
        let directory = tempdir().expect("dataset directory");
        write_test_member(&directory.path().join("a.parquet"), 1);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();

        assert_eq!(
            inspector.preview_while(1, || false),
            Err(DatasetError::Cancelled)
        );
        assert_eq!(inspector.next_member, 0);
        assert!(inspector.preview_reader.is_none());
    }

    #[test]
    fn query_schema_postflight_rejects_a_change_after_the_query_finishes() {
        let directory = tempdir().expect("dataset directory");
        let path = directory.path().join("part.parquet");
        write_test_member(&path, 1);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let candidates = reader
            .source
            .catalog
            .page(None, 1)
            .expect("member page")
            .members;
        reader
            .bind_candidate_paths(&candidates)
            .expect("candidate paths");

        let result = reader.query_schema_checked(&candidates, || {
            fs::remove_file(&path).expect("remove after query")
        });

        assert!(matches!(
            result,
            Err(DatasetError::SourceChanged { member }) if member == "part.parquet"
        ));
    }

    #[test]
    fn schema_seed_write_failures_are_resource_exhaustion() {
        let directory = tempdir().expect("seed directory");
        let path = directory.path().join("read-only-seed.parquet");
        fs::write(&path, b"").expect("seed placeholder");
        let file = fs::OpenOptions::new()
            .read(true)
            .open(path)
            .expect("read-only seed handle");
        let schema = Arc::new(Schema::new(vec![Field::new(
            "value",
            arrow_schema::DataType::Int64,
            true,
        )]));

        assert_eq!(
            write_schema_seed_to(file, &schema),
            Err(DatasetError::Window {
                error: DataWindowError::ResourceExhausted,
            })
        );
    }

    #[test]
    fn lazy_member_probe_panics_are_classified_conservatively() {
        assert_eq!(
            classify_member_read_message(
                "Failed to fetch Arrow record batch: Invalid Error: \
                 TProtocolException: Invalid data",
            ),
            Some(DataWindowError::CorruptSource)
        );
        assert_eq!(
            classify_member_read_message(
                "Failed to fetch Arrow record batch: Out of Memory Error: allocation failed",
            ),
            Some(DataWindowError::ResourceExhausted)
        );
        assert_eq!(
            classify_member_read_message(
                "Failed to fetch Arrow record batch: Internal Error: vector invariant",
            ),
            None
        );
        assert_eq!(
            classify_member_read_message(
                "Could not import DuckDB Arrow array: Invalid data type: Extension",
            ),
            None
        );
    }

    #[test]
    fn member_read_errors_keep_their_first_response_and_latch_the_source() {
        let cases = [
            (
                SourceError::NotFound,
                DatasetError::SourceChanged {
                    member: "part.parquet".to_owned(),
                },
            ),
            (
                SourceError::PermissionDenied,
                DatasetError::MemberPermissionDenied {
                    member: "part.parquet".to_owned(),
                },
            ),
            (
                SourceError::CorruptFooter,
                DatasetError::InvalidMember {
                    member: "part.parquet".to_owned(),
                },
            ),
        ];
        for (source_error, expected) in cases {
            let member = member("part.parquet", "2026");
            let source = test_source(vec![member.clone()], &[0]);

            assert_eq!(source.latch_member_error(source_error, &member), expected);
            assert_eq!(source.latch_source_changed("later.parquet"), expected);
            assert_eq!(source.require_active(), Err(expected));
        }
    }

    #[test]
    fn partition_pruning_changes_the_exact_member_slice_passed_to_the_query() {
        let members = vec![
            member("year=2025/a.parquet", "2025"),
            member("year=2026/b.parquet", "2026"),
        ];
        let summary = DatasetSummary {
            display_name: "dataset/".to_owned(),
            member_count: 2,
            ignored_file_count: 0,
            size_bytes: 0,
            row_count: 0,
            row_group_count: 0,
            schema: vec![text_field("year"), text_field("file")],
            schema_drift_member_count: 0,
            partition_column_indices: vec![0],
            provenance_column_index: 1,
        };
        let filters = [DataFilter {
            field_path: FieldPath::from("year"),
            json_target: None,
            operator: DataFilterOperator::Equals,
            values: vec!["2026".to_owned()],
            match_case: false,
        }];

        let partition_columns = vec![PartitionColumn {
            name: "year".to_owned(),
            kind: PartitionColumnKind::Text,
        }];
        let candidates = candidate_members(&members, &summary, &partition_columns, &filters);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].relative_path, "year=2026/b.parquet");
        assert_eq!(candidates[0].path, PathBuf::from("year=2026/b.parquet"));
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        let interrupt = connection.interrupt_handle();
        initialize_member_tables(&connection, &summary, &partition_columns)
            .expect("member metadata");
        let source = test_source(members.clone(), &[0, 0]);
        let reader = DatasetWindowReader {
            source,
            summary,
            partition_columns,
            connection,
            member_limit: None,
            arrow_schema: Arc::new(Schema::empty()),
            filename_column: "__viewda_filename".to_owned(),
            physical_column_count: 0,
            schema_seed: None,
            _temporary_directory: None,
            interrupt,
            interrupted: Arc::new(AtomicBool::new(false)),
        };
        let candidates = candidates.into_iter().cloned().collect::<Vec<_>>();
        reader
            .bind_candidate_paths(&candidates)
            .expect("candidate boundary");

        let scan_path = reader
            .connection
            .query_row("SELECT unnest(getvariable('__viewda_paths'))", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("query boundary path");
        assert_eq!(scan_path, "year=2026/b.parquet");
    }

    #[test]
    fn canonical_partition_integer_grammar_is_conservative() {
        for (value, expected) in [
            ("0", Some(0)),
            ("1", Some(1)),
            ("-1", Some(-1)),
            ("9223372036854775807", Some(i64::MAX)),
            ("-9223372036854775808", Some(i64::MIN)),
            ("", None),
            ("01", None),
            ("+1", None),
            ("-0", None),
            ("9223372036854775808", None),
            ("__HIVE_DEFAULT_PARTITION__", None),
        ] {
            assert_eq!(canonical_partition_i64(value), expected, "{value}");
        }
    }

    #[test]
    fn query_shape_does_not_grow_with_member_count() {
        let members = (0..1_000)
            .map(|ordinal| {
                let mut member = member(&format!("part-{ordinal:04}.parquet"), "2026");
                member.ordinal = ordinal;
                member
            })
            .collect::<Vec<_>>();
        let summary = DatasetSummary {
            display_name: "dataset/".to_owned(),
            member_count: members.len() as u64,
            ignored_file_count: 0,
            size_bytes: 0,
            row_count: 0,
            row_group_count: 0,
            schema: vec![text_field("value"), text_field("year"), text_field("file")],
            schema_drift_member_count: 0,
            partition_column_indices: vec![1],
            provenance_column_index: 2,
        };
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        let interrupt = connection.interrupt_handle();
        let row_counts = vec![0; members.len()];
        let partition_columns = vec![PartitionColumn {
            name: "year".to_owned(),
            kind: PartitionColumnKind::Text,
        }];
        initialize_member_tables(&connection, &summary, &partition_columns)
            .expect("static metadata");
        let source = test_source(members.clone(), &row_counts);
        let reader = DatasetWindowReader {
            source,
            summary,
            partition_columns,
            connection,
            member_limit: None,
            arrow_schema: Arc::new(Schema::empty()),
            filename_column: "__viewda_filename".to_owned(),
            physical_column_count: 1,
            schema_seed: None,
            _temporary_directory: None,
            interrupt,
            interrupted: Arc::new(AtomicBool::new(false)),
        };

        let query = reader
            .query_sql(DatasetWindowProjection::All)
            .expect("dataset query");

        assert!(query.len() < 1_500);
        assert!(!query.contains("part-0000.parquet"));
        assert!(!query.contains("part-0999.parquet"));
        reader
            .bind_candidate_paths(&[
                members[0].clone(),
                members[500].clone(),
                members[999].clone(),
            ])
            .expect("bounded candidate bind");
        let (bound_paths, bound_candidates, static_members) = reader
            .connection
            .query_row(
                "SELECT len(getvariable('__viewda_paths')), \
                 (SELECT count(*) FROM __viewda_candidates), \
                 (SELECT count(*) FROM __viewda_members)",
                [],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, u64>(2)?,
                    ))
                },
            )
            .expect("bounded per-fetch metadata");
        assert_eq!((bound_paths, bound_candidates, static_members), (3, 3, 3));
    }

    #[test]
    fn window_ordinals_use_bounded_catalog_batches() {
        let members = (0..=MAX_WINDOW_ROWS as u64)
            .map(|ordinal| {
                let mut member = member(&format!("part-{ordinal:03}.parquet"), "2026");
                member.ordinal = ordinal;
                member
            })
            .collect::<Vec<_>>();
        let source = test_source(members, &vec![0; MAX_WINDOW_ROWS as usize + 1]);
        let catalog = Arc::clone(&source.catalog);
        let query_source = DatasetQuerySource {
            source,
            summary: DatasetSummary {
                display_name: "dataset/".to_owned(),
                member_count: MAX_WINDOW_ROWS as u64 + 1,
                ignored_file_count: 0,
                size_bytes: 0,
                row_count: 0,
                row_group_count: 0,
                schema: vec![text_field("year"), text_field("file")],
                schema_drift_member_count: 0,
                partition_column_indices: vec![0],
                provenance_column_index: 1,
            },
            partition_columns: vec![PartitionColumn {
                name: "year".to_owned(),
                kind: PartitionColumnKind::Text,
            }],
            filename_column: "filename".to_owned(),
            row_column: "row".to_owned(),
            ordinal_column: "ordinal".to_owned(),
            physical_column_count: 0,
            arrow_schema: Arc::new(Schema::empty()),
            member_limit: MAX_WINDOW_ROWS as u64 + 1,
            schema_seed: write_schema_seed(&Arc::new(Schema::empty())).expect("schema seed"),
            bound_members: Mutex::new(Vec::new()),
        };

        let selected = query_source
            .members_for_ordinals_while(&[299, 0, 128, 128], || true)
            .expect("batched members");

        assert_eq!(
            selected
                .iter()
                .map(|member| member.ordinal)
                .collect::<Vec<_>>(),
            [0, 128, 299]
        );
        assert_eq!(catalog.member_batch_query_count(), 1);
        assert!(matches!(
            query_source.members_for_ordinals_while(
                &(0..=MAX_WINDOW_ROWS as u64).collect::<Vec<_>>(),
                || true,
            ),
            Err(DatasetError::PageTooLarge)
        ));
        assert_eq!(catalog.member_batch_query_count(), 1);
    }

    #[test]
    fn escapes_only_duckdb_glob_metacharacters_in_platform_paths() {
        assert_eq!(
            escape_glob_path(r#"C:\data\a[1]*?'"данные.parquet"#),
            r#"C:\data\a[[]1[]][*][?]'"данные.parquet"#
        );
    }

    #[test]
    fn removes_windows_verbatim_prefixes_before_query_binding() {
        assert_eq!(
            windows_path_without_verbatim_prefix(r"\\?\C:\data\part.parquet"),
            Some(r"C:\data\part.parquet".to_owned())
        );
        assert_eq!(
            windows_path_without_verbatim_prefix(r"\\?\UNC\server\share\part.parquet"),
            Some(r"\\server\share\part.parquet".to_owned())
        );
        assert_eq!(
            windows_path_without_verbatim_prefix(r"C:\data\part.parquet"),
            None
        );
        assert_eq!(
            windows_path_without_verbatim_prefix(r"\\?\Volume{01234567}\part.parquet"),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_verbatim_paths_that_win32_would_normalize_to_another_target() {
        let directory = tempdir().expect("dataset directory");
        let canonical_directory = fs::canonicalize(directory.path()).expect("canonical directory");
        let lossy_directory = canonical_directory.join("folder.");
        fs::create_dir(&lossy_directory).expect("verbatim trailing-dot directory");
        let member = lossy_directory.join("part.parquet");
        fs::write(&member, b"member").expect("verbatim member");
        let canonical_member = fs::canonicalize(member).expect("canonical member");

        assert_eq!(
            query_compatible_canonical_path(canonical_member),
            Err(DatasetError::Unsupported)
        );
    }

    #[test]
    fn target_membership_uses_one_catalog_lookup_for_paths_and_file_identity() {
        let directory = tempdir().expect("dataset directory");
        let member = directory.path().join("part.parquet");
        write_test_member(&member, 1);
        fs::create_dir(directory.path().join("empty")).expect("alternate path component");
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let catalog = Arc::clone(&source.catalog);

        assert_eq!(
            source.target_matches_member(&directory.path().join("empty/../part.parquet")),
            Ok(true)
        );

        #[cfg(any(unix, windows))]
        {
            let outside = tempdir().expect("hardlink directory");
            let alias = outside.path().join("alias.parquet");
            fs::hard_link(&member, &alias).expect("member hardlink");
            assert_eq!(source.target_matches_member(&alias), Ok(true));
        }

        let other = directory.path().join("other.parquet");
        write_test_member(&other, 2);
        assert_eq!(source.target_matches_member(&other), Ok(false));
        assert_eq!(
            source.target_matches_member(&directory.path().join("future.parquet")),
            Ok(false)
        );
        assert_eq!(
            catalog.target_lookup_query_count(),
            if cfg!(any(unix, windows)) { 4 } else { 3 }
        );
    }

    #[test]
    fn internal_filename_avoids_all_visible_names_case_insensitively() {
        assert_eq!(
            unique_column_name(
                ["__VIEWDA_FILENAME", "__viewda_filename_1"],
                "__viewda_filename",
            ),
            "__viewda_filename_2"
        );
    }

    #[test]
    fn list_and_map_wrapper_names_do_not_create_visible_children() {
        fn group(
            name: &str,
            logical_type: Option<&str>,
            children: Vec<SchemaField>,
        ) -> SchemaField {
            SchemaField {
                name: name.to_owned(),
                physical_type: "GROUP".to_owned(),
                logical_type: logical_type.map(str::to_owned),
                children,
            }
        }
        fn int(name: &str, physical_type: &str) -> SchemaField {
            SchemaField {
                name: name.to_owned(),
                physical_type: physical_type.to_owned(),
                logical_type: None,
                children: vec![],
            }
        }

        let mut schema = vec![group(
            "items",
            Some("List"),
            vec![group(
                "list",
                None,
                vec![group("element", None, vec![int("a", "INT32")])],
            )],
        )];
        merge_schema(
            &mut schema,
            vec![group(
                "items",
                Some("List"),
                vec![group(
                    "array",
                    Some("List"),
                    vec![group("item", None, vec![int("b", "INT64")])],
                )],
            )],
            "spark.parquet",
        )
        .expect("semantic list merge");
        assert_eq!(schema[0].children.len(), 1);
        assert_eq!(schema[0].children[0].children.len(), 1);
        assert_eq!(
            schema[0].children[0].children[0]
                .children
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );

        let mut map_schema = vec![group(
            "attributes",
            Some("Map"),
            vec![group(
                "key_value",
                Some("Map key-value"),
                vec![
                    text_field("key"),
                    group("value", None, vec![int("a", "INT32")]),
                ],
            )],
        )];
        merge_schema(
            &mut map_schema,
            vec![group(
                "attributes",
                Some("Map"),
                vec![group(
                    "entries",
                    None,
                    vec![
                        text_field("k"),
                        group("item", None, vec![int("b", "INT64")]),
                    ],
                )],
            )],
            "arrow.parquet",
        )
        .expect("semantic map merge");
        assert_eq!(map_schema[0].children.len(), 1);
        assert_eq!(
            map_schema[0].children[0].children[1]
                .children
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );

        let incompatible = merge_schema(
            &mut schema,
            vec![group(
                "items",
                Some("List"),
                vec![group("list", None, vec![int("item", "INT64")])],
            )],
            "bad.parquet",
        );
        assert_eq!(
            incompatible,
            Err(DatasetError::SchemaConflict {
                column: "items.element".to_owned(),
                member: "bad.parquet".to_owned(),
            })
        );
    }

    #[test]
    fn arrow_map_merge_treats_entry_children_as_semantic_positions() {
        let map = |entry: &str, key: &str, value: &str| {
            Arc::new(Field::new(
                "attributes",
                DataType::Map(
                    Arc::new(Field::new(
                        entry,
                        DataType::Struct(
                            vec![
                                Arc::new(Field::new(key, DataType::Utf8, false)),
                                Arc::new(Field::new(value, DataType::Int64, true)),
                            ]
                            .into(),
                        ),
                        false,
                    )),
                    false,
                ),
                true,
            ))
        };

        let merged = merge_arrow_fields(
            &map("key_value", "key", "value"),
            &map("entries", "k", "item"),
        )
        .expect("semantic Arrow map merge");
        let DataType::Map(entries, _) = merged.data_type() else {
            panic!("merged map type");
        };
        let DataType::Struct(fields) = entries.data_type() else {
            panic!("merged map entries");
        };
        assert_eq!(entries.name(), "key_value");
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].name(), "key");
        assert_eq!(fields[1].name(), "value");
    }

    #[test]
    fn arrow_merge_accepts_storage_equivalent_writer_representations() {
        let field = |data_type| Arc::new(Field::new("value", data_type, true));

        assert_eq!(
            merge_arrow_fields(&field(DataType::Utf8), &field(DataType::LargeUtf8))
                .expect("string representation merge")
                .data_type(),
            &DataType::LargeUtf8
        );
        assert_eq!(
            merge_arrow_fields(
                &field(DataType::FixedSizeBinary(8)),
                &field(DataType::FixedSizeBinary(16)),
            )
            .expect("binary representation merge")
            .data_type(),
            &DataType::LargeBinary
        );
        assert_eq!(
            merge_arrow_fields(
                &field(DataType::Dictionary(
                    Box::new(DataType::Int32),
                    Box::new(DataType::Utf8),
                )),
                &field(DataType::Utf8),
            )
            .expect("dictionary representation merge")
            .data_type(),
            &DataType::Utf8
        );
    }

    #[test]
    fn produced_schema_check_rejects_a_different_column_contract() {
        let expected = Schema::new(vec![Field::new("value", DataType::Int64, true)]);
        let wrong_type = Schema::new(vec![Field::new("value", DataType::Utf8, true)]);
        let wrong_name = Schema::new(vec![Field::new("other", DataType::Int64, true)]);

        assert_eq!(
            validate_produced_arrow_schema(&expected, &wrong_type),
            Err(DataWindowError::EncodingFailed)
        );
        assert_eq!(
            validate_produced_arrow_schema(&expected, &wrong_name),
            Err(DataWindowError::EncodingFailed)
        );
    }

    #[test]
    fn logical_dataset_schema_has_a_fixed_metadata_boundary() {
        let fields = (0..MAX_DATASET_SCHEMA_NODES - 1)
            .map(|index| text_field(&format!("column_{index}")))
            .collect::<Vec<_>>();
        assert_eq!(validate_dataset_schema_bounds(&fields, &[]), Ok(()));
        let mut over_limit = fields;
        over_limit.push(text_field("one_too_many"));
        assert_eq!(
            validate_dataset_schema_bounds(&over_limit, &[]),
            Err(DatasetError::Unsupported)
        );
    }

    fn member(relative_path: &str, year: &str) -> DatasetMember {
        DatasetMember {
            ordinal: u64::from(year == "2026"),
            path: PathBuf::from(relative_path),
            relative_path: relative_path.to_owned(),
            partitions: vec![PartitionValue {
                key: "year".to_owned(),
                value: year.to_owned(),
            }],
            identity: MemberIdentity {
                size_bytes: 0,
                modified: None,
                platform: test_platform_identity(),
            },
            row_count: None,
        }
    }

    fn test_source(members: Vec<DatasetMember>, row_counts: &[u64]) -> DatasetSource {
        let mut builder = MemberCatalogBuilder::new().expect("member catalog");
        for member in members {
            builder.push(member).expect("catalog member");
        }
        let catalog = builder
            .finish_while(|| true)
            .expect("completed member catalog");
        let facts = row_counts
            .iter()
            .enumerate()
            .map(|(ordinal, row_count)| (ordinal as u64, *row_count, None))
            .collect::<Vec<_>>();
        for facts in facts.chunks(CATALOG_PAGE_MEMBERS as usize) {
            catalog
                .record_inspection_batch(facts)
                .expect("inspection facts");
        }
        DatasetSource {
            display_name: "dataset/".to_owned(),
            ignored_file_count: 0,
            logical_root: PathBuf::new(),
            root: PathBuf::new(),
            catalog: Arc::new(catalog),
            latched_error: Arc::new(Mutex::new(None)),
            footer_cache: Arc::new(Mutex::new(Vec::new())),
            cache_footer_results: false,
            footer_reads: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            identity_checks: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    fn write_test_member(path: &Path, value: i64) {
        write_test_member_values(path, &[value]);
    }

    fn write_test_member_values(path: &Path, values: &[i64]) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "value",
            arrow_schema::DataType::Int64,
            true,
        )]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![Arc::new(Int64Array::from(values.to_vec()))],
        )
        .expect("record batch");
        let file = fs::File::create(path).expect("member file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("member rows");
        writer.close().expect("member footer");
    }

    fn write_test_member_groups(path: &Path, groups: usize, rows_per_group: usize) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "value",
            arrow_schema::DataType::Int64,
            true,
        )]));
        let file = fs::File::create(path).expect("member file");
        let mut writer =
            ArrowWriter::try_new(file, Arc::clone(&schema), None).expect("Parquet writer");
        for group in 0..groups {
            let start = i64::try_from(group * rows_per_group).expect("row group start");
            let end = start + i64::try_from(rows_per_group).expect("row group rows");
            let batch = RecordBatch::try_new(
                Arc::clone(&schema),
                vec![Arc::new(Int64Array::from_iter_values(start..end))],
            )
            .expect("record batch");
            writer.write(&batch).expect("member rows");
            writer.flush().expect("row group");
        }
        writer.close().expect("member footer");
    }

    fn corrupt_test_member_data(path: &Path) {
        let metadata = fs::metadata(path).expect("member metadata");
        let modified = metadata.modified().expect("member modification time");
        let reader = SerializedFileReader::new(fs::File::open(path).expect("member file"))
            .expect("Parquet metadata");
        let column = reader.metadata().row_group(0).column(0);
        let start = column
            .dictionary_page_offset()
            .unwrap_or_else(|| column.data_page_offset());
        let length = usize::try_from(column.compressed_size()).expect("column chunk size");
        drop(reader);

        let mut file = OpenOptions::new()
            .write(true)
            .open(path)
            .expect("writable member");
        file.seek(SeekFrom::Start(
            u64::try_from(start).expect("column chunk offset"),
        ))
        .expect("column chunk seek");
        file.write_all(&vec![0; length])
            .expect("overwrite column chunk");
        file.flush().expect("flush damaged data");
        file.set_times(FileTimes::new().set_modified(modified))
            .expect("restore member identity timestamp");
    }

    #[cfg(unix)]
    fn test_platform_identity() -> PlatformFileIdentity {
        PlatformFileIdentity::Unix {
            device: 0,
            inode: 0,
        }
    }

    #[cfg(windows)]
    fn test_platform_identity() -> PlatformFileIdentity {
        PlatformFileIdentity::Windows {
            volume_serial_number: 0,
            file_id: [0; 16],
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn test_platform_identity() -> PlatformFileIdentity {
        PlatformFileIdentity::Unavailable
    }
}
