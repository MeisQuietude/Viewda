//! Shell-independent data inspection and query operations for Viewda.

mod source;
#[cfg(feature = "query-engine")]
mod statistics;
#[cfg(feature = "query-engine")]
mod window;

#[cfg(feature = "query-engine")]
use duckdb::Connection;
#[cfg(feature = "query-engine")]
use serde::Serialize;
#[cfg(feature = "query-engine")]
use thiserror::Error;

pub use source::{SchemaField, SourceError, SourceSummary, inspect_local_source};
#[cfg(feature = "query-engine")]
pub use statistics::{
    ColumnStatistics, ColumnStatisticsError, ColumnStatisticsReader, StatisticsInterruptHandle,
};
#[cfg(feature = "query-engine")]
pub use window::{DataWindowError, DataWindowReader};

/// Describes the data engine backing the desktop shell.
#[cfg(feature = "query-engine")]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// Human-readable engine name.
    pub name: &'static str,
    /// Data engine crate version.
    pub version: &'static str,
    /// Version reported by the packaged DuckDB query engine.
    pub query_engine_version: String,
}

/// Stable readiness failures for the packaged query engine.
#[cfg(feature = "query-engine")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum EngineError {
    /// The packaged DuckDB library could not start or report its version.
    #[error("The packaged query engine could not start.")]
    QueryEngineUnavailable,
}

/// Opens packaged DuckDB in memory and reports a readiness response.
#[cfg(feature = "query-engine")]
pub fn engine_status() -> Result<EngineStatus, EngineError> {
    let query_engine = Connection::open_in_memory()
        .map_err(|_| EngineError::QueryEngineUnavailable)?
        .version()
        .map_err(|_| EngineError::QueryEngineUnavailable)?;

    Ok(EngineStatus {
        name: "Viewda data engine",
        version: env!("CARGO_PKG_VERSION"),
        query_engine_version: query_engine,
    })
}

#[cfg(all(test, feature = "query-engine"))]
mod tests {
    use super::*;

    #[test]
    fn reports_the_data_engine_identity() {
        let status = engine_status().expect("packaged DuckDB should start");

        assert_eq!(status.name, "Viewda data engine");
        assert_eq!(status.version, env!("CARGO_PKG_VERSION"));
        assert!(!status.query_engine_version.is_empty());
    }
}
