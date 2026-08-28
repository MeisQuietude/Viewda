//! Reusable filtered and sorted views backed by compact source-row positions.

use std::{
    fs::File,
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use arrow_array::{Int64Array, RecordBatch, UInt32Array, UInt64Array};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{Schema, SchemaRef};
use arrow_select::{concat::concat_batches, take::take};
use duckdb::{Config, Connection, Error as DuckDbError, InterruptHandle, params_from_iter};
use parquet::{
    arrow::{
        ProjectionMask,
        arrow_reader::{
            ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder, RowSelection,
        },
    },
    file::metadata::PageIndexPolicy,
};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;

use crate::{
    FieldPath, JsonFieldTarget,
    dataset::{
        DatasetError, DatasetQuerySource, DatasetRowPosition, DatasetSessionToken,
        DatasetSetupError, DatasetSparseRows, DatasetWindowReader, redact_path_aliases,
        validate_produced_arrow_schema,
    },
    field_path::{
        field_path_expression, project_arrow_field_paths, resolve_field_path, validate_field_paths,
    },
    filter::{DataFilter, FilterPredicate, build_filter_predicate_with_names, quote_identifier},
    json_path::{JsonFieldExpression, field_is_json, json_field_expression},
    source::{inspect_local_source, inspect_local_source_for_query, open_local_source},
    window::{DataWindowError, MAX_WINDOW_ROWS, classify_query_error, set_utc_session_timezone},
};

#[cfg(test)]
use std::sync::atomic::AtomicUsize;

// Prepared windows have a fixed budget independent of the one-time sort budget. Single-file
// sparse reads bypass DuckDB; dataset reads use it only to normalize at most MAX_WINDOW_ROWS
// staged rows to the union schema.
const WINDOW_MEMORY_LIMIT: &str = "384MB";
const POSITION_COLUMN: &str = "__viewda_position";
const SOURCE_POSITION_COLUMN: &str = "__viewda_source_position";
const REQUESTED_ORDER_COLUMN: &str = "__viewda_requested_order";
const MAX_SORT_COLUMNS: usize = 32;

#[cfg(test)]
static DATASET_POSITION_ROW_GROUP_READS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static DATASET_POSITION_DECODED_ROWS: AtomicUsize = AtomicUsize::new(0);

/// User-selected memory available to one view preparation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataViewMemoryLimit {
    /// Lowest supported budget and the default for new installations.
    #[default]
    Mb384,
    /// Twice the default budget for moderate sorts.
    Mb768,
    /// Four times the default budget for wider or less spillable sorts.
    Mb1536,
    /// Eight times the default budget for machines with spare RAM.
    Mb3072,
}

impl DataViewMemoryLimit {
    fn duckdb_value(self) -> &'static str {
        match self {
            Self::Mb384 => "384MB",
            Self::Mb768 => "768MB",
            Self::Mb1536 => "1536MB",
            Self::Mb3072 => "3072MB",
        }
    }

    fn maximum_worker_threads(self) -> usize {
        match self {
            Self::Mb384 => 1,
            Self::Mb768 => 2,
            Self::Mb1536 => 4,
            Self::Mb3072 => 8,
        }
    }

    fn worker_threads(self) -> usize {
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        self.maximum_worker_threads().min(available)
    }
}

/// One addressable field in the view's canonical sort order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSort {
    /// Field-name segments from the top-level column through struct fields.
    pub field_path: FieldPath,
    /// Optional extraction below a Parquet column explicitly annotated as JSON.
    #[serde(default)]
    pub json_target: Option<JsonFieldTarget>,
    /// Direction applied before the stable file-order tie-break.
    pub direction: DataSortDirection,
}

/// Direction for one source column in a prepared view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataSortDirection {
    Ascending,
    Descending,
}

/// Stage that exhausted a prepared view's bounded resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataViewResourceOperation {
    Preparation,
    Window,
}

/// One sanitized sort key included in a resource failure report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewSortDiagnostic {
    /// Parquet physical type without the source column name.
    pub physical_type: String,
    /// Optional Parquet logical type without values from the source.
    pub logical_type: Option<String>,
    /// Requested direction for this key.
    pub direction: DataSortDirection,
}

/// Path-free context for diagnosing a bounded view preparation failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewResourceDiagnostics {
    /// Stage that reported the resource failure.
    pub operation: DataViewResourceOperation,
    /// Version reported by the packaged DuckDB library.
    pub query_engine_version: String,
    /// Sanitized first paragraph of the DuckDB failure.
    pub message: String,
    /// Effective DuckDB memory limit for the builder connection.
    pub memory_limit: String,
    /// Effective DuckDB limit for files in the spill directory.
    pub max_temporary_directory_size: String,
    /// Effective DuckDB worker count for the builder connection.
    pub threads: i64,
    /// Rows recorded in the source footer.
    pub row_count: u64,
    /// Source file size without its name or path.
    pub source_size_bytes: u64,
    /// Row groups recorded in the source footer.
    pub row_group_count: usize,
    /// Number of top-level source columns.
    pub column_count: usize,
    /// Number of active filter conditions, without their values.
    pub filter_count: usize,
    /// Sort key types and directions, without column names.
    pub sort_columns: Vec<DataViewSortDiagnostic>,
}

/// Stable failures from preparing or reading a reusable data view.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DataViewError {
    /// A non-resource engine failure already covered by the window protocol.
    #[error(transparent)]
    Engine(#[from] DataWindowError),
    /// DuckDB could not stay within the active operation's memory budget.
    #[error("There is not enough memory for this data view operation.")]
    MemoryExhausted(Box<DataViewResourceDiagnostics>),
    /// DuckDB could not write more data to the active spill directory.
    #[error("There is not enough temporary storage for this data view operation.")]
    TemporaryStorageExhausted(Box<DataViewResourceDiagnostics>),
}

#[derive(Debug, Clone)]
struct DataViewResourceSettings {
    query_engine_version: String,
    memory_limit: String,
    max_temporary_directory_size: String,
    threads: i64,
}

#[derive(Debug, Clone, Copy)]
enum DataViewResourceFailure {
    Memory,
    TemporaryStorage,
}

impl DataViewResourceFailure {
    fn error(self, diagnostics: DataViewResourceDiagnostics) -> DataViewError {
        match self {
            Self::Memory => DataViewError::MemoryExhausted(Box::new(diagnostics)),
            Self::TemporaryStorage => {
                DataViewError::TemporaryStorageExhausted(Box::new(diagnostics))
            }
        }
    }
}

/// A thread-safe handle for interrupting one in-flight view preparation.
#[derive(Clone)]
pub struct DataViewInterruptHandle {
    inner: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

impl DataViewInterruptHandle {
    /// Interrupts the active preparation, or does nothing after its builder is dropped.
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.inner.interrupt();
    }

    /// Reports whether the caller interrupted this preparation.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Owns the isolated, spill-enabled DuckDB connection for one view preparation.
pub struct DataViewBuilder {
    source: DataViewSource,
    filters: Vec<DataFilter>,
    sort: Vec<DataSort>,
    connection: Connection,
    temporary_directory: TempDir,
    resource_settings: DataViewResourceSettings,
    cancelled: Arc<AtomicBool>,
}

enum DataViewSource {
    File(PathBuf),
    Dataset(Box<DatasetQuerySource>),
}

struct DataViewSourceFacts {
    schema: Vec<crate::source::SchemaField>,
    row_count: u64,
    size_bytes: u64,
    row_group_count: usize,
}

struct PreparedRelation {
    sql: String,
    position_projection: String,
    tie_break: String,
    parameters: Vec<duckdb::types::Value>,
}

impl DataViewSource {
    fn facts(&self) -> Result<DataViewSourceFacts, DataViewError> {
        match self {
            Self::File(path) => {
                let summary =
                    inspect_local_source_for_query(path).map_err(DataWindowError::from)?;
                Ok(DataViewSourceFacts {
                    schema: summary.schema,
                    row_count: summary.row_count,
                    size_bytes: summary.size_bytes,
                    row_group_count: summary.row_group_count,
                })
            }
            Self::Dataset(dataset) => Ok(DataViewSourceFacts {
                schema: dataset.schema().to_vec(),
                row_count: dataset.row_count(),
                size_bytes: dataset.size_bytes(),
                row_group_count: dataset.row_group_count().map_err(dataset_view_error)?,
            }),
        }
    }

    fn require_active_while(&self, keep_going: impl FnMut() -> bool) -> Result<(), DatasetError> {
        match self {
            Self::File(_) => Ok(()),
            Self::Dataset(dataset) => dataset.require_active_while(keep_going),
        }
    }

    fn file_metadata(&self) -> Result<Option<ArrowReaderMetadata>, DataViewError> {
        let Self::File(path) = self else {
            return Ok(None);
        };
        let (source_file, _) = open_local_source(path).map_err(DataWindowError::from)?;
        Ok(ArrowReaderMetadata::load(
            &source_file,
            ArrowReaderOptions::new().with_page_index_policy(PageIndexPolicy::Optional),
        )
        .ok())
    }

    fn sanitize_resource_message(&self, message: &str, temporary_path: &Path) -> String {
        match self {
            Self::File(path) => sanitize_resource_message(message, Some(path), temporary_path),
            Self::Dataset(dataset) => {
                let message =
                    redact_path_aliases(message, [temporary_path], "<temporary directory>");
                truncate_resource_message(&dataset.redact_paths(&message))
            }
        }
    }
}

impl DataViewBuilder {
    /// Creates a builder whose resource controls cannot affect direct grid windows.
    pub fn new(
        source_path: PathBuf,
        filters: &[DataFilter],
        sort: &[DataSort],
    ) -> Result<Self, DataViewError> {
        Self::with_memory_limit(source_path, filters, sort, DataViewMemoryLimit::default())
    }

    /// Creates a builder with an explicit preparation-only memory budget.
    pub fn with_memory_limit(
        source_path: PathBuf,
        filters: &[DataFilter],
        sort: &[DataSort],
        memory_limit: DataViewMemoryLimit,
    ) -> Result<Self, DataViewError> {
        Self::with_source(
            DataViewSource::File(source_path),
            filters,
            sort,
            memory_limit,
        )
    }

    /// Creates a builder over one completed fixed dataset relation.
    pub fn for_dataset(
        reader: &DatasetWindowReader,
        filters: &[DataFilter],
        sort: &[DataSort],
        memory_limit: DataViewMemoryLimit,
    ) -> Result<Self, DataViewError> {
        Self::for_dataset_while(reader, filters, sort, memory_limit, || true)
    }

    /// Creates a dataset builder while the owning source session remains active.
    pub fn for_dataset_while(
        reader: &DatasetWindowReader,
        filters: &[DataFilter],
        sort: &[DataSort],
        memory_limit: DataViewMemoryLimit,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DataViewError> {
        let source = reader
            .query_source_while(&mut keep_going)
            .map_err(dataset_view_error)?;
        let builder = Self::with_source(
            DataViewSource::Dataset(Box::new(source)),
            filters,
            sort,
            memory_limit,
        )?;
        if !keep_going() {
            builder.interrupt_handle().interrupt();
            return Err(DataWindowError::Cancelled.into());
        }
        Ok(builder)
    }

    fn with_source(
        source: DataViewSource,
        filters: &[DataFilter],
        sort: &[DataSort],
        memory_limit: DataViewMemoryLimit,
    ) -> Result<Self, DataViewError> {
        let is_dataset = matches!(source, DataViewSource::Dataset(_));
        let temporary_directory = create_temporary_directory("viewda-view-")?;
        let temporary_directory_path = temporary_directory
            .path()
            .to_str()
            .ok_or(DataWindowError::QueryEngineUnavailable)?;
        let config = Config::default()
            .enable_object_cache(!is_dataset)
            .and_then(|config| config.max_memory(memory_limit.duckdb_value()))
            .and_then(|config| config.with("temp_directory", temporary_directory_path))
            // External sort keeps thread-local state. Reserve roughly 384 MB of the selected
            // budget per worker so the minimum can spill instead of exhausting ten core-local
            // buffers before DuckDB can offload them.
            .and_then(|config| config.with("threads", memory_limit.worker_threads().to_string()))
            // The position index has an explicit ORDER BY with a source-row tie-break, so
            // DuckDB may relax insertion preservation to keep large external sorts spillable.
            .and_then(|config| config.with("preserve_insertion_order", "false"))
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        set_utc_session_timezone(&connection)?;
        connection
            .execute_batch(if is_dataset {
                "SET parquet_metadata_cache = false"
            } else {
                "SET parquet_metadata_cache = true"
            })
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let resource_settings = read_resource_settings(&connection)?;

        Ok(Self {
            source,
            filters: filters.to_vec(),
            sort: sort.to_vec(),
            connection,
            temporary_directory,
            resource_settings,
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Returns a handle that can interrupt this builder from another thread.
    pub fn interrupt_handle(&self) -> DataViewInterruptHandle {
        DataViewInterruptHandle {
            inner: self.connection.interrupt_handle(),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Builds one position index shared by counts and all subsequent windows.
    pub fn build(self) -> Result<PreparedDataView, DataViewError> {
        self.build_inner(
            #[cfg(test)]
            || {},
            || {},
        )
    }

    fn build_inner(
        self,
        #[cfg(test)] before_execute: impl FnOnce(),
        before_publish: impl FnOnce(),
    ) -> Result<PreparedDataView, DataViewError> {
        let facts = self.source.facts()?;
        self.require_active()?;
        validate_sort(&facts.schema, &self.sort)?;

        let source_columns = (0..facts.schema.len())
            .map(|index| format!("__viewda_column_{index}"))
            .collect::<Vec<_>>();
        let source_column_names = source_columns
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let source_position = quote_identifier(SOURCE_POSITION_COLUMN);
        let predicate =
            build_filter_predicate_with_names(&facts.schema, &self.filters, &source_column_names)
                .map_err(|_| DataWindowError::InvalidFilter)?;
        let relation_columns = source_column_names
            .iter()
            .copied()
            .map(quote_identifier)
            .collect::<Vec<_>>()
            .join(", ");
        let prepared_relation = self.prepare_relation(
            &facts,
            &source_column_names,
            &relation_columns,
            &source_position,
            &predicate,
        )?;
        let order = build_order_clause_with_names(
            &facts.schema,
            &source_column_names,
            &self.sort,
            &prepared_relation.tie_break,
        )?;
        let position_index = self.temporary_directory.path().join("positions.parquet");
        let index_path = position_index
            .to_str()
            .ok_or(DataWindowError::Unsupported)?;
        let where_clause = (!self.filters.is_empty()).then(|| format!(" WHERE {}", predicate.sql));
        let query = format!(
            "COPY (SELECT {positions} \
             FROM {relation}{where_clause} \
             ORDER BY {order}) TO {index_path} \
             (FORMAT PARQUET, COMPRESSION ZSTD, PRESERVE_ORDER true)",
            positions = prepared_relation.position_projection,
            relation = prepared_relation.sql,
            where_clause = where_clause.as_deref().unwrap_or(""),
            index_path = quote_string_literal(index_path),
        );
        let mut parameters = prepared_relation.parameters;
        parameters.extend(predicate.parameters);
        #[cfg(test)]
        before_execute();
        self.connection
            .execute(&query, params_from_iter(parameters.iter()))
            .map_err(|error| {
                self.classify_prepare_error(error, &facts, !self.filters.is_empty())
            })?;
        self.require_active()?;
        self.source
            .require_active_while(|| !self.cancelled.load(Ordering::Acquire))
            .map_err(dataset_view_error)?;
        self.require_active()?;

        let index_summary = inspect_local_source(&position_index).map_err(DataWindowError::from)?;
        let (position_file, _) =
            open_local_source(&position_index).map_err(DataWindowError::from)?;
        let position_metadata = ArrowReaderMetadata::load(&position_file, Default::default())
            .map_err(|_| DataWindowError::CorruptSource)?;
        if matches!(&self.source, DataViewSource::Dataset(_)) {
            self.connection
                .execute_batch("DROP TABLE __viewda_staged_dataset")
                .map_err(|error| self.classify_prepare_error(error, &facts, false))?;
        }
        let source_metadata = self.source.file_metadata()?;
        let window_resource_settings = restore_view_window_resources(&self.connection)?;
        let mut window_resource_diagnostics = self.resource_diagnostics("", &facts);
        window_resource_diagnostics.operation = DataViewResourceOperation::Window;
        window_resource_diagnostics.query_engine_version =
            window_resource_settings.query_engine_version;
        window_resource_diagnostics.memory_limit = window_resource_settings.memory_limit;
        window_resource_diagnostics.max_temporary_directory_size =
            window_resource_settings.max_temporary_directory_size;
        window_resource_diagnostics.threads = window_resource_settings.threads;
        before_publish();
        self.require_active()?;
        Ok(PreparedDataView {
            source: self.source,
            source_connection: self.connection,
            position_index,
            position_metadata,
            source_metadata,
            schema: facts.schema,
            source_columns,
            source_row_count: facts.row_count,
            row_count: index_summary.row_count,
            filters: self.filters,
            sort: self.sort,
            resource_diagnostics: window_resource_diagnostics,
            temporary_directory: Arc::new(self.temporary_directory),
            interrupted: self.cancelled,
        })
    }

    fn prepare_relation(
        &self,
        facts: &DataViewSourceFacts,
        source_column_names: &[&str],
        relation_columns: &str,
        source_position: &str,
        predicate: &FilterPredicate,
    ) -> Result<PreparedRelation, DataViewError> {
        match &self.source {
            DataViewSource::File(path) => {
                let path = path.to_str().ok_or(DataWindowError::Unsupported)?;
                let source_has_position_name = facts
                    .schema
                    .iter()
                    .any(|field| field.name == "file_row_number");
                let mut parameters = vec![duckdb::types::Value::Text(path.to_owned())];
                let sql = if source_has_position_name {
                    self.connection
                        .execute_batch("SET preserve_insertion_order = true")
                        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
                    parameters.push(duckdb::types::Value::BigInt(
                        i64::try_from(facts.row_count).map_err(|_| DataWindowError::Unsupported)?,
                    ));
                    format!(
                        "read_parquet(?) AS {}({relation_columns}) POSITIONAL JOIN \
                         range(?) AS {}({source_position})",
                        quote_identifier("__viewda_source"),
                        quote_identifier("__viewda_positions")
                    )
                } else {
                    format!(
                        "read_parquet(?, file_row_number = true) AS {}(\
                         {relation_columns}, {source_position})",
                        quote_identifier("__viewda_source")
                    )
                };
                Ok(PreparedRelation {
                    sql,
                    position_projection: format!(
                        "{source_position} AS {}",
                        quote_identifier(POSITION_COLUMN)
                    ),
                    tie_break: source_position.to_owned(),
                    parameters,
                })
            }
            DataViewSource::Dataset(dataset) => {
                self.connection
                    .execute_batch("SET preserve_insertion_order = true")
                    .map_err(|error| self.classify_prepare_error(error, facts, false))?;
                dataset
                    .install_while(&self.connection, || !self.cancelled.load(Ordering::Acquire))
                    .map_err(|error| self.classify_setup_error(error, facts))?;
                let ordinal = quote_identifier(dataset.ordinal_column());
                let native_row = quote_identifier(dataset.row_column());
                let mut needed_indices = self
                    .filters
                    .iter()
                    .filter_map(|filter| {
                        resolve_field_path(&facts.schema, &filter.field_path)
                            .map(|resolved| resolved.root_index)
                    })
                    .chain(self.sort.iter().filter_map(|sort| {
                        resolve_field_path(&facts.schema, &sort.field_path)
                            .map(|resolved| resolved.root_index)
                    }))
                    .collect::<Vec<_>>();
                needed_indices.sort_unstable();
                needed_indices.dedup();
                let staging_projection = needed_indices
                    .into_iter()
                    .map(|index| {
                        format!(
                            "{} AS {}",
                            quote_identifier(&facts.schema[index].name),
                            quote_identifier(source_column_names[index]),
                        )
                    })
                    .chain([
                        format!("{ordinal} AS {ordinal}"),
                        format!("{native_row} AS {native_row}"),
                    ])
                    .collect::<Vec<_>>()
                    .join(", ");
                let staging_where_clause = if self.filters.is_empty() {
                    String::new()
                } else {
                    format!(" WHERE {}", predicate.sql)
                };
                dataset
                    .stage_candidate_batches(
                        &self.connection,
                        &self.filters,
                        "__viewda_staged_dataset",
                        (&staging_projection, &staging_where_clause),
                        &predicate.parameters,
                        || !self.cancelled.load(Ordering::Acquire),
                    )
                    .map_err(|error| self.classify_setup_error(error, facts))?;
                self.connection
                    .execute_batch("SET preserve_insertion_order = false")
                    .map_err(|error| self.classify_prepare_error(error, facts, false))?;
                Ok(PreparedRelation {
                    sql: quote_identifier("__viewda_staged_dataset"),
                    position_projection: format!(
                        "{ordinal} AS {}, {native_row} AS {}",
                        quote_identifier("__viewda_member_ordinal"),
                        quote_identifier("__viewda_native_row")
                    ),
                    tie_break: format!("{ordinal} ASC, {native_row}"),
                    parameters: Vec::new(),
                })
            }
        }
    }

    fn require_active(&self) -> Result<(), DataWindowError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(DataWindowError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn classify_prepare_error(
        &self,
        error: DuckDbError,
        facts: &DataViewSourceFacts,
        filters_applied: bool,
    ) -> DataViewError {
        if let Some(error) = self.classify_prepare_control_error(&error, facts) {
            return error;
        }
        match &self.source {
            DataViewSource::File(_) => classify_query_error(error, filters_applied).into(),
            DataViewSource::Dataset(dataset) => {
                dataset_view_error(dataset.classify_query_failure(error, filters_applied))
            }
        }
    }

    fn classify_setup_error(
        &self,
        error: DatasetSetupError,
        facts: &DataViewSourceFacts,
    ) -> DataViewError {
        match error {
            DatasetSetupError::Dataset(error) => dataset_view_error(error),
            DatasetSetupError::Query(error) => self
                .classify_prepare_control_error(&error, facts)
                .unwrap_or_else(|| classify_query_error(error, false).into()),
        }
    }

    fn classify_prepare_control_error(
        &self,
        error: &DuckDbError,
        facts: &DataViewSourceFacts,
    ) -> Option<DataViewError> {
        if self.cancelled.load(Ordering::Acquire) {
            return Some(DataWindowError::Cancelled.into());
        }
        let (failure, message) = data_view_resource_failure(error)?;
        Some(failure.error(self.resource_diagnostics(message, facts)))
    }

    fn resource_diagnostics(
        &self,
        message: &str,
        facts: &DataViewSourceFacts,
    ) -> DataViewResourceDiagnostics {
        let sort_columns = self
            .sort
            .iter()
            .filter_map(|sort| {
                let field = resolve_field_path(&facts.schema, &sort.field_path)?.field;
                Some(DataViewSortDiagnostic {
                    physical_type: field.physical_type.clone(),
                    logical_type: field.logical_type.clone(),
                    direction: sort.direction,
                })
            })
            .collect();

        DataViewResourceDiagnostics {
            operation: DataViewResourceOperation::Preparation,
            query_engine_version: self.resource_settings.query_engine_version.clone(),
            message: self
                .source
                .sanitize_resource_message(message, self.temporary_directory.path()),
            memory_limit: self.resource_settings.memory_limit.clone(),
            max_temporary_directory_size: self
                .resource_settings
                .max_temporary_directory_size
                .clone(),
            threads: self.resource_settings.threads,
            row_count: facts.row_count,
            source_size_bytes: facts.size_bytes,
            row_group_count: facts.row_group_count,
            column_count: facts.schema.len(),
            filter_count: self.filters.len(),
            sort_columns,
        }
    }
}

fn data_view_resource_failure(error: &DuckDbError) -> Option<(DataViewResourceFailure, &str)> {
    let DuckDbError::DuckDBFailure(_, Some(message)) = error else {
        return None;
    };
    let lower_message = message.to_ascii_lowercase();
    if message.contains("max_temp_directory_size")
        || (message.starts_with("IO Error:")
            && ["no space left", "disk full", "not enough space"]
                .iter()
                .any(|marker| lower_message.contains(marker)))
    {
        Some((DataViewResourceFailure::TemporaryStorage, message))
    } else if message.starts_with("Out of Memory Error:") {
        Some((DataViewResourceFailure::Memory, message))
    } else {
        None
    }
}

fn sanitize_resource_message(
    message: &str,
    source_path: Option<&Path>,
    temporary_path: &Path,
) -> String {
    let message = redact_path_aliases(message, [temporary_path], "<temporary directory>");
    let message = source_path.map_or_else(
        || message.clone(),
        |path| redact_path_aliases(&message, [path], "<source>"),
    );
    truncate_resource_message(&message)
}

fn truncate_resource_message(message: &str) -> String {
    message
        .split("\n\n")
        .next()
        .unwrap_or(message)
        .chars()
        .take(2_048)
        .collect()
}

fn read_resource_settings(
    connection: &Connection,
) -> Result<DataViewResourceSettings, DataWindowError> {
    let query_engine_version = connection
        .version()
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    let (memory_limit, max_temporary_directory_size, threads) = connection
        .query_row(
            "SELECT current_setting('memory_limit'), \
             current_setting('max_temp_directory_size'), current_setting('threads')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    Ok(DataViewResourceSettings {
        query_engine_version,
        memory_limit,
        max_temporary_directory_size,
        threads,
    })
}

fn restore_view_window_resources(
    connection: &Connection,
) -> Result<DataViewResourceSettings, DataWindowError> {
    connection
        .execute_batch(&format!(
            "SET memory_limit = {}; SET threads = 1; SET preserve_insertion_order = true",
            quote_string_literal(WINDOW_MEMORY_LIMIT),
        ))
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    read_resource_settings(connection)
}

fn classify_view_window_error(
    error: DuckDbError,
    resource_diagnostics: &DataViewResourceDiagnostics,
    source: &DataViewSource,
    temporary_directory: &Path,
) -> DataViewError {
    if let Some((failure, message)) = data_view_resource_failure(&error) {
        let mut diagnostics = resource_diagnostics.clone();
        diagnostics.message = source.sanitize_resource_message(message, temporary_directory);
        failure.error(diagnostics)
    } else {
        classify_query_error(error, false).into()
    }
}

fn classify_view_window_query_error(view: &PreparedDataView, error: DuckDbError) -> DataViewError {
    if view.interrupted.load(Ordering::Acquire) {
        DataWindowError::Cancelled.into()
    } else if data_view_resource_failure(&error).is_some() {
        classify_view_window_error(
            error,
            &view.resource_diagnostics,
            &view.source,
            view.temporary_directory.path(),
        )
    } else {
        classify_query_error(error, false).into()
    }
}

/// A completed view whose count and windows share the same source-position index.
pub struct PreparedDataView {
    source: DataViewSource,
    source_connection: Connection,
    position_index: PathBuf,
    position_metadata: ArrowReaderMetadata,
    source_metadata: Option<ArrowReaderMetadata>,
    schema: Vec<crate::source::SchemaField>,
    source_columns: Vec<String>,
    source_row_count: u64,
    row_count: u64,
    filters: Vec<DataFilter>,
    sort: Vec<DataSort>,
    resource_diagnostics: DataViewResourceDiagnostics,
    temporary_directory: Arc<TempDir>,
    interrupted: Arc<AtomicBool>,
}

/// Snapshot of a completed view used by a background export.
///
/// The temporary-directory lease keeps the compact position index alive if the
/// grid replaces its active view while the export is still running.
pub struct PreparedDataViewExport {
    pub(crate) source: PreparedDataViewExportSource,
    pub(crate) position_index: PathBuf,
    pub(crate) position_metadata: ArrowReaderMetadata,
    pub(crate) source_row_count: u64,
    pub(crate) row_count: u64,
    pub(crate) filters: Vec<DataFilter>,
    pub(crate) sorted: bool,
    pub(crate) _temporary_directory: Arc<TempDir>,
}

pub(crate) enum PreparedDataViewExportSource {
    File(PathBuf),
    Dataset(DatasetSessionToken),
}

impl PreparedDataView {
    /// Returns a handle that interrupts an active window and retires this view.
    pub fn interrupt_handle(&self) -> DataViewInterruptHandle {
        DataViewInterruptHandle {
            inner: self.source_connection.interrupt_handle(),
            cancelled: Arc::clone(&self.interrupted),
        }
    }

    /// Returns the exact number of positions in this view.
    pub fn row_count(&self) -> u64 {
        self.row_count
    }

    /// Captures the current filter and position index for a background export.
    pub fn export_snapshot(&self) -> PreparedDataViewExport {
        PreparedDataViewExport {
            source: match &self.source {
                DataViewSource::File(path) => PreparedDataViewExportSource::File(path.clone()),
                DataViewSource::Dataset(dataset) => {
                    PreparedDataViewExportSource::Dataset(dataset.session_token())
                }
            },
            position_index: self.position_index.clone(),
            position_metadata: self.position_metadata.clone(),
            source_row_count: self.source_row_count,
            row_count: self.row_count,
            filters: self.filters.clone(),
            sorted: !self.sort.is_empty(),
            _temporary_directory: Arc::clone(&self.temporary_directory),
        }
    }

    /// Reads a bounded view window without rerunning its filter or sort.
    pub fn fetch_window(&self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DataViewError> {
        let field_paths = self
            .schema
            .iter()
            .map(|field| FieldPath::from(field.name.as_str()))
            .collect::<Vec<_>>();
        self.fetch_window_fields(row_offset, row_count, &field_paths)
    }

    /// Reads selected addressable fields without rerunning the view's filter or sort.
    pub fn fetch_window_fields(
        &self,
        row_offset: u64,
        row_count: u32,
        field_paths: &[FieldPath],
    ) -> Result<Vec<u8>, DataViewError> {
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge.into());
        }
        let resolved =
            validate_field_paths(&self.schema, field_paths).ok_or(DataWindowError::Unsupported)?;
        let requested_root_indices = resolved
            .iter()
            .map(|resolved| resolved.root_index)
            .collect::<Vec<_>>();
        if let DataViewSource::Dataset(dataset) = &self.source {
            let offset = usize::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?;
            let limit = usize::try_from(row_count).map_err(|_| DataWindowError::Unsupported)?;
            let positions = read_dataset_positions(
                &self.position_index,
                &self.position_metadata,
                offset,
                limit,
            )?;
            if positions.is_empty() {
                let schema = dataset
                    .projected_field_schema(field_paths)
                    .map_err(dataset_view_error)?;
                return encode_empty(schema).map_err(DataViewError::from);
            }
            let rows = dataset
                .stage_sparse_window_while(
                    &positions,
                    field_paths,
                    self.temporary_directory.path(),
                    || !self.interrupted.load(Ordering::Acquire),
                )
                .map_err(dataset_view_error)?;
            return self.fetch_sparse_dataset_window(&rows, field_paths);
        }
        let top_level_only = field_paths.iter().all(|path| path.segments().len() == 1);
        if top_level_only
            && let (DataViewSource::File(source_path), Some(metadata)) =
                (&self.source, &self.source_metadata)
        {
            let offset = usize::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?;
            let limit = usize::try_from(row_count).map_err(|_| DataWindowError::Unsupported)?;
            let positions =
                read_positions(&self.position_index, &self.position_metadata, offset, limit)?;
            match read_source_positions(source_path, metadata, &positions, &requested_root_indices)
            {
                Ok(window) => return Ok(window),
                Err(DataWindowError::CorruptSource) => {
                    // TODO(Arrow 59): parquet 58 rejects some valid nested-list row groups.
                    // Remove this full-scan DuckDB fallback after duckdb-rs shares Arrow/Parquet
                    // 59+ and the nested compatibility fixture passes through the sparse reader.
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.fetch_window_fields_with_duckdb(row_offset, row_count, field_paths)
    }

    fn fetch_window_fields_with_duckdb(
        &self,
        row_offset: u64,
        row_count: u32,
        field_paths: &[FieldPath],
    ) -> Result<Vec<u8>, DataViewError> {
        self.fetch_window_fields_with_duckdb_inner(row_offset, row_count, field_paths, || {})
    }

    fn fetch_window_fields_with_duckdb_inner(
        &self,
        row_offset: u64,
        row_count: u32,
        field_paths: &[FieldPath],
        before_prepare: impl FnOnce(),
    ) -> Result<Vec<u8>, DataViewError> {
        if self.interrupted.load(Ordering::Acquire) {
            return Err(DataWindowError::Cancelled.into());
        }
        let position_index_path = self
            .position_index
            .to_str()
            .ok_or(DataWindowError::Unsupported)?;
        let query = match &self.source {
            DataViewSource::File(source_path) => build_window_query(
                &self.schema,
                &self.source_columns,
                self.source_row_count,
                source_path.to_str().ok_or(DataWindowError::Unsupported)?,
                position_index_path,
                field_paths,
            )?,
            DataViewSource::Dataset(_) => return Err(DataWindowError::Unsupported.into()),
        };
        fetch_view_window_inner(self, &query, row_offset, row_count, before_prepare)
    }

    fn fetch_sparse_dataset_window(
        &self,
        rows: &DatasetSparseRows,
        field_paths: &[FieldPath],
    ) -> Result<Vec<u8>, DataViewError> {
        if self.interrupted.load(Ordering::Acquire) {
            return Err(DataWindowError::Cancelled.into());
        }
        let projection = field_paths
            .iter()
            .map(|path| {
                let resolved =
                    resolve_field_path(&self.schema, path).ok_or(DataWindowError::Unsupported)?;
                let root = format!(
                    "source.{}",
                    quote_identifier(&self.schema[resolved.root_index].name)
                );
                let expression =
                    field_path_expression(path, &root).ok_or(DataWindowError::Unsupported)?;
                Ok(format!(
                    "{expression} AS {}",
                    quote_identifier(path.leaf_name().ok_or(DataWindowError::Unsupported)?)
                ))
            })
            .collect::<Result<Vec<_>, DataWindowError>>()?
            .join(", ");
        let query = format!(
            "SELECT {projection} FROM {} source ORDER BY source.{}",
            rows.relation_sql(),
            quote_identifier(rows.requested_order_column())
        );
        let mut statement = self
            .source_connection
            .prepare(&query)
            .map_err(|error| self.classify_sparse_query_error(error))?;
        let batches = statement
            .stream_arrow([])
            .map_err(|error| self.classify_sparse_query_error(error))?;
        let produced_schema = batches.get_schema();
        let expected = project_arrow_field_paths(rows.schema(), field_paths)
            .ok_or(DataWindowError::Unsupported)?;
        validate_produced_arrow_schema(&expected, &produced_schema)?;
        let mut writer = StreamWriter::try_new(Vec::new(), produced_schema.as_ref())
            .map_err(|_| DataWindowError::EncodingFailed)?;
        let mut written_rows = 0_usize;
        let encoded = catch_unwind(AssertUnwindSafe(|| {
            for batch in batches {
                if self.interrupted.load(Ordering::Acquire) {
                    return Err(DataWindowError::Cancelled);
                }
                written_rows = written_rows
                    .checked_add(batch.num_rows())
                    .ok_or(DataWindowError::Unsupported)?;
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
        }));
        let encoded = match encoded {
            Ok(result) => result?,
            Err(_) if self.interrupted.load(Ordering::Acquire) => {
                return Err(DataWindowError::Cancelled.into());
            }
            Err(_) => return Err(DataWindowError::QueryFailed.into()),
        };
        if written_rows != rows.row_count() {
            return Err(DataWindowError::QueryFailed.into());
        }
        Ok(encoded)
    }

    fn classify_sparse_query_error(&self, error: DuckDbError) -> DataViewError {
        if self.interrupted.load(Ordering::Acquire) {
            DataWindowError::Cancelled.into()
        } else if data_view_resource_failure(&error).is_some() {
            classify_view_window_error(
                error,
                &self.resource_diagnostics,
                &self.source,
                self.temporary_directory.path(),
            )
        } else {
            classify_query_error(error, false).into()
        }
    }

    #[cfg(test)]
    fn classify_window_setup_error(&self, error: DatasetSetupError) -> DataViewError {
        match error {
            DatasetSetupError::Dataset(error) => dataset_view_error(error),
            DatasetSetupError::Query(error) => {
                if data_view_resource_failure(&error).is_some() {
                    classify_view_window_error(
                        error,
                        &self.resource_diagnostics,
                        &self.source,
                        self.temporary_directory.path(),
                    )
                } else {
                    classify_query_error(error, false).into()
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn position_index_path(&self) -> &std::path::Path {
        &self.position_index
    }
}

fn validate_sort(
    schema: &[crate::source::SchemaField],
    sort: &[DataSort],
) -> Result<(), DataWindowError> {
    if sort.len() > MAX_SORT_COLUMNS {
        return Err(DataWindowError::InvalidSort);
    }
    let mut seen = Vec::with_capacity(sort.len());
    for column in sort {
        let resolved =
            resolve_field_path(schema, &column.field_path).ok_or(DataWindowError::InvalidSort)?;
        if column.json_target.is_some() && !field_is_json(resolved.field) {
            return Err(DataWindowError::InvalidSort);
        }
        let identity = (
            &column.field_path,
            column.json_target.as_ref().map(|target| &target.path),
        );
        if seen.contains(&identity) {
            return Err(DataWindowError::InvalidSort);
        }
        seen.push(identity);
    }
    Ok(())
}

#[cfg(test)]
fn build_order_clause(
    schema: &[crate::source::SchemaField],
    sort: &[DataSort],
    source_position: &str,
) -> Result<String, DataWindowError> {
    let column_names = schema
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    build_order_clause_with_names(schema, &column_names, sort, source_position)
}

fn build_order_clause_with_names(
    schema: &[crate::source::SchemaField],
    column_names: &[&str],
    sort: &[DataSort],
    source_position: &str,
) -> Result<String, DataWindowError> {
    if column_names.len() != schema.len() {
        return Err(DataWindowError::InvalidSort);
    }
    let mut order = Vec::with_capacity(sort.len() + 1);
    for sort_column in sort {
        let resolved = resolve_field_path(schema, &sort_column.field_path)
            .ok_or(DataWindowError::InvalidSort)?;
        let direction = match sort_column.direction {
            DataSortDirection::Ascending => "ASC",
            DataSortDirection::Descending => "DESC",
        };
        let root = quote_identifier(
            column_names
                .get(resolved.root_index)
                .ok_or(DataWindowError::InvalidSort)?,
        );
        let field = field_path_expression(&sort_column.field_path, &root)
            .ok_or(DataWindowError::InvalidSort)?;
        let expression = match &sort_column.json_target {
            Some(target) if field_is_json(resolved.field) => json_field_expression(&field, target),
            Some(_) => None,
            None => Some(JsonFieldExpression::Scalar(field)),
        }
        .ok_or(DataWindowError::InvalidSort)?;
        match expression {
            JsonFieldExpression::Scalar(expression) => {
                order.push(format!("{expression} {direction} NULLS LAST"));
            }
            JsonFieldExpression::Number(number) => {
                // DOUBLE defines the common numeric bucket. The DECIMAL key preserves exact
                // integers and orders collisions without coercing them back to DOUBLE.
                order.push(format!("{} {direction} NULLS LAST", number.finite));
                order.push(format!("{} {direction} NULLS LAST", number.bucket_tie));
            }
        }
    }
    order.push(format!("{source_position} ASC"));
    Ok(order.join(", "))
}

fn build_window_query(
    schema: &[crate::source::SchemaField],
    source_columns: &[String],
    source_row_count: u64,
    source_path: &str,
    position_index_path: &str,
    field_paths: &[FieldPath],
) -> Result<String, DataWindowError> {
    if source_columns.len() != schema.len() {
        return Err(DataWindowError::Unsupported);
    }
    let requested = quote_identifier("__viewda_requested");
    let requested_source = quote_identifier("__viewda_requested_source");
    let source = quote_identifier("__viewda_source");
    let position = quote_identifier(POSITION_COLUMN);
    let requested_order = quote_identifier(REQUESTED_ORDER_COLUMN);
    let source_position = quote_identifier(SOURCE_POSITION_COLUMN);
    let source_path = quote_string_literal(source_path);
    let position_index_path = quote_string_literal(position_index_path);
    let source_column_aliases = source_columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let projection = field_paths
        .iter()
        .map(|path| {
            let resolved = resolve_field_path(schema, path).ok_or(DataWindowError::Unsupported)?;
            let root = format!(
                "{source}.{}",
                quote_identifier(&source_columns[resolved.root_index])
            );
            let expression =
                field_path_expression(path, &root).ok_or(DataWindowError::Unsupported)?;
            Ok(format!(
                "{expression} AS {}",
                quote_identifier(path.leaf_name().ok_or(DataWindowError::Unsupported)?)
            ))
        })
        .collect::<Result<Vec<_>, DataWindowError>>()?
        .join(", ");
    let requested_cte = format!(
        "{requested} AS (\
         SELECT {position}, {requested_order} \
         FROM read_parquet({position_index_path}, file_row_number = true) \
         AS {requested_source}({position}, {requested_order}) \
         LIMIT ? OFFSET ?)"
    );
    if schema.iter().any(|field| field.name == "file_row_number") {
        let raw_source = quote_identifier("__viewda_raw_source");
        let source_positions = quote_identifier("__viewda_source_positions");
        Ok(format!(
            "WITH {requested_cte}, \
             {source} AS (\
             SELECT {raw_source}.*, {source_positions}.{source_position} \
             FROM read_parquet({source_path}) AS {raw_source}({source_column_aliases}) \
             POSITIONAL JOIN range({source_row_count}) \
             AS {source_positions}({source_position})) \
             SELECT {projection} \
             FROM {requested} \
             JOIN {source} \
             ON {source}.{source_position} = {requested}.{position} \
             ORDER BY {requested}.{requested_order}"
        ))
    } else {
        let source_aliases = format!("{source_column_aliases}, {source_position}");
        Ok(format!(
            "WITH {requested_cte} \
             SELECT {projection} \
             FROM {requested} \
             JOIN read_parquet({source_path}, file_row_number = true) \
             AS {source}({source_aliases}) \
             ON {source}.{source_position} = {requested}.{position} \
             ORDER BY {requested}.{requested_order}"
        ))
    }
}

fn read_positions(
    path: &Path,
    metadata: &ArrowReaderMetadata,
    offset: usize,
    limit: usize,
) -> Result<Vec<u64>, DataWindowError> {
    let file = File::open(path).map_err(map_io_error)?;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, metadata.clone())
        .with_offset(offset)
        .with_limit(limit)
        .with_batch_size(limit.max(1))
        .build()
        .map_err(|_| DataWindowError::CorruptSource)?;
    let mut positions = Vec::with_capacity(limit);
    for batch in reader {
        let batch = batch.map_err(|_| DataWindowError::CorruptSource)?;
        let values = batch
            .column_by_name(POSITION_COLUMN)
            .and_then(|column| column.as_any().downcast_ref::<Int64Array>())
            .ok_or(DataWindowError::CorruptSource)?;
        for value in values.iter() {
            positions.push(
                u64::try_from(value.ok_or(DataWindowError::CorruptSource)?)
                    .map_err(|_| DataWindowError::CorruptSource)?,
            );
        }
    }
    Ok(positions)
}

pub(crate) fn read_dataset_positions(
    path: &Path,
    metadata: &ArrowReaderMetadata,
    offset: usize,
    limit: usize,
) -> Result<Vec<DatasetRowPosition>, DataWindowError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let end = offset
        .checked_add(limit)
        .ok_or(DataWindowError::Unsupported)?;
    let schema = metadata.schema();
    let ordinal_index = schema
        .fields()
        .iter()
        .position(|field| field.name() == "__viewda_member_ordinal")
        .ok_or(DataWindowError::CorruptSource)?;
    let native_row_index = schema
        .fields()
        .iter()
        .position(|field| field.name() == "__viewda_native_row")
        .ok_or(DataWindowError::CorruptSource)?;
    let mut projection = vec![ordinal_index, native_row_index];
    projection.sort_unstable();
    projection.dedup();
    let mut positions = Vec::with_capacity(limit);
    let mut row_group_start = 0_usize;
    for (row_group_index, row_group) in metadata.metadata().row_groups().iter().enumerate() {
        let row_group_rows =
            usize::try_from(row_group.num_rows()).map_err(|_| DataWindowError::CorruptSource)?;
        let row_group_end = row_group_start
            .checked_add(row_group_rows)
            .ok_or(DataWindowError::CorruptSource)?;
        let selected_start = offset.max(row_group_start);
        let selected_end = end.min(row_group_end);
        if selected_start < selected_end {
            let local_start = selected_start - row_group_start;
            let local_end = selected_end - row_group_start;
            let selection = RowSelection::from_consecutive_ranges(
                std::iter::once(local_start..local_end),
                row_group_rows,
            );
            let file = File::open(path).map_err(map_io_error)?;
            let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, metadata.clone())
                .with_projection(ProjectionMask::roots(
                    metadata.metadata().file_metadata().schema_descr(),
                    projection.clone(),
                ))
                .with_row_groups(vec![row_group_index])
                .with_row_selection(selection)
                .with_batch_size(MAX_WINDOW_ROWS as usize)
                .build()
                .map_err(|_| DataWindowError::CorruptSource)?;
            #[cfg(test)]
            DATASET_POSITION_ROW_GROUP_READS.fetch_add(1, Ordering::Relaxed);
            for batch in reader {
                let batch = batch.map_err(|_| DataWindowError::CorruptSource)?;
                #[cfg(test)]
                DATASET_POSITION_DECODED_ROWS.fetch_add(batch.num_rows(), Ordering::Relaxed);
                let ordinals = batch
                    .column_by_name("__viewda_member_ordinal")
                    .and_then(|column| column.as_any().downcast_ref::<UInt64Array>())
                    .ok_or(DataWindowError::CorruptSource)?;
                let native_rows = batch
                    .column_by_name("__viewda_native_row")
                    .and_then(|column| column.as_any().downcast_ref::<Int64Array>())
                    .ok_or(DataWindowError::CorruptSource)?;
                if ordinals.len() != native_rows.len() {
                    return Err(DataWindowError::CorruptSource);
                }
                for (member_ordinal, native_row) in ordinals.iter().zip(native_rows.iter()) {
                    positions.push(DatasetRowPosition {
                        member_ordinal: member_ordinal.ok_or(DataWindowError::CorruptSource)?,
                        native_row: u64::try_from(
                            native_row.ok_or(DataWindowError::CorruptSource)?,
                        )
                        .map_err(|_| DataWindowError::CorruptSource)?,
                        requested_order: u64::try_from(positions.len())
                            .map_err(|_| DataWindowError::Unsupported)?,
                    });
                }
            }
        }
        row_group_start = row_group_end;
        if row_group_start >= end {
            break;
        }
    }
    if positions.len() > limit {
        return Err(DataWindowError::CorruptSource);
    }
    Ok(positions)
}

fn read_source_positions(
    path: &Path,
    metadata: &ArrowReaderMetadata,
    positions: &[u64],
    source_indices: &[usize],
) -> Result<Vec<u8>, DataWindowError> {
    let output_schema = projected_arrow_schema_from_usize(metadata.schema(), source_indices)?;
    if positions.is_empty() {
        return encode_empty(output_schema);
    }

    let total_rows = usize::try_from(metadata.metadata().file_metadata().num_rows())
        .map_err(|_| DataWindowError::Unsupported)?;
    let mut sorted_positions = positions
        .iter()
        .copied()
        .enumerate()
        .map(|(view_index, position)| {
            usize::try_from(position)
                .map(|position| (position, view_index))
                .map_err(|_| DataWindowError::Unsupported)
        })
        .collect::<Result<Vec<_>, _>>()?;
    sorted_positions.sort_unstable_by_key(|(position, _)| *position);
    if sorted_positions
        .last()
        .is_some_and(|(position, _)| *position >= total_rows)
        || sorted_positions
            .windows(2)
            .any(|pair| pair[0].0 == pair[1].0)
    {
        return Err(DataWindowError::CorruptSource);
    }

    let mut source_order_indices = source_indices.to_vec();
    source_order_indices.sort_unstable();
    let selection = RowSelection::from_consecutive_ranges(
        sorted_positions
            .iter()
            .map(|(position, _)| *position..*position + 1),
        total_rows,
    );
    let (file, _) = open_local_source(path).map_err(DataWindowError::from)?;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, metadata.clone())
        .with_projection(ProjectionMask::roots(
            metadata.metadata().file_metadata().schema_descr(),
            source_order_indices.iter().copied(),
        ))
        .with_batch_size(positions.len())
        .with_row_selection(selection)
        .build()
        .map_err(|_| DataWindowError::CorruptSource)?;
    let batches = reader
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| DataWindowError::CorruptSource)?;
    let source_order_schema =
        projected_arrow_schema_from_usize(metadata.schema(), &source_order_indices)?;
    let sorted_batch = concat_batches(&source_order_schema, &batches)
        .map_err(|_| DataWindowError::EncodingFailed)?;
    if sorted_batch.num_rows() != positions.len() {
        return Err(DataWindowError::CorruptSource);
    }

    let mut row_order = vec![0_u32; positions.len()];
    for (sorted_index, (_, view_index)) in sorted_positions.into_iter().enumerate() {
        row_order[view_index] =
            u32::try_from(sorted_index).map_err(|_| DataWindowError::Unsupported)?;
    }
    let row_order = UInt32Array::from(row_order);
    let columns = source_indices
        .iter()
        .map(|source_index| {
            let column_offset = source_order_indices
                .binary_search(source_index)
                .map_err(|_| DataWindowError::Unsupported)?;
            take(
                sorted_batch.column(column_offset).as_ref(),
                &row_order,
                None,
            )
            .map_err(|_| DataWindowError::EncodingFailed)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let batch = RecordBatch::try_new(output_schema, columns)
        .map_err(|_| DataWindowError::EncodingFailed)?;
    encode_batch(&batch)
}

fn projected_arrow_schema_from_usize(
    schema: &SchemaRef,
    source_indices: &[usize],
) -> Result<SchemaRef, DataWindowError> {
    let fields = source_indices
        .iter()
        .map(|index| {
            schema
                .fields()
                .get(*index)
                .cloned()
                .ok_or(DataWindowError::Unsupported)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Arc::new(Schema::new_with_metadata(
        fields,
        schema.metadata().clone(),
    )))
}

fn encode_batch(batch: &RecordBatch) -> Result<Vec<u8>, DataWindowError> {
    let mut writer = StreamWriter::try_new(Vec::new(), batch.schema().as_ref())
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .write(batch)
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .finish()
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .into_inner()
        .map_err(|_| DataWindowError::EncodingFailed)
}

fn encode_empty(schema: SchemaRef) -> Result<Vec<u8>, DataWindowError> {
    let mut writer = StreamWriter::try_new(Vec::new(), schema.as_ref())
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .finish()
        .map_err(|_| DataWindowError::EncodingFailed)?;
    writer
        .into_inner()
        .map_err(|_| DataWindowError::EncodingFailed)
}

fn fetch_view_window_inner(
    view: &PreparedDataView,
    query: &str,
    row_offset: u64,
    row_count: u32,
    before_prepare: impl FnOnce(),
) -> Result<Vec<u8>, DataViewError> {
    if view.interrupted.load(Ordering::Acquire) {
        return Err(DataWindowError::Cancelled.into());
    }
    let DataViewSource::File(path) = &view.source else {
        return Err(DataWindowError::Unsupported.into());
    };
    let (file, _) = open_local_source(path).map_err(DataWindowError::from)?;
    drop(file);
    before_prepare();
    let parameters = [
        duckdb::types::Value::BigInt(i64::from(row_count)),
        duckdb::types::Value::BigInt(
            i64::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?,
        ),
    ];
    let mut statement = view
        .source_connection
        .prepare_cached(query)
        .map_err(|error| classify_view_window_query_error(view, error))?;
    let batches = statement
        .stream_arrow(params_from_iter(parameters.iter()))
        .map_err(|error| classify_view_window_query_error(view, error))?;
    let schema = batches.get_schema();
    let mut writer = StreamWriter::try_new(Vec::new(), schema.as_ref())
        .map_err(|_| DataWindowError::EncodingFailed)?;
    let encoded = catch_unwind(AssertUnwindSafe(|| {
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
    }));
    let encoded = match encoded {
        Ok(result) => result.map_err(DataViewError::from)?,
        Err(_) if view.interrupted.load(Ordering::Acquire) => {
            return Err(DataWindowError::Cancelled.into());
        }
        Err(_) => return Err(DataWindowError::Unsupported.into()),
    };
    if view.interrupted.load(Ordering::Acquire) {
        return Err(DataWindowError::Cancelled.into());
    }
    Ok(encoded)
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn map_io_error(error: io::Error) -> DataWindowError {
    match error.kind() {
        io::ErrorKind::NotFound => DataWindowError::NotFound,
        io::ErrorKind::PermissionDenied => DataWindowError::PermissionDenied,
        io::ErrorKind::StorageFull => DataWindowError::ResourceExhausted,
        _ => DataWindowError::Unsupported,
    }
}

pub(crate) fn create_temporary_directory(prefix: &str) -> Result<TempDir, DataWindowError> {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .map_err(map_io_error)
}

fn dataset_view_error(error: DatasetError) -> DataViewError {
    let error = match error {
        DatasetError::Window { error } => error,
        DatasetError::NotFound => DataWindowError::NotFound,
        DatasetError::PermissionDenied | DatasetError::MemberPermissionDenied { .. } => {
            DataWindowError::PermissionDenied
        }
        DatasetError::SourceChanged { .. } => DataWindowError::SourceChanged,
        DatasetError::InvalidMember { .. } => DataWindowError::CorruptSource,
        DatasetError::Cancelled => DataWindowError::Cancelled,
        DatasetError::NoParquetFiles
        | DatasetError::PageTooLarge
        | DatasetError::InspectionStepTooLarge
        | DatasetError::SchemaConflict { .. }
        | DatasetError::DuplicatePartitionKey { .. }
        | DatasetError::Unsupported => DataWindowError::Unsupported,
    };
    error.into()
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, FileTimes, OpenOptions},
        io::{Cursor, Seek, SeekFrom, Write},
        path::PathBuf,
        sync::{Arc, mpsc},
        thread,
        time::Duration,
    };

    use arrow_array::{
        Array, ArrayRef, BinaryArray, Decimal128Array, Int64Array, RecordBatch, StringArray,
        StructArray, TimestampMicrosecondArray,
    };
    use arrow_ipc::reader::StreamReader;
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::{
        arrow::ArrowWriter,
        file::reader::{FileReader, SerializedFileReader},
    };
    use tempfile::{NamedTempFile, TempDir};

    use super::*;
    use crate::DataFilterOperator;

    #[test]
    fn stores_only_positions_and_reuses_the_index_for_repeated_windows() {
        let source = write_fixture();
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("label"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");
        let metadata_before = fs::metadata(view.position_index_path()).expect("position metadata");

        let first = view.fetch_window(0, 3).expect("first window");
        let repeated = view.fetch_window(0, 3).expect("repeated window");
        let metadata_after = fs::metadata(view.position_index_path()).expect("position metadata");
        let index = inspect_local_source(view.position_index_path()).expect("position index");

        assert_eq!(first, repeated);
        assert_eq!(metadata_before.len(), metadata_after.len());
        assert_eq!(
            metadata_before.modified().ok(),
            metadata_after.modified().ok()
        );
        assert_eq!(index.schema.len(), 1);
        assert_eq!(index.schema[0].name, POSITION_COLUMN);
        assert!(metadata_after.len() < fs::metadata(source.path()).expect("source metadata").len());
    }

    #[test]
    fn dataset_staging_omits_columns_unused_by_filters_and_sort() {
        let (_directory, reader) = write_dataset_fixture();
        let builder = DataViewBuilder::for_dataset(
            &reader,
            &[],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
            DataViewMemoryLimit::Mb384,
        )
        .expect("dataset builder");
        let facts = builder.source.facts().expect("dataset facts");
        let source_columns = (0..facts.schema.len())
            .map(|index| format!("__viewda_column_{index}"))
            .collect::<Vec<_>>();
        let names = source_columns
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        builder
            .prepare_relation(
                &facts,
                &names,
                "",
                "\"__viewda_source_position\"",
                &FilterPredicate {
                    sql: String::new(),
                    parameters: Vec::new(),
                },
            )
            .expect("staged relation");
        let mut statement = builder
            .connection
            .prepare("SELECT name FROM pragma_table_info('__viewda_staged_dataset') ORDER BY cid")
            .expect("staged schema");
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("staged columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("column names");

        assert!(names.iter().any(|name| name == "__viewda_column_0"));
        assert!(!names.iter().any(|name| name == "__viewda_column_1"));
        assert_eq!(names.len(), 3);
    }

    #[test]
    fn dataset_staging_applies_the_prepared_filter_predicate() {
        let (_directory, reader) = write_dataset_fixture();
        let filters = [DataFilter {
            field_path: field("id"),
            json_target: None,
            operator: crate::DataFilterOperator::Equals,
            values: vec!["1".to_owned()],
            match_case: false,
        }];
        let builder = DataViewBuilder::for_dataset(
            &reader,
            &filters,
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
            DataViewMemoryLimit::Mb384,
        )
        .expect("dataset builder");
        let facts = builder.source.facts().expect("dataset facts");
        let source_columns = (0..facts.schema.len())
            .map(|index| format!("__viewda_column_{index}"))
            .collect::<Vec<_>>();
        let names = source_columns
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let predicate = build_filter_predicate_with_names(&facts.schema, &filters, &names)
            .expect("filter predicate");

        builder
            .prepare_relation(
                &facts,
                &names,
                "",
                "\"__viewda_source_position\"",
                &predicate,
            )
            .expect("staged relation");

        let staged_rows = builder
            .connection
            .query_row("SELECT count(*) FROM __viewda_staged_dataset", [], |row| {
                row.get::<_, u64>(0)
            })
            .expect("staged rows");
        assert_eq!(staged_rows, 2);
    }

    #[test]
    fn completed_dataset_view_releases_its_payload_staging_table() {
        let (_directory, reader) = write_dataset_fixture();
        let view = DataViewBuilder::for_dataset(
            &reader,
            &[],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
            DataViewMemoryLimit::Mb384,
        )
        .expect("dataset builder")
        .build()
        .expect("prepared dataset view");

        let staged_tables = view
            .source_connection
            .query_row(
                "SELECT count(*) FROM information_schema.tables \
                 WHERE table_name = '__viewda_staged_dataset'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .expect("staging table count");
        assert_eq!(staged_tables, 0);
        let files = fs::read_dir(view.temporary_directory.path())
            .expect("view temporary directory")
            .map(|entry| {
                entry
                    .expect("view temporary entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(files, ["positions.parquet"]);
    }

    #[test]
    fn prepared_windows_return_only_requested_source_columns() {
        let source = write_fixture();
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("label"),
                json_target: None,
                direction: DataSortDirection::Descending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");

        let bytes = view
            .fetch_window_fields(0, 2, &[field("label")])
            .expect("projected window");
        let batches = StreamReader::try_new(Cursor::new(bytes), None)
            .expect("Arrow stream")
            .collect::<Result<Vec<_>, _>>()
            .expect("Arrow batches");

        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].num_columns(), 1);
        assert_eq!(batches[0].schema().field(0).name(), "label");
        assert_eq!(
            batches[0]
                .column(0)
                .as_any()
                .downcast_ref::<StringArray>()
                .expect("label column")
                .value(0),
            "label-1999"
        );
        let reordered = view
            .fetch_window_fields(0, 1, &[field("label"), field("id")])
            .expect("reordered projected window");
        let reordered = StreamReader::try_new(Cursor::new(reordered), None)
            .expect("reordered Arrow stream")
            .next()
            .expect("reordered Arrow batch")
            .expect("valid reordered Arrow batch");
        assert_eq!(reordered.schema().field(0).name(), "label");
        assert_eq!(reordered.schema().field(1).name(), "id");
        assert_eq!(
            reordered
                .column(1)
                .as_any()
                .downcast_ref::<Int64Array>()
                .expect("id column")
                .value(0),
            1_999
        );
        assert!(matches!(
            view.fetch_window_fields(0, 1, &[]),
            Err(DataViewError::Engine(DataWindowError::Unsupported))
        ));
        assert!(matches!(
            view.fetch_window_fields(0, 1, &[field("label"), field("label")]),
            Err(DataViewError::Engine(DataWindowError::Unsupported))
        ));
        assert!(matches!(
            view.fetch_window_fields(0, 1, &[field("missing")]),
            Err(DataViewError::Engine(DataWindowError::Unsupported))
        ));
    }

    #[test]
    fn utc_timestamp_schema_is_stable_across_direct_sparse_and_fallback_windows() {
        let source = write_utc_timestamp_fixture();
        let mut direct_reader = crate::DataWindowReader::new(source.path().to_owned());
        let direct = direct_reader.fetch(0, 2).expect("direct DuckDB window");
        let direct = StreamReader::try_new(Cursor::new(direct), None)
            .expect("direct Arrow stream")
            .next()
            .expect("direct Arrow batch")
            .expect("valid direct Arrow batch");
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");
        let sparse = view
            .fetch_window_fields(0, 2, &[field("utc_at")])
            .expect("sparse window");
        let sparse = StreamReader::try_new(Cursor::new(sparse), None)
            .expect("sparse Arrow stream")
            .next()
            .expect("sparse Arrow batch")
            .expect("valid sparse Arrow batch");
        let fallback = view
            .fetch_window_fields_with_duckdb(0, 2, &[field("utc_at")])
            .expect("DuckDB fallback window");
        let fallback = StreamReader::try_new(Cursor::new(fallback), None)
            .expect("fallback Arrow stream")
            .next()
            .expect("fallback Arrow batch")
            .expect("valid fallback Arrow batch");
        let expected = DataType::Timestamp(
            arrow_schema::TimeUnit::Microsecond,
            Some(Arc::<str>::from("UTC")),
        );

        assert_eq!(direct.schema().field(1).data_type(), &expected);
        assert_eq!(sparse.schema().field(0).data_type(), &expected);
        assert_eq!(fallback.schema().field(0).data_type(), &expected);
    }

    #[test]
    fn nested_values_are_stable_across_direct_sparse_and_fallback_windows() {
        let source = write_nested_value_fixture();
        let mut direct_reader = crate::DataWindowReader::new(source.path().to_owned());
        let direct = decode_one_window(
            direct_reader.fetch(0, 2).expect("direct DuckDB window"),
            "direct",
        );
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");
        let sparse = decode_one_window(
            view.fetch_window_fields(0, 2, &[field("payload")])
                .expect("sparse window"),
            "sparse",
        );
        let fallback = decode_one_window(
            view.fetch_window_fields_with_duckdb(0, 2, &[field("payload")])
                .expect("DuckDB fallback window"),
            "fallback",
        );

        let direct = nested_value_snapshot(&direct, 1);
        let sparse = nested_value_snapshot(&sparse, 0);
        let fallback = nested_value_snapshot(&fallback, 0);
        assert_eq!(sparse, direct);
        assert_eq!(fallback, direct);
        assert_eq!(direct.amounts, vec![1_234, -5_678]);
        assert_eq!(
            direct.timestamps,
            vec![1_700_000_000_000_000, 1_700_000_000_000_001]
        );
        assert_eq!(direct.binary, vec![b"\0abc".to_vec(), vec![0xff]]);
    }

    #[test]
    fn prepared_nested_window_projects_only_the_requested_parquet_leaf() {
        let source = write_nested_value_fixture();
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");
        let amount = FieldPath::new(["payload", "amount"]);
        let query = build_window_query(
            &view.schema,
            &view.source_columns,
            view.source_row_count,
            source.path().to_str().expect("UTF-8 source path"),
            view.position_index_path()
                .to_str()
                .expect("UTF-8 position path"),
            std::slice::from_ref(&amount),
        )
        .expect("DuckDB fallback query");
        let plan = view
            .source_connection
            .prepare(&format!("EXPLAIN {query}"))
            .expect("explain prepared window")
            .query_map(duckdb::params![2_i64, 0_i64], |row| row.get::<_, String>(1))
            .expect("explain rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("physical plan")
            .join("\n");
        assert!(plan.contains("__viewda_column_1.amount"), "{plan}");
        assert!(!plan.contains("occurred_at"), "{plan}");
        assert!(!plan.contains("blob"), "{plan}");

        let batch = decode_one_window(
            view.fetch_window_fields(0, 2, std::slice::from_ref(&amount))
                .expect("prepared leaf window"),
            "prepared leaf",
        );
        assert_eq!(
            batch
                .column(0)
                .as_any()
                .downcast_ref::<Decimal128Array>()
                .expect("amount decimals")
                .values(),
            &[1_234, -5_678]
        );
    }

    #[test]
    fn traverses_sparse_position_row_groups_without_gaps_duplicates_or_reordering() {
        const ROW_GROUP_ROWS: i64 = 2_048;
        const ROW_GROUP_COUNT: i64 = 8;
        const WINDOW_ROWS: u32 = 512;

        let row_count = ROW_GROUP_ROWS * ROW_GROUP_COUNT;
        let source = write_window_traversal_fixture(row_count);
        let mut view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("sort_key"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");
        rewrite_position_index_with_row_groups(
            view.position_index_path(),
            (0..row_count).rev(),
            ROW_GROUP_ROWS as usize,
        );
        let position_file = File::open(view.position_index_path()).expect("position index file");
        view.position_metadata = ArrowReaderMetadata::load(&position_file, Default::default())
            .expect("rewritten position metadata");
        let index = inspect_local_source(view.position_index_path()).expect("position index");
        assert_eq!(index.row_group_count, ROW_GROUP_COUNT as usize);

        let mut actual = Vec::<i64>::with_capacity(row_count as usize);
        for offset in (0..row_count as u64).step_by(WINDOW_ROWS as usize) {
            let bytes = view
                .fetch_window(offset, WINDOW_ROWS)
                .expect("sorted window");
            for batch in StreamReader::try_new(Cursor::new(bytes), None).expect("Arrow stream") {
                let batch = batch.expect("Arrow batch");
                actual.extend_from_slice(
                    batch
                        .column(0)
                        .as_any()
                        .downcast_ref::<Int64Array>()
                        .expect("int64 id")
                        .values(),
                );
            }
        }

        assert_eq!(actual.len(), row_count as usize);
        if let Some((index, (actual, expected))) = actual
            .iter()
            .copied()
            .zip((0..row_count).rev())
            .enumerate()
            .find(|(_, (actual, expected))| actual != expected)
        {
            panic!("window traversal diverged at row {index}: expected {expected}, got {actual}");
        }
        let preserve_insertion_order: bool = view
            .source_connection
            .query_row(
                "SELECT current_setting('preserve_insertion_order')",
                [],
                |row| row.get(0),
            )
            .expect("window order setting");
        assert!(preserve_insertion_order);
    }

    #[test]
    fn far_dataset_position_page_reads_only_its_compact_index_row_group() {
        let index = NamedTempFile::new().expect("position index");
        rewrite_dataset_position_index_with_row_groups(index.path(), 4, 8);
        let file = File::open(index.path()).expect("position index file");
        let metadata =
            ArrowReaderMetadata::load(&file, Default::default()).expect("position index metadata");
        DATASET_POSITION_ROW_GROUP_READS.store(0, Ordering::Relaxed);
        DATASET_POSITION_DECODED_ROWS.store(0, Ordering::Relaxed);

        let positions =
            read_dataset_positions(index.path(), &metadata, 24, 4).expect("far position page");

        assert_eq!(
            positions,
            (24..28)
                .map(|native_row| DatasetRowPosition {
                    member_ordinal: 3,
                    native_row,
                    requested_order: native_row - 24,
                })
                .collect::<Vec<_>>()
        );
        assert_eq!(DATASET_POSITION_ROW_GROUP_READS.load(Ordering::Relaxed), 1);
        assert_eq!(DATASET_POSITION_DECODED_ROWS.load(Ordering::Relaxed), 4);
    }

    #[cfg(unix)]
    #[test]
    fn cached_parquet_metadata_survives_an_unreadable_footer() {
        let mut source = write_fixture();
        let view = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("label"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        )
        .expect("view builder")
        .build()
        .expect("prepared view");
        let first = view.fetch_window(0, 3).expect("initial window");
        source
            .as_file_mut()
            .seek(SeekFrom::End(-8))
            .expect("footer length offset");
        source
            .as_file_mut()
            .write_all(&[0xff; 4])
            .expect("corrupt footer length");
        source.as_file_mut().flush().expect("flush damaged footer");
        let repeated = view.fetch_window(0, 3).expect("cached metadata window");

        assert_eq!(repeated, first);
    }

    #[test]
    fn cancellation_before_build_never_publishes_an_index() {
        let source = write_fixture();
        let builder = DataViewBuilder::new(source.path().to_owned(), &[], &[]).expect("builder");
        let interrupt = builder.interrupt_handle();
        interrupt.interrupt();

        assert!(matches!(
            builder.build(),
            Err(DataViewError::Engine(DataWindowError::Cancelled))
        ));

        let builder = DataViewBuilder::new(source.path().to_owned(), &[], &[]).expect("builder");
        let interrupt = builder.interrupt_handle();
        assert!(matches!(
            builder.build_inner(|| {}, || interrupt.interrupt()),
            Err(DataViewError::Engine(DataWindowError::Cancelled))
        ));
    }

    #[test]
    fn interrupt_stops_an_executing_json_filter_scan() {
        let (_directory, source) = write_large_json_fixture();
        let builder = DataViewBuilder::new(
            source,
            &[DataFilter {
                field_path: field("payload"),
                json_target: Some(crate::JsonFieldTarget {
                    path: crate::JsonPath::new([crate::JsonPathSegment::Field("value".to_owned())]),
                    value_type: crate::JsonValueType::Number,
                }),
                operator: DataFilterOperator::GreaterThanOrEqual,
                values: vec!["0".to_owned()],
                match_case: false,
            }],
            &[],
        )
        .expect("JSON view builder");
        let position_index = builder.temporary_directory.path().join("positions.parquet");
        let interrupt = Arc::new(builder.interrupt_handle());
        let (execute_tx, execute_rx) = mpsc::sync_channel(0);
        let scan = thread::spawn(move || {
            builder.build_inner(
                move || execute_tx.send(()).expect("report JSON query execution"),
                || {},
            )
        });
        execute_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("JSON query reaches execution");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !position_index.exists() {
            assert!(
                !scan.is_finished(),
                "JSON scan finished before interruption"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "JSON scan did not start writing its position index"
            );
            thread::yield_now();
        }
        assert!(
            !scan.is_finished(),
            "JSON scan finished before interruption"
        );

        interrupt.interrupt();

        assert!(matches!(
            scan.join().expect("JSON scan thread"),
            Err(DataViewError::Engine(DataWindowError::Cancelled))
        ));
    }

    #[test]
    fn separates_memory_and_temporary_storage_failures_with_path_free_diagnostics() {
        let source = write_fixture();
        let builder = DataViewBuilder::new(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("label"),
                json_target: None,
                direction: DataSortDirection::Descending,
            }],
        )
        .expect("view builder");
        let summary = inspect_local_source(source.path()).expect("source summary");
        let facts = DataViewSourceFacts {
            schema: summary.schema.clone(),
            row_count: summary.row_count,
            size_bytes: summary.size_bytes,
            row_group_count: summary.row_group_count,
        };
        let failure = |message: String| {
            DuckDbError::DuckDBFailure(
                duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
                Some(message),
            )
        };
        let source_path = source.path().to_string_lossy();
        let temporary_directory = builder.temporary_directory.path().to_string_lossy();

        let memory = builder.classify_prepare_error(
            failure(format!(
                "Out of Memory Error: failed while reading {source_path}\n\nPossible solutions"
            )),
            &facts,
            false,
        );
        let DataViewError::MemoryExhausted(memory) = memory else {
            panic!("expected memory diagnostics");
        };
        assert_eq!(memory.operation, DataViewResourceOperation::Preparation);
        assert_eq!(memory.row_count, 2_000);
        assert!(memory.source_size_bytes > 0);
        assert_eq!(memory.row_group_count, 1);
        assert_eq!(memory.column_count, 2);
        assert_eq!(memory.filter_count, 0);
        assert_eq!(memory.sort_columns.len(), 1);
        assert_eq!(memory.sort_columns[0].physical_type, "BYTE_ARRAY");
        assert_eq!(
            memory.sort_columns[0].logical_type.as_deref(),
            Some("String")
        );
        assert_eq!(
            memory.sort_columns[0].direction,
            DataSortDirection::Descending
        );
        assert!(memory.message.contains("<source>"));
        assert!(!memory.message.contains(source_path.as_ref()));
        assert!(!memory.memory_limit.is_empty());
        assert!(!memory.max_temporary_directory_size.is_empty());
        assert!(memory.threads > 0);
        assert!(!memory.query_engine_version.is_empty());

        let storage = builder.classify_prepare_error(
            failure(format!(
                "Out of Memory Error: failed to offload {temporary_directory}/block; \
                 max_temp_directory_size was reached\n\nPossible solutions"
            )),
            &facts,
            false,
        );
        let DataViewError::TemporaryStorageExhausted(storage) = storage else {
            panic!("expected temporary storage diagnostics");
        };
        assert!(storage.message.contains("<temporary directory>"));
        assert!(!storage.message.contains(temporary_directory.as_ref()));
    }

    #[test]
    fn conversion_failures_are_invalid_filters_only_when_the_index_has_a_predicate() {
        let source = write_fixture();
        let without_filters =
            DataViewBuilder::new(source.path().to_owned(), &[], &[]).expect("view builder");
        let facts = without_filters.source.facts().expect("source facts");
        assert!(matches!(
            without_filters.classify_prepare_error(
                duckdb_failure("Conversion Error: independent failure".to_owned()),
                &facts,
                !without_filters.filters.is_empty(),
            ),
            DataViewError::Engine(DataWindowError::QueryFailed)
        ));

        let with_filters = DataViewBuilder::new(
            source.path().to_owned(),
            &[DataFilter {
                field_path: field("id"),
                json_target: None,
                operator: crate::DataFilterOperator::Equals,
                values: vec!["1".to_owned()],
                match_case: false,
            }],
            &[],
        )
        .expect("filtered view builder");
        let facts = with_filters.source.facts().expect("source facts");
        assert!(matches!(
            with_filters.classify_prepare_error(
                duckdb_failure("Conversion Error: predicate failure".to_owned()),
                &facts,
                !with_filters.filters.is_empty(),
            ),
            DataViewError::Engine(DataWindowError::InvalidFilter)
        ));
    }

    #[test]
    fn dataset_setup_query_failures_preserve_cancellation_and_resource_errors() {
        let (directory, mut reader) = write_dataset_fixture();
        let builder = DataViewBuilder::for_dataset(&reader, &[], &[], DataViewMemoryLimit::Mb384)
            .expect("dataset builder");
        let facts = builder.source.facts().expect("dataset facts");
        let member_path = directory.path().join("b.parquet");
        let resource = builder.classify_setup_error(
            DatasetSetupError::Query(duckdb_failure(format!(
                "Out of Memory Error: reading {}",
                member_path.display()
            ))),
            &facts,
        );
        let DataViewError::MemoryExhausted(diagnostics) = resource else {
            panic!("expected dataset setup memory diagnostics");
        };
        assert_eq!(
            diagnostics.operation,
            DataViewResourceOperation::Preparation
        );
        assert!(
            !diagnostics
                .message
                .contains(member_path.to_string_lossy().as_ref())
        );

        corrupt_dataset_member_data(&directory.path().join("a[1].parquet"));
        assert!(matches!(
            builder.classify_setup_error(
                DatasetSetupError::Query(duckdb_failure("independent setup failure".to_owned(),)),
                &facts,
            ),
            DataViewError::Engine(DataWindowError::QueryFailed)
        ));
        assert_eq!(
            reader.fetch(0, 8),
            Err(DatasetError::InvalidMember {
                member: "a[1].parquet".to_owned(),
            })
        );
        assert_eq!(
            reader.fetch(0, 8),
            Err(DatasetError::InvalidMember {
                member: "a[1].parquet".to_owned(),
            })
        );

        let (_cancelled_directory, cancelled_reader) = write_dataset_fixture();
        let cancelled =
            DataViewBuilder::for_dataset(&cancelled_reader, &[], &[], DataViewMemoryLimit::Mb384)
                .expect("dataset builder");
        let facts = cancelled.source.facts().expect("dataset facts");
        cancelled.interrupt_handle().interrupt();
        assert!(matches!(
            cancelled.classify_setup_error(
                DatasetSetupError::Query(duckdb_failure("query interrupted".to_owned())),
                &facts,
            ),
            DataViewError::Engine(DataWindowError::Cancelled)
        ));
    }

    #[test]
    fn dataset_window_classifies_changes_between_preflight_and_prepare() {
        let (directory, reader) = write_dataset_fixture();
        let view = DataViewBuilder::for_dataset(&reader, &[], &[], DataViewMemoryLimit::Mb384)
            .expect("dataset builder")
            .build()
            .expect("prepared dataset view");
        let removed = directory.path().join("a[1].parquet");
        let positions = read_dataset_positions(&view.position_index, &view.position_metadata, 0, 8)
            .expect("prepared positions");
        let DataViewSource::Dataset(dataset) = &view.source else {
            panic!("expected dataset source");
        };
        fs::remove_file(&removed).expect("remove after position lookup");
        let result = dataset
            .stage_sparse_window_while(
                &positions,
                &[field("id")],
                view.temporary_directory.path(),
                || true,
            )
            .map_err(dataset_view_error);
        assert!(matches!(
            result,
            Err(DataViewError::Engine(DataWindowError::SourceChanged))
        ));
        assert!(matches!(
            view.fetch_window(0, 8),
            Err(DataViewError::Engine(DataWindowError::SourceChanged))
        ));
    }

    #[test]
    fn dataset_window_prepare_resource_errors_use_window_diagnostics() {
        let (directory, reader) = write_dataset_fixture();
        let view = DataViewBuilder::for_dataset(&reader, &[], &[], DataViewMemoryLimit::Mb384)
            .expect("dataset builder")
            .build()
            .expect("prepared dataset view");
        let member_path = directory.path().join("a[1].parquet");
        let escaped_path = escape_test_glob_path(member_path.to_string_lossy().as_ref());

        let error = view.classify_sparse_query_error(duckdb_failure(format!(
            "Out of Memory Error: reading {}",
            escaped_path
        )));

        let DataViewError::MemoryExhausted(diagnostics) = error else {
            panic!("expected dataset window memory diagnostics");
        };
        assert_eq!(diagnostics.operation, DataViewResourceOperation::Window);
        assert!(
            !diagnostics
                .message
                .contains(member_path.to_string_lossy().as_ref())
        );
        assert!(!diagnostics.message.contains(&escaped_path));

        assert!(matches!(
            view.classify_window_setup_error(DatasetSetupError::Query(duckdb_failure(
                "independent setup failure".to_owned(),
            ))),
            DataViewError::Engine(DataWindowError::QueryFailed)
        ));
        let DataViewSource::Dataset(dataset) = &view.source else {
            panic!("expected dataset source");
        };
        assert_eq!(dataset.require_active(), Ok(()));
    }

    #[test]
    fn prepared_windows_keep_the_bounded_view_budget_and_resource_diagnostics() {
        let source = write_fixture();
        let builder = DataViewBuilder::with_memory_limit(
            source.path().to_owned(),
            &[],
            &[DataSort {
                field_path: field("label"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
            DataViewMemoryLimit::Mb768,
        )
        .expect("view builder");
        let preparation_memory = memory_size_in_bytes(&builder.resource_settings.memory_limit)
            .expect("preparation memory");
        assert!((preparation_memory - 768_000_000.0).abs() <= 1024.0 * 1024.0);
        assert_eq!(
            builder.resource_settings.threads,
            DataViewMemoryLimit::Mb768.worker_threads() as i64
        );
        let view = builder.build().expect("prepared view");
        let settings = read_resource_settings(&view.source_connection).expect("window settings");
        let temporary_directory: String = view
            .source_connection
            .query_row("SELECT current_setting('temp_directory')", [], |row| {
                row.get(0)
            })
            .expect("window temporary directory");
        let preserve_insertion_order: bool = view
            .source_connection
            .query_row(
                "SELECT current_setting('preserve_insertion_order')",
                [],
                |row| row.get(0),
            )
            .expect("window order setting");

        let window_memory = memory_size_in_bytes(&settings.memory_limit).expect("window memory");
        assert!((window_memory - 384_000_000.0).abs() <= 1024.0 * 1024.0);
        assert_eq!(settings.threads, 1);
        assert_eq!(
            PathBuf::from(temporary_directory),
            view.temporary_directory.path()
        );
        assert!(preserve_insertion_order);

        let source_path = source.path().to_string_lossy();
        let temporary_path = view.temporary_directory.path().to_string_lossy();
        let failure = DuckDbError::DuckDBFailure(
            duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
            Some(format!(
                "Out of Memory Error: reading {source_path} via {temporary_path}"
            )),
        );
        let DataViewError::MemoryExhausted(diagnostics) = classify_view_window_error(
            failure,
            &view.resource_diagnostics,
            &view.source,
            view.temporary_directory.path(),
        ) else {
            panic!("expected window memory diagnostics");
        };
        assert_eq!(diagnostics.operation, DataViewResourceOperation::Window);
        assert_eq!(diagnostics.memory_limit, settings.memory_limit);
        assert_eq!(diagnostics.threads, settings.threads);
        assert!(diagnostics.message.contains("<source>"));
        assert!(diagnostics.message.contains("<temporary directory>"));
        assert!(!diagnostics.message.contains(source_path.as_ref()));
        assert!(!diagnostics.message.contains(temporary_path.as_ref()));
    }

    #[test]
    fn limits_builder_memory_and_provides_a_spill_directory() {
        let builder = DataViewBuilder::new(PathBuf::from("unused.parquet"), &[], &[])
            .expect("view builder should start");
        let (
            memory_limit,
            temporary_directory,
            preserve_insertion_order,
            metadata_cache_enabled,
            max_temporary_directory_size,
            threads,
        ): (String, String, bool, bool, String, i64) = builder
            .connection
            .query_row(
                "SELECT current_setting('memory_limit'), current_setting('temp_directory'), \
                 current_setting('preserve_insertion_order'), current_setting('parquet_metadata_cache'), \
                 current_setting('max_temp_directory_size'), current_setting('threads')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("view resource settings should be readable");

        let memory_limit_bytes = memory_size_in_bytes(&memory_limit)
            .expect("DuckDB memory limit should use a recognized size unit");
        assert!(
            (memory_limit_bytes - 384_000_000.0).abs() <= 1024.0 * 1024.0,
            "DuckDB reported an unexpected memory limit: {memory_limit}"
        );
        assert_eq!(
            PathBuf::from(temporary_directory),
            builder.temporary_directory.path()
        );
        assert!(!preserve_insertion_order);
        assert!(metadata_cache_enabled);
        assert_eq!(
            builder.resource_settings.max_temporary_directory_size,
            max_temporary_directory_size
        );
        assert_eq!(builder.resource_settings.threads, threads);
        assert_eq!(threads, 1);
    }

    #[test]
    fn scales_preparation_workers_with_the_selected_memory_budget() {
        assert_eq!(DataViewMemoryLimit::Mb384.maximum_worker_threads(), 1);
        assert_eq!(DataViewMemoryLimit::Mb768.maximum_worker_threads(), 2);
        assert_eq!(DataViewMemoryLimit::Mb1536.maximum_worker_threads(), 4);
        assert_eq!(DataViewMemoryLimit::Mb3072.maximum_worker_threads(), 8);
    }

    #[test]
    fn keeps_spill_directory_outside_the_source_directory() {
        let source_directory = tempfile::tempdir().expect("source directory");
        let source_path = source_directory.path().join("source.parquet");
        let builder = DataViewBuilder::new(source_path, &[], &[]).expect("view builder");

        assert_ne!(
            builder.temporary_directory.path().parent(),
            Some(source_directory.path())
        );
        assert!(
            builder
                .temporary_directory
                .path()
                .file_name()
                .expect("spill directory name")
                .to_string_lossy()
                .starts_with("viewda-view-")
        );
    }

    #[test]
    fn interrupt_handle_stops_its_builder_connection_mid_scan() {
        let builder = DataViewBuilder::new(PathBuf::from("unused.parquet"), &[], &[])
            .expect("view builder should start");
        let interrupt = builder.interrupt_handle();
        let DataViewBuilder {
            connection,
            temporary_directory,
            ..
        } = builder;
        let (started_sender, started_receiver) = mpsc::sync_channel(0);
        let (finished_sender, finished_receiver) = mpsc::sync_channel(1);
        let scan = thread::spawn(move || {
            let _temporary_directory = temporary_directory;
            started_sender.send(()).expect("scan start receiver");
            let result = connection.query_row(
                "SELECT count(*) FROM range(100000000000) AS rows(value) WHERE hash(value) = 0",
                [],
                |row| row.get::<_, i64>(0),
            );
            finished_sender
                .send(result.is_err())
                .expect("scan result receiver");
        });

        started_receiver.recv().expect("scan should start");
        assert!(
            finished_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err(),
            "the scan must still be running before it is interrupted"
        );
        interrupt.interrupt();
        assert_eq!(
            finished_receiver.recv_timeout(Duration::from_secs(5)),
            Ok(true),
            "the builder's interrupt handle must stop its own active connection"
        );
        scan.join().expect("scan thread should stop");
    }

    #[test]
    fn renders_the_engine_order_with_quoted_names_nulls_last_and_file_tie_break() {
        let schema = vec![
            crate::SchemaField {
                name: "value\"quoted".to_owned(),
                physical_type: "INT64".to_owned(),
                logical_type: None,
                children: Vec::new(),
            },
            crate::SchemaField {
                name: "label".to_owned(),
                physical_type: "BYTE_ARRAY".to_owned(),
                logical_type: Some("String".to_owned()),
                children: Vec::new(),
            },
        ];

        assert_eq!(
            build_order_clause(
                &schema,
                &[
                    DataSort {
                        field_path: field("label"),
                        json_target: None,
                        direction: DataSortDirection::Descending,
                    },
                    DataSort {
                        field_path: field("value\"quoted"),
                        json_target: None,
                        direction: DataSortDirection::Ascending,
                    },
                ],
                "\"file_row_number\"",
            ),
            Ok(
                "\"label\" DESC NULLS LAST, \"value\"\"quoted\" ASC NULLS LAST, \"file_row_number\" ASC"
                    .to_owned()
            )
        );
    }

    #[test]
    fn json_sort_uses_text_for_mixed_values_and_requires_a_json_annotation() {
        let json = crate::SchemaField {
            name: "payload".to_owned(),
            physical_type: "BYTE_ARRAY".to_owned(),
            logical_type: Some("JSON".to_owned()),
            children: Vec::new(),
        };
        let target = crate::JsonFieldTarget {
            path: crate::JsonPath::new([crate::JsonPathSegment::Field("value".to_owned())]),
            value_type: crate::JsonValueType::Mixed,
        };
        let sort = DataSort {
            field_path: field("payload"),
            json_target: Some(target),
            direction: DataSortDirection::Ascending,
        };

        assert_eq!(
            build_order_clause(std::slice::from_ref(&json), std::slice::from_ref(&sort), "row"),
            Ok("json_extract_string(TRY_CAST(\"payload\" AS JSON), '$.\"value\"') ASC NULLS LAST, row ASC".to_owned())
        );
        assert_eq!(
            validate_sort(std::slice::from_ref(&json), std::slice::from_ref(&sort)),
            Ok(())
        );

        let text = crate::SchemaField {
            logical_type: Some("String".to_owned()),
            ..json
        };
        assert_eq!(
            validate_sort(&[text], &[sort]),
            Err(DataWindowError::InvalidSort)
        );
    }

    #[test]
    fn json_number_sort_uses_finite_order_with_an_exact_tie_breaker() {
        let schema = [crate::SchemaField {
            name: "payload".to_owned(),
            physical_type: "BYTE_ARRAY".to_owned(),
            logical_type: Some("JSON".to_owned()),
            children: Vec::new(),
        }];
        let sort = [DataSort {
            field_path: field("payload"),
            json_target: Some(crate::JsonFieldTarget {
                path: crate::JsonPath::new([crate::JsonPathSegment::Field("value".to_owned())]),
                value_type: crate::JsonValueType::Number,
            }),
            direction: DataSortDirection::Ascending,
        }];

        let order = build_order_clause(&schema, &sort, "row").expect("JSON numeric order");

        assert!(order.contains("isfinite"));
        assert!(order.contains("DECIMAL(38, 18)"));
        assert!(order.find("isfinite").unwrap() < order.find("DECIMAL(38, 18)").unwrap());
        assert!(!order.contains("COALESCE"));
        assert!(order.ends_with("row ASC"));
    }

    #[test]
    fn json_sort_identity_ignores_the_requested_value_type() {
        let schema = [crate::SchemaField {
            name: "payload".to_owned(),
            physical_type: "BYTE_ARRAY".to_owned(),
            logical_type: Some("JSON".to_owned()),
            children: Vec::new(),
        }];
        let path = crate::JsonPath::new([crate::JsonPathSegment::Field("value".to_owned())]);
        let sort = [
            DataSort {
                field_path: field("payload"),
                json_target: Some(crate::JsonFieldTarget {
                    path: path.clone(),
                    value_type: crate::JsonValueType::Number,
                }),
                direction: DataSortDirection::Ascending,
            },
            DataSort {
                field_path: field("payload"),
                json_target: Some(crate::JsonFieldTarget {
                    path,
                    value_type: crate::JsonValueType::Text,
                }),
                direction: DataSortDirection::Descending,
            },
        ];

        assert_eq!(
            validate_sort(&schema, &sort),
            Err(DataWindowError::InvalidSort)
        );
    }

    fn field(name: &str) -> FieldPath {
        FieldPath::new(vec![name.to_owned()])
    }

    fn write_fixture() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary source");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("label", DataType::Utf8, false),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from_iter_values(0..2_000)) as ArrayRef,
                Arc::new(StringArray::from_iter_values(
                    (0..2_000).map(|index| format!("label-{index:04}")),
                )) as ArrayRef,
            ],
        )
        .expect("record batch");
        let file = source.reopen().expect("fixture file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("write batch");
        writer.close().expect("write footer");
        source
    }

    fn write_large_json_fixture() -> (TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("JSON fixture directory");
        let path = directory.path().join("large-json.parquet");
        let connection = Connection::open_in_memory().expect("JSON fixture connection");
        connection
            .execute_batch(&format!(
                "COPY (SELECT range AS id, \
                 CAST(concat('{{\"value\":', CAST(range AS VARCHAR), '}}') AS JSON) AS payload \
                 FROM range(1000000)) TO {} (FORMAT PARQUET, COMPRESSION ZSTD)",
                quote_string_literal(path.to_str().expect("UTF-8 JSON fixture path")),
            ))
            .expect("large JSON fixture");
        (directory, path)
    }

    fn write_dataset_fixture() -> (tempfile::TempDir, DatasetWindowReader) {
        let directory = tempfile::tempdir().expect("dataset directory");
        for name in ["a[1].parquet", "b.parquet"] {
            let source = write_fixture();
            fs::copy(source.path(), directory.path().join(name)).expect("dataset member");
        }
        let source = crate::DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        while inspector
            .advance(2)
            .expect("dataset inspection")
            .summary
            .is_none()
        {}
        let reader = inspector.into_window_reader().expect("dataset reader");
        (directory, reader)
    }

    #[test]
    fn partition_pruned_dataset_view_checks_only_the_matching_member_batch() {
        let directory = tempfile::tempdir().expect("dataset directory");
        for (year, name) in [("2025", "kept.parquet"), ("2026", "pruned.parquet")] {
            let partition = directory.path().join(format!("year={year}"));
            fs::create_dir_all(&partition).expect("partition directory");
            let fixture = write_fixture();
            fs::copy(fixture.path(), partition.join(name)).expect("dataset member");
        }
        let source = crate::DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        while inspector
            .advance(2)
            .expect("dataset inspection")
            .summary
            .is_none()
        {}
        let reader = inspector.into_window_reader().expect("dataset reader");
        let identity_checks = source.identity_check_count();
        fs::remove_file(directory.path().join("year=2026/pruned.parquet"))
            .expect("remove pruned member");

        DataViewBuilder::for_dataset(
            &reader,
            &[DataFilter {
                field_path: field("year"),
                json_target: None,
                operator: DataFilterOperator::Equals,
                values: vec!["2025".to_owned()],
                match_case: false,
            }],
            &[DataSort {
                field_path: field("id"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
            DataViewMemoryLimit::Mb384,
        )
        .expect("pruned view builder")
        .build()
        .expect("pruned view");
        assert_eq!(
            source.identity_check_count() - identity_checks,
            2,
            "the matching member is checked before and after its staged read"
        );

        assert!(matches!(
            DataViewBuilder::for_dataset(
                &reader,
                &[DataFilter {
                    field_path: field("year"),
                    json_target: None,
                    operator: DataFilterOperator::Equals,
                    values: vec!["2026".to_owned()],
                    match_case: false,
                }],
                &[],
                DataViewMemoryLimit::Mb384,
            )
            .expect("changed-member view builder")
            .build(),
            Err(DataViewError::Engine(DataWindowError::SourceChanged))
        ));
    }

    fn corrupt_dataset_member_data(path: &Path) {
        let metadata = fs::metadata(path).expect("member metadata");
        let modified = metadata.modified().expect("member modification time");
        let reader = SerializedFileReader::new(File::open(path).expect("member file"))
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

    fn duckdb_failure(message: String) -> DuckDbError {
        DuckDbError::DuckDBFailure(
            duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
            Some(message),
        )
    }

    fn escape_test_glob_path(path: &str) -> String {
        let mut escaped = String::new();
        for character in path.chars() {
            match character {
                '[' => escaped.push_str("[[]"),
                ']' => escaped.push_str("[]]"),
                _ => escaped.push(character),
            }
        }
        escaped
    }

    fn write_utc_timestamp_fixture() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary source");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new(
                "utc_at",
                DataType::Timestamp(
                    arrow_schema::TimeUnit::Microsecond,
                    Some(Arc::<str>::from("UTC")),
                ),
                false,
            ),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from_iter_values(0..3)) as ArrayRef,
                Arc::new(
                    TimestampMicrosecondArray::from_iter_values([
                        1_700_000_000_000_000,
                        1_700_000_000_000_001,
                        1_700_000_000_000_002,
                    ])
                    .with_timezone("UTC"),
                ) as ArrayRef,
            ],
        )
        .expect("timestamp batch");
        let file = source.reopen().expect("timestamp fixture file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("write timestamp batch");
        writer.close().expect("write timestamp footer");
        source
    }

    fn write_nested_value_fixture() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary source");
        let amount = Decimal128Array::from(vec![1_234_i128, -5_678])
            .with_precision_and_scale(9, 2)
            .expect("decimal precision");
        let occurred_at = TimestampMicrosecondArray::from_iter_values([
            1_700_000_000_000_000,
            1_700_000_000_000_001,
        ])
        .with_timezone("UTC");
        let payload = StructArray::from(vec![
            (
                Arc::new(Field::new("amount", DataType::Decimal128(9, 2), false)),
                Arc::new(amount) as ArrayRef,
            ),
            (
                Arc::new(Field::new(
                    "occurred_at",
                    DataType::Timestamp(
                        arrow_schema::TimeUnit::Microsecond,
                        Some(Arc::<str>::from("UTC")),
                    ),
                    false,
                )),
                Arc::new(occurred_at) as ArrayRef,
            ),
            (
                Arc::new(Field::new("blob", DataType::Binary, false)),
                Arc::new(BinaryArray::from(vec![b"\0abc".as_slice(), &[0xff]])) as ArrayRef,
            ),
        ]);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new(
                "payload",
                DataType::Struct(Fields::from(payload.fields().to_vec())),
                false,
            ),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(vec![0, 1])) as ArrayRef,
                Arc::new(payload) as ArrayRef,
            ],
        )
        .expect("nested value batch");
        let file = source.reopen().expect("nested value fixture file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("write nested value batch");
        writer.close().expect("write nested value footer");
        source
    }

    fn decode_one_window(bytes: Vec<u8>, label: &str) -> RecordBatch {
        StreamReader::try_new(Cursor::new(bytes), None)
            .unwrap_or_else(|_| panic!("{label} Arrow stream"))
            .next()
            .unwrap_or_else(|| panic!("{label} Arrow batch"))
            .unwrap_or_else(|_| panic!("valid {label} Arrow batch"))
    }

    #[derive(Debug, PartialEq)]
    struct NestedValueSnapshot {
        types: Vec<(String, DataType)>,
        amounts: Vec<i128>,
        timestamps: Vec<i64>,
        binary: Vec<Vec<u8>>,
    }

    fn nested_value_snapshot(batch: &RecordBatch, column: usize) -> NestedValueSnapshot {
        let payload = batch
            .column(column)
            .as_any()
            .downcast_ref::<StructArray>()
            .expect("payload struct");
        let amount = payload
            .column_by_name("amount")
            .and_then(|value| value.as_any().downcast_ref::<Decimal128Array>())
            .expect("payload decimal");
        let occurred_at = payload
            .column_by_name("occurred_at")
            .and_then(|value| value.as_any().downcast_ref::<TimestampMicrosecondArray>())
            .expect("payload timestamp");
        let blob = payload
            .column_by_name("blob")
            .and_then(|value| value.as_any().downcast_ref::<BinaryArray>())
            .expect("payload binary");
        NestedValueSnapshot {
            types: payload
                .fields()
                .iter()
                .map(|field| (field.name().clone(), field.data_type().clone()))
                .collect(),
            amounts: amount.values().to_vec(),
            timestamps: occurred_at.values().to_vec(),
            binary: (0..blob.len())
                .map(|index| blob.value(index).to_vec())
                .collect(),
        }
    }

    fn write_window_traversal_fixture(row_count: i64) -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary source");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("sort_key", DataType::Int64, false),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from_iter_values(0..row_count)) as ArrayRef,
                Arc::new(Int64Array::from_iter_values((0..row_count).rev())) as ArrayRef,
            ],
        )
        .expect("window traversal batch");
        let file = source.reopen().expect("fixture file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("write batch");
        writer.close().expect("write footer");
        source
    }

    fn rewrite_position_index_with_row_groups(
        path: &Path,
        positions: impl Iterator<Item = i64>,
        row_group_rows: usize,
    ) {
        let positions = positions.collect::<Vec<_>>();
        let schema = Arc::new(Schema::new(vec![Field::new(
            POSITION_COLUMN,
            DataType::Int64,
            false,
        )]));
        let file = fs::File::create(path).expect("replace position index");
        let mut writer =
            ArrowWriter::try_new(file, Arc::clone(&schema), None).expect("position index writer");
        for row_group in positions.chunks(row_group_rows) {
            let batch = RecordBatch::try_new(
                Arc::clone(&schema),
                vec![Arc::new(Int64Array::from_iter_values(row_group.iter().copied())) as ArrayRef],
            )
            .expect("position row group");
            writer.write(&batch).expect("write position row group");
            writer.flush().expect("flush position row group");
        }
        writer.close().expect("write position index footer");
    }

    fn rewrite_dataset_position_index_with_row_groups(
        path: &Path,
        row_group_count: u64,
        rows_per_group: u64,
    ) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("__viewda_member_ordinal", DataType::UInt64, false),
            Field::new("__viewda_native_row", DataType::Int64, false),
        ]));
        let file = fs::File::create(path).expect("replace dataset position index");
        let mut writer =
            ArrowWriter::try_new(file, Arc::clone(&schema), None).expect("position index writer");
        for member_ordinal in 0..row_group_count {
            let start = member_ordinal * rows_per_group;
            let batch = RecordBatch::try_new(
                Arc::clone(&schema),
                vec![
                    Arc::new(UInt64Array::from(vec![
                        member_ordinal;
                        rows_per_group as usize
                    ])),
                    Arc::new(Int64Array::from_iter_values(
                        start as i64..(start + rows_per_group) as i64,
                    )),
                ],
            )
            .expect("dataset position row group");
            writer.write(&batch).expect("write position row group");
            writer.flush().expect("flush position row group");
        }
        writer.close().expect("write position index footer");
    }

    fn memory_size_in_bytes(value: &str) -> Option<f64> {
        let amount_end = value
            .char_indices()
            .find_map(|(index, character)| {
                (!character.is_ascii_digit() && character != '.').then_some(index)
            })
            .unwrap_or(value.len());
        let amount = value[..amount_end].parse::<f64>().ok()?;
        let multiplier = match value[amount_end..].trim() {
            "B" => 1.0,
            "KB" => 1_000.0,
            "MB" => 1_000_000.0,
            "GB" => 1_000_000_000.0,
            "KiB" => 1024.0,
            "MiB" => 1024.0 * 1024.0,
            "GiB" => 1024.0 * 1024.0 * 1024.0,
            _ => return None,
        };
        Some(amount * multiplier)
    }
}
