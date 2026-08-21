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

use arrow_array::RecordBatch;
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use duckdb::{
    Config, Connection, Error as DuckDbError, InterruptHandle, appender_params_from_iter,
    params_from_iter, types::Value,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as _;
use tempfile::NamedTempFile;
use tempfile::TempDir;
use thiserror::Error;

use parquet::arrow::ArrowWriter;

#[cfg(windows)]
use crate::source::windows_file_identity;

use crate::{
    DataFilter, DataFilterOperator, SchemaField,
    filter::{build_filter_predicate, quote_identifier},
    source::{
        SourceError, SourceSnapshot, SourceSummary, inspect_local_source,
        inspect_local_source_for_query,
    },
    window::{
        DataWindowError, MAX_WINDOW_ROWS, classify_query_error, set_utc_session_timezone,
        validate_projection,
    },
};
use member_catalog::{CATALOG_PAGE_MEMBERS, MemberCatalog, MemberCatalogBuilder};

const MAX_MEMBER_PAGE_SIZE: u32 = 256;
const MAX_PREVIEW_COLUMNS: usize = 256;
const MAX_PARTITION_DEPTH: usize = 256;
const MAX_DATASET_SCHEMA_NODES: usize = 4_096;
const MAX_DATASET_SCHEMA_BYTES: usize = 4 * 1024 * 1024;
const DATASET_QUERY_MEMORY_LIMIT: &str = "384MB";
const PROVENANCE_COLUMN: &str = "file";

/// A Hive partition key and its text value for one member.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionValue {
    /// Column name derived from a `key=value` directory component.
    pub key: String,
    /// Text after the first equals sign in that component.
    pub value: String,
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
    Windows { volume: u32, file_index: u64 },
    #[cfg(not(any(unix, windows)))]
    Unavailable,
}

/// One bounded member-list item suitable for Structure or source details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMemberSummary {
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
    /// Returns the member's stable zero-based ordinal in the fixed composition.
    pub fn ordinal(&self) -> u64 {
        self.member.ordinal
    }

    /// Returns the slash-separated logical path without exposing its absolute path.
    pub fn relative_path(&self) -> &str {
        &self.member.relative_path
    }

    /// Returns the retained footer snapshot used by Structure.
    pub fn snapshot(&self) -> &SourceSnapshot {
        &self.snapshot
    }

    /// Rechecks every fixed member and the retained selected snapshot.
    /// A changed member latches its relative path even when it is not selected.
    pub fn validate(&self) -> Result<(), DatasetError> {
        self.validate_while(|| true)
    }

    /// Rechecks the fixed composition while the caller still wants the work.
    pub fn validate_while(&self, keep_going: impl FnMut() -> bool) -> Result<(), DatasetError> {
        self.source.ensure_all_members_unchanged_while(keep_going)?;
        self.snapshot
            .validate_for_install(&self.member.path)
            .map_err(|error| self.source.latch_member_error(error, &self.member))
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
    /// Union schema followed by Hive columns and the virtual `file` column.
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

/// One fixed dataset snapshot. Membership changes only when the caller opens it again.
#[derive(Debug, Clone)]
pub struct DatasetSource {
    display_name: String,
    ignored_file_count: u64,
    root: PathBuf,
    catalog: Arc<MemberCatalog>,
    changed_member: Arc<Mutex<Option<String>>>,
}

impl DatasetSource {
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
        let root = std::path::absolute(root).map_err(map_discovery_error)?;
        root.to_str().ok_or(DatasetError::Unsupported)?;
        let metadata = fs::metadata(&root).map_err(map_discovery_error)?;
        if !metadata.is_dir() {
            return Err(DatasetError::Unsupported);
        }
        let folder_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .ok_or(DatasetError::Unsupported)?;
        let mut catalog = MemberCatalogBuilder::new()?;
        let mut ignored_file_count = 0_u64;
        discover_members(
            &root,
            &root,
            &mut catalog,
            &mut ignored_file_count,
            &mut keep_going,
        )?;
        let catalog = catalog.finish_while(&mut keep_going)?;
        if catalog.member_count() == 0 {
            return Err(DatasetError::NoParquetFiles);
        }

        Ok(Self {
            display_name: format!("{folder_name}/"),
            ignored_file_count,
            root,
            catalog: Arc::new(catalog),
            changed_member: Arc::new(Mutex::new(None)),
        })
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
    pub fn open_file_selection_cancellable(
        root: &Path,
        paths: impl IntoIterator<Item = Result<PathBuf, DatasetError>>,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DatasetError> {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
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
        let mut catalog = MemberCatalogBuilder::new()?;
        for requested in paths {
            if !keep_going() {
                return Err(DatasetError::Cancelled);
            }
            let requested = requested?;
            if !has_parquet_extension(&requested) {
                return Err(DatasetError::Unsupported);
            }
            let logical = std::path::absolute(requested).map_err(map_discovery_error)?;
            logical.to_str().ok_or(DatasetError::Unsupported)?;
            let path = query_compatible_canonical_path(
                fs::canonicalize(&logical).map_err(map_discovery_error)?,
            )?;
            path.to_str().ok_or(DatasetError::Unsupported)?;
            let metadata = fs::metadata(&path).map_err(map_discovery_error)?;
            if !metadata.is_file() {
                return Err(DatasetError::Unsupported);
            }
            let relative = logical
                .strip_prefix(&root)
                .map_err(|_| DatasetError::Unsupported)?;
            let relative_path = slash_path(relative)?;
            let partitions = parse_partitions(relative)?;
            let identity = member_identity(&path, &metadata).map_err(map_discovery_error)?;
            catalog.push(DatasetMember {
                ordinal: 0,
                path,
                relative_path,
                partitions,
                identity,
                row_count: None,
            })?;
        }
        let catalog = catalog.finish_while(&mut keep_going)?;
        if catalog.member_count() == 0 {
            return Err(DatasetError::NoParquetFiles);
        }
        let display_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .map_or_else(
                || format!("{} files/", catalog.member_count()),
                |name| format!("{name}/"),
            );

        Ok(Self {
            display_name,
            ignored_file_count: 0,
            root,
            catalog: Arc::new(catalog),
            changed_member: Arc::new(Mutex::new(None)),
        })
    }

    /// Dataset label with a trailing slash.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Number of members captured at open time.
    pub fn member_count(&self) -> u64 {
        self.catalog.member_count()
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
        let metadata = fs::metadata(&member.path)
            .map_err(|_| self.latch_source_changed(&member.relative_path))?;
        let identity = member_identity(&member.path, &metadata)
            .map_err(|_| self.latch_source_changed(&member.relative_path))?;
        if !metadata.is_file() || identity != member.identity {
            return Err(self.latch_source_changed(&member.relative_path));
        }
        Ok(())
    }

    fn ensure_all_members_unchanged(&self) -> Result<(), DatasetError> {
        self.ensure_all_members_unchanged_while(|| true)
    }

    fn ensure_all_members_unchanged_while(
        &self,
        keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        self.ensure_member_prefix_unchanged_while(self.member_count(), keep_going)
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

    fn target_matches_member(&self, target: &Path) -> bool {
        let canonical_target = fs::canonicalize(target).ok();
        let target_platform = fs::metadata(target)
            .ok()
            .and_then(|metadata| platform_file_identity(target, &metadata).ok());
        let mut after = None;
        loop {
            let Ok(page) = self.catalog.page(after, CATALOG_PAGE_MEMBERS) else {
                return false;
            };
            if page.members.iter().any(|member| {
                member.path == target
                    || target_platform
                        .as_ref()
                        .is_some_and(|target| same_file_identity(target, &member.identity.platform))
                    || canonical_target.as_ref().is_some_and(|target| {
                        &member.path == target
                            || fs::canonicalize(&member.path)
                                .ok()
                                .is_some_and(|member| member == *target)
                    })
            }) {
                return true;
            }
            let Some(next) = page.next_ordinal else {
                return false;
            };
            after = Some(next);
        }
    }

    fn require_active(&self) -> Result<(), DatasetError> {
        let changed = self
            .changed_member
            .lock()
            .map_err(|_| DatasetError::Unsupported)?;
        match changed.as_ref() {
            Some(member) => Err(DatasetError::SourceChanged {
                member: member.clone(),
            }),
            None => Ok(()),
        }
    }

    fn latch_source_changed(&self, member: &str) -> DatasetError {
        if let Ok(mut changed) = self.changed_member.lock()
            && changed.is_none()
        {
            *changed = Some(member.to_owned());
        }
        DatasetError::SourceChanged {
            member: member.to_owned(),
        }
    }

    fn latch_member_error(&self, error: SourceError, member: &DatasetMember) -> DatasetError {
        if let Ok(mut changed) = self.changed_member.lock()
            && changed.is_none()
        {
            *changed = Some(member.relative_path.clone());
        }
        map_member_error(error, member)
    }

    fn latch_invalid_member(&self, member: &DatasetMember) -> DatasetError {
        if let Ok(mut changed) = self.changed_member.lock()
            && changed.is_none()
        {
            *changed = Some(member.relative_path.clone());
        }
        DatasetError::InvalidMember {
            member: member.relative_path.clone(),
        }
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

    /// Reports whether cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Incrementally merges member footers while retaining only aggregate schema and counts.
pub struct DatasetInspector {
    source: DatasetSource,
    next_member: u64,
    union_schema: Vec<SchemaField>,
    first_schema: Option<Vec<SchemaField>>,
    first_column_members: HashMap<String, String>,
    partition_names: Vec<String>,
    partition_names_loaded: bool,
    size_bytes: u64,
    row_count: u64,
    row_group_count: u64,
    drift_count: u64,
    initial_schema_reported: bool,
    preview_reader: Option<DatasetWindowReader>,
    cancelled: Arc<AtomicBool>,
    footer_cache: Option<(MemberIdentity, SourceSummary)>,
}

impl DatasetInspector {
    fn new(source: DatasetSource) -> Self {
        Self {
            source,
            next_member: 0,
            union_schema: Vec::new(),
            first_schema: None,
            first_column_members: HashMap::new(),
            partition_names: Vec::new(),
            partition_names_loaded: false,
            size_bytes: 0,
            row_count: 0,
            row_group_count: 0,
            drift_count: 0,
            initial_schema_reported: false,
            preview_reader: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            footer_cache: None,
        }
    }

    /// Returns a handle that can cancel the next or active inspection step.
    pub fn interrupt_handle(&self) -> DatasetInspectionInterruptHandle {
        DatasetInspectionInterruptHandle {
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Reads the first member's bounded rows and keeps its query session for completion.
    pub fn preview(&mut self, row_count: u32) -> Result<DatasetPreview, DatasetError> {
        self.preview_while(row_count, || true)
    }

    /// Reads the first member's bounded rows while the owning open request remains current.
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
        let progress = self.advance_while(1, &mut keep_going)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let summary = self.current_summary()?;
        let mut reader =
            DatasetWindowReader::from_parts(self.source.clone(), summary, Some(1), None)?;
        let projection = (0..reader.summary.schema.len().min(MAX_PREVIEW_COLUMNS))
            .map(|index| u32::try_from(index).map_err(|_| DatasetError::Unsupported))
            .collect::<Result<Vec<_>, _>>()?;
        let arrow_ipc =
            reader.fetch_columns_while(0, row_count, &[], &projection, &mut keep_going)?;
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        self.preview_reader = Some(reader);
        Ok(DatasetPreview {
            progress,
            arrow_ipc,
        })
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
        if !self.partition_names_loaded {
            self.partition_names = self.source.catalog.partition_names()?;
            self.partition_names_loaded = true;
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
            for partition in &member.partitions {
                if !self
                    .partition_names
                    .iter()
                    .any(|name| name.eq_ignore_ascii_case(&partition.key))
                {
                    if self
                        .union_schema
                        .iter()
                        .any(|field| field.name.eq_ignore_ascii_case(&partition.key))
                    {
                        return Err(DatasetError::SchemaConflict {
                            column: partition.key.clone(),
                            member: member.relative_path.clone(),
                        });
                    }
                    self.partition_names.push(partition.key.clone());
                }
            }
            let member_summary = if let Some((_, summary)) = self
                .footer_cache
                .as_ref()
                .filter(|(identity, _)| *identity == member.identity)
            {
                summary.clone()
            } else {
                let summary = inspect_local_source_for_query(&member.path)
                    .map_err(|error| self.source.latch_member_error(error, &member))?;
                if !keep_going() {
                    return Err(DatasetError::Cancelled);
                }
                self.footer_cache = Some((member.identity, summary.clone()));
                summary
            };
            validate_member_schema(&member_summary.schema, &member.relative_path, "")?;
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
            for field in &member_summary.schema {
                if field.name.eq_ignore_ascii_case(PROVENANCE_COLUMN)
                    || self
                        .partition_names
                        .iter()
                        .any(|name| name.eq_ignore_ascii_case(&field.name))
                {
                    return Err(DatasetError::SchemaConflict {
                        column: field.name.clone(),
                        member: member.relative_path.clone(),
                    });
                }
                self.first_column_members
                    .entry(field.name.clone())
                    .or_insert_with(|| member.relative_path.clone());
            }
            merge_schema(
                &mut self.union_schema,
                member_summary.schema,
                &member.relative_path,
            )?;
            validate_dataset_schema_bounds(
                &self.union_schema,
                &self.partition_names,
                &self.first_column_members,
            )?;
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
        if let Some(name) = self
            .partition_names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(PROVENANCE_COLUMN))
        {
            return Err(DatasetError::SchemaConflict {
                column: PROVENANCE_COLUMN.to_owned(),
                member: self.source.catalog.first_member_with_partition(name)?,
            });
        }
        let (schema, partition_column_indices, provenance_column_index) = visible_schema(
            &self.union_schema,
            &self.partition_names,
            &self.first_column_members,
        )?;
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

    /// Consumes completed footer facts and binds the final Arrow schema once for future windows.
    pub fn into_window_reader(mut self) -> Result<DatasetWindowReader, DatasetError> {
        if self.next_member != self.source.member_count() {
            return Err(DatasetError::Unsupported);
        }
        self.source
            .ensure_all_members_unchanged_while(|| !self.cancelled.load(Ordering::Acquire))?;
        let summary = self.current_summary()?;
        match self.preview_reader.take() {
            Some(reader) => reader.upgrade(summary, &self.cancelled),
            None => {
                DatasetWindowReader::from_parts(self.source, summary, None, Some(&self.cancelled))
            }
        }
    }
}

/// First schema and rows produced after inspecting only the first member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetPreview {
    /// Inspection facts after the first footer; complete for a one-member dataset.
    pub progress: DatasetInspectionProgress,
    /// First member's bounded native-order rows.
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
    member_limit: Option<usize>,
    arrow_schema: SchemaRef,
    filename_column: String,
    physical_column_count: usize,
    schema_seed: Option<NamedTempFile>,
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
    filename_column: String,
    row_column: String,
    ordinal_column: String,
    physical_column_count: usize,
    schema_seed: NamedTempFile,
    bound_members: Mutex<Vec<DatasetMember>>,
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
            cursor.finished = page.next_ordinal.is_none();
            let candidates = page
                .members
                .into_iter()
                .filter(|member| {
                    member_matches_prunable_filters(member, &self.summary, &cursor.filters)
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
            .execute(
                &format!(
                    "CREATE TEMP TABLE {table} AS SELECT {projection} FROM {} LIMIT 0",
                    self.relation_sql(),
                ),
                params_from_iter(parameters.iter()),
            )
            .map_err(DatasetSetupError::Query)?;
        let mut cursor = self.candidate_batches(filters);
        while self.bind_next_candidate_batch(connection, &mut cursor, &mut keep_going)? {
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
                DatasetSetupError::Dataset(self.classify_query_failure(
                    error,
                    filters,
                    !where_clause.is_empty(),
                ))
            })?;
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

    pub(crate) fn target_matches_member(&self, target: &Path) -> bool {
        self.source.target_matches_member(target)
    }
    pub(crate) fn schema(&self) -> &[SchemaField] {
        &self.summary.schema
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

    pub(crate) fn temporary_directory_hint(&self) -> Option<&Path> {
        self.source.root.parent()
    }

    pub(crate) fn redact_paths(&self, message: &str) -> String {
        if self.source.root.parent().is_none() {
            return "dataset query resource exhausted".to_owned();
        }
        let mut message = message.to_owned();
        if let Ok(members) = self.bound_members.lock() {
            for member in members.iter() {
                let path = member.path.to_string_lossy();
                message = message
                    .replace(&escape_glob_path(&path), "<source member>")
                    .replace(path.as_ref(), "<source member>");
            }
        }
        let root = self.source.root.to_string_lossy();
        if self.source.root.parent().is_some() {
            let prefix = format!(
                "{}{separator}",
                root.trim_end_matches(std::path::MAIN_SEPARATOR),
                separator = std::path::MAIN_SEPARATOR
            );
            message = message
                .replace(&escape_glob_path(&prefix), "<source>/")
                .replace(&prefix, "<source>/");
        }
        let seed = self.schema_seed.path().to_string_lossy();
        message
            .replace(&escape_glob_path(&seed), "<temporary file>")
            .replace(seed.as_ref(), "<temporary file>")
    }

    #[cfg(test)]
    pub(crate) fn install(&self, connection: &Connection) -> Result<(), DatasetSetupError> {
        self.install_while(connection, || true)
    }

    pub(crate) fn install_while(
        &self,
        connection: &Connection,
        keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetSetupError> {
        self.source.require_active()?;
        self.source.ensure_all_members_unchanged_while(keep_going)?;
        initialize_member_tables(connection, &self.summary)?;
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
        Ok(())
    }

    pub(crate) fn bind_window_members(
        &self,
        connection: &Connection,
        ordinals: &[u64],
    ) -> Result<usize, DatasetSetupError> {
        self.bind_window_members_while(connection, ordinals, || true)
    }

    pub(crate) fn bind_window_members_while(
        &self,
        connection: &Connection,
        ordinals: &[u64],
        keep_going: impl FnMut() -> bool,
    ) -> Result<usize, DatasetSetupError> {
        self.source.require_active()?;
        self.source.ensure_all_members_unchanged_while(keep_going)?;
        let members = self.members_for_ordinals(ordinals)?;
        let count = members.len();
        self.bind_members(connection, &members)?;
        Ok(count)
    }

    /// Binds exact ordinals between the export-wide preflight and final validation.
    pub(crate) fn bind_export_members_while(
        &self,
        connection: &Connection,
        ordinals: &[u64],
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<usize, DatasetSetupError> {
        self.source.require_active()?;
        let mut ordinals = ordinals.to_vec();
        ordinals.sort_unstable();
        ordinals.dedup();
        let mut members = Vec::with_capacity(ordinals.len());
        for ordinal in ordinals {
            if !keep_going() {
                return Err(DatasetError::Cancelled.into());
            }
            members.push(self.source.member(ordinal)?);
        }
        if !keep_going() {
            return Err(DatasetError::Cancelled.into());
        }
        let count = members.len();
        self.bind_members(connection, &members)?;
        Ok(count)
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

    pub(crate) fn validate(&self) -> Result<(), DatasetError> {
        self.source.require_active()?;
        self.source.ensure_all_members_unchanged()
    }

    pub(crate) fn validate_while(
        &self,
        keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        self.source.require_active()?;
        self.source.ensure_all_members_unchanged_while(keep_going)
    }

    pub(crate) fn classify_query_failure(
        &self,
        error: DuckDbError,
        filters: &[DataFilter],
        filters_applied: bool,
    ) -> DatasetError {
        let _ = filters;
        if let Err(changed) = self.source.ensure_all_members_unchanged() {
            return changed;
        }
        match self.bound_members.lock() {
            Ok(candidates) => {
                diagnose_query_failure(&self.source, &candidates, error, filters_applied)
            }
            Err(_) => DatasetError::Unsupported,
        }
    }

    pub(crate) fn classify_window_query_failure(
        &self,
        error: DuckDbError,
        ordinals: &[u64],
    ) -> DatasetError {
        match self.members_for_ordinals(ordinals) {
            Ok(members) => diagnose_query_failure(&self.source, &members, error, false),
            Err(error) => error,
        }
    }

    pub(crate) fn classify_window_lazy_query_failure(
        &self,
        panic: &(dyn Any + Send),
        ordinals: &[u64],
    ) -> DatasetError {
        match self.members_for_ordinals(ordinals) {
            Ok(members) => diagnose_lazy_query_failure(&self.source, &members, panic, false),
            Err(error) => error,
        }
    }

    pub(crate) fn classify_lazy_query_failure(&self, panic: &(dyn Any + Send)) -> DatasetError {
        if let Err(changed) = self.source.ensure_all_members_unchanged() {
            return changed;
        }
        match self.bound_members.lock() {
            Ok(candidates) => diagnose_lazy_query_failure(&self.source, &candidates, panic, false),
            Err(_) => DatasetError::Unsupported,
        }
    }

    fn members_for_ordinals(&self, ordinals: &[u64]) -> Result<Vec<DatasetMember>, DatasetError> {
        let mut ordinals = ordinals.to_vec();
        ordinals.sort_unstable();
        ordinals.dedup();
        ordinals
            .iter()
            .map(|ordinal| self.source.member(*ordinal))
            .collect()
    }
}

impl DatasetWindowReader {
    fn ensure_query_members_unchanged_while(
        &self,
        keep_going: impl FnMut() -> bool,
    ) -> Result<(), DatasetError> {
        match self.member_limit {
            Some(limit) => self
                .source
                .ensure_member_prefix_unchanged_while(limit as u64, keep_going),
            None => self.source.ensure_all_members_unchanged_while(keep_going),
        }
    }

    /// Returns a handle that stops an active direct query without locking the reader.
    pub fn interrupt_handle(&self) -> DatasetWindowInterruptHandle {
        DatasetWindowInterruptHandle {
            interrupt: Arc::clone(&self.interrupt),
            interrupted: Arc::clone(&self.interrupted),
        }
    }

    /// Returns the selected member's first row in frozen dataset order.
    ///
    /// The whole fixed composition is revalidated before and after calculating
    /// the checked prefix so callers cannot navigate through stale member data.
    pub fn member_row_offset(&self, ordinal: u64) -> Result<u64, DatasetError> {
        self.member_row_offset_while(ordinal, || true)
    }

    /// Returns a member offset while the caller still wants the work.
    pub fn member_row_offset_while(
        &self,
        ordinal: u64,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<u64, DatasetError> {
        self.source.member(ordinal)?;
        self.source
            .ensure_all_members_unchanged_while(&mut keep_going)?;
        let offset = self.source.catalog.row_offset(ordinal)?;
        self.source
            .ensure_all_members_unchanged_while(&mut keep_going)?;
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
        let member = self.source.member(ordinal)?;
        self.source
            .ensure_all_members_unchanged_while(&mut keep_going)?;
        let snapshot = SourceSnapshot::open(&member.path)
            .map_err(|error| self.source.latch_member_error(error, &member))?;
        after_open();
        self.source
            .ensure_all_members_unchanged_while(&mut keep_going)?;
        snapshot
            .validate_for_install(&member.path)
            .map_err(|error| self.source.latch_member_error(error, &member))?;
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
        keep_going: impl FnMut() -> bool,
    ) -> Result<DatasetQuerySource, DatasetError> {
        if self.member_limit.is_some() {
            return Err(DatasetError::Unsupported);
        }
        self.source.require_active()?;
        self.source.ensure_all_members_unchanged_while(keep_going)?;
        let filename_column = unique_internal_column(&self.summary.schema, "__viewda_filename");
        let row_column = unique_internal_column(&self.summary.schema, "__viewda_native_row");
        let ordinal_column =
            unique_internal_column(&self.summary.schema, "__viewda_member_ordinal");
        Ok(DatasetQuerySource {
            source: self.source.clone(),
            summary: self.summary.clone(),
            filename_column,
            row_column,
            ordinal_column,
            physical_column_count: self.physical_column_count,
            schema_seed: write_schema_seed(&self.arrow_schema)?,
            bound_members: Mutex::new(Vec::new()),
        })
    }
    fn from_parts(
        source: DatasetSource,
        summary: DatasetSummary,
        member_limit: Option<usize>,
        cancelled: Option<&AtomicBool>,
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
        let filename_column = unique_internal_column(&summary.schema, "__viewda_filename");
        initialize_member_tables(&connection, &summary).map_err(DatasetSetupError::into_dataset)?;
        let mut reader = Self {
            interrupt,
            interrupted,
            source,
            summary,
            connection,
            member_limit,
            arrow_schema: Arc::new(Schema::empty()),
            filename_column,
            physical_column_count,
            schema_seed: None,
            _temporary_directory: Some(temporary_directory),
        };
        reader.refresh_arrow_schema(cancelled)?;
        if reader.member_limit.is_none() {
            reader.source.ensure_all_members_unchanged_while(|| {
                !cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
            })?;
        }
        reader.install_schema_seed()?;
        Ok(reader)
    }

    fn upgrade(
        mut self,
        summary: DatasetSummary,
        cancelled: &AtomicBool,
    ) -> Result<Self, DatasetError> {
        self.summary = summary;
        self.member_limit = None;
        self.physical_column_count =
            self.summary
                .partition_column_indices
                .first()
                .copied()
                .unwrap_or(self.summary.provenance_column_index) as usize;
        self.filename_column = unique_internal_column(&self.summary.schema, "__viewda_filename");
        self.schema_seed = None;
        self.refresh_arrow_schema(Some(cancelled))?;
        self.source
            .ensure_all_members_unchanged_while(|| !cancelled.load(Ordering::Acquire))?;
        self.install_schema_seed()?;
        Ok(self)
    }

    fn refresh_arrow_schema(&mut self, cancelled: Option<&AtomicBool>) -> Result<(), DatasetError> {
        let limit = self
            .member_limit
            .map_or(self.source.member_count(), |limit| limit as u64)
            .min(self.source.member_count());
        let mut after = None;
        let mut previous_identity = None;
        let mut merged_schema: Option<Schema> = None;
        loop {
            if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Acquire)) {
                return Err(DatasetError::Cancelled);
            }
            let mut page = self.source.catalog.page(after, CATALOG_PAGE_MEMBERS)?;
            let next = page.next_ordinal.filter(|next| *next < limit);
            page.members.retain(|member| member.ordinal < limit);
            page.members.retain(|member| {
                let duplicate = previous_identity.as_ref() == Some(&member.identity);
                previous_identity = Some(member.identity);
                !duplicate
            });
            if !page.members.is_empty() {
                bind_paths_variable(&self.connection, &page.members, None)
                    .map_err(DatasetSetupError::into_dataset)?;
                let batch_schema = self.query_physical_schema(&page.members)?;
                merged_schema = Some(match merged_schema {
                    Some(schema) => merge_arrow_schemas(schema, batch_schema)?,
                    None => batch_schema,
                });
            }
            let Some(next) = next else {
                break;
            };
            after = Some(next);
        }
        let schema = merged_schema.ok_or(DatasetError::Unsupported)?;
        let mut fields = schema.fields.iter().cloned().collect::<Vec<_>>();
        for index in &self.summary.partition_column_indices {
            fields.push(Arc::new(Field::new(
                &self.summary.schema[*index as usize].name,
                DataType::Utf8,
                true,
            )));
        }
        fields.push(Arc::new(Field::new(
            &self.summary.schema[self.summary.provenance_column_index as usize].name,
            DataType::Utf8,
            false,
        )));
        self.arrow_schema = Arc::new(Schema::new_with_metadata(fields, schema.metadata));
        Ok(())
    }

    fn query_physical_schema(&self, candidates: &[DatasetMember]) -> Result<Schema, DatasetError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT * FROM read_parquet(getvariable('__viewda_paths'), \
                 union_by_name = true, hive_partitioning = false) LIMIT 0",
            )
            .map_err(|error| diagnose_query_failure(&self.source, candidates, error, false))?;
        let batches = statement
            .stream_arrow([])
            .map_err(|error| diagnose_query_failure(&self.source, candidates, error, false))?;
        Ok(batches.get_schema().as_ref().clone())
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
                    relative_path: member.relative_path,
                    partitions: member.partitions,
                })
                .collect(),
        })
    }

    /// Reads a stable global window and applies typed filters over all members.
    pub fn fetch(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
    ) -> Result<Vec<u8>, DatasetError> {
        self.fetch_while(row_offset, row_count, filters, || true)
    }

    /// Reads a stable window while the caller still wants the work.
    pub fn fetch_while(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
        keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        self.fetch_projection(row_offset, row_count, filters, None, keep_going)
    }

    /// Reads selected union-schema columns in the requested order.
    pub fn fetch_columns(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
        source_indices: &[u32],
    ) -> Result<Vec<u8>, DatasetError> {
        self.fetch_columns_while(row_offset, row_count, filters, source_indices, || true)
    }

    /// Reads projected columns while the caller still wants the work.
    pub fn fetch_columns_while(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
        source_indices: &[u32],
        keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        let projection = validate_projection(&self.summary.schema, source_indices)?;
        self.fetch_projection(
            row_offset,
            row_count,
            filters,
            Some(&projection),
            keep_going,
        )
    }

    fn fetch_projection(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
        source_indices: Option<&[usize]>,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Vec<u8>, DatasetError> {
        let interrupted = Arc::clone(&self.interrupted);
        let mut wants_work = || !interrupted.load(Ordering::Acquire) && keep_going();
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        self.source.require_active()?;
        let predicate = build_filter_predicate(&self.summary.schema, filters)
            .map_err(|_| DataWindowError::InvalidFilter)?;
        self.ensure_query_members_unchanged_while(&mut wants_work)?;
        let projected_schema = source_indices
            .map(|indices| self.arrow_schema.project(indices).map(Arc::new))
            .transpose()
            .map_err(|_| DataWindowError::Unsupported)?;
        let where_clause = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", predicate.sql)
        };
        let mut writer = StreamWriter::try_new(
            Vec::new(),
            projected_schema
                .as_ref()
                .unwrap_or(&self.arrow_schema)
                .as_ref(),
        )
        .map_err(|_| DataWindowError::EncodingFailed)?;
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
            if filters.is_empty() {
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
            }
            let page = self.source.catalog.page(after, CATALOG_PAGE_MEMBERS)?;
            let candidates = page
                .members
                .into_iter()
                .filter(|member| member.ordinal < active_limit)
                .filter(|member| member_matches_prunable_filters(member, &self.summary, filters))
                .collect::<Vec<_>>();
            if !candidates.is_empty() {
                self.bind_candidate_paths(&candidates)?;
                let batch_rows = if filters.is_empty() {
                    Some(candidates.iter().try_fold(0_u64, |total, member| {
                        total
                            .checked_add(member.row_count.ok_or(DatasetError::Unsupported)?)
                            .ok_or(DatasetError::Unsupported)
                    })?)
                } else if remaining_offset > 0 {
                    Some(self.count_candidate_rows(
                        &candidates,
                        &where_clause,
                        &predicate.parameters,
                    )?)
                } else {
                    None
                };
                if batch_rows.is_some_and(|batch_rows| remaining_offset >= batch_rows) {
                    let batch_rows = batch_rows.expect("checked above");
                    remaining_offset -= batch_rows;
                } else {
                    if !wants_work() {
                        return Err(DatasetError::Cancelled);
                    }
                    let batches = self.query_candidate_rows(
                        &candidates,
                        &where_clause,
                        &predicate.parameters,
                        remaining_offset,
                        remaining_count,
                        source_indices,
                    )?;
                    remaining_offset = 0;
                    for batch in batches {
                        remaining_count = remaining_count.saturating_sub(batch.num_rows() as u64);
                        writer
                            .write(&batch)
                            .map_err(|_| DataWindowError::EncodingFailed)?;
                    }
                }
            }
            let Some(next) = page.next_ordinal.filter(|next| *next < active_limit) else {
                break;
            };
            after = Some(next);
        }
        writer
            .finish()
            .map_err(|_| DataWindowError::EncodingFailed)?;
        let encoded = writer
            .into_inner()
            .map_err(|_| DataWindowError::EncodingFailed)?;
        self.ensure_query_members_unchanged_while(&mut wants_work)?;
        Ok(encoded)
    }

    fn count_candidate_rows(
        &self,
        candidates: &[DatasetMember],
        where_clause: &str,
        parameters: &[Value],
    ) -> Result<u64, DatasetError> {
        let relation = dataset_relation_sql(
            &self.summary,
            self.physical_column_count,
            &self.filename_column,
            None,
            self.schema_seed.is_some(),
        );
        let query = format!("SELECT count(*)::UBIGINT FROM {relation}{where_clause}");
        self.connection
            .query_row(&query, params_from_iter(parameters.iter()), |row| {
                row.get(0)
            })
            .map_err(|error| {
                if self.interrupted.load(Ordering::Acquire) {
                    DatasetError::Cancelled
                } else {
                    diagnose_query_failure(&self.source, candidates, error, !parameters.is_empty())
                }
            })
    }

    fn query_candidate_rows(
        &self,
        candidates: &[DatasetMember],
        where_clause: &str,
        predicate_parameters: &[Value],
        row_offset: u64,
        row_count: u64,
        source_indices: Option<&[usize]>,
    ) -> Result<Vec<RecordBatch>, DatasetError> {
        let query = self.query_sql(where_clause, source_indices);
        let mut parameters = predicate_parameters.to_vec();
        parameters.push(Value::BigInt(
            i64::try_from(row_count).map_err(|_| DataWindowError::Unsupported)?,
        ));
        parameters.push(Value::BigInt(
            i64::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?,
        ));
        let mut statement = self.connection.prepare(&query).map_err(|error| {
            if self.interrupted.load(Ordering::Acquire) {
                DatasetError::Cancelled
            } else {
                diagnose_query_failure(
                    &self.source,
                    candidates,
                    error,
                    !predicate_parameters.is_empty(),
                )
            }
        })?;
        let batches = statement
            .stream_arrow(params_from_iter(parameters.iter()))
            .map_err(|error| {
                if self.interrupted.load(Ordering::Acquire) {
                    DatasetError::Cancelled
                } else {
                    diagnose_query_failure(
                        &self.source,
                        candidates,
                        error,
                        !predicate_parameters.is_empty(),
                    )
                }
            })?;
        match catch_unwind(AssertUnwindSafe(|| batches.collect::<Vec<_>>())) {
            Ok(batches) => Ok(batches),
            Err(_) if self.interrupted.load(Ordering::Acquire) => Err(DatasetError::Cancelled),
            Err(panic) => Err(diagnose_lazy_query_failure(
                &self.source,
                candidates,
                panic.as_ref(),
                !predicate_parameters.is_empty(),
            )),
        }
    }

    fn bind_candidate_paths(&self, candidates: &[DatasetMember]) -> Result<(), DatasetError> {
        bind_candidate_members(
            &self.connection,
            &self.source,
            &self.summary,
            candidates,
            self.schema_seed.as_ref().map(NamedTempFile::path),
        )
        .map_err(DatasetSetupError::into_dataset)
    }

    #[cfg(test)]
    fn query_schema(&self, candidates: &[DatasetMember]) -> Result<SchemaRef, DatasetError> {
        let query = self.query_sql("", None);
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
        self.source.ensure_all_members_unchanged()?;
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

    fn query_sql(&self, where_clause: &str, source_indices: Option<&[usize]>) -> String {
        let relation = dataset_relation_sql(
            &self.summary,
            self.physical_column_count,
            &self.filename_column,
            None,
            self.schema_seed.is_some(),
        );
        let projection = source_indices
            .map_or_else(
                || (0..self.summary.schema.len()).collect::<Vec<_>>(),
                <[usize]>::to_vec,
            )
            .into_iter()
            .map(|index| &self.summary.schema[index])
            .map(|field| quote_identifier(&field.name))
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT {projection} FROM {relation}{where_clause} LIMIT ? OFFSET ?",)
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
        quote_identifier(PROVENANCE_COLUMN),
        filename = quote_identifier(filename_column),
    );
    let global_row_column = unique_internal_column(&summary.schema, "__viewda_global_row");
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
) -> Result<(), DatasetSetupError> {
    let partition_columns = summary
        .partition_column_indices
        .iter()
        .enumerate()
        .map(|(index, _)| format!(", \"__partition_{index}\" VARCHAR"))
        .collect::<String>();
    connection
        .execute_batch(&format!(
            "CREATE TEMP TABLE __viewda_members (\
             __ordinal UBIGINT PRIMARY KEY, __path VARCHAR NOT NULL UNIQUE, \
             __relative VARCHAR NOT NULL, __row_count UBIGINT NOT NULL{partition_columns}); \
             CREATE TEMP TABLE __viewda_candidates (__ordinal UBIGINT PRIMARY KEY)"
        ))
        .map_err(DatasetSetupError::Query)?;
    Ok(())
}

fn append_member_metadata(
    connection: &Connection,
    members: &[DatasetMember],
    summary: &DatasetSummary,
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
        for schema_index in &summary.partition_column_indices {
            let name = &summary.schema[*schema_index as usize].name;
            values.push(
                member
                    .partitions
                    .iter()
                    .find(|partition| partition.key.eq_ignore_ascii_case(name))
                    .map_or(Value::Null, |partition| {
                        Value::Text(partition.value.clone())
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
    append_member_metadata(connection, candidates, summary, &row_counts)?;
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

fn discover_members(
    root: &Path,
    directory: &Path,
    catalog: &mut MemberCatalogBuilder,
    ignored_file_count: &mut u64,
    keep_going: &mut dyn FnMut() -> bool,
) -> Result<(), DatasetError> {
    if !keep_going() {
        return Err(DatasetError::Cancelled);
    }
    let entries = fs::read_dir(directory).map_err(map_discovery_error)?;
    for entry in entries {
        if !keep_going() {
            return Err(DatasetError::Cancelled);
        }
        let entry = entry.map_err(map_discovery_error)?;
        let file_type = entry.file_type().map_err(map_discovery_error)?;
        let path = entry.path();
        if file_type.is_dir() {
            discover_members(root, &path, catalog, ignored_file_count, keep_going)?;
        } else if file_type.is_file() && is_visible_parquet_path(root, &path) {
            let metadata = entry.metadata().map_err(map_discovery_error)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| DatasetError::Unsupported)?;
            let relative_path = slash_path(relative)?;
            let partitions = parse_partitions(relative)?;
            let identity = member_identity(&path, &metadata).map_err(map_discovery_error)?;
            catalog.push(DatasetMember {
                ordinal: 0,
                path,
                relative_path,
                partitions,
                identity,
                row_count: None,
            })?;
        } else if file_type.is_file() {
            *ignored_file_count = ignored_file_count
                .checked_add(1)
                .ok_or(DatasetError::Unsupported)?;
        }
    }
    Ok(())
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

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn unique_internal_column(schema: &[SchemaField], base: &str) -> String {
    let mut candidate = base.to_owned();
    let mut suffix = 1_u32;
    while schema
        .iter()
        .any(|field| field.name.eq_ignore_ascii_case(&candidate))
    {
        candidate = format!("{base}_{suffix}");
        suffix += 1;
    }
    candidate
}

fn parse_partitions(relative_path: &Path) -> Result<Vec<PartitionValue>, DatasetError> {
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
        if key.is_empty()
            || partitions
                .iter()
                .any(|item: &PartitionValue| item.key.eq_ignore_ascii_case(key))
        {
            return Err(DatasetError::Unsupported);
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
    partition_names: &[String],
    first_column_members: &HashMap<String, String>,
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
    let nodes = nodes.saturating_add(partition_names.len());
    let bytes = schema_bytes
        .saturating_add(partition_names.iter().map(String::len).sum::<usize>())
        .saturating_add(
            first_column_members
                .iter()
                .map(|(column, member)| column.len().saturating_add(member.len()))
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
            DataType::Map(merge_arrow_fields(left_field, right_field)?, *left_sorted)
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
    partition_names: &[String],
    first_column_members: &HashMap<String, String>,
) -> Result<(Vec<SchemaField>, Vec<u32>, u32), DatasetError> {
    let mut schema = union_schema.to_vec();
    let mut partition_column_indices = Vec::with_capacity(partition_names.len());
    for name in partition_names {
        if schema
            .iter()
            .any(|field| field.name.eq_ignore_ascii_case(name))
        {
            return Err(DatasetError::SchemaConflict {
                column: name.clone(),
                member: String::new(),
            });
        }
        partition_column_indices
            .push(u32::try_from(schema.len()).map_err(|_| DatasetError::Unsupported)?);
        schema.push(text_field(name));
    }
    for reserved in [PROVENANCE_COLUMN] {
        if schema
            .iter()
            .any(|field| field.name.eq_ignore_ascii_case(reserved))
        {
            return Err(DatasetError::SchemaConflict {
                column: reserved.to_owned(),
                member: first_column_members
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(reserved))
                    .map(|(_, member)| member)
                    .cloned()
                    .unwrap_or_default(),
            });
        }
    }
    let provenance_column_index =
        u32::try_from(schema.len()).map_err(|_| DatasetError::Unsupported)?;
    schema.push(text_field(PROVENANCE_COLUMN));
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

#[cfg(test)]
fn drift_page(
    members: &[DatasetMember],
    deviating_members: &[usize],
    offset: u64,
    limit: u32,
) -> Result<DatasetMemberPage, DatasetError> {
    if limit > MAX_MEMBER_PAGE_SIZE {
        return Err(DatasetError::PageTooLarge);
    }
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(deviating_members.len());
    let end = start
        .saturating_add(limit as usize)
        .min(deviating_members.len());
    let members = deviating_members[start..end]
        .iter()
        .map(|index| &members[*index])
        .map(|member| DatasetMemberSummary {
            relative_path: member.relative_path.clone(),
            partitions: member.partitions.clone(),
        })
        .collect();
    Ok(DatasetMemberPage {
        offset,
        total: deviating_members.len() as u64,
        members,
    })
}

fn member_matches_prunable_filters(
    member: &DatasetMember,
    summary: &DatasetSummary,
    filters: &[DataFilter],
) -> bool {
    filters.iter().all(|filter| {
        let Some(column) = summary.schema.get(filter.column_index as usize) else {
            return true;
        };
        let is_partition = summary
            .partition_column_indices
            .contains(&filter.column_index);
        if filter.column_index != summary.provenance_column_index && !is_partition {
            return true;
        }
        let value = if column.name == PROVENANCE_COLUMN {
            Some(member.relative_path.as_str())
        } else {
            member
                .partitions
                .iter()
                .find(|partition| partition.key.eq_ignore_ascii_case(&column.name))
                .map(|partition| partition.value.as_str())
        };
        text_filter_matches(value, filter)
    })
}

#[cfg(test)]
fn candidate_members<'a>(
    members: &'a [DatasetMember],
    summary: &DatasetSummary,
    filters: &[DataFilter],
) -> Vec<&'a DatasetMember> {
    members
        .iter()
        .filter(|member| member_matches_prunable_filters(member, summary, filters))
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
fn same_file_identity(left: &PlatformFileIdentity, right: &PlatformFileIdentity) -> bool {
    let PlatformFileIdentity::Unix {
        device: left_device,
        inode: left_inode,
    } = left;
    let PlatformFileIdentity::Unix {
        device: right_device,
        inode: right_inode,
    } = right;
    left_device == right_device && left_inode == right_inode
}

#[cfg(windows)]
fn same_file_identity(left: &PlatformFileIdentity, right: &PlatformFileIdentity) -> bool {
    let PlatformFileIdentity::Windows {
        volume: left_volume,
        file_index: left_index,
    } = left;
    let PlatformFileIdentity::Windows {
        volume: right_volume,
        file_index: right_index,
    } = right;
    left_volume == right_volume && left_index == right_index
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(_left: &PlatformFileIdentity, _right: &PlatformFileIdentity) -> bool {
    false
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
    let (volume, file_index) = windows_file_identity(&file)?;
    Ok(PlatformFileIdentity::Windows { volume, file_index })
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
        SourceError::PermissionDenied => DatasetError::PermissionDenied,
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

    use arrow_array::Int64Array;
    use arrow_schema::Field;
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use tempfile::tempdir;

    use super::*;

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
        let seed_escaped =
            escape_glob_path(query_source.schema_seed.path().to_string_lossy().as_ref());
        let message = format!(
            "failed to read {}, {}, {}, {}, and {}",
            first.display(),
            first_escaped,
            second.display(),
            query_source.schema_seed.path().display(),
            seed_escaped,
        );

        let redacted = query_source.redact_paths(&message);

        assert_eq!(
            redacted,
            "failed to read <source member>, <source member>, <source member>, <temporary file>, and <temporary file>"
        );
    }

    #[test]
    fn root_dataset_resource_diagnostics_never_echo_member_paths() {
        let source = test_source(vec![member("a.parquet", "2025")], &[1]);
        let query_source = DatasetQuerySource {
            source: DatasetSource {
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
            filename_column: "file".to_owned(),
            row_column: "row".to_owned(),
            ordinal_column: "ordinal".to_owned(),
            physical_column_count: 1,
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
        let unrelated = directory.path().join("b.parquet");
        write_test_member(&selected, 1);
        write_test_member(&unrelated, 2);
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
                fs::rename(replacement, &unrelated).expect("replace unrelated member");
            },
        ) {
            Ok(_) => panic!("replacement during snapshot open must fail"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            DatasetError::SourceChanged {
                member: "b.parquet".to_owned(),
            }
        );
        assert_eq!(reader.member_snapshot(0).err(), Some(error));
    }

    #[test]
    fn window_query_diagnostics_probe_only_the_bound_page_members() {
        let directory = tempdir().expect("dataset directory");
        let first = directory.path().join("a.parquet");
        write_test_member(&first, 1);
        write_test_member(&directory.path().join("b.parquet"), 2);
        write_test_member(&directory.path().join("c.parquet"), 3);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(3).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let query_source = reader.query_source().expect("query source");
        corrupt_test_member_data(&first);

        let failure = DuckDbError::DuckDBFailure(
            duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
            Some("independent query failure".to_owned()),
        );
        assert_eq!(
            query_source.classify_window_query_failure(failure, &[2]),
            DatasetError::Window {
                error: DataWindowError::QueryFailed,
            }
        );
        assert_eq!(query_source.source.require_active(), Ok(()));

        let failure = DuckDbError::DuckDBFailure(
            duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
            Some("independent query failure".to_owned()),
        );
        assert_eq!(
            query_source.classify_window_query_failure(failure, &[0]),
            DatasetError::InvalidMember {
                member: "a.parquet".to_owned(),
            }
        );
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
                source_index: 0,
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
                DatasetError::PermissionDenied,
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
            assert_eq!(
                source.require_active(),
                Err(DatasetError::SourceChanged {
                    member: "part.parquet".to_owned(),
                })
            );
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
            column_index: 0,
            operator: DataFilterOperator::Equals,
            values: vec!["2026".to_owned()],
            match_case: false,
        }];

        let candidates = candidate_members(&members, &summary, &filters);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].relative_path, "year=2026/b.parquet");
        assert_eq!(candidates[0].path, PathBuf::from("year=2026/b.parquet"));
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        let interrupt = connection.interrupt_handle();
        initialize_member_tables(&connection, &summary).expect("member metadata");
        let source = test_source(members.clone(), &[0, 0]);
        let reader = DatasetWindowReader {
            source,
            summary,
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
        initialize_member_tables(&connection, &summary).expect("static metadata");
        let source = test_source(members.clone(), &row_counts);
        let reader = DatasetWindowReader {
            source,
            summary,
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

        let query = reader.query_sql("", None);

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
    fn validated_export_binding_polls_only_the_requested_member_batch() {
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
            schema: vec![text_field("year"), text_field("file")],
            schema_drift_member_count: 0,
            partition_column_indices: vec![0],
            provenance_column_index: 1,
        };
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        initialize_member_tables(&connection, &summary).expect("static metadata");
        let row_counts = vec![0; 1_000];
        let query_source = DatasetQuerySource {
            source: test_source(members, &row_counts),
            summary,
            filename_column: "file".to_owned(),
            row_column: "row".to_owned(),
            ordinal_column: "ordinal".to_owned(),
            physical_column_count: 0,
            schema_seed: write_schema_seed(&Arc::new(Schema::empty())).expect("schema seed"),
            bound_members: Mutex::new(Vec::new()),
        };
        let mut polls = 0;

        let count = query_source
            .bind_export_members_while(&connection, &[0, 999], || {
                polls += 1;
                true
            })
            .expect("bounded export member binding");

        assert_eq!(count, 2);
        assert_eq!(polls, 3);
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
    fn platform_file_identity_distinguishes_aliases_from_other_files() {
        #[cfg(unix)]
        let (identity, alias, other) = (
            PlatformFileIdentity::Unix {
                device: 7,
                inode: 11,
            },
            PlatformFileIdentity::Unix {
                device: 7,
                inode: 11,
            },
            PlatformFileIdentity::Unix {
                device: 7,
                inode: 12,
            },
        );
        #[cfg(windows)]
        let (identity, alias, other) = (
            PlatformFileIdentity::Windows {
                volume: 7,
                file_index: 11,
            },
            PlatformFileIdentity::Windows {
                volume: 7,
                file_index: 11,
            },
            PlatformFileIdentity::Windows {
                volume: 7,
                file_index: 12,
            },
        );
        #[cfg(not(any(unix, windows)))]
        let (identity, alias, other) = (
            PlatformFileIdentity::Unavailable,
            PlatformFileIdentity::Unavailable,
            PlatformFileIdentity::Unavailable,
        );

        assert_eq!(
            same_file_identity(&identity, &alias),
            cfg!(any(unix, windows))
        );
        assert!(!same_file_identity(&identity, &other));
    }

    #[test]
    fn internal_filename_avoids_all_visible_names_case_insensitively() {
        assert_eq!(
            unique_internal_column(
                &[
                    text_field("__VIEWDA_FILENAME"),
                    text_field("__viewda_filename_1"),
                ],
                "__viewda_filename",
            ),
            "__viewda_filename_2"
        );
    }

    #[test]
    fn logical_dataset_schema_has_a_fixed_metadata_boundary() {
        let fields = (0..MAX_DATASET_SCHEMA_NODES - 1)
            .map(|index| text_field(&format!("column_{index}")))
            .collect::<Vec<_>>();
        assert_eq!(
            validate_dataset_schema_bounds(&fields, &[], &HashMap::new()),
            Ok(())
        );
        let mut over_limit = fields;
        over_limit.push(text_field("one_too_many"));
        assert_eq!(
            validate_dataset_schema_bounds(&over_limit, &[], &HashMap::new()),
            Err(DatasetError::Unsupported)
        );
    }

    #[test]
    fn drift_pages_stay_bounded_past_the_protocol_boundary() {
        let members = (0..300)
            .map(|ordinal| {
                let mut member = member(&format!("part-{ordinal:03}.parquet"), "2026");
                member.ordinal = ordinal;
                member
            })
            .collect::<Vec<_>>();
        let deviations = (0..300).collect::<Vec<_>>();

        let page = drift_page(&members, &deviations, 255, 2).expect("bounded drift page");

        assert_eq!(page.total, 300);
        assert_eq!(page.members.len(), 2);
        assert_eq!(page.members[0].relative_path, "part-255.parquet");
        assert_eq!(
            drift_page(&members, &deviations, 0, 257),
            Err(DatasetError::PageTooLarge)
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
            root: PathBuf::new(),
            catalog: Arc::new(catalog),
            changed_member: Arc::new(Mutex::new(None)),
        }
    }

    fn write_test_member(path: &Path, value: i64) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "value",
            arrow_schema::DataType::Int64,
            true,
        )]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![Arc::new(Int64Array::from(vec![value]))],
        )
        .expect("record batch");
        let file = fs::File::create(path).expect("member file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("member rows");
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
            volume: 0,
            file_index: 0,
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn test_platform_identity() -> PlatformFileIdentity {
        PlatformFileIdentity::Unavailable
    }
}
