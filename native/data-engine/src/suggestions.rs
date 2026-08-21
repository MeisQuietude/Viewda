//! Cancellable text-value suggestions for filter editors.

use std::{
    collections::HashSet,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use arrow_array::{Array, StringArray};
use duckdb::{Config, Connection, Error as DuckDbError, InterruptHandle};
use serde::Serialize;

use crate::{
    dataset::{DatasetError, DatasetQuerySource, DatasetSetupError, DatasetWindowReader},
    filter::{ColumnFilterKind, DataFilterOperator, column_filter_kind, quote_identifier},
    source::{SchemaField, open_local_source},
    window::{DataWindowError, classify_query_error},
};

const SUGGESTION_MEMORY_LIMIT: &str = "384MB";
const MAX_SUGGESTION_INPUT_BYTES: usize = 4_096;
const MAX_TEXT_VALUE_SUGGESTIONS: usize = 20;

/// Values collected by one text-value suggestion scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextValueSuggestions {
    /// Distinct matching values in source order.
    pub values: Vec<String>,
    /// Whether the scan stopped after collecting twenty distinct matches.
    pub is_partial: bool,
}

/// A per-request cancellation marker backed by its reader's shared interrupt.
pub struct TextValueSuggestionsInterruptHandle {
    inner: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

impl TextValueSuggestionsInterruptHandle {
    /// Marks this request cancelled and interrupts the reader's active scan.
    ///
    /// The reader contract permits only the scan using this handle to be active.
    /// Calling this method while another handle's scan is active interrupts that
    /// scan without marking its request cancelled.
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.inner.interrupt();
    }

    /// Reports whether the caller interrupted this scan.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Reuses one isolated DuckDB connection for suggestions from an opened source.
pub struct TextValueSuggestionsReader {
    source: TextValueSuggestionsSource,
    connection: Mutex<Connection>,
    interrupt: Arc<InterruptHandle>,
}

enum TextValueSuggestionsSource {
    File(PathBuf),
    Dataset(Box<DatasetQuerySource>),
}

impl TextValueSuggestionsReader {
    /// Creates a reader whose isolated connection cannot block grid windows.
    pub fn new(source_path: PathBuf) -> Result<Self, DataWindowError> {
        Self::with_source(TextValueSuggestionsSource::File(source_path))
    }

    /// Creates a suggestion reader for one completed fixed dataset.
    pub fn for_dataset(reader: &DatasetWindowReader) -> Result<Self, DataWindowError> {
        Self::for_dataset_while(reader, || true)
    }

    /// Creates a dataset suggestion reader while its source session remains active.
    pub fn for_dataset_while(
        reader: &DatasetWindowReader,
        mut keep_going: impl FnMut() -> bool,
    ) -> Result<Self, DataWindowError> {
        let source = reader
            .query_source_while(&mut keep_going)
            .map_err(dataset_suggestion_error)?;
        let suggestion_reader =
            Self::with_source(TextValueSuggestionsSource::Dataset(Box::new(source)))?;
        {
            let connection = suggestion_reader
                .connection
                .lock()
                .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
            let TextValueSuggestionsSource::Dataset(dataset) = &suggestion_reader.source else {
                unreachable!("dataset constructor always retains a dataset source");
            };
            dataset
                .install_while(&connection, &mut keep_going)
                .map_err(dataset_setup_suggestion_error)?;
        }
        if !keep_going() {
            return Err(DataWindowError::Cancelled);
        }
        Ok(suggestion_reader)
    }

    fn with_source(source: TextValueSuggestionsSource) -> Result<Self, DataWindowError> {
        let is_dataset = matches!(source, TextValueSuggestionsSource::Dataset(_));
        let config = Config::default()
            .enable_object_cache(!is_dataset)
            .and_then(|config| config.max_memory(SUGGESTION_MEMORY_LIMIT))
            .and_then(|config| config.with("threads", "1"))
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let connection = Connection::open_in_memory_with_flags(config)
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        connection
            .execute_batch(if is_dataset {
                "SET parquet_metadata_cache = false"
            } else {
                "SET parquet_metadata_cache = true"
            })
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        let interrupt = connection.interrupt_handle();
        Ok(Self {
            source,
            connection: Mutex::new(connection),
            interrupt,
        })
    }

    /// Returns the cancellation handle for one subsequent [`Self::fetch`] call.
    ///
    /// The caller must keep at most one `fetch` call active on this reader and
    /// pass that call its own handle. All handles share the connection-level
    /// DuckDB interrupt, while their cancellation markers remain independent.
    /// Interrupting a stale or different handle during an active call can abort
    /// that call without classifying its result as [`DataWindowError::Cancelled`].
    pub fn interrupt_handle(&self) -> TextValueSuggestionsInterruptHandle {
        TextValueSuggestionsInterruptHandle {
            inner: Arc::clone(&self.interrupt),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Scans one trusted text column until EOF or twenty distinct matches.
    ///
    /// The caller must keep at most one scan active on this reader and pass the
    /// per-request handle created for this call by [`Self::interrupt_handle`].
    pub fn fetch(
        &self,
        input: &str,
        column: &SchemaField,
        operator: DataFilterOperator,
        interrupt: &TextValueSuggestionsInterruptHandle,
    ) -> Result<TextValueSuggestions, DataWindowError> {
        self.fetch_checked(input, column, operator, interrupt, || {})
    }

    fn fetch_checked(
        &self,
        input: &str,
        column: &SchemaField,
        operator: DataFilterOperator,
        interrupt: &TextValueSuggestionsInterruptHandle,
        before_prepare: impl FnOnce(),
    ) -> Result<TextValueSuggestions, DataWindowError> {
        if input.len() > MAX_SUGGESTION_INPUT_BYTES {
            return Err(DataWindowError::InvalidFilter);
        }
        debug_assert!(Arc::ptr_eq(&self.interrupt, &interrupt.inner));
        Self::require_active(interrupt)?;
        if column_filter_kind(column) != ColumnFilterKind::Text {
            return Err(DataWindowError::InvalidFilter);
        }
        let match_function = match operator {
            DataFilterOperator::Equals
            | DataFilterOperator::NotEquals
            | DataFilterOperator::TextContains
            | DataFilterOperator::NotContains => "contains",
            DataFilterOperator::StartsWith => "starts_with",
            DataFilterOperator::EndsWith => "ends_with",
            _ => return Err(DataWindowError::InvalidFilter),
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| DataWindowError::QueryEngineUnavailable)?;
        Self::require_active(interrupt)?;
        if let TextValueSuggestionsSource::Dataset(dataset) = &self.source {
            before_prepare();
            return self.fetch_dataset_batches(
                &connection,
                dataset,
                input,
                column,
                match_function,
                interrupt,
            );
        }
        let (relation, mut parameters) = match &self.source {
            TextValueSuggestionsSource::File(source_path) => {
                let (source, _) = open_local_source(source_path).map_err(DataWindowError::from)?;
                drop(source);
                let path = source_path.to_str().ok_or(DataWindowError::Unsupported)?;
                (
                    "read_parquet(?)".to_owned(),
                    vec![duckdb::types::Value::Text(path.to_owned())],
                )
            }
            TextValueSuggestionsSource::Dataset(_) => unreachable!("dataset handled above"),
        };
        before_prepare();
        Self::require_active(interrupt)?;
        parameters.push(duckdb::types::Value::Text(input.to_owned()));
        let query = suggestion_query(&column.name, match_function, &relation);
        let mut statement = connection
            .prepare_cached(&query)
            .map_err(|error| self.classify_error(error, interrupt))?;
        Self::require_active(interrupt)?;
        let batches = statement
            .stream_arrow(duckdb::params_from_iter(parameters.iter()))
            .map_err(|error| self.classify_error(error, interrupt))?;
        let values = catch_unwind(AssertUnwindSafe(
            || -> Result<TextValueSuggestions, DataWindowError> {
                let mut seen = HashSet::with_capacity(MAX_TEXT_VALUE_SUGGESTIONS);
                let mut values = Vec::with_capacity(MAX_TEXT_VALUE_SUGGESTIONS);
                for batch in batches {
                    let strings = batch
                        .column(0)
                        .as_any()
                        .downcast_ref::<StringArray>()
                        .ok_or(DataWindowError::QueryFailed)?;
                    for value in strings.iter().flatten() {
                        if seen.insert(value.to_owned()) {
                            values.push(value.to_owned());
                            if values.len() == MAX_TEXT_VALUE_SUGGESTIONS {
                                return Ok(TextValueSuggestions {
                                    values,
                                    is_partial: true,
                                });
                            }
                        }
                    }
                }
                Ok(TextValueSuggestions {
                    values,
                    is_partial: false,
                })
            },
        ));
        let values = match values {
            Ok(result) => result?,
            Err(_) if interrupt.cancelled.load(Ordering::Acquire) => {
                return Err(DataWindowError::Cancelled);
            }
            Err(panic) => match &self.source {
                TextValueSuggestionsSource::File(_) => return Err(DataWindowError::QueryFailed),
                TextValueSuggestionsSource::Dataset(dataset) => {
                    return Err(dataset_suggestion_error(
                        dataset.classify_lazy_query_failure(panic.as_ref()),
                    ));
                }
            },
        };
        Self::require_active(interrupt)?;
        if let TextValueSuggestionsSource::Dataset(dataset) = &self.source {
            dataset.validate().map_err(dataset_suggestion_error)?;
        }
        Self::require_active(interrupt)?;
        Ok(values)
    }

    fn fetch_dataset_batches(
        &self,
        connection: &Connection,
        dataset: &DatasetQuerySource,
        input: &str,
        column: &SchemaField,
        match_function: &str,
        interrupt: &TextValueSuggestionsInterruptHandle,
    ) -> Result<TextValueSuggestions, DataWindowError> {
        if !dataset.schema().contains(column) {
            return Err(DataWindowError::InvalidFilter);
        }
        dataset
            .validate_while(|| !interrupt.cancelled.load(Ordering::Acquire))
            .map_err(dataset_suggestion_error)?;
        let mut cursor = dataset.candidate_batches(&[]);
        let query = suggestion_query(&column.name, match_function, &dataset.relation_sql());
        let parameters = [duckdb::types::Value::Text(input.to_owned())];
        let mut seen = HashSet::with_capacity(MAX_TEXT_VALUE_SUGGESTIONS);
        let mut values = Vec::with_capacity(MAX_TEXT_VALUE_SUGGESTIONS);
        while dataset
            .bind_next_candidate_batch(connection, &mut cursor, || {
                !interrupt.cancelled.load(Ordering::Acquire)
            })
            .map_err(dataset_setup_suggestion_error)?
        {
            Self::require_active(interrupt)?;
            let mut statement = connection
                .prepare(&query)
                .map_err(|error| self.classify_error(error, interrupt))?;
            let batches = statement
                .stream_arrow(duckdb::params_from_iter(parameters.iter()))
                .map_err(|error| self.classify_error(error, interrupt))?;
            let partial = catch_unwind(AssertUnwindSafe(|| {
                for batch in batches {
                    let strings = batch
                        .column(0)
                        .as_any()
                        .downcast_ref::<StringArray>()
                        .ok_or(DataWindowError::QueryFailed)?;
                    for value in strings.iter().flatten() {
                        if seen.insert(value.to_owned()) {
                            values.push(value.to_owned());
                            if values.len() == MAX_TEXT_VALUE_SUGGESTIONS {
                                return Ok(true);
                            }
                        }
                    }
                }
                Ok::<_, DataWindowError>(false)
            }))
            .map_err(|panic| {
                if interrupt.cancelled.load(Ordering::Acquire) {
                    DataWindowError::Cancelled
                } else {
                    dataset_suggestion_error(dataset.classify_lazy_query_failure(panic.as_ref()))
                }
            })??;
            if partial {
                dataset
                    .validate_while(|| !interrupt.cancelled.load(Ordering::Acquire))
                    .map_err(dataset_suggestion_error)?;
                Self::require_active(interrupt)?;
                return Ok(TextValueSuggestions {
                    values,
                    is_partial: true,
                });
            }
        }
        dataset
            .validate_while(|| !interrupt.cancelled.load(Ordering::Acquire))
            .map_err(dataset_suggestion_error)?;
        Self::require_active(interrupt)?;
        Ok(TextValueSuggestions {
            values,
            is_partial: false,
        })
    }

    fn require_active(
        interrupt: &TextValueSuggestionsInterruptHandle,
    ) -> Result<(), DataWindowError> {
        if interrupt.cancelled.load(Ordering::Acquire) {
            Err(DataWindowError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn classify_error(
        &self,
        error: DuckDbError,
        interrupt: &TextValueSuggestionsInterruptHandle,
    ) -> DataWindowError {
        if interrupt.cancelled.load(Ordering::Acquire) {
            DataWindowError::Cancelled
        } else {
            match &self.source {
                TextValueSuggestionsSource::File(_) => classify_query_error(error, false),
                TextValueSuggestionsSource::Dataset(dataset) => {
                    dataset_suggestion_error(dataset.classify_query_failure(error, &[], false))
                }
            }
        }
    }
}

fn suggestion_query(column_name: &str, match_function: &str, relation: &str) -> String {
    let identifier = quote_identifier(column_name);
    format!(
        "SELECT value \
         FROM (\
             SELECT CAST({identifier} AS VARCHAR) AS value \
             FROM {relation} \
             WHERE {identifier} IS NOT NULL\
         ) candidates \
         WHERE {match_function}(lower(value), lower(?))"
    )
}

fn dataset_setup_suggestion_error(error: DatasetSetupError) -> DataWindowError {
    match error {
        DatasetSetupError::Dataset(error) => dataset_suggestion_error(error),
        DatasetSetupError::Query(error) => classify_query_error(error, false),
    }
}

fn dataset_suggestion_error(error: DatasetError) -> DataWindowError {
    match error {
        DatasetError::NotFound => DataWindowError::NotFound,
        DatasetError::PermissionDenied => DataWindowError::PermissionDenied,
        DatasetError::SourceChanged { .. } => DataWindowError::SourceChanged,
        DatasetError::InvalidMember { .. } => DataWindowError::CorruptSource,
        DatasetError::Cancelled => DataWindowError::Cancelled,
        DatasetError::Window { error } => error,
        _ => DataWindowError::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, mpsc},
        thread,
        time::Duration,
    };

    use duckdb::{Connection, params};
    use tempfile::tempdir;

    use super::*;
    use crate::DatasetSource;

    #[test]
    fn suggestion_scan_projects_only_the_requested_column() {
        let directory = tempdir().expect("source directory");
        let path = directory.path().join("projection.parquet");
        let path_text = path.to_str().expect("UTF-8 source path");
        let connection = Connection::open_in_memory().expect("fixture connection");
        connection
            .execute("SET VARIABLE __test_path = ?", params![path_text])
            .expect("set output path");
        connection
            .execute(
                "COPY (SELECT range AS ignored, concat('value-', range::VARCHAR) AS label \
                 FROM range(10)) TO (getvariable('__test_path')) (FORMAT PARQUET)",
                [],
            )
            .expect("projection fixture");
        let explain = format!(
            "EXPLAIN {}",
            suggestion_query("label", "contains", "read_parquet(?)")
        );
        let plan = connection
            .prepare(&explain)
            .expect("explain statement")
            .query_map(params![path_text, "value"], |row| row.get::<_, String>(1))
            .expect("explain rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("physical plan")
            .join("\n");

        assert!(plan.contains("Projections: label"), "{plan}");
        assert!(!plan.contains("ignored"), "{plan}");
    }

    #[test]
    fn dataset_suggestions_reuse_static_member_metadata_across_fetches() {
        let directory = tempdir().expect("dataset directory");
        let fixture = Connection::open_in_memory().expect("fixture connection");
        for (name, value) in [("a.parquet", "alpha"), ("b.parquet", "beta")] {
            let path = directory.path().join(name);
            fixture
                .execute(
                    "SET VARIABLE __test_path = ?",
                    params![path.to_str().expect("UTF-8 fixture path")],
                )
                .expect("fixture path");
            fixture
                .execute(
                    "COPY (SELECT ?::VARCHAR AS label) \
                     TO (getvariable('__test_path')) (FORMAT PARQUET)",
                    params![value],
                )
                .expect("dataset member fixture");
        }
        let source = DatasetSource::open_folder(directory.path()).expect("dataset source");
        let mut inspector = source.inspector();
        inspector.advance(2).expect("dataset inspection");
        let dataset = inspector.into_window_reader().expect("dataset reader");
        let label = dataset.summary().schema[0].clone();
        let reader =
            TextValueSuggestionsReader::for_dataset(&dataset).expect("dataset suggestions reader");

        let first = reader.interrupt_handle();
        assert_eq!(
            reader
                .fetch("alp", &label, DataFilterOperator::Equals, &first)
                .expect("first suggestions")
                .values,
            ["alpha"]
        );
        reader
            .connection
            .lock()
            .expect("suggestions connection")
            .execute(
                "INSERT INTO __viewda_members VALUES (999, 'marker', 'marker', 0)",
                [],
            )
            .expect("metadata initialization marker");

        let second = reader.interrupt_handle();
        assert_eq!(
            reader
                .fetch("bet", &label, DataFilterOperator::Equals, &second)
                .expect("second suggestions")
                .values,
            ["beta"]
        );
        let member_metadata_rows = reader
            .connection
            .lock()
            .expect("suggestions connection")
            .query_row("SELECT count(*) FROM __viewda_members", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("static member metadata count");
        assert_eq!(member_metadata_rows, 2);

        let cancelled = reader.interrupt_handle();
        assert_eq!(
            reader.fetch_checked(
                "alp",
                &label,
                DataFilterOperator::Equals,
                &cancelled,
                || cancelled.interrupt(),
            ),
            Err(DataWindowError::Cancelled)
        );
        let retry = reader.interrupt_handle();
        assert_eq!(
            reader
                .fetch("alp", &label, DataFilterOperator::Equals, &retry)
                .expect("retry after setup-boundary cancellation")
                .values,
            ["alpha"]
        );
    }

    #[test]
    fn interrupting_an_active_scan_returns_cancelled_instead_of_partial_values() {
        let directory = tempdir().expect("source directory");
        let path = directory.path().join("large-text.parquet");
        let path_text = path.to_str().expect("UTF-8 source path");
        let fixture = Connection::open_in_memory().expect("fixture connection");
        fixture
            .execute("SET VARIABLE __test_path = ?", params![path_text])
            .expect("set output path");
        fixture
            .execute(
                "COPY (SELECT concat('value-', range::VARCHAR) AS label FROM range(?)) \
                 TO (getvariable('__test_path')) (FORMAT PARQUET)",
                params![8_000_000_i64],
            )
            .expect("large text fixture");

        let reader = Arc::new(TextValueSuggestionsReader::new(path).expect("suggestion reader"));
        let interrupt = Arc::new(reader.interrupt_handle());
        let scan_reader = Arc::clone(&reader);
        let scan_interrupt = Arc::clone(&interrupt);
        let column = SchemaField {
            name: "label".to_owned(),
            physical_type: "BYTE_ARRAY".to_owned(),
            logical_type: Some("String".to_owned()),
            children: Vec::new(),
        };
        let scan_column = column.clone();
        let (started_sender, started_receiver) = mpsc::sync_channel(0);
        let (finished_sender, finished_receiver) = mpsc::sync_channel(1);
        let scan = thread::spawn(move || {
            started_sender.send(()).expect("scan start receiver");
            finished_sender
                .send(scan_reader.fetch(
                    "not-present",
                    &scan_column,
                    DataFilterOperator::Equals,
                    &scan_interrupt,
                ))
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
            Ok(Err(DataWindowError::Cancelled))
        );
        scan.join().expect("scan thread should stop");

        let retry = reader.interrupt_handle();
        let suggestions = reader
            .fetch("value-1", &column, DataFilterOperator::Equals, &retry)
            .expect("the reused connection should accept the next scan");
        assert_eq!(suggestions.values.len(), MAX_TEXT_VALUE_SUGGESTIONS);
        assert!(suggestions.is_partial);
    }
}
