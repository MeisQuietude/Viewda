//! Footer-only structure facts read from generated Parquet fixtures.

use std::{fs, path::Path, sync::Arc};

use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use parquet::{
    arrow::ArrowWriter,
    basic::{Compression, ZstdLevel},
    file::{
        metadata::KeyValue,
        properties::{EnabledStatistics, WriterProperties},
    },
    schema::types::ColumnPath,
};
use tempfile::NamedTempFile;
use viewda_data_engine::{
    StructureBloomProbeOutcome, StructureByteUnit, StructureCancellation, StructureColumnSort,
    StructureError, StructureLoadProgress, StructureReader, StructureRowGroupSort,
    StructureSortDirection, inspect_local_source_snapshot,
};

#[test]
fn source_summary_and_structure_share_the_opened_file_snapshot() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .build(),
    );
    let (summary, snapshot) =
        inspect_local_source_snapshot(source.path()).expect("source opens once");
    let replacement = write_wide_parquet(3);
    fs::rename(replacement.path(), source.path()).expect("path can name a new inode after open");

    let reader = StructureReader::from_snapshot(
        &snapshot,
        &StructureLoadProgress::default(),
        &StructureCancellation::default(),
    )
    .expect("retained footer remains summarizable");

    assert_eq!(reader.summary().row_count, summary.row_count);
    assert_eq!(reader.summary().column_count, summary.column_count);
    assert_ne!(
        reader.summary().column_count,
        StructureReader::open(
            source.path().to_owned(),
            &StructureLoadProgress::default(),
            &StructureCancellation::default(),
        )
        .expect("replacement source opens")
        .summary()
        .column_count,
        "Structure used the retained snapshot rather than reopening the path"
    );
    let report = reader.report(StructureByteUnit::Compressed);
    assert!(report.contains(&format!("File bytes: {}", summary.size_bytes)));
    assert!(report.contains("Byte unit: compressed"));
    assert!(!report.contains("Viewda"));
    assert!(report.starts_with("# Parquet structure report\n"));
}

#[test]
fn reports_the_file_card_facts_of_a_mixed_codec_file() {
    let source = write_mixed_codec_parquet();

    let reader = open_structure(source.path());
    let summary = reader.summary();

    assert_eq!(
        summary.codecs,
        Some(vec!["snappy".to_owned(), "zstd".to_owned()])
    );
    assert_eq!(summary.row_count, 12);
    assert_eq!(summary.row_group_count, 3);
    assert_eq!(summary.column_count, 2);
    assert_eq!(summary.rows_per_row_group, Some(4.0));
    assert_eq!(summary.chunk_count, 6);
    assert_eq!(summary.chunks_with_statistics, Some(6));
    assert!(summary.chunk_aggregates_complete);
    assert_eq!(summary.unreadable_row_group_count, 0);
    assert_eq!(summary.format_version, 1);
    assert!(
        summary
            .created_by
            .as_deref()
            .is_some_and(|writer| writer.starts_with("parquet-rs")),
        "the footer names its writer: {:?}",
        summary.created_by
    );
    assert!(summary.footer_bytes > 8);
    assert!(summary.compressed_bytes > 0);
    assert_eq!(
        summary.compression_ratio,
        Some(summary.uncompressed_bytes as f64 / summary.compressed_bytes as f64)
    );

    let codec_totals = &reader.lens_totals().codecs;
    assert_eq!(
        codec_totals
            .iter()
            .map(|total| total.codec.as_str())
            .collect::<Vec<_>>(),
        vec!["snappy", "zstd"]
    );
    assert_eq!(
        codec_totals
            .iter()
            .map(|total| total.total.compressed_bytes)
            .sum::<u64>(),
        summary.compressed_bytes
    );
    assert_eq!(
        codec_totals
            .iter()
            .map(|total| total.total.chunk_count)
            .sum::<u64>(),
        summary.chunk_count
    );
}

#[test]
fn states_that_no_chunk_carries_statistics_when_the_writer_stored_none() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_statistics_enabled(EnabledStatistics::None)
            .set_max_row_group_row_count(Some(4))
            .build(),
    );

    let reader = open_structure(source.path());

    assert_eq!(reader.summary().chunks_with_statistics, Some(0));
    assert_eq!(reader.summary().chunk_count, 6);
    assert_eq!(reader.lens_totals().statistics.present.chunk_count, 0);
    assert_eq!(reader.lens_totals().statistics.absent.chunk_count, 6);
    assert_eq!(
        reader
            .chunk_details(0, 0)
            .expect("chunk details load")
            .statistics,
        None
    );
}

#[test]
fn answers_bloom_probes_per_row_group_and_names_columns_without_a_filter() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .set_column_bloom_filter_enabled(ColumnPath::from("name"), true)
            .build(),
    );
    let reader = open_structure(source.path());
    let cancellation = StructureCancellation::default();

    let present = reader
        .probe_bloom_filter(1, "name-0", 0, 16, &cancellation)
        .expect("probing a filtered column succeeds");
    assert_eq!(
        present
            .row_groups
            .iter()
            .map(|result| result.outcome)
            .collect::<Vec<_>>(),
        vec![
            StructureBloomProbeOutcome::MayContain,
            StructureBloomProbeOutcome::DefinitelyAbsent,
            StructureBloomProbeOutcome::DefinitelyAbsent,
        ]
    );
    assert_eq!(present.total_count, 3);

    let absent = reader
        .probe_bloom_filter(1, "not-in-this-file", 0, 16, &cancellation)
        .expect("probing an unwritten value succeeds");
    assert!(
        absent
            .row_groups
            .iter()
            .all(|result| result.outcome == StructureBloomProbeOutcome::DefinitelyAbsent)
    );

    let unfiltered = reader
        .probe_bloom_filter(0, "3", 0, 16, &cancellation)
        .expect("probing a column without a filter succeeds");
    assert!(
        unfiltered
            .row_groups
            .iter()
            .all(|result| result.outcome == StructureBloomProbeOutcome::NoFilter)
    );

    assert_eq!(
        reader
            .probe_bloom_filter(0, "not-a-number", 0, 16, &cancellation)
            .err(),
        Some(StructureError::InvalidProbeValue)
    );
    assert_eq!(
        reader
            .probe_bloom_filter(2, "anything", 0, 16, &cancellation)
            .err(),
        Some(StructureError::UnknownColumn)
    );

    assert!(
        reader
            .chunk_details(0, 1)
            .expect("chunk details load")
            .bloom_filter_bytes
            .is_some()
    );
    assert_eq!(
        reader
            .chunk_details(0, 0)
            .expect("chunk details load")
            .bloom_filter_bytes,
        None
    );
}

#[test]
fn bloom_probes_keep_the_opened_source_snapshot_after_path_replacement() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .set_column_bloom_filter_enabled(ColumnPath::from("name"), true)
            .build(),
    );
    let replacement = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(12))
            .build(),
    );
    let reader = open_structure(source.path());
    let moved_path = source.path().with_extension("opened.parquet");

    fs::rename(source.path(), &moved_path).expect("opened fixture can be moved");
    fs::copy(replacement.path(), source.path()).expect("path can point at a different source");

    let probe = reader
        .probe_bloom_filter(1, "name-0", 0, 16, &StructureCancellation::default())
        .expect("the retained source remains probeable");
    assert_eq!(
        probe.total_count, 3,
        "metadata and bloom bytes share one snapshot"
    );
    assert_eq!(
        probe.row_groups[0].outcome,
        StructureBloomProbeOutcome::MayContain
    );

    fs::remove_file(moved_path).expect("moved fixture can be removed");
}

#[test]
fn bloom_probes_reject_in_place_changes_to_the_retained_file() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_column_bloom_filter_enabled(ColumnPath::from("name"), true)
            .build(),
    );
    let reader = open_structure(source.path());
    let mut changed = fs::OpenOptions::new()
        .append(true)
        .open(source.path())
        .expect("source can be mutated");
    std::io::Write::write_all(&mut changed, b"changed").expect("mutate source in place");

    assert_eq!(
        reader
            .probe_bloom_filter(1, "name-0", 0, 16, &StructureCancellation::default())
            .err(),
        Some(StructureError::SourceChanged),
    );
}

#[test]
fn describes_a_file_that_holds_no_row_group() {
    let source = write_empty_parquet();

    let reader = open_structure(source.path());
    let summary = reader.summary();

    assert_eq!(summary.row_count, 0);
    assert_eq!(summary.row_group_count, 0);
    assert_eq!(summary.column_count, 2);
    assert_eq!(summary.rows_per_row_group, None);
    assert_eq!(summary.compressed_bytes, 0);
    assert_eq!(summary.compression_ratio, None);
    assert_eq!(summary.chunk_count, 0);
    assert!(
        reader
            .layout(StructureByteUnit::Compressed, 0, 16, 8, None)
            .rows
            .is_empty()
    );
    assert_eq!(
        reader.first_row_offset(0),
        Err(StructureError::UnknownRowGroup)
    );

    let columns = reader.column_page(
        StructureByteUnit::Compressed,
        StructureColumnSort::Bytes,
        StructureSortDirection::Descending,
        0,
        16,
    );
    assert_eq!(columns.total_count, 2);
    assert!(
        columns
            .columns
            .iter()
            .all(|column| column.cumulative_share == 0.0)
    );
}

#[test]
fn aligns_bounded_columns_and_conserves_one_remaining_aggregate() {
    let source = write_wide_parquet(40);

    let reader = open_structure(source.path());
    let layout = reader.layout(StructureByteUnit::Compressed, 0, 4, 5, None);

    assert_eq!(layout.rows.len(), 1);
    let row = &layout.rows[0];
    assert_eq!(row.segments.len(), 5);
    let tail = row
        .tail
        .expect("the remaining columns collapse into a tail");
    assert_eq!(tail.column_count, 35);
    assert_eq!(layout.remaining_column_count, 35);
    assert_eq!(
        layout
            .columns
            .iter()
            .map(|column| column.column_index)
            .collect::<Vec<_>>(),
        row.segments
            .iter()
            .map(|segment| segment.column_index)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        row.segments
            .iter()
            .map(|segment| segment.compressed_bytes)
            .sum::<u64>()
            + tail.compressed_bytes,
        row.compressed_bytes
    );
    assert!(row.is_readable);

    let unlimited = reader.layout(StructureByteUnit::Compressed, 0, 4, 4096, None);
    assert_eq!(unlimited.rows[0].segments.len(), 12, "engine caps columns");
}

#[test]
fn focused_tiny_column_is_named_without_changing_exact_tail_totals() {
    let source = write_wide_parquet(40);
    let reader = open_structure(source.path());
    let layout = reader.layout(StructureByteUnit::Compressed, 0, 4, 5, Some(25));
    let row = &layout.rows[0];
    let tail = row.tail.expect("unfocused columns remain collapsed");

    assert_eq!(row.segments.len(), 5);
    assert!(
        row.segments
            .iter()
            .any(|segment| segment.column_index == 25)
    );
    assert_eq!(tail.column_count, 35);
    assert_eq!(
        layout.columns.last().map(|column| column.column_index),
        Some(25),
        "the focused tail column owns the reserved last named slot"
    );
    assert_eq!(
        row.segments
            .iter()
            .map(|segment| segment.compressed_bytes)
            .sum::<u64>()
            + tail.compressed_bytes,
        row.compressed_bytes
    );
    assert!(layout.overview.len() <= 256);
    assert_eq!(
        layout.overview[0].focused_compressed_bytes,
        row.segments
            .iter()
            .find(|segment| segment.column_index == 25)
            .expect("focused segment")
            .compressed_bytes
    );
}

#[test]
fn keeps_paged_tables_inside_their_bounds() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(2))
            .build(),
    );
    let reader = open_structure(source.path());

    let all = reader.row_group_page(
        StructureByteUnit::Compressed,
        StructureRowGroupSort::Index,
        StructureSortDirection::Ascending,
        0,
        100,
    );
    assert_eq!(all.total_count, 6);
    assert_eq!(
        all.row_groups
            .iter()
            .map(|group| group.index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, 5]
    );
    assert_eq!(
        all.row_groups
            .iter()
            .map(|group| group.row_count)
            .sum::<u64>(),
        12
    );

    let window = reader.row_group_page(
        StructureByteUnit::Compressed,
        StructureRowGroupSort::Index,
        StructureSortDirection::Descending,
        1,
        2,
    );
    assert_eq!(window.offset, 1);
    assert_eq!(
        window
            .row_groups
            .iter()
            .map(|group| group.index)
            .collect::<Vec<_>>(),
        vec![4, 3]
    );

    let beyond = reader.row_group_page(
        StructureByteUnit::Compressed,
        StructureRowGroupSort::Index,
        StructureSortDirection::Ascending,
        99,
        4,
    );
    assert_eq!(beyond.offset, 6);
    assert!(beyond.row_groups.is_empty());
    assert_eq!(beyond.total_count, 6);
}

#[test]
fn maps_every_row_group_to_the_source_row_it_starts_at() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(5))
            .build(),
    );

    let reader = open_structure(source.path());

    assert_eq!(reader.summary().row_group_count, 3);
    assert_eq!(reader.first_row_offset(0), Ok(0));
    assert_eq!(reader.first_row_offset(1), Ok(5));
    assert_eq!(reader.first_row_offset(2), Ok(10));
    assert_eq!(
        reader.first_row_offset(3),
        Err(StructureError::UnknownRowGroup)
    );
}

#[test]
fn ranks_columns_by_stored_bytes() {
    let source = write_wide_parquet(4);

    let reader = open_structure(source.path());
    let page = reader.column_page(
        StructureByteUnit::Compressed,
        StructureColumnSort::Bytes,
        StructureSortDirection::Descending,
        0,
        16,
    );

    assert_eq!(page.total_count, 4);
    assert!(
        page.columns
            .windows(2)
            .all(|pair| pair[0].compressed_bytes >= pair[1].compressed_bytes)
    );
    assert_eq!(
        page.columns[0].name, "noise_0",
        "the incompressible column leads the table"
    );
    assert_eq!(
        page.columns
            .iter()
            .map(|column| column.compressed_bytes)
            .sum::<u64>(),
        reader.summary().compressed_bytes
    );
    assert!(
        page.columns[0]
            .compression_ratio
            .is_some_and(|ratio| ratio < 1.5)
    );

    let by_name = reader.column_page(
        StructureByteUnit::Compressed,
        StructureColumnSort::Name,
        StructureSortDirection::Ascending,
        0,
        16,
    );
    assert_eq!(
        by_name
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        vec!["noise_0", "noise_1", "noise_2", "noise_3"]
    );
}

#[test]
fn keeps_cumulative_share_tied_to_the_files_own_ranking() {
    let source = write_wide_parquet(4);
    let reader = open_structure(source.path());

    let ranked = reader.column_page(
        StructureByteUnit::Compressed,
        StructureColumnSort::Bytes,
        StructureSortDirection::Descending,
        0,
        16,
    );
    let cumulative = ranked
        .columns
        .iter()
        .map(|column| column.cumulative_share)
        .collect::<Vec<_>>();
    assert!(
        cumulative.windows(2).all(|pair| pair[0] <= pair[1]),
        "the running total never decreases down the ranking: {cumulative:?}"
    );
    let first_share =
        ranked.columns[0].compressed_bytes as f64 / reader.summary().compressed_bytes as f64;
    assert!((cumulative[0] - first_share).abs() < 1e-9);
    assert!((cumulative[3] - 1.0).abs() < 1e-9);

    let by_name = reader.column_page(
        StructureByteUnit::Compressed,
        StructureColumnSort::Name,
        StructureSortDirection::Ascending,
        0,
        16,
    );
    for column in &by_name.columns {
        let ranked_column = ranked
            .columns
            .iter()
            .find(|candidate| candidate.name == column.name)
            .expect("every column appears in both orderings");
        assert_eq!(
            column.cumulative_share, ranked_column.cumulative_share,
            "sorting the view never changes a column's cumulative share"
        );
    }

    let uncompressed = reader.column_page(
        StructureByteUnit::Uncompressed,
        StructureColumnSort::Bytes,
        StructureSortDirection::Descending,
        0,
        16,
    );
    assert!(
        (uncompressed
            .columns
            .last()
            .expect("the file has columns")
            .cumulative_share
            - 1.0)
            .abs()
            < 1e-9
    );
}

#[test]
fn reports_no_cumulative_share_for_a_file_without_bytes() {
    let source = write_empty_parquet();

    let page = open_structure(source.path()).column_page(
        StructureByteUnit::Compressed,
        StructureColumnSort::Bytes,
        StructureSortDirection::Descending,
        0,
        16,
    );

    assert!(
        page.columns
            .iter()
            .all(|column| column.cumulative_share == 0.0)
    );
}

#[test]
fn lists_key_value_metadata_keys_and_sizes_without_their_values() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(12))
            .set_key_value_metadata(Some(vec![
                KeyValue::new("pandas".to_owned(), Some("{\"a\": 1}".to_owned())),
                KeyValue::new("marker".to_owned(), None),
            ]))
            .build(),
    );

    let reader = open_structure(source.path());
    let entries = &reader.summary().key_value_metadata;

    let pandas = entries
        .iter()
        .find(|entry| entry.key == "pandas")
        .expect("the written key survives");
    assert_eq!(pandas.value_bytes, Some(8));
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.key == "marker")
            .expect("a valueless key survives")
            .value_bytes,
        None
    );
    assert_eq!(
        reader
            .key_value(pandas.index)
            .expect("values load on demand")
            .value,
        Some("{\"a\": 1}".to_owned())
    );
}

#[test]
fn describes_a_file_whose_data_pages_are_damaged() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .build(),
    );
    let intact = open_structure(source.path());
    let expected = intact.summary().clone();
    let expected_details = intact.chunk_details(0, 0).expect("chunk details load");

    let mut bytes = fs::read(source.path()).expect("fixture is readable");
    let first_page = usize::try_from(expected_details.data_page_offset).expect("offset fits");
    for byte in &mut bytes[first_page..first_page + 16] {
        *byte = 0;
    }
    fs::write(source.path(), &bytes).expect("fixture is writable");

    let damaged = open_structure(source.path());

    assert_eq!(damaged.summary(), &expected);
    assert_eq!(
        damaged
            .chunk_details(0, 0)
            .expect("chunk details still load"),
        expected_details
    );
}

#[test]
fn marks_footer_entries_unreadable_when_their_page_ranges_were_truncated() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .build(),
    );
    let bytes = fs::read(source.path()).expect("fixture is readable");
    let metadata_bytes = u32::from_le_bytes(
        bytes[bytes.len() - 8..bytes.len() - 4]
            .try_into()
            .expect("footer length bytes"),
    ) as usize;
    let footer_start = bytes.len() - 8 - metadata_bytes;
    let truncated = [&bytes[..4], &bytes[footer_start..]].concat();
    fs::write(source.path(), truncated).expect("fixture can lose its data pages");

    let reader = open_structure(source.path());

    assert_eq!(reader.summary().row_group_count, 3);
    assert_eq!(reader.summary().unreadable_row_group_count, 3);
    assert!(reader.summary().compressed_bytes > 0);
    assert!(
        reader
            .layout(StructureByteUnit::Compressed, 0, 16, 8, None)
            .rows
            .iter()
            .all(|row| !row.is_readable && !row.segments.is_empty()),
        "footer-recorded layout facts remain visible under the unreadable hatch"
    );
    assert_eq!(
        reader.first_row_offset(0),
        Err(StructureError::CorruptFooter),
        "Data navigation must not use an unreadable row group"
    );
}

#[test]
fn reports_chunk_facts_including_statistics_exactness() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .build(),
    );

    let reader = open_structure(source.path());
    let details = reader.chunk_details(0, 0).expect("chunk details load");

    assert_eq!(details.column_index, 0);
    assert_eq!(details.column_name, "id");
    assert_eq!(details.physical_type, "INT64");
    assert_eq!(details.codec, "uncompressed");
    assert_eq!(details.value_count, 4);
    assert!(details.data_page_offset > 0);
    let statistics = details.statistics.expect("the writer stored statistics");
    assert_eq!(statistics.minimum, Some("0".to_owned()));
    assert_eq!(statistics.maximum, Some("3".to_owned()));
    assert!(statistics.minimum_is_exact);
    assert!(statistics.maximum_is_exact);
    assert_eq!(statistics.null_count, Some(0));

    assert_eq!(
        reader.chunk_details(9, 0).err(),
        Some(StructureError::UnknownRowGroup)
    );
    assert_eq!(
        reader.chunk_details(0, 9).err(),
        Some(StructureError::UnknownColumn)
    );
}

#[test]
fn reports_progress_while_it_summarizes_row_groups() {
    let source = write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(2))
            .build(),
    );
    let progress = StructureLoadProgress::default();

    let reader = StructureReader::open(
        source.path().to_owned(),
        &progress,
        &StructureCancellation::default(),
    )
    .expect("structure opens");

    assert_eq!(
        progress.snapshot().total_row_groups,
        reader.summary().row_group_count as u64
    );
    assert_eq!(
        progress.snapshot().completed_row_groups,
        reader.summary().row_group_count as u64
    );
    assert_eq!(
        progress.snapshot().total_chunks,
        reader.summary().chunk_count
    );
    assert_eq!(
        progress.snapshot().completed_chunks,
        reader.summary().chunk_count
    );
}

fn open_structure(path: &Path) -> StructureReader {
    StructureReader::open(
        path.to_owned(),
        &StructureLoadProgress::default(),
        &StructureCancellation::default(),
    )
    .expect("structure opens")
}

fn write_parquet(properties: WriterProperties) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary file can be created");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from((0..12).collect::<Vec<_>>())) as ArrayRef,
            Arc::new(StringArray::from(
                (0..12)
                    .map(|index| format!("name-{index}"))
                    .collect::<Vec<_>>(),
            )) as ArrayRef,
        ],
    )
    .expect("record batch is valid");

    let file = source.reopen().expect("temporary file can be reopened");
    let mut writer = ArrowWriter::try_new(file, schema, Some(properties))
        .expect("Parquet writer can be created");
    writer.write(&batch).expect("record batch can be written");
    writer.close().expect("Parquet footer can be written");
    source
}

fn write_mixed_codec_parquet() -> NamedTempFile {
    write_parquet(
        WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .set_column_compression(ColumnPath::from("id"), Compression::SNAPPY)
            .set_column_compression(
                ColumnPath::from("name"),
                Compression::ZSTD(ZstdLevel::default()),
            )
            .build(),
    )
}

fn write_empty_parquet() -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary file can be created");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
    ]));
    let file = source.reopen().expect("temporary file can be reopened");
    ArrowWriter::try_new(file, schema, None)
        .expect("Parquet writer can be created")
        .close()
        .expect("Parquet footer can be written");
    source
}

/// Writes one row group whose columns carry visibly different amounts of noise,
/// so byte ranking and tail aggregation have a stable order to assert on.
fn write_wide_parquet(column_count: usize) -> NamedTempFile {
    let source = NamedTempFile::new().expect("temporary file can be created");
    let fields = (0..column_count)
        .map(|index| Field::new(format!("noise_{index}"), DataType::Utf8, false))
        .collect::<Vec<_>>();
    let schema = Arc::new(Schema::new(fields));
    let columns = (0..column_count)
        .map(|index| {
            let values = (0..64)
                .map(|row| pseudo_random_text(index, row, column_count - index))
                .collect::<Vec<_>>();
            Arc::new(StringArray::from(values)) as ArrayRef
        })
        .collect::<Vec<_>>();
    let batch = RecordBatch::try_new(Arc::clone(&schema), columns).expect("record batch is valid");

    let file = source.reopen().expect("temporary file can be reopened");
    let mut writer = ArrowWriter::try_new(
        file,
        schema,
        Some(
            WriterProperties::builder()
                .set_max_row_group_row_count(Some(64))
                .set_dictionary_enabled(false)
                .build(),
        ),
    )
    .expect("Parquet writer can be created");
    writer.write(&batch).expect("record batch can be written");
    writer.close().expect("Parquet footer can be written");
    source
}

fn pseudo_random_text(column: usize, row: usize, length: usize) -> String {
    let mut state = (column as u64 + 1)
        .wrapping_mul(0x9e37_79b9)
        .wrapping_add(row as u64);
    (0..length.max(1) * 8)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            char::from(b'!' + u8::try_from((state >> 33) % 90).unwrap_or(0))
        })
        .collect()
}
