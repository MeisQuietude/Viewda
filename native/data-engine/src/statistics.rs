use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use duckdb::{Config, Connection, InterruptHandle, params_from_iter, types::Value};
use serde::Serialize;
use tempfile::TempDir;
use thiserror::Error;

use crate::{
    FieldPath,
    dataset::{DatasetError, DatasetQuerySource, DatasetSetupError, DatasetWindowReader},
    field_path::{field_path_expression, resolve_field_path},
    source::{SourceError, inspect_local_source_for_query, open_local_source},
    view::create_temporary_directory,
};

const QUERY_MEMORY_LIMIT: &str = "384MB";

/// A handle for cancelling an in-flight statistics scan.
pub struct StatisticsInterruptHandle {
    inner: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

impl StatisticsInterruptHandle {
    /// Interrupts the active scan, or does nothing after its reader is dropped.
    /// Statistics keep their existing error surface, so an interrupted scan
    /// returns [`ColumnStatisticsError::QueryFailed`].
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.inner.interrupt();
    }
}

/// Statistics computed by one scan of a selected column.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStatistics {
    /// Minimum non-null value formatted by the query engine.
    pub minimum: Option<String>,
    /// Maximum non-null value formatted by the query engine.
    pub maximum: Option<String>,
    /// Whether this result includes minimum and maximum values.
    pub min_max_computed: bool,
    /// Fraction of rows whose selected value is null.
    pub null_share: f64,
    /// Rows whose selected value is null.
    pub null_count: u64,
    /// Approximate number of distinct non-null values when measured for this result.
    pub approximate_distinct_count: Option<u64>,
    /// Length or pair-count distribution for list and map fields.
    pub container_count: Option<ContainerCountStatistics>,
}

/// Cardinality facts for a list's elements or a map's key-value pairs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCountStatistics {
    /// Smallest non-null container cardinality.
    pub minimum: Option<u64>,
    /// Mean non-null container cardinality.
    pub average: Option<f64>,
    /// Largest non-null container cardinality.
    pub maximum: Option<u64>,
    /// Non-null containers with zero elements or pairs.
    pub empty_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerCountKind {
    List,
    Map,
}

/// Stable failures from a column-statistics request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ColumnStatisticsError {
    /// The selected source no longer exists.
    #[error("The selected file no longer exists.")]
    NotFound,
    /// The operating system denied access to the selected source.
    #[error("Viewda does not have permission to read the selected file.")]
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
    /// The source or result cannot be represented safely.
    #[error("Statistics are not supported for this column.")]
    Unsupported,
    /// The scan exceeded the resources available to the query engine.
    #[error("There is not enough memory to compute these statistics.")]
    ResourceExhausted,
    /// DuckDB could not complete the statistics query.
    #[error("The query engine could not compute these statistics.")]
    QueryFailed,
    /// The packaged DuckDB library could not start.
    #[error("The packaged query engine could not start.")]
    QueryEngineUnavailable,
}

/// Owns the isolated DuckDB connection used by one statistics scan.
pub struct ColumnStatisticsReader {
    source: ColumnStatisticsSource,
    connection: Connection,
    _temporary_directory: TempDir,
    cancelled: Arc<AtomicBool>,
}

enum ColumnStatisticsSource {
    File(PathBuf),
    Dataset(Box<DatasetQuerySource>),
}

impl ColumnStatisticsReader {
    /// Creates a statistics reader that cannot block the grid's connection.
    pub fn new(source_path: PathBuf) -> Result<Self, ColumnStatisticsError> {
        Self::with_source(ColumnStatisticsSource::File(source_path))
    }

    /// Creates a statistics reader for one completed fixed dataset.
    pub fn for_dataset(reader: &DatasetWindowReader) -> Result<Self, ColumnStatisticsError> {
        Self::for_dataset_while(reader, || true)
    }

    /// Creates a dataset statistics reader while its source session remains active.
    pub fn for_dataset_while(
        reader: &DatasetWindowReader,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, ColumnStatisticsError> {
        let source = reader
            .query_source_while(&mut keep_going)
            .map_err(dataset_statistics_error)?;
        let statistics = Self::with_source(ColumnStatisticsSource::Dataset(Box::new(source)))?;
        if !keep_going() {
            return Err(ColumnStatisticsError::QueryFailed);
        }
        Ok(statistics)
    }

    fn with_source(source: ColumnStatisticsSource) -> Result<Self, ColumnStatisticsError> {
        let is_dataset = matches!(source, ColumnStatisticsSource::Dataset(_));
        let temporary_directory = create_temporary_directory("viewda-statistics-")
            .map_err(statistics_temporary_directory_error)?;
        let temporary_directory_path = temporary_directory
            .path()
            .to_str()
            .ok_or(ColumnStatisticsError::QueryEngineUnavailable)?;
        let config = Config::default()
            .enable_object_cache(!is_dataset)
            .and_then(|config| config.max_memory(QUERY_MEMORY_LIMIT))
            .and_then(|config| config.with("temp_directory", temporary_directory_path))
            .map_err(|_| ColumnStatisticsError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| ColumnStatisticsError::QueryEngineUnavailable)?;
        connection
            .execute_batch(if is_dataset {
                "SET parquet_metadata_cache = false"
            } else {
                "SET parquet_metadata_cache = true"
            })
            .map_err(|_| ColumnStatisticsError::QueryEngineUnavailable)?;
        Ok(Self {
            source,
            connection,
            _temporary_directory: temporary_directory,
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Returns a thread-safe handle for interrupting this reader's active scan.
    pub fn interrupt_handle(&self) -> StatisticsInterruptHandle {
        StatisticsInterruptHandle {
            inner: self.connection.interrupt_handle(),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Scans one trusted schema column and computes the requested aggregates together.
    pub fn fetch(
        self,
        field_path: &FieldPath,
        include_min_max: bool,
    ) -> Result<ColumnStatistics, ColumnStatisticsError> {
        self.fetch_checked(field_path, include_min_max, || {})
    }

    fn fetch_checked(
        self,
        field_path: &FieldPath,
        include_min_max: bool,
        after_setup: impl FnOnce(),
    ) -> Result<ColumnStatistics, ColumnStatisticsError> {
        self.require_active()?;
        let (relation, parameters, container_kind) = match &self.source {
            ColumnStatisticsSource::File(source_path) => {
                let (source, _) =
                    open_local_source(source_path).map_err(ColumnStatisticsError::from)?;
                drop(source);
                let path = source_path
                    .to_str()
                    .ok_or(ColumnStatisticsError::Unsupported)?;
                let summary = inspect_local_source_for_query(source_path)
                    .map_err(ColumnStatisticsError::from)?;
                let resolved = resolve_field_path(&summary.schema, field_path)
                    .ok_or(ColumnStatisticsError::Unsupported)?;
                (
                    "read_parquet(?)".to_owned(),
                    vec![Value::Text(path.to_owned())],
                    container_count_kind(resolved.field),
                )
            }
            ColumnStatisticsSource::Dataset(dataset) => {
                let resolved = resolve_field_path(dataset.schema(), field_path)
                    .ok_or(ColumnStatisticsError::Unsupported)?;
                let container_kind = container_count_kind(resolved.field);
                dataset
                    .install_while(&self.connection, || !self.cancelled.load(Ordering::Acquire))
                    .map_err(|error| self.classify_setup_error(error))?;
                after_setup();
                return self.fetch_dataset(dataset, field_path, include_min_max, container_kind);
            }
        };
        after_setup();
        self.require_active()?;
        let root = format!(
            "source.{}",
            quote_identifier(
                field_path
                    .segments()
                    .first()
                    .ok_or(ColumnStatisticsError::Unsupported)?,
            )
        );
        let identifier =
            field_path_expression(field_path, &root).ok_or(ColumnStatisticsError::Unsupported)?;
        if let Some(kind) = container_kind {
            return self.fetch_container(&relation, &parameters, &identifier, kind);
        }
        let (minimum, maximum) = if include_min_max {
            (
                format!("CAST(min({identifier}) AS VARCHAR)"),
                format!("CAST(max({identifier}) AS VARCHAR)"),
            )
        } else {
            ("NULL::VARCHAR".to_owned(), "NULL::VARCHAR".to_owned())
        };
        let query = format!(
            "SELECT {minimum}, {maximum}, \
             count(*) - count({identifier}), \
             approx_count_distinct({identifier}), count(*) \
             FROM {relation} source"
        );
        let mut statement = self
            .connection
            .prepare(&query)
            .map_err(|error| self.classify_scan_error(error))?;
        self.require_active()?;
        let (minimum, maximum, null_count, approximate_distinct_count, row_count) = statement
            .query_row(params_from_iter(parameters.iter()), |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| self.classify_scan_error(error))?;
        self.require_active()?;
        if let ColumnStatisticsSource::Dataset(dataset) = &self.source {
            dataset
                .require_active_while(|| !self.cancelled.load(Ordering::Acquire))
                .map_err(dataset_statistics_error)?;
        }
        self.require_active()?;
        column_statistics(
            (
                minimum,
                maximum,
                null_count,
                approximate_distinct_count,
                row_count,
            ),
            include_min_max,
        )
    }

    fn fetch_dataset(
        &self,
        dataset: &DatasetQuerySource,
        field_path: &FieldPath,
        include_min_max: bool,
        container_kind: Option<ContainerCountKind>,
    ) -> Result<ColumnStatistics, ColumnStatisticsError> {
        self.require_active()?;
        let root = format!(
            "source.{}",
            quote_identifier(
                field_path
                    .segments()
                    .first()
                    .ok_or(ColumnStatisticsError::Unsupported)?,
            )
        );
        let identifier =
            field_path_expression(field_path, &root).ok_or(ColumnStatisticsError::Unsupported)?;
        if let Some(kind) = container_kind {
            return self.fetch_dataset_container(dataset, &identifier, kind);
        }
        let state_projection = statistics_state_projection(&identifier, include_min_max);
        let empty_relation = dataset
            .sparse_empty_relation_sql()
            .map_err(dataset_statistics_error)?;
        self.connection
            .execute_batch(&format!(
                "CREATE TEMP TABLE __viewda_statistics_accumulator AS \
                 SELECT {state_projection} FROM {empty_relation} source"
            ))
            .map_err(|error| self.classify_scan_error(error))?;

        let combine_projection = statistics_combine_projection(include_min_max);
        let mut cursor = dataset.candidate_batches(&[]);
        while dataset
            .bind_next_candidate_batch(&self.connection, &mut cursor, || {
                !self.cancelled.load(Ordering::Acquire)
            })
            .map_err(|error| self.classify_setup_error(error))?
        {
            dataset
                .validate_bound_members_while(|| !self.cancelled.load(Ordering::Acquire))
                .map_err(dataset_statistics_error)?;
            self.require_active()?;
            self.connection
                .execute_batch(&format!(
                    "CREATE OR REPLACE TEMP TABLE __viewda_statistics_accumulator AS \
                     SELECT {combine_projection} \
                     FROM __viewda_statistics_accumulator accumulator CROSS JOIN (\
                       SELECT {state_projection} FROM {} source\
                     ) batch",
                    dataset.relation_sql(),
                ))
                .map_err(|error| self.classify_scan_error(error))?;
            self.require_active()?;
            dataset
                .validate_bound_members_while(|| !self.cancelled.load(Ordering::Acquire))
                .map_err(dataset_statistics_error)?;
        }

        let (minimum, maximum) = if include_min_max {
            ("CAST(minimum AS VARCHAR)", "CAST(maximum AS VARCHAR)")
        } else {
            ("NULL::VARCHAR", "NULL::VARCHAR")
        };
        let query = format!(
            "SELECT {minimum}, {maximum}, finalize(rows) - finalize(non_null), \
                    finalize(distinct_values), finalize(rows) \
             FROM __viewda_statistics_accumulator"
        );
        let result = self
            .connection
            .query_row(&query, [], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| self.classify_scan_error(error))?;
        self.require_active()?;
        dataset
            .require_active_while(|| !self.cancelled.load(Ordering::Acquire))
            .map_err(dataset_statistics_error)?;
        column_statistics(result, include_min_max)
    }

    fn fetch_container(
        &self,
        relation: &str,
        parameters: &[Value],
        identifier: &str,
        kind: ContainerCountKind,
    ) -> Result<ColumnStatistics, ColumnStatisticsError> {
        let query = container_statistics_query(relation, identifier, kind);
        let mut statement = self
            .connection
            .prepare(&query)
            .map_err(|error| self.classify_scan_error(error))?;
        self.require_active()?;
        let result = statement
            .query_row(
                params_from_iter(parameters.iter()),
                read_container_statistics_row,
            )
            .map_err(|error| self.classify_scan_error(error))?;
        self.require_active()?;
        container_statistics(result)
    }

    fn fetch_dataset_container(
        &self,
        dataset: &DatasetQuerySource,
        identifier: &str,
        kind: ContainerCountKind,
    ) -> Result<ColumnStatistics, ColumnStatisticsError> {
        let mut aggregate = ContainerStatisticsAggregate::default();
        let mut cursor = dataset.candidate_batches(&[]);
        while dataset
            .bind_next_candidate_batch(&self.connection, &mut cursor, || {
                !self.cancelled.load(Ordering::Acquire)
            })
            .map_err(|error| self.classify_setup_error(error))?
        {
            dataset
                .validate_bound_members_while(|| !self.cancelled.load(Ordering::Acquire))
                .map_err(dataset_statistics_error)?;
            self.require_active()?;
            let query = container_statistics_query(&dataset.relation_sql(), identifier, kind);
            let result = self
                .connection
                .query_row(&query, [], read_container_statistics_row)
                .map_err(|error| self.classify_scan_error(error))?;
            aggregate.add(result)?;
            self.require_active()?;
            dataset
                .validate_bound_members_while(|| !self.cancelled.load(Ordering::Acquire))
                .map_err(dataset_statistics_error)?;
        }
        dataset
            .require_active_while(|| !self.cancelled.load(Ordering::Acquire))
            .map_err(dataset_statistics_error)?;
        self.require_active()?;
        container_statistics(aggregate.finish()?)
    }

    fn require_active(&self) -> Result<(), ColumnStatisticsError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ColumnStatisticsError::QueryFailed)
        } else {
            Ok(())
        }
    }

    fn classify_setup_error(&self, error: DatasetSetupError) -> ColumnStatisticsError {
        if self.cancelled.load(Ordering::Acquire) {
            ColumnStatisticsError::QueryFailed
        } else {
            dataset_setup_statistics_error(error)
        }
    }

    fn classify_scan_error(&self, error: duckdb::Error) -> ColumnStatisticsError {
        classify_statistics_scan_error(&self.source, error, &self.cancelled)
    }
}

fn statistics_state_projection(identifier: &str, include_min_max: bool) -> String {
    let min_max = include_min_max.then(|| {
        format!(
            "min({identifier}) AS minimum, \
             max({identifier}) AS maximum, "
        )
    });
    format!(
        "{}count(*) EXPORT_STATE AS rows, \
         count({identifier}) EXPORT_STATE AS non_null, \
         approx_count_distinct({identifier}) EXPORT_STATE AS distinct_values",
        min_max.as_deref().unwrap_or("")
    )
}

fn statistics_combine_projection(include_min_max: bool) -> String {
    let min_max = include_min_max.then_some(
        "least(accumulator.minimum, batch.minimum) AS minimum, \
         greatest(accumulator.maximum, batch.maximum) AS maximum, ",
    );
    format!(
        "{}combine(accumulator.rows, batch.rows) AS rows, \
         combine(accumulator.non_null, batch.non_null) AS non_null, \
         combine(accumulator.distinct_values, batch.distinct_values) AS distinct_values",
        min_max.unwrap_or("")
    )
}

type ContainerStatisticsRow = (Option<i64>, Option<i64>, Option<f64>, i64, i64, i64);

#[derive(Default)]
struct ContainerStatisticsAggregate {
    minimum: Option<i64>,
    maximum: Option<i64>,
    total: f64,
    non_null_count: u64,
    empty_count: u64,
    null_count: u64,
}

impl ContainerStatisticsAggregate {
    fn add(&mut self, row: ContainerStatisticsRow) -> Result<(), ColumnStatisticsError> {
        let (minimum, maximum, total, non_null_count, empty_count, null_count) = row;
        self.minimum = self.minimum.into_iter().chain(minimum).min();
        self.maximum = self.maximum.into_iter().chain(maximum).max();
        self.total += total.unwrap_or(0.0);
        self.non_null_count = self
            .non_null_count
            .checked_add(nonnegative_u64(non_null_count)?)
            .ok_or(ColumnStatisticsError::Unsupported)?;
        self.empty_count = self
            .empty_count
            .checked_add(nonnegative_u64(empty_count)?)
            .ok_or(ColumnStatisticsError::Unsupported)?;
        self.null_count = self
            .null_count
            .checked_add(nonnegative_u64(null_count)?)
            .ok_or(ColumnStatisticsError::Unsupported)?;
        Ok(())
    }

    fn finish(self) -> Result<ContainerStatisticsRow, ColumnStatisticsError> {
        Ok((
            self.minimum,
            self.maximum,
            Some(self.total),
            i64::try_from(self.non_null_count).map_err(|_| ColumnStatisticsError::Unsupported)?,
            i64::try_from(self.empty_count).map_err(|_| ColumnStatisticsError::Unsupported)?,
            i64::try_from(self.null_count).map_err(|_| ColumnStatisticsError::Unsupported)?,
        ))
    }
}

fn container_count_kind(field: &crate::SchemaField) -> Option<ContainerCountKind> {
    match field.logical_type.as_deref() {
        Some("List") => Some(ContainerCountKind::List),
        Some("Map") => Some(ContainerCountKind::Map),
        _ => None,
    }
}

fn container_statistics_query(
    relation: &str,
    identifier: &str,
    kind: ContainerCountKind,
) -> String {
    let count = match kind {
        ContainerCountKind::List => format!("length({identifier})"),
        ContainerCountKind::Map => format!("cardinality({identifier})"),
    };
    format!(
        "SELECT min(value_count), max(value_count), sum(value_count)::DOUBLE, \
                count(value_count), count(*) FILTER (WHERE value_count = 0), \
                count(*) - count(value_count) \
         FROM (SELECT {count} AS value_count FROM {relation} source) container_values"
    )
}

fn read_container_statistics_row(row: &duckdb::Row<'_>) -> duckdb::Result<ContainerStatisticsRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

fn container_statistics(
    row: ContainerStatisticsRow,
) -> Result<ColumnStatistics, ColumnStatisticsError> {
    let (minimum, maximum, total, non_null_count, empty_count, null_count) = row;
    let minimum = minimum.map(nonnegative_u64).transpose()?;
    let maximum = maximum.map(nonnegative_u64).transpose()?;
    let non_null_count = nonnegative_u64(non_null_count)?;
    let empty_count = nonnegative_u64(empty_count)?;
    let null_count = nonnegative_u64(null_count)?;
    let row_count = non_null_count
        .checked_add(null_count)
        .ok_or(ColumnStatisticsError::Unsupported)?;
    Ok(ColumnStatistics {
        minimum: None,
        maximum: None,
        min_max_computed: false,
        null_share: if row_count == 0 {
            0.0
        } else {
            null_count as f64 / row_count as f64
        },
        null_count,
        approximate_distinct_count: None,
        container_count: Some(ContainerCountStatistics {
            minimum,
            average: (non_null_count > 0).then(|| total.unwrap_or(0.0) / non_null_count as f64),
            maximum,
            empty_count,
        }),
    })
}

fn nonnegative_u64(value: i64) -> Result<u64, ColumnStatisticsError> {
    u64::try_from(value).map_err(|_| ColumnStatisticsError::Unsupported)
}

fn column_statistics(
    result: (Option<String>, Option<String>, i64, i64, i64),
    include_min_max: bool,
) -> Result<ColumnStatistics, ColumnStatisticsError> {
    let (minimum, maximum, null_count, approximate_distinct_count, row_count) = result;
    let null_count = u64::try_from(null_count).map_err(|_| ColumnStatisticsError::Unsupported)?;
    let approximate_distinct_count = u64::try_from(approximate_distinct_count)
        .map_err(|_| ColumnStatisticsError::Unsupported)?;
    let row_count = u64::try_from(row_count).map_err(|_| ColumnStatisticsError::Unsupported)?;
    Ok(ColumnStatistics {
        minimum,
        maximum,
        min_max_computed: include_min_max,
        null_share: if row_count == 0 {
            0.0
        } else {
            null_count as f64 / row_count as f64
        },
        null_count,
        approximate_distinct_count: Some(approximate_distinct_count),
        container_count: None,
    })
}

fn statistics_temporary_directory_error(error: crate::DataWindowError) -> ColumnStatisticsError {
    match error {
        crate::DataWindowError::NotFound => ColumnStatisticsError::NotFound,
        crate::DataWindowError::PermissionDenied => ColumnStatisticsError::PermissionDenied,
        crate::DataWindowError::ResourceExhausted => ColumnStatisticsError::ResourceExhausted,
        _ => ColumnStatisticsError::QueryEngineUnavailable,
    }
}

fn dataset_setup_statistics_error(error: DatasetSetupError) -> ColumnStatisticsError {
    match error {
        DatasetSetupError::Dataset(error) => dataset_statistics_error(error),
        DatasetSetupError::Query(error) => classify_query_error(error),
    }
}

fn dataset_statistics_error(error: DatasetError) -> ColumnStatisticsError {
    match error {
        DatasetError::NotFound => ColumnStatisticsError::NotFound,
        DatasetError::PermissionDenied | DatasetError::MemberPermissionDenied { .. } => {
            ColumnStatisticsError::PermissionDenied
        }
        DatasetError::SourceChanged { .. } => ColumnStatisticsError::SourceChanged,
        DatasetError::InvalidMember { .. } => ColumnStatisticsError::CorruptSource,
        DatasetError::Window { error } => match error {
            crate::DataWindowError::NotFound => ColumnStatisticsError::NotFound,
            crate::DataWindowError::PermissionDenied => ColumnStatisticsError::PermissionDenied,
            crate::DataWindowError::SourceChanged => ColumnStatisticsError::SourceChanged,
            crate::DataWindowError::NotParquet | crate::DataWindowError::CorruptSource => {
                ColumnStatisticsError::CorruptSource
            }
            crate::DataWindowError::ResourceExhausted => ColumnStatisticsError::ResourceExhausted,
            crate::DataWindowError::QueryEngineUnavailable => {
                ColumnStatisticsError::QueryEngineUnavailable
            }
            crate::DataWindowError::QueryFailed => ColumnStatisticsError::QueryFailed,
            _ => ColumnStatisticsError::Unsupported,
        },
        _ => ColumnStatisticsError::Unsupported,
    }
}

impl From<SourceError> for ColumnStatisticsError {
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

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn classify_query_error(error: duckdb::Error) -> ColumnStatisticsError {
    classify_query_error_category(&error).unwrap_or(ColumnStatisticsError::QueryFailed)
}

fn classify_query_error_category(error: &duckdb::Error) -> Option<ColumnStatisticsError> {
    let duckdb::Error::DuckDBFailure(_, Some(message)) = error else {
        return None;
    };

    // duckdb 1.10505 collapses execution categories into one error variant;
    // its message prefix is the only category exposed by this pinned binding.
    if message.starts_with("Out of Memory Error:") {
        Some(ColumnStatisticsError::ResourceExhausted)
    } else if message.starts_with("Binder Error:")
        || message.starts_with("Invalid type Error:")
        || message.starts_with("Not implemented Error:")
    {
        Some(ColumnStatisticsError::Unsupported)
    } else {
        None
    }
}

fn classify_statistics_scan_error(
    source: &ColumnStatisticsSource,
    error: duckdb::Error,
    cancelled: &AtomicBool,
) -> ColumnStatisticsError {
    if cancelled.load(Ordering::Acquire) {
        return ColumnStatisticsError::QueryFailed;
    }
    if let Some(error) = classify_query_error_category(&error) {
        return error;
    }
    match source {
        ColumnStatisticsSource::File(_) => ColumnStatisticsError::QueryFailed,
        ColumnStatisticsSource::Dataset(dataset) => {
            dataset_statistics_error(dataset.classify_query_failure(error, false))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs::File, sync::Arc};

    use arrow_array::{
        Array, ArrayRef, Int64Array, ListArray, RecordBatch, StringArray, StructArray,
        builder::{Int64Builder, MapBuilder, NullBufferBuilder, StringBuilder},
        types::Int64Type,
    };
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::arrow::ArrowWriter;
    use tempfile::{NamedTempFile, tempdir};

    use super::*;
    use crate::DatasetSource;

    #[test]
    fn computes_requested_statistics_in_one_column_scan() {
        let source = write_statistics_parquet();
        let reader = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("statistics reader should start");

        assert_eq!(
            reader
                .fetch(&FieldPath::from("value"), true)
                .expect("statistics should load"),
            ColumnStatistics {
                minimum: Some("2".to_owned()),
                maximum: Some("7".to_owned()),
                min_max_computed: true,
                null_share: 0.25,
                null_count: 1,
                approximate_distinct_count: Some(2),
                container_count: None,
            }
        );
    }

    #[test]
    fn combines_exported_aggregate_states_incrementally() {
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        let result = connection
            .query_row(
                "WITH first AS (SELECT count(*) EXPORT_STATE AS rows, \
                                      count(value) EXPORT_STATE AS values, \
                                      approx_count_distinct(value) EXPORT_STATE AS distinct_values \
                               FROM (VALUES (1), (2), (2), (NULL)) values(value)), \
                      second AS (SELECT count(*) EXPORT_STATE AS rows, \
                                       count(value) EXPORT_STATE AS values, \
                                       approx_count_distinct(value) EXPORT_STATE AS distinct_values \
                                FROM (VALUES (3), (3), (NULL)) values(value)) \
                 SELECT finalize(combine(first.rows, second.rows)), \
                        finalize(combine(first.values, second.values)), \
                        finalize(combine(first.distinct_values, second.distinct_values)) \
                 FROM first CROSS JOIN second",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .expect("aggregate states should finalize");

        assert_eq!(result, (7, 5, 3));
    }

    #[test]
    fn limits_memory_and_provides_a_spill_directory() {
        let reader = ColumnStatisticsReader::new(PathBuf::from("unused.parquet"))
            .expect("statistics reader should start");
        let (memory_limit, temporary_directory): (String, String) = reader
            .connection
            .query_row(
                "SELECT current_setting('memory_limit'), current_setting('temp_directory')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("statistics resource settings should be readable");
        let memory_limit_bytes = memory_size_in_bytes(&memory_limit)
            .expect("DuckDB memory limit should use a recognized size unit");

        assert!(
            (memory_limit_bytes - 384_000_000.0).abs() <= 1024.0 * 1024.0,
            "DuckDB reported an unexpected memory limit: {memory_limit}"
        );
        assert_eq!(
            PathBuf::from(temporary_directory),
            reader._temporary_directory.path()
        );
    }

    #[test]
    fn dataset_spill_is_temporary_and_its_lease_cleans_up() {
        let source_parent = tempdir().expect("source parent");
        let dataset_path = source_parent.path().join("dataset");
        std::fs::create_dir(&dataset_path).expect("dataset directory");
        write_statistics_parquet_to(&dataset_path.join("part.parquet"));
        let source = DatasetSource::open_folder(&dataset_path).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("dataset inspection");
        let dataset = inspector.into_window_reader().expect("dataset reader");
        let identity_checks = source.identity_check_count();
        let statistics =
            ColumnStatisticsReader::for_dataset(&dataset).expect("dataset statistics reader");
        assert_eq!(source.identity_check_count(), identity_checks);
        let temporary_path = statistics._temporary_directory.path().to_owned();

        assert_ne!(temporary_path.parent(), Some(source_parent.path()));
        assert!(temporary_path.exists());
        statistics
            .fetch(&FieldPath::from("value"), true)
            .expect("dataset statistics");
        assert_eq!(
            source.identity_check_count() - identity_checks,
            2,
            "statistics checks its one-member staging batch before and after reading it"
        );
        assert!(!temporary_path.exists());
    }

    #[test]
    fn temporary_directory_lease_cleans_up() {
        let temporary = create_temporary_directory("viewda-statistics-test-")
            .expect("system temporary directory");
        let temporary_path = temporary.path().to_owned();

        assert_eq!(
            statistics_temporary_directory_error(crate::DataWindowError::ResourceExhausted),
            ColumnStatisticsError::ResourceExhausted
        );
        drop(temporary);
        assert!(!temporary_path.exists());
    }

    #[test]
    fn skips_minimum_and_maximum_when_the_caller_does_not_request_them() {
        let source = write_statistics_parquet();
        let reader = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("statistics reader should start");

        assert_eq!(
            reader
                .fetch(&FieldPath::from("odd\"name"), false)
                .expect("summary statistics should load"),
            ColumnStatistics {
                minimum: None,
                maximum: None,
                min_max_computed: false,
                null_share: 0.0,
                null_count: 0,
                approximate_distinct_count: Some(3),
                container_count: None,
            }
        );
    }

    #[test]
    fn quotes_schema_names_instead_of_treating_them_as_sql() {
        let source = write_statistics_parquet();
        let reader = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("statistics reader should start");

        assert_eq!(
            reader
                .fetch(&FieldPath::from("odd\"name"), true)
                .expect("quoted identifier should load")
                .approximate_distinct_count,
            Some(3)
        );
    }

    #[test]
    fn computes_nested_struct_list_length_and_map_pair_statistics() {
        let source = write_nested_statistics_parquet();

        let nested = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("nested statistics reader")
            .fetch(&FieldPath::new(["profile", "score"]), true)
            .expect("nested scalar statistics");
        assert_eq!(
            nested,
            ColumnStatistics {
                minimum: Some("2".to_owned()),
                maximum: Some("7".to_owned()),
                min_max_computed: true,
                null_share: 0.25,
                null_count: 1,
                approximate_distinct_count: Some(2),
                container_count: None,
            }
        );

        let structure = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("struct statistics reader")
            .fetch(&FieldPath::from("profile"), false)
            .expect("addressable struct statistics");
        assert_eq!(structure.null_count, 1);
        assert_eq!(structure.null_share, 0.25);
        assert!(!structure.min_max_computed);

        let lists = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("list statistics reader")
            .fetch(&FieldPath::from("tags"), false)
            .expect("list length statistics");
        assert_eq!(
            lists.container_count,
            Some(ContainerCountStatistics {
                minimum: Some(0),
                average: Some(5.0 / 3.0),
                maximum: Some(3),
                empty_count: 1,
            })
        );
        assert_eq!(lists.null_count, 1);
        assert_eq!(lists.approximate_distinct_count, None);
        assert!(
            serde_json::to_value(&lists).expect("list statistics wire")["approximateDistinctCount"]
                .is_null()
        );

        let maps = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("map statistics reader")
            .fetch(&FieldPath::from("attributes"), false)
            .expect("map pair-count statistics");
        assert_eq!(
            maps.container_count,
            Some(ContainerCountStatistics {
                minimum: Some(0),
                average: Some(1.0),
                maximum: Some(2),
                empty_count: 1,
            })
        );
        assert_eq!(maps.null_count, 1);
        assert_eq!(maps.approximate_distinct_count, None);
    }

    #[test]
    fn computes_nested_statistics_for_a_dataset_staging_relation() {
        let directory = tempdir().expect("dataset directory");
        write_nested_statistics_parquet_to(&directory.path().join("part.parquet"));
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("dataset inspection");
        let dataset = inspector.into_window_reader().expect("dataset reader");

        let statistics = ColumnStatisticsReader::for_dataset(&dataset)
            .expect("dataset statistics reader")
            .fetch(&FieldPath::new(["profile", "score"]), true)
            .expect("dataset nested statistics");

        assert_eq!(statistics.minimum.as_deref(), Some("2"));
        assert_eq!(statistics.maximum.as_deref(), Some("7"));
        assert_eq!(statistics.null_count, 1);
    }

    #[test]
    fn distinguishes_resource_and_generic_query_failures_from_corruption() {
        let failure = |message: &str| {
            duckdb::Error::DuckDBFailure(
                duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
                Some(message.to_owned()),
            )
        };

        assert_eq!(
            classify_query_error(failure("Out of Memory Error: allocation failed")),
            ColumnStatisticsError::ResourceExhausted
        );
        assert_eq!(
            classify_query_error(failure(
                "Binder Error: no aggregate matches the selected MAP type"
            )),
            ColumnStatisticsError::Unsupported
        );
        assert_eq!(
            classify_query_error(failure("Execution Error: aggregate failed")),
            ColumnStatisticsError::QueryFailed
        );
    }

    #[test]
    fn dataset_cancellation_after_setup_stops_before_query_preparation() {
        let directory = tempdir().expect("dataset directory");
        write_statistics_parquet_to(&directory.path().join("part.parquet"));
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("dataset inspection");
        let dataset = inspector.into_window_reader().expect("dataset reader");
        let statistics =
            ColumnStatisticsReader::for_dataset(&dataset).expect("dataset statistics reader");
        let interrupt = statistics.interrupt_handle();

        assert_eq!(
            statistics.fetch_checked(&FieldPath::from("value"), true, || interrupt.interrupt()),
            Err(ColumnStatisticsError::QueryFailed)
        );
        assert!(dataset.member_snapshot(0).is_ok());
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

    fn write_statistics_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file can be created");
        write_statistics_parquet_to(source.path());
        source
    }

    fn write_statistics_parquet_to(path: &std::path::Path) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("value", DataType::Int64, true),
            Field::new("odd\"name", DataType::Utf8, false),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(vec![Some(2), None, Some(7), Some(2)])) as ArrayRef,
                Arc::new(StringArray::from(vec!["a", "b", "a", "c"])) as ArrayRef,
            ],
        )
        .expect("statistics record batch is valid");
        let file = File::create(path).expect("temporary file can be opened");
        let mut writer =
            ArrowWriter::try_new(file, schema, None).expect("Parquet writer can be created");
        writer.write(&batch).expect("record batch can be written");
        writer.close().expect("Parquet footer can be written");
    }

    fn write_nested_statistics_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary nested statistics file");
        write_nested_statistics_parquet_to(source.path());
        source
    }

    fn write_nested_statistics_parquet_to(path: &std::path::Path) {
        let profile_fields = Fields::from(vec![Field::new("score", DataType::Int64, false)]);
        let mut profile_validity = NullBufferBuilder::new(4);
        for valid in [true, false, true, true] {
            profile_validity.append(valid);
        }
        let profile = StructArray::new(
            profile_fields.clone(),
            vec![Arc::new(Int64Array::from(vec![2, 99, 7, 2])) as ArrayRef],
            profile_validity.finish(),
        );
        let tags = ListArray::from_iter_primitive::<Int64Type, _, _>(vec![
            Some(vec![Some(1), Some(2)]),
            Some(Vec::<Option<i64>>::new()),
            None,
            Some(vec![Some(3), Some(4), Some(5)]),
        ]);
        let mut attributes = MapBuilder::new(None, StringBuilder::new(), Int64Builder::new());
        for (key, value) in [("a", 1), ("b", 2)] {
            attributes.keys().append_value(key);
            attributes.values().append_value(value);
        }
        attributes.append(true).expect("two-pair map");
        attributes.append(true).expect("empty map");
        attributes.append(false).expect("null map");
        attributes.keys().append_value("c");
        attributes.values().append_value(3);
        attributes.append(true).expect("one-pair map");
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
        .expect("nested statistics record batch");
        let file = File::create(path).expect("nested statistics file");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("nested Parquet writer");
        writer.write(&batch).expect("nested statistics batch");
        writer.close().expect("nested statistics footer");
    }
}
