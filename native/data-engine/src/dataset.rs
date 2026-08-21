//! Parquet datasets with fixed membership and bounded windows.

use std::{
    any::Any,
    collections::{HashMap, HashSet},
    fs,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::SystemTime,
};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt as _;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle as _;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
};

use arrow_array::RecordBatch;
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{Schema, SchemaRef};
use duckdb::{
    Config, Connection, Error as DuckDbError, appender_params_from_iter, params_from_iter,
    types::Value,
};
use serde::Serialize;
use tempfile::NamedTempFile;
use thiserror::Error;

use parquet::arrow::ArrowWriter;

use crate::{
    DataFilter, DataFilterOperator, SchemaField,
    filter::{build_filter_predicate, quote_identifier},
    source::{SourceError, inspect_local_source},
    window::{DataWindowError, MAX_WINDOW_ROWS, classify_query_error, set_utc_session_timezone},
};

const MAX_MEMBER_PAGE_SIZE: u32 = 256;
const PROVENANCE_COLUMN: &str = "file";

/// A Hive partition key and its text value for one member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// A requested member page exceeds the bounded protocol limit.
    #[error("The requested dataset member page is too large.")]
    MemberPageTooLarge,
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
    members: Arc<[DatasetMember]>,
    changed_member: Arc<Mutex<Option<String>>>,
}

impl DatasetSource {
    /// Discovers supported members without reading any Parquet footer.
    pub fn open_folder(root: &Path) -> Result<Self, DatasetError> {
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
        let mut discovered = Vec::new();
        let mut ignored_file_count = 0_u64;
        discover_members(&root, &root, &mut discovered, &mut ignored_file_count)?;
        if discovered.is_empty() {
            return Err(DatasetError::NoParquetFiles);
        }
        discovered.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        for (ordinal, member) in discovered.iter_mut().enumerate() {
            member.ordinal = ordinal as u64;
        }

        Ok(Self {
            display_name: format!("{folder_name}/"),
            ignored_file_count,
            members: discovered.into(),
            changed_member: Arc::new(Mutex::new(None)),
        })
    }

    /// Opens an explicit fixed set after deriving one common logical root.
    ///
    /// Logical absolute paths determine provenance, Hive values, and lexicographic
    /// order. Canonical targets determine reads, identities, and duplicate rejection.
    pub fn open_files(paths: &[PathBuf]) -> Result<Self, DatasetError> {
        if paths.is_empty() {
            return Err(DatasetError::NoParquetFiles);
        }
        if paths.iter().any(|path| {
            path.extension()
                .is_none_or(|extension| extension != "parquet")
        }) {
            return Err(DatasetError::Unsupported);
        }

        let mut canonical_targets = HashSet::with_capacity(paths.len());
        let mut resolved_paths = Vec::with_capacity(paths.len());
        for path in paths {
            let logical = std::path::absolute(path).map_err(map_discovery_error)?;
            logical.to_str().ok_or(DatasetError::Unsupported)?;
            let path = query_compatible_canonical_path(
                fs::canonicalize(&logical).map_err(map_discovery_error)?,
            )?;
            path.to_str().ok_or(DatasetError::Unsupported)?;
            let metadata = fs::metadata(&path).map_err(map_discovery_error)?;
            if !metadata.is_file() || !canonical_targets.insert(path.clone()) {
                return Err(DatasetError::Unsupported);
            }
            resolved_paths.push((logical, path));
        }
        let logical_paths = resolved_paths
            .iter()
            .map(|(logical, _)| logical.clone())
            .collect::<Vec<_>>();
        let root = common_parent(&logical_paths).ok_or(DatasetError::Unsupported)?;
        let mut members = Vec::with_capacity(resolved_paths.len());
        for (logical, path) in resolved_paths {
            let metadata = fs::metadata(&path).map_err(map_discovery_error)?;
            let relative = logical
                .strip_prefix(&root)
                .map_err(|_| DatasetError::Unsupported)?;
            let relative_path = slash_path(relative)?;
            let partitions = parse_partitions(relative)?;
            let identity = member_identity(&path, &metadata).map_err(map_discovery_error)?;
            members.push(DatasetMember {
                ordinal: 0,
                path,
                relative_path,
                partitions,
                identity,
            });
        }
        members.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        for (ordinal, member) in members.iter_mut().enumerate() {
            member.ordinal = ordinal as u64;
        }
        let display_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .map_or_else(
                || format!("{} files/", members.len()),
                |name| format!("{name}/"),
            );

        Ok(Self {
            display_name,
            ignored_file_count: 0,
            members: members.into(),
            changed_member: Arc::new(Mutex::new(None)),
        })
    }

    /// Dataset label with a trailing slash.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Number of members captured at open time.
    pub fn member_count(&self) -> u64 {
        self.members.len() as u64
    }

    /// Number of files excluded from membership at open time.
    pub fn ignored_file_count(&self) -> u64 {
        self.ignored_file_count
    }

    /// Returns a bounded page without exposing absolute filesystem paths.
    pub fn member_page(&self, offset: u64, limit: u32) -> Result<DatasetMemberPage, DatasetError> {
        if limit > MAX_MEMBER_PAGE_SIZE {
            return Err(DatasetError::MemberPageTooLarge);
        }
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(self.members.len());
        let end = start.saturating_add(limit as usize).min(self.members.len());
        let members = self.members[start..end]
            .iter()
            .map(|member| DatasetMemberSummary {
                relative_path: member.relative_path.clone(),
                partitions: member.partitions.clone(),
            })
            .collect();
        Ok(DatasetMemberPage {
            offset,
            total: self.member_count(),
            members,
        })
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

    fn ensure_members_unchanged(&self, members: &[DatasetMember]) -> Result<(), DatasetError> {
        for member in members {
            self.ensure_member_unchanged(member)?;
        }
        Ok(())
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
    next_member: usize,
    union_schema: Vec<SchemaField>,
    first_schema: Option<Vec<SchemaField>>,
    first_column_members: HashMap<String, String>,
    partition_names: Vec<String>,
    size_bytes: u64,
    row_count: u64,
    row_group_count: u64,
    drift_count: u64,
    deviating_members: Vec<usize>,
    initial_schema_reported: bool,
    preview_reader: Option<DatasetWindowReader>,
    cancelled: Arc<AtomicBool>,
}

impl DatasetInspector {
    fn new(source: DatasetSource) -> Self {
        let mut partition_names = Vec::new();
        for member in source.members.iter() {
            for partition in &member.partitions {
                if !partition_names
                    .iter()
                    .any(|name: &String| name.eq_ignore_ascii_case(&partition.key))
                {
                    partition_names.push(partition.key.clone());
                }
            }
        }
        Self {
            source,
            next_member: 0,
            union_schema: Vec::new(),
            first_schema: None,
            first_column_members: HashMap::new(),
            partition_names,
            size_bytes: 0,
            row_count: 0,
            row_group_count: 0,
            drift_count: 0,
            deviating_members: Vec::new(),
            initial_schema_reported: false,
            preview_reader: None,
            cancelled: Arc::new(AtomicBool::new(false)),
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
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        if self.next_member != 0 || self.preview_reader.is_some() {
            return Err(DatasetError::Unsupported);
        }
        let progress = self.advance(1)?;
        let summary = self.current_summary()?;
        let mut reader = DatasetWindowReader::from_parts(
            self.source.clone(),
            summary,
            Some(1),
            self.deviating_members.clone(),
        )?;
        let arrow_ipc = reader.fetch(0, row_count, &[])?;
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
        if member_budget == 0 || member_budget > MAX_MEMBER_PAGE_SIZE {
            return Err(DatasetError::InspectionStepTooLarge);
        }
        self.source.require_active()?;
        let end = self
            .next_member
            .saturating_add(member_budget as usize)
            .min(self.source.members.len());
        while self.next_member < end {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(DatasetError::Cancelled);
            }
            let member = &self.source.members[self.next_member];
            self.source.ensure_member_unchanged(member)?;
            let member_summary = inspect_local_source(&member.path)
                .map_err(|error| self.source.latch_member_error(error, member))?;
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
            if self
                .first_schema
                .as_ref()
                .is_some_and(|first| first != &member_summary.schema)
            {
                self.drift_count += 1;
                self.deviating_members.push(self.next_member);
            } else if self.first_schema.is_none() {
                self.first_schema = Some(member_summary.schema.clone());
            }
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
            self.next_member += 1;
        }

        let schema_complete = self.next_member == self.source.members.len();
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
            completed_member_count: self.next_member as u64,
            total_member_count: self.source.member_count(),
            row_count: self.row_count,
            row_group_count: self.row_group_count,
            schema: progress_schema,
            schema_complete,
            summary,
        })
    }

    fn current_summary(&self) -> Result<DatasetSummary, DatasetError> {
        let (schema, partition_column_indices, provenance_column_index) = visible_schema(
            &self.union_schema,
            &self.partition_names,
            &self.first_column_members,
            &self.source.members,
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
        if self.next_member != self.source.members.len() {
            return Err(DatasetError::Unsupported);
        }
        self.source.ensure_members_unchanged(&self.source.members)?;
        let summary = self.current_summary()?;
        match self.preview_reader.take() {
            Some(reader) => reader.upgrade(summary, self.deviating_members),
            None => {
                DatasetWindowReader::from_parts(self.source, summary, None, self.deviating_members)
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
    source: DatasetSource,
    summary: DatasetSummary,
    connection: Connection,
    member_limit: Option<usize>,
    deviating_members: Vec<usize>,
    arrow_schema: SchemaRef,
    filename_column: String,
    physical_column_count: usize,
    initialized_member_count: usize,
    schema_seed: Option<NamedTempFile>,
}

impl DatasetWindowReader {
    fn from_parts(
        source: DatasetSource,
        summary: DatasetSummary,
        member_limit: Option<usize>,
        deviating_members: Vec<usize>,
    ) -> Result<Self, DatasetError> {
        let config = Config::default()
            .enable_object_cache(false)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
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
        let active_member_count = member_limit
            .unwrap_or(source.members.len())
            .min(source.members.len());
        initialize_member_tables(
            &connection,
            &source.members[..active_member_count],
            &summary,
        )?;
        install_member_maps(&connection, &summary)?;
        let mut reader = Self {
            source,
            summary,
            connection,
            member_limit,
            deviating_members,
            arrow_schema: Arc::new(Schema::empty()),
            filename_column,
            physical_column_count,
            initialized_member_count: active_member_count,
            schema_seed: None,
        };
        let members = reader.active_members();
        let candidates = members.iter().collect::<Vec<_>>();
        reader.bind_candidate_paths(&candidates)?;
        // The completed reader pays one schema-only DuckDB bind after the background footer pass.
        // Preview uses the same path with an active member table limited to its first member.
        reader.arrow_schema = reader.query_schema_checked(&candidates, || {})?;
        reader.install_schema_seed()?;
        Ok(reader)
    }

    fn upgrade(
        mut self,
        summary: DatasetSummary,
        deviating_members: Vec<usize>,
    ) -> Result<Self, DatasetError> {
        self.source.ensure_members_unchanged(&self.source.members)?;
        append_member_metadata(
            &self.connection,
            &self.source.members[self.initialized_member_count..],
            &summary,
        )?;
        install_member_maps(&self.connection, &summary)?;
        self.initialized_member_count = self.source.members.len();
        self.summary = summary;
        self.member_limit = None;
        self.deviating_members = deviating_members;
        self.physical_column_count =
            self.summary
                .partition_column_indices
                .first()
                .copied()
                .unwrap_or(self.summary.provenance_column_index) as usize;
        self.filename_column = unique_internal_column(&self.summary.schema, "__viewda_filename");
        self.schema_seed = None;
        let candidates = self.source.members.iter().collect::<Vec<_>>();
        self.bind_candidate_paths(&candidates)?;
        self.arrow_schema = self.query_schema_checked(&candidates, || {})?;
        self.install_schema_seed()?;
        Ok(self)
    }

    /// Returns the inspected union schema and aggregate footer facts.
    pub fn summary(&self) -> &DatasetSummary {
        &self.summary
    }

    /// Returns a bounded page of members whose schema differs from the first member.
    pub fn schema_drift_page(
        &self,
        offset: u64,
        limit: u32,
    ) -> Result<DatasetMemberPage, DatasetError> {
        drift_page(&self.source.members, &self.deviating_members, offset, limit)
    }

    /// Reads a stable global window and applies typed filters over all members.
    pub fn fetch(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
    ) -> Result<Vec<u8>, DatasetError> {
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        self.source.require_active()?;
        let predicate = build_filter_predicate(&self.summary.schema, filters)
            .map_err(|_| DataWindowError::InvalidFilter)?;
        let members = self.active_members();
        self.source.ensure_members_unchanged(members)?;
        let candidates = candidate_members(members, &self.summary, filters);
        if candidates.is_empty() {
            return encode_empty_ipc(&self.arrow_schema);
        }
        self.bind_candidate_paths(&candidates)?;
        let where_clause = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", predicate.sql)
        };
        let query = self.query_sql(&where_clause);
        let mut parameters = predicate.parameters;
        parameters.push(Value::BigInt(i64::from(row_count)));
        parameters.push(Value::BigInt(
            i64::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?,
        ));
        let mut statement = match self.connection.prepare(&query) {
            Ok(statement) => statement,
            Err(error) => {
                return Err(diagnose_query_failure(
                    &self.source,
                    &candidates,
                    error,
                    !filters.is_empty(),
                ));
            }
        };
        let batches = match statement.stream_arrow(params_from_iter(parameters.iter())) {
            Ok(batches) => batches,
            Err(error) => {
                return Err(diagnose_query_failure(
                    &self.source,
                    &candidates,
                    error,
                    !filters.is_empty(),
                ));
            }
        };
        let mut writer = StreamWriter::try_new(Vec::new(), self.arrow_schema.as_ref())
            .map_err(|_| DataWindowError::EncodingFailed)?;
        let encoded = match catch_unwind(AssertUnwindSafe(|| {
            for batch in batches {
                writer
                    .write(&batch)
                    .map_err(|_| DataWindowError::EncodingFailed)?;
            }
            writer
                .finish()
                .map_err(|_| DataWindowError::EncodingFailed)?;
            writer
                .into_inner()
                .map_err(|_| DataWindowError::EncodingFailed)
        })) {
            Ok(result) => result?,
            Err(panic) => {
                return Err(diagnose_lazy_query_failure(
                    &self.source,
                    &candidates,
                    panic.as_ref(),
                    !filters.is_empty(),
                ));
            }
        };
        for member in &candidates {
            self.source.ensure_member_unchanged(member)?;
        }
        Ok(encoded)
    }

    fn active_members(&self) -> &[DatasetMember] {
        self.member_limit.map_or_else(
            || self.source.members.as_ref(),
            |limit| &self.source.members[..limit.min(self.source.members.len())],
        )
    }

    fn bind_candidate_paths(&self, candidates: &[&DatasetMember]) -> Result<(), DatasetError> {
        let mut paths =
            Vec::with_capacity(candidates.len() + usize::from(self.schema_seed.is_some()));
        paths.extend(
            candidates
                .iter()
                .map(|member| member.path.to_str().ok_or(DatasetError::Unsupported))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(escape_glob_path),
        );
        if let Some(seed) = &self.schema_seed {
            let path = seed.path().to_str().ok_or(DatasetError::Unsupported)?;
            paths.push(escape_glob_path(path));
        }
        self.connection
            .execute(
                "SET VARIABLE __viewda_paths = string_split(?, chr(0))",
                [Value::Text(paths.join("\0"))],
            )
            .map_err(|error| classify_query_error(error, false))?;
        Ok(())
    }

    fn query_schema(&self, candidates: &[&DatasetMember]) -> Result<SchemaRef, DatasetError> {
        let query = self.query_sql("");
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

    fn query_schema_checked(
        &self,
        candidates: &[&DatasetMember],
        after_query: impl FnOnce(),
    ) -> Result<SchemaRef, DatasetError> {
        let schema = self.query_schema(candidates)?;
        after_query();
        self.source
            .ensure_members_unchanged(self.active_members())?;
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

    fn query_sql(&self, where_clause: &str) -> String {
        let projection = self
            .summary
            .schema
            .iter()
            .map(|field| quote_identifier(&field.name))
            .collect::<Vec<_>>()
            .join(", ");
        let physical_projection = self.summary.schema[..self.physical_column_count]
            .iter()
            .map(|field| {
                format!(
                    "s.{} AS {}",
                    quote_identifier(&field.name),
                    quote_identifier(&field.name)
                )
            })
            .collect::<Vec<_>>();
        let partition_projection = self
            .summary
            .partition_column_indices
            .iter()
            .enumerate()
            .map(|(partition_index, schema_index)| {
                format!(
                    "map_extract_value(getvariable('__viewda_partition_{partition_index}'), \
                     s.{filename}) AS {column}",
                    filename = quote_identifier(&self.filename_column),
                    column = quote_identifier(&self.summary.schema[*schema_index as usize].name),
                )
            });
        let visible_projection = physical_projection
            .into_iter()
            .chain(partition_projection)
            .chain([format!(
                "map_extract_value(getvariable('__viewda_relative_map'), s.{filename}) AS {}",
                quote_identifier(PROVENANCE_COLUMN),
                filename = quote_identifier(&self.filename_column),
            )])
            .collect::<Vec<_>>()
            .join(", ");
        let seed_filter = self.schema_seed.as_ref().map_or_else(String::new, |_| {
            format!(
                " WHERE s.{} <> getvariable('__viewda_seed_path')",
                quote_identifier(&self.filename_column)
            )
        });
        format!(
            "SELECT {projection} FROM (\
             SELECT {visible_projection} \
             FROM read_parquet(getvariable('__viewda_paths'), union_by_name = true, \
             hive_partitioning = false, filename = {filename_option}) s{seed_filter}\
             ){where_clause} LIMIT ? OFFSET ?",
            filename_option = quote_string_literal(&self.filename_column),
        )
    }
}

fn initialize_member_tables(
    connection: &Connection,
    members: &[DatasetMember],
    summary: &DatasetSummary,
) -> Result<(), DatasetError> {
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
             __relative VARCHAR NOT NULL{partition_columns})"
        ))
        .map_err(|error| classify_query_error(error, false))?;
    append_member_metadata(connection, members, summary)
}

fn append_member_metadata(
    connection: &Connection,
    members: &[DatasetMember],
    summary: &DatasetSummary,
) -> Result<(), DatasetError> {
    let mut appender = connection
        .appender("__viewda_members")
        .map_err(|error| classify_query_error(error, false))?;
    for member in members {
        let path = member.path.to_str().ok_or(DatasetError::Unsupported)?;
        let mut values = vec![
            Value::UBigInt(member.ordinal),
            Value::Text(path.to_owned()),
            Value::Text(member.relative_path.clone()),
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
            .map_err(|error| classify_query_error(error, false))?;
    }
    appender
        .flush()
        .map_err(|error| classify_query_error(error, false))?;
    Ok(())
}

fn install_member_maps(
    connection: &Connection,
    summary: &DatasetSummary,
) -> Result<(), DatasetError> {
    connection
        .execute_batch(
            "SET VARIABLE __viewda_relative_map = (\
             SELECT map(list(__path ORDER BY __ordinal), list(__relative ORDER BY __ordinal)) \
             FROM __viewda_members)",
        )
        .map_err(|error| classify_query_error(error, false))?;
    for partition_index in 0..summary.partition_column_indices.len() {
        connection
            .execute_batch(&format!(
                "SET VARIABLE __viewda_partition_{partition_index} = (\
                 SELECT map(list(__path ORDER BY __ordinal), \
                 list({} ORDER BY __ordinal)) FROM __viewda_members)",
                quote_identifier(&format!("__partition_{partition_index}"))
            ))
            .map_err(|error| classify_query_error(error, false))?;
    }
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

fn encode_empty_ipc(schema: &SchemaRef) -> Result<Vec<u8>, DatasetError> {
    let mut writer = StreamWriter::try_new(Vec::new(), schema.as_ref())
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .finish()
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .into_inner()
        .map_err(|_| DataWindowError::EncodingFailed.into())
}

fn discover_members(
    root: &Path,
    directory: &Path,
    members: &mut Vec<DatasetMember>,
    ignored_file_count: &mut u64,
) -> Result<(), DatasetError> {
    let entries = fs::read_dir(directory).map_err(map_discovery_error)?;
    for entry in entries {
        let entry = entry.map_err(map_discovery_error)?;
        let file_type = entry.file_type().map_err(map_discovery_error)?;
        let path = entry.path();
        if file_type.is_dir() {
            discover_members(root, &path, members, ignored_file_count)?;
        } else if file_type.is_file() && is_visible_parquet_path(root, &path) {
            let metadata = entry.metadata().map_err(map_discovery_error)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| DatasetError::Unsupported)?;
            let relative_path = slash_path(relative)?;
            let partitions = parse_partitions(relative)?;
            let identity = member_identity(&path, &metadata).map_err(map_discovery_error)?;
            members.push(DatasetMember {
                ordinal: 0,
                path,
                relative_path,
                partitions,
                identity,
            });
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
        && path
            .extension()
            .is_some_and(|extension| extension == "parquet")
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

fn common_parent(paths: &[PathBuf]) -> Option<PathBuf> {
    let mut common = paths.first()?.parent()?.to_path_buf();
    while paths.iter().any(|path| !path.starts_with(&common)) {
        if !common.pop() {
            return None;
        }
    }
    while common
        .file_name()
        .and_then(|component| component.to_str())
        .is_some_and(is_hive_partition_component)
    {
        if !common.pop() {
            return None;
        }
    }
    Some(common)
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
    members: &[DatasetMember],
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
                member: first_member_with_partition(members, name),
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
                    .unwrap_or_else(|| first_member_with_partition(members, reserved)),
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

fn first_member_with_partition(members: &[DatasetMember], key: &str) -> String {
    members
        .iter()
        .find(|member| {
            member
                .partitions
                .iter()
                .any(|partition| partition.key.eq_ignore_ascii_case(key))
        })
        .map(|member| member.relative_path.clone())
        .unwrap_or_default()
}

fn drift_page(
    members: &[DatasetMember],
    deviating_members: &[usize],
    offset: u64,
    limit: u32,
) -> Result<DatasetMemberPage, DatasetError> {
    if limit > MAX_MEMBER_PAGE_SIZE {
        return Err(DatasetError::MemberPageTooLarge);
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
    candidates: &[&DatasetMember],
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
    candidates: &[&DatasetMember],
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
    candidates: &[&DatasetMember],
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
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` keeps the handle valid and `information` is writable for the call.
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PlatformFileIdentity::Windows {
        volume: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
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
    use arrow_array::Int64Array;
    use arrow_schema::Field;
    use tempfile::tempdir;

    use super::*;

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
    fn query_schema_postflight_rejects_a_change_after_the_query_finishes() {
        let directory = tempdir().expect("dataset directory");
        let path = directory.path().join("part.parquet");
        write_test_member(&path, 1);
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("footer pass");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let candidates = reader.source.members.iter().collect::<Vec<_>>();

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
            let source = DatasetSource {
                display_name: "dataset/".to_owned(),
                ignored_file_count: 0,
                members: vec![member.clone()].into(),
                changed_member: Arc::new(Mutex::new(None)),
            };

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
        initialize_member_tables(&connection, &members, &summary).expect("member metadata");
        let source = DatasetSource {
            display_name: "dataset/".to_owned(),
            ignored_file_count: 0,
            members: members.clone().into(),
            changed_member: Arc::new(Mutex::new(None)),
        };
        let reader = DatasetWindowReader {
            source,
            summary,
            connection,
            member_limit: None,
            deviating_members: Vec::new(),
            arrow_schema: Arc::new(Schema::empty()),
            filename_column: "__viewda_filename".to_owned(),
            physical_column_count: 0,
            initialized_member_count: 2,
            schema_seed: None,
        };
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
        initialize_member_tables(&connection, &members, &summary).expect("static metadata");
        let source = DatasetSource {
            display_name: "dataset/".to_owned(),
            ignored_file_count: 0,
            members: members.clone().into(),
            changed_member: Arc::new(Mutex::new(None)),
        };
        let reader = DatasetWindowReader {
            source,
            summary,
            connection,
            member_limit: None,
            deviating_members: Vec::new(),
            arrow_schema: Arc::new(Schema::empty()),
            filename_column: "__viewda_filename".to_owned(),
            physical_column_count: 1,
            initialized_member_count: 1_000,
            schema_seed: None,
        };

        let query = reader.query_sql("");

        assert!(query.len() < 1_500);
        assert!(!query.contains("part-0000.parquet"));
        assert!(!query.contains("part-0999.parquet"));
        reader
            .bind_candidate_paths(&[&members[999]])
            .expect("one candidate bind");
        let (bound_paths, static_members) = reader
            .connection
            .query_row(
                "SELECT len(getvariable('__viewda_paths')), count(*) FROM __viewda_members",
                [],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
            )
            .expect("bounded per-fetch metadata");
        assert_eq!((bound_paths, static_members), (1, 1_000));
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
            Err(DatasetError::MemberPageTooLarge)
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
