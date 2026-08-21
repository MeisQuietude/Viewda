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
    ColumnStatisticsReader, CsvExportOptions, DataExportError, DataExportFormat, DataExportReader,
    DataExportRequest, DataFilter, DataFilterOperator, DataSort, DataSortDirection,
    DataViewBuilder, DataViewError, DataViewMemoryLimit, DataWindowError, DatasetError,
    DatasetPartitionNode, DatasetPartitionPage, DatasetSource, DatasetWindowReader, ExportRowRange,
    PartitionValue, StructureCancellation, StructureLoadProgress, StructureReader,
    TextValueSuggestionsReader,
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
            .fetch_columns(0, 8, &[], &[file_index, 0])
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
            .fetch_columns(0, 1, &[], &[late_index])
            .expect("late column window"),
    );
    assert_eq!(int64_values(&batch, 0), [299]);

    let target = directory.path().join("late.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(vec![late_index], vec![]),
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

    let batch = decode_one(&reader.fetch(0, 16, &[]).expect("exact paths"));
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

    let view = DataViewBuilder::for_dataset(
        &reader,
        &[],
        &[DataSort {
            source_index: 1,
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
fn member_row_offsets_follow_frozen_order_across_empty_members() {
    let directory = TempDir::new().expect("dataset directory");
    write_ints(&directory.path().join("a.parquet"), "id", &[10, 11]);
    write_ints(&directory.path().join("b.parquet"), "id", &[]);
    write_ints(&directory.path().join("c.parquet"), "id", &[20, 21, 22]);
    let reader =
        complete_reader(DatasetSource::open_folder(directory.path()).expect("folder dataset"));

    assert_eq!(reader.member_row_offset(0), Ok(0));
    assert_eq!(reader.member_row_offset(1), Ok(2));
    assert_eq!(reader.member_row_offset(2), Ok(2));
    assert_eq!(reader.member_row_offset(3), Err(DatasetError::Unsupported));
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
            source_index: value,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let batch = decode_one(
        &view
            .fetch_window_columns(0, 8, &[file, year, value])
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
        string_values(&batch, 1),
        [
            Some("2025"),
            Some("2025"),
            Some("2026"),
            Some("2025"),
            Some("2026")
        ]
    );
    assert_eq!(int64_values(&batch, 2), [1, 1, 1, 2, 3]);
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
            source_index: key,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb768,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let crossing = decode_one(
        &view
            .fetch_window_columns(180, 40, &[file, id])
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
                .fetch_window_columns(0, 512, &[id])
                .expect("first prepared page"),
        ),
        0,
    );
    actual.extend(int64_values(
        &decode_one(
            &view
                .fetch_window_columns(512, 64, &[id])
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
        column_index: year,
        operator: DataFilterOperator::Equals,
        values: vec!["2025".to_owned()],
        match_case: false,
    };
    let view = DataViewBuilder::for_dataset(
        &reader,
        &[filter],
        &[DataSort {
            source_index: value,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    let batch = decode_one(
        &view
            .fetch_window_columns(0, 4, &[value, later])
            .expect("pruned union window"),
    );
    assert_eq!(integer_optional_values(&batch, 0), [Some(1)]);
    assert_eq!(integer_optional_values(&batch, 1), [None]);
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
            column_index: year,
            operator: DataFilterOperator::Equals,
            values: vec!["2026".to_owned()],
            match_case: false,
        }],
        &[DataSort {
            source_index: value,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let batch = decode_one(
        &view
            .fetch_window_columns(0, 8, &[file, value])
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
            column_index: year,
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
            source_index: 0,
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
            column_index: 0,
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
            source_index: 0,
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
fn prepared_dataset_view_rechecks_all_members_before_each_window() {
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
            source_index: 0,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");

    write_ints(&second, "value", &[3, 4]);
    assert!(matches!(
        view.fetch_window(0, 2),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    ));
    assert!(matches!(
        view.fetch_window(0, 2),
        Err(DataViewError::Engine(DataWindowError::SourceChanged))
    ));
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
            column_index: value,
            operator: DataFilterOperator::LessThanOrEqual,
            values: vec!["2".to_owned()],
            match_case: false,
        }],
        &[DataSort {
            source_index: value,
            direction: DataSortDirection::Ascending,
        }],
        DataViewMemoryLimit::Mb384,
    )
    .expect("dataset view builder")
    .build()
    .expect("prepared dataset view");
    let target = directory.path().join("view.csv");
    let request = dataset_csv_request(vec![file, value], vec![ExportRowRange { start: 1, end: 3 }]);

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
    let request = dataset_csv_request(vec![column_index(&first, "value")], vec![]);

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
        .fetch("label", true)
        .expect("label statistics");
    assert_eq!(label_statistics.minimum.as_deref(), Some("alpha"));
    assert_eq!(label_statistics.maximum.as_deref(), Some("alpha"));
    assert_eq!(label_statistics.null_share, 2.0 / 3.0);
    assert_eq!(label_statistics.approximate_distinct_count, 1);

    let value_statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("dataset statistics reader")
        .fetch("value", true)
        .expect("promoted numeric statistics");
    assert_eq!(value_statistics.minimum.as_deref(), Some("1"));
    assert_eq!(value_statistics.maximum.as_deref(), Some("3"));

    let file_statistics = ColumnStatisticsReader::for_dataset(&reader)
        .expect("dataset statistics reader")
        .fetch("file", true)
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
    let label = reader
        .summary()
        .schema
        .get(column_index(&reader, "label") as usize)
        .expect("label schema");
    let handle = suggestions.interrupt_handle();
    assert_eq!(
        suggestions
            .fetch("alp", label, DataFilterOperator::TextContains, &handle)
            .expect("label suggestions")
            .values,
        ["alpha"]
    );
    let file = reader
        .summary()
        .schema
        .get(column_index(&reader, "file") as usize)
        .expect("file schema");
    let handle = suggestions.interrupt_handle();
    assert_eq!(
        suggestions
            .fetch("2026", file, DataFilterOperator::TextContains, &handle)
            .expect("file suggestions")
            .values,
        ["year=2026/b.parquet"]
    );
    let year = reader
        .summary()
        .schema
        .get(column_index(&reader, "year") as usize)
        .expect("year schema");
    let handle = suggestions.interrupt_handle();
    assert_eq!(
        suggestions
            .fetch("2025", year, DataFilterOperator::Equals, &handle)
            .expect("partition suggestions")
            .values,
        ["2025"]
    );
    let cancelled = suggestions.interrupt_handle();
    cancelled.interrupt();
    assert!(matches!(
        suggestions.fetch("", file, DataFilterOperator::TextContains, &cancelled),
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
        &[equals(year, "2026")],
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
        cancelled_statistics.fetch("value", true),
        Err(viewda_data_engine::ColumnStatisticsError::QueryFailed)
    ));

    let target = directory.path().join("pruned.csv");
    DataExportReader::for_dataset(
        &reader,
        target.clone(),
        dataset_csv_request(vec![column_index(&reader, "value")], vec![]),
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
            .fetch("value", true),
        Err(viewda_data_engine::ColumnStatisticsError::CorruptSource)
    ));
    assert!(matches!(
        ColumnStatisticsReader::for_dataset(&reader),
        Err(viewda_data_engine::ColumnStatisticsError::SourceChanged)
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
    assert_eq!(selected.ordinal(), 1);
    assert_eq!(selected.relative_path(), "b/part.parquet");
    let structure = StructureReader::from_snapshot(
        selected.snapshot(),
        &StructureLoadProgress::default(),
        &StructureCancellation::default(),
    )
    .expect("selected member structure");
    assert_eq!(structure.summary().row_count, 2);
    selected.validate().expect("unchanged selected member");
    assert!(matches!(
        reader.member_snapshot(2),
        Err(DatasetError::Unsupported)
    ));
    let replacement = directory.path().join("replacement.parquet");
    write_ints(&replacement, "value", &[9]);
    fs::rename(replacement, directory.path().join("a/part.parquet"))
        .expect("replace unrelated member");
    assert_eq!(
        selected.validate(),
        Err(DatasetError::SourceChanged {
            member: "a/part.parquet".to_owned(),
        })
    );
}

fn dataset_csv_request(
    column_indices: Vec<u32>,
    row_ranges: Vec<ExportRowRange>,
) -> DataExportRequest {
    DataExportRequest {
        column_indices,
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
