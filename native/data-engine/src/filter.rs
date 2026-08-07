//! Typed filter conditions shared by bounded data-window queries.

use duckdb::types::Value;
use serde::Deserialize;
use thiserror::Error;

use crate::source::SchemaField;

const MAX_FILTERS: usize = 32;
const MAX_ONE_OF_VALUES: usize = 100;
const MAX_VALUE_BYTES: usize = 4_096;

/// One typed condition applied to a top-level Parquet column.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFilter {
    /// Zero-based top-level column index from the source summary.
    pub column_index: u32,
    /// Operation valid for the column's filter family.
    pub operator: DataFilterOperator,
    /// Text representations converted by DuckDB to the column's exact type.
    #[serde(default)]
    pub values: Vec<String>,
}

/// Stable typed operations accepted by the data engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataFilterOperator {
    Equals,
    NotEquals,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    OneOf,
    Range,
    TextContains,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum FilterBuildError {
    #[error("The filter condition is invalid for this source.")]
    Invalid,
}

pub(crate) struct FilterPredicate {
    pub(crate) sql: String,
    pub(crate) parameters: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColumnFilterKind {
    Boolean,
    Number,
    Text,
    Temporal,
    NullOnly,
}

pub(crate) fn build_filter_predicate(
    schema: &[SchemaField],
    filters: &[DataFilter],
) -> Result<FilterPredicate, FilterBuildError> {
    if filters.len() > MAX_FILTERS {
        return Err(FilterBuildError::Invalid);
    }

    let mut clauses = Vec::with_capacity(filters.len());
    let mut parameters = Vec::new();
    for filter in filters {
        let column = schema
            .get(filter.column_index as usize)
            .ok_or(FilterBuildError::Invalid)?;
        validate_filter(filter, column_filter_kind(column))?;
        let identifier = quote_identifier(&column.name);
        let clause = match filter.operator {
            DataFilterOperator::Equals => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("{identifier} = cast_to_type(?, {identifier})")
            }
            DataFilterOperator::NotEquals => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("{identifier} <> cast_to_type(?, {identifier})")
            }
            DataFilterOperator::GreaterThan => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("{identifier} > cast_to_type(?, {identifier})")
            }
            DataFilterOperator::GreaterThanOrEqual => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("{identifier} >= cast_to_type(?, {identifier})")
            }
            DataFilterOperator::LessThan => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("{identifier} < cast_to_type(?, {identifier})")
            }
            DataFilterOperator::LessThanOrEqual => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("{identifier} <= cast_to_type(?, {identifier})")
            }
            DataFilterOperator::OneOf => {
                parameters.extend(filter.values.iter().cloned().map(Value::Text));
                let values = std::iter::repeat_n(
                    format!("cast_to_type(?, {identifier})"),
                    filter.values.len(),
                )
                .collect::<Vec<_>>()
                .join(", ");
                format!("{identifier} IN ({values})")
            }
            DataFilterOperator::Range => {
                parameters.extend(filter.values.iter().cloned().map(Value::Text));
                format!(
                    "{identifier} BETWEEN cast_to_type(?, {identifier}) AND cast_to_type(?, {identifier})"
                )
            }
            DataFilterOperator::TextContains => {
                parameters.push(Value::Text(filter.values[0].clone()));
                format!("contains(CAST({identifier} AS VARCHAR), ?)")
            }
            DataFilterOperator::IsNull => format!("{identifier} IS NULL"),
            DataFilterOperator::IsNotNull => format!("{identifier} IS NOT NULL"),
        };
        clauses.push(clause);
    }

    Ok(FilterPredicate {
        sql: clauses.join(" AND "),
        parameters,
    })
}

fn column_filter_kind(field: &SchemaField) -> ColumnFilterKind {
    if field.physical_type == "GROUP" {
        return ColumnFilterKind::NullOnly;
    }
    if field.logical_type.as_deref().is_some_and(|logical| {
        logical.starts_with("Date")
            || logical.starts_with("Time")
            || logical.starts_with("Timestamp")
    }) || field.physical_type == "INT96"
    {
        return ColumnFilterKind::Temporal;
    }
    if field.logical_type.as_deref().is_some_and(|logical| {
        logical.starts_with("String") || logical.starts_with("Enum") || logical.starts_with("JSON")
    }) {
        return ColumnFilterKind::Text;
    }
    if field
        .logical_type
        .as_deref()
        .is_some_and(|logical| logical.starts_with("Decimal") || logical == "Float16")
    {
        return ColumnFilterKind::Number;
    }

    match field.physical_type.as_str() {
        "BOOLEAN" => ColumnFilterKind::Boolean,
        "INT32" | "INT64" | "FLOAT" | "DOUBLE" => ColumnFilterKind::Number,
        _ => ColumnFilterKind::NullOnly,
    }
}

fn validate_filter(filter: &DataFilter, kind: ColumnFilterKind) -> Result<(), FilterBuildError> {
    let supported = match filter.operator {
        DataFilterOperator::Equals | DataFilterOperator::NotEquals => {
            kind != ColumnFilterKind::NullOnly
        }
        DataFilterOperator::GreaterThan
        | DataFilterOperator::GreaterThanOrEqual
        | DataFilterOperator::LessThan
        | DataFilterOperator::LessThanOrEqual => kind == ColumnFilterKind::Number,
        DataFilterOperator::OneOf => matches!(
            kind,
            ColumnFilterKind::Number | ColumnFilterKind::Text | ColumnFilterKind::Temporal
        ),
        DataFilterOperator::Range => {
            matches!(kind, ColumnFilterKind::Number | ColumnFilterKind::Temporal)
        }
        DataFilterOperator::TextContains => kind == ColumnFilterKind::Text,
        DataFilterOperator::IsNull | DataFilterOperator::IsNotNull => true,
    };
    if !supported {
        return Err(FilterBuildError::Invalid);
    }

    let valid_arity = match filter.operator {
        DataFilterOperator::Equals
        | DataFilterOperator::NotEquals
        | DataFilterOperator::GreaterThan
        | DataFilterOperator::GreaterThanOrEqual
        | DataFilterOperator::LessThan
        | DataFilterOperator::LessThanOrEqual
        | DataFilterOperator::TextContains => filter.values.len() == 1,
        DataFilterOperator::OneOf => (1..=MAX_ONE_OF_VALUES).contains(&filter.values.len()),
        DataFilterOperator::Range => filter.values.len() == 2,
        DataFilterOperator::IsNull | DataFilterOperator::IsNotNull => filter.values.is_empty(),
    };
    if !valid_arity
        || filter
            .values
            .iter()
            .any(|value| value.len() > MAX_VALUE_BYTES)
    {
        return Err(FilterBuildError::Invalid);
    }
    if kind != ColumnFilterKind::Text && filter.values.iter().any(|value| value.trim().is_empty()) {
        return Err(FilterBuildError::Invalid);
    }
    if kind == ColumnFilterKind::Boolean
        && filter
            .values
            .iter()
            .any(|value| value != "true" && value != "false")
    {
        return Err(FilterBuildError::Invalid);
    }

    Ok(())
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, filter_kind: ColumnFilterKind) -> SchemaField {
        let (physical_type, logical_type) = match filter_kind {
            ColumnFilterKind::Boolean => ("BOOLEAN", None),
            ColumnFilterKind::Number => ("INT64", None),
            ColumnFilterKind::Text => ("BYTE_ARRAY", Some("String".to_owned())),
            ColumnFilterKind::Temporal => {
                ("INT64", Some("Timestamp (microseconds, UTC)".to_owned()))
            }
            ColumnFilterKind::NullOnly => ("GROUP", None),
        };
        SchemaField {
            name: name.to_owned(),
            physical_type: physical_type.to_owned(),
            logical_type,
            children: Vec::new(),
        }
    }

    #[test]
    fn builds_parameterized_and_conditions_with_quoted_identifiers() {
        let filters = vec![
            DataFilter {
                column_index: 0,
                operator: DataFilterOperator::Range,
                values: vec!["10".to_owned(), "20".to_owned()],
            },
            DataFilter {
                column_index: 1,
                operator: DataFilterOperator::TextContains,
                values: vec!["quiet".to_owned()],
            },
        ];

        let predicate = build_filter_predicate(
            &[
                field("value\"quoted", ColumnFilterKind::Number),
                field("label", ColumnFilterKind::Text),
            ],
            &filters,
        )
        .expect("valid filters");

        assert_eq!(
            predicate.sql,
            "\"value\"\"quoted\" BETWEEN cast_to_type(?, \"value\"\"quoted\") AND cast_to_type(?, \"value\"\"quoted\") AND contains(CAST(\"label\" AS VARCHAR), ?)"
        );
        assert_eq!(
            predicate.parameters,
            vec![
                Value::Text("10".to_owned()),
                Value::Text("20".to_owned()),
                Value::Text("quiet".to_owned()),
            ]
        );
    }

    #[test]
    fn rejects_operators_outside_the_column_filter_family() {
        let filter = DataFilter {
            column_index: 0,
            operator: DataFilterOperator::Range,
            values: vec!["a".to_owned(), "z".to_owned()],
        };

        assert!(
            build_filter_predicate(&[field("label", ColumnFilterKind::Text)], &[filter]).is_err()
        );
    }

    #[test]
    fn builds_numeric_comparisons_with_bound_casts() {
        let cases = [
            (DataFilterOperator::GreaterThan, ">"),
            (DataFilterOperator::GreaterThanOrEqual, ">="),
            (DataFilterOperator::LessThan, "<"),
            (DataFilterOperator::LessThanOrEqual, "<="),
        ];

        for (operator, sql_operator) in cases {
            let predicate = build_filter_predicate(
                &[field("value\"quoted", ColumnFilterKind::Number)],
                &[DataFilter {
                    column_index: 0,
                    operator,
                    values: vec!["12.5".to_owned()],
                }],
            )
            .expect("valid numeric comparison");

            assert_eq!(
                predicate.sql,
                format!("\"value\"\"quoted\" {sql_operator} cast_to_type(?, \"value\"\"quoted\")")
            );
            assert_eq!(predicate.parameters, vec![Value::Text("12.5".to_owned())]);
        }
    }

    #[test]
    fn rejects_numeric_comparisons_with_invalid_arity_or_column_kind() {
        let operators = [
            DataFilterOperator::GreaterThan,
            DataFilterOperator::GreaterThanOrEqual,
            DataFilterOperator::LessThan,
            DataFilterOperator::LessThanOrEqual,
        ];

        for operator in operators {
            for values in [Vec::new(), vec!["1".to_owned(), "2".to_owned()]] {
                let filter = DataFilter {
                    column_index: 0,
                    operator,
                    values,
                };
                assert!(
                    build_filter_predicate(&[field("value", ColumnFilterKind::Number)], &[filter])
                        .is_err()
                );
            }

            for kind in [
                ColumnFilterKind::Boolean,
                ColumnFilterKind::Text,
                ColumnFilterKind::Temporal,
                ColumnFilterKind::NullOnly,
            ] {
                let filter = DataFilter {
                    column_index: 0,
                    operator,
                    values: vec!["1".to_owned()],
                };
                assert!(build_filter_predicate(&[field("value", kind)], &[filter]).is_err());
            }
        }
    }

    #[test]
    fn classifies_float16_as_numeric() {
        let float16 = SchemaField {
            name: "half".to_owned(),
            physical_type: "FIXED_LEN_BYTE_ARRAY".to_owned(),
            logical_type: Some("Float16".to_owned()),
            children: Vec::new(),
        };

        assert_eq!(column_filter_kind(&float16), ColumnFilterKind::Number);
    }

    #[test]
    fn rejects_conditions_and_value_lists_above_engine_limits() {
        let column = field("value", ColumnFilterKind::Number);
        let filters = (0..=MAX_FILTERS)
            .map(|_| DataFilter {
                column_index: 0,
                operator: DataFilterOperator::IsNotNull,
                values: Vec::new(),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            build_filter_predicate(std::slice::from_ref(&column), &filters).err(),
            Some(FilterBuildError::Invalid)
        );

        let one_of = DataFilter {
            column_index: 0,
            operator: DataFilterOperator::OneOf,
            values: vec!["1".to_owned(); MAX_ONE_OF_VALUES + 1],
        };
        assert_eq!(
            build_filter_predicate(&[column], &[one_of]).err(),
            Some(FilterBuildError::Invalid)
        );
    }

    #[test]
    fn accepts_a_value_at_the_byte_limit_and_rejects_the_next_byte() {
        let column = field("label", ColumnFilterKind::Text);
        let filter_with_value = |value: String| DataFilter {
            column_index: 0,
            operator: DataFilterOperator::Equals,
            values: vec![value],
        };

        assert!(
            build_filter_predicate(
                std::slice::from_ref(&column),
                &[filter_with_value("x".repeat(MAX_VALUE_BYTES))],
            )
            .is_ok()
        );
        assert_eq!(
            build_filter_predicate(
                &[column],
                &[filter_with_value("x".repeat(MAX_VALUE_BYTES + 1))],
            )
            .err(),
            Some(FilterBuildError::Invalid)
        );
    }
}
