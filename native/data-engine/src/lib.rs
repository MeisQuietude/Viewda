//! Shell-independent data operations for Viewda.

mod source;
mod window;

use duckdb::Connection;
use serde::Serialize;
use thiserror::Error;

pub use source::{SchemaField, SourceError, SourceSummary, inspect_local_source};
pub use window::{DataWindowError, DataWindowReader};

/// Describes the data engine backing the desktop shell.
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum EngineError {
    /// The packaged DuckDB library could not start or report its version.
    #[error("The packaged query engine could not start.")]
    QueryEngineUnavailable,
}

/// Opens packaged DuckDB in memory and reports a readiness response.
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

#[cfg(test)]
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
