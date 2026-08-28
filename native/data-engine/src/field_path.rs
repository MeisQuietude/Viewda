//! Structured addresses for top-level columns and fields reachable through structs.

use std::collections::HashSet;
use std::sync::Arc;

use arrow_schema::{DataType, Field, Schema, SchemaRef};
use serde::{Deserialize, Serialize};

use crate::source::SchemaField;

/// A column address whose segments remain unambiguous across the engine boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct FieldPath(Vec<String>);

impl FieldPath {
    /// Creates a path from its top-level field name and zero or more struct-field names.
    pub fn new(segments: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self(segments.into_iter().map(Into::into).collect())
    }

    /// Returns the field-name segments from the top-level column to the addressed field.
    pub fn segments(&self) -> &[String] {
        &self.0
    }

    pub(crate) fn leaf_name(&self) -> Option<&str> {
        self.0.last().map(String::as_str)
    }
}

impl From<&str> for FieldPath {
    fn from(name: &str) -> Self {
        Self(vec![name.to_owned()])
    }
}

pub(crate) struct ResolvedFieldPath<'a> {
    pub(crate) root_index: usize,
    pub(crate) field: &'a SchemaField,
}

pub(crate) fn resolve_field_path<'a>(
    schema: &'a [SchemaField],
    path: &FieldPath,
) -> Option<ResolvedFieldPath<'a>> {
    let (root_name, child_names) = path.0.split_first()?;
    let root_index = schema.iter().position(|field| field.name == *root_name)?;
    let mut field = schema.get(root_index)?;
    for child_name in child_names {
        if !field_is_struct(field) {
            return None;
        }
        field = field
            .children
            .iter()
            .find(|child| child.name == *child_name)?;
    }
    Some(ResolvedFieldPath { root_index, field })
}

pub(crate) fn validate_field_paths<'a>(
    schema: &'a [SchemaField],
    paths: &[FieldPath],
) -> Option<Vec<ResolvedFieldPath<'a>>> {
    if paths.is_empty() {
        return None;
    }
    let mut seen = HashSet::with_capacity(paths.len());
    paths
        .iter()
        .map(|path| {
            if !seen.insert(path) {
                return None;
            }
            resolve_field_path(schema, path)
        })
        .collect()
}

pub(crate) fn field_is_struct(field: &SchemaField) -> bool {
    field.physical_type == "GROUP" && !matches!(field.logical_type.as_deref(), Some("List" | "Map"))
}

pub(crate) fn field_path_expression(path: &FieldPath, root: &str) -> Option<String> {
    let (_, child_names) = path.0.split_first()?;
    Some(
        child_names
            .iter()
            .fold(root.to_owned(), |expression, name| {
                format!(
                    "struct_extract({expression}, {})",
                    quote_string_literal(name)
                )
            }),
    )
}

pub(crate) fn field_path_title(path: &FieldPath) -> String {
    path.0
        .iter()
        .map(|segment| {
            if !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                segment.clone()
            } else {
                format!("\"{}\"", segment.replace('"', "\"\""))
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

pub(crate) fn project_arrow_field_paths(
    schema: &SchemaRef,
    paths: &[FieldPath],
) -> Option<SchemaRef> {
    let fields = paths
        .iter()
        .map(|path| {
            let (root_name, child_names) = path.0.split_first()?;
            let mut field = schema
                .fields()
                .iter()
                .find(|field| field.name() == root_name)?;
            let mut nullable = field.is_nullable();
            for child_name in child_names {
                let DataType::Struct(children) = field.data_type() else {
                    return None;
                };
                field = children.iter().find(|field| field.name() == child_name)?;
                nullable |= field.is_nullable();
            }
            Some(Arc::new(
                field
                    .as_ref()
                    .clone()
                    .with_name(path.leaf_name()?.to_owned())
                    .with_nullable(nullable),
            ))
        })
        .collect::<Option<Vec<Arc<Field>>>>()?;
    Some(Arc::new(Schema::new_with_metadata(
        fields,
        schema.metadata().clone(),
    )))
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_paths_as_segment_arrays_without_presentation_grammar() {
        let path = FieldPath::new(["addr", "weird.name", "postal code"]);

        assert_eq!(
            serde_json::to_value(&path).expect("field path should serialize"),
            json!(["addr", "weird.name", "postal code"])
        );
        assert_eq!(
            serde_json::from_value::<FieldPath>(json!(["addr", "weird.name", "postal code"]))
                .expect("field path should deserialize"),
            path
        );
    }

    #[test]
    fn formats_only_presentation_paths_with_segment_quoting() {
        assert_eq!(
            field_path_title(&FieldPath::new([
                "addr",
                "weird.name",
                "postal code",
                "a\"b"
            ])),
            "addr.\"weird.name\".\"postal code\".\"a\"\"b\""
        );
    }
}
