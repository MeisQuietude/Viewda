use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use arrow_ipc::writer::StreamWriter;
use duckdb::{
    Config, Connection, Error as DuckDbError, InterruptHandle, params_from_iter, types::Value,
};
use serde::Serialize;
use tempfile::TempDir;
use thiserror::Error;

use crate::{
    filter::{DataFilter, build_filter_predicate},
    source::{SchemaField, SourceError, inspect_local_source, open_local_source},
};

// Keep in sync with DataGrid.tsx's MAX_WINDOW_ROWS; this is the authoritative IPC guard.
const MAX_WINDOW_ROWS: u32 = 512;
const FILTERED_COUNT_MEMORY_LIMIT: &str = "384MB";

/// Stable failures from a bounded window or filtered-count query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DataWindowError {
    /// The selected source no longer exists.
    #[error("The selected file no longer exists.")]
    NotFound,
    /// The operating system denied access to the selected source.
    #[error("Viewda does not have permission to read the selected file.")]
    PermissionDenied,
    /// The selected source does not have Parquet file markers.
    #[error("The selected file is not a Parquet file.")]
    NotParquet,
    /// DuckDB could not decode a source with Parquet markers.
    #[error("The Parquet data is damaged or incomplete.")]
    CorruptSource,
    /// The source or requested offset cannot be represented safely.
    #[error("This data window is not supported.")]
    Unsupported,
    /// The request exceeds the bounded engine window.
    #[error("The requested data window is too large.")]
    WindowTooLarge,
    /// A condition does not match its column type or has invalid values.
    #[error("The filter condition is invalid for this column.")]
    InvalidFilter,
    /// The caller cancelled an exact filtered-row count.
    #[error("The filtered row count was cancelled.")]
    Cancelled,
    /// The query exceeded the memory available to its DuckDB connection.
    #[error("There is not enough memory to complete this query.")]
    ResourceExhausted,
    /// DuckDB could not complete a data query for a non-corruption reason.
    #[error("The query engine could not read this data.")]
    QueryFailed,
    /// The packaged DuckDB library could not start.
    #[error("The packaged query engine could not start.")]
    QueryEngineUnavailable,
    /// Arrow IPC encoding failed.
    #[error("The data window could not be encoded.")]
    EncodingFailed,
}

/// Reuses one DuckDB connection for every window of an opened source.
pub struct DataWindowReader {
    source_path: PathBuf,
    connection: Option<Connection>,
    filter_schema: Option<Vec<SchemaField>>,
}

/// A thread-safe handle for interrupting an exact filtered-row count.
pub struct FilteredRowCountInterruptHandle {
    inner: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

impl FilteredRowCountInterruptHandle {
    /// Interrupts the active count, or does nothing after its reader is dropped.
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.inner.interrupt();
    }

    /// Reports whether the caller interrupted this count.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Owns the isolated DuckDB connection used by one exact filtered-row count.
pub struct FilteredRowCountReader {
    source_path: PathBuf,
    connection: Connection,
    _temporary_directory: TempDir,
    filters: Vec<DataFilter>,
    cancelled: Arc<AtomicBool>,
}

impl FilteredRowCountReader {
    /// Prepares a count reader that cannot block the grid's connection.
    pub fn new(source_path: PathBuf, filters: &[DataFilter]) -> Result<Self, DataWindowError> {
        let (connection, temporary_directory) = open_filtered_count_connection()?;
        Ok(Self {
            source_path,
            connection,
            _temporary_directory: temporary_directory,
            filters: filters.to_vec(),
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Returns a handle that can interrupt this reader from another thread.
    pub fn interrupt_handle(&self) -> FilteredRowCountInterruptHandle {
        FilteredRowCountInterruptHandle {
            inner: self.connection.interrupt_handle(),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Counts matches without materializing filtered rows.
    pub fn fetch(self) -> Result<u64, DataWindowError> {
        let summary = inspect_local_source(&self.source_path).map_err(DataWindowError::from)?;
        self.require_active()?;
        if self.filters.is_empty() {
            return Ok(summary.row_count);
        }
        let predicate = build_filter_predicate(&summary.schema, &self.filters)
            .map_err(|_| DataWindowError::InvalidFilter)?;
        self.require_active()?;
        let path = self
            .source_path
            .to_str()
            .ok_or(DataWindowError::Unsupported)?;
        let sql = format!(
            "SELECT COUNT(*) FROM read_parquet(?) WHERE {}",
            predicate.sql
        );
        let mut parameters = vec![Value::Text(path.to_owned())];
        parameters.extend(predicate.parameters);
        let count = self
            .connection
            .query_row(&sql, params_from_iter(parameters.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| {
                if self.cancelled.load(Ordering::Acquire) {
                    DataWindowError::Cancelled
                } else {
                    classify_query_error(error, true)
                }
            })?;
        self.require_active()?;
        u64::try_from(count).map_err(|_| DataWindowError::Unsupported)
    }

    fn require_active(&self) -> Result<(), DataWindowError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(DataWindowError::Cancelled)
        } else {
            Ok(())
        }
    }
}

impl DataWindowReader {
    /// Creates a reader for a Rust-owned path inspected by the caller.
    pub fn new(source_path: PathBuf) -> Self {
        Self {
            source_path,
            connection: None,
            filter_schema: None,
        }
    }

    /// Reads a bounded row window and encodes it as Arrow IPC.
    pub fn fetch(&mut self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DataWindowError> {
        self.fetch_filtered(row_offset, row_count, &[])
    }

    /// Reads a bounded row window after applying typed conditions.
    pub fn fetch_filtered(
        &mut self,
        row_offset: u64,
        row_count: u32,
        filters: &[DataFilter],
    ) -> Result<Vec<u8>, DataWindowError> {
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge);
        }

        // Keep the preflight to two four-byte reads. Parsing the footer for every
        // scroll window would duplicate DuckDB work and make latency scale with
        // metadata size.
        let (source, _) = open_local_source(&self.source_path).map_err(DataWindowError::from)?;
        drop(source);

        let path = self
            .source_path
            .to_str()
            .ok_or(DataWindowError::Unsupported)?;
        let row_offset = i64::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?;
        let predicate = if filters.is_empty() {
            None
        } else {
            let schema = match &self.filter_schema {
                Some(schema) => schema,
                None => self.filter_schema.insert(
                    inspect_local_source(&self.source_path)
                        .map_err(DataWindowError::from)?
                        .schema,
                ),
            };
            Some(
                build_filter_predicate(schema, filters)
                    .map_err(|_| DataWindowError::InvalidFilter)?,
            )
        };
        if self.connection.is_none() {
            self.connection = Some(open_window_connection()?);
        }
        let connection = self
            .connection
            .as_ref()
            .ok_or(DataWindowError::QueryEngineUnavailable)?;
        // DuckDB currently evaluates a filtered OFFSET by scanning the matching prefix again.
        // Keep that known deep-scroll cost until the sorting pipeline can own reusable row order.
        let sql = match &predicate {
            Some(predicate) => format!(
                "SELECT * FROM read_parquet(?) WHERE {} LIMIT ? OFFSET ?",
                predicate.sql
            ),
            None => "SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?".to_owned(),
        };
        let mut parameters = vec![Value::Text(path.to_owned())];
        if let Some(predicate) = predicate {
            parameters.extend(predicate.parameters);
        }
        parameters.extend([
            Value::BigInt(i64::from(row_count)),
            Value::BigInt(row_offset),
        ]);
        let mut statement = connection
            .prepare_cached(&sql)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let batches = statement
            .stream_arrow(params_from_iter(parameters.iter()))
            .map_err(|error| classify_query_error(error, !filters.is_empty()))?;
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

        encoded.unwrap_or(Err(DataWindowError::Unsupported))
    }
}

fn classify_query_error(error: DuckDbError, has_filters: bool) -> DataWindowError {
    let DuckDbError::DuckDBFailure(_, Some(message)) = error else {
        return DataWindowError::QueryFailed;
    };

    // duckdb 1.10505 exposes execution categories only through message prefixes.
    if has_filters
        && (message.starts_with("Conversion Error:") || message.contains("Could not convert"))
    {
        DataWindowError::InvalidFilter
    } else if message.starts_with("Out of Memory Error:") {
        DataWindowError::ResourceExhausted
    } else if message.starts_with("Invalid Input Error:") || message.starts_with("Parquet Error:") {
        DataWindowError::CorruptSource
    } else {
        DataWindowError::QueryFailed
    }
}

fn open_window_connection() -> Result<Connection, DataWindowError> {
    let config = Config::default()
        .enable_object_cache(true)
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    Connection::open_in_memory_with_flags(config)
        .map_err(|_| DataWindowError::QueryEngineUnavailable)
}

fn open_filtered_count_connection() -> Result<(Connection, TempDir), DataWindowError> {
    let temporary_directory = tempfile::Builder::new()
        .prefix("viewda-filter-count-")
        .tempdir()
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    let temporary_directory_path = temporary_directory
        .path()
        .to_str()
        .ok_or(DataWindowError::QueryEngineUnavailable)?;
    let config = Config::default()
        .enable_object_cache(true)
        .and_then(|config| config.max_memory(FILTERED_COUNT_MEMORY_LIMIT))
        .and_then(|config| config.with("temp_directory", temporary_directory_path))
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    let connection = Connection::open_in_memory_with_flags(config)
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    Ok((connection, temporary_directory))
}

impl From<SourceError> for DataWindowError {
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
        sync::{Arc, mpsc},
        thread,
        time::Duration,
    };

    use arrow_array::{
        ArrayRef, Date32Array, RecordBatch, Time64MicrosecondArray, TimestampMicrosecondArray,
    };
    use arrow_schema::{DataType, Field, Schema, TimeUnit};
    use parquet::arrow::ArrowWriter;
    use tempfile::NamedTempFile;

    use super::*;
    use crate::filter::DataFilterOperator;

    #[test]
    fn counts_every_temporal_prefill_formatted_for_filters() {
        let source = write_temporal_parquet();
        let filters = [
            DataFilter {
                column_index: 0,
                operator: DataFilterOperator::Equals,
                values: vec!["2026-08-01T06:07:08.009456Z".to_owned()],
            },
            DataFilter {
                column_index: 1,
                operator: DataFilterOperator::Equals,
                values: vec!["2026-08-01T06:07:08.009456".to_owned()],
            },
            DataFilter {
                column_index: 2,
                operator: DataFilterOperator::Equals,
                values: vec!["06:07:08.009456".to_owned()],
            },
            DataFilter {
                column_index: 3,
                operator: DataFilterOperator::Equals,
                values: vec!["2026-08-01".to_owned()],
            },
        ];

        assert_eq!(
            FilteredRowCountReader::new(source.path().to_owned(), &filters)
                .expect("filtered count reader")
                .fetch()
                .expect("temporal values should cast"),
            1
        );
    }

    #[test]
    fn cancellation_stops_a_count_before_it_scans() {
        let source = write_temporal_parquet();
        let filters = [DataFilter {
            column_index: 0,
            operator: DataFilterOperator::Equals,
            values: vec!["2026-08-01T06:07:08.009456Z".to_owned()],
        }];
        let reader = FilteredRowCountReader::new(source.path().to_owned(), &filters)
            .expect("filtered count reader");
        let interrupt = reader.interrupt_handle();

        interrupt.interrupt();

        assert_eq!(reader.fetch(), Err(DataWindowError::Cancelled));
    }

    #[test]
    fn count_connection_limits_memory_and_provides_a_spill_directory() {
        let reader = FilteredRowCountReader::new(PathBuf::from("unused.parquet"), &[])
            .expect("filtered count reader should start");
        let (memory_limit, temporary_directory): (String, String) = reader
            .connection
            .query_row(
                "SELECT current_setting('memory_limit'), current_setting('temp_directory')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("filtered count resource settings should be readable");
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
    fn interrupt_handle_stops_its_count_connection_mid_scan() {
        let reader = FilteredRowCountReader::new(PathBuf::from("unused.parquet"), &[])
            .expect("filtered count reader should start");
        let interrupt = reader.interrupt_handle();
        let FilteredRowCountReader {
            connection,
            _temporary_directory: temporary_directory,
            ..
        } = reader;
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
            "the reader's interrupt handle must stop its own active connection"
        );
        scan.join().expect("scan thread should stop");
    }

    #[test]
    fn distinguishes_filter_conversion_resource_corruption_and_query_failures() {
        let failure = |message: &str| {
            DuckDbError::DuckDBFailure(
                duckdb::ffi::Error::new(duckdb::ffi::DuckDBError),
                Some(message.to_owned()),
            )
        };

        assert_eq!(
            classify_query_error(failure("Conversion Error: invalid integer"), true),
            DataWindowError::InvalidFilter
        );
        assert_eq!(
            classify_query_error(failure("Out of Memory Error: allocation failed"), true),
            DataWindowError::ResourceExhausted
        );
        assert_eq!(
            classify_query_error(
                failure("Invalid Input Error: malformed Parquet footer"),
                false
            ),
            DataWindowError::CorruptSource
        );
        assert_eq!(
            classify_query_error(failure("IO Error: failed to read a block"), true),
            DataWindowError::QueryFailed
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

    fn write_temporal_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file");
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "recorded_at",
                DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
                false,
            ),
            Field::new(
                "local_at",
                DataType::Timestamp(TimeUnit::Microsecond, None),
                false,
            ),
            Field::new("local_time", DataType::Time64(TimeUnit::Microsecond), false),
            Field::new("day", DataType::Date32, false),
        ]));
        let timestamp = 1_785_564_428_009_456_i64;
        let time = 22_028_009_456_i64;
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(
                    TimestampMicrosecondArray::from(vec![timestamp, timestamp + 1])
                        .with_timezone("UTC"),
                ) as ArrayRef,
                Arc::new(TimestampMicrosecondArray::from(vec![
                    timestamp,
                    timestamp + 1,
                ])) as ArrayRef,
                Arc::new(Time64MicrosecondArray::from(vec![time, time + 1])) as ArrayRef,
                Arc::new(Date32Array::from(vec![20_666, 20_667])) as ArrayRef,
            ],
        )
        .expect("record batch");
        let file = File::create(source.path()).expect("Parquet fixture");
        let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
        writer.write(&batch).expect("write batch");
        writer.close().expect("write footer");
        source
    }
}
