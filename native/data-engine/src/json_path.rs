//! Sampled JSON-field discovery and safe DuckDB extraction expressions.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
};

use arrow_array::{
    Array, BinaryArray, LargeBinaryArray, LargeStringArray, RecordBatch, StringArray,
};
use arrow_ipc::reader::StreamReader;
use serde::{Deserialize, Serialize};

use crate::{SchemaField, window::DataWindowError};

/// Source rows inspected when discovering paths in one JSON column.
pub const JSON_SCHEMA_SAMPLE_ROW_LIMIT: u32 = 512;
/// Maximum Unicode scalar values retained from any one source value.
pub const JSON_SCHEMA_SAMPLE_VALUE_CHARACTER_LIMIT: usize = 2_048;
/// Maximum UTF-8 bytes parsed from any one sampled JSON value.
pub const JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT: usize = JSON_SCHEMA_SAMPLE_VALUE_CHARACTER_LIMIT * 4;
/// Maximum UTF-8 bytes parsed across one sampled JSON column window.
pub const JSON_SCHEMA_SAMPLE_TOTAL_BYTE_LIMIT: usize = 4 * 1024 * 1024;
/// Maximum encoded Arrow bytes accepted at the inference boundary.
pub const JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT: usize =
    JSON_SCHEMA_SAMPLE_ROW_LIMIT as usize * (JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT + 1) + 1024 * 1024;
const MAX_JSON_PATH_SEGMENTS: usize = 64;
const MAX_JSON_PATH_BYTES: usize = 4_096;
const MAX_JSON_SCHEMA_NODES: usize = 4_096;
pub(crate) const JSON_NUMBER_SQL_TYPE: &str = "DECIMAL(38, 18)";

/// One object-field or array-index step inside a JSON value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JsonPathSegment {
    /// An object key, including empty keys and keys containing punctuation.
    Field(String),
    /// A zero-based array index.
    Index(u32),
}

/// An address inside a JSON column, independent from Parquet [`crate::FieldPath`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct JsonPath(Vec<JsonPathSegment>);

impl JsonPath {
    /// Creates a JSON path from object-field and array-index segments.
    pub fn new(segments: impl IntoIterator<Item = JsonPathSegment>) -> Self {
        Self(segments.into_iter().collect())
    }

    /// Returns the path segments in traversal order.
    pub fn segments(&self) -> &[JsonPathSegment] {
        &self.0
    }

    fn validate(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= MAX_JSON_PATH_SEGMENTS
            && self
                .0
                .iter()
                .map(json_path_segment_bytes)
                .try_fold(0_usize, usize::checked_add)
                .is_some_and(|bytes| bytes <= MAX_JSON_PATH_BYTES)
    }
}

fn json_path_segment_bytes(segment: &JsonPathSegment) -> usize {
    match segment {
        JsonPathSegment::Field(name) => name.len(),
        JsonPathSegment::Index(index) => index.to_string().len(),
    }
}

/// Scalar behavior requested for one extracted JSON path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JsonValueType {
    Boolean,
    Number,
    Text,
    /// More than one non-null JSON type was observed; comparisons use text.
    Mixed,
}

/// An optional JSON extraction applied below an existing Parquet column path.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonFieldTarget {
    pub path: JsonPath,
    pub value_type: JsonValueType,
}

/// SQL representation of one extracted JSON field.
pub(crate) enum JsonFieldExpression {
    Scalar(String),
    Number(JsonNumberExpression),
}

/// SQL keys that preserve numeric order across exact integers and canonical floating values.
pub(crate) struct JsonNumberExpression {
    pub(crate) finite: String,
    pub(crate) bucket_tie: String,
}

/// JSON types observed for one path in the bounded sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JsonObservedType {
    Null,
    Boolean,
    Number,
    String,
    Object,
    Array,
}

/// One node in a sampled JSON path tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSchemaNode {
    pub segment: JsonPathSegment,
    pub observed_types: Vec<JsonObservedType>,
    pub effective_type: Option<JsonValueType>,
    pub children: Vec<JsonSchemaNode>,
}

/// Bounded discovery result for one Parquet JSON column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSchemaInference {
    /// Always true: paths come from source values, not a declared JSON schema.
    pub is_sample_derived: bool,
    /// The fixed upper bound on inspected source rows.
    pub sample_row_limit: u32,
    /// Per-value UTF-8 byte bound applied before JSON parsing.
    pub sample_value_byte_limit: usize,
    /// Per-value Unicode-scalar bound applied by the source query.
    pub sample_value_character_limit: usize,
    /// Aggregate UTF-8 byte bound applied before JSON parsing.
    pub sample_total_byte_limit: usize,
    /// Encoded Arrow byte bound applied before stream decoding.
    pub sample_arrow_byte_limit: usize,
    /// Rows present in the supplied first-window sample.
    pub sampled_row_count: u32,
    /// UTF-8 bytes admitted to the JSON parser.
    pub sampled_value_bytes: usize,
    /// Whether source rows exist beyond the inspected sample.
    pub has_more_rows: bool,
    /// Whether path/depth guards omitted part of otherwise sampled values.
    pub is_truncated: bool,
    /// Values that could not be decoded as UTF-8 JSON despite the Parquet annotation.
    pub invalid_value_count: u32,
    /// Values skipped before parsing because a per-value or aggregate sample limit was reached.
    pub oversized_value_count: u32,
    pub nodes: Vec<JsonSchemaNode>,
}

#[derive(Default)]
struct InferredNode {
    observed_types: BTreeSet<JsonObservedType>,
    children: BTreeMap<JsonPathSegment, InferredNode>,
}

/// Infers a bounded path tree from an Arrow window containing one projected JSON field.
///
/// The caller supplies the first [`JSON_SCHEMA_SAMPLE_ROW_LIMIT`] source rows. Paths absent from
/// this result remain valid manual [`JsonFieldTarget`] values; the sample never acts as an allowlist.
pub fn infer_json_schema_from_arrow(
    field: &SchemaField,
    arrow: &[u8],
    source_row_count: u64,
) -> Result<JsonSchemaInference, DataWindowError> {
    if field.logical_type.as_deref() != Some("JSON") || field.physical_type == "GROUP" {
        return Err(DataWindowError::Unsupported);
    }
    if arrow.len() > JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT {
        return Err(DataWindowError::WindowTooLarge);
    }
    let batches = StreamReader::try_new(Cursor::new(arrow), None)
        .map_err(|_| DataWindowError::CorruptSource)?;
    let mut root = InferredNode::default();
    let mut sampled_row_count = 0_u32;
    let mut invalid_value_count = 0_u32;
    let mut oversized_value_count = 0_u32;
    let mut sampled_bytes = 0_usize;
    let mut node_count = 0_usize;
    let mut is_truncated = false;
    for batch in batches {
        let batch = batch.map_err(|_| DataWindowError::CorruptSource)?;
        if batch.num_columns() != 1 {
            return Err(DataWindowError::Unsupported);
        }
        sampled_row_count = sampled_row_count
            .checked_add(u32::try_from(batch.num_rows()).map_err(|_| DataWindowError::Unsupported)?)
            .ok_or(DataWindowError::Unsupported)?;
        visit_json_strings(&batch, |value| match value {
            JsonSampleValue::Text(value) => {
                if !sample_value_fits(value.len(), &mut sampled_bytes) {
                    oversized_value_count = oversized_value_count.saturating_add(1);
                    is_truncated = true;
                    return;
                }
                match serde_json::from_str::<serde_json::Value>(value) {
                    Ok(value) => observe_children(
                        &mut root,
                        &value,
                        0,
                        0,
                        &mut node_count,
                        &mut is_truncated,
                    ),
                    Err(_) => invalid_value_count = invalid_value_count.saturating_add(1),
                }
            }
            JsonSampleValue::InvalidUtf8 => {
                invalid_value_count = invalid_value_count.saturating_add(1)
            }
            JsonSampleValue::Null => {}
        })?;
    }
    if sampled_row_count > JSON_SCHEMA_SAMPLE_ROW_LIMIT {
        return Err(DataWindowError::WindowTooLarge);
    }
    Ok(JsonSchemaInference {
        is_sample_derived: true,
        sample_row_limit: JSON_SCHEMA_SAMPLE_ROW_LIMIT,
        sample_value_byte_limit: JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT,
        sample_value_character_limit: JSON_SCHEMA_SAMPLE_VALUE_CHARACTER_LIMIT,
        sample_total_byte_limit: JSON_SCHEMA_SAMPLE_TOTAL_BYTE_LIMIT,
        sample_arrow_byte_limit: JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT,
        sampled_row_count,
        sampled_value_bytes: sampled_bytes,
        has_more_rows: source_row_count > u64::from(sampled_row_count),
        is_truncated,
        invalid_value_count,
        oversized_value_count,
        nodes: finish_children(root.children),
    })
}

fn sample_value_fits(value_bytes: usize, sampled_bytes: &mut usize) -> bool {
    let Some(next_bytes) = sampled_bytes.checked_add(value_bytes) else {
        return false;
    };
    if value_bytes > JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT
        || next_bytes > JSON_SCHEMA_SAMPLE_TOTAL_BYTE_LIMIT
    {
        return false;
    }
    *sampled_bytes = next_bytes;
    true
}

enum JsonSampleValue<'a> {
    Null,
    Text(&'a str),
    InvalidUtf8,
}

fn visit_json_strings(
    batch: &RecordBatch,
    mut visit: impl FnMut(JsonSampleValue<'_>),
) -> Result<(), DataWindowError> {
    let column = batch.column(0);
    if let Some(values) = column.as_any().downcast_ref::<StringArray>() {
        values
            .iter()
            .for_each(|value| visit(value.map_or(JsonSampleValue::Null, JsonSampleValue::Text)));
        return Ok(());
    }
    if let Some(values) = column.as_any().downcast_ref::<LargeStringArray>() {
        values
            .iter()
            .for_each(|value| visit(value.map_or(JsonSampleValue::Null, JsonSampleValue::Text)));
        return Ok(());
    }
    if let Some(values) = column.as_any().downcast_ref::<BinaryArray>() {
        for value in values.iter() {
            visit(match value {
                None => JsonSampleValue::Null,
                Some(value) => std::str::from_utf8(value)
                    .map(JsonSampleValue::Text)
                    .unwrap_or(JsonSampleValue::InvalidUtf8),
            });
        }
        return Ok(());
    }
    if let Some(values) = column.as_any().downcast_ref::<LargeBinaryArray>() {
        for value in values.iter() {
            visit(match value {
                None => JsonSampleValue::Null,
                Some(value) => std::str::from_utf8(value)
                    .map(JsonSampleValue::Text)
                    .unwrap_or(JsonSampleValue::InvalidUtf8),
            });
        }
        return Ok(());
    }
    Err(DataWindowError::Unsupported)
}

fn observe_children(
    parent: &mut InferredNode,
    value: &serde_json::Value,
    depth: usize,
    path_bytes: usize,
    node_count: &mut usize,
    is_truncated: &mut bool,
) {
    if depth >= MAX_JSON_PATH_SEGMENTS {
        if matches!(
            value,
            serde_json::Value::Object(_) | serde_json::Value::Array(_)
        ) {
            *is_truncated = true;
        }
        return;
    }
    match value {
        serde_json::Value::Object(fields) => {
            for (name, value) in fields {
                observe_child(
                    parent,
                    JsonPathSegment::Field(name.clone()),
                    value,
                    depth,
                    path_bytes,
                    node_count,
                    is_truncated,
                );
            }
        }
        serde_json::Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                let Ok(index) = u32::try_from(index) else {
                    *is_truncated = true;
                    break;
                };
                observe_child(
                    parent,
                    JsonPathSegment::Index(index),
                    value,
                    depth,
                    path_bytes,
                    node_count,
                    is_truncated,
                );
            }
        }
        _ => {}
    }
}

fn observe_child(
    parent: &mut InferredNode,
    segment: JsonPathSegment,
    value: &serde_json::Value,
    depth: usize,
    path_bytes: usize,
    node_count: &mut usize,
    is_truncated: &mut bool,
) {
    let Some(child_path_bytes) = path_bytes.checked_add(json_path_segment_bytes(&segment)) else {
        *is_truncated = true;
        return;
    };
    if child_path_bytes > MAX_JSON_PATH_BYTES {
        *is_truncated = true;
        return;
    }
    if !parent.children.contains_key(&segment) {
        if *node_count == MAX_JSON_SCHEMA_NODES {
            *is_truncated = true;
            return;
        }
        *node_count += 1;
    }
    let child = parent.children.entry(segment).or_default();
    child.observed_types.insert(observed_type(value));
    observe_children(
        child,
        value,
        depth + 1,
        child_path_bytes,
        node_count,
        is_truncated,
    );
}

fn observed_type(value: &serde_json::Value) -> JsonObservedType {
    match value {
        serde_json::Value::Null => JsonObservedType::Null,
        serde_json::Value::Bool(_) => JsonObservedType::Boolean,
        serde_json::Value::Number(_) => JsonObservedType::Number,
        serde_json::Value::String(_) => JsonObservedType::String,
        serde_json::Value::Object(_) => JsonObservedType::Object,
        serde_json::Value::Array(_) => JsonObservedType::Array,
    }
}

fn finish_children(children: BTreeMap<JsonPathSegment, InferredNode>) -> Vec<JsonSchemaNode> {
    children
        .into_iter()
        .map(|(segment, node)| {
            let observed_types = node.observed_types.into_iter().collect::<Vec<_>>();
            JsonSchemaNode {
                segment,
                effective_type: effective_type(&observed_types),
                observed_types,
                children: finish_children(node.children),
            }
        })
        .collect()
}

fn effective_type(observed: &[JsonObservedType]) -> Option<JsonValueType> {
    let non_null = observed
        .iter()
        .copied()
        .filter(|value| *value != JsonObservedType::Null)
        .collect::<Vec<_>>();
    match non_null.as_slice() {
        [] => None,
        [JsonObservedType::Boolean] => Some(JsonValueType::Boolean),
        [JsonObservedType::Number] => Some(JsonValueType::Number),
        [JsonObservedType::String] => Some(JsonValueType::Text),
        [JsonObservedType::Object | JsonObservedType::Array] => None,
        _ => Some(JsonValueType::Mixed),
    }
}

pub(crate) fn json_field_expression(
    root: &str,
    target: &JsonFieldTarget,
) -> Option<JsonFieldExpression> {
    // This is the sole extraction boundary. A future materialized value must provide the same
    // scalar or numeric pair, so filters, sorting, JSON paths, and the wire remain unchanged.
    if !target.path.validate() {
        return None;
    }
    let path = target.path.segments().iter().try_fold(
        "$".to_owned(),
        |mut path, segment| -> Option<String> {
            match segment {
                JsonPathSegment::Field(name) => {
                    path.push('.');
                    path.push_str(&serde_json::to_string(name).ok()?);
                }
                JsonPathSegment::Index(index) => {
                    path.push('[');
                    path.push_str(&index.to_string());
                    path.push(']');
                }
            }
            Some(path)
        },
    )?;
    let json = format!("TRY_CAST({root} AS JSON)");
    let path = quote_string_literal(&path);
    let extracted = format!("json_extract({json}, {path})");
    Some(match target.value_type {
        JsonValueType::Boolean => {
            JsonFieldExpression::Scalar(format!("TRY_CAST({extracted} AS BOOLEAN)"))
        }
        JsonValueType::Number => JsonFieldExpression::Number(json_number_expression(&extracted)),
        JsonValueType::Text | JsonValueType::Mixed => {
            JsonFieldExpression::Scalar(format!("json_extract_string({json}, {path})"))
        }
    })
}

fn json_number_expression(extracted: &str) -> JsonNumberExpression {
    let raw = format!("json_extract_string({extracted}, '$')");
    let json_type = format!("json_type({extracted})");
    let number_type = format!("{json_type} IN ('BIGINT', 'UBIGINT', 'DOUBLE')");
    let exact_type = format!("{json_type} IN ('BIGINT', 'UBIGINT')");
    let decimal = format!("TRY_CAST({raw} AS {JSON_NUMBER_SQL_TYPE})");
    let double = format!("TRY_CAST({raw} AS DOUBLE)");

    let finite = format!("CASE WHEN {number_type} AND isfinite({double}) THEN {double} END");
    let bucket_tie = format!(
        "CASE WHEN {exact_type} THEN {decimal} \
         WHEN {number_type} AND isfinite({double}) \
         THEN TRY_CAST({double} AS {JSON_NUMBER_SQL_TYPE}) END"
    );

    JsonNumberExpression { finite, bucket_tie }
}

/// Reports whether a textual bound is an integer representable by the fixed-decimal tie key.
pub(crate) fn json_number_is_exact_integer_bound(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut cursor = usize::from(bytes.first() == Some(&b'-'));
    if cursor == bytes.len() {
        return false;
    }
    if bytes[cursor] == b'0' {
        cursor += 1;
        if bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            return false;
        }
    } else if bytes[cursor].is_ascii_digit() && bytes[cursor] != b'0' {
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
    } else {
        return false;
    }
    let mut fraction_length = 0_usize;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        fraction_length = cursor - fraction_start;
        if fraction_length == 0 {
            return false;
        }
    }
    let fraction_end = cursor;
    let exponent = if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        let exponent_start = cursor;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let exponent_digits = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if exponent_digits == cursor {
            return false;
        }
        value[exponent_start..cursor].parse::<i64>().ok()
    } else {
        Some(0)
    };
    if cursor != bytes.len() {
        return false;
    }
    let Some(exponent) = exponent else {
        return false;
    };
    let digits = bytes[..fraction_end]
        .iter()
        .copied()
        .filter(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    let significant = digits
        .iter()
        .copied()
        .skip_while(|digit| *digit == b'0')
        .collect::<Vec<_>>();
    let coefficient_length = significant
        .iter()
        .rposition(|digit| *digit != b'0')
        .map_or(0, |index| index + 1);
    let trailing_zeroes = significant.len() - coefficient_length;
    let Ok(fraction_length) = i64::try_from(fraction_length) else {
        return false;
    };
    let Ok(trailing_zeroes) = i64::try_from(trailing_zeroes) else {
        return false;
    };
    let Ok(coefficient_length) = i64::try_from(coefficient_length) else {
        return false;
    };
    let Some(power) = exponent
        .checked_sub(fraction_length)
        .and_then(|power| power.checked_add(trailing_zeroes))
    else {
        return false;
    };

    coefficient_length == 0
        || (power >= 0
            && coefficient_length
                .checked_add(power)
                .is_some_and(|integer_digits| integer_digits <= 20))
}

pub(crate) fn json_schema_sample_expression(root: &str) -> String {
    // Every retained character is at most four UTF-8 bytes. Longer values become a fixed marker
    // one byte beyond the parser limit, keeping the Arrow sample bounded while preserving the
    // distinction between null, invalid JSON, and an intentionally skipped oversized value.
    format!(
        "CASE WHEN length(CAST({root} AS VARCHAR)) > {character_limit} \
         THEN repeat('x', {oversized_marker_bytes}) ELSE CAST({root} AS VARCHAR) END",
        character_limit = JSON_SCHEMA_SAMPLE_VALUE_CHARACTER_LIMIT,
        oversized_marker_bytes = JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT + 1,
    )
}

pub(crate) fn field_is_json(field: &SchemaField) -> bool {
    field.physical_type != "GROUP" && field.logical_type.as_deref() == Some("JSON")
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow_array::{ArrayRef, BinaryArray, RecordBatch};
    use arrow_ipc::writer::StreamWriter;
    use arrow_schema::{DataType, Field, Schema};
    use duckdb::Connection;
    use serde_json::json;

    use super::*;

    #[test]
    fn json_path_wire_distinguishes_object_fields_and_array_indices() {
        let path = JsonPath::new([
            JsonPathSegment::Field("items".to_owned()),
            JsonPathSegment::Index(2),
            JsonPathSegment::Field("unit.price".to_owned()),
        ]);

        assert_eq!(
            serde_json::to_value(&path).expect("serialize JSON path"),
            json!([{ "field": "items" }, { "index": 2 }, { "field": "unit.price" }])
        );
        assert_eq!(
            serde_json::from_value::<JsonPath>(json!([
                { "field": "items" },
                { "index": 2 },
                { "field": "unit.price" }
            ]))
            .expect("deserialize JSON path"),
            path
        );
    }

    #[test]
    fn extraction_preserves_typed_segments_and_escapes_jsonpath_fields() {
        let target = JsonFieldTarget {
            path: JsonPath::new([
                JsonPathSegment::Field("0.a\\b[\"c']".to_owned()),
                JsonPathSegment::Index(10),
            ]),
            value_type: JsonValueType::Mixed,
        };

        let Some(JsonFieldExpression::Scalar(expression)) =
            json_field_expression("payload", &target)
        else {
            panic!("mixed JSON target must use one scalar expression");
        };
        assert_eq!(
            expression,
            "json_extract_string(TRY_CAST(payload AS JSON), '$.\"0.a\\\\b[\\\"c'']\"[10]')"
        );
    }

    #[test]
    fn exact_integer_bound_eligibility_matches_the_fixed_decimal_contract() {
        for value in [
            "0",
            "-0",
            "9007199254740992",
            "9007199254740993",
            "9223372036854775807",
            "99999999999999999999",
            "1.0",
            "1.0000000000000000000",
            "1e19",
            "10e-1",
            "0.1e1",
            "1.1e1",
        ] {
            assert!(json_number_is_exact_integer_bound(value), "{value}");
        }
        for value in [
            "0.1",
            "0.100000000000000001",
            "1e-18",
            "1e-1",
            "100000000000000000000",
            "1e20",
            "1e100",
            "0.1000000000000000001",
            "01",
            "+1",
            "NaN",
            "",
        ] {
            assert!(!json_number_is_exact_integer_bound(value), "{value}");
        }
    }

    #[test]
    fn numeric_expression_builds_decimal_ties_inside_finite_buckets() {
        let target = JsonFieldTarget {
            path: JsonPath::new([JsonPathSegment::Field("value".to_owned())]),
            value_type: JsonValueType::Number,
        };
        let connection = Connection::open_in_memory().expect("DuckDB connection");
        for (value, expected_tie) in [
            (
                "9007199254740993",
                Some("9007199254740993.000000000000000000"),
            ),
            (
                "9007199254740992.0",
                Some("9007199254740992.000000000000000000"),
            ),
            ("0.1", Some("0.100000000000000000")),
            ("0.1000000000000000001", Some("0.100000000000000000")),
            ("1e100", None),
        ] {
            let root = quote_string_literal(&format!(r#"{{"value":{value}}}"#));
            let Some(JsonFieldExpression::Number(number)) = json_field_expression(&root, &target)
            else {
                panic!("number target must use numeric expression");
            };
            let (finite, exact) = connection
                .query_row(
                    &format!(
                        "SELECT {}, CAST({} AS VARCHAR)",
                        number.finite, number.bucket_tie
                    ),
                    [],
                    |row| {
                        Ok((
                            row.get::<_, Option<f64>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .expect("numeric JSON expression");
            assert!(finite.is_some(), "{value}");
            assert_eq!(exact.as_deref(), expected_tie, "{value}");
        }
    }

    #[test]
    fn path_limits_count_the_exact_index_text_and_inference_skips_invalid_paths() {
        assert!(
            JsonPath::new([
                JsonPathSegment::Field("x".repeat(MAX_JSON_PATH_BYTES - 10)),
                JsonPathSegment::Index(u32::MAX),
            ])
            .validate()
        );
        assert!(
            !JsonPath::new([
                JsonPathSegment::Field("x".repeat(MAX_JSON_PATH_BYTES - 9)),
                JsonPathSegment::Index(u32::MAX),
            ])
            .validate()
        );

        let overlong_key = "x".repeat(MAX_JSON_PATH_BYTES + 1);
        let value = serde_json::Value::Object(serde_json::Map::from_iter([(
            overlong_key,
            serde_json::Value::Bool(true),
        )]));
        let mut root = InferredNode::default();
        let mut node_count = 0;
        let mut is_truncated = false;
        observe_children(&mut root, &value, 0, 0, &mut node_count, &mut is_truncated);

        assert!(is_truncated);
        assert!(root.children.is_empty());

        let near_limit = "x".repeat(MAX_JSON_PATH_BYTES - 1);
        let value = serde_json::Value::Object(serde_json::Map::from_iter([(
            near_limit.clone(),
            serde_json::Value::Object(serde_json::Map::from_iter([(
                "yy".to_owned(),
                serde_json::Value::Bool(true),
            )])),
        )]));
        let mut root = InferredNode::default();
        let mut node_count = 0;
        let mut is_truncated = false;
        observe_children(&mut root, &value, 0, 0, &mut node_count, &mut is_truncated);
        let nodes = finish_children(root.children);

        assert!(is_truncated);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].segment, JsonPathSegment::Field(near_limit));
        assert!(nodes[0].children.is_empty());
        assert!(JsonPath::new([nodes[0].segment.clone()]).validate());
    }

    #[test]
    fn sample_expression_bounds_source_values_before_arrow_encoding() {
        assert_eq!(
            json_schema_sample_expression("payload"),
            "CASE WHEN length(CAST(payload AS VARCHAR)) > 2048 THEN repeat('x', 8193) ELSE CAST(payload AS VARCHAR) END"
        );
    }

    #[test]
    fn sample_byte_limits_reject_the_first_value_beyond_each_bound() {
        let mut sampled_bytes = 0;
        for _ in 0..(JSON_SCHEMA_SAMPLE_TOTAL_BYTE_LIMIT / JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT) {
            assert!(sample_value_fits(
                JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT,
                &mut sampled_bytes
            ));
        }
        assert_eq!(sampled_bytes, JSON_SCHEMA_SAMPLE_TOTAL_BYTE_LIMIT);
        assert!(!sample_value_fits(1, &mut sampled_bytes));

        let mut empty_sample = 0;
        assert!(!sample_value_fits(
            JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT + 1,
            &mut empty_sample
        ));
        assert_eq!(empty_sample, 0);
    }

    #[test]
    fn inference_counts_invalid_utf8_and_skips_oversized_values_before_json_parsing() {
        let valid = br#"{"ok":true}"#;
        let invalid = [0xff, 0xfe];
        let oversized = vec![b'x'; JSON_SCHEMA_SAMPLE_VALUE_BYTE_LIMIT + 1];
        let values = BinaryArray::from(vec![
            Some(valid.as_slice()),
            Some(invalid.as_slice()),
            Some(oversized.as_slice()),
        ]);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "payload",
            DataType::Binary,
            true,
        )]));
        let batch = RecordBatch::try_new(Arc::clone(&schema), vec![Arc::new(values) as ArrayRef])
            .expect("JSON sample batch");
        let mut writer = StreamWriter::try_new(Vec::new(), &schema).expect("Arrow stream writer");
        writer.write(&batch).expect("JSON sample batch write");
        writer.finish().expect("JSON sample stream finish");
        let arrow = writer.into_inner().expect("JSON sample stream bytes");
        let field = SchemaField {
            name: "payload".to_owned(),
            physical_type: "BYTE_ARRAY".to_owned(),
            logical_type: Some("JSON".to_owned()),
            children: Vec::new(),
        };

        let inferred =
            infer_json_schema_from_arrow(&field, &arrow, 3).expect("bounded binary JSON inference");

        assert_eq!(inferred.invalid_value_count, 1);
        assert_eq!(inferred.oversized_value_count, 1);
        assert!(inferred.is_truncated);
        assert_eq!(
            inferred.nodes[0].segment,
            JsonPathSegment::Field("ok".to_owned())
        );

        let text_field = SchemaField {
            logical_type: Some("String".to_owned()),
            ..field
        };
        assert_eq!(
            infer_json_schema_from_arrow(&text_field, &arrow, 3),
            Err(DataWindowError::Unsupported)
        );
    }
}
