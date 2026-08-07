//! Bounded, cancellable text-value suggestions for filter editors.

use std::{
    collections::HashSet,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use arrow_array::{Array, BooleanArray, StringArray};
use duckdb::{Config, Connection, Error as DuckDbError, InterruptHandle, params};
use serde::Serialize;

use crate::{
    filter::{ColumnFilterKind, DataFilterOperator, column_filter_kind, quote_identifier},
    source::{SchemaField, open_local_source},
    window::{DataWindowError, classify_query_error},
};

const SUGGESTION_MEMORY_LIMIT: &str = "384MB";
const MAX_SUGGESTION_PREFIX_BYTES: usize = 4_096;
const MAX_TEXT_VALUE_SUGGESTIONS: usize = 20;
const MAX_TEXT_VALUE_SUGGESTION_ROWS: usize = 10_000;

/// Values collected by one bounded text-value suggestion scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextValueSuggestions {
    /// Distinct matching values in source order.
    pub values: Vec<String>,
    /// Whether more non-null source rows existed beyond the scan limit.
    pub is_partial: bool,
    /// Maximum number of non-null source rows considered for matches.
    pub scan_limit: usize,
}

/// A thread-safe handle for interrupting one distinct-value scan.
pub struct TextValueSuggestionsInterruptHandle {
    inner: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

impl TextValueSuggestionsInterruptHandle {
    /// Interrupts the active scan, or does nothing after its reader is dropped.
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.inner.interrupt();
    }

    /// Reports whether the caller interrupted this scan.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Owns the isolated DuckDB connection used by one text-value suggestion scan.
pub struct TextValueSuggestionsReader {
    source_path: PathBuf,
    connection: Connection,
    prefix: String,
    cancelled: Arc<AtomicBool>,
}

impl TextValueSuggestionsReader {
    /// Creates a reader whose bounded connection cannot block grid windows.
    pub fn new(source_path: PathBuf, prefix: String) -> Result<Self, DataWindowError> {
        if prefix.len() > MAX_SUGGESTION_PREFIX_BYTES {
            return Err(DataWindowError::InvalidFilter);
        }
        let config = Config::default()
            .enable_object_cache(true)
            .and_then(|config| config.max_memory(SUGGESTION_MEMORY_LIMIT))
            .and_then(|config| config.with("threads", "1"))
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        Ok(Self {
            source_path,
            connection,
            prefix,
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Returns a handle that can interrupt this reader from another thread.
    pub fn interrupt_handle(&self) -> TextValueSuggestionsInterruptHandle {
        TextValueSuggestionsInterruptHandle {
            inner: self.connection.interrupt_handle(),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Scans a bounded prefix of one trusted text column for up to twenty distinct values.
    pub fn fetch(
        self,
        column: &SchemaField,
        operator: DataFilterOperator,
    ) -> Result<TextValueSuggestions, DataWindowError> {
        let (source, _) = open_local_source(&self.source_path).map_err(DataWindowError::from)?;
        drop(source);
        self.require_active()?;
        if column_filter_kind(column) != ColumnFilterKind::Text {
            return Err(DataWindowError::InvalidFilter);
        }
        let match_function = match operator {
            DataFilterOperator::Equals
            | DataFilterOperator::NotEquals
            | DataFilterOperator::StartsWith => "starts_with",
            DataFilterOperator::TextContains | DataFilterOperator::NotContains => "contains",
            DataFilterOperator::EndsWith => "ends_with",
            _ => return Err(DataWindowError::InvalidFilter),
        };
        let path = self
            .source_path
            .to_str()
            .ok_or(DataWindowError::Unsupported)?;
        let identifier = quote_identifier(&column.name);
        let scan_probe_limit = MAX_TEXT_VALUE_SUGGESTION_ROWS + 1;
        let query = format!(
            "SELECT value, {match_function}(lower(value), lower(?)) AS is_match \
             FROM (\
                 SELECT CAST({identifier} AS VARCHAR) AS value \
                 FROM read_parquet(?) \
                 WHERE {identifier} IS NOT NULL \
                 LIMIT {scan_probe_limit}\
             ) candidates"
        );
        let mut statement = self
            .connection
            .prepare(&query)
            .map_err(|error| self.classify_error(error))?;
        let batches = statement
            .stream_arrow(params![self.prefix.as_str(), path])
            .map_err(|error| self.classify_error(error))?;
        let values = catch_unwind(AssertUnwindSafe(
            || -> Result<TextValueSuggestions, DataWindowError> {
                let mut seen = HashSet::with_capacity(MAX_TEXT_VALUE_SUGGESTIONS);
                let mut values = Vec::with_capacity(MAX_TEXT_VALUE_SUGGESTIONS);
                let mut scanned_rows = 0;
                for batch in batches {
                    let strings = batch
                        .column(0)
                        .as_any()
                        .downcast_ref::<StringArray>()
                        .ok_or(DataWindowError::QueryFailed)?;
                    let matches = batch
                        .column(1)
                        .as_any()
                        .downcast_ref::<BooleanArray>()
                        .ok_or(DataWindowError::QueryFailed)?;
                    for row_index in 0..batch.num_rows() {
                        scanned_rows += 1;
                        if scanned_rows > MAX_TEXT_VALUE_SUGGESTION_ROWS {
                            return Ok(TextValueSuggestions {
                                values,
                                is_partial: true,
                                scan_limit: MAX_TEXT_VALUE_SUGGESTION_ROWS,
                            });
                        }
                        if !matches.is_valid(row_index) || !matches.value(row_index) {
                            continue;
                        }
                        let value = strings.value(row_index);
                        if seen.insert(value.to_owned()) {
                            values.push(value.to_owned());
                            if values.len() == MAX_TEXT_VALUE_SUGGESTIONS {
                                return Ok(TextValueSuggestions {
                                    values,
                                    is_partial: false,
                                    scan_limit: MAX_TEXT_VALUE_SUGGESTION_ROWS,
                                });
                            }
                        }
                    }
                }
                Ok(TextValueSuggestions {
                    values,
                    is_partial: false,
                    scan_limit: MAX_TEXT_VALUE_SUGGESTION_ROWS,
                })
            },
        ));
        let values = match values {
            Ok(result) => result?,
            Err(_) if self.cancelled.load(Ordering::Acquire) => {
                return Err(DataWindowError::Cancelled);
            }
            Err(_) => return Err(DataWindowError::QueryFailed),
        };
        self.require_active()?;
        Ok(values)
    }

    fn require_active(&self) -> Result<(), DataWindowError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(DataWindowError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn classify_error(&self, error: DuckDbError) -> DataWindowError {
        if self.cancelled.load(Ordering::Acquire) {
            DataWindowError::Cancelled
        } else {
            classify_query_error(error, false)
        }
    }
}
