use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
};

use arrow_ipc::writer::StreamWriter;
use duckdb::{Config, Connection, Error as DuckDbError, types::Value};
use serde::Serialize;
use thiserror::Error;

use crate::source::{SourceError, open_local_source};

// Keep in sync with DataGrid.tsx's MAX_WINDOW_ROWS; this is the authoritative IPC guard.
pub(crate) const MAX_WINDOW_ROWS: u32 = 512;

/// Stable failures from a bounded window or prepared-view operation.
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
    /// The source could not be decoded.
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
    /// The requested sort does not identify distinct source columns.
    #[error("The sort order is invalid for this source.")]
    InvalidSort,
    /// The caller cancelled preparation of a data view.
    #[error("The data view preparation was cancelled.")]
    Cancelled,
    /// The preparation exceeded its bounded memory and spill resources.
    #[error("There are not enough resources to prepare this data view.")]
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

/// Reuses one DuckDB connection for direct windows of an opened source.
pub struct DataWindowReader {
    source_path: PathBuf,
    connection: Option<Connection>,
}

impl DataWindowReader {
    /// Creates a reader for a Rust-owned path inspected by the caller.
    pub fn new(source_path: PathBuf) -> Self {
        Self {
            source_path,
            connection: None,
        }
    }

    /// Reads a bounded file-order window and encodes it as Arrow IPC.
    pub fn fetch(&mut self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DataWindowError> {
        if row_count > MAX_WINDOW_ROWS {
            return Err(DataWindowError::WindowTooLarge);
        }

        // Keep the preflight to two four-byte reads. Parsing the footer for every
        // scroll window would duplicate DuckDB work and make latency scale with metadata size.
        let (source, _) = open_local_source(&self.source_path).map_err(DataWindowError::from)?;
        drop(source);

        let path = self
            .source_path
            .to_str()
            .ok_or(DataWindowError::Unsupported)?;
        let row_offset = i64::try_from(row_offset).map_err(|_| DataWindowError::Unsupported)?;
        if self.connection.is_none() {
            self.connection = Some(open_window_connection()?);
        }
        let connection = self
            .connection
            .as_ref()
            .ok_or(DataWindowError::QueryEngineUnavailable)?;
        let sql = "SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?";
        let parameters = [
            Value::Text(path.to_owned()),
            Value::BigInt(i64::from(row_count)),
            Value::BigInt(row_offset),
        ];
        let mut statement = connection
            .prepare_cached(sql)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let batches = statement
            .stream_arrow(duckdb::params_from_iter(parameters.iter()))
            .map_err(|error| classify_query_error(error, false))?;
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

pub(crate) fn classify_query_error(error: DuckDbError, has_filters: bool) -> DataWindowError {
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
    let connection = Connection::open_in_memory_with_flags(config)
        .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
    set_utc_session_timezone(&connection)?;
    Ok(connection)
}

pub(crate) fn set_utc_session_timezone(connection: &Connection) -> Result<(), DataWindowError> {
    // Parquet adjusted-to-UTC timestamps use the canonical Arrow timezone "UTC". DuckDB emits
    // its session timezone instead, so pin it for schemas to stay stable across reader paths.
    connection
        .execute_batch("SET TimeZone = 'UTC'")
        .map_err(|_| DataWindowError::QueryEngineUnavailable)
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
    use super::*;

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
}
