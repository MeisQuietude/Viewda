use std::{cmp::Ordering, fs, io::Cursor, sync::Arc};

use arrow_array::{
    Array, ArrayRef, BooleanArray, Date32Array, Decimal128Array, Float16Array, Float32Array,
    Float64Array, Int32Array, Int64Array, ListArray, RecordBatch, StringArray, StructArray,
    Time64MicrosecondArray, TimestampMicrosecondArray, TimestampMillisecondArray,
    TimestampNanosecondArray, builder::NullBufferBuilder, types::Int32Type,
};
use arrow_ipc::reader::StreamReader;
use arrow_schema::{DataType, Field, Fields, Schema, TimeUnit};
use half::f16;
use parquet::{
    arrow::ArrowWriter,
    data_type::{
        ByteArray, ByteArrayType, FixedLenByteArray, FixedLenByteArrayType,
        Int32Type as ParquetInt32Type, Int64Type as ParquetInt64Type, Int96,
        Int96Type as ParquetInt96Type,
    },
    file::writer::SerializedFileWriter,
    schema::parser::parse_message_type,
};
use tempfile::{NamedTempFile, TempDir};
use viewda_data_engine::{
    ColumnStatisticsReader, DataFilter, DataFilterOperator, DataSort, DataSortDirection,
    DataViewBuilder, DataViewError, DataViewMemoryLimit, DataWindowError, DataWindowReader,
    DatasetSource, FieldPath, JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT, JSON_SCHEMA_SAMPLE_ROW_LIMIT,
    JSON_SCHEMA_SAMPLE_VALUE_CHARACTER_LIMIT, JsonFieldTarget, JsonObservedType, JsonPath,
    JsonPathSegment, JsonValueType, PreparedDataView, TextValueSuggestionsReader,
    infer_json_schema_from_arrow, inspect_local_source,
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
fn projects_filters_sorts_and_statistics_with_parent_and_leaf_nulls() {
    let source = write_addressable_nested_parquet();
    let city = FieldPath::new(["profile.with.dot", "city\"name"]);
    let postal = FieldPath::new(["profile.with.dot", "address", "postal.code"]);
    let id = path("id");
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let projected = decode(
        reader
            .fetch_fields(0, 8, &[postal.clone(), city.clone(), id.clone()])
            .expect("nested projection"),
    );
    let batch = &projected[0];
    assert_eq!(
        batch
            .schema()
            .fields()
            .iter()
            .map(|field| (field.name().as_str(), field.is_nullable()))
            .collect::<Vec<_>>(),
        [("postal.code", true), ("city\"name", true), ("id", true)]
    );
    assert_eq!(
        optional_int32_values(batch, 0),
        [Some(100), None, None, Some(400)]
    );
    assert_eq!(
        string_values(batch, 1),
        [Some("A"), None, Some("C"), Some("D")]
    );

    let filtered = prepare_view(
        source.path(),
        &[DataFilter {
            field_path: postal.clone(),
            json_target: None,
            operator: DataFilterOperator::IsNull,
            values: Vec::new(),
            match_case: false,
        }],
        &[],
    )
    .expect("nested null filter");
    let filtered = decode(
        filtered
            .fetch_window_fields(0, 8, std::slice::from_ref(&id))
            .expect("filtered nested projection"),
    );
    assert_eq!(int64_values(&filtered[0], 0), [2, 3]);

    let non_null = prepare_view(
        source.path(),
        &[DataFilter {
            field_path: postal.clone(),
            json_target: None,
            operator: DataFilterOperator::IsNotNull,
            values: Vec::new(),
            match_case: false,
        }],
        &[],
    )
    .expect("nested non-null filter");
    let non_null = decode(
        non_null
            .fetch_window_fields(0, 8, std::slice::from_ref(&id))
            .expect("non-null nested projection"),
    );
    assert_eq!(int64_values(&non_null[0], 0), [1, 4]);

    let statistics = ColumnStatisticsReader::new(source.path().to_owned())
        .expect("nested statistics reader")
        .fetch(&postal, true)
        .expect("nullable leaf statistics");
    assert_eq!(statistics.null_count, 2);
    assert_eq!(statistics.null_share, 0.5);
    assert_eq!(statistics.minimum.as_deref(), Some("100"));
    assert_eq!(statistics.maximum.as_deref(), Some("400"));
    assert_eq!(statistics.approximate_distinct_count, Some(2));

    let sorted = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: postal.clone(),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("nested sort");
    let sorted = decode(
        sorted
            .fetch_window_fields(0, 8, &[id, city, postal])
            .expect("sorted nested projection"),
    );
    assert_eq!(int64_values(&sorted[0], 0), [1, 4, 2, 3]);
    assert_eq!(
        string_values(&sorted[0], 1),
        [Some("A"), Some("D"), None, Some("C")]
    );
}

#[test]
fn keeps_same_named_leaves_correlated_across_file_and_dataset_views() {
    let source = write_addressable_nested_parquet();
    let paths = [
        FieldPath::new(["profile.with.dot", "city\"name"]),
        FieldPath::new(["alternate", "city\"name"]),
    ];
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let direct_file = decode(
        reader
            .fetch_fields(0, 8, &paths)
            .expect("direct file same-named leaves"),
    )
    .remove(0);
    let file_view = DataViewBuilder::new(source.path().to_owned(), &[], &[])
        .expect("file view builder")
        .build()
        .expect("file view");
    let prepared_file = decode(
        file_view
            .fetch_window_fields(0, 8, &paths)
            .expect("prepared file same-named leaves"),
    )
    .remove(0);

    let directory = TempDir::new().expect("dataset directory");
    fs::copy(source.path(), directory.path().join("part.parquet")).expect("dataset fixture member");
    let dataset_source = DatasetSource::open_folder(directory.path()).expect("dataset source");
    let mut inspector = dataset_source.inspector();
    inspector.advance(1).expect("dataset inspection");
    let mut dataset = inspector.into_window_reader().expect("dataset reader");
    let direct_dataset = decode(
        dataset
            .fetch_fields(0, 8, &paths)
            .expect("direct dataset same-named leaves"),
    )
    .remove(0);
    let dataset_view = DataViewBuilder::for_dataset(&dataset, &[], &[], DataViewMemoryLimit::Mb384)
        .expect("dataset view builder")
        .build()
        .expect("dataset view");
    let prepared_dataset = decode(
        dataset_view
            .fetch_window_fields(0, 8, &paths)
            .expect("prepared dataset same-named leaves"),
    )
    .remove(0);

    for batch in [
        &direct_file,
        &prepared_file,
        &direct_dataset,
        &prepared_dataset,
    ] {
        assert_eq!(
            batch
                .schema()
                .fields()
                .iter()
                .map(|field| field.name().as_str())
                .collect::<Vec<_>>(),
            ["city\"name", "city\"name"]
        );
        assert_eq!(
            string_values(batch, 0),
            [Some("A"), None, Some("C"), Some("D")]
        );
        assert_eq!(
            string_values(batch, 1),
            [Some("W"), Some("X"), Some("Y"), Some("Z")]
        );
    }
}

#[test]
fn rejects_paths_that_traverse_list_elements() {
    let source = write_nested_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(
        reader.fetch_fields(0, 1, &[FieldPath::new(["tags", "element"])]),
        Err(DataWindowError::Unsupported)
    );
}

#[test]
fn duplicate_top_level_names_remain_readable_only_without_path_projection() {
    let source = write_duplicate_name_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batch = decode(
        reader
            .fetch(0, 1)
            .expect("unprojected duplicate-name window"),
    )
    .remove(0);
    assert_eq!(batch.num_columns(), 3);
    assert_eq!(int32_value(&batch, 0), 11);
    assert_eq!(int32_value(&batch, 1), 22);
    assert_eq!(int32_value(&batch, 2), 33);
    let projected = decode(
        reader
            .fetch_fields(0, 1, &[FieldPath::from("payload")])
            .expect("unambiguous projection after duplicate columns"),
    )
    .remove(0);
    assert_eq!(int32_value(&projected, 0), 33);
    assert_eq!(
        reader.fetch_fields(0, 1, &[FieldPath::from("duplicate")]),
        Err(DataWindowError::Unsupported)
    );
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
fn projects_five_columns_from_a_ten_thousand_column_source_in_requested_order() {
    let source = write_wide_parquet(10_000);
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(
        reader
            .fetch_fields(
                1,
                1,
                &[
                    path("c09999"),
                    path("c00000"),
                    path("c05000"),
                    path("c00042"),
                    path("c07000"),
                ],
            )
            .expect("projected wide window"),
    );
    let batch = &batches[0];

    assert_eq!(batch.num_columns(), 5);
    assert_eq!(
        batch
            .schema()
            .fields()
            .iter()
            .map(|field| field.name().as_str())
            .collect::<Vec<_>>(),
        ["c09999", "c00000", "c05000", "c00042", "c07000"]
    );
    assert_eq!(
        (0..batch.num_columns())
            .map(|column| int32_value(batch, column))
            .collect::<Vec<_>>(),
        [10_000, 1, 5_001, 43, 7_001]
    );
}

#[test]
fn projects_and_validates_deep_and_wide_struct_paths() {
    let source = write_deep_and_wide_struct_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let deep = FieldPath::new([
        "deep", "level1", "level2", "level3", "level4", "level5", "level6", "value",
    ]);
    let first = FieldPath::new(["wide", "field000"]);
    let middle = FieldPath::new(["wide", "field050"]);
    let last = FieldPath::new(["wide", "field099"]);

    let batch = decode(
        reader
            .fetch_fields(1, 1, &[last, deep.clone(), middle, first])
            .expect("deep and wide struct projection"),
    )
    .remove(0);
    assert_eq!(
        batch
            .schema()
            .fields()
            .iter()
            .map(|field| field.name().as_str())
            .collect::<Vec<_>>(),
        ["field099", "value", "field050", "field000"]
    );
    assert_eq!(int32_value(&batch, 0), 1_099);
    assert_eq!(int64_values(&batch, 1), [9]);
    assert_eq!(int32_value(&batch, 2), 1_050);
    assert_eq!(int32_value(&batch, 3), 1_000);

    assert_eq!(
        reader.fetch_fields(
            0,
            1,
            &[FieldPath::new([
                "deep", "level1", "level2", "level3", "level4", "level5", "missing", "value",
            ])],
        ),
        Err(DataWindowError::Unsupported)
    );
    assert_eq!(
        reader.fetch_fields(0, 1, &[FieldPath::new(["wide", "field100"])]),
        Err(DataWindowError::Unsupported)
    );
}

#[test]
fn projects_a_column_whose_name_exceeds_the_wire_summary_limit() {
    let column_name = format!("long_{}", "界".repeat(100));
    let source = write_named_parquet(&column_name);
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let batches = decode(
        reader
            .fetch_fields(0, 1, &[FieldPath::new(vec![column_name.clone()])])
            .expect("query schema keeps the complete column name"),
    );

    assert_eq!(batches[0].schema().field(0).name(), &column_name);
    assert_eq!(int32_value(&batches[0], 0), 17);
}

#[test]
fn projected_direct_windows_preserve_deep_file_order_and_unusual_names() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let full = decode(reader.fetch(6, 2).expect("full deep window"));
    let projected = decode(
        reader
            .fetch_fields(6, 2, &[path("select"), path("id\"quoted")])
            .expect("projected deep window"),
    );
    let projected = &projected[0];

    assert_eq!(projected.schema().field(0).name(), "select");
    assert_eq!(projected.schema().field(1).name(), "id\"quoted");
    assert_eq!(string_values(projected, 0), string_values(&full[0], 1));
    assert_eq!(int64_values(projected, 1), int64_values(&full[0], 0));
}

#[test]
fn reordered_top_level_projection_matches_a_full_deep_window() {
    let (_directory, source) = write_duckdb_nested_sort_parquet();
    let mut reader = DataWindowReader::new(source);

    let full = decode(reader.fetch(8_150, 100).expect("full deep window")).remove(0);
    let projected = decode(
        reader
            .fetch_fields(8_150, 100, &[path("list_value"), path("file_order")])
            .expect("reordered top-level deep window"),
    )
    .remove(0);

    assert_eq!(projected.num_rows(), 100);
    assert_eq!(
        projected
            .schema()
            .fields()
            .iter()
            .map(|field| field.name().as_str())
            .collect::<Vec<_>>(),
        ["list_value", "file_order"]
    );
    assert_eq!(projected.column(0).to_data(), full.column(2).to_data());
    assert_eq!(int64_values(&projected, 1), int64_values(&full, 0));
}

#[test]
fn projected_windows_treat_file_row_number_as_data_and_keep_empty_boundaries() {
    let source = write_file_row_number_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let payload = path("payload");

    let batch = decode(
        reader
            .fetch_fields(1, 1, std::slice::from_ref(&payload))
            .expect("projected window after the first row"),
    )
    .remove(0);
    assert_eq!(string_values(&batch, 0), [Some("row-1")]);

    for (offset, count) in [(1, 0), (100, 2)] {
        let bytes = reader
            .fetch_fields(offset, count, std::slice::from_ref(&payload))
            .expect("empty projected window");
        let stream = StreamReader::try_new(Cursor::new(bytes), None).expect("Arrow IPC stream");
        assert_eq!(stream.schema().field(0).name(), "payload");
        assert_eq!(stream.count(), 0, "window at offset {offset}");
    }
}

#[test]
fn projected_windows_keep_empty_schema_and_cross_row_group_order() {
    let empty_source = write_empty_projected_parquet();
    let mut empty_reader = DataWindowReader::new(empty_source.path().to_owned());
    let empty_bytes = empty_reader
        .fetch_fields(0, 4, &[path("file_order")])
        .expect("zero-row projected window");
    let empty = StreamReader::try_new(Cursor::new(empty_bytes), None).expect("Arrow IPC stream");
    assert_eq!(empty.schema().field(0).name(), "file_order");
    assert_eq!(empty.count(), 0);

    let grouped_source = write_multi_group_parquet();
    let mut grouped_reader = DataWindowReader::new(grouped_source.path().to_owned());
    let batch = decode(
        grouped_reader
            .fetch_fields(3, 4, &[path("file_order")])
            .expect("projected window across a row-group boundary"),
    )
    .remove(0);
    assert_eq!(batch.num_rows(), 4);
    assert_eq!(int64_values(&batch, 0), [3, 4, 5, 6]);
}

#[test]
fn identity_projection_keeps_the_direct_window_wire_format() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let full = reader.fetch(2, 3).expect("full window");
    let identity = reader
        .fetch_fields(
            2,
            3,
            &[
                path("id\"quoted"),
                path("select"),
                path("active"),
                path("day"),
                path("score"),
            ],
        )
        .expect("identity-projected window");

    assert_eq!(identity, full);
}

#[test]
fn rejects_invalid_direct_projections() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(
        reader.fetch_fields(0, 1, &[]),
        Err(DataWindowError::Unsupported)
    );
    assert_eq!(
        reader.fetch_fields(0, 1, &[path("select"), path("select")]),
        Err(DataWindowError::Unsupported)
    );
    assert_eq!(
        reader.fetch_fields(0, 1, &[path("missing")]),
        Err(DataWindowError::Unsupported)
    );
}

#[test]
fn maps_a_damaged_parquet_source_to_a_typed_error() {
    let source = write_basic_parquet();
    fs::write(source.path(), b"PAR1broken footerPAR1").expect("corrupt fixture");
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(reader.fetch(0, 4), Err(DataWindowError::CorruptSource));
    assert!(matches!(
        prepare_view(
            source.path(),
            &[filter("id\"quoted", DataFilterOperator::Equals, &["10"])],
            &[],
        ),
        Err(DataViewError::Engine(DataWindowError::CorruptSource))
    ));
}

#[test]
fn rejects_an_unbounded_window_before_querying_duckdb() {
    let source = write_basic_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());

    assert_eq!(reader.fetch(0, 513), Err(DataWindowError::WindowTooLarge));
    assert_eq!(
        reader.fetch_fields(0, 513, &[path("id\"quoted")]),
        Err(DataWindowError::WindowTooLarge)
    );
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
        (
            filter("id\"quoted", DataFilterOperator::Equals, &["12"]),
            vec![12],
        ),
        (
            filter("id\"quoted", DataFilterOperator::NotEquals, &["12"]),
            vec![10, 11, 13, 14, 15, 16, 17],
        ),
        (
            filter("id\"quoted", DataFilterOperator::GreaterThan, &["12"]),
            vec![13, 14, 15, 16, 17],
        ),
        (
            filter(
                "id\"quoted",
                DataFilterOperator::GreaterThanOrEqual,
                &["12"],
            ),
            vec![12, 13, 14, 15, 16, 17],
        ),
        (
            filter("id\"quoted", DataFilterOperator::LessThan, &["12"]),
            vec![10, 11],
        ),
        (
            filter("id\"quoted", DataFilterOperator::LessThanOrEqual, &["12"]),
            vec![10, 11, 12],
        ),
        (
            filter("id\"quoted", DataFilterOperator::OneOf, &["11", "14"]),
            vec![11, 14],
        ),
        (
            filter("id\"quoted", DataFilterOperator::Range, &["12", "14"]),
            vec![12, 13, 14],
        ),
        (filter("score", DataFilterOperator::IsNull, &[]), vec![15]),
        (
            filter("score", DataFilterOperator::IsNotNull, &[]),
            vec![10, 11, 12, 13, 14, 16, 17],
        ),
        (
            filter("select", DataFilterOperator::Equals, &["row-2"]),
            vec![12],
        ),
        (
            filter("select", DataFilterOperator::NotEquals, &["row-2"]),
            vec![10, 13, 14, 15, 16, 17],
        ),
        (
            filter("select", DataFilterOperator::OneOf, &["row-2", "row-4"]),
            vec![12, 14],
        ),
        (
            filter("select", DataFilterOperator::TextContains, &["row-"]),
            vec![10, 12, 13, 14, 15, 16, 17],
        ),
        (filter("select", DataFilterOperator::IsNull, &[]), vec![11]),
        (
            filter("select", DataFilterOperator::IsNotNull, &[]),
            vec![10, 12, 13, 14, 15, 16, 17],
        ),
        (
            filter("active", DataFilterOperator::Equals, &["true"]),
            vec![10, 12, 14, 16],
        ),
        (
            filter("active", DataFilterOperator::NotEquals, &["true"]),
            vec![11, 13, 15],
        ),
        (filter("active", DataFilterOperator::IsNull, &[]), vec![17]),
        (
            filter("active", DataFilterOperator::IsNotNull, &[]),
            vec![10, 11, 12, 13, 14, 15, 16],
        ),
        (
            filter("day", DataFilterOperator::Equals, &["1970-01-03"]),
            vec![12],
        ),
        (
            filter("day", DataFilterOperator::NotEquals, &["1970-01-03"]),
            vec![10, 11, 13, 14, 15, 17],
        ),
        (
            filter(
                "day",
                DataFilterOperator::OneOf,
                &["1970-01-02", "1970-01-05"],
            ),
            vec![11, 14],
        ),
        (
            filter(
                "day",
                DataFilterOperator::Range,
                &["1970-01-03", "1970-01-05"],
            ),
            vec![12, 13, 14],
        ),
        (filter("day", DataFilterOperator::IsNull, &[]), vec![16]),
        (
            filter("day", DataFilterOperator::IsNotNull, &[]),
            vec![10, 11, 12, 13, 14, 15, 17],
        ),
    ];

    for (condition, expected) in cases {
        let view = prepare_view(source.path(), &[condition], &[]).expect("filtered view");
        let batches = decode(view.fetch_window(0, 32).expect("filtered window"));
        assert_eq!(int64_values(&batches[0], 0), expected);
    }
}

#[test]
fn applies_text_operators_case_insensitively_unless_match_case_is_enabled() {
    let source = write_text_parquet(vec![
        Some("Alphabet".to_owned()),
        Some("alphabet".to_owned()),
        Some("ALPHABET".to_owned()),
        Some("omegaBeta".to_owned()),
        Some("Бета".to_owned()),
        Some("бета".to_owned()),
        Some(String::new()),
        None,
    ]);
    let cases = [
        (
            text_filter(DataFilterOperator::TextContains, "PHA", false),
            vec![Some("Alphabet"), Some("alphabet"), Some("ALPHABET")],
        ),
        (
            text_filter(DataFilterOperator::TextContains, "PHA", true),
            vec![Some("ALPHABET")],
        ),
        (
            text_filter(DataFilterOperator::StartsWith, "ALP", false),
            vec![Some("Alphabet"), Some("alphabet"), Some("ALPHABET")],
        ),
        (
            text_filter(DataFilterOperator::EndsWith, "BET", false),
            vec![Some("Alphabet"), Some("alphabet"), Some("ALPHABET")],
        ),
        (
            text_filter(DataFilterOperator::NotContains, "PHA", false),
            vec![Some("omegaBeta"), Some("Бета"), Some("бета"), Some("")],
        ),
        (
            text_filter(DataFilterOperator::StartsWith, "БЕ", false),
            vec![Some("Бета"), Some("бета")],
        ),
        (
            text_filter(DataFilterOperator::StartsWith, "БЕ", true),
            Vec::new(),
        ),
    ];

    for (condition, expected) in cases {
        let view = prepare_view(source.path(), &[condition], &[]).expect("text-filtered view");
        assert_eq!(view.row_count(), expected.len() as u64);
        if !expected.is_empty() {
            let batches = decode(view.fetch_window(0, 32).expect("text filter window"));
            assert_eq!(string_values(&batches[0], 0), expected);
        }
    }
}

#[test]
fn applies_nested_text_operators_to_a_dotted_path_segment() {
    let source = write_addressable_nested_parquet();
    let field_path = FieldPath::new(["profile.with.dot", "city\"name"]);
    let id = path("id");

    for (operator, value, expected) in [
        (DataFilterOperator::TextContains, "c", vec![3]),
        (DataFilterOperator::StartsWith, "d", vec![4]),
    ] {
        let view = prepare_view(
            source.path(),
            &[DataFilter {
                field_path: field_path.clone(),
                json_target: None,
                operator,
                values: vec![value.to_owned()],
                match_case: false,
            }],
            &[],
        )
        .expect("nested text-filtered view");
        let rows = decode(
            view.fetch_window_fields(0, 8, std::slice::from_ref(&id))
                .expect("nested text-filtered window"),
        );

        assert_eq!(int64_values(&rows[0], 0), expected);
    }
}

#[test]
fn empty_string_equals_matches_empty_cells_but_not_nulls() {
    let source = write_text_parquet(vec![Some(String::new()), None, Some("value".to_owned())]);
    let view = prepare_view(
        source.path(),
        &[filter("label", DataFilterOperator::Equals, &[""])],
        &[],
    )
    .expect("empty-string filtered view");
    let batches = decode(view.fetch_window(0, 8).expect("empty-string window"));

    assert_eq!(string_values(&batches[0], 0), vec![Some("")]);
}

#[test]
fn suggests_distinct_substring_matches_with_a_fixed_cap() {
    let mut values = (0..25)
        .map(|index| Some(format!("Alpha{index:02}")))
        .collect::<Vec<_>>();
    values.extend([
        Some("Alpha00".to_owned()),
        Some("alpha00".to_owned()),
        Some("Beta".to_owned()),
        None,
    ]);
    let source = write_text_parquet(values);

    let suggestions =
        fetch_text_suggestions(source.path(), "PHA", "label", DataFilterOperator::Equals)
            .expect("suggestions");

    assert_eq!(suggestions.values.len(), 20);
    assert!(suggestions.is_partial);
    assert!(
        suggestions
            .values
            .iter()
            .all(|value| value.to_lowercase().contains("pha"))
    );
    assert_eq!(
        suggestions
            .values
            .iter()
            .filter(|value| *value == "Alpha00")
            .count(),
        1
    );
    assert!(!suggestions.values.contains(&"Beta".to_owned()));
}

#[test]
fn equals_and_not_equals_suggest_uuid_values_by_middle_fragments() {
    let source = write_special_types_parquet();
    let summary = inspect_local_source(source.path()).expect("special-type summary");
    let uuid = &summary.schema[1];

    for operator in [DataFilterOperator::Equals, DataFilterOperator::NotEquals] {
        let suggestions = fetch_text_suggestions(source.path(), "E89B-12D3", &uuid.name, operator)
            .expect("UUID suggestions");

        assert_eq!(
            suggestions.values,
            [
                "123e4567-e89b-12d3-a456-426614174000",
                "123e4567-e89b-12d3-a456-426614174001",
            ]
        );
        assert!(!suggestions.is_partial);
    }
}

#[test]
fn positional_operators_keep_their_input_positions() {
    let source = write_text_parquet(vec![Some("Alphabet".to_owned()), Some("Gamma".to_owned())]);

    for (operator, input, expected) in [
        (DataFilterOperator::TextContains, "pha", vec!["Alphabet"]),
        (DataFilterOperator::NotContains, "pha", vec!["Alphabet"]),
        (DataFilterOperator::StartsWith, "pha", Vec::new()),
        (DataFilterOperator::EndsWith, "pha", Vec::new()),
        (DataFilterOperator::StartsWith, "alp", vec!["Alphabet"]),
        (DataFilterOperator::EndsWith, "bet", vec!["Alphabet"]),
    ] {
        let suggestions =
            fetch_text_suggestions(source.path(), input, "label", operator).expect("suggestions");

        assert_eq!(suggestions.values, expected);
        assert!(!suggestions.is_partial);
    }
}

#[test]
fn finds_a_match_beyond_ten_thousand_rows() {
    let mut values = vec![Some("common".to_owned()); 10_000];
    values.push(Some("late".to_owned()));
    let source = write_text_parquet(values);

    let suggestions =
        fetch_text_suggestions(source.path(), "late", "label", DataFilterOperator::Equals)
            .expect("suggestions");

    assert_eq!(suggestions.values, ["late"]);
    assert!(!suggestions.is_partial);
}

#[test]
fn marks_a_suggestion_scan_complete_when_the_column_ends_before_twenty_matches() {
    let source = write_text_parquet(vec![
        Some("Alpha".to_owned()),
        Some("Beta".to_owned()),
        None,
    ]);

    let suggestions =
        fetch_text_suggestions(source.path(), "", "label", DataFilterOperator::Equals)
            .expect("suggestions");

    assert_eq!(suggestions.values, vec!["Alpha", "Beta"]);
    assert!(!suggestions.is_partial);
}

#[test]
fn cancels_text_value_suggestions_before_scanning() {
    let source = write_text_parquet(vec![Some("value".to_owned())]);
    let reader =
        TextValueSuggestionsReader::new(source.path().to_owned()).expect("suggestions reader");
    let interrupt = reader.interrupt_handle();

    interrupt.interrupt();

    assert_eq!(
        reader.fetch("", &path("label"), DataFilterOperator::Equals, &interrupt,),
        Err(DataWindowError::Cancelled)
    );
}

fn fetch_text_suggestions(
    source_path: &std::path::Path,
    input: &str,
    column_name: &str,
    operator: DataFilterOperator,
) -> Result<viewda_data_engine::TextValueSuggestions, DataWindowError> {
    let reader = TextValueSuggestionsReader::new(source_path.to_owned())?;
    let interrupt = reader.interrupt_handle();
    reader.fetch(input, &path(column_name), operator, &interrupt)
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
    let column_names = ["id", "integer", "float", "double", "decimal", "half"];

    for (column_index, column_name) in column_names.iter().enumerate().skip(1) {
        for (operator, expected) in cases {
            let view = prepare_view(source.path(), &[filter(column_name, operator, &["2"])], &[])
                .expect("filtered numeric view");
            let batches = decode(view.fetch_window(0, 32).expect("filtered numeric window"));

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
                "uuid_value",
                DataFilterOperator::Equals,
                &["123e4567-e89b-12d3-a456-426614174001"],
            ),
            vec![2],
        ),
        (
            filter(
                "uuid_value",
                DataFilterOperator::OneOf,
                &[
                    "123e4567-e89b-12d3-a456-426614174000",
                    "550e8400-e29b-41d4-a716-446655440000",
                ],
            ),
            vec![1, 3],
        ),
        (
            filter("uuid_value", DataFilterOperator::TextContains, &["e89b"]),
            vec![1, 2],
        ),
        (
            filter("json_value", DataFilterOperator::TextContains, &["beta"]),
            vec![2],
        ),
    ];

    for (condition, expected) in cases {
        let view =
            prepare_view(source.path(), &[condition], &[]).expect("special-type filtered view");
        let batches = decode(
            view.fetch_window(0, 8)
                .expect("special-type filtered window"),
        );
        assert_eq!(int64_values(&batches[0], 0), expected);
    }
}

#[test]
fn manual_json_path_works_when_the_path_appears_after_the_schema_sample() {
    let mut values = vec![r#"{"known":1}"#.to_owned(); JSON_SCHEMA_SAMPLE_ROW_LIMIT as usize];
    values.push(r#"{"late":"found"}"#.to_owned());
    let source = write_json_path_parquet(&values);
    let summary = inspect_local_source(source.path()).expect("JSON source summary");
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let sample = reader
        .fetch_json_schema_sample(&path("payload"))
        .expect("JSON sample window");
    let inferred = infer_json_schema_from_arrow(&summary.schema[1], &sample, summary.row_count)
        .expect("sampled JSON schema");

    assert!(inferred.is_sample_derived);
    assert_eq!(inferred.sample_row_limit, JSON_SCHEMA_SAMPLE_ROW_LIMIT);
    assert_eq!(inferred.sampled_row_count, JSON_SCHEMA_SAMPLE_ROW_LIMIT);
    assert!(inferred.has_more_rows);
    assert!(
        inferred
            .nodes
            .iter()
            .all(|node| { node.segment != JsonPathSegment::Field("late".to_owned()) })
    );

    let filtered = prepare_view(
        source.path(),
        &[json_filter(
            JsonPath::new([JsonPathSegment::Field("late".to_owned())]),
            JsonValueType::Text,
            DataFilterOperator::Equals,
            &["found"],
        )],
        &[],
    )
    .expect("manual path filter");
    let rows = decode(
        filtered
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("manual path result"),
    );
    assert_eq!(int64_values(&rows[0], 0), [512]);
}

#[test]
fn json_schema_sample_bounds_arrow_output_for_oversized_values() {
    let oversized = format!(
        r#"{{"large":"{}"}}"#,
        "x".repeat(JSON_SCHEMA_SAMPLE_VALUE_CHARACTER_LIMIT + 1)
    );
    let values = vec![oversized; JSON_SCHEMA_SAMPLE_ROW_LIMIT as usize];
    let source = write_json_path_parquet(&values);
    let summary = inspect_local_source(source.path()).expect("oversized JSON summary");
    let mut reader = DataWindowReader::new(source.path().to_owned());

    let sample = reader
        .fetch_json_schema_sample(&path("payload"))
        .expect("bounded oversized JSON sample");
    assert!(sample.len() <= JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT);
    let inferred = infer_json_schema_from_arrow(&summary.schema[1], &sample, summary.row_count)
        .expect("oversized JSON inference");

    assert_eq!(inferred.oversized_value_count, JSON_SCHEMA_SAMPLE_ROW_LIMIT);
    assert_eq!(inferred.sampled_value_bytes, 0);
    assert!(inferred.is_truncated);
    assert!(inferred.nodes.is_empty());

    let directory = TempDir::new().expect("oversized JSON dataset directory");
    fs::copy(source.path(), directory.path().join("part.parquet"))
        .expect("oversized JSON dataset member");
    let dataset_source = DatasetSource::open_folder(directory.path()).expect("JSON dataset source");
    let mut inspector = dataset_source.inspector();
    inspector.advance(1).expect("JSON dataset inspection");
    let mut dataset = inspector.into_window_reader().expect("JSON dataset reader");
    let dataset_sample = dataset
        .fetch_json_schema_sample_while(&path("payload"), || true)
        .expect("bounded oversized dataset JSON sample");
    assert!(dataset_sample.len() <= JSON_SCHEMA_SAMPLE_ARROW_BYTE_LIMIT);
    let dataset_inferred =
        infer_json_schema_from_arrow(&summary.schema[1], &dataset_sample, summary.row_count)
            .expect("oversized dataset JSON inference");
    assert_eq!(
        dataset_inferred.oversized_value_count,
        JSON_SCHEMA_SAMPLE_ROW_LIMIT
    );
}

#[test]
fn filters_a_json_number_through_a_nested_array_index() {
    let source = write_json_path_parquet(&[
        r#"{"items":[{"score":12}]}"#.to_owned(),
        r#"{"items":[{"score":3}]}"#.to_owned(),
        r#"{"items":[]}"#.to_owned(),
    ]);
    let filtered = prepare_view(
        source.path(),
        &[json_filter(
            JsonPath::new([
                JsonPathSegment::Field("items".to_owned()),
                JsonPathSegment::Index(0),
                JsonPathSegment::Field("score".to_owned()),
            ]),
            JsonValueType::Number,
            DataFilterOperator::GreaterThan,
            &["10"],
        )],
        &[],
    )
    .expect("array-index JSON filter");
    let rows = decode(
        filtered
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("array-index filter result"),
    );

    assert_eq!(int64_values(&rows[0], 0), [0]);
}

#[test]
fn filters_and_sorts_a_nested_json_boolean_with_nulls_last() {
    let source = write_nullable_json_path_parquet(&[
        Some(r#"{"nested":{"enabled":true}}"#),
        Some(r#"{"nested":{"enabled":false}}"#),
        Some(r#"{"nested":{"enabled":true}}"#),
        Some(r#"{"nested":{"enabled":null}}"#),
        Some(r#"{"nested":{}}"#),
        None,
    ]);
    let json_path = || {
        JsonPath::new([
            JsonPathSegment::Field("nested".to_owned()),
            JsonPathSegment::Field("enabled".to_owned()),
        ])
    };

    for (operator, value, expected) in [
        (DataFilterOperator::Equals, "true", vec![0, 2]),
        (DataFilterOperator::Equals, "false", vec![1]),
        (DataFilterOperator::NotEquals, "false", vec![0, 2]),
    ] {
        let filtered = prepare_view(
            source.path(),
            &[json_filter(
                json_path(),
                JsonValueType::Boolean,
                operator,
                &[value],
            )],
            &[],
        )
        .expect("nested JSON boolean filter");
        let rows = decode(
            filtered
                .fetch_window_fields(0, 8, &[path("id")])
                .expect("nested JSON boolean rows"),
        );

        assert_eq!(int64_values(&rows[0], 0), expected);
    }

    let nulls = prepare_view(
        source.path(),
        &[json_filter(
            json_path(),
            JsonValueType::Boolean,
            DataFilterOperator::IsNull,
            &[],
        )],
        &[],
    )
    .expect("nested JSON boolean null filter");
    let rows = decode(
        nulls
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("nested JSON boolean null rows"),
    );
    assert_eq!(int64_values(&rows[0], 0), [3, 4, 5]);

    let sorted = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("payload"),
            json_target: Some(JsonFieldTarget {
                path: json_path(),
                value_type: JsonValueType::Boolean,
            }),
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("nested JSON boolean sort");
    let rows = decode(
        sorted
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("nested JSON boolean sorted rows"),
    );

    assert_eq!(int64_values(&rows[0], 0), [1, 0, 2, 3, 4, 5]);
}

#[test]
fn json_path_execution_keeps_numeric_object_keys_distinct_from_array_indices() {
    let key = "a.b\"\\[]'";
    let source = write_json_path_parquet(&[
        r#"{"0":{"a.b\"\\[]'":11}}"#.to_owned(),
        r#"[{"a.b\"\\[]'":22}]"#.to_owned(),
    ]);
    let cases = [
        (
            JsonPath::new([
                JsonPathSegment::Field("0".to_owned()),
                JsonPathSegment::Field(key.to_owned()),
            ]),
            "11",
            vec![0],
        ),
        (
            JsonPath::new([
                JsonPathSegment::Index(0),
                JsonPathSegment::Field(key.to_owned()),
            ]),
            "22",
            vec![1],
        ),
    ];

    for (json_path, value, expected) in cases {
        let filtered = prepare_view(
            source.path(),
            &[json_filter(
                json_path,
                JsonValueType::Number,
                DataFilterOperator::Equals,
                &[value],
            )],
            &[],
        )
        .expect("typed JSON-path filter");
        let rows = decode(
            filtered
                .fetch_window_fields(0, 8, &[path("id")])
                .expect("typed JSON-path rows"),
        );

        assert_eq!(int64_values(&rows[0], 0), expected);
    }
}

#[test]
fn json_numbers_keep_exact_decimal_and_finite_double_branches() {
    let source = write_nullable_json_path_parquet(&[
        Some(r#"{"value":9007199254740992}"#),
        Some(r#"{"value":9007199254740993}"#),
        Some(r#"{"value":9223372036854775807}"#),
        Some(r#"{"value":0.1}"#),
        Some(r#"{"value":0.100000000000000001}"#),
        Some(r#"{"value":100000000000000000000}"#),
        Some(r#"{"value":1e100}"#),
        Some(r#"{"value":0.1000000000000000001}"#),
        Some(r#"{"value":-1e100}"#),
        Some(r#"{"value":"not-a-number"}"#),
        Some(r#"{"value":null}"#),
        Some("{}"),
        None,
    ]);
    let json_path = || JsonPath::new([JsonPathSegment::Field("value".to_owned())]);
    let exact = prepare_view(
        source.path(),
        &[json_filter(
            json_path(),
            JsonValueType::Number,
            DataFilterOperator::Equals,
            &["9007199254740993"],
        )],
        &[],
    )
    .expect("exact JSON number filter");
    let rows = decode(
        exact
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("exact JSON number rows"),
    );
    assert_eq!(int64_values(&rows[0], 0), [1]);

    let exact_range = prepare_view(
        source.path(),
        &[json_filter(
            json_path(),
            JsonValueType::Number,
            DataFilterOperator::Range,
            &["9007199254740992", "9007199254740993"],
        )],
        &[],
    )
    .expect("exact JSON number range");
    let rows = decode(
        exact_range
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("exact JSON number range rows"),
    );
    assert_eq!(int64_values(&rows[0], 0), [0, 1]);

    let i64_max = prepare_view(
        source.path(),
        &[json_filter(
            json_path(),
            JsonValueType::Number,
            DataFilterOperator::Equals,
            &["9223372036854775807"],
        )],
        &[],
    )
    .expect("i64 max JSON number filter");
    let rows = decode(
        i64_max
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("i64 max JSON number rows"),
    );
    assert_eq!(int64_values(&rows[0], 0), [2]);

    let finite_fallback = prepare_view(
        source.path(),
        &[json_filter(
            json_path(),
            JsonValueType::Number,
            DataFilterOperator::OneOf,
            &["1e100", "0.1000000000000000001"],
        )],
        &[],
    )
    .expect("finite fallback JSON number filter");
    let rows = decode(
        finite_fallback
            .fetch_window_fields(0, 16, &[path("id")])
            .expect("finite fallback JSON number rows"),
    );
    assert_eq!(int64_values(&rows[0], 0), [3, 4, 6, 7]);

    let sorted = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("payload"),
            json_target: Some(JsonFieldTarget {
                path: json_path(),
                value_type: JsonValueType::Number,
            }),
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("exact JSON number sort");
    let rows = decode(
        sorted
            .fetch_window_fields(0, 16, &[path("id")])
            .expect("exact JSON number sorted rows"),
    );
    assert_eq!(
        int64_values(&rows[0], 0),
        [8, 3, 4, 7, 0, 1, 2, 5, 6, 9, 10, 11, 12]
    );

    let sorted = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("payload"),
            json_target: Some(JsonFieldTarget {
                path: json_path(),
                value_type: JsonValueType::Number,
            }),
            direction: DataSortDirection::Descending,
        }],
    )
    .expect("descending JSON number sort");
    let rows = decode(
        sorted
            .fetch_window_fields(0, 16, &[path("id")])
            .expect("descending JSON number sorted rows"),
    );
    assert_eq!(
        int64_values(&rows[0], 0),
        [6, 5, 2, 1, 0, 3, 4, 7, 8, 9, 10, 11, 12]
    );

    let non_null = prepare_view(
        source.path(),
        &[json_filter(
            json_path(),
            JsonValueType::Number,
            DataFilterOperator::IsNotNull,
            &[],
        )],
        &[],
    )
    .expect("finite JSON number presence filter");
    let rows = decode(
        non_null
            .fetch_window_fields(0, 16, &[path("id")])
            .expect("finite JSON number presence rows"),
    );
    assert_eq!(int64_values(&rows[0], 0), (0..=8).collect::<Vec<_>>());
}

#[test]
fn json_number_bucket_ties_distinguish_exact_integers_from_fractional_doubles() {
    let source = write_nullable_json_path_parquet(&[
        Some(r#"{"value":9007199254740992.0}"#),
        Some(r#"{"value":9007199254740993}"#),
        Some(r#"{"value":9007199254740992}"#),
        Some(r#"{"value":0.1000000000000000001}"#),
        Some(r#"{"value":"not-a-number"}"#),
        None,
    ]);
    let json_path = || JsonPath::new([JsonPathSegment::Field("value".to_owned())]);
    let filter_ids = |operator, values: &[&str]| {
        let view = prepare_view(
            source.path(),
            &[json_filter(
                json_path(),
                JsonValueType::Number,
                operator,
                values,
            )],
            &[],
        )
        .expect("JSON number collision filter");
        let rows = decode(
            view.fetch_window_fields(0, 16, &[path("id")])
                .expect("JSON number collision rows"),
        );
        int64_values(&rows[0], 0)
    };

    assert_eq!(
        filter_ids(DataFilterOperator::Equals, &["9007199254740993"]),
        [1]
    );
    assert_eq!(
        filter_ids(DataFilterOperator::NotEquals, &["9007199254740993"]),
        [0, 2, 3]
    );
    assert_eq!(
        filter_ids(DataFilterOperator::LessThan, &["9007199254740993"]),
        [0, 2, 3]
    );
    assert_eq!(
        filter_ids(DataFilterOperator::Equals, &["9007199254740992"]),
        [0, 2]
    );
    assert_eq!(
        filter_ids(DataFilterOperator::Equals, &["0.1000000000000000001"]),
        [3]
    );

    for (direction, expected) in [
        (DataSortDirection::Ascending, vec![3, 0, 2, 1, 4, 5]),
        (DataSortDirection::Descending, vec![1, 0, 2, 3, 4, 5]),
    ] {
        let view = prepare_view(
            source.path(),
            &[],
            &[DataSort {
                field_path: path("payload"),
                json_target: Some(JsonFieldTarget {
                    path: json_path(),
                    value_type: JsonValueType::Number,
                }),
                direction,
            }],
        )
        .expect("JSON number collision sort");
        let rows = decode(
            view.fetch_window_fields(0, 16, &[path("id")])
                .expect("JSON number collision sorted rows"),
        );

        assert_eq!(int64_values(&rows[0], 0), expected);
    }
}

#[test]
fn json_null_filter_covers_missing_json_null_and_null_root() {
    let source = write_nullable_json_path_parquet(&[
        Some(r#"{"value":null}"#),
        Some("{}"),
        Some(r#"{"value":"not-a-number"}"#),
        None,
        Some(r#"{"value":1}"#),
    ]);
    let target = || JsonPath::new([JsonPathSegment::Field("value".to_owned())]);

    for (operator, expected) in [
        (DataFilterOperator::IsNull, vec![0, 1, 2, 3]),
        (DataFilterOperator::IsNotNull, vec![4]),
    ] {
        let filtered = prepare_view(
            source.path(),
            &[json_filter(target(), JsonValueType::Number, operator, &[])],
            &[],
        )
        .expect("JSON null-semantics filter");
        let rows = decode(
            filtered
                .fetch_window_fields(0, 8, &[path("id")])
                .expect("JSON null-semantics rows"),
        );

        assert_eq!(int64_values(&rows[0], 0), expected);
    }
}

#[test]
fn invalid_logical_json_is_rejected_by_the_source_scan() {
    let source = write_json_path_parquet(&["not-json".to_owned()]);

    assert!(matches!(
        prepare_view(
            source.path(),
            &[json_filter(
                JsonPath::new([JsonPathSegment::Field("value".to_owned())]),
                JsonValueType::Number,
                DataFilterOperator::IsNull,
                &[],
            )],
            &[],
        ),
        Err(DataViewError::Engine(DataWindowError::CorruptSource))
    ));
}

#[test]
fn dataset_json_filter_and_sort_use_the_same_path_contract() {
    let first =
        write_json_path_parquet(&[r#"{"value":2}"#.to_owned(), r#"{"value":12}"#.to_owned()]);
    let second =
        write_json_path_parquet(&[r#"{"value":7}"#.to_owned(), r#"{"value":20}"#.to_owned()]);
    let directory = TempDir::new().expect("JSON dataset directory");
    fs::copy(first.path(), directory.path().join("a.parquet")).expect("first JSON member");
    fs::copy(second.path(), directory.path().join("b.parquet")).expect("second JSON member");
    let source = DatasetSource::open_folder(directory.path()).expect("JSON dataset source");
    let mut inspector = source.inspector();
    inspector.advance(2).expect("JSON dataset inspection");
    let reader = inspector.into_window_reader().expect("JSON dataset reader");
    let target = JsonFieldTarget {
        path: JsonPath::new([JsonPathSegment::Field("value".to_owned())]),
        value_type: JsonValueType::Number,
    };
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[json_filter(
            target.path.clone(),
            target.value_type,
            DataFilterOperator::GreaterThan,
            &["5"],
        )],
        &[DataSort {
            field_path: path("payload"),
            json_target: Some(target),
            direction: DataSortDirection::Descending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("JSON dataset view builder")
    .build()
    .expect("JSON dataset view");
    let rows = decode(
        view.fetch_window_fields(0, 8, &[path("payload")])
            .expect("JSON dataset rows"),
    );

    assert_eq!(
        string_values(&rows[0], 0),
        [
            Some(r#"{"value":20}"#),
            Some(r#"{"value":12}"#),
            Some(r#"{"value":7}"#),
        ]
    );
}

#[test]
fn mixed_json_types_infer_and_sort_with_the_text_fallback() {
    let source = write_json_path_parquet(&[
        r#"{"value":2}"#.to_owned(),
        r#"{"value":"10"}"#.to_owned(),
        r#"{"value":1}"#.to_owned(),
    ]);
    let summary = inspect_local_source(source.path()).expect("mixed JSON summary");
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let sample = reader
        .fetch_json_schema_sample(&path("payload"))
        .expect("mixed JSON sample");
    let inferred = infer_json_schema_from_arrow(&summary.schema[1], &sample, summary.row_count)
        .expect("mixed JSON inference");
    let value = inferred
        .nodes
        .iter()
        .find(|node| node.segment == JsonPathSegment::Field("value".to_owned()))
        .expect("inferred value path");
    assert_eq!(
        value.observed_types,
        [JsonObservedType::Number, JsonObservedType::String]
    );
    assert_eq!(value.effective_type, Some(JsonValueType::Mixed));

    let sorted = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("payload"),
            json_target: Some(JsonFieldTarget {
                path: JsonPath::new([JsonPathSegment::Field("value".to_owned())]),
                value_type: JsonValueType::Mixed,
            }),
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("mixed JSON sort");
    let rows = decode(
        sorted
            .fetch_window_fields(0, 8, &[path("id")])
            .expect("mixed JSON sorted rows"),
    );

    assert_eq!(int64_values(&rows[0], 0), [2, 1, 0]);
}

#[test]
fn json_filter_uses_the_existing_prepared_view_cancellation_handle() {
    let source = write_json_path_parquet(&[r#"{"value":1}"#.to_owned()]);
    let builder = DataViewBuilder::new(
        source.path().to_owned(),
        &[json_filter(
            JsonPath::new([JsonPathSegment::Field("value".to_owned())]),
            JsonValueType::Number,
            DataFilterOperator::Equals,
            &["1"],
        )],
        &[],
    )
    .expect("JSON view builder");
    let interrupt = builder.interrupt_handle();
    interrupt.interrupt();

    assert!(matches!(
        builder.build(),
        Err(DataViewError::Engine(DataWindowError::Cancelled))
    ));
}

#[test]
fn keeps_plain_binary_columns_null_only() {
    let source = write_special_types_parquet();

    assert!(matches!(
        prepare_view(
            source.path(),
            &[filter(
                "binary_value",
                DataFilterOperator::TextContains,
                &["alpha"],
            )],
            &[],
        ),
        Err(DataViewError::Engine(DataWindowError::InvalidFilter))
    ));

    let view = prepare_view(
        source.path(),
        &[filter("binary_value", DataFilterOperator::IsNotNull, &[])],
        &[],
    )
    .expect("binary null-check view");
    let batches = decode(view.fetch_window(0, 8).expect("binary null-check window"));
    assert_eq!(int64_values(&batches[0], 0), vec![1, 2, 3]);
}

#[test]
fn applies_every_comparison_to_modern_temporal_types() {
    let source = write_temporal_filter_parquet();
    assert_temporal_comparisons(
        &source,
        &[
            (1, "1970-01-02"),
            (2, "1970-01-02T00:00:00.123"),
            (3, "1970-01-02T00:00:00.123456Z"),
            (4, "1970-01-02T00:00:00.123456789"),
            (5, "12:00:00"),
            (6, "1970-01-02T00:00:00.123Z"),
            (7, "1970-01-02T00:00:00.123456"),
            (8, "1970-01-02T00:00:00.123456789Z"),
        ],
    );
}

#[test]
fn applies_every_comparison_to_all_time_units_legacy_types_and_int96() {
    let source = write_raw_temporal_parquet();
    assert_temporal_comparisons(
        &source,
        &[
            (1, "12:00:00.123"),
            (2, "12:00:00.123+00:00"),
            (3, "12:00:00.123+00:00"),
            (4, "12:00:00.123456"),
            (5, "12:00:00.123456+00:00"),
            (6, "12:00:00.123456789"),
            (7, "12:00:00.123456789+00:00"),
            (8, "12:00:00.123456+00:00"),
            (9, "1970-01-02T00:00:00.123Z"),
            (10, "1970-01-02T00:00:00.123456Z"),
            (11, "1970-01-02T00:00:00.123456789"),
        ],
    );
}

fn assert_temporal_comparisons(source: &NamedTempFile, cases: &[(u32, &str)]) {
    let operators = [
        (DataFilterOperator::GreaterThan, &[2][..]),
        (DataFilterOperator::GreaterThanOrEqual, &[1, 2][..]),
        (DataFilterOperator::LessThan, &[0][..]),
        (DataFilterOperator::LessThanOrEqual, &[0, 1][..]),
    ];
    let schema = inspect_local_source(source.path()).expect("temporal schema");

    for &(column_index, value) in cases {
        let column_name = &schema.schema[column_index as usize].name;
        for (operator, expected) in operators {
            let view = prepare_view(
                source.path(),
                &[filter(column_name, operator, &[value])],
                &[],
            )
            .unwrap_or_else(|error| {
                panic!("column {column_index}, operator {operator:?}: {error:?}")
            });
            let batches = decode(view.fetch_window(0, 4).expect("filtered temporal window"));

            assert_eq!(
                int64_values(&batches[0], 0),
                expected,
                "column {column_index}, operator {operator:?}"
            );
        }
    }
}

#[test]
fn accepts_an_explicit_offset_for_a_utc_timestamp_filter() {
    let source = write_temporal_filter_parquet();
    let view = prepare_view(
        source.path(),
        &[filter(
            "micros_utc",
            DataFilterOperator::Equals,
            &["1970-01-02T03:00:00.123456+03:00"],
        )],
        &[],
    )
    .expect("UTC view with an explicit offset");
    let batches = decode(
        view.fetch_window(0, 4)
            .expect("UTC filter with an explicit offset"),
    );

    assert_eq!(int64_values(&batches[0], 0), vec![1]);
}

#[test]
fn accepts_a_timezone_free_value_for_a_utc_time_filter() {
    let source = write_raw_temporal_parquet();
    let view = prepare_view(
        source.path(),
        &[filter(
            "time_ms_utc",
            DataFilterOperator::Equals,
            &["12:00:00.123"],
        )],
        &[],
    )
    .expect("UTC time view without an offset");
    let batches = decode(
        view.fetch_window(0, 4)
            .expect("UTC time filter without an offset"),
    );

    assert_eq!(int64_values(&batches[0], 0), vec![1]);
}

#[test]
fn uses_a_timestamp_filter_boundary_beyond_the_column_storage_precision() {
    let source = write_temporal_filter_parquet();
    let view = prepare_view(
        source.path(),
        &[filter(
            "millis",
            DataFilterOperator::GreaterThanOrEqual,
            &["1970-01-02T00:00:00.1234"],
        )],
        &[],
    )
    .expect("millisecond view with extra precision");
    let batches = decode(
        view.fetch_window(0, 4)
            .expect("millisecond filter with extra precision"),
    );

    assert_eq!(int64_values(&batches[0], 0), vec![2]);
}

#[test]
fn returns_duckdb_temporal_types_used_by_cell_prefill() {
    let source = write_temporal_filter_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let batches = decode(reader.fetch(0, 1).expect("temporal window"));
    let schema = batches[0].schema();

    let types = schema
        .fields()
        .iter()
        .skip(2)
        .map(|field| field.data_type())
        .collect::<Vec<_>>();

    assert!(matches!(
        types[0],
        DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, None)
    ));
    assert!(matches!(
        types[1],
        DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, Some(_))
    ));
    assert!(matches!(
        types[2],
        DataType::Timestamp(arrow_schema::TimeUnit::Nanosecond, None)
    ));
    assert!(matches!(
        types[3],
        DataType::Time64(arrow_schema::TimeUnit::Microsecond)
    ));
    assert!(matches!(
        types[4],
        DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, Some(_))
    ));
    assert!(matches!(
        types[5],
        DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, None)
    ));
    assert!(matches!(
        types[6],
        DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, Some(_))
    ));
}

#[test]
fn returns_duckdb_types_for_all_time_units_legacy_types_and_int96() {
    let source = write_raw_temporal_parquet();
    let mut reader = DataWindowReader::new(source.path().to_owned());
    let batches = decode(reader.fetch(0, 3).expect("raw temporal window"));
    let schema = batches[0].schema();

    let types = schema
        .fields()
        .iter()
        .skip(1)
        .map(|field| field.data_type().clone())
        .collect::<Vec<_>>();

    assert_eq!(
        types,
        vec![
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Time64(arrow_schema::TimeUnit::Microsecond),
            DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, None),
            DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, None),
            DataType::Timestamp(arrow_schema::TimeUnit::Microsecond, None),
        ]
    );
}

#[test]
fn combines_conditions_and_offsets_the_filtered_view() {
    let source = write_basic_parquet();
    let filters = vec![
        filter("id\"quoted", DataFilterOperator::Range, &["11", "17"]),
        filter(
            "select",
            DataFilterOperator::OneOf,
            &["row-2", "row-4", "row-6"],
        ),
    ];
    let view = prepare_view(source.path(), &filters, &[]).expect("filtered view");

    let batches = decode(view.fetch_window(1, 2).expect("filtered offset window"));

    assert_eq!(int64_values(&batches[0], 0), vec![14, 16]);
    assert_eq!(view.row_count(), 3);
}

#[test]
fn returns_a_schema_only_window_for_an_empty_filter_result() {
    let source = write_basic_parquet();
    let view = prepare_view(
        source.path(),
        &[filter("id\"quoted", DataFilterOperator::Equals, &["999"])],
        &[],
    )
    .expect("empty filtered view");
    let bytes = view.fetch_window(0, 4).expect("empty filtered window");
    let reader = StreamReader::try_new(Cursor::new(bytes), None).expect("Arrow IPC stream");

    assert_eq!(reader.schema().fields().len(), 5);
    assert_eq!(reader.count(), 0);
}

#[test]
fn rejects_an_operator_not_supported_by_the_column_type() {
    let source = write_basic_parquet();
    assert!(matches!(
        prepare_view(
            source.path(),
            &[filter(
                "id\"quoted",
                DataFilterOperator::TextContains,
                &["1"],
            )],
            &[],
        ),
        Err(DataViewError::Engine(DataWindowError::InvalidFilter))
    ));
}

#[test]
fn rejects_bound_values_that_cannot_convert_to_the_column_type() {
    let source = write_basic_parquet();
    assert!(matches!(
        prepare_view(
            source.path(),
            &[filter(
                "id\"quoted",
                DataFilterOperator::Equals,
                &["1 OR 1=1"],
            )],
            &[],
        ),
        Err(DataViewError::Engine(DataWindowError::InvalidFilter))
    ));
}

#[test]
fn sorts_large_mixed_type_sources_once_for_start_middle_and_end_windows() {
    let (source, rows) = write_sort_parquet();
    let view = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("number"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("single-column view");
    let mut expected = rows.clone();
    expected.sort_by(|left, right| {
        compare_optional(&left.number, &right.number).then(left.file_order.cmp(&right.file_order))
    });
    assert_sorted_windows(&view, &expected);

    let view = prepare_view(
        source.path(),
        &[],
        &[
            DataSort {
                field_path: path("label"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            },
            DataSort {
                field_path: path("recorded_at"),
                json_target: None,
                direction: DataSortDirection::Descending,
            },
        ],
    )
    .expect("two-column view");
    expected = rows;
    expected.sort_by(|left, right| {
        compare_optional(&left.label.as_deref(), &right.label.as_deref())
            .then(compare_optional_descending(
                &left.timestamp,
                &right.timestamp,
            ))
            .then(left.file_order.cmp(&right.file_order))
    });
    assert_sorted_windows(&view, &expected);
}

#[test]
fn reads_first_and_deep_sorted_windows_from_duckdb_nested_parquet() {
    let (_directory, source) = write_duckdb_nested_sort_parquet();
    let view = prepare_view(
        &source,
        &[],
        &[DataSort {
            field_path: path("int8_value"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("nested DuckDB view");
    let first = decode(view.fetch_window(0, 512).expect("first nested window"));
    let deep = decode(
        view.fetch_window(view.row_count() - 512, 512)
            .expect("deep nested window"),
    );
    let mut expected = (0_i64..10_000).collect::<Vec<_>>();
    expected.sort_by_key(|value| (value % 127, *value));

    assert_eq!(
        first
            .iter()
            .flat_map(|batch| int64_values(batch, 0))
            .collect::<Vec<_>>(),
        expected[..512]
    );
    assert_eq!(
        deep.iter()
            .flat_map(|batch| int64_values(batch, 0))
            .collect::<Vec<_>>(),
        expected[expected.len() - 512..]
    );
    assert_eq!(first[0].schema(), deep[0].schema());
    assert!(matches!(deep[0].column(2).data_type(), DataType::List(_)));
}

#[test]
fn combines_filter_sort_windows_and_exact_count_in_one_view() {
    let source = write_basic_parquet();
    let filters = [filter(
        "id\"quoted",
        DataFilterOperator::Range,
        &["11", "16"],
    )];
    let view = prepare_view(
        source.path(),
        &filters,
        &[DataSort {
            field_path: path("select"),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
    )
    .expect("filtered and sorted view");

    let window = decode(view.fetch_window(1, 3).expect("view window"));

    assert_eq!(view.row_count(), 6);
    assert_eq!(int64_values(&window[0], 0), vec![15, 14, 13]);
    let projected = decode(
        view.fetch_window_fields(1, 3, &[path("active")])
            .expect("window projected away from filter and sort columns"),
    );
    assert_eq!(projected[0].num_columns(), 1);
    assert_eq!(projected[0].schema().field(0).name(), "active");
    assert_eq!(
        projected[0]
            .column(0)
            .as_any()
            .downcast_ref::<BooleanArray>()
            .expect("active column")
            .iter()
            .collect::<Vec<_>>(),
        [Some(false), Some(true), Some(false)]
    );

    let filtered_file_order = prepare_view(source.path(), &filters, &[])
        .expect("filtered file-order view after clearing sort");
    assert_eq!(filtered_file_order.row_count(), 6);
    assert_eq!(
        int64_values(
            &decode(
                filtered_file_order
                    .fetch_window(0, 8)
                    .expect("file-order filtered window"),
            )[0],
            0,
        ),
        vec![11, 12, 13, 14, 15, 16]
    );
}

#[test]
fn keeps_nulls_last_in_both_directions_and_direct_windows_in_file_order() {
    let (source, rows) = write_sort_parquet();
    for direction in [DataSortDirection::Ascending, DataSortDirection::Descending] {
        let view = prepare_view(
            source.path(),
            &[],
            &[DataSort {
                field_path: path("number"),
                json_target: None,
                direction,
            }],
        )
        .expect("nullable number sort");
        let last = decode(view.fetch_window(10_015, 12).expect("last sorted window"));
        let positions = int64_values(&last[0], 0);
        assert!(
            positions
                .iter()
                .all(|position| rows[*position as usize].number.is_none())
        );
    }

    let mut direct = DataWindowReader::new(source.path().to_owned());
    let file_order = decode(direct.fetch(509, 7).expect("file-order window"));
    assert_eq!(
        int64_values(&file_order[0], 0),
        (509..516).collect::<Vec<_>>()
    );
}

#[test]
fn cancelled_replacement_does_not_damage_the_completed_view() {
    let (source, _) = write_sort_parquet();
    let completed = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("file_order"),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
    )
    .expect("completed view");
    let replacement = DataViewBuilder::new(
        source.path().to_owned(),
        &[],
        &[DataSort {
            field_path: path("file_order"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("replacement builder");
    replacement.interrupt_handle().interrupt();

    assert!(matches!(
        replacement.build(),
        Err(DataViewError::Engine(DataWindowError::Cancelled))
    ));
    let first = decode(completed.fetch_window(0, 3).expect("completed window"));
    assert_eq!(int64_values(&first[0], 0), vec![10_026, 10_025, 10_024]);
}

#[test]
fn rejects_duplicate_and_out_of_bounds_sort_columns() {
    let source = write_basic_parquet();
    assert!(matches!(
        prepare_view(
            source.path(),
            &[],
            &[
                DataSort {
                    field_path: path("id\"quoted"),
                    json_target: None,
                    direction: DataSortDirection::Ascending,
                },
                DataSort {
                    field_path: path("id\"quoted"),
                    json_target: None,
                    direction: DataSortDirection::Descending,
                },
            ],
        ),
        Err(DataViewError::Engine(DataWindowError::InvalidSort))
    ));
    assert!(matches!(
        prepare_view(
            source.path(),
            &[],
            &[DataSort {
                field_path: path("missing"),
                json_target: None,
                direction: DataSortDirection::Ascending,
            }],
        ),
        Err(DataViewError::Engine(DataWindowError::InvalidSort))
    ));
}

#[test]
fn uses_file_order_as_a_stable_tie_break_across_row_groups() {
    let source = write_multi_group_parquet();
    let view = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("group"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("multi-group view");

    let rows = decode(view.fetch_window(0, 12).expect("stable window"));

    assert_eq!(
        int64_values(&rows[0], 0),
        vec![0, 3, 6, 9, 1, 4, 7, 10, 2, 5, 8, 11]
    );
}

#[test]
fn orders_nan_after_finite_values_ascending_and_before_them_descending() {
    let source = write_float_parquet();
    let ascending = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("value"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("ascending float view");
    let descending = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("value"),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
    )
    .expect("descending float view");

    assert_eq!(
        int64_values(
            &decode(ascending.fetch_window(0, 8).expect("ascending"))[0],
            0
        ),
        vec![0, 1, 2, 3, 4]
    );
    assert_eq!(
        int64_values(
            &decode(descending.fetch_window(0, 8).expect("descending"))[0],
            0
        ),
        vec![3, 2, 1, 0, 4]
    );
}

#[test]
fn distinguishes_a_physical_file_row_number_column_from_the_virtual_position() {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(vec![Field::new(
        "file_row_number",
        DataType::Int64,
        false,
    )]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![Arc::new(Int64Array::from(vec![20, 10])) as ArrayRef],
    )
    .expect("record batch");
    write_batch(&source, schema, &batch);
    let view = prepare_view(
        source.path(),
        &[],
        &[DataSort {
            field_path: path("file_row_number"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("view with colliding physical name");

    assert_eq!(
        int64_values(&decode(view.fetch_window(0, 2).expect("window"))[0], 0),
        vec![10, 20]
    );
}

#[derive(Clone)]
struct SortRow {
    file_order: i64,
    number: Option<i32>,
    label: Option<String>,
    timestamp: Option<i64>,
}

fn assert_sorted_windows(view: &PreparedDataView, expected: &[SortRow]) {
    for (offset, count) in [(0, 9), (5_009, 11), (10_020, 12)] {
        let batches = decode(view.fetch_window(offset, count).expect("sorted window"));
        let actual = int64_values(&batches[0], 0);
        let expected = expected
            [offset as usize..usize::min(offset as usize + count as usize, expected.len())]
            .iter()
            .map(|row| row.file_order)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "window at offset {offset}");
    }
}

fn compare_optional<T: Ord>(left: &Option<T>, right: &Option<T>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn compare_optional_descending<T: Ord>(left: &Option<T>, right: &Option<T>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => right.cmp(left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn prepare_view(
    source: &std::path::Path,
    filters: &[DataFilter],
    sort: &[DataSort],
) -> Result<PreparedDataView, DataViewError> {
    DataViewBuilder::new(source.to_owned(), filters, sort)?.build()
}

fn filter(column_name: &str, operator: DataFilterOperator, values: &[&str]) -> DataFilter {
    DataFilter {
        field_path: path(column_name),
        json_target: None,
        operator,
        values: values.iter().map(|value| (*value).to_owned()).collect(),
        match_case: false,
    }
}

fn json_filter(
    json_path: JsonPath,
    value_type: JsonValueType,
    operator: DataFilterOperator,
    values: &[&str],
) -> DataFilter {
    DataFilter {
        field_path: path("payload"),
        json_target: Some(JsonFieldTarget {
            path: json_path,
            value_type,
        }),
        operator,
        values: values.iter().map(|value| (*value).to_owned()).collect(),
        match_case: false,
    }
}

fn text_filter(operator: DataFilterOperator, value: &str, match_case: bool) -> DataFilter {
    DataFilter {
        field_path: path("label"),
        json_target: None,
        operator,
        values: vec![value.to_owned()],
        match_case,
    }
}

fn path(name: &str) -> FieldPath {
    FieldPath::new(vec![name.to_owned()])
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

fn optional_int32_values(batch: &RecordBatch, column: usize) -> Vec<Option<i32>> {
    let values = batch
        .column(column)
        .as_any()
        .downcast_ref::<Int32Array>()
        .expect("int32 column");
    (0..values.len())
        .map(|index| (!values.is_null(index)).then(|| values.value(index)))
        .collect()
}

fn write_basic_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id\"quoted", DataType::Int64, false),
        Field::new("select", DataType::Utf8, true),
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

fn write_temporal_filter_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let millis = TimestampMillisecondArray::from(vec![0, 86_400_123, 172_800_123]);
    let micros = TimestampMicrosecondArray::from(vec![0, 86_400_123_456, 172_800_123_456])
        .with_timezone("UTC");
    let nanos = TimestampNanosecondArray::from(vec![0, 86_400_123_456_789, 172_800_123_456_789]);
    let time = Time64MicrosecondArray::from(vec![0, 43_200_000_000, 80_000_000_000]);
    let millis_utc =
        TimestampMillisecondArray::from(vec![0, 86_400_123, 172_800_123]).with_timezone("UTC");
    let micros_local = TimestampMicrosecondArray::from(vec![0, 86_400_123_456, 172_800_123_456]);
    let nanos_utc =
        TimestampNanosecondArray::from(vec![0, 86_400_123_456_789, 172_800_123_456_789])
            .with_timezone("UTC");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("day", DataType::Date32, false),
        Field::new("millis", millis.data_type().clone(), false),
        Field::new("micros_utc", micros.data_type().clone(), false),
        Field::new("nanos", nanos.data_type().clone(), false),
        Field::new("time", time.data_type().clone(), false),
        Field::new("millis_utc", millis_utc.data_type().clone(), false),
        Field::new("micros_local", micros_local.data_type().clone(), false),
        Field::new("nanos_utc", nanos_utc.data_type().clone(), false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from(vec![0, 1, 2])) as ArrayRef,
            Arc::new(Date32Array::from(vec![0, 1, 2])) as ArrayRef,
            Arc::new(millis) as ArrayRef,
            Arc::new(micros) as ArrayRef,
            Arc::new(nanos) as ArrayRef,
            Arc::new(time) as ArrayRef,
            Arc::new(millis_utc) as ArrayRef,
            Arc::new(micros_local) as ArrayRef,
            Arc::new(nanos_utc) as ArrayRef,
        ],
    )
    .expect("temporal record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_text_parquet(values: Vec<Option<String>>) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(vec![Field::new("label", DataType::Utf8, true)]));
    let strings = StringArray::from_iter(values.iter().map(|value| value.as_deref()));
    let batch = RecordBatch::try_new(Arc::clone(&schema), vec![Arc::new(strings) as ArrayRef])
        .expect("text record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_raw_temporal_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(
        parse_message_type(
            "message schema {
                required INT64 id;
                required INT32 time_ms_local (TIME(MILLIS,false));
                required INT32 time_ms_utc (TIME(MILLIS,true));
                required INT32 legacy_time_ms (TIME_MILLIS);
                required INT64 time_us_local (TIME(MICROS,false));
                required INT64 time_us_utc (TIME(MICROS,true));
                required INT64 time_ns_local (TIME(NANOS,false));
                required INT64 time_ns_utc (TIME(NANOS,true));
                required INT64 legacy_time_us (TIME_MICROS);
                required INT64 legacy_ts_ms (TIMESTAMP_MILLIS);
                required INT64 legacy_ts_us (TIMESTAMP_MICROS);
                required INT96 int96_ts;
            }",
        )
        .expect("raw temporal schema"),
    );
    let file = source.reopen().expect("temporary source is reopenable");
    let mut writer =
        SerializedFileWriter::new(file, schema, Default::default()).expect("raw Parquet writer");
    let mut row_group = writer.next_row_group().expect("raw temporal row group");

    let mut column = row_group
        .next_column()
        .expect("id column")
        .expect("id writer");
    column
        .typed::<ParquetInt64Type>()
        .write_batch(&[0, 1, 2], None, None)
        .expect("id values");
    column.close().expect("id column");

    for values in [
        [0, 43_200_123, 80_000_123],
        [0, 43_200_123, 80_000_123],
        [0, 43_200_123, 80_000_123],
    ] {
        let mut column = row_group
            .next_column()
            .expect("millisecond time column")
            .expect("millisecond time writer");
        column
            .typed::<ParquetInt32Type>()
            .write_batch(&values, None, None)
            .expect("millisecond time values");
        column.close().expect("millisecond time column");
    }

    for values in [
        [0, 43_200_123_456, 80_000_123_456],
        [0, 43_200_123_456, 80_000_123_456],
        [0, 43_200_123_456_789, 80_000_123_456_789],
        [0, 43_200_123_456_789, 80_000_123_456_789],
        [0, 43_200_123_456, 80_000_123_456],
        [0, 86_400_123, 172_800_123],
        [0, 86_400_123_456, 172_800_123_456],
    ] {
        let mut column = row_group
            .next_column()
            .expect("microsecond, nanosecond, or timestamp column")
            .expect("i64 temporal writer");
        column
            .typed::<ParquetInt64Type>()
            .write_batch(&values, None, None)
            .expect("i64 temporal values");
        column.close().expect("i64 temporal column");
    }

    let int96_values = [
        int96(2_440_588, 0),
        int96(2_440_589, 123_456_789),
        int96(2_440_590, 123_456_789),
    ];
    let mut column = row_group
        .next_column()
        .expect("INT96 column")
        .expect("INT96 writer");
    column
        .typed::<ParquetInt96Type>()
        .write_batch(&int96_values, None, None)
        .expect("INT96 values");
    column.close().expect("INT96 column");

    assert!(
        row_group
            .next_column()
            .expect("end of raw temporal columns")
            .is_none()
    );
    row_group.close().expect("raw temporal row group");
    writer.close().expect("raw temporal Parquet footer");
    source
}

fn int96(julian_day: u32, nanoseconds: u64) -> Int96 {
    let mut value = Int96::new();
    value.set_data(
        nanoseconds as u32,
        (nanoseconds >> u32::BITS) as u32,
        julian_day,
    );
    value
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

fn write_addressable_nested_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let address_fields = Fields::from(vec![Field::new("postal.code", DataType::Int32, true)]);
    let address = StructArray::new(
        address_fields.clone(),
        vec![Arc::new(Int32Array::from(vec![
            Some(100),
            Some(200),
            None,
            Some(400),
        ])) as ArrayRef],
        None,
    );
    let profile_fields = Fields::from(vec![
        Field::new("city\"name", DataType::Utf8, false),
        Field::new("address", DataType::Struct(address_fields), true),
    ]);
    let mut profile_validity = NullBufferBuilder::new(4);
    for valid in [true, false, true, true] {
        profile_validity.append(valid);
    }
    let profile = StructArray::new(
        profile_fields.clone(),
        vec![
            Arc::new(StringArray::from(vec!["A", "masked", "C", "D"])) as ArrayRef,
            Arc::new(address) as ArrayRef,
        ],
        profile_validity.finish(),
    );
    let alternate_fields = Fields::from(vec![Field::new("city\"name", DataType::Utf8, false)]);
    let alternate = StructArray::new(
        alternate_fields.clone(),
        vec![Arc::new(StringArray::from(vec!["W", "X", "Y", "Z"])) as ArrayRef],
        None,
    );
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("profile.with.dot", DataType::Struct(profile_fields), true),
        Field::new("alternate", DataType::Struct(alternate_fields), false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])) as ArrayRef,
            Arc::new(profile) as ArrayRef,
            Arc::new(alternate) as ArrayRef,
        ],
    )
    .expect("addressable nested record batch");
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
        .typed::<ParquetInt64Type>()
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

fn write_json_path_parquet(values: &[String]) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary JSON source");
    let schema = Arc::new(
        parse_message_type(
            "message json_paths {
                REQUIRED INT64 id;
                REQUIRED BYTE_ARRAY payload (JSON);
            }",
        )
        .expect("JSON-path Parquet schema"),
    );
    let file = source
        .reopen()
        .expect("temporary JSON source is reopenable");
    let mut writer =
        SerializedFileWriter::new(file, schema, Default::default()).expect("Parquet writer");
    let mut row_group = writer.next_row_group().expect("Parquet row group");

    let mut column = row_group
        .next_column()
        .expect("id column")
        .expect("id column writer");
    let ids = (0..values.len())
        .map(|index| i64::try_from(index).expect("fixture row fits i64"))
        .collect::<Vec<_>>();
    column
        .typed::<ParquetInt64Type>()
        .write_batch(&ids, None, None)
        .expect("id values");
    column.close().expect("id column footer");

    let mut column = row_group
        .next_column()
        .expect("JSON column")
        .expect("JSON column writer");
    let values = values
        .iter()
        .map(|value| ByteArray::from(value.as_str()))
        .collect::<Vec<_>>();
    column
        .typed::<ByteArrayType>()
        .write_batch(&values, None, None)
        .expect("JSON values");
    column.close().expect("JSON column footer");

    assert!(
        row_group
            .next_column()
            .expect("end of JSON-path columns")
            .is_none()
    );
    row_group.close().expect("Parquet row group footer");
    writer.close().expect("Parquet footer");
    source
}

fn write_nullable_json_path_parquet(values: &[Option<&str>]) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary nullable JSON source");
    let schema = Arc::new(
        parse_message_type(
            "message json_paths {
                REQUIRED INT64 id;
                OPTIONAL BYTE_ARRAY payload (JSON);
            }",
        )
        .expect("nullable JSON-path Parquet schema"),
    );
    let file = source
        .reopen()
        .expect("temporary nullable JSON source is reopenable");
    let mut writer =
        SerializedFileWriter::new(file, schema, Default::default()).expect("Parquet writer");
    let mut row_group = writer.next_row_group().expect("Parquet row group");

    let mut column = row_group
        .next_column()
        .expect("id column")
        .expect("id column writer");
    let ids = (0..values.len())
        .map(|index| i64::try_from(index).expect("fixture row fits i64"))
        .collect::<Vec<_>>();
    column
        .typed::<ParquetInt64Type>()
        .write_batch(&ids, None, None)
        .expect("id values");
    column.close().expect("id column footer");

    let mut column = row_group
        .next_column()
        .expect("JSON column")
        .expect("JSON column writer");
    let definition_levels = values
        .iter()
        .map(|value| i16::from(value.is_some()))
        .collect::<Vec<_>>();
    let present_values = values
        .iter()
        .filter_map(|value| value.map(ByteArray::from))
        .collect::<Vec<_>>();
    column
        .typed::<ByteArrayType>()
        .write_batch(&present_values, Some(&definition_levels), None)
        .expect("nullable JSON values");
    column.close().expect("JSON column footer");
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

fn write_deep_and_wide_struct_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary nested-shape source");

    let mut deep: ArrayRef = Arc::new(Int64Array::from(vec![7, 9]));
    let mut child_name = "value".to_owned();
    for level in (1..=6).rev() {
        let fields = Fields::from(vec![Field::new(
            &child_name,
            deep.data_type().clone(),
            false,
        )]);
        deep = Arc::new(StructArray::new(fields, vec![deep], None));
        child_name = format!("level{level}");
    }
    let deep_fields = Fields::from(vec![Field::new(
        child_name,
        deep.data_type().clone(),
        false,
    )]);
    let deep = StructArray::new(deep_fields, vec![deep], None);

    let wide_fields = Fields::from(
        (0..100)
            .map(|index| Field::new(format!("field{index:03}"), DataType::Int32, false))
            .collect::<Vec<_>>(),
    );
    let wide_columns = (0..100)
        .map(|index| Arc::new(Int32Array::from(vec![index, 1_000 + index])) as ArrayRef)
        .collect::<Vec<_>>();
    let wide = StructArray::new(wide_fields, wide_columns, None);

    let schema = Arc::new(Schema::new(vec![
        Field::new("deep", deep.data_type().clone(), false),
        Field::new("wide", wide.data_type().clone(), false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![Arc::new(deep) as ArrayRef, Arc::new(wide) as ArrayRef],
    )
    .expect("deep and wide struct batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_duplicate_name_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary duplicate-name source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("duplicate", DataType::Int32, false),
        Field::new("duplicate", DataType::Int32, false),
        Field::new("payload", DataType::Int32, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int32Array::from(vec![11])) as ArrayRef,
            Arc::new(Int32Array::from(vec![22])) as ArrayRef,
            Arc::new(Int32Array::from(vec![33])) as ArrayRef,
        ],
    )
    .expect("duplicate-name record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_named_parquet(column_name: &str) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary file");
    let schema = Arc::new(Schema::new(vec![Field::new(
        column_name,
        DataType::Int32,
        false,
    )]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![Arc::new(Int32Array::from(vec![17])) as ArrayRef],
    )
    .expect("record batch");
    let mut writer = ArrowWriter::try_new(source.reopen().expect("source file"), schema, None)
        .expect("Parquet writer");
    writer.write(&batch).expect("write batch");
    writer.close().expect("write footer");
    source
}

fn write_file_row_number_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary file-row-number source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("file_row_number", DataType::Int64, false),
        Field::new("payload", DataType::Utf8, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from(vec![40, 41, 42])) as ArrayRef,
            Arc::new(StringArray::from(vec!["row-0", "row-1", "row-2"])) as ArrayRef,
        ],
    )
    .expect("file-row-number record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_sort_parquet() -> (NamedTempFile, Vec<SortRow>) {
    let source = NamedTempFile::new().expect("temporary source");
    let rows = (0..10_027)
        .map(|index| SortRow {
            file_order: index,
            number: (index % 17 != 0).then_some(((index * 29) % 23) as i32),
            label: (index % 19 != 0).then(|| format!("label-{:02}", (index * 31) % 13)),
            timestamp: (index % 23 != 0)
                .then_some(1_700_000_000_000_000 + ((index * 37) % 101) * 1_000_000),
        })
        .collect::<Vec<_>>();
    let schema = Arc::new(Schema::new(vec![
        Field::new("file_order", DataType::Int64, false),
        Field::new("number", DataType::Int32, true),
        Field::new("label", DataType::Utf8, true),
        Field::new(
            "recorded_at",
            DataType::Timestamp(TimeUnit::Microsecond, None),
            true,
        ),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|row| row.file_order),
            )) as ArrayRef,
            Arc::new(Int32Array::from(
                rows.iter().map(|row| row.number).collect::<Vec<_>>(),
            )) as ArrayRef,
            Arc::new(StringArray::from(
                rows.iter()
                    .map(|row| row.label.as_deref())
                    .collect::<Vec<_>>(),
            )) as ArrayRef,
            Arc::new(TimestampMicrosecondArray::from(
                rows.iter().map(|row| row.timestamp).collect::<Vec<_>>(),
            )) as ArrayRef,
        ],
    )
    .expect("mixed sort record batch");
    write_batch(&source, schema, &batch);
    (source, rows)
}

fn write_duckdb_nested_sort_parquet() -> (TempDir, std::path::PathBuf) {
    let directory = TempDir::new().expect("nested fixture directory");
    let path = directory.path().join("nested-sort.parquet");
    let escaped_path = path
        .to_str()
        .expect("nested fixture path")
        .replace('\'', "''");
    let connection = duckdb::Connection::open_in_memory().expect("DuckDB fixture connection");
    connection
        .execute_batch(&format!(
            "COPY (\
             SELECT value AS file_order, \
                    CAST(value % 127 AS TINYINT) AS int8_value, \
                    [CAST(value AS INTEGER), CAST(value + 1 AS INTEGER)] AS list_value \
             FROM range(10000) AS rows(value)) \
             TO '{escaped_path}' (FORMAT PARQUET, ROW_GROUP_SIZE 2048)"
        ))
        .expect("write nested DuckDB Parquet fixture");
    (directory, path)
}

fn write_multi_group_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("file_order", DataType::Int64, false),
        Field::new("group", DataType::Int32, false),
    ]));
    let file = source.reopen().expect("multi-group fixture file");
    let mut writer = ArrowWriter::try_new(file, Arc::clone(&schema), None).expect("Parquet writer");
    for start in [0_i64, 4, 8] {
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from_iter_values(start..start + 4)) as ArrayRef,
                Arc::new(Int32Array::from_iter_values(
                    (start..start + 4).map(|value| (value % 3) as i32),
                )) as ArrayRef,
            ],
        )
        .expect("row-group batch");
        writer.write(&batch).expect("write row group");
        writer.flush().expect("flush row group");
    }
    writer.close().expect("write footer");
    source
}

fn write_empty_projected_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary zero-row source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("file_order", DataType::Int64, false),
        Field::new("group", DataType::Int32, false),
    ]));
    let batch = RecordBatch::new_empty(Arc::clone(&schema));
    write_batch(&source, schema, &batch);
    source
}

fn write_float_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary source");
    let schema = Arc::new(Schema::new(vec![
        Field::new("file_order", DataType::Int64, false),
        Field::new("value", DataType::Float64, true),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from_iter_values(0..5)) as ArrayRef,
            Arc::new(Float64Array::from(vec![
                Some(f64::NEG_INFINITY),
                Some(-1.0),
                Some(f64::INFINITY),
                Some(f64::NAN),
                None,
            ])) as ArrayRef,
        ],
    )
    .expect("float record batch");
    write_batch(&source, schema, &batch);
    source
}

fn write_batch(source: &NamedTempFile, schema: Arc<Schema>, batch: &RecordBatch) {
    let file = source.reopen().expect("temporary source is reopenable");
    let mut writer = ArrowWriter::try_new(file, schema, None).expect("Parquet writer");
    writer.write(batch).expect("Parquet batch");
    writer.close().expect("Parquet footer");
}
