use std::{
    fs::{self, FileTimes, OpenOptions},
    io::{Cursor, Seek, SeekFrom, Write},
    sync::Arc,
};

use arrow_array::{
    Array, ArrayRef, Float32Array, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray,
    StructArray,
};
use arrow_ipc::reader::StreamReader;
use arrow_schema::{Field, Schema};
use parquet::arrow::ArrowWriter;
use parquet::file::reader::{FileReader, SerializedFileReader};
use tempfile::TempDir;
use viewda_data_engine::{
    DataFilter, DataFilterOperator, DatasetError, DatasetSource, DatasetWindowReader,
};

#[test]
fn discovers_visible_parquet_members_in_lexicographic_order_and_counts_other_files() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("z/part.parquet"), "value", &[3]);
    write_ints(&directory.path().join("a/part.parquet"), "value", &[1]);
    fs::write(directory.path().join("_SUCCESS"), b"").expect("success marker");
    fs::write(directory.path().join("part.parquet.crc"), b"").expect("crc marker");
    fs::write(directory.path().join(".hidden.parquet"), b"not read").expect("hidden member");
    fs::create_dir_all(directory.path().join(".private")).expect("hidden directory");
    fs::write(directory.path().join(".private/part.parquet"), b"not read")
        .expect("member below hidden directory");
    #[cfg(unix)]
    std::os::unix::fs::symlink(directory.path(), directory.path().join("loop"))
        .expect("directory symlink");

    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let page = source.member_page(0, 16).expect("member page");

    assert_eq!(source.member_count(), 2);
    assert_eq!(source.ignored_file_count(), 4);
    assert_eq!(
        page.members
            .iter()
            .map(|member| member.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["a/part.parquet", "z/part.parquet"]
    );
}

#[test]
fn explicit_files_use_common_root_hive_paths_and_lexicographic_order() {
    let directory = TempDir::new().expect("dataset directory");
    let later = directory.path().join("year=2026/part.parquet");
    let earlier = directory.path().join("year=2025/part.parquet");
    write_ints(&later, "value", &[20]);
    write_ints(&earlier, "value", &[10]);

    let source = DatasetSource::open_files(&[later, earlier]).expect("explicit dataset");
    let page = source.member_page(0, 8).expect("member page");

    assert_eq!(
        source.display_name(),
        format!(
            "{}/",
            directory
                .path()
                .file_name()
                .expect("temporary folder name")
                .to_string_lossy()
        )
    );
    assert_eq!(source.ignored_file_count(), 0);
    assert_eq!(
        page.members
            .iter()
            .map(|member| member.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["year=2025/part.parquet", "year=2026/part.parquet"]
    );
    assert_eq!(
        page.members
            .iter()
            .map(|member| member.partitions.as_slice())
            .collect::<Vec<_>>(),
        [
            &[viewda_data_engine::PartitionValue {
                key: "year".to_owned(),
                value: "2025".to_owned(),
            }][..],
            &[viewda_data_engine::PartitionValue {
                key: "year".to_owned(),
                value: "2026".to_owned(),
            }][..],
        ]
    );
    let mut reader = complete_reader(source);
    let batch = decode_one(&reader.fetch(0, 8, &[]).expect("explicit window"));
    assert_eq!(int64_values(&batch, 0), [10, 20]);
    assert_eq!(
        string_values(&batch, 2),
        [
            Some("year=2025/part.parquet"),
            Some("year=2026/part.parquet"),
        ]
    );
}

#[test]
fn explicit_files_preserve_constant_trailing_hive_partitions() {
    let directory = TempDir::new().expect("dataset directory");
    let trips = directory.path().join("trips");
    let first = trips.join("year=2026/month=07/a.parquet");
    let second = trips.join("year=2026/month=07/b.parquet");
    write_ints(&first, "value", &[10]);
    write_ints(&second, "value", &[20]);

    let source = DatasetSource::open_files(&[second, first]).expect("explicit dataset");
    let page = source.member_page(0, 8).expect("member page");

    assert_eq!(source.display_name(), "trips/");
    assert_eq!(
        page.members
            .iter()
            .map(|member| member.relative_path.as_str())
            .collect::<Vec<_>>(),
        [
            "year=2026/month=07/a.parquet",
            "year=2026/month=07/b.parquet",
        ]
    );
    for member in &page.members {
        assert_eq!(
            member
                .partitions
                .iter()
                .map(|partition| (partition.key.as_str(), partition.value.as_str()))
                .collect::<Vec<_>>(),
            [("year", "2026"), ("month", "07")]
        );
    }

    let mut reader = complete_reader(source);
    let batch = decode_one(&reader.fetch(0, 8, &[]).expect("explicit window"));
    assert_eq!(int64_values(&batch, 0), [10, 20]);
    assert_eq!(string_values(&batch, 1), [Some("2026"), Some("2026")]);
    assert_eq!(string_values(&batch, 2), [Some("07"), Some("07")]);
    assert_eq!(
        string_values(&batch, 3),
        [
            Some("year=2026/month=07/a.parquet"),
            Some("year=2026/month=07/b.parquet"),
        ]
    );
}

#[test]
fn explicit_file_validation_is_eager_but_footer_reads_remain_lazy() {
    let directory = TempDir::new().expect("dataset directory");
    let damaged = directory.path().join("damaged.parquet");
    let uppercase = directory.path().join("ignored.PARQUET");
    fs::write(&damaged, b"not parquet").expect("damaged member");
    fs::write(&uppercase, b"not parquet").expect("uppercase extension");

    assert!(matches!(
        DatasetSource::open_files(&[]),
        Err(DatasetError::NoParquetFiles)
    ));
    assert!(matches!(
        DatasetSource::open_files(&[damaged.clone(), uppercase]),
        Err(DatasetError::Unsupported)
    ));
    let source =
        DatasetSource::open_files(std::slice::from_ref(&damaged)).expect("lazy explicit source");
    assert_eq!(source.member_count(), 1);
    assert_eq!(
        source.inspector().advance(1),
        Err(DatasetError::InvalidMember {
            member: "damaged.parquet".to_owned(),
        })
    );

    let directory_member = directory.path().join("folder.parquet");
    fs::create_dir(&directory_member).expect("directory member");
    assert!(matches!(
        DatasetSource::open_files(&[directory_member]),
        Err(DatasetError::Unsupported)
    ));
}

#[cfg(unix)]
#[test]
fn explicit_files_reject_two_aliases_of_the_same_canonical_member() {
    let directory = TempDir::new().expect("dataset directory");
    let member = directory.path().join("part.parquet");
    let alias = directory.path().join("alias.parquet");
    write_ints(&member, "value", &[1]);
    std::os::unix::fs::symlink(&member, &alias).expect("member alias");

    assert!(matches!(
        DatasetSource::open_files(&[member, alias]),
        Err(DatasetError::Unsupported)
    ));
}

#[cfg(unix)]
#[test]
fn explicit_file_aliases_preserve_logical_hive_paths_and_root() {
    let directory = TempDir::new().expect("dataset directory");
    let physical = directory.path().join("physical");
    let logical = directory.path().join("logical");
    let earlier_target = physical.join("earlier.parquet");
    let later_target = physical.join("later.parquet");
    let earlier_alias = logical.join("year=2025/part.parquet");
    let later_alias = logical.join("year=2026/part.parquet");
    write_ints(&earlier_target, "value", &[10]);
    write_ints(&later_target, "value", &[20]);
    fs::create_dir_all(earlier_alias.parent().expect("earlier alias parent"))
        .expect("earlier alias parent");
    fs::create_dir_all(later_alias.parent().expect("later alias parent"))
        .expect("later alias parent");
    std::os::unix::fs::symlink(&earlier_target, &earlier_alias).expect("earlier alias");
    std::os::unix::fs::symlink(&later_target, &later_alias).expect("later alias");

    let source = DatasetSource::open_files(&[later_alias, earlier_alias]).expect("alias dataset");
    let page = source.member_page(0, 8).expect("member page");

    assert_eq!(source.display_name(), "logical/");
    assert_eq!(
        page.members
            .iter()
            .map(|member| member.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["year=2025/part.parquet", "year=2026/part.parquet"]
    );
    assert_eq!(page.members[0].partitions[0].value, "2025");
    assert_eq!(page.members[1].partitions[0].value, "2026");

    let mut reader = complete_reader(source);
    let batch = decode_one(&reader.fetch(0, 8, &[]).expect("alias window"));
    assert_eq!(int64_values(&batch, 0), [10, 20]);
    assert_eq!(
        string_values(&batch, 2),
        [
            Some("year=2025/part.parquet"),
            Some("year=2026/part.parquet"),
        ]
    );
}

#[cfg(target_os = "linux")]
#[test]
fn non_utf8_member_paths_are_rejected_before_footer_inspection() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt as _};

    let explicit_directory = TempDir::new().expect("explicit directory");
    let explicit_member = explicit_directory
        .path()
        .join(OsString::from_vec(b"bad-\xff.parquet".to_vec()));
    fs::write(&explicit_member, b"not parquet").expect("non-UTF-8 explicit member");
    assert!(matches!(
        DatasetSource::open_files(&[explicit_member]),
        Err(DatasetError::Unsupported)
    ));

    let folder = TempDir::new().expect("folder directory");
    let folder_member_directory = folder.path().join(OsString::from_vec(b"bad-\xff".to_vec()));
    fs::create_dir(&folder_member_directory).expect("non-UTF-8 member directory");
    write_ints(&folder_member_directory.join("part.parquet"), "value", &[1]);
    assert!(matches!(
        DatasetSource::open_folder(folder.path()),
        Err(DatasetError::Unsupported)
    ));
}

#[cfg(unix)]
#[test]
fn folder_discovery_counts_non_utf8_files_that_are_not_visible_members() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt as _};

    let folder = TempDir::new().expect("folder directory");
    write_ints(&folder.path().join("part.parquet"), "value", &[1]);
    fs::write(
        folder
            .path()
            .join(OsString::from_vec(b"ignored-\xff.txt".to_vec())),
        b"ignored",
    )
    .expect("non-UTF-8 unrelated file");
    fs::write(
        folder
            .path()
            .join(OsString::from_vec(b".hidden-\xff.parquet".to_vec())),
        b"ignored",
    )
    .expect("non-UTF-8 hidden file");
    let unrelated_directory = folder
        .path()
        .join(OsString::from_vec(b"directory-\xff".to_vec()));
    fs::create_dir(&unrelated_directory).expect("non-UTF-8 directory");
    fs::write(unrelated_directory.join("ignored.txt"), b"ignored")
        .expect("file below non-UTF-8 directory");

    let source = DatasetSource::open_folder(folder.path()).expect("folder dataset");

    assert_eq!(source.member_count(), 1);
    assert_eq!(source.ignored_file_count(), 3);
    assert_eq!(
        source.member_page(0, 8).expect("member page").members[0].relative_path,
        "part.parquet"
    );
}

#[test]
fn rejects_empty_folders_and_bounds_member_pages() {
    let directory = TempDir::new().expect("dataset directory");
    fs::write(directory.path().join("_SUCCESS"), b"").expect("success marker");

    assert!(matches!(
        DatasetSource::open_folder(directory.path()),
        Err(DatasetError::NoParquetFiles)
    ));

    write_ints(&directory.path().join("part.parquet"), "value", &[1]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    assert_eq!(
        source.member_page(0, 257),
        Err(DatasetError::MemberPageTooLarge)
    );
}

#[test]
fn discovers_a_thousand_members_without_reading_their_footers() {
    let directory = TempDir::new().expect("dataset directory");
    for index in 0..1_000 {
        fs::write(
            directory.path().join(format!("part-{index:04}.parquet")),
            b"footer intentionally absent",
        )
        .expect("lazy member");
    }

    let source = DatasetSource::open_folder(directory.path()).expect("lazy discovery");

    assert_eq!(source.member_count(), 1_000);
    assert_eq!(
        source.member_page(998, 2).expect("last page").members.len(),
        2
    );
}

#[test]
fn inspection_is_incremental_cancellable_and_latches_member_read_failures() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "value", &[1]);
    fs::write(directory.path().join("b.parquet"), b"not parquet").expect("invalid member");
    let source = DatasetSource::open_folder(directory.path()).expect("lazy discovery");
    let mut preview_inspector = source.inspector();
    let preview = preview_inspector.preview(8).expect("first-member preview");
    assert!(!preview.progress.schema_complete);
    assert_eq!(int64_values(&decode_one(&preview.arrow_ipc), 0), [1]);
    let mut inspector = source.inspector();

    let first = inspector.advance(1).expect("first footer");
    assert_eq!(first.completed_member_count, 1);
    assert_eq!(first.total_member_count, 2);
    assert_eq!(first.row_count, 1);
    assert!(first.summary.is_none());
    assert!(!first.schema_complete);
    assert_eq!(
        first
            .schema
            .as_ref()
            .expect("changed schema")
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        ["value", "file"]
    );

    assert_eq!(
        inspector.advance(1),
        Err(DatasetError::InvalidMember {
            member: "b.parquet".to_owned(),
        })
    );
    write_ints(&directory.path().join("b.parquet"), "value", &[2]);
    assert_eq!(
        source.inspector().advance(1),
        Err(DatasetError::SourceChanged {
            member: "b.parquet".to_owned(),
        })
    );

    let reopened = DatasetSource::open_folder(directory.path()).expect("explicit reopen");
    let inspector = reopened.inspector();
    let interrupt = inspector.interrupt_handle();
    interrupt.interrupt();
    let mut inspector = inspector;
    assert_eq!(inspector.advance(1), Err(DatasetError::Cancelled));
}

#[test]
fn preview_stops_after_the_first_valid_member_even_when_it_is_empty() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[]);
    write_ints(&directory.path().join("year=2026/b.parquet"), "id", &[20]);
    fs::create_dir_all(directory.path().join("year=2027")).expect("later partition directory");
    fs::write(directory.path().join("year=2027/c.parquet"), b"not parquet")
        .expect("unopened later member");
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    let mut inspector = source.inspector();
    let preview = inspector.preview(8).expect("lazy preview");
    let mut batches =
        StreamReader::try_new(Cursor::new(&preview.arrow_ipc), None).expect("preview Arrow stream");

    assert_eq!(preview.progress.completed_member_count, 1);
    assert!(!preview.progress.schema_complete);
    assert_eq!(batches.schema().field(0).name(), "id");
    assert!(batches.next().is_none());
    assert_eq!(
        inspector
            .advance(1)
            .expect("second footer")
            .completed_member_count,
        2
    );
}

#[test]
fn one_member_preview_reports_completed_inspection() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("part.parquet"), "id", &[1]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();

    let preview = inspector.preview(1).expect("one-member preview");

    assert!(preview.progress.schema_complete);
    assert!(preview.progress.schema.is_none());
    assert!(preview.progress.summary.is_some());
}

#[test]
fn zero_candidate_filters_return_schema_only_ipc_without_a_query_member() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("year=2025/a.parquet"), "id", &[10]);
    write_ints(&directory.path().join("year=2026/b.parquet"), "id", &[20]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");
    let cases = [
        vec![filter(year, DataFilterOperator::Equals, &["never"])],
        vec![filter(year, DataFilterOperator::OneOf, &["2023", "2024"])],
        vec![filter(file, DataFilterOperator::IsNull, &[])],
        vec![
            filter(year, DataFilterOperator::IsNull, &[]),
            filter(file, DataFilterOperator::IsNotNull, &[]),
        ],
        vec![
            filter(year, DataFilterOperator::IsNotNull, &[]),
            filter(file, DataFilterOperator::Equals, &["missing.parquet"]),
        ],
    ];

    for filters in cases {
        let window = reader.fetch(0, 8, &filters).expect("empty filtered window");
        let mut batches =
            StreamReader::try_new(Cursor::new(&window), None).expect("schema-only Arrow stream");
        assert_eq!(
            batches
                .schema()
                .fields()
                .iter()
                .map(|field| field.name().as_str())
                .collect::<Vec<_>>(),
            ["id", "year", "file"]
        );
        assert!(batches.next().is_none());
    }
}

#[test]
fn treats_glob_metacharacters_quotes_and_unicode_as_exact_member_paths() {
    let directory = TempDir::new().expect("dataset directory");
    let mut names = vec![
        "br[ack].parquet",
        "quote'one.parquet",
        "right].parquet",
        "данные.parquet",
    ];
    #[cfg(unix)]
    names.extend([
        "double\"quote.parquet",
        "question?.parquet",
        "star*.parquet",
    ]);
    for (index, name) in names.iter().enumerate() {
        write_ints(&directory.path().join(name), "id", &[index as i64]);
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);

    let batch = decode_one(&reader.fetch(0, 16, &[]).expect("exact paths"));
    let expected = {
        let mut expected = names.clone();
        expected.sort();
        expected
    };

    assert_eq!(
        string_values(&batch, 1),
        expected.into_iter().map(Some).collect::<Vec<_>>()
    );
    assert_eq!(batch.num_rows(), names.len());
}

#[test]
fn root_member_preview_exposes_a_later_partition_key_as_null() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[10]);
    fs::create_dir_all(directory.path().join("year=2026")).expect("partition directory");
    fs::write(directory.path().join("year=2026/b.parquet"), b"not parquet")
        .expect("unopened later member");
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    let mut inspector = source.inspector();
    let preview = inspector.preview(8).expect("root preview");
    let batch = decode_one(&preview.arrow_ipc);

    assert_eq!(preview.progress.completed_member_count, 1);
    assert!(!preview.progress.schema_complete);
    assert_eq!(string_values(&batch, 1), [None]);
}

#[test]
fn unions_schema_by_name_fills_missing_values_and_exposes_relative_provenance() {
    let directory = TempDir::new().expect("dataset directory");
    write_columns(
        &directory
            .path()
            .join("year=2025/month=12/part-00000.parquet"),
        vec![
            ("id", Arc::new(Int64Array::from(vec![10, 11]))),
            (
                "label",
                Arc::new(StringArray::from(vec![Some("old"), None])),
            ),
        ],
    );
    write_columns(
        &directory
            .path()
            .join("year=2026/month=07/part-00000.parquet"),
        vec![
            ("id", Arc::new(Int64Array::from(vec![20, 21]))),
            ("amount", Arc::new(Int32Array::from(vec![7, 8]))),
        ],
    );
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    let preview = inspector.preview(1).expect("narrow preview");
    assert_eq!(int64_values(&decode_one(&preview.arrow_ipc), 0), [10]);
    inspector.advance(1).expect("final footer");
    let mut reader = inspector.into_window_reader().expect("upgraded reader");

    assert_eq!(reader.summary().row_count, 4);
    assert_eq!(reader.summary().schema_drift_member_count, 1);
    assert_eq!(
        reader
            .summary()
            .schema
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        ["id", "label", "amount", "year", "month", "file"]
    );
    let window = reader.fetch(0, 16, &[]).expect("dataset window");
    let batch = decode_one(&window);

    assert_eq!(int64_values(&batch, 0), vec![10, 11, 20, 21]);
    assert_eq!(
        string_values(&batch, 1),
        vec![Some("old"), None, None, None]
    );
    assert_eq!(
        integer_optional_values(&batch, 2),
        vec![None, None, Some(7), Some(8)]
    );
    assert_eq!(
        string_values(&batch, 5),
        vec![
            Some("year=2025/month=12/part-00000.parquet"),
            Some("year=2025/month=12/part-00000.parquet"),
            Some("year=2026/month=07/part-00000.parquet"),
            Some("year=2026/month=07/part-00000.parquet"),
        ]
    );
    let file = column_index(&reader, "file");
    let first_only = decode_one(
        &reader
            .fetch(
                0,
                8,
                &[equals(file, "year=2025/month=12/part-00000.parquet")],
            )
            .expect("missing-column candidate"),
    );
    assert_eq!(integer_optional_values(&first_only, 2), [None, None]);
}

#[test]
fn partition_and_file_filters_prune_paths_before_the_query_boundary() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("year=2025/a.parquet"), "id", &[10]);
    write_ints(&directory.path().join("year=2026/b.parquet"), "id", &[20]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");

    let partition_window = reader
        .fetch(0, 8, &[equals(year, "2026")])
        .expect("partition window");
    assert_eq!(int64_values(&decode_one(&partition_window), 0), [20]);

    let file_window = reader
        .fetch(0, 8, &[equals(file, "year=2025/a.parquet")])
        .expect("provenance window");
    assert_eq!(int64_values(&decode_one(&file_window), 0), [10]);
}

#[test]
fn reports_the_column_and_relative_member_for_irreconcilable_types() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "mixed", &[1]);
    write_columns(
        &directory.path().join("b.parquet"),
        vec![("mixed", Arc::new(StringArray::from(vec!["one"])))],
    );
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    assert_eq!(
        source.inspector().advance(2),
        Err(DatasetError::SchemaConflict {
            column: "mixed".to_owned(),
            member: "b.parquet".to_owned(),
        })
    );
}

#[test]
fn unions_nested_fields_and_qualifies_nested_conflicts() {
    let union = TempDir::new().expect("nested union dataset");
    write_columns(
        &union.path().join("a.parquet"),
        vec![(
            "profile",
            Arc::new(StructArray::from(vec![(
                Arc::new(Field::new("city", arrow_schema::DataType::Utf8, true)),
                Arc::new(StringArray::from(vec!["Oslo"])) as ArrayRef,
            )])),
        )],
    );
    write_columns(
        &union.path().join("b.parquet"),
        vec![(
            "profile",
            Arc::new(StructArray::from(vec![
                (
                    Arc::new(Field::new("city", arrow_schema::DataType::Utf8, true)),
                    Arc::new(StringArray::from(vec!["Riga"])) as ArrayRef,
                ),
                (
                    Arc::new(Field::new("zip", arrow_schema::DataType::Int64, true)),
                    Arc::new(Int64Array::from(vec![100])) as ArrayRef,
                ),
            ])),
        )],
    );
    let source = DatasetSource::open_folder(union.path()).expect("nested dataset");
    let mut reader = complete_reader(source);
    let batch = decode_one(&reader.fetch(0, 8, &[]).expect("nested union"));
    let profile = batch
        .column(0)
        .as_any()
        .downcast_ref::<StructArray>()
        .expect("profile struct");
    assert_eq!(
        integer_optional_values(
            &RecordBatch::try_from_iter([("zip", profile.column(1).clone())]).expect("zip batch"),
            0,
        ),
        [None, Some(100)]
    );
    let file = column_index(&reader, "file");
    let first_only = decode_one(
        &reader
            .fetch(0, 8, &[equals(file, "a.parquet")])
            .expect("missing nested child candidate"),
    );
    let first_profile = first_only
        .column(0)
        .as_any()
        .downcast_ref::<StructArray>()
        .expect("profile struct");
    assert!(first_profile.column(1).is_null(0));

    let conflict = TempDir::new().expect("nested conflict dataset");
    write_columns(
        &conflict.path().join("a.parquet"),
        vec![(
            "profile",
            Arc::new(StructArray::from(vec![(
                Arc::new(Field::new("city", arrow_schema::DataType::Utf8, true)),
                Arc::new(StringArray::from(vec!["Oslo"])) as ArrayRef,
            )])),
        )],
    );
    write_columns(
        &conflict.path().join("b.parquet"),
        vec![(
            "profile",
            Arc::new(StructArray::from(vec![(
                Arc::new(Field::new("city", arrow_schema::DataType::Int64, true)),
                Arc::new(Int64Array::from(vec![1])) as ArrayRef,
            )])),
        )],
    );
    assert_eq!(
        DatasetSource::open_folder(conflict.path())
            .expect("nested conflict dataset")
            .inspector()
            .advance(2),
        Err(DatasetError::SchemaConflict {
            column: "profile.city".to_owned(),
            member: "b.parquet".to_owned(),
        })
    );
}

#[test]
fn widens_safe_numeric_drift_and_rejects_data_partition_and_provenance_collisions() {
    let numeric = TempDir::new().expect("numeric dataset");
    write_columns(
        &numeric.path().join("a.parquet"),
        vec![("value", Arc::new(Int32Array::from(vec![1])))],
    );
    write_columns(
        &numeric.path().join("b.parquet"),
        vec![("value", Arc::new(Int64Array::from(vec![2])))],
    );
    let numeric_source = DatasetSource::open_folder(numeric.path()).expect("numeric dataset");
    let summary = complete_summary(&numeric_source);
    assert_eq!(summary.schema[0].physical_type, "INT64");
    let mut numeric_reader = complete_reader(numeric_source);
    let numeric_file = column_index(&numeric_reader, "file");
    assert_eq!(
        decode_one(
            &numeric_reader
                .fetch(0, 8, &[equals(numeric_file, "a.parquet")])
                .expect("numeric subset window")
        )
        .schema()
        .field(0)
        .data_type(),
        &arrow_schema::DataType::Int64
    );

    let floating = TempDir::new().expect("floating dataset");
    write_columns(
        &floating.path().join("a.parquet"),
        vec![("value", Arc::new(Float32Array::from(vec![1.5])))],
    );
    write_columns(
        &floating.path().join("b.parquet"),
        vec![("value", Arc::new(Float64Array::from(vec![2.5])))],
    );
    let floating_source = DatasetSource::open_folder(floating.path()).expect("floating dataset");
    assert_eq!(
        complete_summary(&floating_source).schema[0].physical_type,
        "DOUBLE"
    );
    let mut floating_reader = complete_reader(floating_source);
    let floating_file = column_index(&floating_reader, "file");
    assert_eq!(
        decode_one(
            &floating_reader
                .fetch(0, 8, &[equals(floating_file, "a.parquet")])
                .expect("floating subset window")
        )
        .schema()
        .field(0)
        .data_type(),
        &arrow_schema::DataType::Float64
    );

    let lossy = TempDir::new().expect("lossy dataset");
    write_columns(
        &lossy.path().join("a.parquet"),
        vec![(
            "value",
            Arc::new(Int64Array::from(vec![9_007_199_254_740_993])),
        )],
    );
    write_columns(
        &lossy.path().join("b.parquet"),
        vec![("value", Arc::new(Float64Array::from(vec![1.0])))],
    );
    assert_eq!(
        DatasetSource::open_folder(lossy.path())
            .expect("lossy dataset")
            .inspector()
            .advance(2),
        Err(DatasetError::SchemaConflict {
            column: "value".to_owned(),
            member: "b.parquet".to_owned(),
        })
    );

    let partition = TempDir::new().expect("partition collision dataset");
    write_ints(
        &partition.path().join("year=2026/part.parquet"),
        "year",
        &[2025],
    );
    assert!(matches!(
        DatasetSource::open_folder(partition.path())
            .expect("partition dataset")
            .inspector()
            .advance(1),
        Err(DatasetError::SchemaConflict { column, member })
            if column == "year" && member == "year=2026/part.parquet"
    ));

    let provenance = TempDir::new().expect("provenance collision dataset");
    write_columns(
        &provenance.path().join("part.parquet"),
        vec![("file", Arc::new(StringArray::from(vec!["physical"])))],
    );
    assert!(matches!(
        DatasetSource::open_folder(provenance.path())
            .expect("provenance dataset")
            .inspector()
            .advance(1),
        Err(DatasetError::SchemaConflict { column, member })
            if column == "file" && member == "part.parquet"
    ));

    let provenance_partition = TempDir::new().expect("provenance partition collision dataset");
    write_ints(
        &provenance_partition
            .path()
            .join("FILE=archive/part.parquet"),
        "value",
        &[1],
    );
    assert!(matches!(
        DatasetSource::open_folder(provenance_partition.path())
            .expect("provenance partition dataset")
            .inspector()
            .advance(1),
        Err(DatasetError::SchemaConflict { column, member })
            if column == "file" && member == "FILE=archive/part.parquet"
    ));
}

#[test]
fn pages_the_members_that_deviate_from_the_first_schema() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[1]);
    write_columns(
        &directory.path().join("b.parquet"),
        vec![
            ("id", Arc::new(Int64Array::from(vec![2]))),
            ("extra", Arc::new(Int64Array::from(vec![3]))),
        ],
    );
    write_ints(&directory.path().join("c.parquet"), "id", &[4]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    let first_progress = inspector.advance(1).expect("first footer");
    let middle_progress = inspector.advance(1).expect("second footer");
    let final_progress = inspector.advance(1).expect("final footer");

    assert!(first_progress.schema.is_some());
    assert!(middle_progress.schema.is_none());
    assert!(middle_progress.summary.is_none());
    assert!(final_progress.schema_complete);
    assert!(final_progress.schema.is_none());
    assert!(final_progress.summary.is_some());
    let reader = inspector.into_window_reader().expect("completed reader");
    assert_eq!(
        reader.schema_drift_page(0, 16).expect("reader drift page"),
        viewda_data_engine::DatasetMemberPage {
            offset: 0,
            total: 1,
            members: vec![viewda_data_engine::DatasetMemberSummary {
                relative_path: "b.parquet".to_owned(),
                partitions: Vec::new(),
            }],
        }
    );
}

#[test]
fn rejects_case_insensitive_duplicate_member_columns_at_each_nesting_level() {
    let top = TempDir::new().expect("top-level duplicate dataset");
    write_columns(
        &top.path().join("part.parquet"),
        vec![
            ("id", Arc::new(Int64Array::from(vec![1]))),
            ("ID", Arc::new(Int64Array::from(vec![2]))),
        ],
    );
    assert_eq!(
        DatasetSource::open_folder(top.path())
            .expect("duplicate dataset")
            .inspector()
            .advance(1),
        Err(DatasetError::SchemaConflict {
            column: "ID".to_owned(),
            member: "part.parquet".to_owned(),
        })
    );

    let nested = TempDir::new().expect("nested duplicate dataset");
    write_columns(
        &nested.path().join("part.parquet"),
        vec![(
            "profile",
            Arc::new(StructArray::from(vec![
                (
                    Arc::new(Field::new("city", arrow_schema::DataType::Utf8, true)),
                    Arc::new(StringArray::from(vec!["Oslo"])) as ArrayRef,
                ),
                (
                    Arc::new(Field::new("CITY", arrow_schema::DataType::Utf8, true)),
                    Arc::new(StringArray::from(vec!["Riga"])) as ArrayRef,
                ),
            ])),
        )],
    );
    assert_eq!(
        DatasetSource::open_folder(nested.path())
            .expect("nested duplicate dataset")
            .inspector()
            .advance(1),
        Err(DatasetError::SchemaConflict {
            column: "profile.CITY".to_owned(),
            member: "part.parquet".to_owned(),
        })
    );
}

#[test]
fn conversion_to_reader_rechecks_the_completed_snapshot() {
    let deleted = TempDir::new().expect("deleted conversion dataset");
    let deleted_member = deleted.path().join("part.parquet");
    write_ints(&deleted_member, "id", &[1]);
    let source = DatasetSource::open_folder(deleted.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    inspector.advance(1).expect("completed footer");
    fs::remove_file(&deleted_member).expect("delete completed member");
    assert!(matches!(
        inspector.into_window_reader(),
        Err(DatasetError::SourceChanged { member }) if member == "part.parquet"
    ));

    #[cfg(unix)]
    {
        let replaced = TempDir::new().expect("replacement conversion dataset");
        let member = replaced.path().join("part.parquet");
        let replacement = replaced.path().join("replacement.parquet");
        write_ints(&member, "id", &[1]);
        let source = DatasetSource::open_folder(replaced.path()).expect("folder dataset");
        let mut inspector = source.inspector();
        inspector.advance(1).expect("completed footer");
        write_ints(&replacement, "id", &[2]);
        fs::rename(replacement, &member).expect("atomic replacement");
        assert!(matches!(
            inspector.into_window_reader(),
            Err(DatasetError::SourceChanged { member }) if member == "part.parquet"
        ));
    }
}

#[test]
fn damaged_data_pages_name_the_member_and_freeze_later_fetches() {
    let directory = TempDir::new().expect("damaged data dataset");
    let member = directory.path().join("part.parquet");
    write_ints(&member, "id", &[1, 2, 3]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);
    corrupt_first_column_data(&member);
    assert!(viewda_data_engine::inspect_local_source(&member).is_ok());

    assert_eq!(
        reader.fetch(0, 8, &[]),
        Err(DatasetError::InvalidMember {
            member: "part.parquet".to_owned(),
        })
    );
    assert_eq!(
        reader.fetch(0, 8, &[]),
        Err(DatasetError::SourceChanged {
            member: "part.parquet".to_owned(),
        })
    );
}

#[test]
fn preserves_physical_filename_and_file_row_number_columns() {
    let directory = TempDir::new().expect("dataset directory");
    write_columns(
        &directory.path().join("part.parquet"),
        vec![
            (
                "filename",
                Arc::new(StringArray::from(vec!["physical-name"])),
            ),
            ("file_row_number", Arc::new(Int64Array::from(vec![99]))),
        ],
    );
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);

    let batch = decode_one(&reader.fetch(0, 8, &[]).expect("window"));

    assert_eq!(string_values(&batch, 0), [Some("physical-name")]);
    assert_eq!(int64_values(&batch, 1), [99]);
    assert_eq!(string_values(&batch, 2), [Some("part.parquet")]);
}

#[test]
fn keeps_composition_fixed_and_latches_a_disappeared_member() {
    let directory = TempDir::new().expect("dataset directory");
    let first = directory.path().join("a.parquet");
    let second = directory.path().join("b.parquet");
    write_ints(&first, "id", &[1]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    write_ints(&second, "id", &[2]);
    assert_eq!(complete_summary(&source).member_count, 1);
    let mut reader = complete_reader(source.clone());
    assert_eq!(
        int64_values(&decode_one(&reader.fetch(0, 8, &[]).expect("window")), 0),
        [1]
    );

    fs::remove_file(&first).expect("remove fixed member");
    assert_eq!(
        reader.fetch(0, 8, &[]),
        Err(DatasetError::SourceChanged {
            member: "a.parquet".to_owned(),
        })
    );
    write_ints(&first, "id", &[1]);
    assert_eq!(
        reader.fetch(0, 8, &[]),
        Err(DatasetError::SourceChanged {
            member: "a.parquet".to_owned(),
        })
    );

    let reopened = DatasetSource::open_folder(directory.path()).expect("reload dataset");
    assert_eq!(reopened.member_count(), 2);
}

#[test]
fn deleting_a_pruned_member_freezes_the_whole_dataset() {
    let directory = TempDir::new().expect("dataset directory");
    let kept = directory.path().join("year=2025/a.parquet");
    let deleted = directory.path().join("year=2026/b.parquet");
    write_ints(&kept, "id", &[10]);
    write_ints(&deleted, "id", &[20]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);
    let year = column_index(&reader, "year");
    fs::remove_file(&deleted).expect("delete pruned member");

    assert_eq!(
        reader.fetch(0, 8, &[equals(year, "2025")]),
        Err(DatasetError::SourceChanged {
            member: "year=2026/b.parquet".to_owned(),
        })
    );
}

#[cfg(unix)]
#[test]
fn atomic_member_replacement_discards_the_window_and_latches_source_changed() {
    let directory = TempDir::new().expect("dataset directory");
    let member = directory.path().join("part.parquet");
    let replacement = directory.path().join("replacement.parquet");
    write_ints(&member, "id", &[10]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);
    write_ints(&replacement, "id", &[20]);
    fs::rename(&replacement, &member).expect("atomic replacement");

    assert_eq!(
        reader.fetch(0, 8, &[]),
        Err(DatasetError::SourceChanged {
            member: "part.parquet".to_owned(),
        })
    );
    assert_eq!(
        reader.fetch(0, 8, &[]),
        Err(DatasetError::SourceChanged {
            member: "part.parquet".to_owned(),
        })
    );
}

#[test]
fn windows_remain_stable_across_empty_members_and_offsets() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[10, 11]);
    write_ints(&directory.path().join("b.parquet"), "id", &[]);
    write_ints(&directory.path().join("c.parquet"), "id", &[20, 21]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);

    assert_eq!(
        int64_values(&decode_one(&reader.fetch(1, 2, &[]).expect("window")), 0),
        [11, 20]
    );
}

#[test]
fn fully_empty_dataset_returns_its_schema_and_no_batches() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[]);
    write_ints(&directory.path().join("b.parquet"), "id", &[]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);

    let window = reader.fetch(0, 8, &[]).expect("empty dataset window");
    let mut batches =
        StreamReader::try_new(Cursor::new(&window), None).expect("schema-only Arrow stream");

    assert_eq!(batches.schema().field(0).name(), "id");
    assert_eq!(batches.schema().field(1).name(), "file");
    assert!(batches.next().is_none());
}

fn equals(column_index: u32, value: &str) -> DataFilter {
    filter(column_index, DataFilterOperator::Equals, &[value])
}

fn filter(column_index: u32, operator: DataFilterOperator, values: &[&str]) -> DataFilter {
    DataFilter {
        column_index,
        operator,
        values: values.iter().map(|value| (*value).to_owned()).collect(),
        match_case: false,
    }
}

fn complete_reader(source: DatasetSource) -> DatasetWindowReader {
    let mut inspector = source.inspector();
    while inspector
        .advance(256)
        .expect("dataset inspection")
        .summary
        .is_none()
    {}
    inspector.into_window_reader().expect("dataset reader")
}

fn complete_summary(source: &DatasetSource) -> viewda_data_engine::DatasetSummary {
    let mut inspector = source.inspector();
    loop {
        if let Some(summary) = inspector.advance(256).expect("dataset inspection").summary {
            return summary;
        }
    }
}

fn column_index(reader: &DatasetWindowReader, name: &str) -> u32 {
    reader
        .summary()
        .schema
        .iter()
        .position(|field| field.name == name)
        .map(|index| index as u32)
        .expect("dataset column")
}

fn write_ints(path: &std::path::Path, name: &str, values: &[i64]) {
    write_columns(
        path,
        vec![(name, Arc::new(Int64Array::from(values.to_vec())))],
    );
}

fn write_columns(path: &std::path::Path, columns: Vec<(&str, ArrayRef)>) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture directory");
    let schema = Arc::new(Schema::new(
        columns
            .iter()
            .map(|(name, array)| Field::new(*name, array.data_type().clone(), true))
            .collect::<Vec<_>>(),
    ));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        columns.into_iter().map(|(_, array)| array).collect(),
    )
    .expect("fixture batch");
    let file = fs::File::create(path).expect("fixture file");
    let mut writer = ArrowWriter::try_new(file, schema, None).expect("fixture writer");
    writer.write(&batch).expect("fixture rows");
    writer.close().expect("fixture footer");
}

fn corrupt_first_column_data(path: &std::path::Path) {
    let metadata = fs::metadata(path).expect("member metadata");
    let modified = metadata.modified().expect("member modification time");
    let reader = SerializedFileReader::new(fs::File::open(path).expect("member file"))
        .expect("Parquet metadata");
    let column = reader.metadata().row_group(0).column(0);
    let start = column
        .dictionary_page_offset()
        .unwrap_or_else(|| column.data_page_offset());
    let length = usize::try_from(column.compressed_size()).expect("column chunk size");
    drop(reader);

    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .expect("writable member");
    file.seek(SeekFrom::Start(
        u64::try_from(start).expect("column chunk offset"),
    ))
    .expect("column chunk seek");
    file.write_all(&vec![0; length])
        .expect("overwrite column chunk");
    file.flush().expect("flush damaged data");
    file.set_times(FileTimes::new().set_modified(modified))
        .expect("restore member identity timestamp");
}

fn decode_one(bytes: &[u8]) -> RecordBatch {
    StreamReader::try_new(Cursor::new(bytes), None)
        .expect("Arrow stream")
        .next()
        .expect("one batch")
        .expect("valid batch")
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

fn integer_optional_values(batch: &RecordBatch, column: usize) -> Vec<Option<i64>> {
    if let Some(values) = batch.column(column).as_any().downcast_ref::<Int32Array>() {
        return (0..values.len())
            .map(|index| (!values.is_null(index)).then(|| i64::from(values.value(index))))
            .collect();
    }
    let values = batch
        .column(column)
        .as_any()
        .downcast_ref::<Int64Array>()
        .expect("integer column");
    (0..values.len())
        .map(|index| (!values.is_null(index)).then(|| values.value(index)))
        .collect()
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
