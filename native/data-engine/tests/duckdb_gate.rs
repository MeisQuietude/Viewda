use std::sync::Arc;

use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use duckdb::Connection;
use parquet::arrow::ArrowWriter;
use tempfile::NamedTempFile;

#[test]
fn packaged_duckdb_reads_a_parquet_row_with_a_limit() {
    let source = write_parquet();
    let source_path = source
        .path()
        .to_str()
        .expect("temporary path should be valid UTF-8");
    let connection = Connection::open_in_memory().expect("packaged DuckDB should start");
    assert_eq!(
        connection
            .version()
            .expect("DuckDB should report its version"),
        "v1.5.5"
    );

    let first_row: (i64, String) = connection
        .query_row(
            "SELECT id, name FROM read_parquet(?) LIMIT 1",
            [source_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("packaged parquet extension should read the temporary source");

    assert_eq!(first_row, (7, "Ada".to_owned()));
}

fn write_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary file can be created");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from(vec![7, 11])) as ArrayRef,
            Arc::new(StringArray::from(vec!["Ada", "Lin"])) as ArrayRef,
        ],
    )
    .expect("gate record batch should be valid");
    let file = source
        .reopen()
        .expect("temporary file should be reopenable");
    let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer should start");
    writer
        .write(&batch)
        .expect("gate record batch should be writable");
    writer.close().expect("Parquet footer should be writable");

    source
}
