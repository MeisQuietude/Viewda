//! Cancellable, bounded-memory file export through the query engine.

use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use duckdb::{
    Config, Connection, Error as DuckDbError, InterruptHandle, params, params_from_iter,
    types::Value,
};
use serde::Deserialize;
use tempfile::{TempDir, TempPath};
use thiserror::Error;

use crate::{
    FieldPath,
    dataset::{
        DatasetError, DatasetQuerySource, DatasetRowPosition, DatasetSetupError,
        DatasetWindowReader, MAX_EXPORT_SPARSE_MEMBERS, MAX_EXPORT_SPARSE_ROWS,
    },
    field_path::{field_path_expression, field_path_title, resolve_field_path},
    filter::{DataFilter, FilterPredicate, build_filter_predicate_with_names},
    source::{SchemaField, SourceError, inspect_local_source_for_query},
    view::{PreparedDataViewExport, PreparedDataViewExportSource, read_dataset_positions},
};

const QUERY_MEMORY_LIMIT: &str = "384MB";

/// Options for RFC 4180 CSV export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CsvExportOptions {}

/// File format and format-specific options accepted by the export boundary.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "format", rename_all = "camelCase")]
pub enum DataExportFormat {
    /// Comma-separated values with the v1 defaults.
    Csv {
        /// Reserved format-specific options object.
        #[serde(default)]
        options: CsvExportOptions,
    },
}

/// Half-open row range in the active filtered and sorted view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRowRange {
    /// First included zero-based view row.
    pub start: u64,
    /// First excluded zero-based view row.
    pub end: u64,
}

/// Path-free description of the view rows and columns to export.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExportRequest {
    /// Addressable fields in visible grid order.
    pub field_paths: Vec<FieldPath>,
    /// Selected view rows. An empty list exports every view row.
    #[serde(default)]
    pub row_ranges: Vec<ExportRowRange>,
    /// Output format and format-specific options.
    pub output: DataExportFormat,
}

/// Stable failures from a file export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DataExportError {
    /// The selected source no longer exists.
    #[error("The selected file no longer exists.")]
    NotFound,
    /// The operating system denied source or destination access.
    #[error("Viewda does not have permission to read or write this file.")]
    PermissionDenied,
    /// The source path no longer identifies the opened file.
    #[error("The selected file changed after it was opened.")]
    SourceChanged,
    /// The selected source does not have Parquet file markers.
    #[error("The selected file is not a Parquet file.")]
    NotParquet,
    /// DuckDB could not decode the selected source.
    #[error("The Parquet data is damaged or incomplete.")]
    CorruptSource,
    /// The requested columns, ranges, or filters are invalid.
    #[error("The export request is invalid for this view.")]
    InvalidRequest,
    /// The source, destination, or selected values cannot be exported safely.
    #[error("This view cannot be exported.")]
    Unsupported,
    /// The destination filesystem ran out of space.
    #[error("There is not enough disk space to finish the export.")]
    DiskFull,
    /// The query exceeded the bounded export connection's memory budget.
    #[error("There is not enough memory to finish the export.")]
    ResourceExhausted,
    /// The query engine could not finish the export.
    #[error("The query engine could not export this view.")]
    QueryFailed,
    /// The packaged DuckDB library could not start.
    #[error("The packaged query engine could not start.")]
    QueryEngineUnavailable,
    /// The caller cancelled the export.
    #[error("The export was cancelled.")]
    Cancelled,
}

/// Thread-safe cancellation handle for one export query.
#[derive(Clone)]
pub struct DataExportCancellation {
    interrupt: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

impl DataExportCancellation {
    /// Interrupts the active query, or marks a not-yet-started query cancelled.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.interrupt.interrupt();
    }

    /// Reports whether the caller requested cancellation.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Measured bytes written to the temporary export file.
#[derive(Clone)]
pub struct DataExportProgress {
    temporary_path: Arc<PathBuf>,
    final_bytes: Arc<AtomicU64>,
}

impl DataExportProgress {
    /// Reads the current temporary-file size without estimating a percentage.
    pub fn bytes_written(&self) -> u64 {
        fs::metadata(self.temporary_path.as_ref())
            .map(|metadata| metadata.len())
            .unwrap_or_else(|_| self.final_bytes.load(Ordering::Acquire))
    }
}

/// Owns the isolated DuckDB connection and adjacent temporary output file.
pub struct DataExportReader {
    source: DataExportSource,
    target_path: PathBuf,
    temporary_path: TempPath,
    connection: Connection,
    _spill_directory: TempDir,
    _work_directory: TempDir,
    request: DataExportRequest,
    view: Option<PreparedDataViewExport>,
    schema: Vec<SchemaField>,
    cancelled: Arc<AtomicBool>,
    final_bytes: Arc<AtomicU64>,
}

enum DataExportSource {
    File(PathBuf),
    Dataset(Box<DatasetQuerySource>),
}

impl DataExportReader {
    /// Prepares an export that cannot block the grid connection.
    pub fn new(
        source_path: PathBuf,
        target_path: PathBuf,
        mut request: DataExportRequest,
        view: Option<PreparedDataViewExport>,
    ) -> Result<Self, DataExportError> {
        let summary =
            inspect_local_source_for_query(&source_path).map_err(DataExportError::from)?;
        if paths_match(&source_path, &target_path) {
            return Err(DataExportError::InvalidRequest);
        }
        if view.as_ref().is_some_and(|view| {
            !matches!(&view.source, PreparedDataViewExportSource::File(path) if path == &source_path)
        }) {
            return Err(DataExportError::InvalidRequest);
        }
        let filters = view
            .as_ref()
            .map(|view| view.filters.as_slice())
            .unwrap_or_default();
        let view_row_count = view
            .as_ref()
            .map_or(summary.row_count, |view| view.row_count);
        validate_request(&summary.schema, &request, filters, view_row_count)?;
        request.row_ranges = normalize_ranges(&request.row_ranges)?;

        Self::with_source(
            DataExportSource::File(source_path),
            target_path,
            request,
            view,
            summary.schema,
        )
    }

    /// Prepares an export from one completed fixed dataset.
    pub fn for_dataset(
        reader: &DatasetWindowReader,
        target_path: PathBuf,
        request: DataExportRequest,
        view: Option<PreparedDataViewExport>,
    ) -> Result<Self, DataExportError> {
        Self::for_dataset_while(reader, target_path, request, view, || true)
    }

    /// Prepares a dataset export while its start reservation remains active.
    pub fn for_dataset_while(
        reader: &DatasetWindowReader,
        target_path: PathBuf,
        mut request: DataExportRequest,
        view: Option<PreparedDataViewExport>,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DataExportError> {
        let source = reader
            .query_source_while(&mut keep_going)
            .map_err(dataset_export_error)?;
        if source
            .target_matches_member(&target_path)
            .map_err(dataset_export_error)?
        {
            return Err(DataExportError::InvalidRequest);
        }
        if view.as_ref().is_some_and(|view| {
            !matches!(&view.source, PreparedDataViewExportSource::Dataset(token)
                if source.matches_session(token))
        }) {
            return Err(DataExportError::InvalidRequest);
        }
        let filters = view
            .as_ref()
            .map(|view| view.filters.as_slice())
            .unwrap_or_default();
        let view_row_count = view
            .as_ref()
            .map_or(source.row_count(), |view| view.row_count);
        validate_request(source.schema(), &request, filters, view_row_count)?;
        request.row_ranges = normalize_ranges(&request.row_ranges)?;
        let schema = source.schema().to_vec();
        let export = Self::with_source(
            DataExportSource::Dataset(Box::new(source)),
            target_path,
            request,
            view,
            schema,
        )?;
        if !keep_going() {
            export.cancellation().cancel();
            return Err(DataExportError::Cancelled);
        }
        Ok(export)
    }

    fn with_source(
        source: DataExportSource,
        target_path: PathBuf,
        request: DataExportRequest,
        view: Option<PreparedDataViewExport>,
        schema: Vec<SchemaField>,
    ) -> Result<Self, DataExportError> {
        let is_dataset = matches!(source, DataExportSource::Dataset(_));
        let target_directory = target_path.parent().ok_or(DataExportError::Unsupported)?;
        let mut work_directory_builder = tempfile::Builder::new();
        work_directory_builder.prefix(".viewda-export-work-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            work_directory_builder.permissions(fs::Permissions::from_mode(0o700));
        }
        let work_directory = work_directory_builder
            .tempdir_in(target_directory)
            .map_err(classify_io_error)?;
        let temporary_file = tempfile::Builder::new()
            .prefix("output-")
            .suffix(".tmp")
            .tempfile_in(work_directory.path())
            .map_err(classify_io_error)?;
        let temporary_path = temporary_file.into_temp_path();
        // DuckDB creates COPY targets itself. The private directory keeps this absent name
        // unavailable to other processes while TempPath retains cleanup and publish ownership.
        fs::remove_file(&temporary_path).map_err(classify_io_error)?;

        let spill_directory = tempfile::Builder::new()
            .prefix("spill-")
            .tempdir_in(work_directory.path())
            .map_err(classify_io_error)?;
        let spill_directory_path = spill_directory
            .path()
            .to_str()
            .ok_or(DataExportError::QueryEngineUnavailable)?;
        let config = Config::default()
            .enable_object_cache(!is_dataset)
            .and_then(|config| config.max_memory(QUERY_MEMORY_LIMIT))
            .and_then(|config| config.with("temp_directory", spill_directory_path))
            .and_then(|config| config.with("preserve_insertion_order", "true"))
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;
        let config = if is_dataset {
            config
                .with("threads", "1")
                .map_err(|_| DataExportError::QueryEngineUnavailable)?
        } else {
            config
        };
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;
        connection
            .execute_batch(if is_dataset {
                "SET TimeZone = 'UTC'; SET parquet_metadata_cache = false"
            } else {
                "SET TimeZone = 'UTC'; SET parquet_metadata_cache = true"
            })
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;

        Ok(Self {
            source,
            target_path,
            temporary_path,
            connection,
            _spill_directory: spill_directory,
            _work_directory: work_directory,
            request,
            view,
            schema,
            cancelled: Arc::new(AtomicBool::new(false)),
            final_bytes: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Returns a handle that can interrupt this export from another thread.
    pub fn cancellation(&self) -> DataExportCancellation {
        DataExportCancellation {
            interrupt: self.connection.interrupt_handle(),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Returns a handle for measured output-file growth.
    pub fn progress(&self) -> DataExportProgress {
        DataExportProgress {
            temporary_path: Arc::new(self.temporary_path.to_path_buf()),
            final_bytes: Arc::clone(&self.final_bytes),
        }
    }

    /// Streams the requested query to a temporary file and atomically replaces the target.
    pub fn export(self) -> Result<u64, DataExportError> {
        self.export_checked(|| {})
    }

    fn export_checked(self, before_copy: impl FnOnce()) -> Result<u64, DataExportError> {
        self.require_active()?;
        let temporary_path = self
            .temporary_path
            .to_str()
            .ok_or(DataExportError::Unsupported)?;
        match &self.source {
            DataExportSource::File(source_path) => {
                let source_path = source_path.to_str().ok_or(DataExportError::Unsupported)?;
                self.connection
                    .execute(
                        "SET VARIABLE __viewda_source_path = ?",
                        params![source_path],
                    )
                    .map_err(|error| self.classify_setup_query_error(error, true))?;
            }
            DataExportSource::Dataset(dataset) => {
                dataset
                    .install_while(&self.connection, || !self.cancelled.load(Ordering::Acquire))
                    .map_err(|error| self.classify_dataset_setup_error(error))?;
            }
        }
        let conversion_is_request = matches!(&self.source, DataExportSource::File(_));
        self.connection
            .execute(
                "SET VARIABLE __viewda_export_path = ?",
                params![temporary_path],
            )
            .map_err(|error| self.classify_setup_query_error(error, conversion_is_request))?;
        if let Some(view) = self
            .view
            .as_ref()
            .filter(|view| view.sorted && matches!(&self.source, DataExportSource::File(_)))
        {
            let position_index = view
                .position_index
                .to_str()
                .ok_or(DataExportError::Unsupported)?;
            self.connection
                .execute(
                    "SET VARIABLE __viewda_position_index_path = ?",
                    params![position_index],
                )
                .map_err(|error| self.classify_setup_query_error(error, conversion_is_request))?;
        }
        before_copy();
        self.require_active()?;
        let result = match &self.source {
            DataExportSource::File(_) => {
                let (query, parameters) =
                    build_export_query(&self.schema, &self.request, self.view.as_ref())?;
                self.connection.execute(
                    &build_csv_copy(&query, true),
                    params_from_iter(parameters.iter()),
                )
            }
            DataExportSource::Dataset(dataset) => {
                self.export_dataset_batches(dataset)?;
                Ok(0)
            }
        };
        if self.cancelled.load(Ordering::Acquire) {
            return Err(DataExportError::Cancelled);
        }
        result.map_err(|error| match &self.source {
            DataExportSource::File(_) => classify_query_error(error),
            DataExportSource::Dataset(dataset) => {
                classify_dataset_export_query_error(dataset, error)
            }
        })?;
        self.require_active()?;
        if let DataExportSource::Dataset(dataset) = &self.source {
            dataset
                .require_active_while(|| !self.cancelled.load(Ordering::Acquire))
                .map_err(dataset_export_error)?;
        }
        self.require_active()?;

        let bytes = fs::metadata(&self.temporary_path)
            .map_err(classify_io_error)?
            .len();
        self.final_bytes.store(bytes, Ordering::Release);
        self.require_active()?;
        self.temporary_path
            .persist(&self.target_path)
            .map_err(|error| classify_io_error(error.error))?;
        Ok(bytes)
    }

    fn require_active(&self) -> Result<(), DataExportError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(DataExportError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn export_dataset_batches(&self, dataset: &DatasetQuerySource) -> Result<(), DataExportError> {
        let selected_columns = self
            .request
            .field_paths
            .iter()
            .map(|path| {
                let resolved = resolve_field_path(&self.schema, path)
                    .ok_or(DataExportError::InvalidRequest)?;
                let root = format!(
                    "source.{}",
                    quote_identifier(&self.schema[resolved.root_index].name)
                );
                let expression =
                    field_path_expression(path, &root).ok_or(DataExportError::InvalidRequest)?;
                Ok(export_column_expression_from(
                    resolved.field,
                    &expression,
                    &field_path_title(path),
                ))
            })
            .collect::<Result<Vec<_>, DataExportError>>()?
            .join(", ");
        let mut wrote_rows = false;
        if let Some(view) = &self.view {
            let ranges = if self.request.row_ranges.is_empty() {
                vec![ExportRowRange {
                    start: 0,
                    end: view.row_count,
                }]
            } else {
                self.request.row_ranges.clone()
            };
            for range in ranges {
                let mut offset = range.start;
                while offset < range.end {
                    self.require_active()?;
                    let requested_rows = usize::try_from(range.end - offset)
                        .map_err(|_| DataExportError::InvalidRequest)?
                        .min(MAX_EXPORT_SPARSE_ROWS);
                    let mut positions = read_dataset_positions(
                        &view.position_index,
                        &view.position_metadata,
                        usize::try_from(offset).map_err(|_| DataExportError::InvalidRequest)?,
                        requested_rows,
                    )
                    .map_err(|error| dataset_export_error(error.into()))?;
                    truncate_sparse_member_prefix(&mut positions, MAX_EXPORT_SPARSE_MEMBERS);
                    if positions.is_empty() {
                        return Err(DataExportError::InvalidRequest);
                    }
                    let rows = dataset
                        .stage_sparse_export_while(
                            &positions,
                            &self.request.field_paths,
                            self._work_directory.path(),
                            || !self.cancelled.load(Ordering::Acquire),
                        )
                        .map_err(dataset_export_error)?;
                    let query = format!(
                        "SELECT {selected_columns} FROM {} source ORDER BY source.{}",
                        rows.relation_sql(),
                        quote_identifier(rows.requested_order_column())
                    );
                    self.execute_dataset_copy(dataset, &query, &[], !wrote_rows)?;
                    wrote_rows = true;
                    offset = offset
                        .checked_add(
                            u64::try_from(rows.row_count())
                                .map_err(|_| DataExportError::InvalidRequest)?,
                        )
                        .ok_or(DataExportError::InvalidRequest)?;
                    self.require_active()?;
                    drop(rows);
                }
            }
        } else {
            let mut cursor = dataset.candidate_batches(&[]);
            let ranges = if self.request.row_ranges.is_empty() {
                vec![ExportRowRange {
                    start: 0,
                    end: dataset.row_count(),
                }]
            } else {
                self.request.row_ranges.clone()
            };
            let mut batch_start = 0_u64;
            while dataset
                .bind_next_candidate_batch(&self.connection, &mut cursor, || {
                    !self.cancelled.load(Ordering::Acquire)
                })
                .map_err(|error| self.classify_dataset_setup_error(error))?
            {
                let batch_rows = dataset
                    .bound_row_count(&self.connection)
                    .map_err(|error| self.classify_dataset_setup_error(error))?;
                let batch_end = batch_start
                    .checked_add(batch_rows)
                    .ok_or(DataExportError::Unsupported)?;
                let mut scanned_batch = false;
                for range in &ranges {
                    let start = range.start.max(batch_start);
                    let end = range.end.min(batch_end);
                    if start >= end {
                        continue;
                    }
                    if !scanned_batch {
                        dataset
                            .validate_bound_members_while(|| {
                                !self.cancelled.load(Ordering::Acquire)
                            })
                            .map_err(dataset_export_error)?;
                        scanned_batch = true;
                    }
                    let relation = dataset.relation_sql();
                    let query = format!(
                        "SELECT {selected_columns} FROM {relation} source \
                         LIMIT ? OFFSET ?"
                    );
                    self.execute_dataset_copy(
                        dataset,
                        &query,
                        &[
                            Value::BigInt((end - start) as i64),
                            Value::BigInt((start - batch_start) as i64),
                        ],
                        !wrote_rows,
                    )?;
                    wrote_rows = true;
                }
                if scanned_batch {
                    dataset
                        .validate_bound_members_while(|| !self.cancelled.load(Ordering::Acquire))
                        .map_err(dataset_export_error)?;
                }
                batch_start = batch_end;
            }
        }
        if !wrote_rows {
            let relation = dataset
                .sparse_empty_relation_sql()
                .map_err(dataset_export_error)?;
            let query = format!("SELECT {selected_columns} FROM {relation} source LIMIT 0");
            self.execute_dataset_copy(dataset, &query, &[], true)?;
        }
        Ok(())
    }

    fn execute_dataset_copy(
        &self,
        dataset: &DatasetQuerySource,
        query: &str,
        parameters: &[Value],
        header: bool,
    ) -> Result<(), DataExportError> {
        self.require_active()?;
        if header {
            let output_path = self
                .temporary_path
                .to_str()
                .ok_or(DataExportError::Unsupported)?;
            self.connection
                .execute(
                    "SET VARIABLE __viewda_export_path = ?",
                    params![output_path],
                )
                .map_err(|error| self.classify_setup_query_error(error, false))?;
            let result = self.connection.execute(
                &build_csv_copy(query, true),
                params_from_iter(parameters.iter()),
            );
            if self.cancelled.load(Ordering::Acquire) {
                return Err(DataExportError::Cancelled);
            }
            result.map_err(|error| classify_dataset_export_query_error(dataset, error))?;
            return self.require_active();
        }
        let directory = self
            .temporary_path
            .parent()
            .ok_or(DataExportError::Unsupported)?;
        let chunk = tempfile::Builder::new()
            .prefix(".viewda-export-chunk-")
            .tempfile_in(directory)
            .map_err(classify_io_error)?;
        let chunk = chunk.into_temp_path();
        // The enclosing work directory is private and remains leased for the entire export.
        fs::remove_file(&chunk).map_err(classify_io_error)?;
        let chunk_path = chunk.to_str().ok_or(DataExportError::Unsupported)?;
        self.connection
            .execute("SET VARIABLE __viewda_export_path = ?", params![chunk_path])
            .map_err(|error| self.classify_setup_query_error(error, false))?;
        let result = self.connection.execute(
            &build_csv_copy(query, header),
            params_from_iter(parameters.iter()),
        );
        if self.cancelled.load(Ordering::Acquire) {
            return Err(DataExportError::Cancelled);
        }
        result.map_err(|error| classify_dataset_export_query_error(dataset, error))?;
        let mut chunk_file = fs::File::open(&chunk).map_err(classify_io_error)?;
        let mut output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.temporary_path)
            .map_err(classify_io_error)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            self.require_active()?;
            let read = chunk_file.read(&mut buffer).map_err(classify_io_error)?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(classify_io_error)?;
        }
        self.require_active()
    }

    fn classify_setup_query_error(
        &self,
        error: DuckDbError,
        conversion_is_request: bool,
    ) -> DataExportError {
        if self.cancelled.load(Ordering::Acquire) {
            DataExportError::Cancelled
        } else {
            classify_query_error_category(&error, conversion_is_request)
                .unwrap_or(DataExportError::QueryFailed)
        }
    }

    fn classify_dataset_setup_error(&self, error: DatasetSetupError) -> DataExportError {
        if self.cancelled.load(Ordering::Acquire) {
            return DataExportError::Cancelled;
        }
        match error {
            DatasetSetupError::Dataset(error) => dataset_export_error(error),
            DatasetSetupError::Query(error) => {
                classify_query_error_category(&error, false).unwrap_or(DataExportError::QueryFailed)
            }
        }
    }
}

fn build_csv_copy(query: &str, header: bool) -> String {
    format!(
        "COPY ({query}) TO (getvariable('__viewda_export_path')) \
         (FORMAT CSV, HEADER {header}, DELIMITER ',', \
         QUOTE '\"', ESCAPE '\"', NULLSTR '', NEW_LINE E'\\r\\n', \
         DATEFORMAT '%Y-%m-%d', TIMESTAMPFORMAT '%Y-%m-%dT%H:%M:%S.%n')"
    )
}

fn truncate_sparse_member_prefix(positions: &mut Vec<DatasetRowPosition>, member_limit: usize) {
    let mut seen = HashSet::new();
    let mut keep = positions.len();
    for (index, position) in positions.iter().enumerate() {
        if !seen.contains(&position.member_ordinal) && seen.len() == member_limit {
            keep = index;
            break;
        }
        seen.insert(position.member_ordinal);
    }
    positions.truncate(keep);
}

fn paths_match(source_path: &Path, target_path: &Path) -> bool {
    source_path == target_path
        || fs::canonicalize(source_path)
            .ok()
            .zip(fs::canonicalize(target_path).ok())
            .is_some_and(|(source, target)| source == target)
}

fn validate_request(
    schema: &[SchemaField],
    request: &DataExportRequest,
    filters: &[DataFilter],
    view_row_count: u64,
) -> Result<(), DataExportError> {
    if request.field_paths.is_empty() {
        return Err(DataExportError::InvalidRequest);
    }
    let mut columns = HashSet::new();
    for path in &request.field_paths {
        if resolve_field_path(schema, path).is_none() || !columns.insert(path) {
            return Err(DataExportError::InvalidRequest);
        }
    }
    build_export_filter_predicate(schema, filters).map_err(|_| DataExportError::InvalidRequest)?;
    let ranges = normalize_ranges(&request.row_ranges)?;
    if ranges
        .last()
        .is_some_and(|range| range.end > view_row_count)
    {
        return Err(DataExportError::InvalidRequest);
    }
    Ok(())
}

fn normalize_ranges(ranges: &[ExportRowRange]) -> Result<Vec<ExportRowRange>, DataExportError> {
    let mut ranges = ranges.to_vec();
    if ranges
        .iter()
        .any(|range| range.start >= range.end || range.end > i64::MAX as u64)
    {
        return Err(DataExportError::InvalidRequest);
    }
    ranges.sort_unstable_by_key(|range| (range.start, range.end));
    let mut normalized: Vec<ExportRowRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(previous) = normalized.last_mut()
            && range.start <= previous.end
        {
            previous.end = previous.end.max(range.end);
        } else {
            normalized.push(range);
        }
    }
    Ok(normalized)
}

fn build_export_query(
    schema: &[SchemaField],
    request: &DataExportRequest,
    view: Option<&PreparedDataViewExport>,
) -> Result<(String, Vec<Value>), DataExportError> {
    if let Some(view) = view.filter(|view| view.sorted) {
        return build_sorted_view_query(schema, request, view);
    }
    let filters = view.map(|view| view.filters.as_slice()).unwrap_or_default();
    let predicate = build_export_filter_predicate(schema, filters)
        .map_err(|_| DataExportError::InvalidRequest)?;
    let selected_columns = request
        .field_paths
        .iter()
        .map(|path| {
            let resolved =
                resolve_field_path(schema, path).ok_or(DataExportError::InvalidRequest)?;
            let root = quote_identifier(&schema[resolved.root_index].name);
            let expression =
                field_path_expression(path, &root).ok_or(DataExportError::InvalidRequest)?;
            Ok::<String, DataExportError>(export_column_expression_from(
                resolved.field,
                &expression,
                &field_path_title(path),
            ))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join(", ");
    let where_clause = if predicate.sql.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", predicate.sql)
    };
    if request.row_ranges.is_empty() {
        return Ok((
            format!(
                "SELECT {selected_columns} \
                 FROM read_parquet(getvariable('__viewda_source_path')){where_clause}"
            ),
            predicate.parameters,
        ));
    }

    build_selection_query(
        schema,
        request,
        &predicate.sql,
        &predicate.parameters,
        &selected_columns,
    )
}

fn build_export_filter_predicate(
    schema: &[SchemaField],
    filters: &[DataFilter],
) -> Result<FilterPredicate, crate::filter::FilterBuildError> {
    let column_names = schema
        .iter()
        .map(|field| field.name.as_str())
        .collect::<Vec<_>>();
    build_filter_predicate_with_names(schema, filters, &column_names)
}

fn build_selection_query(
    schema: &[SchemaField],
    request: &DataExportRequest,
    predicate_sql: &str,
    predicate_parameters: &[Value],
    selected_columns: &str,
) -> Result<(String, Vec<Value>), DataExportError> {
    let names = schema
        .iter()
        .map(|field| field.name.to_lowercase())
        .collect::<HashSet<_>>();
    let file_row = available_name("__viewda_file_row", &names);
    let mut names_with_file_row = names;
    names_with_file_row.insert(file_row.to_lowercase());
    let range_order = available_name("__viewda_range_order", &names_with_file_row);
    let aliases = schema
        .iter()
        .map(|field| quote_identifier(&field.name))
        .chain(std::iter::once(quote_identifier(&file_row)))
        .collect::<Vec<_>>()
        .join(", ");
    let raw_columns = schema
        .iter()
        .map(|field| quote_identifier(&field.name))
        .collect::<Vec<_>>()
        .join(", ");
    let where_clause = if predicate_sql.is_empty() {
        String::new()
    } else {
        format!(" WHERE {predicate_sql}")
    };
    let file_row_identifier = quote_identifier(&file_row);
    let range_order_identifier = quote_identifier(&range_order);
    let mut parameters = Vec::new();
    let branches = request
        .row_ranges
        .iter()
        .enumerate()
        .map(|(range_index, range)| {
            parameters.extend_from_slice(predicate_parameters);
            parameters.extend([
                Value::BigInt((range.end - range.start) as i64),
                Value::BigInt(range.start as i64),
            ]);
            format!(
                "(SELECT {raw_columns}, {file_row_identifier}, \
                   {range_index}::UBIGINT AS {range_order_identifier} \
                  FROM read_parquet(\
                    getvariable('__viewda_source_path'), \
                    file_row_number = true, hive_partitioning = false\
                  ) AS \"__viewda_source\"({aliases}){where_clause} \
                  LIMIT ? OFFSET ?)"
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");

    Ok((
        format!(
            "SELECT {selected_columns} FROM ({branches}) AS \"__viewda_selection\" \
             ORDER BY {range_order_identifier}, {file_row_identifier}"
        ),
        parameters,
    ))
}

fn build_sorted_view_query(
    schema: &[SchemaField],
    request: &DataExportRequest,
    view: &PreparedDataViewExport,
) -> Result<(String, Vec<Value>), DataExportError> {
    let requested = quote_identifier("__viewda_requested");
    let requested_source = quote_identifier("__viewda_requested_source");
    let source = quote_identifier("__viewda_source");
    let raw_source = quote_identifier("__viewda_raw_source");
    let source_positions = quote_identifier("__viewda_source_positions");
    let position = quote_identifier("__viewda_position");
    let requested_order = quote_identifier("__viewda_requested_order");
    let source_position = quote_identifier("__viewda_source_position");
    let source_columns = (0..schema.len())
        .map(|index| format!("__viewda_column_{index}"))
        .collect::<Vec<_>>();
    let source_column_aliases = source_columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let selected_columns = request
        .field_paths
        .iter()
        .map(|path| {
            let resolved =
                resolve_field_path(schema, path).ok_or(DataExportError::InvalidRequest)?;
            let source_column = source_columns
                .get(resolved.root_index)
                .ok_or(DataExportError::InvalidRequest)?;
            let root = format!("{source}.{}", quote_identifier(source_column));
            let expression =
                field_path_expression(path, &root).ok_or(DataExportError::InvalidRequest)?;
            Ok(export_column_expression_from(
                resolved.field,
                &expression,
                &field_path_title(path),
            ))
        })
        .collect::<Result<Vec<_>, DataExportError>>()?
        .join(", ");
    let (range_clause, parameters) = build_view_range_clause(&request.row_ranges, &requested_order);
    let requested_cte = format!(
        "{requested} AS (\
         SELECT {position}, {requested_order} \
         FROM read_parquet(\
           getvariable('__viewda_position_index_path'), \
           file_row_number = true, hive_partitioning = false\
         ) AS {requested_source}({position}, {requested_order}){range_clause})"
    );
    let query = if schema.iter().any(|field| field.name == "file_row_number") {
        format!(
            "WITH {requested_cte}, \
             {source} AS (\
             SELECT {raw_source}.*, {source_positions}.{source_position} \
             FROM read_parquet(getvariable('__viewda_source_path')) \
             AS {raw_source}({source_column_aliases}) \
             POSITIONAL JOIN range({source_row_count}) \
             AS {source_positions}({source_position})) \
             SELECT {selected_columns} \
             FROM {requested} \
             JOIN {source} \
             ON {source}.{source_position} = {requested}.{position} \
             ORDER BY {requested}.{requested_order}",
            source_row_count = view.source_row_count,
        )
    } else {
        let source_aliases = format!("{source_column_aliases}, {source_position}");
        format!(
            "WITH {requested_cte} \
             SELECT {selected_columns} \
             FROM {requested} \
             JOIN read_parquet(\
               getvariable('__viewda_source_path'), \
               file_row_number = true, hive_partitioning = false\
             ) AS {source}({source_aliases}) \
             ON {source}.{source_position} = {requested}.{position} \
             ORDER BY {requested}.{requested_order}"
        )
    };
    Ok((query, parameters))
}

fn build_view_range_clause(
    ranges: &[ExportRowRange],
    requested_order: &str,
) -> (String, Vec<Value>) {
    if ranges.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut parameters = Vec::with_capacity(ranges.len() * 2);
    let conditions = ranges
        .iter()
        .map(|range| {
            parameters.extend([
                Value::BigInt(range.start as i64),
                Value::BigInt(range.end as i64),
            ]);
            format!("({requested_order} >= ? AND {requested_order} < ?)")
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    (format!(" WHERE {conditions}"), parameters)
}

fn export_column_expression_from(field: &SchemaField, value: &str, output_name: &str) -> String {
    let identifier = quote_identifier(output_name);
    if field.physical_type == "GROUP" {
        return format!(
            "{} AS {identifier}",
            canonical_json_expression(field, value)
        );
    }
    if field.physical_type == "INT96"
        || field
            .logical_type
            .as_deref()
            .is_some_and(|logical_type| logical_type.starts_with("Timestamp"))
    {
        let utc = field
            .logical_type
            .as_deref()
            .is_some_and(|logical_type| logical_type.ends_with(", UTC)"));
        let fraction = if utc { "%f" } else { "%n" };
        let timezone = if utc { "Z" } else { "" };
        return format!(
            "strftime({value}, '%Y-%m-%dT%H:%M:%S.{fraction}') || \
             '{timezone}' AS {identifier}"
        );
    }
    if value == identifier {
        value.to_owned()
    } else {
        format!("{value} AS {identifier}")
    }
}

fn canonical_json_expression(field: &SchemaField, value: &str) -> String {
    let non_null = match field.logical_type.as_deref() {
        Some("Map") => canonical_map_json_expression(field, value),
        Some("List") => canonical_list_json_expression(field, value),
        _ if field.physical_type == "GROUP" => canonical_struct_json_expression(field, value),
        _ => canonical_scalar_json_expression(field, value),
    };
    format!("coalesce({non_null}, CAST('null' AS JSON))")
}

fn canonical_struct_json_expression(field: &SchemaField, value: &str) -> String {
    if field.children.is_empty() {
        return format!("to_json({value})");
    }
    let members = field
        .children
        .iter()
        .flat_map(|child| {
            let child_value = format!(
                "struct_extract({value}, {})",
                quote_string_literal(&child.name)
            );
            [
                quote_string_literal(&child.name),
                canonical_json_expression(child, &child_value),
            ]
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "CASE WHEN {value} IS NULL THEN CAST('null' AS JSON) \
         ELSE json_object({members}) END"
    )
}

fn canonical_list_json_expression(field: &SchemaField, value: &str) -> String {
    let Some(element) = list_element_field(field) else {
        return format!("to_json({value})");
    };
    let element_json = canonical_json_expression(element, "element");
    format!("to_json(list_transform({value}, element -> {element_json}))")
}

fn canonical_map_json_expression(field: &SchemaField, value: &str) -> String {
    let Some((key, map_value)) = map_entry_fields(field) else {
        return format!("to_json({value})");
    };
    let key_json = canonical_json_expression(key, "entry.key");
    let value_json = canonical_json_expression(map_value, "entry.value");
    format!(
        "to_json(list_transform(map_entries({value}), \
         entry -> json_array({key_json}, {value_json})))"
    )
}

fn canonical_scalar_json_expression(field: &SchemaField, value: &str) -> String {
    let logical_type = field.logical_type.as_deref().unwrap_or_default();
    if field.physical_type == "INT96" || logical_type.starts_with("Timestamp") {
        let epoch = if field.physical_type == "INT96" || logical_type.contains("microseconds") {
            format!("epoch_us({value})")
        } else if logical_type.contains("milliseconds") {
            format!("epoch_ms({value})")
        } else {
            format!("epoch_ns({value})")
        };
        return canonical_integer_json_expression(&epoch);
    }
    if logical_type.starts_with("Time") {
        let epoch = if logical_type.contains("milliseconds") {
            format!("epoch_us({value}) / 1000")
        } else if logical_type.contains("microseconds") {
            format!("epoch_us({value})")
        } else {
            format!("epoch_us({value}) * 1000")
        };
        return canonical_integer_json_expression(&epoch);
    }
    if logical_type.starts_with("Decimal") {
        // JSON numbers cannot preserve decimal scale or every exact decimal value.
        return format!("to_json(CAST({value} AS VARCHAR))");
    }
    if matches!(field.physical_type.as_str(), "INT32" | "INT64") && logical_type != "Date" {
        return canonical_integer_json_expression(value);
    }
    if matches!(field.physical_type.as_str(), "FLOAT" | "DOUBLE") {
        // Grid copy and CSV use shortest round-trip finite numbers without an optional positive
        // exponent sign. DuckDB additionally retains fixed-point `.0`, so remove it for integers.
        return format!(
            "CASE WHEN {value} IS NULL THEN NULL \
             WHEN {value} = 0 THEN CAST('0' AS JSON) \
             WHEN isfinite({value}) AND {value} = trunc({value}) AND abs({value}) < 1e21 \
             THEN CAST(substring(CAST(to_json({value}) AS VARCHAR), 1, \
             length(CAST(to_json({value}) AS VARCHAR)) - 2) AS JSON) \
             WHEN isfinite({value}) THEN to_json({value}) \
             WHEN isnan({value}) THEN to_json('NaN') \
             WHEN {value} > 0 THEN to_json('Infinity') \
             ELSE to_json('-Infinity') END"
        );
    }
    if matches!(
        field.physical_type.as_str(),
        "BYTE_ARRAY" | "FIXED_LEN_BYTE_ARRAY"
    ) && !matches!(logical_type, "String" | "Enum" | "JSON" | "BSON")
    {
        return format!("to_json(to_base64({value}))");
    }
    format!("to_json({value})")
}

fn canonical_integer_json_expression(value: &str) -> String {
    format!(
        "CASE WHEN {value} BETWEEN -9007199254740991 AND 9007199254740991 \
         THEN to_json({value}) ELSE to_json(CAST({value} AS VARCHAR)) END"
    )
}

fn list_element_field(field: &SchemaField) -> Option<&SchemaField> {
    let repeated = field.children.first()?;
    repeated.children.first().or(Some(repeated))
}

fn map_entry_fields(field: &SchemaField) -> Option<(&SchemaField, &SchemaField)> {
    let entries = field.children.first()?;
    Some((entries.children.first()?, entries.children.get(1)?))
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn available_name(base: &str, names: &HashSet<String>) -> String {
    let mut name = base.to_owned();
    let mut suffix = 2;
    while names.contains(&name.to_lowercase()) {
        name = format!("{base}_{suffix}");
        suffix += 1;
    }
    name
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn classify_query_error(error: DuckDbError) -> DataExportError {
    classify_query_error_category(&error, true).unwrap_or(DataExportError::QueryFailed)
}

fn classify_query_error_category(
    error: &DuckDbError,
    conversion_is_request: bool,
) -> Option<DataExportError> {
    let DuckDbError::DuckDBFailure(_, Some(message)) = error else {
        return None;
    };
    let lowercase = message.to_lowercase();
    if lowercase.contains("no space left")
        || lowercase.contains("not enough space")
        || lowercase.contains("disk full")
    {
        Some(DataExportError::DiskFull)
    } else if lowercase.contains("permission denied") || lowercase.contains("access is denied") {
        Some(DataExportError::PermissionDenied)
    } else if message.starts_with("Out of Memory Error:") {
        Some(DataExportError::ResourceExhausted)
    } else if (conversion_is_request && message.starts_with("Conversion Error:"))
        || message.starts_with("Binder Error:")
        || message.starts_with("Invalid type Error:")
        || message.starts_with("Not implemented Error:")
    {
        Some(DataExportError::InvalidRequest)
    } else {
        None
    }
}

fn classify_dataset_export_query_error(
    dataset: &DatasetQuerySource,
    error: DuckDbError,
) -> DataExportError {
    dataset_export_error(dataset.classify_query_failure(error, false))
}

fn dataset_export_error(error: DatasetError) -> DataExportError {
    match error {
        DatasetError::NotFound => DataExportError::NotFound,
        DatasetError::PermissionDenied | DatasetError::MemberPermissionDenied { .. } => {
            DataExportError::PermissionDenied
        }
        DatasetError::SourceChanged { .. } => DataExportError::SourceChanged,
        DatasetError::InvalidMember { .. } => DataExportError::CorruptSource,
        DatasetError::Cancelled => DataExportError::Cancelled,
        DatasetError::Window { error } => match error {
            crate::DataWindowError::NotFound => DataExportError::NotFound,
            crate::DataWindowError::PermissionDenied => DataExportError::PermissionDenied,
            crate::DataWindowError::SourceChanged => DataExportError::SourceChanged,
            crate::DataWindowError::NotParquet | crate::DataWindowError::CorruptSource => {
                DataExportError::CorruptSource
            }
            crate::DataWindowError::InvalidFilter | crate::DataWindowError::InvalidSort => {
                DataExportError::InvalidRequest
            }
            crate::DataWindowError::Cancelled => DataExportError::Cancelled,
            crate::DataWindowError::ResourceExhausted => DataExportError::ResourceExhausted,
            crate::DataWindowError::QueryEngineUnavailable => {
                DataExportError::QueryEngineUnavailable
            }
            crate::DataWindowError::Unsupported
            | crate::DataWindowError::WindowTooLarge
            | crate::DataWindowError::EncodingFailed => DataExportError::Unsupported,
            crate::DataWindowError::QueryFailed => DataExportError::QueryFailed,
        },
        DatasetError::NoParquetFiles
        | DatasetError::PageTooLarge
        | DatasetError::InspectionStepTooLarge
        | DatasetError::SchemaConflict { .. }
        | DatasetError::DuplicatePartitionKey { .. }
        | DatasetError::Unsupported => DataExportError::Unsupported,
    }
}

fn classify_io_error(error: io::Error) -> DataExportError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => DataExportError::PermissionDenied,
        io::ErrorKind::StorageFull => DataExportError::DiskFull,
        _ => DataExportError::QueryFailed,
    }
}

impl From<SourceError> for DataExportError {
    fn from(error: SourceError) -> Self {
        match error {
            SourceError::NotFound => Self::NotFound,
            SourceError::PermissionDenied => Self::PermissionDenied,
            SourceError::SourceChanged => Self::SourceChanged,
            SourceError::NotParquet => Self::NotParquet,
            SourceError::CorruptFooter => Self::CorruptSource,
            SourceError::Unsupported => Self::Unsupported,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };

    use arrow_array::{
        Array, ArrayRef, BinaryArray, Decimal128Array, Float64Array, Int64Array, ListArray,
        RecordBatch, StringArray, StructArray, TimestampNanosecondArray,
        builder::{Int64Builder, MapBuilder, NullBufferBuilder, StringBuilder},
        types::Int64Type,
    };
    use arrow_schema::{DataType, Field, Fields, Schema, TimeUnit};
    use parquet::arrow::ArrowWriter;
    use tempfile::{NamedTempFile, tempdir};

    use super::*;
    use crate::{
        filter::{DataFilter, DataFilterOperator},
        view::{DataSort, DataSortDirection, DataViewBuilder},
    };

    #[test]
    fn exports_filtered_selected_rows_visible_columns_and_utc_timestamps_as_csv() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("selection.csv");
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[DataFilter {
                field_path: field("id"),
                json_target: None,
                operator: DataFilterOperator::Range,
                values: vec!["2".to_owned(), "3".to_owned()],
                match_case: false,
            }],
            &[],
        )
        .expect("view builder")
        .build()
        .expect("prepared view")
        .export_snapshot();
        let reader = DataExportReader::new(
            source.path().to_owned(),
            target.clone(),
            DataExportRequest {
                field_paths: ["text", "id", "recorded_at", "recorded_at_utc", "optional"]
                    .map(field)
                    .to_vec(),
                row_ranges: vec![ExportRowRange { start: 0, end: 2 }],
                output: DataExportFormat::Csv {
                    options: CsvExportOptions::default(),
                },
            },
            Some(view),
        )
        .expect("export reader");

        reader.export().expect("CSV export");

        assert_eq!(
            fs::read_to_string(target).expect("exported CSV"),
            concat!(
                "text,id,recorded_at,recorded_at_utc,optional\r\n",
                "\"second\nline\",2,2026-04-01T06:07:08.123456790,",
                "2026-04-01T06:07:08.123456Z,value\r\n",
                "plain,3,2026-04-01T06:07:08.123456791,",
                "2026-04-01T06:07:08.123456Z,\r\n",
            )
        );
    }

    #[test]
    fn exports_nested_values_with_the_grid_canonical_json_shape() {
        let source = write_nested_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("nested.csv");
        let reader = DataExportReader::new(
            source.path().to_owned(),
            target.clone(),
            DataExportRequest {
                field_paths: vec![
                    FieldPath::from("profile"),
                    FieldPath::from("tags"),
                    FieldPath::from("attributes"),
                    FieldPath::new(["profile", "weird.name"]),
                ],
                row_ranges: Vec::new(),
                output: DataExportFormat::Csv {
                    options: CsvExportOptions::default(),
                },
            },
            None,
        )
        .expect("nested export reader");

        reader.export().expect("nested CSV export");

        let profile = include_str!("../../test-fixtures/canonical-nested-profile.json").trim_end();
        let quoted_profile = format!("\"{}\"", profile.replace('"', "\"\""));
        assert_eq!(
            fs::read_to_string(target).expect("nested CSV"),
            format!(
                concat!(
                    "profile,tags,attributes,\"profile.\"\"weird.name\"\"\"\r\n",
                    "{},\"[1,2]\",\"[[\"\"a\"\",1],[\"\"b\"\",2]]\",Ada\r\n",
                    "null,null,null,\r\n",
                ),
                quoted_profile
            )
        );
    }

    #[test]
    fn current_view_query_is_a_flat_streaming_copy_source() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[DataFilter {
                field_path: field("id"),
                json_target: None,
                operator: DataFilterOperator::Equals,
                values: vec!["1".to_owned()],
                match_case: false,
            }],
            &[],
        )
        .expect("view builder")
        .build()
        .expect("prepared view")
        .export_snapshot();
        let reader = DataExportReader::new(
            source.path().to_owned(),
            output_directory.path().join("view.csv"),
            request(vec![0, 1]),
            Some(view),
        )
        .expect("export reader");
        let (query, _) = build_export_query(&reader.schema, &reader.request, reader.view.as_ref())
            .expect("export query");

        assert!(query.starts_with("SELECT \"id\", \"text\" FROM read_parquet"));
        assert!(query.contains(" WHERE \"id\" = cast_to_type(?, \"id\")"));
        assert!(!query.contains("row_number()"));
        assert!(!query.contains("ORDER BY"));
        assert!(!query.contains("WITH "));
    }

    #[test]
    fn exports_rows_in_the_prepared_sort_order() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("sorted-view.csv");
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[DataFilter {
                field_path: field("id"),
                json_target: None,
                operator: DataFilterOperator::GreaterThanOrEqual,
                values: vec!["2".to_owned()],
                match_case: false,
            }],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Descending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view")
        .export_snapshot();
        let reader = DataExportReader::new(
            source.path().to_owned(),
            target.clone(),
            request(vec![0, 1]),
            Some(view),
        )
        .expect("export reader");
        let (query, _) = build_export_query(&reader.schema, &reader.request, reader.view.as_ref())
            .expect("export query");

        assert!(query.contains("__viewda_position_index_path"));
        assert!(!query.contains("row_number()"));
        reader.export().expect("sorted CSV export");

        assert_eq!(
            fs::read_to_string(target).expect("exported CSV"),
            "id,text\r\n3,plain\r\n2,\"second\nline\"\r\n"
        );
    }

    #[test]
    fn streams_a_large_current_view_without_window_materialization() {
        let (source_directory, source_path) = write_large_parquet(300_000);
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("large-view.csv");
        let reader = DataExportReader::new(source_path, target.clone(), request(vec![0]), None)
            .expect("export reader");

        reader.export().expect("large CSV export");

        let bytes = fs::read(&target).expect("exported CSV");
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 300_001);
        drop(source_directory);
    }

    #[test]
    fn uses_rfc_4180_escaping_for_quotes_commas_and_newlines() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("view.csv");
        let reader = DataExportReader::new(
            source.path().to_owned(),
            target.clone(),
            request(vec![1]),
            None,
        )
        .expect("export reader");

        reader.export().expect("CSV export");

        assert_eq!(
            fs::read_to_string(target).expect("exported CSV"),
            concat!(
                "text\r\n",
                "\"comma, and \"\"quote\"\"\"\r\n",
                "\"second\nline\"\r\n",
                "plain\r\n",
            )
        );
    }

    #[test]
    fn cancellation_after_setup_preserves_the_target_and_skips_copy() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("view.csv");
        fs::write(&target, "existing").expect("existing target");
        let reader = DataExportReader::new(
            source.path().to_owned(),
            target.clone(),
            request(vec![0]),
            None,
        )
        .expect("export reader");
        let progress = reader.progress();
        let cancellation = reader.cancellation();

        assert_eq!(
            reader.export_checked(|| cancellation.cancel()),
            Err(DataExportError::Cancelled)
        );
        assert_eq!(
            fs::read_to_string(target).expect("existing target"),
            "existing"
        );
        assert_eq!(progress.bytes_written(), 0);
        assert_eq!(
            fs::read_dir(output_directory.path())
                .expect("output directory")
                .count(),
            1
        );
    }

    #[test]
    fn interrupt_mid_scan_removes_the_temporary_file() {
        let (_source_directory, source_path) = write_large_parquet(8_000_000);
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("cancelled.csv");
        let reader = DataExportReader::new(source_path, target.clone(), request(vec![0]), None)
            .expect("export reader");
        let progress = reader.progress();
        let cancellation = reader.cancellation();
        let export = thread::spawn(move || reader.export());
        let deadline = Instant::now() + Duration::from_secs(10);

        while progress.bytes_written() == 0 && !export.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(progress.bytes_written() > 0, "COPY never started streaming");
        assert!(
            !export.is_finished(),
            "export finished before it could be interrupted"
        );
        cancellation.cancel();

        assert_eq!(
            export.join().expect("export thread"),
            Err(DataExportError::Cancelled)
        );
        assert!(!target.exists());
        assert_eq!(
            fs::read_dir(output_directory.path())
                .expect("output directory")
                .count(),
            0
        );
    }

    #[test]
    fn atomically_replaces_an_existing_destination() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("view.csv");
        fs::write(&target, "old contents").expect("existing target");
        let reader = DataExportReader::new(
            source.path().to_owned(),
            target.clone(),
            request(vec![0]),
            None,
        )
        .expect("export reader");

        reader.export().expect("CSV export");

        assert_eq!(
            fs::read_to_string(&target).expect("exported CSV"),
            "id\r\n1\r\n2\r\n3\r\n"
        );
        assert_eq!(
            fs::read_dir(output_directory.path())
                .expect("output directory")
                .count(),
            1
        );
    }

    #[test]
    fn refuses_to_replace_the_open_parquet_source() {
        let source = write_export_parquet();
        let before = fs::read(source.path()).expect("source bytes");

        assert!(matches!(
            DataExportReader::new(
                source.path().to_owned(),
                source.path().to_owned(),
                request(vec![0]),
                None,
            ),
            Err(DataExportError::InvalidRequest)
        ));
        assert_eq!(fs::read(source.path()).expect("source bytes"), before);
    }

    #[test]
    fn rejects_a_prepared_view_from_another_source() {
        let source = write_export_parquet();
        let other_source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let view = DataViewBuilder::new(
            other_source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view")
        .export_snapshot();

        assert!(matches!(
            DataExportReader::new(
                source.path().to_owned(),
                output_directory.path().join("view.csv"),
                request(vec![0]),
                Some(view),
            ),
            Err(DataExportError::InvalidRequest)
        ));
    }

    #[test]
    fn limits_memory_and_provides_a_spill_directory() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let reader = DataExportReader::new(
            source.path().to_owned(),
            output_directory.path().join("view.csv"),
            request(vec![0]),
            None,
        )
        .expect("export reader");
        let (memory_limit, temporary_directory, timezone): (String, String, String) = reader
            .connection
            .query_row(
                "SELECT current_setting('memory_limit'), \
                        current_setting('temp_directory'), current_setting('TimeZone')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("export resource settings");

        assert!(memory_limit.starts_with("366.2 MiB") || memory_limit.starts_with("384.0 MB"));
        assert_eq!(
            PathBuf::from(temporary_directory),
            reader._spill_directory.path()
        );
        assert_eq!(
            reader._work_directory.path().parent(),
            Some(output_directory.path())
        );
        assert_eq!(
            reader.temporary_path.parent(),
            Some(reader._work_directory.path())
        );
        assert_eq!(
            reader._spill_directory.path().parent(),
            Some(reader._work_directory.path())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(reader._work_directory.path())
                    .expect("work directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert_eq!(timezone, "UTC");
    }

    #[test]
    fn empty_prepared_dataset_position_page_is_empty() {
        let dataset_directory = tempdir().expect("dataset directory");
        let member = dataset_directory.path().join("part.parquet");
        let source_file = write_export_parquet();
        fs::copy(source_file.path(), &member).expect("dataset member");
        let source =
            crate::DatasetSource::open_folder(dataset_directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("dataset inspection");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let view = DataViewBuilder::for_dataset(
            &reader,
            &[DataFilter {
                field_path: field("id"),
                json_target: None,
                operator: DataFilterOperator::Equals,
                values: vec!["999".to_owned()],
                match_case: false,
            }],
            &[],
            crate::DataViewMemoryLimit::Mb384,
        )
        .expect("empty dataset view builder")
        .build()
        .expect("empty dataset view")
        .export_snapshot();
        assert!(
            read_dataset_positions(&view.position_index, &view.position_metadata, 0, 1)
                .expect("empty position page")
                .is_empty()
        );
    }

    #[test]
    fn direct_dataset_export_checks_each_read_member_once_before_and_after_copy() {
        let dataset_directory = tempdir().expect("dataset directory");
        let source_file = write_export_parquet();
        for name in ["a.parquet", "b.parquet"] {
            fs::copy(source_file.path(), dataset_directory.path().join(name))
                .expect("dataset member");
        }
        let source =
            crate::DatasetSource::open_folder(dataset_directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(2).expect("dataset inspection");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let identity_checks = source.identity_check_count();
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("dataset.csv");
        let export = DataExportReader::for_dataset(&reader, target.clone(), request(vec![0]), None)
            .expect("dataset export reader");
        assert_eq!(source.identity_check_count(), identity_checks);
        let (threads, preserve_insertion_order): (i64, bool) = export
            .connection
            .query_row(
                "SELECT current_setting('threads'), current_setting('preserve_insertion_order')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("dataset export ordering settings");
        assert_eq!(threads, 1);
        assert!(preserve_insertion_order);

        export.export().expect("dataset export");

        assert_eq!(
            source.identity_check_count() - identity_checks,
            4,
            "the two-member batch is checked before and after COPY"
        );
        assert_eq!(
            fs::read_to_string(target).expect("dataset CSV"),
            "id\r\n1\r\n2\r\n3\r\n1\r\n2\r\n3\r\n"
        );
    }

    #[test]
    fn prepared_dataset_export_ignores_an_unrelated_pruned_member_until_it_is_touched() {
        let dataset_directory = tempdir().expect("dataset directory");
        let source_file = write_export_parquet();
        for (year, name) in [("2025", "kept.parquet"), ("2026", "pruned.parquet")] {
            let partition = dataset_directory.path().join(format!("year={year}"));
            fs::create_dir_all(&partition).expect("partition directory");
            fs::copy(source_file.path(), partition.join(name)).expect("dataset member");
        }
        let source =
            crate::DatasetSource::open_folder(dataset_directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(2).expect("dataset inspection");
        let mut reader = inspector.into_window_reader().expect("dataset reader");
        let filter = DataFilter {
            field_path: field("year"),
            json_target: None,
            operator: DataFilterOperator::Equals,
            values: vec!["2025".to_owned()],
            match_case: false,
        };
        let view = DataViewBuilder::for_dataset(
            &reader,
            std::slice::from_ref(&filter),
            &[],
            crate::DataViewMemoryLimit::Mb384,
        )
        .expect("prepared view builder")
        .build()
        .expect("prepared view");
        fs::remove_file(dataset_directory.path().join("year=2026/pruned.parquet"))
            .expect("remove pruned member");
        let output_directory = tempdir().expect("output directory");
        let target = output_directory.path().join("prepared.csv");

        DataExportReader::for_dataset(
            &reader,
            target.clone(),
            request(vec![0]),
            Some(view.export_snapshot()),
        )
        .expect("prepared dataset export reader")
        .export()
        .expect("prepared dataset export");

        assert_eq!(
            fs::read_to_string(target).expect("prepared CSV"),
            "id\r\n1\r\n2\r\n3\r\n"
        );
        assert_eq!(reader.latched_source_change(), Ok(()));
        assert_eq!(
            reader.fetch(0, 8),
            Err(DatasetError::SourceChanged {
                member: "year=2026/pruned.parquet".to_owned(),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn dataset_export_permission_failure_latches_the_exact_bound_member() {
        use std::os::unix::fs::PermissionsExt as _;

        let dataset_directory = tempdir().expect("dataset directory");
        let member = dataset_directory.path().join("part.parquet");
        let source_file = write_export_parquet();
        fs::copy(source_file.path(), &member).expect("dataset member");
        let source =
            crate::DatasetSource::open_folder(dataset_directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("dataset inspection");
        let reader = inspector.into_window_reader().expect("dataset reader");
        let output_directory = tempdir().expect("output directory");
        let export = DataExportReader::for_dataset(
            &reader,
            output_directory.path().join("dataset.csv"),
            request(vec![0]),
            None,
        )
        .expect("dataset export reader");
        fs::set_permissions(&member, fs::Permissions::from_mode(0o000))
            .expect("remove member access");

        let result = export.export();
        fs::set_permissions(&member, fs::Permissions::from_mode(0o600))
            .expect("restore member access");

        assert_eq!(result, Err(DataExportError::PermissionDenied));
        assert_eq!(
            reader.latched_source_change(),
            Err(DatasetError::MemberPermissionDenied {
                member: "part.parquet".to_owned(),
            })
        );
    }

    #[test]
    fn classifies_resource_and_filesystem_failures_honestly() {
        assert_eq!(
            classify_query_error(DuckDbError::DuckDBFailure(
                duckdb::ffi::Error {
                    code: duckdb::ffi::ErrorCode::OutOfMemory,
                    extended_code: 1,
                },
                Some("Out of Memory Error: allocation failed".to_owned()),
            )),
            DataExportError::ResourceExhausted
        );
        assert_eq!(
            classify_io_error(io::Error::new(io::ErrorKind::StorageFull, "full")),
            DataExportError::DiskFull
        );
        assert_eq!(
            classify_io_error(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
            DataExportError::PermissionDenied
        );
    }

    #[test]
    fn normalizes_union_ranges_without_expanding_large_selections() {
        assert_eq!(
            normalize_ranges(&[
                ExportRowRange { start: 8, end: 10 },
                ExportRowRange { start: 1, end: 4 },
                ExportRowRange { start: 3, end: 8 },
            ]),
            Ok(vec![ExportRowRange { start: 1, end: 10 }])
        );
    }

    fn request(column_indices: Vec<u32>) -> DataExportRequest {
        let names = ["id", "text", "recorded_at", "recorded_at_utc", "optional"];
        DataExportRequest {
            field_paths: column_indices
                .into_iter()
                .map(|index| field(names[index as usize]))
                .collect(),
            row_ranges: Vec::new(),
            output: DataExportFormat::Csv {
                options: CsvExportOptions::default(),
            },
        }
    }

    fn field(name: &str) -> FieldPath {
        FieldPath::new(vec![name.to_owned()])
    }

    fn write_export_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary source");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("text", DataType::Utf8, false),
            Field::new(
                "recorded_at",
                DataType::Timestamp(TimeUnit::Nanosecond, None),
                false,
            ),
            Field::new(
                "recorded_at_utc",
                DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
                false,
            ),
            Field::new("optional", DataType::Utf8, true),
        ]));
        let base = 1_775_023_628_123_456_789_i64;
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3])) as ArrayRef,
                Arc::new(StringArray::from(vec![
                    "comma, and \"quote\"",
                    "second\nline",
                    "plain",
                ])) as ArrayRef,
                Arc::new(TimestampNanosecondArray::from(vec![
                    base,
                    base + 1,
                    base + 2,
                ])) as ArrayRef,
                Arc::new(
                    TimestampNanosecondArray::from(vec![base, base + 1, base + 2])
                        .with_timezone("UTC"),
                ) as ArrayRef,
                Arc::new(StringArray::from(vec![None, Some("value"), None])) as ArrayRef,
            ],
        )
        .expect("record batch");
        let file = File::create(source.path()).expect("Parquet file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("write batch");
        writer.close().expect("write footer");
        source
    }

    fn write_nested_export_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary nested source");
        let mut labels = MapBuilder::new(None, StringBuilder::new(), StringBuilder::new());
        for value in ["English", "French"] {
            labels.keys().append_value("language");
            labels.values().append_value(value);
        }
        labels.append(true).expect("duplicate-key map");
        labels.keys().append_value("masked");
        labels.values().append_value("value");
        labels.append(true).expect("masked map");
        let labels = labels.finish();
        let profile_fields = Fields::from(vec![
            Field::new("weird.name", DataType::Utf8, false),
            Field::new("age", DataType::Int64, false),
            Field::new("scale_zero", DataType::Decimal128(10, 0), false),
            Field::new("trailing_zero", DataType::Decimal128(10, 2), false),
            Field::new("unsafe_decimal", DataType::Decimal128(38, 0), false),
            Field::new("small_decimal", DataType::Decimal128(38, 20), false),
            Field::new("finite_one", DataType::Float64, false),
            Field::new("negative_zero", DataType::Float64, false),
            Field::new("large_finite", DataType::Float64, false),
            Field::new("fractional_exponent", DataType::Float64, false),
            Field::new("positive_exponent", DataType::Float64, false),
            Field::new("negative_exponent", DataType::Float64, false),
            Field::new("rounding_sensitive_integral", DataType::Float64, false),
            Field::new("nan", DataType::Float64, false),
            Field::new("positive_infinity", DataType::Float64, false),
            Field::new("negative_infinity", DataType::Float64, false),
            Field::new("nullable_float", DataType::Float64, true),
            Field::new("unsafe", DataType::Int64, false),
            Field::new("payload", DataType::Binary, false),
            Field::new("labels", labels.data_type().clone(), false),
            Field::new(
                "recorded_at",
                DataType::Timestamp(TimeUnit::Nanosecond, None),
                false,
            ),
        ]);
        let mut profile_validity = NullBufferBuilder::new(2);
        profile_validity.append(true);
        profile_validity.append(false);
        let profile = StructArray::new(
            profile_fields.clone(),
            vec![
                Arc::new(StringArray::from(vec!["Ada", "masked"])) as ArrayRef,
                Arc::new(Int64Array::from(vec![37, 99])) as ArrayRef,
                Arc::new(
                    Decimal128Array::from(vec![37, 0])
                        .with_precision_and_scale(10, 0)
                        .expect("scale-zero decimal"),
                ) as ArrayRef,
                Arc::new(
                    Decimal128Array::from(vec![120, 0])
                        .with_precision_and_scale(10, 2)
                        .expect("trailing-zero decimal"),
                ) as ArrayRef,
                Arc::new(
                    Decimal128Array::from(vec![9_007_199_254_740_993, 0])
                        .with_precision_and_scale(38, 0)
                        .expect("unsafe decimal"),
                ) as ArrayRef,
                Arc::new(
                    Decimal128Array::from(vec![1, 0])
                        .with_precision_and_scale(38, 20)
                        .expect("small decimal"),
                ) as ArrayRef,
                Arc::new(Float64Array::from(vec![1.0, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![-0.0, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![1e20, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![1.25e-7, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![1e21, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![-1e21, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![1_000_000_000_000_000_100_f64, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![f64::NAN, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![f64::INFINITY, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![f64::NEG_INFINITY, 0.0])) as ArrayRef,
                Arc::new(Float64Array::from(vec![None, Some(0.0)])) as ArrayRef,
                Arc::new(Int64Array::from(vec![9_007_199_254_740_993, 0])) as ArrayRef,
                Arc::new(BinaryArray::from_iter_values([
                    [1_u8, 2, 3].as_slice(),
                    [4_u8].as_slice(),
                ])) as ArrayRef,
                Arc::new(labels) as ArrayRef,
                Arc::new(TimestampNanosecondArray::from(vec![
                    9_007_199_254_740_993,
                    0,
                ])) as ArrayRef,
            ],
            profile_validity.finish(),
        );
        let tags = ListArray::from_iter_primitive::<Int64Type, _, _>(vec![
            Some(vec![Some(1), Some(2)]),
            None,
        ]);
        let mut attributes = MapBuilder::new(None, StringBuilder::new(), Int64Builder::new());
        for (key, value) in [("a", 1), ("b", 2)] {
            attributes.keys().append_value(key);
            attributes.values().append_value(value);
        }
        attributes.append(true).expect("two-pair map");
        attributes.append(false).expect("null map");
        let attributes = attributes.finish();
        let schema = Arc::new(Schema::new(vec![
            Field::new("profile", DataType::Struct(profile_fields), true),
            Field::new("tags", tags.data_type().clone(), true),
            Field::new("attributes", attributes.data_type().clone(), true),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(profile) as ArrayRef,
                Arc::new(tags) as ArrayRef,
                Arc::new(attributes) as ArrayRef,
            ],
        )
        .expect("nested export batch");
        let file = File::create(source.path()).expect("nested Parquet file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("nested Parquet writer");
        writer.write(&batch).expect("write nested batch");
        writer.close().expect("write nested footer");
        source
    }

    fn write_large_parquet(row_count: u64) -> (TempDir, PathBuf) {
        let directory = tempdir().expect("source directory");
        let path = directory.path().join("large.parquet");
        let path_text = path.to_str().expect("UTF-8 source path");
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        connection
            .execute("SET VARIABLE __test_path = ?", params![path_text])
            .expect("set output path");
        connection
            .execute(
                "COPY (SELECT range AS id FROM range(?)) \
                 TO (getvariable('__test_path')) (FORMAT PARQUET)",
                params![row_count as i64],
            )
            .expect("large Parquet fixture");
        (directory, path)
    }
}
