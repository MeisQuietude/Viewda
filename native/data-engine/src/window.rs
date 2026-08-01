use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
};

use arrow_ipc::writer::StreamWriter;
use duckdb::{Config, Connection, params};
use serde::Serialize;
use thiserror::Error;

use crate::source::{SourceError, open_local_source};

// Keep in sync with DataGrid.tsx's MAX_WINDOW_ROWS; this is the authoritative IPC guard.
const MAX_WINDOW_ROWS: u32 = 512;

/// Stable failures from a bounded data-window request.
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
}

impl DataWindowReader {
    /// Creates a reader for a Rust-owned path inspected by the caller.
    pub fn new(source_path: PathBuf) -> Self {
        Self {
            source_path,
            connection: None,
        }
    }

    /// Reads a bounded row window and encodes it as Arrow IPC.
    pub fn fetch(&mut self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DataWindowError> {
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
        if self.connection.is_none() {
            let config = Config::default()
                .enable_object_cache(true)
                .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
            self.connection = Some(
                Connection::open_in_memory_with_flags(config)
                    .map_err(|_| DataWindowError::QueryEngineUnavailable)?,
            );
        }
        let connection = self
            .connection
            .as_ref()
            .ok_or(DataWindowError::QueryEngineUnavailable)?;
        let mut statement = connection
            .prepare_cached("SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?")
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let batches = statement
            .stream_arrow(params![path, i64::from(row_count), row_offset])
            .map_err(|_| DataWindowError::CorruptSource)?;
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
