use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
};

use arrow_ipc::writer::StreamWriter;
use duckdb::{Config, Connection, Error as DuckDbError, types::Value};
use serde::Serialize;
use thiserror::Error;

use crate::{
    FieldPath,
    field_path::{field_path_expression, validate_field_paths},
    filter::quote_identifier,
    json_path::{field_is_json, json_schema_sample_expression},
    source::{
        SchemaField, SourceError, SourceSummary, inspect_local_source_for_query, open_local_source,
    },
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
    /// The source path no longer identifies the file opened by the caller.
    #[error("The selected file changed after it was opened.")]
    SourceChanged,
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
    summary: Option<SourceSummary>,
}

impl DataWindowReader {
    /// Creates a reader for a Rust-owned path inspected by the caller.
    pub fn new(source_path: PathBuf) -> Self {
        Self {
            source_path,
            connection: None,
            summary: None,
        }
    }

    /// Reads a bounded file-order window and encodes it as Arrow IPC.
    pub fn fetch(&mut self, row_offset: u64, row_count: u32) -> Result<Vec<u8>, DataWindowError> {
        validate_window_size(row_count)?;
        self.fetch_projection(row_offset, row_count, None)
    }

    /// Reads selected addressable fields in the requested order without changing file order.
    pub fn fetch_fields(
        &mut self,
        row_offset: u64,
        row_count: u32,
        field_paths: &[FieldPath],
    ) -> Result<Vec<u8>, DataWindowError> {
        validate_window_size(row_count)?;
        if field_paths.is_empty() {
            return Err(DataWindowError::Unsupported);
        }
        let projection = {
            let summary = match &self.summary {
                Some(summary) => summary,
                None => self.summary.insert(
                    inspect_local_source_for_query(&self.source_path)
                        .map_err(DataWindowError::from)?,
                ),
            };
            let schema = &summary.schema;
            validate_field_paths(schema, field_paths).ok_or(DataWindowError::Unsupported)?;
            if is_identity_projection(schema, field_paths) {
                None
            } else {
                let source_columns = (0..schema.len())
                    .map(|index| format!("__viewda_column_{index}"))
                    .collect::<Vec<_>>();
                let projection = format_projection_expressions(
                    schema,
                    field_paths,
                    &source_columns,
                    Some("__viewda_source"),
                )?;
                let aliases = source_columns
                    .iter()
                    .map(|column| quote_identifier(column))
                    .collect::<Vec<_>>()
                    .join(", ");
                let source_row_count = if field_paths.iter().any(|path| path.segments().len() > 1) {
                    Some(
                        i64::try_from(summary.row_count)
                            .map_err(|_| DataWindowError::Unsupported)?,
                    )
                } else {
                    None
                };
                Some((projection, aliases, source_row_count))
            }
        };

        self.fetch_projection(
            row_offset,
            row_count,
            projection
                .as_ref()
                .map(|(projection, aliases, source_row_count)| {
                    (projection.as_str(), aliases.as_str(), *source_row_count)
                }),
        )
    }

    /// Reads the first bounded, size-limited values from one Parquet JSON column.
    pub fn fetch_json_schema_sample(
        &mut self,
        field_path: &FieldPath,
    ) -> Result<Vec<u8>, DataWindowError> {
        let (projection, aliases) = {
            let summary = match &self.summary {
                Some(summary) => summary,
                None => self.summary.insert(
                    inspect_local_source_for_query(&self.source_path)
                        .map_err(DataWindowError::from)?,
                ),
            };
            let resolved = crate::field_path::resolve_field_path(&summary.schema, field_path)
                .filter(|resolved| field_is_json(resolved.field))
                .ok_or(DataWindowError::Unsupported)?;
            let source_columns = (0..summary.schema.len())
                .map(|index| format!("__viewda_column_{index}"))
                .collect::<Vec<_>>();
            let root = format!(
                "{}.{}",
                quote_identifier("__viewda_source"),
                quote_identifier(&source_columns[resolved.root_index])
            );
            let field =
                field_path_expression(field_path, &root).ok_or(DataWindowError::Unsupported)?;
            let projection = format!(
                "{} AS {}",
                json_schema_sample_expression(&field),
                quote_identifier(field_path.leaf_name().ok_or(DataWindowError::Unsupported)?),
            );
            let aliases = source_columns
                .iter()
                .map(|column| quote_identifier(column))
                .collect::<Vec<_>>()
                .join(", ");
            (projection, aliases)
        };

        // A JSON sample is row-bounded, so it must not install the full-row-count range used to
        // protect ordinary nested leaf windows from projection widening.
        let sample = self.fetch_projection(
            0,
            crate::JSON_SCHEMA_SAMPLE_ROW_LIMIT,
            Some((&projection, &aliases, None)),
        )?;
        if sample.len() > crate::JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT {
            return Err(DataWindowError::WindowTooLarge);
        }
        Ok(sample)
    }

    fn fetch_projection(
        &mut self,
        row_offset: u64,
        row_count: u32,
        projection: Option<(&str, &str, Option<i64>)>,
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
        let (sql, parameters) = match projection {
            None => (
                "SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?".to_owned(),
                vec![
                    Value::Text(path.to_owned()),
                    Value::BigInt(i64::from(row_count)),
                    Value::BigInt(row_offset),
                ],
            ),
            Some((projection, aliases, source_row_count)) => {
                let mut parameters = vec![Value::Text(path.to_owned())];
                if let Some(source_row_count) = source_row_count {
                    parameters.push(Value::BigInt(source_row_count));
                }
                parameters.extend([
                    Value::BigInt(i64::from(row_count)),
                    Value::BigInt(row_offset),
                ]);
                (
                    projected_window_query(projection, aliases, source_row_count.is_some()),
                    parameters,
                )
            }
        };
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

fn projected_window_query(projection: &str, aliases: &str, nested: bool) -> String {
    // The matching range leaves cardinality and order unchanged while preventing DuckDB's LIMIT
    // pushdown from widening a nested Parquet leaf projection. Top-level subsets do not need it.
    let leaf_projection_guard = if nested {
        " POSITIONAL JOIN range(?)"
    } else {
        ""
    };
    format!(
        "SELECT {projection} FROM read_parquet(?) \
         AS \"__viewda_source\"({aliases}){leaf_projection_guard} LIMIT ? OFFSET ?"
    )
}

#[cfg(test)]
fn format_projection_clause(
    schema: &[SchemaField],
    field_paths: &[FieldPath],
) -> Result<String, DataWindowError> {
    if is_identity_projection(schema, field_paths) {
        Ok("*".to_owned())
    } else {
        let roots = schema
            .iter()
            .map(|field| field.name.clone())
            .collect::<Vec<_>>();
        format_projection_expressions(schema, field_paths, &roots, None)
    }
}

fn is_identity_projection(schema: &[SchemaField], field_paths: &[FieldPath]) -> bool {
    field_paths.len() == schema.len()
        && field_paths
            .iter()
            .zip(schema)
            .all(|(path, field)| path.segments() == [field.name.as_str()])
}

fn format_projection_expressions(
    schema: &[SchemaField],
    field_paths: &[FieldPath],
    root_names: &[String],
    source_alias: Option<&str>,
) -> Result<String, DataWindowError> {
    if root_names.len() != schema.len() {
        return Err(DataWindowError::Unsupported);
    }
    field_paths
        .iter()
        .map(|path| {
            let resolved = crate::field_path::resolve_field_path(schema, path)
                .ok_or(DataWindowError::Unsupported)?;
            let root = quote_identifier(
                root_names
                    .get(resolved.root_index)
                    .ok_or(DataWindowError::Unsupported)?,
            );
            let root = source_alias
                .map(|source| format!("{}.{}", quote_identifier(source), root))
                .unwrap_or(root);
            let expression =
                field_path_expression(path, &root).ok_or(DataWindowError::Unsupported)?;
            Ok(format!(
                "{expression} AS {}",
                quote_identifier(path.leaf_name().ok_or(DataWindowError::Unsupported)?)
            ))
        })
        .collect::<Result<Vec<_>, DataWindowError>>()
        .map(|expressions| expressions.join(", "))
}

fn validate_window_size(row_count: u32) -> Result<(), DataWindowError> {
    if row_count > MAX_WINDOW_ROWS {
        Err(DataWindowError::WindowTooLarge)
    } else {
        Ok(())
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
            SourceError::SourceChanged => Self::SourceChanged,
            SourceError::NotParquet => Self::NotParquet,
            SourceError::CorruptFooter => Self::CorruptSource,
            SourceError::Unsupported => Self::Unsupported,
        }
    }
}
#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use arrow_array::Int64Array;
    use arrow_ipc::reader::StreamReader;
    use duckdb::params;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn direct_windows_choose_simple_top_level_and_leaf_pruned_nested_plans() {
        let directory = tempdir().expect("projection fixture directory");
        let path = directory.path().join("nested-projection.parquet");
        let path_text = path.to_str().expect("UTF-8 fixture path");
        let connection = Connection::open_in_memory().expect("fixture connection");
        connection
            .execute("SET VARIABLE __test_path = ?", params![path_text])
            .expect("set fixture path");
        connection
            .execute(
                "COPY (SELECT range AS id, \
                 struct_pack(wanted := range, ignored := repeat('x', 1000)) AS profile \
                 FROM range(10)) TO (getvariable('__test_path')) (FORMAT PARQUET)",
                [],
            )
            .expect("nested projection fixture");
        let schema = inspect_local_source_for_query(&path)
            .expect("projection fixture schema")
            .schema;
        let source_columns = (0..schema.len())
            .map(|index| format!("__viewda_column_{index}"))
            .collect::<Vec<_>>();
        let aliases = source_columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let projection = format_projection_expressions(
            &schema,
            &[FieldPath::new(["profile", "wanted"])],
            &source_columns,
            Some("__viewda_source"),
        )
        .expect("nested projection clause");
        let query = projected_window_query(&projection, &aliases, true);
        let plan = connection
            .prepare(&format!("EXPLAIN {query}"))
            .expect("explain nested window")
            .query_map(params![path_text, 10_i64, 1_i64, 0_i64], |row| {
                row.get::<_, String>(1)
            })
            .expect("explain rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("physical plan")
            .join("\n");

        assert!(plan.contains("__viewda_column_1.wanted"), "{plan}");
        assert!(!plan.contains("ignored"), "{plan}");

        let sample_query = projected_window_query(&projection, &aliases, false);
        assert!(!sample_query.contains("range("), "{sample_query}");
        let sample_plan = connection
            .prepare(&format!("EXPLAIN {sample_query}"))
            .expect("explain bounded nested sample")
            .query_map(params![path_text, 1_i64, 0_i64], |row| {
                row.get::<_, String>(1)
            })
            .expect("explain bounded nested sample rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("bounded nested sample physical plan")
            .join("\n");
        assert!(sample_plan.contains("STREAMING_LIMIT"), "{sample_plan}");
        assert!(!sample_plan.contains("POSITIONAL_SCAN"), "{sample_plan}");

        let projection = format_projection_expressions(
            &schema,
            &[FieldPath::from("id")],
            &source_columns,
            Some("__viewda_source"),
        )
        .expect("top-level projection clause");
        let query = projected_window_query(&projection, &aliases, false);
        let plan = connection
            .prepare(&format!("EXPLAIN {query}"))
            .expect("explain top-level window")
            .query_map(params![path_text, 1_i64, 8_i64], |row| {
                row.get::<_, String>(1)
            })
            .expect("explain rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("physical plan")
            .join("\n");
        assert!(!plan.contains("POSITIONAL_SCAN"), "{plan}");
        assert!(plan.contains("__viewda_column_0"), "{plan}");

        let mut reader = DataWindowReader::new(path);
        let bytes = reader
            .fetch_fields(0, 1, &[FieldPath::new(["profile", "wanted"])])
            .expect("nested leaf window");
        let batch = StreamReader::try_new(Cursor::new(bytes), None)
            .expect("Arrow IPC stream")
            .next()
            .expect("one batch")
            .expect("valid batch");
        assert_eq!(batch.schema().field(0).name(), "wanted");
        assert_eq!(
            batch
                .column(0)
                .as_any()
                .downcast_ref::<Int64Array>()
                .expect("wanted integers")
                .value(0),
            0
        );
        let bytes = reader
            .fetch_fields(8, 1, &[FieldPath::from("id")])
            .expect("top-level projected window");
        let batch = StreamReader::try_new(Cursor::new(bytes), None)
            .expect("Arrow IPC stream")
            .next()
            .expect("one batch")
            .expect("valid batch");
        assert_eq!(
            batch
                .column(0)
                .as_any()
                .downcast_ref::<Int64Array>()
                .expect("id integers")
                .values(),
            &[8]
        );
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
            format_projection_clause(
                &schema,
                &[FieldPath::from("label"), FieldPath::from("value\"quoted")]
            ),
            Ok("\"label\" AS \"label\", \"value\"\"quoted\" AS \"value\"\"quoted\"".to_owned())
        );
        assert_eq!(
            format_projection_clause(
                &schema,
                &[
                    FieldPath::from("value\"quoted"),
                    FieldPath::from("label"),
                    FieldPath::from("amount")
                ]
            ),
            Ok("*".to_owned())
        );
    }
}
