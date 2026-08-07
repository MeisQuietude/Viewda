//! Cancellable, bounded-memory file export through the query engine.

use std::{
    collections::HashSet,
    fs, io,
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
    filter::{DataFilter, FilterPredicate, build_filter_predicate_with_names},
    source::{SchemaField, SourceError, inspect_local_source},
    view::PreparedDataViewExport,
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
    /// Source columns in visible grid order.
    pub column_indices: Vec<u32>,
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
    source_path: PathBuf,
    target_path: PathBuf,
    temporary_path: TempPath,
    connection: Connection,
    _spill_directory: TempDir,
    request: DataExportRequest,
    view: Option<PreparedDataViewExport>,
    schema: Vec<SchemaField>,
    cancelled: Arc<AtomicBool>,
    final_bytes: Arc<AtomicU64>,
}

impl DataExportReader {
    /// Prepares an export that cannot block the grid connection.
    pub fn new(
        source_path: PathBuf,
        target_path: PathBuf,
        mut request: DataExportRequest,
        view: Option<PreparedDataViewExport>,
    ) -> Result<Self, DataExportError> {
        let summary = inspect_local_source(&source_path).map_err(DataExportError::from)?;
        if paths_match(&source_path, &target_path) {
            return Err(DataExportError::InvalidRequest);
        }
        if view
            .as_ref()
            .is_some_and(|view| view.source_path != source_path)
        {
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

        let target_directory = target_path.parent().ok_or(DataExportError::Unsupported)?;
        let temporary_file = tempfile::Builder::new()
            .prefix(".viewda-export-")
            .suffix(".tmp")
            .tempfile_in(target_directory)
            .map_err(classify_io_error)?;
        let temporary_path = temporary_file.into_temp_path();
        fs::remove_file(&temporary_path).map_err(classify_io_error)?;

        let spill_directory = tempfile::Builder::new()
            .prefix("viewda-export-spill-")
            .tempdir()
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;
        let spill_directory_path = spill_directory
            .path()
            .to_str()
            .ok_or(DataExportError::QueryEngineUnavailable)?;
        let config = Config::default()
            .enable_object_cache(true)
            .and_then(|config| config.max_memory(QUERY_MEMORY_LIMIT))
            .and_then(|config| config.with("temp_directory", spill_directory_path))
            .and_then(|config| config.with("preserve_insertion_order", "true"))
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;
        connection
            .execute_batch("SET TimeZone = 'UTC'")
            .map_err(|_| DataExportError::QueryEngineUnavailable)?;

        Ok(Self {
            source_path,
            target_path,
            temporary_path,
            connection,
            _spill_directory: spill_directory,
            request,
            view,
            schema: summary.schema,
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
        self.require_active()?;
        let source_path = self
            .source_path
            .to_str()
            .ok_or(DataExportError::Unsupported)?;
        let temporary_path = self
            .temporary_path
            .to_str()
            .ok_or(DataExportError::Unsupported)?;
        self.connection
            .execute(
                "SET VARIABLE __viewda_source_path = ?",
                params![source_path],
            )
            .map_err(classify_query_error)?;
        self.connection
            .execute(
                "SET VARIABLE __viewda_export_path = ?",
                params![temporary_path],
            )
            .map_err(classify_query_error)?;
        if let Some(view) = self.view.as_ref().filter(|view| view.sorted) {
            let position_index = view
                .position_index
                .to_str()
                .ok_or(DataExportError::Unsupported)?;
            self.connection
                .execute(
                    "SET VARIABLE __viewda_position_index_path = ?",
                    params![position_index],
                )
                .map_err(classify_query_error)?;
        }
        let (query, parameters) =
            build_export_query(&self.schema, &self.request, self.view.as_ref())?;
        let copy = match &self.request.output {
            DataExportFormat::Csv { .. } => format!(
                "COPY ({query}) TO (getvariable('__viewda_export_path')) \
                 (FORMAT CSV, HEADER true, DELIMITER ',', \
                 QUOTE '\"', ESCAPE '\"', NULLSTR '', NEW_LINE E'\\r\\n', \
                 DATEFORMAT '%Y-%m-%d', TIMESTAMPFORMAT '%Y-%m-%dT%H:%M:%S.%n')"
            ),
        };
        let result = self
            .connection
            .execute(&copy, params_from_iter(parameters.iter()));
        if self.cancelled.load(Ordering::Acquire) {
            return Err(DataExportError::Cancelled);
        }
        result.map_err(classify_query_error)?;
        self.require_active()?;

        let bytes = fs::metadata(&self.temporary_path)
            .map_err(classify_io_error)?
            .len();
        self.final_bytes.store(bytes, Ordering::Release);
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
    if request.column_indices.is_empty() {
        return Err(DataExportError::InvalidRequest);
    }
    let mut columns = HashSet::new();
    for index in &request.column_indices {
        let index = usize::try_from(*index).map_err(|_| DataExportError::InvalidRequest)?;
        if index >= schema.len() || !columns.insert(index) {
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
        .column_indices
        .iter()
        .map(|index| {
            schema
                .get(*index as usize)
                .map(export_column_expression)
                .ok_or(DataExportError::InvalidRequest)
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
    let raw_columns = request
        .column_indices
        .iter()
        .map(|index| {
            schema
                .get(*index as usize)
                .map(|field| quote_identifier(&field.name))
                .ok_or(DataExportError::InvalidRequest)
        })
        .collect::<Result<Vec<_>, _>>()?
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
        .column_indices
        .iter()
        .map(|index| {
            let index = usize::try_from(*index).map_err(|_| DataExportError::InvalidRequest)?;
            let field = schema.get(index).ok_or(DataExportError::InvalidRequest)?;
            let source_column = source_columns
                .get(index)
                .ok_or(DataExportError::InvalidRequest)?;
            Ok(export_column_expression_from(
                field,
                &format!("{source}.{}", quote_identifier(source_column)),
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

fn export_column_expression(field: &SchemaField) -> String {
    let identifier = quote_identifier(&field.name);
    export_column_expression_from(field, &identifier)
}

fn export_column_expression_from(field: &SchemaField, value: &str) -> String {
    let identifier = quote_identifier(&field.name);
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
        identifier
    } else {
        format!("{value} AS {identifier}")
    }
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
    let message = match error {
        DuckDbError::DuckDBFailure(_, Some(message)) => message,
        _ => return DataExportError::QueryFailed,
    };
    let lowercase = message.to_lowercase();
    if lowercase.contains("no space left")
        || lowercase.contains("not enough space")
        || lowercase.contains("disk full")
    {
        DataExportError::DiskFull
    } else if lowercase.contains("permission denied") || lowercase.contains("access is denied") {
        DataExportError::PermissionDenied
    } else if message.starts_with("Out of Memory Error:") {
        DataExportError::ResourceExhausted
    } else if message.starts_with("Conversion Error:")
        || message.starts_with("Binder Error:")
        || message.starts_with("Invalid type Error:")
        || message.starts_with("Not implemented Error:")
    {
        DataExportError::InvalidRequest
    } else {
        DataExportError::QueryFailed
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

    use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray, TimestampNanosecondArray};
    use arrow_schema::{DataType, Field, Schema, TimeUnit};
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
                column_index: 0,
                operator: DataFilterOperator::Range,
                values: vec!["2".to_owned(), "3".to_owned()],
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
                column_indices: vec![1, 0, 2, 3, 4],
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
    fn current_view_query_is_a_flat_streaming_copy_source() {
        let source = write_export_parquet();
        let output_directory = tempdir().expect("output directory");
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[DataFilter {
                column_index: 0,
                operator: DataFilterOperator::Equals,
                values: vec!["1".to_owned()],
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
                column_index: 0,
                operator: DataFilterOperator::GreaterThanOrEqual,
                values: vec!["2".to_owned()],
            }],
            &[DataSort {
                source_index: 0,
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
    fn cancellation_preserves_an_existing_target_and_removes_the_temporary_file() {
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

        cancellation.cancel();

        assert_eq!(reader.export(), Err(DataExportError::Cancelled));
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
                source_index: 0,
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
        assert_eq!(timezone, "UTC");
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
        DataExportRequest {
            column_indices,
            row_ranges: Vec::new(),
            output: DataExportFormat::Csv {
                options: CsvExportOptions::default(),
            },
        }
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
