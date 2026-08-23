use std::{path::PathBuf, sync::Arc};

use duckdb::{Config, Connection, InterruptHandle, params};
use serde::Serialize;
use tempfile::TempDir;
use thiserror::Error;

use crate::source::{SourceError, open_local_source};

const QUERY_MEMORY_LIMIT: &str = "384MB";

/// A handle for cancelling an in-flight statistics scan.
pub struct StatisticsInterruptHandle {
    inner: Arc<InterruptHandle>,
}

impl StatisticsInterruptHandle {
    /// Interrupts the active scan, or does nothing after its reader is dropped.
    pub fn interrupt(&self) {
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
    /// Approximate number of distinct non-null values.
    pub approximate_distinct_count: u64,
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
    source_path: PathBuf,
    connection: Connection,
    _temporary_directory: TempDir,
}

impl ColumnStatisticsReader {
    /// Creates a statistics reader that cannot block the grid's connection.
    pub fn new(source_path: PathBuf) -> Result<Self, ColumnStatisticsError> {
        let temporary_directory = tempfile::Builder::new()
            .prefix("viewda-statistics-")
            .tempdir()
            .map_err(|_| ColumnStatisticsError::QueryEngineUnavailable)?;
        let temporary_directory_path = temporary_directory
            .path()
            .to_str()
            .ok_or(ColumnStatisticsError::QueryEngineUnavailable)?;
        let config = Config::default()
            .enable_object_cache(true)
            .and_then(|config| config.max_memory(QUERY_MEMORY_LIMIT))
            .and_then(|config| config.with("temp_directory", temporary_directory_path))
            .map_err(|_| ColumnStatisticsError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| ColumnStatisticsError::QueryEngineUnavailable)?;
        Ok(Self {
            source_path,
            connection,
            _temporary_directory: temporary_directory,
        })
    }

    /// Returns a thread-safe handle for interrupting this reader's active scan.
    pub fn interrupt_handle(&self) -> StatisticsInterruptHandle {
        StatisticsInterruptHandle {
            inner: self.connection.interrupt_handle(),
        }
    }

    /// Scans one trusted schema column and computes the requested aggregates together.
    pub fn fetch(
        self,
        column_name: &str,
        include_min_max: bool,
    ) -> Result<ColumnStatistics, ColumnStatisticsError> {
        let (source, _) =
            open_local_source(&self.source_path).map_err(ColumnStatisticsError::from)?;
        drop(source);

        let path = self
            .source_path
            .to_str()
            .ok_or(ColumnStatisticsError::Unsupported)?;
        let identifier = quote_identifier(column_name);
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
             FROM read_parquet(?)"
        );
        let mut statement = self
            .connection
            .prepare(&query)
            .map_err(classify_query_error)?;
        let (minimum, maximum, null_count, approximate_distinct_count, row_count) = statement
            .query_row(params![path], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(classify_query_error)?;
        let null_count =
            u64::try_from(null_count).map_err(|_| ColumnStatisticsError::Unsupported)?;
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
            approximate_distinct_count,
        })
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
    let duckdb::Error::DuckDBFailure(_, Some(message)) = error else {
        return ColumnStatisticsError::QueryFailed;
    };

    // duckdb 1.10505 collapses execution categories into one error variant;
    // its message prefix is the only category exposed by this pinned binding.
    if message.starts_with("Out of Memory Error:") {
        ColumnStatisticsError::ResourceExhausted
    } else if message.starts_with("Binder Error:")
        || message.starts_with("Invalid type Error:")
        || message.starts_with("Not implemented Error:")
    {
        ColumnStatisticsError::Unsupported
    } else {
        ColumnStatisticsError::QueryFailed
    }
}

#[cfg(test)]
mod tests {
    use std::{fs::File, sync::Arc};

    use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use tempfile::NamedTempFile;

    use super::*;

    #[test]
    fn computes_requested_statistics_in_one_column_scan() {
        let source = write_statistics_parquet();
        let reader = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("statistics reader should start");

        assert_eq!(
            reader.fetch("value", true).expect("statistics should load"),
            ColumnStatistics {
                minimum: Some("2".to_owned()),
                maximum: Some("7".to_owned()),
                min_max_computed: true,
                null_share: 0.25,
                approximate_distinct_count: 2,
            }
        );
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
    fn skips_minimum_and_maximum_when_the_caller_does_not_request_them() {
        let source = write_statistics_parquet();
        let reader = ColumnStatisticsReader::new(source.path().to_owned())
            .expect("statistics reader should start");

        assert_eq!(
            reader
                .fetch("odd\"name", false)
                .expect("summary statistics should load"),
            ColumnStatistics {
                minimum: None,
                maximum: None,
                min_max_computed: false,
                null_share: 0.0,
                approximate_distinct_count: 3,
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
                .fetch("odd\"name", true)
                .expect("quoted identifier should load")
                .approximate_distinct_count,
            3
        );
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
        let file = File::create(source.path()).expect("temporary file can be opened");
        let mut writer =
            ArrowWriter::try_new(file, schema, None).expect("Parquet writer can be created");
        writer.write(&batch).expect("record batch can be written");
        writer.close().expect("Parquet footer can be written");
        source
    }
}
