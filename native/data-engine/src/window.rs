use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
};

use arrow_ipc::writer::StreamWriter;
use duckdb::{Config, Connection, Error as DuckDbError, types::Value};
use serde::Serialize;
use thiserror::Error;

use crate::{
    filter::quote_identifier,
    source::{SchemaField, SourceError, inspect_local_source, open_local_source},
};

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
    /// The caller cancelled a long-running data query.
    #[error("The data query was cancelled.")]
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
    schema: Option<Vec<SchemaField>>,
}

impl DataWindowReader {
    /// Creates a reader for a Rust-owned path inspected by the caller.
    pub fn new(source_path: PathBuf) -> Self {
        Self {
            source_path,
            connection: None,
            schema: None,
        }
    }

    /// Reads a bounded file-order window and encodes it as Arrow IPC.
    pub fn fetch(&mut self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DataWindowError> {
        validate_window_size(row_count)?;
        self.fetch_projection(row_offset, row_count, None)
    }

    /// Reads selected source columns in the requested order without changing file order.
    pub fn fetch_columns(
        &mut self,
        row_offset: u64,
        row_count: u32,
        source_indices: &[u32],
    ) -> Result<Vec<u8>, DataWindowError> {
        validate_window_size(row_count)?;
        if source_indices.is_empty() {
            return Err(DataWindowError::Unsupported);
        }
        let projection = {
            let schema = match &self.schema {
                Some(schema) => schema,
                None => self.schema.insert(
                    inspect_local_source(&self.source_path)
                        .map_err(DataWindowError::from)?
                        .schema,
                ),
            };
            let source_indices = validate_projection(schema, source_indices)?;
            let projection = format_projection_clause(schema, &source_indices);
            (projection != "*").then_some(projection)
        };

        self.fetch_projection(row_offset, row_count, projection.as_deref())
    }

    fn fetch_projection(
        &mut self,
        row_offset: u64,
        row_count: u32,
        projection: Option<&str>,
    ) -> Result<Vec<u8>, DataWindowError> {
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
        let sql = projection.map_or_else(
            || "SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?".to_owned(),
            |projection| format!("SELECT {projection} FROM read_parquet(?) LIMIT ? OFFSET ?"),
        );
        let parameters = [
            Value::Text(path.to_owned()),
            Value::BigInt(i64::from(row_count)),
            Value::BigInt(row_offset),
        ];
        let mut statement = connection
            .prepare_cached(&sql)
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

fn format_projection_clause(schema: &[SchemaField], source_indices: &[usize]) -> String {
    let identity_projection =
        source_indices.len() == schema.len() && source_indices.iter().copied().eq(0..schema.len());
    if identity_projection {
        "*".to_owned()
    } else {
        source_indices
            .iter()
            .map(|source_index| quote_identifier(&schema[*source_index].name))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn validate_window_size(row_count: u32) -> Result<(), DataWindowError> {
    if row_count > MAX_WINDOW_ROWS {
        Err(DataWindowError::WindowTooLarge)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_projection(
    schema: &[SchemaField],
    source_indices: &[u32],
) -> Result<Vec<usize>, DataWindowError> {
    if source_indices.is_empty() {
        return Err(DataWindowError::Unsupported);
    }
    let mut seen = vec![false; schema.len()];
    let mut validated = Vec::with_capacity(source_indices.len());
    for source_index in source_indices {
        let source_index =
            usize::try_from(*source_index).map_err(|_| DataWindowError::Unsupported)?;
        let Some(slot) = seen.get_mut(source_index) else {
            return Err(DataWindowError::Unsupported);
        };
        if std::mem::replace(slot, true) {
            return Err(DataWindowError::Unsupported);
        }
        validated.push(source_index);
    }
    Ok(validated)
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

    #[test]
    fn formats_projection_in_requested_order_with_sql_identifier_quoting() {
        let schema = [
            SchemaField {
                name: "value\"quoted".to_owned(),
                physical_type: "INT64".to_owned(),
                logical_type: None,
                children: Vec::new(),
            },
            SchemaField {
                name: "label".to_owned(),
                physical_type: "BYTE_ARRAY".to_owned(),
                logical_type: Some("String".to_owned()),
                children: Vec::new(),
            },
            SchemaField {
                name: "amount".to_owned(),
                physical_type: "DOUBLE".to_owned(),
                logical_type: None,
                children: Vec::new(),
            },
        ];

        assert_eq!(
            format_projection_clause(&schema, &[1, 0]),
            "\"label\", \"value\"\"quoted\""
        );
        assert_eq!(format_projection_clause(&schema, &[0, 1, 2]), "*");
    }
}
