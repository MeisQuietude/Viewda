use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use parquet::{
    basic::ConvertedType,
    errors::ParquetError,
    file::reader::{FileReader, SerializedFileReader},
    schema::types::Type,
};
use serde::Serialize;
use thiserror::Error;

const PARQUET_MAGIC: &[u8; 4] = b"PAR1";

/// A path-free description of an inspected local Parquet source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    /// File name suitable for display without its directory.
    pub display_name: String,
    /// File size reported by the local filesystem.
    pub size_bytes: u64,
    /// Total rows recorded in the Parquet footer.
    pub row_count: u64,
    /// Number of row groups recorded in the Parquet footer.
    pub row_group_count: usize,
    /// Physical Parquet schema, preserving nested fields.
    pub schema: Vec<SchemaField>,
}

/// One field in the physical Parquet schema tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    /// Field name from the Parquet schema.
    pub name: String,
    /// Stable physical type name, or `GROUP` for nested fields.
    pub physical_type: String,
    /// Optional Parquet logical type annotation.
    pub logical_type: Option<String>,
    /// Nested fields in declaration order.
    pub children: Vec<SchemaField>,
}

/// Stable errors that can cross the data-engine boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SourceError {
    /// The selected source no longer exists.
    #[error("The selected file no longer exists.")]
    NotFound,
    /// The operating system denied access to the selected source.
    #[error("Viewda does not have permission to read the selected file.")]
    PermissionDenied,
    /// The selected source does not have Parquet file markers.
    #[error("The selected file is not a Parquet file.")]
    NotParquet,
    /// Parquet markers exist, but the footer cannot be decoded.
    #[error("The Parquet footer is damaged or incomplete.")]
    CorruptFooter,
    /// The source uses a shape that this bootstrap does not support.
    #[error("This source is not supported yet.")]
    Unsupported,
}

/// Reads local Parquet metadata without loading row values or exposing the path.
pub fn inspect_local_source(path: &Path) -> Result<SourceSummary, SourceError> {
    let (mut file, size_bytes) = open_local_source(path)?;
    file.seek(SeekFrom::Start(0)).map_err(map_io_error)?;

    let reader = SerializedFileReader::new(file).map_err(map_parquet_error)?;
    let parquet_metadata = reader.metadata();
    let file_metadata = parquet_metadata.file_metadata();
    let row_count =
        u64::try_from(file_metadata.num_rows()).map_err(|_| SourceError::CorruptFooter)?;
    let schema = file_metadata
        .schema_descr()
        .root_schema()
        .get_fields()
        .iter()
        .map(|field| schema_field(field))
        .collect();
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or(SourceError::Unsupported)?;

    Ok(SourceSummary {
        display_name,
        size_bytes,
        row_count,
        row_group_count: parquet_metadata.num_row_groups(),
        schema,
    })
}

pub(crate) fn open_local_source(path: &Path) -> Result<(File, u64), SourceError> {
    let mut file = File::open(path).map_err(map_io_error)?;
    let metadata = file.metadata().map_err(map_io_error)?;

    if !metadata.is_file() {
        return Err(SourceError::Unsupported);
    }

    verify_magic(&mut file, metadata.len())?;
    Ok((file, metadata.len()))
}

fn verify_magic(file: &mut File, size: u64) -> Result<(), SourceError> {
    if size < 8 {
        return Err(SourceError::NotParquet);
    }

    let mut leading = [0; 4];
    let mut trailing = [0; 4];
    file.read_exact(&mut leading).map_err(map_io_error)?;
    file.seek(SeekFrom::End(-4)).map_err(map_io_error)?;
    file.read_exact(&mut trailing).map_err(map_io_error)?;

    if &leading != PARQUET_MAGIC || &trailing != PARQUET_MAGIC {
        return Err(SourceError::NotParquet);
    }

    Ok(())
}

fn map_io_error(error: io::Error) -> SourceError {
    match error.kind() {
        io::ErrorKind::NotFound => SourceError::NotFound,
        io::ErrorKind::PermissionDenied => SourceError::PermissionDenied,
        _ => SourceError::Unsupported,
    }
}

fn map_parquet_error(error: ParquetError) -> SourceError {
    match error {
        ParquetError::NYI(_) => SourceError::Unsupported,
        ParquetError::External(external) => external
            .downcast_ref::<io::Error>()
            .map(|error| map_io_error(io::Error::from(error.kind())))
            .unwrap_or(SourceError::CorruptFooter),
        _ => SourceError::CorruptFooter,
    }
}

fn schema_field(field: &Type) -> SchemaField {
    let basic = field.get_basic_info();
    let logical_type = basic
        .logical_type_ref()
        .map(|logical| format!("{logical:?}"))
        .or_else(|| {
            let converted = basic.converted_type();
            (converted != ConvertedType::NONE).then(|| format!("{converted:?}"))
        });

    match field {
        Type::PrimitiveType { physical_type, .. } => SchemaField {
            name: field.name().to_owned(),
            physical_type: format!("{physical_type:?}"),
            logical_type,
            children: Vec::new(),
        },
        Type::GroupType { fields, .. } => SchemaField {
            name: field.name().to_owned(),
            physical_type: "GROUP".to_owned(),
            logical_type,
            children: fields
                .iter()
                .map(|child| schema_field(child))
                .collect::<Vec<_>>(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use arrow_array::{ArrayRef, Int32Array, Int64Array, RecordBatch, StringArray, StructArray};
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::arrow::ArrowWriter;
    use tempfile::NamedTempFile;

    use super::*;

    #[test]
    fn inspects_basic_parquet_metadata_without_returning_a_path() {
        let source = write_basic_parquet();

        let summary = inspect_local_source(source.path()).expect("basic Parquet should open");

        assert_eq!(
            summary,
            SourceSummary {
                display_name: source
                    .path()
                    .file_name()
                    .expect("temporary file has a name")
                    .to_string_lossy()
                    .into_owned(),
                size_bytes: fs::metadata(source.path())
                    .expect("temporary file metadata is readable")
                    .len(),
                row_count: 3,
                row_group_count: 1,
                schema: vec![
                    SchemaField {
                        name: "id".to_owned(),
                        physical_type: "INT64".to_owned(),
                        logical_type: None,
                        children: vec![],
                    },
                    SchemaField {
                        name: "name".to_owned(),
                        physical_type: "BYTE_ARRAY".to_owned(),
                        logical_type: Some("String".to_owned()),
                        children: vec![],
                    },
                ],
            }
        );
    }

    #[test]
    fn preserves_nested_schema_fields() {
        let source = write_nested_parquet();

        let summary = inspect_local_source(source.path()).expect("nested Parquet should open");

        assert_eq!(summary.row_count, 2);
        assert_eq!(
            summary.schema,
            vec![SchemaField {
                name: "profile".to_owned(),
                physical_type: "GROUP".to_owned(),
                logical_type: None,
                children: vec![
                    SchemaField {
                        name: "city".to_owned(),
                        physical_type: "BYTE_ARRAY".to_owned(),
                        logical_type: Some("String".to_owned()),
                        children: vec![],
                    },
                    SchemaField {
                        name: "postal_code".to_owned(),
                        physical_type: "INT32".to_owned(),
                        logical_type: None,
                        children: vec![],
                    },
                ],
            }]
        );
    }

    #[test]
    fn rejects_non_parquet_input_before_parsing_a_footer() {
        let source = NamedTempFile::new().expect("temporary file can be created");
        fs::write(source.path(), b"ordinary text").expect("temporary file can be written");

        assert_eq!(
            inspect_local_source(source.path()),
            Err(SourceError::NotParquet)
        );
    }

    #[test]
    fn maps_a_damaged_parquet_footer_to_our_error_taxonomy() {
        let source = write_basic_parquet();
        fs::write(
            source.path(),
            [
                PARQUET_MAGIC.as_slice(),
                &[0xff; 4],
                PARQUET_MAGIC.as_slice(),
            ]
            .concat(),
        )
        .expect("corrupt fixture can be written");

        assert_eq!(
            inspect_local_source(source.path()),
            Err(SourceError::CorruptFooter)
        );
    }

    #[test]
    fn maps_io_errors_without_exposing_platform_messages() {
        assert_eq!(
            map_io_error(io::Error::from(io::ErrorKind::NotFound)),
            SourceError::NotFound
        );
        assert_eq!(
            map_io_error(io::Error::from(io::ErrorKind::PermissionDenied)),
            SourceError::PermissionDenied
        );
        assert_eq!(
            map_io_error(io::Error::from(io::ErrorKind::Other)),
            SourceError::Unsupported
        );
    }

    fn write_basic_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file can be created");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3])) as ArrayRef,
                Arc::new(StringArray::from(vec![Some("Ada"), None, Some("Lin")])) as ArrayRef,
            ],
        )
        .expect("basic record batch is valid");

        write_batch(&source, schema, &batch);
        source
    }

    fn write_nested_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file can be created");
        let nested_fields = Fields::from(vec![
            Field::new("city", DataType::Utf8, false),
            Field::new("postal_code", DataType::Int32, true),
        ]);
        let profile = StructArray::from(vec![
            (
                Arc::new(Field::new("city", DataType::Utf8, false)),
                Arc::new(StringArray::from(vec!["Helsinki", "Kyoto"])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("postal_code", DataType::Int32, true)),
                Arc::new(Int32Array::from(vec![Some(100), None])) as ArrayRef,
            ),
        ]);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "profile",
            DataType::Struct(nested_fields),
            false,
        )]));
        let batch = RecordBatch::try_new(Arc::clone(&schema), vec![Arc::new(profile) as ArrayRef])
            .expect("nested record batch is valid");

        write_batch(&source, schema, &batch);
        source
    }

    fn write_batch(source: &NamedTempFile, schema: Arc<Schema>, batch: &RecordBatch) {
        let file = source.reopen().expect("temporary file can be reopened");
        let mut writer =
            ArrowWriter::try_new(file, schema, None).expect("Parquet writer can be created");
        writer.write(batch).expect("record batch can be written");
        writer.close().expect("Parquet footer can be written");
    }
}
