use std::{fs, io::Cursor, sync::Arc};

use arrow_array::{
    Array, ArrayRef, Decimal128Array, Int32Array, Int64Array, ListArray, RecordBatch, StringArray,
    StructArray, types::Int32Type,
};
use arrow_ipc::reader::StreamReader;
use arrow_schema::{DataType, Field, Fields, Schema};
use parquet::arrow::ArrowWriter;
use tempfile::NamedTempFile;
use viewda_data_engine::{DataWindowError, DataWindowReader};

#[test]
fn fetches_exact_basic_windows_at_the_first_and_last_boundaries() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let first = decode(reader.fetch(0, 3).expect("first window"));
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].num_rows(), 3);
    assert_eq!(int64_values(&first[0], 0), vec![10, 11, 12]);
    assert_eq!(
        string_values(&first[0], 1),
        vec![Some("row-0"), None, Some("row-2")]
    );

    let last = decode(reader.fetch(6, 4).expect("last window"));
    assert_eq!(last.len(), 1);
    assert_eq!(last[0].num_rows(), 2);
    assert_eq!(int64_values(&last[0], 0), vec![16, 17]);
    assert_eq!(
        string_values(&last[0], 1),
        vec![Some("row-6"), Some("row-7")]
    );
}

#[test]
fn returns_the_schema_and_no_rows_for_a_window_after_eof() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let bytes = reader.fetch(80, 4).expect("past-EOF window");
    let reader = StreamReader::try_new(Cursor::new(bytes), None).expect("Arrow IPC stream");

    assert_eq!(reader.schema().fields().len(), 2);
    assert_eq!(reader.count(), 0);
}

#[test]
fn preserves_nested_values_in_the_arrow_window() {
    let source = write_nested_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(reader.fetch(1, 1).expect("nested window"));
    let profile = batches[0]
        .column(0)
        .as_any()
        .downcast_ref::<StructArray>()
        .expect("profile struct");
    let city = profile
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("city strings");
    let tags = batches[0]
        .column(1)
        .as_any()
        .downcast_ref::<ListArray>()
        .expect("tag lists");
    let tag_values = tags
        .value(0)
        .as_any()
        .downcast_ref::<Int32Array>()
        .expect("integer tags")
        .values()
        .to_vec();

    assert_eq!(city.value(0), "Kyoto");
    assert_eq!(tag_values, vec![3, 5]);
}

#[test]
fn preserves_decimal128_integer_digits_across_the_arrow_window() {
    let source = write_decimal128_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(reader.fetch(0, 4).expect("decimal128 window"));
    let values = batches[0]
        .column(0)
        .as_any()
        .downcast_ref::<Decimal128Array>()
        .expect("decimal128 column");
    let two_to_64 = 1_i128 << 64;

    assert_eq!(values.data_type(), &DataType::Decimal128(38, 0));
    assert_eq!(
        values.values(),
        &[two_to_64 - 1, two_to_64, two_to_64 + 1, 10_i128.pow(38) - 1,]
    );
}

#[test]
fn fetches_a_row_from_a_ten_thousand_column_source() {
    let source = write_wide_parquet(10_000);
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(reader.fetch(1, 1).expect("wide window"));

    assert_eq!(batches[0].num_columns(), 10_000);
    assert_eq!(int32_value(&batches[0], 0), 1);
    assert_eq!(int32_value(&batches[0], 9_999), 10_000);
}

#[test]
fn maps_a_damaged_parquet_source_to_a_typed_error() {
    let source = write_basic_parquet();
    fs::write(source.path(), b"PAR1broken footerPAR1").expect("corrupt fixture");
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(reader.fetch(0, 4), Err(DataWindowError::CorruptSource));
}

#[test]
fn rejects_an_unbounded_window_before_querying_duckdb() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(reader.fetch(0, 513), Err(DataWindowError::WindowTooLarge));
}

fn decode(bytes: Vec<u8>) -> Vec<RecordBatch> {
    StreamReader::try_new(Cursor::new(bytes), None)
        .expect("Arrow IPC stream")
        .collect::<Result<Vec<_>, _>>()
        .expect("Arrow record batches")
}

fn int64_values(batch: &RecordBatch, column: usize) -> Vec<i64> {
    batch
        .column(column)
        .as_any()
        .downcast_ref::<Int64Array>()
        .expect("int64 column")
        .values()
        .to_vec()
}

fn string_values(batch: &RecordBatch, column: usize) -> Vec<Option<&str>> {
    let values = batch
        .column(column)
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("string column");
    (0..values.len())
        .map(|index| (!values.is_null(index)).then(|| values.value(index)))
        .collect()
}

fn int32_value(batch: &RecordBatch, column: usize) -> i32 {
    batch
        .column(column)
        .as_any()
        .downcast_ref::<Int32Array>()
        .expect("int32 column")
        .value(0)
}

fn write_basic_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("label", DataType::Utf8, true),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from_iter_values(10..18)) as ArrayRef,
            Arc::new(StringArray::from(vec![
                Some("row-0"),
                None,
                Some("row-2"),
                Some("row-3"),
                Some("row-4"),
                Some("row-5"),
                Some("row-6"),
                Some("row-7"),
            ])) as ArrayRef,
        ],
    )
    .expect("basic record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_nested_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let profile_fields = Fields::from(vec![
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
    let tags = ListArray::from_iter_primitive::<Int32Type, _, _>(vec![
        Some(vec![Some(1), Some(2)]),
        Some(vec![Some(3), Some(5)]),
    ]);
    let schema = Arc::new(Schema::new(vec![
        Field::new("profile", DataType::Struct(profile_fields), false),
        Field::new("tags", tags.data_type().clone(), false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![Arc::new(profile) as ArrayRef, Arc::new(tags) as ArrayRef],
    )
    .expect("nested record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_decimal128_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let two_to_64 = 1_i128 << 64;
    let values = Decimal128Array::from(vec![
        two_to_64 - 1,
        two_to_64,
        two_to_64 + 1,
        10_i128.pow(38) - 1,
    ])
    .with_precision_and_scale(38, 0)
    .expect("decimal128 fixture precision");
    let schema = Arc::new(Schema::new(vec![Field::new(
        "wide_integer",
        DataType::Decimal128(38, 0),
        false,
    )]));
    let batch = RecordBatch::try_new(Arc::clone(&schema), vec![Arc::new(values) as ArrayRef])
        .expect("decimal128 record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_wide_parquet(column_count: usize) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(
        (0..column_count)
            .map(|index| Field::new(format!("c{index:05}"), DataType::Int32, false))
            .collect::<Vec<_>>(),
    ));
    let columns = (0..column_count)
        .map(|index| {
            let value = i32::try_from(index).expect("wide fixture index fits i32");
            Arc::new(Int32Array::from(vec![value, value + 1])) as ArrayRef
        })
        .collect::<Vec<_>>();
    let batch = RecordBatch::try_new(Arc::clone(&schema), columns).expect("wide record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_batch(source: &NamedTempFile, schema: Arc<Schema>, batch: &RecordBatch) {
    let file = source.reopen().expect("temporary source is reopenable");
    let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
    writer.write(batch).expect("Parquet batch");
    writer.close().expect("Parquet footer");
}
