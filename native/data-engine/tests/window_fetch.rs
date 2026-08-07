use std::{fs, io::Cursor, sync::Arc};

use arrow_array::{
    Array, ArrayRef, BooleanArray, Date32Array, Decimal128Array, Float16Array, Float32Array,
    Float64Array, Int32Array, Int64Array, ListArray, RecordBatch, StringArray, StructArray,
    types::Int32Type,
};
use arrow_ipc::reader::StreamReader;
use arrow_schema::{DataType, Field, Fields, Schema};
use half::f16;
use parquet::{
    arrow::ArrowWriter,
    data_type::{ByteArray, ByteArrayType, FixedLenByteArray, FixedLenByteArrayType, Int64Type},
    file::writer::SerializedFileWriter,
    schema::parser::parse_message_type,
};
use tempfile::NamedTempFile;
use viewda_data_engine::{
    DataFilter, DataFilterOperator, DataWindowError, DataWindowReader, FilteredRowCountReader,
};

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

    assert_eq!(reader.schema().fields().len(), 5);
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
    assert_eq!(
        reader.fetch_filtered(0, 4, &[filter(0, DataFilterOperator::Equals, &["10"])],),
        Err(DataWindowError::CorruptSource)
    );
}

#[test]
fn rejects_an_unbounded_window_before_querying_duckdb() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(reader.fetch(0, 513), Err(DataWindowError::WindowTooLarge));
}

#[test]
fn accepts_a_window_at_the_row_limit() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(reader.fetch(0, 512).expect("maximum bounded window"));

    assert_eq!(batches[0].num_rows(), 8);
}

#[test]
fn applies_every_operator_to_supported_scalar_types() {
    let source = write_basic_parquet();
    let cases = [
        (filter(0, DataFilterOperator::Equals, &["12"]), vec![12]),
        (
            filter(0, DataFilterOperator::NotEquals, &["12"]),
            vec![10, 11, 13, 14, 15, 16, 17],
        ),
        (
            filter(0, DataFilterOperator::GreaterThan, &["12"]),
            vec![13, 14, 15, 16, 17],
        ),
        (
            filter(0, DataFilterOperator::GreaterThanOrEqual, &["12"]),
            vec![12, 13, 14, 15, 16, 17],
        ),
        (
            filter(0, DataFilterOperator::LessThan, &["12"]),
            vec![10, 11],
        ),
        (
            filter(0, DataFilterOperator::LessThanOrEqual, &["12"]),
            vec![10, 11, 12],
        ),
        (
            filter(0, DataFilterOperator::OneOf, &["11", "14"]),
            vec![11, 14],
        ),
        (
            filter(0, DataFilterOperator::Range, &["12", "14"]),
            vec![12, 13, 14],
        ),
        (filter(4, DataFilterOperator::IsNull, &[]), vec![15]),
        (
            filter(4, DataFilterOperator::IsNotNull, &[]),
            vec![10, 11, 12, 13, 14, 16, 17],
        ),
        (filter(1, DataFilterOperator::Equals, &["row-2"]), vec![12]),
        (
            filter(1, DataFilterOperator::NotEquals, &["row-2"]),
            vec![10, 13, 14, 15, 16, 17],
        ),
        (
            filter(1, DataFilterOperator::OneOf, &["row-2", "row-4"]),
            vec![12, 14],
        ),
        (
            filter(1, DataFilterOperator::TextContains, &["row-"]),
            vec![10, 12, 13, 14, 15, 16, 17],
        ),
        (filter(1, DataFilterOperator::IsNull, &[]), vec![11]),
        (
            filter(1, DataFilterOperator::IsNotNull, &[]),
            vec![10, 12, 13, 14, 15, 16, 17],
        ),
        (
            filter(2, DataFilterOperator::Equals, &["true"]),
            vec![10, 12, 14, 16],
        ),
        (
            filter(2, DataFilterOperator::NotEquals, &["true"]),
            vec![11, 13, 15],
        ),
        (filter(2, DataFilterOperator::IsNull, &[]), vec![17]),
        (
            filter(2, DataFilterOperator::IsNotNull, &[]),
            vec![10, 11, 12, 13, 14, 15, 16],
        ),
        (
            filter(3, DataFilterOperator::Equals, &["1970-01-03"]),
            vec![12],
        ),
        (
            filter(3, DataFilterOperator::NotEquals, &["1970-01-03"]),
            vec![10, 11, 13, 14, 15, 17],
        ),
        (
            filter(3, DataFilterOperator::OneOf, &["1970-01-02", "1970-01-05"]),
            vec![11, 14],
        ),
        (
            filter(3, DataFilterOperator::Range, &["1970-01-03", "1970-01-05"]),
            vec![12, 13, 14],
        ),
        (filter(3, DataFilterOperator::IsNull, &[]), vec![16]),
        (
            filter(3, DataFilterOperator::IsNotNull, &[]),
            vec![10, 11, 12, 13, 14, 15, 17],
        ),
    ];

    for (condition, expected) in cases {
        let mut reader = DataWindowReader::new(source.path().to_owned());
        let batches = decode(
            reader
                .fetch_filtered(0, 32, &[condition])
                .expect("filtered window"),
        );
        assert_eq!(int64_values(&batches[0], 0), expected);
    }
}

#[test]
fn applies_numeric_comparisons_to_each_numeric_storage_type() {
    let source = write_numeric_parquet();
    let cases = [
        (DataFilterOperator::GreaterThan, &[14, 15][..]),
        (DataFilterOperator::GreaterThanOrEqual, &[13, 14, 15][..]),
        (DataFilterOperator::LessThan, &[10, 11, 12][..]),
        (DataFilterOperator::LessThanOrEqual, &[10, 11, 12, 13][..]),
    ];

    for column_index in 1..=5 {
        for (operator, expected) in cases {
            let mut reader = DataWindowReader::new(source.path().to_owned());
            let batches = decode(
                reader
                    .fetch_filtered(0, 32, &[filter(column_index, operator, &["2"])])
                    .expect("filtered numeric window"),
            );

            assert_eq!(
                int64_values(&batches[0], 0),
                expected,
                "column {column_index}, operator {operator:?}"
            );
        }
    }
}

#[test]
fn filters_uuid_and_json_columns_as_text() {
    let source = write_special_types_parquet();
    let cases = [
        (
            filter(
                1,
                DataFilterOperator::Equals,
                &["123e4567-e89b-12d3-a456-426614174001"],
            ),
            vec![2],
        ),
        (
            filter(
                1,
                DataFilterOperator::OneOf,
                &[
                    "123e4567-e89b-12d3-a456-426614174000",
                    "550e8400-e29b-41d4-a716-446655440000",
                ],
            ),
            vec![1, 3],
        ),
        (
            filter(1, DataFilterOperator::TextContains, &["e89b"]),
            vec![1, 2],
        ),
        (
            filter(2, DataFilterOperator::TextContains, &["beta"]),
            vec![2],
        ),
    ];

    for (condition, expected) in cases {
        let mut reader = DataWindowReader::new(source.path().to_owned());
        let batches = decode(
            reader
                .fetch_filtered(0, 8, &[condition])
                .expect("special-type filtered window"),
        );
        assert_eq!(int64_values(&batches[0], 0), expected);
    }
}

#[test]
fn keeps_plain_binary_columns_null_only() {
    let source = write_special_types_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(
        reader.fetch_filtered(
            0,
            8,
            &[filter(3, DataFilterOperator::TextContains, &["alpha"],)],
        ),
        Err(DataWindowError::InvalidFilter),
    );

    let batches = decode(
        reader
            .fetch_filtered(0, 8, &[filter(3, DataFilterOperator::IsNotNull, &[])])
            .expect("binary null-check window"),
    );
    assert_eq!(int64_values(&batches[0], 0), vec![1, 2, 3]);
}

#[test]
fn combines_conditions_and_offsets_the_filtered_view() {
    let source = write_basic_parquet();
    let filters = vec![
        filter(0, DataFilterOperator::Range, &["11", "17"]),
        filter(1, DataFilterOperator::OneOf, &["row-2", "row-4", "row-6"]),
    ];
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(
        reader
            .fetch_filtered(1, 2, &filters)
            .expect("filtered offset window"),
    );

    assert_eq!(int64_values(&batches[0], 0), vec![14, 16]);
    assert_eq!(
        FilteredRowCountReader::new(source.path().to_owned(), &filters)
            .expect("filtered count reader")
            .fetch()
            .expect("filtered count"),
        3
    );
}

#[test]
fn returns_a_schema_only_window_for_an_empty_filter_result() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let bytes = reader
        .fetch_filtered(0, 4, &[filter(0, DataFilterOperator::Equals, &["999"])])
        .expect("empty filtered window");
    let reader = StreamReader::try_new(Cursor::new(bytes), None).expect("Arrow IPC stream");

    assert_eq!(reader.schema().fields().len(), 5);
    assert_eq!(reader.count(), 0);
}

#[test]
fn rejects_an_operator_not_supported_by_the_column_type() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(
        reader.fetch_filtered(0, 4, &[filter(0, DataFilterOperator::TextContains, &["1"])],),
        Err(DataWindowError::InvalidFilter)
    );
}

#[test]
fn rejects_bound_values_that_cannot_convert_to_the_column_type() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(
        reader.fetch_filtered(
            0,
            4,
            &[filter(0, DataFilterOperator::Equals, &["1 OR 1=1"],)],
        ),
        Err(DataWindowError::InvalidFilter)
    );
}

fn filter(column_index: u32, operator: DataFilterOperator, values: &[&str]) -> DataFilter {
    DataFilter {
        column_index,
        operator,
        values: values.iter().map(|value| (*value).to_owned()).collect(),
    }
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
        Field::new("id\"quoted", DataType::Int64, false),
        Field::new("label", DataType::Utf8, true),
        Field::new("active", DataType::Boolean, true),
        Field::new("day", DataType::Date32, true),
        Field::new("score", DataType::Int64, true),
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
            Arc::new(BooleanArray::from(vec![
                Some(true),
                Some(false),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
                Some(true),
                None,
            ])) as ArrayRef,
            Arc::new(Date32Array::from(vec![
                Some(0),
                Some(1),
                Some(2),
                Some(3),
                Some(4),
                Some(5),
                None,
                Some(7),
            ])) as ArrayRef,
            Arc::new(Int64Array::from(vec![
                Some(100),
                Some(101),
                Some(102),
                Some(103),
                Some(104),
                None,
                Some(106),
                Some(107),
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

fn write_numeric_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let ids = [10_i64, 11, 12, 13, 14, 15];
    let integers = [-3_i64, -1, 0, 2, 4, 7];
    let float32s = [-3_f32, -1.0, 0.0, 2.0, 4.0, 7.0];
    let float64s = [-3_f64, -1.0, 0.0, 2.0, 4.0, 7.0];
    let decimals = Decimal128Array::from(vec![-300_i128, -100, 0, 200, 400, 700])
        .with_precision_and_scale(10, 2)
        .expect("decimal comparison fixture precision");
    let float16s = Float16Array::from(
        [-3_f32, -1.0, 0.0, 2.0, 4.0, 7.0]
            .map(f16::from_f32)
            .to_vec(),
    );
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("integer", DataType::Int64, false),
        Field::new("float", DataType::Float32, false),
        Field::new("double", DataType::Float64, false),
        Field::new("decimal", DataType::Decimal128(10, 2), false),
        Field::new("half", DataType::Float16, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from_iter_values(ids)) as ArrayRef,
            Arc::new(Int64Array::from_iter_values(integers)) as ArrayRef,
            Arc::new(Float32Array::from(float32s.to_vec())) as ArrayRef,
            Arc::new(Float64Array::from(float64s.to_vec())) as ArrayRef,
            Arc::new(decimals) as ArrayRef,
            Arc::new(float16s) as ArrayRef,
        ],
    )
    .expect("numeric comparison record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_special_types_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(
        parse_message_type(
            "message special_types {
                REQUIRED INT64 id;
                REQUIRED FIXED_LEN_BYTE_ARRAY (16) uuid_value (UUID);
                REQUIRED BYTE_ARRAY json_value (JSON);
                REQUIRED BYTE_ARRAY binary_value;
            }",
        )
        .expect("special-type Parquet schema"),
    );
    let file = source.reopen().expect("temporary source is reopenable");
    let mut writer =
        SerializedFileWriter::new(file, schema, Default::default()).expect("Parquet writer");
    let mut row_group = writer.next_row_group().expect("Parquet row group");

    let mut column = row_group
        .next_column()
        .expect("id column")
        .expect("id column writer");
    column
        .typed::<Int64Type>()
        .write_batch(&[1, 2, 3], None, None)
        .expect("id values");
    column.close().expect("id column footer");

    let uuids = [
        vec![
            0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17,
            0x40, 0x00,
        ],
        vec![
            0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17,
            0x40, 0x01,
        ],
        vec![
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ],
    ]
    .map(FixedLenByteArray::from);
    let mut column = row_group
        .next_column()
        .expect("UUID column")
        .expect("UUID column writer");
    column
        .typed::<FixedLenByteArrayType>()
        .write_batch(&uuids, None, None)
        .expect("UUID values");
    column.close().expect("UUID column footer");

    let json_values = [
        ByteArray::from(r#"{"kind":"alpha","count":1}"#),
        ByteArray::from(r#"{"kind":"beta","count":2}"#),
        ByteArray::from(r#"{"kind":"alphabet","count":3}"#),
    ];
    let mut column = row_group
        .next_column()
        .expect("JSON column")
        .expect("JSON column writer");
    column
        .typed::<ByteArrayType>()
        .write_batch(&json_values, None, None)
        .expect("JSON values");
    column.close().expect("JSON column footer");

    let binary_values = [
        ByteArray::from(b"alpha".as_slice()),
        ByteArray::from(b"beta".as_slice()),
        ByteArray::from(b"gamma".as_slice()),
    ];
    let mut column = row_group
        .next_column()
        .expect("binary column")
        .expect("binary column writer");
    column
        .typed::<ByteArrayType>()
        .write_batch(&binary_values, None, None)
        .expect("binary values");
    column.close().expect("binary column footer");

    assert!(
        row_group
            .next_column()
            .expect("end of special-type columns")
            .is_none()
    );
    row_group.close().expect("Parquet row group footer");
    writer.close().expect("Parquet footer");
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
