use std::{
    fs::{self, FileTimes, OpenOptions},
    io::{Cursor, Seek, SeekFrom, Write},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use arrow_array::{
    Array, ArrayRef, Date32Array, Decimal128Array, DictionaryArray, Float32Array, Float64Array,
    Int32Array, Int64Array, RecordBatch, StringArray, StructArray, TimestampNanosecondArray,
    builder::{Int32Builder, Int64Builder, ListBuilder, StructBuilder},
    types::Int32Type,
};
use arrow_ipc::reader::StreamReader;
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::ArrowWriter;
use parquet::file::reader::{FileReader, SerializedFileReader};
use tempfile::TempDir;
use viewda_data_engine::{
    ColumnStatisticsReader, CsvExportOptions, DataExportError, DataExportFormat, DataExportReader,
    DataExportRequest, DataFilter, DataFilterOperator, DataSort, DataSortDirection,
    DataViewBuilder, DataViewError, DataViewMemoryLimit, DataWindowError, DataWindowReader,
    DatasetError, DatasetPartitionNode, DatasetPartitionPage, DatasetSource, DatasetWindowReader,
    ExportRowRange, FieldPath, PartitionValue, StructureCancellation, StructureLoadProgress,
    StructureReader, TextValueSuggestionsReader,
};

#[test]
fn discovers_visible_parquet_members_in_lexicographic_order_and_counts_other_files() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("z/part.parquet"), "value", &[3]);
    write_ints(&directory.path().join("a/part.parquet"), "value", &[1]);
    write_ints(&directory.path().join("upper.PARQUET"), "value", &[2]);
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

    assert_eq!(source.member_count(), 3);
    assert_eq!(source.ignored_file_count(), 4);
    assert_eq!(
        page.members
            .iter()
            .map(|member| member.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["a/part.parquet", "upper.PARQUET", "z/part.parquet"]
    );
}

#[test]
fn opening_and_reading_sources_does_not_modify_source_mtimes() {
    let workspace = TempDir::new().expect("source workspace");
    let file_directory = workspace.path().join("file-source");
    let file_path = file_directory.join("single.parquet");
    let dataset_directory = workspace.path().join("dataset-source");
    let member_path = dataset_directory.join("part.parquet");
    write_ints(&file_path, "value", &[2, 1]);
    write_ints(&member_path, "value", &[4, 3]);
    let observed = [
        workspace.path(),
        file_directory.as_path(),
        file_path.as_path(),
        dataset_directory.as_path(),
        member_path.as_path(),
    ];
    let before = observed.map(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .expect("source modification time")
    });

    // Keep source writes distinguishable on filesystems with one-second mtime precision.
    thread::sleep(Duration::from_millis(1_100));

    let mut file = DataWindowReader::new(file_path.clone());
    file.fetch(0, 2).expect("direct file window");
    DataViewBuilder::new(
        file_path.clone(),
        &[],
        &[DataSort {
            field_path: FieldPath::from("value"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
    )
    .expect("file view builder")
    .build()
    .expect("file view")
    .fetch_window(0, 2)
    .expect("prepared file window");
    ColumnStatisticsReader::new(file_path.clone())
        .expect("file statistics reader")
        .fetch(&FieldPath::from("value"), true)
        .expect("file statistics");

    let source = DatasetSource::open_folder(&dataset_directory).expect("folder dataset");
    let mut dataset = complete_reader(source);
    dataset.fetch(0, 2).expect("direct dataset window");
    DataViewBuilder::for_dataset(
        &dataset,
        &[],
        &[DataSort {
            field_path: FieldPath::from("value"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("dataset view")
    .fetch_window(0, 2)
    .expect("prepared dataset window");
    ColumnStatisticsReader::for_dataset(&dataset)
        .expect("dataset statistics reader")
        .fetch(&FieldPath::from("value"), true)
        .expect("dataset statistics");

    let after = observed.map(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .expect("source modification time after reads")
    });
    assert_eq!(after, before);
}

#[cfg(unix)]
#[test]
fn counts_parquet_file_symlinks_as_ignored_without_following_them() {
    let directory = TempDir::new().expect("dataset directory");
    let member = directory.path().join("part.parquet");
    write_ints(&member, "value", &[1]);
    std::os::unix::fs::symlink(&member, directory.path().join("alias.parquet"))
        .expect("member symlink");

    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    assert_eq!(source.member_count(), 1);
    assert_eq!(source.ignored_file_count(), 1);
    assert_eq!(
        source.member_page(0, 8).expect("member page").members[0].relative_path,
        "part.parquet"
    );
}

#[test]
fn treats_empty_hive_keys_as_plain_directories_and_names_duplicate_keys() {
    let ordinary = TempDir::new().expect("ordinary directory dataset");
    write_ints(
        &ordinary.path().join("=archive/year=2026/part.parquet"),
        "value",
        &[1],
    );
    let source = DatasetSource::open_folder(ordinary.path()).expect("folder dataset");
    assert_eq!(
        source.member_page(0, 8).expect("member page").members[0].partitions,
        [PartitionValue {
            key: "year".to_owned(),
            value: "2026".to_owned(),
        }]
    );

    let duplicate = TempDir::new().expect("duplicate partition dataset");
    write_ints(
        &duplicate.path().join("year=2025/YEAR=2026/part.parquet"),
        "value",
        &[1],
    );
    assert!(matches!(
        DatasetSource::open_folder(duplicate.path()),
        Err(DatasetError::DuplicatePartitionKey { key, member })
            if key == "YEAR" && member == "year=2025/YEAR=2026/part.parquet"
    ));
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
    let batch = decode_one(&reader.fetch(0, 8).expect("explicit window"));
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
fn direct_dataset_windows_project_union_columns_in_requested_order() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "value", &[1]);
    write_ints(&directory.path().join("b.parquet"), "value", &[2]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    inspector.advance(8).expect("footer pass");
    let mut reader = inspector.into_window_reader().expect("dataset reader");
    let file_index = reader.summary().provenance_column_index;

    let batch = decode_one(
        &reader
            .fetch_fields(0, 8, &field_paths(&reader, &[file_index, 0]))
            .expect("projected window"),
    );

    assert_eq!(batch.schema().field(0).name(), "file");
    assert_eq!(batch.schema().field(1).name(), "value");
    assert_eq!(
        batch
            .column(0)
            .as_any()
            .downcast_ref::<StringArray>()
            .expect("file strings")
            .iter()
            .collect::<Vec<_>>(),
        [Some("a.parquet"), Some("b.parquet")]
    );
    assert_eq!(int64_values(&batch, 1), [1, 2]);
}

#[test]
fn wide_dataset_keeps_late_columns_for_windows_and_export() {
    let directory = TempDir::new().expect("dataset directory");
    let columns = (0..300)
        .map(|index| {
            (
                format!("column_{index}"),
                Arc::new(Int64Array::from(vec![index as i64])) as ArrayRef,
            )
        })
        .collect::<Vec<_>>();
    let named_columns = columns
        .iter()
        .map(|(name, values)| (name.as_str(), Arc::clone(values)))
        .collect();
    write_columns(&directory.path().join("wide.parquet"), named_columns);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    let preview = inspector.preview(1).expect("wide preview");
    let preview = decode_one(&preview.arrow_ipc);
    assert_eq!(preview.num_columns(), 256);
    let mut reader = inspector.into_window_reader().expect("dataset reader");

    assert_eq!(reader.summary().schema.len(), 301);
    let late_index = column_index(&reader, "column_299");
    let batch = decode_one(
        &reader
            .fetch_fields(0, 1, &field_paths(&reader, &[late_index]))
            .expect("late column window"),
    );
    assert_eq!(int64_values(&batch, 0), [299]);

    let target = directory.path().join("late.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![late_index], vec![]),
        None,
    )
    .expect("wide dataset export")
    .export()
    .expect("late column export");
    assert_eq!(
        fs::read_to_string(target).expect("exported CSV"),
        "column_299\r\n299\r\n"
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
    let batch = decode_one(&reader.fetch(0, 8).expect("explicit window"));
    assert_eq!(int64_values(&batch, 0), [10, 20]);
    assert_eq!(integer_optional_values(&batch, 1), [Some(2026), Some(2026)]);
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
    let uppercase = directory.path().join("member.PARQUET");
    fs::write(&damaged, b"not parquet").expect("damaged member");
    write_ints(&uppercase, "value", &[1]);

    assert!(matches!(
        DatasetSource::open_files(&[]),
        Err(DatasetError::NoParquetFiles)
    ));
    assert_eq!(
        DatasetSource::open_files(&[damaged.clone(), uppercase])
            .expect("uppercase extension")
            .member_count(),
        2
    );
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
    let batch = decode_one(&reader.fetch(0, 8).expect("alias window"));
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

#[cfg(target_os = "linux")]
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
    assert_eq!(source.member_page(0, 257), Err(DatasetError::PageTooLarge));
}

#[test]
fn pages_hive_partition_children_with_descendant_counts() {
    let directory = TempDir::new().expect("dataset directory");
    for path in [
        "Country=US/year=2025/a.parquet",
        "country=US/year=2026/b.parquet",
        "country=US/plain.parquet",
        "country=CA/year=2025/c.parquet",
        "region=EU/d.parquet",
        "unpartitioned.parquet",
    ] {
        let path = directory.path().join(path);
        fs::create_dir_all(path.parent().expect("member parent")).expect("member parent");
        fs::write(&path, b"footer intentionally absent")
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    let root: DatasetPartitionPage = source
        .partition_page(&[], None, 16)
        .expect("root partitions");
    assert_eq!(
        root.nodes
            .iter()
            .map(|node| {
                (
                    node.partition.key.to_ascii_lowercase(),
                    node.partition.value.as_str(),
                    node.member_count,
                )
            })
            .collect::<Vec<_>>(),
        [
            ("country".to_owned(), "CA", 1),
            ("country".to_owned(), "US", 3),
            ("region".to_owned(), "EU", 1),
        ]
    );
    assert_eq!(root.next_after, None);

    let parent = PartitionValue {
        key: "COUNTRY".to_owned(),
        value: "US".to_owned(),
    };
    let children = source
        .partition_page(std::slice::from_ref(&parent), None, 16)
        .expect("country children");
    assert_eq!(
        children.nodes,
        [
            DatasetPartitionNode {
                partition: PartitionValue {
                    key: "year".to_owned(),
                    value: "2025".to_owned(),
                },
                member_count: 1,
            },
            DatasetPartitionNode {
                partition: PartitionValue {
                    key: "year".to_owned(),
                    value: "2026".to_owned(),
                },
                member_count: 1,
            },
        ]
    );
}

#[test]
fn partition_cursors_continue_without_duplicates() {
    let directory = TempDir::new().expect("dataset directory");
    for value in ["d", "a", "c", "b"] {
        let path = directory.path().join(format!("key={value}/part.parquet"));
        fs::create_dir_all(path.parent().expect("partition parent")).expect("partition parent");
        fs::write(path, b"footer intentionally absent").expect("lazy member");
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    let first = source
        .partition_page(&[], None, 2)
        .expect("first partition page");
    assert_eq!(
        first
            .nodes
            .iter()
            .map(|node| node.partition.value.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    let cursor = first.next_after.as_ref().expect("continuation cursor");
    assert_eq!(cursor.value, "b");

    let second = source
        .partition_page(&[], Some(cursor), 2)
        .expect("second partition page");
    assert_eq!(
        second
            .nodes
            .iter()
            .map(|node| node.partition.value.as_str())
            .collect::<Vec<_>>(),
        ["c", "d"]
    );
    assert_eq!(second.next_after, None);
}

#[test]
fn partition_pages_keep_exact_counts_after_bounded_map_eviction() {
    let directory = TempDir::new().expect("dataset directory");
    for path in [
        "Yield=y/part.parquet",
        "Zulu=z/part.parquet",
        "alpha=a/one.parquet",
        "alpha=a/two.parquet",
        "alpha=a/three.parquet",
    ] {
        let path = directory.path().join(path);
        fs::create_dir_all(path.parent().expect("partition parent")).expect("partition parent");
        fs::write(path, b"footer intentionally absent").expect("lazy member");
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    let page = source
        .partition_page(&[], None, 1)
        .expect("bounded partition page");

    assert_eq!(page.nodes.len(), 1);
    assert_eq!(page.nodes[0].partition.key, "alpha");
    assert_eq!(page.nodes[0].member_count, 3);
    assert_eq!(page.next_after, Some(page.nodes[0].partition.clone()));
}

#[test]
fn bounds_partition_pages_and_large_partition_sets() {
    let directory = TempDir::new().expect("dataset directory");
    for index in 0..1_000 {
        let path = directory
            .path()
            .join(format!("bucket={index:04}/part.parquet"));
        fs::create_dir_all(path.parent().expect("partition parent")).expect("partition parent");
        fs::write(path, b"footer intentionally absent").expect("lazy member");
    }
    for name in ["another.parquet", "third.parquet"] {
        fs::write(
            directory.path().join("bucket=0000").join(name),
            b"footer intentionally absent",
        )
        .expect("repeated partition member");
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");

    assert_eq!(
        source.partition_page(&[], None, 257),
        Err(DatasetError::PageTooLarge)
    );
    assert_eq!(
        source.partition_page(
            &vec![
                PartitionValue {
                    key: "key".to_owned(),
                    value: "value".to_owned(),
                };
                257
            ],
            None,
            1
        ),
        Err(DatasetError::PageTooLarge)
    );
    assert_eq!(
        source.partition_page(&[], None, 0),
        Ok(DatasetPartitionPage {
            nodes: Vec::new(),
            next_after: None,
        })
    );

    let page = source
        .partition_page(&[], None, 8)
        .expect("bounded partition page");
    assert_eq!(page.nodes.len(), 8);
    assert_eq!(page.nodes[0].partition.value, "0000");
    assert_eq!(page.nodes[0].member_count, 3);
    assert_eq!(page.nodes[7].partition.value, "0007");
    assert_eq!(
        page.next_after.as_ref().map(|cursor| cursor.value.as_str()),
        Some("0007")
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
fn folder_discovery_consumes_only_the_requested_entry_budget() {
    let directory = TempDir::new().expect("dataset directory");
    for index in 0..40 {
        fs::write(
            directory.path().join(format!("part-{index:02}.parquet")),
            b"footer intentionally absent",
        )
        .expect("lazy member");
    }

    let mut discovery = DatasetSource::begin_folder(directory.path()).expect("begin discovery");
    assert_eq!(
        discovery.progress().expect("initial progress"),
        viewda_data_engine::DatasetDiscoveryProgress {
            scanned_entry_count: 0,
            discovered_member_count: 0,
            ignored_file_count: 0,
            complete: false,
        }
    );

    let first = discovery.advance(7).expect("bounded discovery step");
    assert_eq!(first.scanned_entry_count, 7);
    assert_eq!(first.discovered_member_count, 7);
    assert!(!first.complete);
    let preview = discovery
        .next_preview_candidate()
        .expect("preview candidate")
        .expect("non-empty candidate");
    assert_eq!(preview.member_count(), 7);
    assert!(
        discovery
            .next_preview_candidate()
            .expect("unchanged candidate")
            .is_none()
    );
    assert_eq!(discovery.advance(0).expect("empty step"), first);
    assert_eq!(discovery.advance(257), Err(DatasetError::PageTooLarge));

    let continued = discovery.advance(25).expect("continue discovery");
    assert_eq!(continued.scanned_entry_count, 32);
    assert_eq!(
        discovery
            .next_preview_candidate()
            .expect("larger candidate")
            .expect("candidate after more members")
            .member_count(),
        32
    );
    let preview_paths = preview
        .member_page(0, 7)
        .expect("preview members")
        .members
        .into_iter()
        .map(|member| member.relative_path)
        .collect::<Vec<_>>();
    assert_eq!(preview_paths.len(), 7);

    let complete = discovery.advance(256).expect("finish discovery");
    assert!(complete.complete);
    assert_eq!(complete.scanned_entry_count, 40);
    assert_eq!(complete.discovered_member_count, 40);
    let source = discovery.into_source().expect("full source");
    let full_paths = source
        .member_page(0, 40)
        .expect("full members")
        .members
        .into_iter()
        .map(|member| member.relative_path)
        .collect::<Vec<_>>();
    assert_eq!(source.member_count(), 40);
    assert!(
        preview_paths
            .iter()
            .all(|preview_path| full_paths.contains(preview_path))
    );
}

#[test]
fn explicit_discovery_pulls_paths_incrementally_and_checks_cancellation_between_them() {
    let directory = TempDir::new().expect("dataset directory");
    let paths = (0..10)
        .map(|index| {
            let path = directory.path().join(format!("part-{index:02}.parquet"));
            fs::write(&path, b"footer intentionally absent").expect("lazy member");
            path
        })
        .collect::<Vec<_>>();
    let pulls = Arc::new(AtomicUsize::new(0));
    let counted_paths = {
        let pulls = Arc::clone(&pulls);
        paths.clone().into_iter().map(move |path| {
            pulls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, DatasetError>(path)
        })
    };
    let mut discovery = DatasetSource::begin_file_selection(directory.path(), counted_paths)
        .expect("begin explicit discovery");

    let first = discovery.advance(3).expect("bounded explicit step");
    assert_eq!(first.scanned_entry_count, 3);
    assert_eq!(first.discovered_member_count, 3);
    assert_eq!(pulls.load(Ordering::SeqCst), 3);

    let cancellation_pulls = Arc::new(AtomicUsize::new(0));
    let counted_paths = {
        let cancellation_pulls = Arc::clone(&cancellation_pulls);
        paths.into_iter().map(move |path| {
            cancellation_pulls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, DatasetError>(path)
        })
    };
    let mut cancelled = DatasetSource::begin_file_selection(directory.path(), counted_paths)
        .expect("begin cancelled discovery");
    let mut polls = 0;
    assert_eq!(
        cancelled.advance_while(10, || {
            polls += 1;
            polls < 3
        }),
        Err(DatasetError::Cancelled)
    );
    assert_eq!(cancellation_pulls.load(Ordering::SeqCst), 1);
}

#[test]
fn early_sample_is_available_before_discovery_pulls_later_entries() {
    let directory = TempDir::new().expect("dataset directory");
    let first = directory.path().join("part-00.parquet");
    write_ints(&first, "value", &[1]);
    let mut paths = vec![first];
    for index in 1..100 {
        let path = directory.path().join(format!("part-{index:02}.parquet"));
        fs::write(&path, b"footer intentionally absent").expect("later lazy member");
        paths.push(path);
    }
    let pulls = Arc::new(AtomicUsize::new(0));
    let counted_paths = {
        let pulls = Arc::clone(&pulls);
        paths.into_iter().map(move |path| {
            pulls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, DatasetError>(path)
        })
    };
    let mut discovery = DatasetSource::begin_file_selection(directory.path(), counted_paths)
        .expect("begin discovery");

    let first_step = discovery.advance(1).expect("first bounded step");
    assert_eq!(pulls.load(Ordering::SeqCst), 1);
    assert_eq!(first_step.discovered_member_count, 1);
    assert!(!first_step.complete);
    let sample = discovery
        .next_preview_candidate()
        .expect("sample candidate")
        .expect("sample after the first bounded step");
    assert_eq!(sample.member_count(), 1);
    let preview = sample
        .inspector()
        .preview(1)
        .expect("meaningful sample frame");
    assert_eq!(preview.progress.row_count, 1);
    assert!(
        discovery
            .commit_preview_candidate(&preview)
            .expect("commit meaningful sample")
    );

    let continued = discovery.advance(1).expect("continued discovery");
    assert_eq!(pulls.load(Ordering::SeqCst), 2);
    assert_eq!(continued.discovered_member_count, 2);
    assert!(!continued.complete);
}

#[test]
fn early_sample_grows_past_an_empty_candidate_before_it_is_committed() {
    let directory = TempDir::new().expect("dataset directory");
    let empty = directory.path().join("part-00.parquet");
    let nonempty = directory.path().join("part-01.parquet");
    let later = directory.path().join("part-02.parquet");
    write_ints(&empty, "value", &[]);
    write_ints(&nonempty, "value", &[1]);
    fs::write(&later, b"footer intentionally absent").expect("later lazy member");
    let mut discovery = DatasetSource::begin_file_selection(
        directory.path(),
        [empty, nonempty, later].into_iter().map(Ok),
    )
    .expect("begin discovery");

    let first_step = discovery.advance(1).expect("empty candidate step");
    assert!(!first_step.complete);
    let first_candidate = discovery
        .next_preview_candidate()
        .expect("first candidate")
        .expect("empty candidate source");
    let first_preview = first_candidate
        .inspector()
        .preview(1)
        .expect("empty candidate preview");
    assert_eq!(first_preview.progress.row_count, 0);
    assert!(
        !discovery
            .commit_preview_candidate(&first_preview)
            .expect("retain empty candidate")
    );

    let second_step = discovery.advance(1).expect("nonempty candidate step");
    assert!(!second_step.complete);
    let second_candidate = discovery
        .next_preview_candidate()
        .expect("grown candidate")
        .expect("candidate with rows");
    let second_preview = second_candidate
        .inspector()
        .preview(1)
        .expect("grown candidate preview");
    assert_eq!(second_preview.progress.completed_member_count, 2);
    assert_eq!(second_preview.progress.row_count, 1);
    assert!(
        discovery
            .commit_preview_candidate(&second_preview)
            .expect("commit candidate with rows")
    );

    let continued = discovery.advance(1).expect("continued discovery");
    assert_eq!(continued.discovered_member_count, 3);
    assert!(!continued.complete);
}

#[test]
fn discovery_freezes_a_deterministically_sorted_composition_only_at_eof() {
    let directory = TempDir::new().expect("dataset directory");
    fs::write(directory.path().join("b.parquet"), b"footer absent").expect("later member");
    fs::write(directory.path().join("a.parquet"), b"footer absent").expect("earlier member");

    let mut discovery = DatasetSource::begin_folder(directory.path()).expect("begin discovery");
    assert!(!discovery.progress().expect("initial progress").complete);
    let complete = discovery.advance(256).expect("reach eof");
    assert!(complete.complete);

    fs::write(directory.path().join("c.parquet"), b"footer absent").expect("late member");
    let source = discovery.into_source().expect("frozen source");
    assert_eq!(source.member_count(), 2);
    assert_eq!(
        source
            .member_page(0, 8)
            .expect("sorted members")
            .members
            .into_iter()
            .map(|member| member.relative_path)
            .collect::<Vec<_>>(),
        ["a.parquet", "b.parquet"]
    );
    assert_eq!(
        DatasetSource::open_folder(directory.path())
            .expect("explicit reopen")
            .member_count(),
        3
    );
}

#[test]
fn empty_folder_is_reported_only_after_discovery_reaches_eof() {
    let directory = TempDir::new().expect("dataset directory");
    assert!(matches!(
        DatasetSource::begin_folder(directory.path())
            .expect("begin premature freeze")
            .into_source(),
        Err(DatasetError::Unsupported)
    ));
    let mut discovery = DatasetSource::begin_folder(directory.path()).expect("begin empty folder");

    assert!(!discovery.progress().expect("initial progress").complete);
    assert!(discovery.advance(1).expect("empty eof").complete);
    assert!(matches!(
        discovery.into_source(),
        Err(DatasetError::NoParquetFiles)
    ));
}

#[cfg(unix)]
#[test]
fn public_folder_boundary_pages_one_hundred_thousand_members() {
    let directory = TempDir::new().expect("dataset directory");
    let mut link_target = directory.path().join("part-000000.parquet");
    write_ints(&link_target, "value", &[7]);
    for index in 1..=100_000 {
        let member = directory.path().join(format!("part-{index:06}.parquet"));
        if index % 50_000 == 0 {
            write_ints(&member, "value", &[7]);
            link_target = member;
        } else {
            fs::hard_link(&link_target, member).expect("logical member hardlink");
        }
    }

    let source = DatasetSource::open_folder(directory.path()).expect("high-cardinality source");
    let page = source.member_page(100_000, 256).expect("bounded wire page");

    assert_eq!(source.member_count(), 100_001);
    assert_eq!(page.total, 100_001);
    assert_eq!(page.members.len(), 1);
    assert_eq!(page.members[0].relative_path, "part-100000.parquet");

    let mut inspector = source.inspector();
    while inspector
        .advance(256)
        .expect("bounded footer page")
        .summary
        .is_none()
    {}
    let mut reader = inspector.into_window_reader().expect("ready dataset");
    let last = decode_one(&reader.fetch(100_000, 1).expect("last member row"));
    assert_eq!(int64_values(&last, 0), [7]);
}

#[test]
fn folder_open_cancels_during_discovery() {
    let directory = TempDir::new().expect("dataset directory");
    for index in 0..300 {
        fs::write(
            directory.path().join(format!("part-{index:03}.parquet")),
            b"footer intentionally absent",
        )
        .expect("lazy member");
    }
    let mut polls = 0;
    let result = DatasetSource::open_folder_cancellable(directory.path(), || {
        polls += 1;
        polls < 32
    });

    assert!(matches!(result, Err(DatasetError::Cancelled)));
}

#[test]
fn inspection_is_incremental_cancellable_and_latches_member_read_failures() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "value", &[1]);
    fs::write(directory.path().join("b.parquet"), b"not parquet").expect("invalid member");
    let source = DatasetSource::open_folder(directory.path()).expect("lazy discovery");
    let mut preview_inspector = source.inspector();
    let preview = preview_inspector.preview(8).expect("bounded early preview");
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
        Err(DatasetError::InvalidMember {
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
fn preview_skips_an_empty_leading_member_and_stops_at_the_first_rows() {
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

    assert_eq!(preview.progress.completed_member_count, 2);
    assert!(!preview.progress.schema_complete);
    assert_eq!(batches.schema().field(0).name(), "id");
    let batch = batches
        .next()
        .expect("preview rows")
        .expect("preview batch");
    assert_eq!(int64_values(&batch, 0), [20]);
    assert!(batches.next().is_none());
    assert_eq!(
        inspector
            .advance(1)
            .expect_err("unopened later member remains lazy"),
        DatasetError::InvalidMember {
            member: "year=2027/c.parquet".to_owned(),
        }
    );
}

#[test]
fn preview_bounds_the_footer_search_when_the_leading_members_are_empty() {
    let directory = TempDir::new().expect("dataset directory");
    for ordinal in 0..32 {
        write_ints(
            &directory.path().join(format!("part-{ordinal:02}.parquet")),
            "id",
            &[],
        );
    }
    fs::write(directory.path().join("part-32.parquet"), b"not parquet")
        .expect("unopened later member");
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();

    let preview = inspector.preview(8).expect("bounded empty preview");

    assert_eq!(preview.progress.completed_member_count, 32);
    assert_eq!(preview.progress.row_count, 0);
    assert!(!preview.progress.schema_complete);
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
fn preview_reader_supports_windows_and_prepared_views_over_only_its_fixed_sample() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[20]);
    write_ints(&directory.path().join("b.parquet"), "id", &[10]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    inspector.preview(8).expect("preview");
    let mut reader = inspector.take_preview_reader().expect("preview reader");

    let direct = decode_one(&reader.fetch(0, 8).expect("preview window"));
    assert_eq!(int64_values(&direct, 0), [20]);

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: FieldPath::from("id"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("preview view builder")
    .build()
    .expect("preview view");
    let sorted = decode_one(&view.fetch_window(0, 8).expect("preview sorted window"));
    assert_eq!(int64_values(&sorted, 0), [20]);
}

#[test]
fn zero_candidate_filters_return_schema_only_ipc_without_a_query_member() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("year=2025/a.parquet"), "id", &[10]);
    write_ints(&directory.path().join("year=2026/b.parquet"), "id", &[20]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let reader = complete_reader(source);
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");
    let cases = [
        vec![filter(&reader, year, DataFilterOperator::Equals, &["2099"])],
        vec![filter(
            &reader,
            year,
            DataFilterOperator::OneOf,
            &["2023", "2024"],
        )],
        vec![filter(&reader, file, DataFilterOperator::IsNull, &[])],
        vec![
            filter(&reader, year, DataFilterOperator::IsNull, &[]),
            filter(&reader, file, DataFilterOperator::IsNotNull, &[]),
        ],
        vec![
            filter(&reader, year, DataFilterOperator::IsNotNull, &[]),
            filter(
                &reader,
                file,
                DataFilterOperator::Equals,
                &["missing.parquet"],
            ),
        ],
    ];

    for filters in cases {
        let window = filtered_window(&reader, 0, 8, &filters).expect("empty filtered window");
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
    let names = vec![
        "br[ack].parquet",
        "quote'one.parquet",
        "right].parquet",
        "данные.parquet",
    ];
    #[cfg(unix)]
    let names = {
        let mut names = names;
        names.extend([
            "double\"quote.parquet",
            "question?.parquet",
            "star*.parquet",
        ]);
        names
    };
    for (index, name) in names.iter().enumerate() {
        write_ints(&directory.path().join(name), "id", &[index as i64]);
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);

    let batch = decode_one(&reader.fetch(0, 16).expect("exact paths"));
    let expected = {
        let mut expected = names.clone();
        expected.sort();
        expected
    };

    assert_eq!(
        string_values(&batch, 1),
        expected.iter().copied().map(Some).collect::<Vec<_>>()
    );
    assert_eq!(batch.num_rows(), names.len());

    let view = DataViewBuilder::for_dataset(&reader, &[], &[], DataViewMemoryLimit::Mb384)
        .expect("dataset view builder")
        .build()
        .expect("prepared dataset view");
    let batch = decode_one(&view.fetch_window(0, 16).expect("prepared exact paths"));
    assert_eq!(
        string_values(&batch, 1),
        expected.into_iter().map(Some).collect::<Vec<_>>()
    );
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
    assert_eq!(integer_optional_values(&batch, 1), [None]);
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
    let window = reader.fetch(0, 16).expect("dataset window");
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
        &filtered_window(
            &reader,
            0,
            8,
            &[equals(
                &reader,
                file,
                "year=2025/month=12/part-00000.parquet",
            )],
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
    let reader = complete_reader(source);
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");

    let partition_window =
        filtered_window(&reader, 0, 8, &[equals(&reader, year, "2026")]).expect("partition window");
    assert_eq!(int64_values(&decode_one(&partition_window), 0), [20]);

    let file_window = filtered_window(
        &reader,
        0,
        8,
        &[equals(&reader, file, "year=2025/a.parquet")],
    )
    .expect("provenance window");
    assert_eq!(int64_values(&decode_one(&file_window), 0), [10]);
}

#[test]
fn infers_canonical_integer_hive_columns_across_query_surfaces() {
    let directory = TempDir::new().expect("dataset directory");
    for (relative, id) in [
        (
            "year=2/month=01/category=1/empty=__HIVE_DEFAULT_PARTITION__/a.parquet",
            2,
        ),
        (
            "year=10/month=2/category=x/empty=__HIVE_DEFAULT_PARTITION__/b.parquet",
            10,
        ),
        (
            "year=__HIVE_DEFAULT_PARTITION__/month=3/category=__HIVE_DEFAULT_PARTITION__/empty=__HIVE_DEFAULT_PARTITION__/c.parquet",
            0,
        ),
    ] {
        write_ints(&directory.path().join(relative), "id", &[id]);
    }
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    assert!(
        source
            .partition_page(&[], None, 8)
            .expect("raw partition roots")
            .nodes
            .iter()
            .any(|node| node.partition.value == "__HIVE_DEFAULT_PARTITION__")
    );
    let mut reader = complete_reader(source);
    let id = column_index(&reader, "id");
    let year = column_index(&reader, "year");
    let month = column_index(&reader, "month");
    let category = column_index(&reader, "category");
    let empty = column_index(&reader, "empty");
    let file = column_index(&reader, "file");
    assert_eq!(
        reader.summary().schema[year as usize].physical_type,
        "INT64"
    );
    assert_eq!(reader.summary().schema[year as usize].logical_type, None);
    assert_eq!(
        reader.summary().schema[month as usize].physical_type,
        "BYTE_ARRAY"
    );
    assert_eq!(
        reader.summary().schema[category as usize].physical_type,
        "BYTE_ARRAY"
    );
    assert_eq!(
        reader.summary().schema[empty as usize].physical_type,
        "BYTE_ARRAY"
    );

    let direct = decode_one(
        &reader
            .fetch_fields(
                0,
                8,
                &field_paths(&reader, &[id, year, month, category, empty, file]),
            )
            .expect("typed partition window"),
    );
    assert_eq!(int64_values(&direct, 0), [10, 2, 0]);
    assert_eq!(
        integer_optional_values(&direct, 1),
        [Some(10), Some(2), None]
    );
    assert_eq!(
        string_values(&direct, 2),
        [Some("2"), Some("01"), Some("3")]
    );
    assert_eq!(string_values(&direct, 3), [Some("x"), Some("1"), None]);
    assert_eq!(string_values(&direct, 4), [None, None, None]);

    let range = decode_one(
        &filtered_window(
            &reader,
            0,
            8,
            &[filter(
                &reader,
                year,
                DataFilterOperator::Range,
                &["2", "9"],
            )],
        )
        .expect("numeric partition range"),
    );
    assert_eq!(int64_values(&range, 0), [2]);
    assert_eq!(
        filtered_window(
            &reader,
            0,
            8,
            &[filter(
                &reader,
                year,
                DataFilterOperator::Equals,
                &["not-a-number"],
            )],
        ),
        Err(DataViewError::Engine(DataWindowError::InvalidFilter))
    );

    let sorted = DataViewBuilder::for_dataset(
        &reader,
        &[filter(&reader, year, DataFilterOperator::IsNotNull, &[])],
        &[DataSort {
            field_path: field_path(&reader, year),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("partition view builder")
    .build()
    .expect("partition view");
    let sparse = decode_one(
        &sorted
            .fetch_window_fields(0, 8, &field_paths(&reader, &[year, id]))
            .expect("sparse partition window"),
    );
    assert_eq!(integer_optional_values(&sparse, 0), [Some(2), Some(10)]);
    assert_eq!(int64_values(&sparse, 1), [2, 10]);

    let statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("partition statistics reader")
        .fetch(&FieldPath::from("year"), true)
        .expect("partition statistics");
    assert_eq!(statistics.minimum.as_deref(), Some("2"));
    assert_eq!(statistics.maximum.as_deref(), Some("10"));
    assert_eq!(statistics.null_share, 1.0 / 3.0);
    assert_eq!(statistics.approximate_distinct_count, Some(2));

    let suggestions =
        TextValueSuggestionsReader::for_dataset(&reader).expect("partition suggestions reader");
    assert_eq!(
        suggestions
            .fetch(
                "0",
                &field_path(&reader, month),
                DataFilterOperator::TextContains,
                &suggestions.interrupt_handle(),
            )
            .expect("text partition suggestions")
            .values,
        ["01"]
    );

    let target = directory.path().join("typed-hive.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![id, year, month, category], vec![]),
        None,
    )
    .expect("typed partition export reader")
    .export()
    .expect("typed partition export");
    assert_eq!(
        fs::read_to_string(target).expect("typed partition CSV"),
        "id,year,month,category\r\n\
         10,10,2,x\r\n\
         2,2,01,1\r\n\
         0,,3,\r\n"
    );
}

#[test]
fn early_sample_and_fixed_composition_use_their_own_hive_types() {
    let directory = TempDir::new().expect("dataset directory");
    let numeric = directory.path().join("year=2/a.parquet");
    let mixed = directory.path().join("year=mixed/b.parquet");
    write_ints(&numeric, "id", &[2]);
    write_ints(&mixed, "id", &[3]);
    let mut discovery = DatasetSource::begin_file_selection(
        directory.path(),
        [Ok(numeric.clone()), Ok(mixed.clone())],
    )
    .expect("explicit discovery");
    discovery.advance(1).expect("first member");
    let sample = discovery
        .next_preview_candidate()
        .expect("sample candidate")
        .expect("sample source");
    assert_eq!(
        complete_summary(&sample)
            .schema
            .iter()
            .find(|field| field.name == "year")
            .expect("sample partition")
            .physical_type,
        "INT64"
    );
    while !discovery.advance(1).expect("remaining discovery").complete {}
    let full = discovery.into_source().expect("fixed composition");
    let mut reader = complete_reader(full);
    let year = column_index(&reader, "year");
    assert_eq!(
        reader.summary().schema[year as usize].physical_type,
        "BYTE_ARRAY"
    );
    assert_eq!(
        string_values(
            &decode_one(
                &reader
                    .fetch_fields(0, 8, &field_paths(&reader, &[year]))
                    .expect("fixed-composition window"),
            ),
            0,
        ),
        [Some("2"), Some("mixed")]
    );
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
    let batch = decode_one(&reader.fetch(0, 8).expect("nested union"));
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
    let city_path = FieldPath::new(["profile", "city"]);
    let zip_path = FieldPath::new(["profile", "zip"]);
    let projected = decode_one(
        &reader
            .fetch_fields(0, 8, &[zip_path.clone(), city_path.clone()])
            .expect("nested dataset projection"),
    );
    assert_eq!(integer_optional_values(&projected, 0), [None, Some(100)]);
    assert_eq!(string_values(&projected, 1), [Some("Oslo"), Some("Riga")]);

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[DataFilter {
            field_path: city_path.clone(),
            json_target: None,
            operator: DataFilterOperator::Equals,
            values: vec!["Riga".to_owned()],
            match_case: false,
        }],
        &[DataSort {
            field_path: zip_path.clone(),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("nested dataset view builder")
    .build()
    .expect("nested dataset view");
    let prepared = decode_one(
        &view
            .fetch_window_fields(0, 8, &[city_path, zip_path])
            .expect("prepared nested dataset projection"),
    );
    assert_eq!(string_values(&prepared, 0), [Some("Riga")]);
    assert_eq!(integer_optional_values(&prepared, 1), [Some(100)]);

    let file = column_index(&reader, "file");
    let first_only = decode_one(
        &filtered_window(&reader, 0, 8, &[equals(&reader, file, "a.parquet")])
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
fn maps_canonical_paths_to_each_members_exact_case_for_sparse_reads_and_export() {
    let directory = TempDir::new().expect("case-drift dataset");
    write_columns(
        &directory.path().join("a.parquet"),
        vec![("Profile", case_drift_profile("Address", "City", "Oslo"))],
    );
    write_columns(
        &directory.path().join("b.parquet"),
        vec![("profile", case_drift_profile("address", "city", "Riga"))],
    );
    let mut reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let city = FieldPath::new(["Profile", "Address", "City"]);

    let direct = decode_one(
        &reader
            .fetch_fields(0, 8, std::slice::from_ref(&city))
            .expect("direct case-drift window"),
    );
    assert_eq!(string_values(&direct, 0), [Some("Oslo"), Some("Riga")]);

    let view = DataViewBuilder::for_dataset(&reader, &[], &[], DataViewMemoryLimit::Mb384)
        .expect("case-drift view builder")
        .build()
        .expect("case-drift view");
    let prepared = decode_one(
        &view
            .fetch_window_fields(0, 8, std::slice::from_ref(&city))
            .expect("prepared case-drift window"),
    );
    assert_eq!(string_values(&prepared, 0), [Some("Oslo"), Some("Riga")]);

    let target = directory.path().join("case-drift.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        DataExportRequest {
            field_paths: vec![city],
            row_ranges: Vec::new(),
            output: DataExportFormat::Csv {
                options: CsvExportOptions::default(),
            },
        },
        Some(view.export_snapshot()),
    )
    .expect("case-drift export reader")
    .export()
    .expect("case-drift export");
    assert_eq!(
        fs::read_to_string(target).expect("case-drift CSV"),
        "Profile.Address.City\r\nOslo\r\nRiga\r\n"
    );
}

#[test]
fn widens_safe_numeric_drift_and_rejects_lossy_promotions() {
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
    let numeric_reader = complete_reader(numeric_source);
    let numeric_file = column_index(&numeric_reader, "file");
    assert_eq!(
        decode_one(
            &filtered_window(
                &numeric_reader,
                0,
                8,
                &[equals(&numeric_reader, numeric_file, "a.parquet")],
            )
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
    let floating_reader = complete_reader(floating_source);
    let floating_file = column_index(&floating_reader, "file");
    assert_eq!(
        decode_one(
            &filtered_window(
                &floating_reader,
                0,
                8,
                &[equals(&floating_reader, floating_file, "a.parquet")]
            )
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
}

#[test]
fn suffixes_colliding_virtual_columns_without_renaming_physical_columns() {
    let provenance = TempDir::new().expect("provenance collision dataset");
    write_columns(
        &provenance.path().join("part.parquet"),
        vec![("file", Arc::new(StringArray::from(vec!["physical"])))],
    );
    let mut provenance_reader =
        complete_reader(DatasetSource::open_folder(provenance.path()).expect("provenance dataset"));
    assert_eq!(
        provenance_reader
            .summary()
            .schema
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        ["file", "file_1"]
    );
    let provenance_batch = decode_one(
        &provenance_reader
            .fetch(0, 8)
            .expect("provenance collision window"),
    );
    assert_eq!(string_values(&provenance_batch, 0), [Some("physical")]);
    assert_eq!(string_values(&provenance_batch, 1), [Some("part.parquet")]);

    let directory = TempDir::new().expect("multi-collision dataset");
    for (relative, physical_year, marker) in [
        ("year=2026/FILE=archive/a.parquet", 2006, "a"),
        ("year=2025/FILE=older/b.parquet", 2005, "b"),
    ] {
        write_columns(
            &directory.path().join(relative),
            vec![
                (
                    "year",
                    Arc::new(Int64Array::from(vec![physical_year])) as ArrayRef,
                ),
                (
                    "YEAR_1",
                    Arc::new(StringArray::from(vec![marker])) as ArrayRef,
                ),
                (
                    "file",
                    Arc::new(StringArray::from(vec!["physical-file"])) as ArrayRef,
                ),
                (
                    "FILE_1",
                    Arc::new(StringArray::from(vec!["physical-file-1"])) as ArrayRef,
                ),
            ],
        );
    }
    let reader = complete_reader(
        DatasetSource::open_folder(directory.path()).expect("multi-collision dataset"),
    );
    let summary = reader.summary();
    assert_eq!(
        summary
            .schema
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        [
            "year", "YEAR_1", "file", "FILE_1", "year_2", "FILE_2", "file_3"
        ]
    );
    assert_eq!(summary.partition_column_indices, [4, 5]);
    assert_eq!(summary.provenance_column_index, 6);

    let virtual_year = summary.partition_column_indices[0];
    let virtual_file_partition = summary.partition_column_indices[1];
    let provenance = summary.provenance_column_index;
    let filtered = decode_one(
        &filtered_window(
            &reader,
            0,
            8,
            &[
                equals(&reader, virtual_year, "2026"),
                equals(&reader, virtual_file_partition, "archive"),
                equals(&reader, provenance, "year=2026/FILE=archive/a.parquet"),
            ],
        )
        .expect("suffixed virtual filter"),
    );
    assert_eq!(int64_values(&filtered, 0), [2006]);
    assert_eq!(integer_optional_values(&filtered, 4), [Some(2026)]);
    assert_eq!(string_values(&filtered, 5), [Some("archive")]);
    assert_eq!(
        string_values(&filtered, 6),
        [Some("year=2026/FILE=archive/a.parquet")]
    );

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, virtual_year),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("suffixed partition sort")
    .build()
    .expect("prepared collision view");
    let sorted = decode_one(&view.fetch_window(0, 8).expect("sorted collision window"));
    assert_eq!(
        integer_optional_values(&sorted, 4),
        [Some(2025), Some(2026)]
    );

    let target = directory.path().join("collision.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(
            &reader,
            vec![0, virtual_year, virtual_file_partition, provenance],
            vec![],
        ),
        None,
    )
    .expect("collision export reader")
    .export()
    .expect("collision export");
    assert_eq!(
        fs::read_to_string(target).expect("collision CSV"),
        "year,year_2,FILE_2,file_3\r\n\
         2005,2025,older,year=2025/FILE=older/b.parquet\r\n\
         2006,2026,archive,year=2026/FILE=archive/a.parquet\r\n"
    );
}

#[test]
fn widens_numeric_schema_across_the_catalog_page_boundary() {
    let directory = TempDir::new().expect("dataset directory");
    for index in 0..256 {
        write_columns(
            &directory.path().join(format!("part-{index:03}.parquet")),
            vec![("value", Arc::new(Int32Array::from(vec![index])) as ArrayRef)],
        );
    }
    write_columns(
        &directory.path().join("part-256.parquet"),
        vec![(
            "value",
            Arc::new(Int64Array::from(vec![i64::MAX])) as ArrayRef,
        )],
    );
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    inspector.advance(256).expect("first footer page");
    inspector.advance(1).expect("second footer page");
    let mut reader = inspector.into_window_reader().expect("dataset reader");

    let batch = decode_one(&reader.fetch(256, 1).expect("promoted window"));
    assert_eq!(int64_values(&batch, 0), [i64::MAX]);

    let statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("dataset statistics")
        .fetch(&FieldPath::from("value"), true)
        .expect("cross-page statistics");
    assert_eq!(statistics.maximum.as_deref(), Some("9223372036854775807"));

    let file_index = column_index(&reader, "file");
    let suggestions =
        TextValueSuggestionsReader::for_dataset(&reader).expect("dataset suggestions");
    let interrupt = suggestions.interrupt_handle();
    assert_eq!(
        suggestions
            .fetch(
                "256",
                &field_path(&reader, file_index),
                DataFilterOperator::TextContains,
                &interrupt,
            )
            .expect("later-page suggestion")
            .values,
        ["part-256.parquet"]
    );

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: FieldPath::from("value"),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view")
    .build()
    .expect("global sort");
    let sorted = decode_one(
        &view
            .fetch_window_fields(0, 1, &[FieldPath::from("value")])
            .expect("sorted later-page row"),
    );
    assert_eq!(int64_values(&sorted, 0), [i64::MAX]);

    let target = directory.path().join("all.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![0], Vec::new()),
        None,
    )
    .expect("dataset export")
    .export()
    .expect("cross-page export");
    let exported = fs::read_to_string(target).expect("exported csv");
    let direct_lines = exported.lines().collect::<Vec<_>>();
    assert_eq!(direct_lines.len(), 258);
    assert_eq!(direct_lines[0], "value");
    assert_eq!(
        direct_lines[1..257],
        (0..256).map(|value| value.to_string()).collect::<Vec<_>>()
    );
    assert_eq!(direct_lines[257], i64::MAX.to_string());

    let sorted_target = directory.path().join("sorted.csv");
    let export = DataExportReader::for_dataset(
        &reader,
        sorted_target.clone(),
        dataset_csv_request(&reader, vec![0], Vec::new()),
        Some(view.export_snapshot()),
    )
    .expect("sorted dataset export");
    let progress = export.progress();
    export.export().expect("cross-page sorted export");
    let sorted_export = fs::read_to_string(sorted_target).expect("sorted exported csv");
    let lines = sorted_export.lines().collect::<Vec<_>>();

    assert_eq!(lines.len(), 258);
    assert_eq!(lines[0], "value");
    assert_eq!(lines[1], i64::MAX.to_string());
    assert_eq!(lines[257], "0");
    assert_eq!(lines.iter().filter(|line| **line == "value").count(), 1);
    assert_eq!(progress.bytes_written(), sorted_export.len() as u64);
}

#[test]
fn keeps_producer_types_and_values_across_dataset_query_paths() {
    let directory = TempDir::new().expect("dataset directory");
    for (name, id, label) in [("a.parquet", 2, "later"), ("b.parquet", 1, "earlier")] {
        let labels = DictionaryArray::<Int32Type>::try_new(
            Int32Array::from(vec![0]),
            Arc::new(StringArray::from(vec![label])),
        )
        .expect("dictionary fixture");
        let decimal = Decimal128Array::from(vec![i128::from(id) * 100])
            .with_precision_and_scale(10, 2)
            .expect("decimal fixture");
        write_columns(
            &directory.path().join(name),
            vec![
                ("id", Arc::new(Int64Array::from(vec![id])) as ArrayRef),
                (
                    "recorded_at",
                    Arc::new(TimestampNanosecondArray::from(vec![id * 1_000_000_001])) as ArrayRef,
                ),
                (
                    "day",
                    Arc::new(Date32Array::from(vec![id as i32])) as ArrayRef,
                ),
                ("amount", Arc::new(decimal) as ArrayRef),
                ("label", Arc::new(labels) as ArrayRef),
                (
                    "__viewda_column_0",
                    Arc::new(StringArray::from(vec![label])) as ArrayRef,
                ),
            ],
        );
    }
    let mut reader = complete_reader(
        DatasetSource::open_folder(directory.path()).expect("typed folder dataset"),
    );

    let direct = decode_one(&reader.fetch(0, 8).expect("direct typed window"));
    assert_eq!(direct.num_rows(), 2);
    assert!(matches!(
        direct.schema().field(1).data_type(),
        DataType::Timestamp(_, None)
    ));
    assert_eq!(direct.schema().field(2).data_type(), &DataType::Date32);
    assert!(matches!(
        direct.schema().field(3).data_type(),
        DataType::Decimal128(_, 2)
    ));
    assert_eq!(direct.schema().field(4).data_type(), &DataType::Utf8);
    assert_eq!(direct.schema().field(5).name(), "__viewda_column_0");
    assert_eq!(
        timestamp_nanosecond_values(&direct, 1),
        [2_000_000_002, 1_000_000_001]
    );
    assert_eq!(date32_values(&direct, 2), [2, 1]);
    assert_eq!(decimal128_values(&direct, 3), [200, 100]);
    assert_eq!(string_values(&direct, 4), [Some("later"), Some("earlier")]);
    assert_eq!(string_values(&direct, 5), [Some("later"), Some("earlier")]);

    let alias = column_index(&reader, "__viewda_column_0");

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[filter(
            &reader,
            alias,
            DataFilterOperator::NotEquals,
            &["missing"],
        )],
        &[DataSort {
            field_path: field_path(&reader, alias),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("typed view builder")
    .build()
    .expect("typed view");
    let sorted = decode_one(&view.fetch_window(0, 8).expect("sorted typed window"));
    assert_eq!(int64_values(&sorted, 0), [1, 2]);
    assert!(matches!(
        sorted.schema().field(1).data_type(),
        DataType::Timestamp(_, None)
    ));
    assert_eq!(sorted.schema().field(2).data_type(), &DataType::Date32);
    assert!(matches!(
        sorted.schema().field(3).data_type(),
        DataType::Decimal128(_, 2)
    ));
    assert_eq!(sorted.schema().field(4).data_type(), &DataType::Utf8);
    assert_eq!(sorted.schema().field(5).name(), "__viewda_column_0");
    assert_eq!(
        timestamp_nanosecond_values(&sorted, 1),
        [1_000_000_001, 2_000_000_002]
    );
    assert_eq!(date32_values(&sorted, 2), [1, 2]);
    assert_eq!(decimal128_values(&sorted, 3), [100, 200]);
    assert_eq!(string_values(&sorted, 4), [Some("earlier"), Some("later")]);
    assert_eq!(string_values(&sorted, 5), [Some("earlier"), Some("later")]);

    let target = directory.path().join("typed.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![0, 1, 2, 3, 4, alias], vec![]),
        Some(view.export_snapshot()),
    )
    .expect("typed export reader")
    .export()
    .expect("typed export");
    let exported = fs::read_to_string(target).expect("typed CSV");
    assert_eq!(
        exported.lines().collect::<Vec<_>>(),
        [
            "id,recorded_at,day,amount,label,__viewda_column_0",
            "1,1970-01-01T00:00:01.000000001,1970-01-02,1.00,earlier,earlier",
            "2,1970-01-01T00:00:02.000000002,1970-01-03,2.00,later,later",
        ]
    );
}

#[test]
fn merges_nested_list_schema_across_the_catalog_page_boundary() {
    let directory = TempDir::new().expect("dataset directory");
    for index in 0..256 {
        write_columns(
            &directory.path().join(format!("part-{index:03}.parquet")),
            vec![("items", list_struct_a(index))],
        );
    }
    write_columns(
        &directory.path().join("part-256.parquet"),
        vec![("items", list_struct_a_b(i64::MAX, 7))],
    );
    let mut reader = complete_reader(
        DatasetSource::open_folder(directory.path()).expect("nested folder dataset"),
    );

    let batch = decode_one(&reader.fetch(256, 1).expect("nested union window"));
    let schema = batch.schema();
    let DataType::List(item) = schema.field(0).data_type() else {
        panic!("expected list column");
    };
    let DataType::Struct(fields) = item.data_type() else {
        panic!("expected list struct item");
    };
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0].data_type(), &DataType::Int64);
    assert_eq!(fields[1].name(), "b");
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
                ordinal: 1,
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
        reader.fetch(0, 8),
        Err(DatasetError::InvalidMember {
            member: "part.parquet".to_owned(),
        })
    );
    assert_eq!(
        reader.fetch(0, 8),
        Err(DatasetError::InvalidMember {
            member: "part.parquet".to_owned(),
        })
    );
}

#[cfg(unix)]
#[test]
fn member_permission_failure_is_named_and_remains_the_latched_error() {
    use std::os::unix::fs::PermissionsExt as _;

    let directory = TempDir::new().expect("permission dataset");
    let member = directory.path().join("part.parquet");
    write_ints(&member, "id", &[1]);
    let mut reader = complete_reader(
        DatasetSource::open_folder(directory.path()).expect("permission dataset source"),
    );
    fs::set_permissions(&member, fs::Permissions::from_mode(0o000)).expect("remove member access");

    let first = reader.fetch(0, 8);
    let second = reader.fetch(0, 8);
    fs::set_permissions(&member, fs::Permissions::from_mode(0o600)).expect("restore member access");

    let expected = Err(DatasetError::MemberPermissionDenied {
        member: "part.parquet".to_owned(),
    });
    assert_eq!(first, expected);
    assert_eq!(second, expected);

    let snapshot_directory = TempDir::new().expect("snapshot permission dataset");
    let snapshot_member = snapshot_directory.path().join("part.parquet");
    write_ints(&snapshot_member, "id", &[1]);
    let snapshot_reader = complete_reader(
        DatasetSource::open_folder(snapshot_directory.path())
            .expect("snapshot permission dataset source"),
    );
    fs::set_permissions(&snapshot_member, fs::Permissions::from_mode(0o000))
        .expect("remove selected member access");
    let snapshot_error = snapshot_reader.member_snapshot(0).err();
    fs::set_permissions(&snapshot_member, fs::Permissions::from_mode(0o600))
        .expect("restore selected member access");

    assert_eq!(
        snapshot_error,
        Some(DatasetError::MemberPermissionDenied {
            member: "part.parquet".to_owned(),
        })
    );
    assert_eq!(
        snapshot_reader.member_snapshot(0).err(),
        snapshot_error,
        "the first selected-member failure remains latched"
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

    let batch = decode_one(&reader.fetch(0, 8).expect("window"));

    assert_eq!(string_values(&batch, 0), [Some("physical-name")]);
    assert_eq!(int64_values(&batch, 1), [99]);
    assert_eq!(string_values(&batch, 2), [Some("part.parquet")]);

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: FieldPath::from("filename"),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let batch = decode_one(&view.fetch_window(0, 8).expect("prepared window"));
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
        int64_values(&decode_one(&reader.fetch(0, 8).expect("window")), 0),
        [1]
    );

    fs::remove_file(&first).expect("remove fixed member");
    assert_eq!(
        reader.fetch(0, 8),
        Err(DatasetError::SourceChanged {
            member: "a.parquet".to_owned(),
        })
    );
    write_ints(&first, "id", &[1]);
    assert_eq!(
        reader.fetch(0, 8),
        Err(DatasetError::SourceChanged {
            member: "a.parquet".to_owned(),
        })
    );

    let reopened = DatasetSource::open_folder(directory.path()).expect("reload dataset");
    assert_eq!(reopened.member_count(), 2);
}

#[test]
fn a_pruned_member_is_checked_only_when_a_query_needs_it() {
    let directory = TempDir::new().expect("dataset directory");
    let kept = directory.path().join("year=2025/a.parquet");
    let deleted = directory.path().join("year=2026/b.parquet");
    write_ints(&kept, "id", &[10]);
    write_ints(&deleted, "id", &[20]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let reader = complete_reader(source);
    let year = column_index(&reader, "year");
    fs::remove_file(&deleted).expect("delete pruned member");

    assert_eq!(
        int64_values(
            &decode_one(
                &filtered_window(&reader, 0, 8, &[equals(&reader, year, "2025")])
                    .expect("window pruned away from changed member"),
            ),
            0,
        ),
        [10]
    );
    assert_eq!(
        filtered_window(&reader, 0, 8, &[equals(&reader, year, "2026")]),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    );
    assert_eq!(
        filtered_window(&reader, 0, 8, &[equals(&reader, year, "2025")]),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
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
        reader.fetch(0, 8),
        Err(DatasetError::SourceChanged {
            member: "part.parquet".to_owned(),
        })
    );
    assert_eq!(
        reader.fetch(0, 8),
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
        int64_values(&decode_one(&reader.fetch(1, 2).expect("window")), 0),
        [11, 20]
    );
}

#[test]
fn member_row_offsets_follow_frozen_order_across_empty_members() {
    let directory = TempDir::new().expect("dataset directory");
    let first = directory.path().join("a.parquet");
    let selected = directory.path().join("b.parquet");
    let last = directory.path().join("c.parquet");
    write_ints(&first, "id", &[10, 11]);
    write_ints(&selected, "id", &[]);
    write_ints(&last, "id", &[20, 21, 22]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));

    assert_eq!(
        reader.member_row_offset_while(1, || false),
        Err(DatasetError::Cancelled)
    );
    assert_eq!(reader.member_row_offset(0), Ok(0));
    assert_eq!(reader.member_row_offset(1), Ok(2));
    assert_eq!(reader.member_row_offset(2), Ok(2));
    assert_eq!(reader.member_row_offset(3), Err(DatasetError::Unsupported));
    fs::remove_file(first).expect("delete unrelated prefix member");
    fs::remove_file(last).expect("delete unrelated suffix member");
    assert_eq!(
        reader.member_row_offset(1),
        Ok(2),
        "the catalog offset stays frozen when unrelated members change"
    );
    fs::remove_file(selected).expect("delete selected member");
    assert_eq!(
        reader.member_row_offset(1),
        Err(DatasetError::SourceChanged {
            member: "b.parquet".to_owned(),
        })
    );
}

#[cfg(unix)]
#[test]
fn member_row_offset_latches_the_exact_replaced_member() {
    let directory = TempDir::new().expect("dataset directory");
    let selected = directory.path().join("part.parquet");
    let replacement = directory.path().join("replacement.parquet");
    write_ints(&selected, "id", &[1]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    write_ints(&replacement, "id", &[2, 3]);
    fs::rename(replacement, selected).expect("replace selected member");

    let expected = Err(DatasetError::SourceChanged {
        member: "part.parquet".to_owned(),
    });
    assert_eq!(reader.member_row_offset(0), expected);
    assert_eq!(reader.member_row_offset(0), expected);
}

#[test]
fn fully_empty_dataset_returns_its_schema_and_no_batches() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[]);
    write_ints(&directory.path().join("b.parquet"), "id", &[]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut reader = complete_reader(source);

    let window = reader.fetch(0, 8).expect("empty dataset window");
    let mut batches =
        StreamReader::try_new(Cursor::new(&window), None).expect("schema-only Arrow stream");

    assert_eq!(batches.schema().field(0).name(), "id");
    assert_eq!(batches.schema().field(1).name(), "file");
    assert!(batches.next().is_none());

    let target = directory.path().join("empty.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![0, 1], vec![]),
        None,
    )
    .expect("empty dataset export reader")
    .export()
    .expect("empty dataset export");
    assert_eq!(
        fs::read_to_string(target).expect("empty dataset CSV"),
        "id,file\r\n"
    );
}

fn equals(reader: &DatasetWindowReader, column_index: u32, value: &str) -> DataFilter {
    filter(reader, column_index, DataFilterOperator::Equals, &[value])
}

fn filter(
    reader: &DatasetWindowReader,
    column_index: u32,
    operator: DataFilterOperator,
    values: &[&str],
) -> DataFilter {
    DataFilter {
        field_path: field_path(reader, column_index),
        json_target: None,
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

fn filtered_window(
    reader: &DatasetWindowReader,
    row_offset: u64,
    row_count: u32,
    filters: &[DataFilter],
) -> Result<Vec<u8>, DataViewError> {
    DataViewBuilder::for_dataset(reader, filters, &[], DataViewMemoryLimit::Mb384)?
        .build()?
        .fetch_window(row_offset, row_count)
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

fn field_path(reader: &DatasetWindowReader, column_index: u32) -> FieldPath {
    FieldPath::new(vec![
        reader.summary().schema[column_index as usize].name.clone(),
    ])
}

fn field_paths(reader: &DatasetWindowReader, column_indices: &[u32]) -> Vec<FieldPath> {
    column_indices
        .iter()
        .map(|index| field_path(reader, *index))
        .collect()
}

#[test]
fn prepared_dataset_view_sorts_stably_and_projects_partition_and_file_columns() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(
        &directory.path().join("year=2025/a.parquet"),
        "value",
        &[2, 1, 1],
    );
    write_ints(&directory.path().join("year=2025/z.parquet"), "value", &[]);
    write_ints(
        &directory.path().join("year=2026/b.parquet"),
        "value",
        &[1, 3],
    );
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, value),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let batch = decode_one(
        &view
            .fetch_window_fields(0, 8, &field_paths(&reader, &[file, year, value]))
            .expect("prepared dataset window"),
    );
    assert_eq!(
        string_values(&batch, 0),
        [
            Some("year=2025/a.parquet"),
            Some("year=2025/a.parquet"),
            Some("year=2026/b.parquet"),
            Some("year=2025/a.parquet"),
            Some("year=2026/b.parquet"),
        ]
    );
    assert_eq!(
        integer_optional_values(&batch, 1),
        [Some(2025), Some(2025), Some(2026), Some(2025), Some(2026)]
    );
    assert_eq!(int64_values(&batch, 2), [1, 1, 1, 2, 3]);
}

#[test]
fn prepared_window_reads_512_distinct_one_row_members() {
    let directory = TempDir::new().expect("dataset directory");
    for ordinal in 0..512_i64 {
        write_ints(
            &directory.path().join(format!("part-{ordinal:04}.parquet")),
            "value",
            &[511 - ordinal],
        );
    }
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let file = reader.summary().provenance_column_index;
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, value),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let batch = decode_one(
        &view
            .fetch_window_fields(0, 512, &field_paths(&reader, &[value, file]))
            .expect("maximum prepared window"),
    );

    assert_eq!(int64_values(&batch, 0), (0..512_i64).collect::<Vec<_>>());
    let files = string_values(&batch, 1);
    assert_eq!(files.len(), 512);
    assert_eq!(files.first(), Some(&Some("part-0511.parquet")));
    assert_eq!(files.last(), Some(&Some("part-0000.parquet")));
}

#[test]
fn prepared_dataset_filters_and_sorts_virtual_columns() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("year=2025/z.parquet"), "value", &[1]);
    write_ints(&directory.path().join("year=2026/b.parquet"), "value", &[2]);
    write_ints(&directory.path().join("year=2026/a.parquet"), "value", &[3]);
    let mut reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");

    let by_file = DataViewBuilder::for_dataset(
        &reader,
        &[equals(&reader, year, "2026")],
        &[DataSort {
            field_path: field_path(&reader, file),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let by_file_batch = decode_one(
        &by_file
            .fetch_window_fields(0, 8, &field_paths(&reader, &[file, year, value]))
            .expect("partition-filtered file sort"),
    );
    assert_eq!(
        string_values(&by_file_batch, 0),
        [Some("year=2026/a.parquet"), Some("year=2026/b.parquet")]
    );

    let by_partition = DataViewBuilder::for_dataset(
        &reader,
        &[DataFilter {
            field_path: field_path(&reader, file),
            json_target: None,
            operator: DataFilterOperator::TextContains,
            values: vec![".parquet".to_owned()],
            match_case: true,
        }],
        &[DataSort {
            field_path: field_path(&reader, year),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let prepared = decode_one(
        &by_partition
            .fetch_window_fields(0, 8, &field_paths(&reader, &[value, year, file]))
            .expect("file-filtered partition sort"),
    );
    assert_eq!(
        integer_optional_values(&prepared, 1),
        [Some(2026), Some(2026), Some(2025)]
    );

    let direct = decode_one(
        &reader
            .fetch_fields(0, 8, &field_paths(&reader, &[value, year, file]))
            .expect("direct dataset window"),
    );
    assert_eq!(direct.schema(), prepared.schema());
}

#[test]
fn prepared_filter_prunes_a_nonmatching_damaged_member_before_staging_scan() {
    let directory = TempDir::new().expect("dataset directory");
    let retained = directory.path().join("year=2025/a.parquet");
    let pruned = directory.path().join("year=2026/b.parquet");
    write_ints(&retained, "value", &[1]);
    write_ints(&pruned, "value", &[2]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let year = column_index(&reader, "year");
    corrupt_first_column_data(&pruned);

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[equals(&reader, year, "2025")],
        &[DataSort {
            field_path: field_path(&reader, value),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("predicate must reach staged member scans");
    let batch = decode_one(
        &view
            .fetch_window_fields(0, 8, &field_paths(&reader, &[value]))
            .expect("prepared window"),
    );
    assert_eq!(int64_values(&batch, 0), [1]);
}

#[test]
fn completed_inspection_does_not_read_member_footers_again() {
    let directory = TempDir::new().expect("dataset directory");
    let first = directory.path().join("a.parquet");
    let second = directory.path().join("b.parquet");
    write_ints(&first, "value", &[1]);
    write_ints(&second, "value", &[2]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let mut inspector = source.inspector();
    let progress = inspector.advance(8).expect("single footer pass");
    assert_eq!(progress.completed_member_count, 2);
    corrupt_footer_magic(&second);

    let reader = inspector
        .into_window_reader()
        .expect("reader reuses schemas accumulated during inspection");

    assert_eq!(reader.summary().member_count, 2);
}

#[test]
fn prepared_dataset_view_preserves_native_order_across_parallel_row_group_scans() {
    let directory = TempDir::new().expect("dataset directory");
    write_ordered_member(&directory.path().join("a.parquet"), 0, 3, 64);
    write_ordered_member(&directory.path().join("b.parquet"), 1_000, 3, 64);
    write_ordered_member(&directory.path().join("c.parquet"), 2_000, 3, 64);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let key = column_index(&reader, "key");
    let id = column_index(&reader, "id");
    let file = column_index(&reader, "file");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, key),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb768,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let crossing = decode_one(
        &view
            .fetch_window_fields(180, 40, &field_paths(&reader, &[file, id]))
            .expect("cross-member page"),
    );
    assert_eq!(
        string_values(&crossing, 0),
        [Some("a.parquet"); 12]
            .into_iter()
            .chain([Some("b.parquet"); 28])
            .collect::<Vec<_>>()
    );
    assert_eq!(
        int64_values(&crossing, 1),
        (180..192).chain(1_000..1_028).collect::<Vec<_>>()
    );

    let mut actual = int64_values(
        &decode_one(
            &view
                .fetch_window_fields(0, 512, &field_paths(&reader, &[id]))
                .expect("first prepared page"),
        ),
        0,
    );
    actual.extend(int64_values(
        &decode_one(
            &view
                .fetch_window_fields(512, 64, &field_paths(&reader, &[id]))
                .expect("last prepared page"),
        ),
        0,
    ));
    let expected = (0..192)
        .chain(1_000..1_192)
        .chain(2_000..2_192)
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

#[test]
fn prepared_dataset_view_preserves_union_schema_after_partition_pruning() {
    let directory = TempDir::new().expect("dataset directory");
    write_columns(
        &directory.path().join("year=2025/a.parquet"),
        vec![("value", Arc::new(Int32Array::from(vec![1_i32])) as ArrayRef)],
    );
    write_columns(
        &directory.path().join("year=2026/b.parquet"),
        vec![
            ("value", Arc::new(Int64Array::from(vec![2_i64])) as ArrayRef),
            ("later", Arc::new(Int64Array::from(vec![9_i64])) as ArrayRef),
        ],
    );
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let later = column_index(&reader, "later");
    let year = column_index(&reader, "year");
    let filter = DataFilter {
        field_path: field_path(&reader, year),
        json_target: None,
        operator: DataFilterOperator::Equals,
        values: vec!["2025".to_owned()],
        match_case: false,
    };
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[filter],
        &[DataSort {
            field_path: field_path(&reader, value),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let batch = decode_one(
        &view
            .fetch_window_fields(0, 4, &field_paths(&reader, &[value, later]))
            .expect("pruned union window"),
    );
    assert_eq!(integer_optional_values(&batch, 0), [Some(1)]);
    assert_eq!(integer_optional_values(&batch, 1), [None]);
}

#[test]
fn prepared_dataset_sparse_rows_preserve_nested_union_schema() {
    let directory = TempDir::new().expect("dataset directory");
    write_columns(
        &directory.path().join("a.parquet"),
        vec![
            ("key", Arc::new(Int64Array::from(vec![2])) as ArrayRef),
            ("items", list_struct_a(11)),
        ],
    );
    write_columns(
        &directory.path().join("b.parquet"),
        vec![
            ("key", Arc::new(Int64Array::from(vec![1])) as ArrayRef),
            ("items", list_struct_a_b(22, 33)),
        ],
    );
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let key = column_index(&reader, "key");
    let items = column_index(&reader, "items");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, key),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let batch = decode_one(
        &view
            .fetch_window_fields(0, 2, &field_paths(&reader, &[items, key]))
            .expect("nested sparse window"),
    );
    let schema = batch.schema();
    let DataType::List(item) = schema.field(0).data_type() else {
        panic!("expected list column");
    };
    let DataType::Struct(fields) = item.data_type() else {
        panic!("expected list struct item");
    };
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0].name(), "a");
    assert_eq!(fields[0].data_type(), &DataType::Int64);
    assert_eq!(fields[1].name(), "b");
    assert_eq!(int64_values(&batch, 1), [1, 2]);
}

#[test]
fn prepared_dataset_view_offsets_are_relative_to_pruned_candidates() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("year=2024/a.parquet"), "value", &[]);
    write_ints(&directory.path().join("year=2025/b.parquet"), "value", &[9]);
    write_ints(
        &directory.path().join("year=2026/c.parquet"),
        "value",
        &[4, 5],
    );
    write_ints(
        &directory.path().join("year=2025/d.parquet"),
        "value",
        &[10],
    );
    write_ints(&directory.path().join("year=2026/e.parquet"), "value", &[6]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let year = column_index(&reader, "year");
    let file = column_index(&reader, "file");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[DataFilter {
            field_path: field_path(&reader, year),
            json_target: None,
            operator: DataFilterOperator::Equals,
            values: vec!["2026".to_owned()],
            match_case: false,
        }],
        &[DataSort {
            field_path: field_path(&reader, value),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let batch = decode_one(
        &view
            .fetch_window_fields(0, 8, &field_paths(&reader, &[file, value]))
            .expect("pruned candidate window"),
    );
    assert_eq!(
        string_values(&batch, 0),
        [
            Some("year=2026/c.parquet"),
            Some("year=2026/c.parquet"),
            Some("year=2026/e.parquet")
        ]
    );
    assert_eq!(int64_values(&batch, 1), [4, 5, 6]);

    let empty = DataViewBuilder::for_dataset(
        &reader,
        &[DataFilter {
            field_path: field_path(&reader, year),
            json_target: None,
            operator: DataFilterOperator::Equals,
            values: vec!["2099".to_owned()],
            match_case: false,
        }],
        &[],
        DataViewMemoryLimit::Mb384,
    )
    .expect("empty dataset view builder")
    .build()
    .expect("empty prepared dataset view");
    assert_eq!(empty.row_count(), 0);
    let mut stream = StreamReader::try_new(
        Cursor::new(empty.fetch_window(0, 8).expect("empty prepared window")),
        None,
    )
    .expect("empty Arrow stream");
    assert_eq!(
        stream.schema().fields().len(),
        reader.summary().schema.len()
    );
    assert!(stream.next().is_none());
}

#[test]
fn prepared_dataset_view_honors_cancellation_and_the_source_change_latch() {
    let directory = TempDir::new().expect("dataset directory");
    let first = directory.path().join("a.parquet");
    let second = directory.path().join("b.parquet");
    write_ints(&first, "value", &[1]);
    write_ints(&second, "value", &[2]);
    let source = DatasetSource::open_folder(directory.path()).expect("folder dataset");
    let reader = complete_reader(source.clone());

    let cancelled = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, 0),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder");
    cancelled.interrupt_handle().interrupt();
    assert!(matches!(
        cancelled.build(),
        Err(DataViewError::Engine(DataWindowError::Cancelled))
    ));

    let invalid_filter = DataViewBuilder::for_dataset(
        &reader,
        &[DataFilter {
            field_path: field_path(&reader, 0),
            json_target: None,
            operator: DataFilterOperator::TextContains,
            values: vec!["1".to_owned()],
            match_case: false,
        }],
        &[],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder");
    assert!(matches!(
        invalid_filter.build(),
        Err(DataViewError::Engine(DataWindowError::InvalidFilter))
    ));

    let builder = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, 0),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder");
    write_ints(&second, "value", &[3, 4]);
    assert!(matches!(
        builder.build(),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    ));
    assert!(matches!(
        DataViewBuilder::for_dataset(&reader, &[], &[], DataViewMemoryLimit::Mb384),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    ));
}

#[test]
fn prepared_dataset_view_checks_only_members_in_each_window() {
    let directory = TempDir::new().expect("dataset directory");
    let first = directory.path().join("a.parquet");
    let second = directory.path().join("b.parquet");
    write_ints(&first, "value", &[1]);
    write_ints(&second, "value", &[2]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            field_path: field_path(&reader, 0),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    write_ints(&second, "value", &[3]);
    assert_eq!(
        int64_values(
            &decode_one(
                &view
                    .fetch_window(0, 1)
                    .expect("window does not touch changed member"),
            ),
            0,
        ),
        [1]
    );
    assert!(matches!(
        view.fetch_window(1, 1),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    ));
    assert!(matches!(
        view.fetch_window(0, 1),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    ));
}

#[test]
fn prepared_grid_and_full_view_export_read_only_selected_source_row_groups() {
    let directory = TempDir::new().expect("dataset directory");
    let member = directory.path().join("part.parquet");
    write_prunable_row_groups(&member, 8);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let key = column_index(&reader, "key");
    let payload = column_index(&reader, "payload");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[filter(&reader, key, DataFilterOperator::LessThan, &["8"])],
        &[DataSort {
            field_path: field_path(&reader, key),
            json_target: None,
            direction: DataSortDirection::Descending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    corrupt_column_data(&member, 1, 1);

    let batch = decode_one(
        &view
            .fetch_window_fields(0, 8, &field_paths(&reader, &[payload]))
            .expect("selected row-group window"),
    );
    assert_eq!(
        int64_values(&batch, 0),
        (0..8_i64).rev().collect::<Vec<_>>()
    );

    let target = directory.path().join("filtered-view.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![payload], Vec::new()),
        Some(view.export_snapshot()),
    )
    .expect("prepared dataset export")
    .export()
    .expect("full filtered view export");
    assert_eq!(
        fs::read_to_string(target).expect("filtered view CSV"),
        "payload\r\n7\r\n6\r\n5\r\n4\r\n3\r\n2\r\n1\r\n0\r\n"
    );
}

#[test]
fn exports_whole_dataset_with_union_partition_and_file_columns_in_native_order() {
    let directory = TempDir::new().expect("dataset directory");
    write_columns(
        &directory.path().join("year=2025/a.parquet"),
        vec![
            (
                "value",
                Arc::new(Int64Array::from(vec![2_i64, 1])) as ArrayRef,
            ),
            (
                "note",
                Arc::new(StringArray::from(vec![Some("alpha"), None])) as ArrayRef,
            ),
        ],
    );
    write_ints(&directory.path().join("year=2026/b.parquet"), "value", &[3]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let target = directory.path().join("whole.csv");
    let request = dataset_csv_request(
        &reader,
        [&reader, &reader, &reader, &reader]
            .into_iter()
            .zip(["value", "note", "year", "file"])
            .map(|(reader, name)| column_index(reader, name))
            .collect(),
        vec![],
    );

    let bytes = DataExportReader::for_dataset(&reader, target.clone(), request, None)
        .expect("dataset export reader")
        .export()
        .expect("whole dataset export");
    let csv = fs::read_to_string(&target).expect("exported CSV");

    assert_eq!(bytes, csv.len() as u64);
    assert_eq!(
        csv,
        "value,note,year,file\r\n\
         2,alpha,2025,year=2025/a.parquet\r\n\
         1,,2025,year=2025/a.parquet\r\n\
         3,,2026,year=2026/b.parquet\r\n"
    );

    let ranged_target = directory.path().join("whole-range.csv");
    DataExportReader::for_dataset(
        &reader,
        ranged_target.clone(),
        dataset_csv_request(
            &reader,
            vec![
                column_index(&reader, "value"),
                column_index(&reader, "file"),
            ],
            vec![ExportRowRange { start: 1, end: 3 }],
        ),
        None,
    )
    .expect("ranged dataset export reader")
    .export()
    .expect("ranged whole dataset export");
    assert_eq!(
        fs::read_to_string(ranged_target).expect("ranged exported CSV"),
        "value,file\r\n1,year=2025/a.parquet\r\n3,year=2026/b.parquet\r\n"
    );
}

#[test]
fn exports_dataset_view_ranges_in_exact_filtered_and_sorted_order() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "value", &[3, 1]);
    write_ints(&directory.path().join("b.parquet"), "value", &[2, 1]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let value = column_index(&reader, "value");
    let file = column_index(&reader, "file");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[DataFilter {
            field_path: field_path(&reader, value),
            json_target: None,
            operator: DataFilterOperator::LessThanOrEqual,
            values: vec!["2".to_owned()],
            match_case: false,
        }],
        &[DataSort {
            field_path: field_path(&reader, value),
            json_target: None,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let target = directory.path().join("view.csv");
    let request = dataset_csv_request(
        &reader,
        vec![file, value],
        vec![ExportRowRange { start: 1, end: 3 }],
    );

    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        request,
        Some(view.export_snapshot()),
    )
    .expect("dataset view export reader")
    .export()
    .expect("dataset view export");

    assert_eq!(
        fs::read_to_string(target).expect("exported CSV"),
        "file,value\r\nb.parquet,1\r\nb.parquet,2\r\n"
    );
}

#[test]
fn dataset_export_rejects_foreign_views_member_targets_and_preserves_cancelled_targets() {
    let first_directory = TempDir::new().expect("first dataset directory");
    let first_member = first_directory.path().join("part.parquet");
    write_ints(&first_member, "value", &[1]);
    let first = complete_reader(
        DatasetSource::open_folder(first_directory.path()).expect("first folder dataset"),
    );
    let second_directory = TempDir::new().expect("second dataset directory");
    write_ints(&second_directory.path().join("part.parquet"), "value", &[1]);
    let second = complete_reader(
        DatasetSource::open_folder(second_directory.path()).expect("second folder dataset"),
    );
    let view = DataViewBuilder::for_dataset(&first, &[], &[], DataViewMemoryLimit::Mb384)
        .expect("dataset view builder")
        .build()
        .expect("prepared dataset view");
    let request = dataset_csv_request(&first, vec![column_index(&first, "value")], vec![]);

    assert!(matches!(
        DataExportReader::for_dataset(
            &second,
            second_directory.path().join("foreign.csv"),
            request.clone(),
            Some(view.export_snapshot()),
        ),
        Err(DataExportError::InvalidRequest)
    ));
    let reopened = complete_reader(
        DatasetSource::open_folder(first_directory.path()).expect("reopened folder dataset"),
    );
    assert!(matches!(
        DataExportReader::for_dataset(
            &reopened,
            first_directory.path().join("reopened.csv"),
            request.clone(),
            Some(view.export_snapshot()),
        ),
        Err(DataExportError::InvalidRequest)
    ));
    assert!(matches!(
        DataExportReader::for_dataset(&first, first_member.clone(), request.clone(), None),
        Err(DataExportError::InvalidRequest)
    ));
    #[cfg(unix)]
    {
        let alias = first_directory.path().join("member-alias.parquet");
        std::os::unix::fs::symlink(&first_member, &alias).expect("member alias");
        assert!(matches!(
            DataExportReader::for_dataset(&first, alias, request.clone(), None),
            Err(DataExportError::InvalidRequest)
        ));
        let hardlink = first_directory.path().join("member-hardlink.parquet");
        fs::hard_link(&first_member, &hardlink).expect("member hardlink");
        let source_bytes = fs::read(&first_member).expect("source bytes before rejection");
        assert!(matches!(
            DataExportReader::for_dataset(&first, hardlink, request.clone(), None),
            Err(DataExportError::InvalidRequest)
        ));
        assert_eq!(
            fs::read(&first_member).expect("source bytes after rejection"),
            source_bytes
        );
    }

    let target = first_directory.path().join("cancelled.csv");
    fs::write(&target, "keep\n").expect("existing target");
    let export = DataExportReader::for_dataset(&first, target.clone(), request, None)
        .expect("dataset export reader");
    export.cancellation().cancel();
    assert!(matches!(export.export(), Err(DataExportError::Cancelled)));
    assert_eq!(
        fs::read_to_string(target).expect("preserved target"),
        "keep\n"
    );
}

#[test]
fn dataset_statistics_and_suggestions_cover_union_partition_and_file_columns() {
    let directory = TempDir::new().expect("dataset directory");
    write_columns(
        &directory.path().join("year=2025/a.parquet"),
        vec![
            (
                "value",
                Arc::new(Int32Array::from(vec![1_i32, 2])) as ArrayRef,
            ),
            (
                "label",
                Arc::new(StringArray::from(vec![Some("alpha"), None])) as ArrayRef,
            ),
        ],
    );
    write_columns(
        &directory.path().join("year=2026/b.parquet"),
        vec![("value", Arc::new(Int64Array::from(vec![3_i64])) as ArrayRef)],
    );
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));

    let label_statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("dataset statistics reader")
        .fetch(&FieldPath::from("label"), true)
        .expect("label statistics");
    assert_eq!(label_statistics.minimum.as_deref(), Some("alpha"));
    assert_eq!(label_statistics.maximum.as_deref(), Some("alpha"));
    assert_eq!(label_statistics.null_share, 2.0 / 3.0);
    assert_eq!(label_statistics.approximate_distinct_count, Some(1));

    let value_statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("dataset statistics reader")
        .fetch(&FieldPath::from("value"), true)
        .expect("promoted numeric statistics");
    assert_eq!(value_statistics.minimum.as_deref(), Some("1"));
    assert_eq!(value_statistics.maximum.as_deref(), Some("3"));

    let file_statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("dataset statistics reader")
        .fetch(&FieldPath::from("file"), true)
        .expect("file statistics");
    assert_eq!(
        file_statistics.minimum.as_deref(),
        Some("year=2025/a.parquet")
    );
    assert_eq!(
        file_statistics.maximum.as_deref(),
        Some("year=2026/b.parquet")
    );
    assert_eq!(file_statistics.null_share, 0.0);

    let suggestions =
        TextValueSuggestionsReader::for_dataset(&reader).expect("dataset suggestion reader");
    let handle = suggestions.interrupt_handle();
    assert_eq!(
        suggestions
            .fetch(
                "alp",
                &FieldPath::from("label"),
                DataFilterOperator::TextContains,
                &handle,
            )
            .expect("label suggestions")
            .values,
        ["alpha"]
    );
    let handle = suggestions.interrupt_handle();
    assert_eq!(
        suggestions
            .fetch(
                "2026",
                &FieldPath::from("file"),
                DataFilterOperator::TextContains,
                &handle,
            )
            .expect("file suggestions")
            .values,
        ["year=2026/b.parquet"]
    );
    let year = reader
        .summary()
        .schema
        .get(column_index(&reader, "year") as usize)
        .expect("year schema");
    assert_eq!(year.physical_type, "INT64");
    let handle = suggestions.interrupt_handle();
    assert_eq!(
        suggestions.fetch(
            "2025",
            &FieldPath::from("year"),
            DataFilterOperator::TextContains,
            &handle,
        ),
        Err(DataWindowError::InvalidFilter)
    );
    let cancelled = suggestions.interrupt_handle();
    cancelled.interrupt();
    assert!(matches!(
        suggestions.fetch(
            "",
            &FieldPath::from("file"),
            DataFilterOperator::TextContains,
            &cancelled,
        ),
        Err(DataWindowError::Cancelled)
    ));
}

#[test]
fn dataset_operations_diagnose_only_scanned_members_and_latch_selected_corruption() {
    let directory = TempDir::new().expect("dataset directory");
    let pruned = directory.path().join("year=2025/a.parquet");
    write_ints(&pruned, "value", &[1]);
    write_ints(&directory.path().join("year=2026/b.parquet"), "value", &[2]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));
    let year = column_index(&reader, "year");
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[equals(&reader, year, "2026")],
        &[],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    corrupt_first_column_data(&pruned);

    let cancelled_statistics =
        ColumnStatisticsReader::for_dataset(&reader).expect("dataset statistics reader");
    cancelled_statistics.interrupt_handle().interrupt();
    assert!(matches!(
        cancelled_statistics.fetch(&FieldPath::from("value"), true),
        Err(viewda_data_engine::ColumnStatisticsError::QueryFailed)
    ));

    let target = directory.path().join("pruned.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(&reader, vec![column_index(&reader, "value")], vec![]),
        Some(view.export_snapshot()),
    )
    .expect("pruned view export reader")
    .export()
    .expect("unscanned damaged member must not affect the view query");
    assert_eq!(
        fs::read_to_string(target).expect("pruned export"),
        "value\r\n2\r\n"
    );

    assert!(matches!(
        ColumnStatisticsReader::for_dataset(&reader)
            .expect("dataset statistics reader")
            .fetch(&FieldPath::from("value"), true),
        Err(viewda_data_engine::ColumnStatisticsError::CorruptSource)
    ));
    assert!(matches!(
        ColumnStatisticsReader::for_dataset(&reader),
        Err(viewda_data_engine::ColumnStatisticsError::CorruptSource)
    ));
}

#[test]
fn selected_dataset_member_snapshot_is_stable_and_loads_structure_without_an_absolute_name() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a/part.parquet"), "value", &[1]);
    write_ints(&directory.path().join("b/part.parquet"), "value", &[2, 3]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));

    let selected = reader.member_snapshot(1).expect("selected member snapshot");
    let structure = StructureReader::from_snapshot(
        selected.snapshot(),
        &StructureLoadProgress::default(),
        &StructureCancellation::default(),
    )
    .expect("selected member structure");
    assert_eq!(structure.summary().row_count, 2);
    selected.validate().expect("unchanged selected member");
    assert_eq!(
        reader.member_snapshot_while(1, || false).err(),
        Some(DatasetError::Cancelled)
    );
    let mut validation_polls = 0;
    assert_eq!(
        selected.validate_while(|| {
            validation_polls += 1;
            validation_polls == 1
        }),
        Err(DatasetError::Cancelled)
    );
    selected
        .validate()
        .expect("cancellation does not latch a source failure");
    assert!(matches!(
        reader.member_snapshot(2),
        Err(DatasetError::Unsupported)
    ));
    fs::remove_file(directory.path().join("a/part.parquet")).expect("delete unrelated member");
    selected
        .validate()
        .expect("unrelated member does not invalidate selected snapshot");
    reader
        .member_snapshot(1)
        .expect("unrelated member does not block selected snapshot");
    fs::remove_file(directory.path().join("b/part.parquet")).expect("delete selected member");
    assert_eq!(
        selected.validate(),
        Err(DatasetError::SourceChanged {
            member: "b/part.parquet".to_owned(),
        })
    );
}

fn dataset_csv_request(
    reader: &DatasetWindowReader,
    column_indices: Vec<u32>,
    row_ranges: Vec<ExportRowRange>,
) -> DataExportRequest {
    DataExportRequest {
        field_paths: field_paths(reader, &column_indices),
        row_ranges,
        output: DataExportFormat::Csv {
            options: CsvExportOptions::default(),
        },
    }
}

fn write_ints(path: &std::path::Path, name: &str, values: &[i64]) {
    write_columns(
        path,
        vec![(name, Arc::new(Int64Array::from(values.to_vec())))],
    );
}

fn list_struct_a(value: i32) -> ArrayRef {
    let mut builder = ListBuilder::new(StructBuilder::from_fields(
        vec![Field::new("a", DataType::Int32, true)],
        1,
    ));
    builder
        .values()
        .field_builder::<Int32Builder>(0)
        .expect("field a")
        .append_value(value);
    builder.values().append(true);
    builder.append(true);
    Arc::new(builder.finish())
}

fn list_struct_a_b(a: i64, b: i32) -> ArrayRef {
    let mut builder = ListBuilder::new(StructBuilder::from_fields(
        vec![
            Field::new("a", DataType::Int64, true),
            Field::new("b", DataType::Int32, true),
        ],
        1,
    ));
    builder
        .values()
        .field_builder::<Int64Builder>(0)
        .expect("field a")
        .append_value(a);
    builder
        .values()
        .field_builder::<Int32Builder>(1)
        .expect("field b")
        .append_value(b);
    builder.values().append(true);
    builder.append(true);
    Arc::new(builder.finish())
}

fn write_ordered_member(path: &std::path::Path, first_id: i64, groups: usize, rows: usize) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture directory");
    let schema = Arc::new(Schema::new(vec![
        Field::new("key", arrow_schema::DataType::Int64, false),
        Field::new("id", arrow_schema::DataType::Int64, false),
    ]));
    let file = std::fs::File::create(path).expect("fixture file");
    let mut writer = ArrowWriter::try_new(file, Arc::clone(&schema), None).expect("Parquet writer");
    for group in 0..groups {
        let group_start = first_id + i64::try_from(group * rows).expect("row group offset");
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(vec![1; rows])),
                Arc::new(Int64Array::from_iter_values(
                    group_start..group_start + i64::try_from(rows).expect("row count"),
                )),
            ],
        )
        .expect("record batch");
        writer.write(&batch).expect("member rows");
        writer.flush().expect("row group");
    }
    writer.close().expect("member footer");
}

fn write_prunable_row_groups(path: &std::path::Path, rows_per_group: usize) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture directory");
    let schema = Arc::new(Schema::new(vec![
        Field::new("key", DataType::Int64, false),
        Field::new("payload", DataType::Int64, false),
    ]));
    let file = fs::File::create(path).expect("fixture file");
    let mut writer = ArrowWriter::try_new(file, Arc::clone(&schema), None).expect("Parquet writer");
    for group in 0..2 {
        let start = i64::try_from(group * rows_per_group).expect("row group start");
        let end = start + i64::try_from(rows_per_group).expect("row group rows");
        let values = (start..end).collect::<Vec<_>>();
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(values.clone())),
                Arc::new(Int64Array::from(values)),
            ],
        )
        .expect("record batch");
        writer.write(&batch).expect("member rows");
        writer.flush().expect("row group");
    }
    writer.close().expect("member footer");
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

fn case_drift_profile(address: &str, city: &str, value: &str) -> ArrayRef {
    let address_array = StructArray::from(vec![(
        Arc::new(Field::new(city, DataType::Utf8, true)),
        Arc::new(StringArray::from(vec![value])) as ArrayRef,
    )]);
    Arc::new(StructArray::from(vec![(
        Arc::new(Field::new(address, address_array.data_type().clone(), true)),
        Arc::new(address_array) as ArrayRef,
    )]))
}

fn corrupt_first_column_data(path: &std::path::Path) {
    corrupt_column_data(path, 0, 0);
}

fn corrupt_column_data(path: &std::path::Path, row_group: usize, column_index: usize) {
    let metadata = fs::metadata(path).expect("member metadata");
    let modified = metadata.modified().expect("member modification time");
    let reader = SerializedFileReader::new(fs::File::open(path).expect("member file"))
        .expect("Parquet metadata");
    let column = reader.metadata().row_group(row_group).column(column_index);
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

fn corrupt_footer_magic(path: &std::path::Path) {
    let metadata = fs::metadata(path).expect("member metadata");
    let modified = metadata.modified().expect("member modification time");
    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .expect("writable member");
    file.seek(SeekFrom::End(-4)).expect("footer magic seek");
    file.write_all(b"BAD!").expect("overwrite footer magic");
    file.flush().expect("flush damaged footer");
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

fn timestamp_nanosecond_values(batch: &RecordBatch, column: usize) -> Vec<i64> {
    batch
        .column(column)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .expect("nanosecond timestamp column")
        .values()
        .to_vec()
}

fn date32_values(batch: &RecordBatch, column: usize) -> Vec<i32> {
    batch
        .column(column)
        .as_any()
        .downcast_ref::<Date32Array>()
        .expect("date column")
        .values()
        .to_vec()
}

fn decimal128_values(batch: &RecordBatch, column: usize) -> Vec<i128> {
    batch
        .column(column)
        .as_any()
        .downcast_ref::<Decimal128Array>()
        .expect("decimal column")
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
