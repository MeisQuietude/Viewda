//! Footer-only facts about the physical layout of one Parquet source.
//!
//! The footer is parsed once into a [`StructureReader`], which every later query
//! reads without touching the file again. The single exception is
//! [`StructureReader::probe_bloom_filter`], which reads the byte range that holds
//! one bloom filter. No data page is ever decoded, so a file whose data pages are
//! damaged still produces a complete layout description.

use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    fmt::Write,
    fs::File,
    io::Cursor,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

use parquet::{
    basic::{Compression, Encoding, Type as PhysicalType},
    bloom_filter::Sbbf,
    data_type::{ByteArray, FixedLenByteArray},
    errors::ParquetError,
    file::{
        FOOTER_SIZE,
        metadata::{ColumnChunkMetaData, ParquetMetaData, ParquetMetaDataReader, RowGroupMetaData},
        reader::{ChunkReader, Length},
        statistics::Statistics,
    },
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::source::{
    SourceError, converted_type_name, logical_type_name, map_parquet_error, open_local_source,
    physical_type_name,
};

/// Key-value metadata entries described in one summary; the rest are counted only.
const MAX_KEY_VALUE_ENTRIES: usize = 256;
/// Largest key-value payload handed to a caller in one read.
const MAX_KEY_VALUE_BYTES: usize = 1 << 20;
/// Layout rows returned by one request.
const MAX_LAYOUT_ROWS: usize = 256;
/// Named segments per layout row; everything below them collapses into the tail.
const MAX_LAYOUT_SEGMENTS: usize = 32;
/// Minimap buckets returned with any layout window.
const MAX_LAYOUT_OVERVIEW_BUCKETS: usize = 256;
/// Rows returned by one row-group or column page.
const MAX_PAGE_SIZE: usize = 1_000;
/// Bloom filters read by one probe request.
const MAX_PROBE_ROW_GROUPS: usize = 256;
/// Largest bloom-filter byte range one probe may read from a chunk.
const MAX_BLOOM_PROBE_BYTES: usize = 16 << 20;
/// Characters kept from one rendered statistics value.
const MAX_STATISTIC_CHARACTERS: usize = 128;
/// Rows from either detail table included in a copied report.
const MAX_REPORT_TABLE_ROWS: usize = 256;
/// UTF-8 bytes retained from any footer-controlled report field before escaping.
const MAX_REPORT_FIELD_BYTES: usize = 128;
/// Hard upper bound for the copied Markdown report.
const MAX_REPORT_BYTES: usize = 256 << 10;
/// Upper compression-ratio bound of each lens step. The final step is unbounded.
const RATIO_STEP_BOUNDS: [f64; 4] = [1.1, 2.0, 4.0, 10.0];

/// Stable failures from a structure query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum StructureError {
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
    /// The source uses a shape this reader cannot describe.
    #[error("This source is not supported yet.")]
    Unsupported,
    /// The caller cancelled the request.
    #[error("The request was cancelled.")]
    Cancelled,
    /// The request named a row group the source does not have.
    #[error("That row group is not part of this file.")]
    UnknownRowGroup,
    /// The request named a column the source does not have.
    #[error("That column is not part of this file.")]
    UnknownColumn,
    /// The request named a key-value metadata entry the source does not have.
    #[error("That metadata entry is not part of this file.")]
    UnknownKeyValue,
    /// The probe text cannot be read as a value of the column's physical type.
    #[error("That value cannot be read as a value of this column's type.")]
    InvalidProbeValue,
    /// The column's physical type has no reproducible bloom-filter hash input.
    #[error("Bloom filters cannot be probed for this column's type.")]
    UnsupportedProbeColumn,
}

impl From<SourceError> for StructureError {
    fn from(error: SourceError) -> Self {
        match error {
            SourceError::NotFound => Self::NotFound,
            SourceError::PermissionDenied => Self::PermissionDenied,
            SourceError::NotParquet => Self::NotParquet,
            SourceError::CorruptFooter => Self::CorruptFooter,
            SourceError::Unsupported => Self::Unsupported,
        }
    }
}

/// Cancellation shared with an in-flight structure load or bloom probe.
///
/// Cancellation is observed between whole steps: after opening the file, after
/// the footer decode, and once per row group. The footer decode itself is a
/// single call into the Parquet crate and cannot be interrupted part-way.
#[derive(Clone, Default)]
pub struct StructureCancellation {
    cancelled: Arc<AtomicBool>,
}

impl StructureCancellation {
    /// Asks the owning request to stop at its next step boundary.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    /// Reports whether the caller requested cancellation.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn check(&self) -> Result<(), StructureError> {
        if self.is_cancelled() {
            return Err(StructureError::Cancelled);
        }
        Ok(())
    }
}

/// Coarse progress of one structure load, readable while the load runs.
#[derive(Clone, Default)]
pub struct StructureLoadProgress {
    completed_row_groups: Arc<AtomicU64>,
    total_row_groups: Arc<AtomicU64>,
}

impl StructureLoadProgress {
    /// Reads the current counters. Both stay zero until the footer is decoded.
    pub fn snapshot(&self) -> StructureLoadSnapshot {
        StructureLoadSnapshot {
            completed_row_groups: self.completed_row_groups.load(Ordering::Acquire),
            total_row_groups: self.total_row_groups.load(Ordering::Acquire),
        }
    }
}

/// One reading of a structure load's progress counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLoadSnapshot {
    /// Row groups already summarized.
    pub completed_row_groups: u64,
    /// Row groups to summarize, or zero while the footer is still being decoded.
    pub total_row_groups: u64,
}

/// Which stored size a request ranks, shares, and sums by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StructureByteUnit {
    /// Bytes as stored in the file.
    Compressed,
    /// Bytes after decompression, as recorded in the footer.
    Uncompressed,
}

/// Direction of a paged structure ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StructureSortDirection {
    /// Smallest first.
    Ascending,
    /// Largest first.
    Descending,
}

/// Ordering key of the row-group table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StructureRowGroupSort {
    /// Position in the file.
    Index,
    /// Rows recorded for the row group.
    RowCount,
    /// Stored bytes in the requested unit.
    Bytes,
    /// Uncompressed bytes divided by stored bytes.
    CompressionRatio,
    /// Column chunks that carry a bloom filter.
    BloomFilters,
}

/// Ordering key of the columns table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StructureColumnSort {
    /// Dotted schema path.
    Name,
    /// Stored bytes in the requested unit.
    Bytes,
    /// Uncompressed bytes divided by stored bytes.
    CompressionRatio,
}

/// Everything the structure file card states about one source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureSummary {
    /// Column-chunk bytes as stored in the file.
    pub compressed_bytes: u64,
    /// Column-chunk bytes after decompression.
    pub uncompressed_bytes: u64,
    /// Uncompressed bytes divided by stored bytes, absent when nothing is stored.
    pub compression_ratio: Option<f64>,
    /// Parquet format version recorded in the footer.
    pub format_version: i32,
    /// Writer identification recorded in the footer.
    pub created_by: Option<String>,
    /// Rows recorded in the footer.
    pub row_count: u64,
    /// Row groups recorded in the footer.
    pub row_group_count: usize,
    /// Leaf columns in the schema.
    pub column_count: usize,
    /// Rows divided by row groups, absent when the file has no row group.
    pub rows_per_row_group: Option<f64>,
    /// Serialized footer metadata plus the eight trailing bytes.
    pub footer_bytes: u64,
    /// Distinct compression codecs in use, ordered by name.
    pub codecs: Vec<String>,
    /// Column chunks across every row group.
    pub chunk_count: u64,
    /// Column chunks that carry footer statistics.
    pub chunks_with_statistics: u64,
    /// Column chunks that carry a bloom filter.
    pub chunks_with_bloom_filter: u64,
    /// Row groups whose footer entry is inconsistent and excluded from the totals.
    pub unreadable_row_group_count: usize,
    /// Key-value metadata entries in the footer.
    pub key_value_count: usize,
    /// The first [`MAX_KEY_VALUE_ENTRIES`] key-value entries, values excluded.
    pub key_value_metadata: Vec<StructureKeyValueEntry>,
}

/// One key-value metadata entry described without its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureKeyValueEntry {
    /// Position in the footer's key-value list. Keys are not unique.
    pub index: usize,
    /// Metadata key.
    pub key: String,
    /// Value length in bytes, absent when the entry stores no value.
    pub value_bytes: Option<u64>,
}

/// One key-value metadata entry with its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureKeyValue {
    /// Position in the footer's key-value list.
    pub index: usize,
    /// Metadata key.
    pub key: String,
    /// Value, cut to [`MAX_KEY_VALUE_BYTES`] when longer.
    pub value: Option<String>,
    /// Whether the value was cut.
    pub is_truncated: bool,
}

/// Chunk counts and bytes behind one legend entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLensTotal {
    /// Column chunks in this category.
    pub chunk_count: u64,
    /// Stored bytes in this category.
    pub compressed_bytes: u64,
    /// Uncompressed bytes in this category.
    pub uncompressed_bytes: u64,
}

impl StructureLensTotal {
    fn add(
        &mut self,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
    ) -> Result<(), StructureError> {
        self.chunk_count = self
            .chunk_count
            .checked_add(1)
            .ok_or(StructureError::CorruptFooter)?;
        self.compressed_bytes = self
            .compressed_bytes
            .checked_add(compressed_bytes)
            .ok_or(StructureError::CorruptFooter)?;
        self.uncompressed_bytes = self
            .uncompressed_bytes
            .checked_add(uncompressed_bytes)
            .ok_or(StructureError::CorruptFooter)?;
        Ok(())
    }
}

/// One codec category of the codec lens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureCodecTotal {
    /// Codec name as reported in the file card.
    pub codec: String,
    /// Chunks and bytes using this codec.
    pub total: StructureLensTotal,
}

/// One step of the ratio lens.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureRatioStep {
    /// Exclusive upper ratio bound, absent for the unbounded final step.
    pub max_ratio: Option<f64>,
    /// Chunks and bytes inside this step.
    pub total: StructureLensTotal,
}

/// Both sides of a present/absent lens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructurePresenceTotals {
    /// Chunks that carry the feature.
    pub present: StructureLensTotal,
    /// Chunks that do not.
    pub absent: StructureLensTotal,
}

/// Legend totals for every structure lens.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLensTotals {
    /// Codec lens, ordered by codec name.
    pub codecs: Vec<StructureCodecTotal>,
    /// Ratio lens, ordered from the lowest step upwards.
    pub ratio_steps: Vec<StructureRatioStep>,
    /// Chunks that store nothing and therefore have no ratio.
    pub unrated_chunk_count: u64,
    /// Statistics lens.
    pub statistics: StructurePresenceTotals,
    /// Bloom-filter lens.
    pub bloom_filters: StructurePresenceTotals,
}

/// One proportional segment of a layout row.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayoutSegment {
    /// Leaf column this segment belongs to.
    pub column_index: usize,
    /// Dotted schema path of the column.
    pub column_name: String,
    /// Stored bytes of the segment.
    pub compressed_bytes: u64,
    /// Uncompressed bytes of the segment.
    pub uncompressed_bytes: u64,
    /// Uncompressed bytes divided by stored bytes, absent when nothing is stored.
    pub compression_ratio: Option<f64>,
    /// Compression codec of the segment.
    pub codec: String,
    /// Encodings recorded for the segment.
    pub encodings: Vec<String>,
    /// Whether the segment carries footer statistics.
    pub has_statistics: bool,
    /// Whether the segment carries a bloom filter.
    pub has_bloom_filter: bool,
    /// Whether the segment carries a page index.
    pub has_page_index: bool,
}

/// The segments of a layout row that fell below the returned segment limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayoutTail {
    /// Segments collapsed into the tail.
    pub segment_count: usize,
    /// Stored bytes of the collapsed segments.
    pub compressed_bytes: u64,
    /// Uncompressed bytes of the collapsed segments.
    pub uncompressed_bytes: u64,
}

/// One row of the layout visualization.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayoutRow {
    /// Position of the row group in the file.
    pub index: usize,
    /// Stored bytes of the whole row.
    pub compressed_bytes: u64,
    /// Uncompressed bytes of the whole row.
    pub uncompressed_bytes: u64,
    /// Whether the row group's footer entry is consistent.
    pub is_readable: bool,
    /// Largest segments in the requested unit, largest first.
    pub segments: Vec<StructureLayoutSegment>,
    /// Everything below the returned segments, absent when nothing was collapsed.
    pub tail: Option<StructureLayoutTail>,
}

/// A bounded window of layout rows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayout {
    /// Position of the first returned row.
    pub offset: usize,
    /// Rows available in the source.
    pub total_count: usize,
    /// Largest readable row group in stored bytes, for stable width normalization.
    pub max_compressed_bytes: u64,
    /// Largest readable row group in uncompressed bytes.
    pub max_uncompressed_bytes: u64,
    /// Bounded whole-file overview for the minimap.
    pub overview: Vec<StructureLayoutOverviewBucket>,
    /// Returned rows in file order.
    pub rows: Vec<StructureLayoutRow>,
}

/// One bounded whole-file minimap bucket.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayoutOverviewBucket {
    pub row_start: usize,
    pub row_end: usize,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub dominant_ratio_step_compressed: Option<usize>,
    pub dominant_ratio_step_uncompressed: Option<usize>,
    pub dominant_codec_compressed: Option<String>,
    pub dominant_codec_uncompressed: Option<String>,
    pub statistics_share_compressed: f64,
    pub statistics_share_uncompressed: f64,
    pub has_bloom_filter: bool,
    pub has_readable_group: bool,
}

/// One row of the row-group table.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureRowGroupSummary {
    /// Position of the row group in the file.
    pub index: usize,
    /// Rows recorded for the row group.
    pub row_count: u64,
    /// Stored bytes of the row group.
    pub compressed_bytes: u64,
    /// Uncompressed bytes of the row group.
    pub uncompressed_bytes: u64,
    /// Uncompressed bytes divided by stored bytes, absent when nothing is stored.
    pub compression_ratio: Option<f64>,
    /// Column chunks in the row group.
    pub chunk_count: usize,
    /// Column chunks that carry a bloom filter.
    pub chunks_with_bloom_filter: u64,
    /// Whether the row group's footer entry is consistent.
    pub is_readable: bool,
}

/// A bounded window of the row-group table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureRowGroupPage {
    /// Position of the first returned row in the requested ordering.
    pub offset: usize,
    /// Rows available in the source.
    pub total_count: usize,
    /// Returned rows in the requested ordering.
    pub row_groups: Vec<StructureRowGroupSummary>,
}

/// One row of the columns table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureColumnSummary {
    /// Leaf column position in the schema.
    pub index: usize,
    /// Dotted schema path of the column.
    pub name: String,
    /// Stable physical type name.
    pub physical_type: String,
    /// Parquet logical type annotation.
    pub logical_type: Option<String>,
    /// Stored bytes across every row group.
    pub compressed_bytes: u64,
    /// Uncompressed bytes across every row group.
    pub uncompressed_bytes: u64,
    /// Uncompressed bytes divided by stored bytes, absent when nothing is stored.
    pub compression_ratio: Option<f64>,
    /// Encodings recorded across every row group.
    pub encodings: Vec<String>,
    /// Fraction of the file's bytes in the requested unit.
    pub share: f64,
    /// Share of this column plus every larger column in the requested unit.
    ///
    /// The running total follows the file's own bytes-descending ranking, not the
    /// caller's ordering, so a row keeps the same value under any visible sort.
    pub cumulative_share: f64,
}

/// A bounded window of the columns table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureColumnPage {
    /// Position of the first returned row in the requested ordering.
    pub offset: usize,
    /// Rows available in the source.
    pub total_count: usize,
    /// Stored bytes of every readable column chunk.
    pub total_compressed_bytes: u64,
    /// Uncompressed bytes of every readable column chunk.
    pub total_uncompressed_bytes: u64,
    /// Returned rows in the requested ordering.
    pub columns: Vec<StructureColumnSummary>,
}

/// Footer statistics of one column chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureChunkStatistics {
    /// Rendered minimum, cut to [`MAX_STATISTIC_CHARACTERS`] with a trailing ellipsis.
    pub minimum: Option<String>,
    /// Rendered maximum, cut the same way.
    pub maximum: Option<String>,
    /// Whether the writer stored the exact minimum rather than a lower bound.
    pub minimum_is_exact: bool,
    /// Whether the writer stored the exact maximum rather than an upper bound.
    pub maximum_is_exact: bool,
    /// Nulls recorded for the chunk.
    pub null_count: Option<u64>,
    /// Distinct values recorded for the chunk.
    pub distinct_count: Option<u64>,
}

/// Everything the column-chunk panel states about one chunk.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureChunkDetails {
    /// Row group the chunk belongs to.
    pub row_group_index: usize,
    /// Leaf column the chunk belongs to.
    pub column_index: usize,
    /// Dotted schema path of the column.
    pub column_name: String,
    /// Stable physical type name.
    pub physical_type: String,
    /// Compression codec of the chunk.
    pub codec: String,
    /// Encodings recorded for the chunk.
    pub encodings: Vec<String>,
    /// Values recorded for the chunk, including nulls.
    pub value_count: u64,
    /// Stored bytes of the chunk.
    pub compressed_bytes: u64,
    /// Uncompressed bytes of the chunk.
    pub uncompressed_bytes: u64,
    /// Uncompressed bytes divided by stored bytes, absent when nothing is stored.
    pub compression_ratio: Option<f64>,
    /// File offset of the chunk's first data page.
    pub data_page_offset: u64,
    /// File offset of the chunk's dictionary page.
    pub dictionary_page_offset: Option<u64>,
    /// Bloom-filter size in bytes, absent when the chunk carries no filter.
    pub bloom_filter_bytes: Option<u64>,
    /// Whether this chunk records a bloom filter, even when its size is absent.
    pub has_bloom_filter: bool,
    /// Whether any row group records a bloom filter for this column.
    pub column_has_bloom_filter: bool,
    /// Whether the chunk carries a page index.
    pub has_page_index: bool,
    /// Whether the chunk carries an offset index.
    pub has_offset_index: bool,
    /// Footer statistics, absent when the writer stored none.
    pub statistics: Option<StructureChunkStatistics>,
}

/// What one row group's bloom filter says about a probed value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StructureBloomProbeOutcome {
    /// The filter matches; the value may be present.
    MayContain,
    /// The filter does not match; the value is not present.
    DefinitelyAbsent,
    /// The chunk carries no bloom filter, so the filter answers nothing.
    NoFilter,
    /// The filter is recorded but could not be read.
    Unreadable,
}

/// One row group's answer to a bloom probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureBloomProbeResult {
    /// Position of the row group in the file.
    pub index: usize,
    /// What the row group's filter says.
    pub outcome: StructureBloomProbeOutcome,
}

/// A bounded window of bloom-probe answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureBloomProbe {
    /// Leaf column that was probed.
    pub column_index: usize,
    /// Position of the first returned row group.
    pub offset: usize,
    /// Row groups available in the source.
    pub total_count: usize,
    /// Returned answers in file order.
    pub row_groups: Vec<StructureBloomProbeResult>,
}

struct RowGroupFacts {
    row_count: u64,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    chunk_count: usize,
    chunks_with_bloom_filter: u64,
    is_readable: bool,
    first_row_offset: Option<u64>,
}

struct ColumnFacts {
    name: String,
    physical_type: String,
    logical_type: Option<String>,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    encodings: u16,
    cumulative_share_compressed: f64,
    cumulative_share_uncompressed: f64,
}

/// The parsed footer of one source, shared by every structure query.
///
/// Construction is the only step that reads the footer. Callers are expected to
/// keep one reader per opened source for as long as that source stays open.
pub struct StructureReader {
    path: PathBuf,
    metadata: ParquetMetaData,
    summary: StructureSummary,
    lens_totals: StructureLensTotals,
    row_groups: Vec<RowGroupFacts>,
    columns: Vec<ColumnFacts>,
    max_compressed_row_group_bytes: u64,
    max_uncompressed_row_group_bytes: u64,
    layout_overview: Vec<StructureLayoutOverviewBucket>,
}

impl StructureReader {
    /// Parses the footer of a local Parquet source.
    ///
    /// Page indexes are deliberately left unread: their byte ranges grow with the
    /// schema, and nothing in the structure view needs more than their presence.
    pub fn open(
        path: PathBuf,
        progress: &StructureLoadProgress,
        cancellation: &StructureCancellation,
    ) -> Result<Self, StructureError> {
        let (file, _) = open_local_source(&path)?;
        cancellation.check()?;

        let mut metadata_reader = ParquetMetaDataReader::new();
        metadata_reader
            .try_parse(&file)
            .map_err(map_structure_parquet_error)?;
        let footer_bytes = u64::try_from(metadata_reader.metadata_size().unwrap_or(FOOTER_SIZE))
            .map_err(|_| StructureError::CorruptFooter)?;
        let metadata = metadata_reader
            .finish()
            .map_err(map_structure_parquet_error)?;
        cancellation.check()?;

        Self::summarize(path, metadata, footer_bytes, progress, cancellation)
    }

    fn summarize(
        path: PathBuf,
        metadata: ParquetMetaData,
        footer_bytes: u64,
        progress: &StructureLoadProgress,
        cancellation: &StructureCancellation,
    ) -> Result<Self, StructureError> {
        let file_metadata = metadata.file_metadata();
        let schema = file_metadata.schema_descr();
        let column_count = schema.num_columns();
        let row_count =
            u64::try_from(file_metadata.num_rows()).map_err(|_| StructureError::CorruptFooter)?;
        let row_group_count = metadata.num_row_groups();
        progress.total_row_groups.store(
            u64::try_from(row_group_count).map_err(|_| StructureError::CorruptFooter)?,
            Ordering::Release,
        );

        let mut columns = schema
            .columns()
            .iter()
            .map(|descriptor| ColumnFacts {
                name: descriptor.path().string(),
                physical_type: physical_type_name(&descriptor.physical_type()).to_owned(),
                logical_type: descriptor
                    .logical_type_ref()
                    .map(logical_type_name)
                    .or_else(|| {
                        converted_type_name(descriptor.self_type(), descriptor.converted_type())
                    }),
                compressed_bytes: 0,
                uncompressed_bytes: 0,
                encodings: 0,
                cumulative_share_compressed: 0.0,
                cumulative_share_uncompressed: 0.0,
            })
            .collect::<Vec<_>>();
        let mut row_groups = Vec::with_capacity(row_group_count);
        let mut lens = LensAccumulator::default();
        let mut codecs = 0_u16;
        let mut compressed_bytes = 0_u64;
        let mut uncompressed_bytes = 0_u64;
        let mut chunk_count = 0_u64;
        let mut chunks_with_statistics = 0_u64;
        let mut chunks_with_bloom_filter = 0_u64;
        let mut unreadable_row_group_count = 0_usize;
        let mut max_compressed_row_group_bytes = 0_u64;
        let mut max_uncompressed_row_group_bytes = 0_u64;
        let mut first_row_offset = Some(0_u64);
        let mut overview = vec![
            LayoutOverviewAccumulator::default();
            row_group_count.min(MAX_LAYOUT_OVERVIEW_BUCKETS)
        ];

        for (index, row_group) in metadata.row_groups().iter().enumerate() {
            cancellation.check()?;
            let is_readable = is_readable_row_group(row_group, column_count);
            let row_group_rows = u64::try_from(row_group.num_rows()).unwrap_or(0);
            let mut row_group_compressed = 0_u64;
            let mut row_group_uncompressed = 0_u64;
            let mut row_group_blooms = 0_u64;

            if is_readable {
                if !overview.is_empty() {
                    let bucket = index * overview.len() / row_group_count;
                    overview[bucket].has_readable_group = true;
                }
                for (column_index, chunk) in row_group.columns().iter().enumerate() {
                    cancellation.check()?;
                    let chunk_compressed = u64::try_from(chunk.compressed_size()).unwrap_or(0);
                    let chunk_uncompressed = u64::try_from(chunk.uncompressed_size()).unwrap_or(0);
                    row_group_compressed = row_group_compressed
                        .checked_add(chunk_compressed)
                        .ok_or(StructureError::CorruptFooter)?;
                    row_group_uncompressed = row_group_uncompressed
                        .checked_add(chunk_uncompressed)
                        .ok_or(StructureError::CorruptFooter)?;
                    let has_statistics = chunk.statistics().is_some();
                    let has_bloom_filter = chunk.bloom_filter_offset().is_some();
                    if has_statistics {
                        chunks_with_statistics = chunks_with_statistics
                            .checked_add(1)
                            .ok_or(StructureError::CorruptFooter)?;
                    }
                    if has_bloom_filter {
                        row_group_blooms = row_group_blooms
                            .checked_add(1)
                            .ok_or(StructureError::CorruptFooter)?;
                    }
                    chunk_count = chunk_count
                        .checked_add(1)
                        .ok_or(StructureError::CorruptFooter)?;
                    codecs |= codec_bit(chunk.compression());
                    lens.add(chunk, chunk_compressed, chunk_uncompressed)?;
                    if !overview.is_empty() {
                        let bucket = index * overview.len() / row_group_count;
                        overview[bucket].add(chunk, chunk_compressed, chunk_uncompressed)?;
                    }

                    let facts = &mut columns[column_index];
                    facts.compressed_bytes = facts
                        .compressed_bytes
                        .checked_add(chunk_compressed)
                        .ok_or(StructureError::CorruptFooter)?;
                    facts.uncompressed_bytes = facts
                        .uncompressed_bytes
                        .checked_add(chunk_uncompressed)
                        .ok_or(StructureError::CorruptFooter)?;
                    for encoding in chunk.encodings() {
                        facts.encodings |= encoding_bit(encoding);
                    }
                }
                compressed_bytes = compressed_bytes
                    .checked_add(row_group_compressed)
                    .ok_or(StructureError::CorruptFooter)?;
                uncompressed_bytes = uncompressed_bytes
                    .checked_add(row_group_uncompressed)
                    .ok_or(StructureError::CorruptFooter)?;
                chunks_with_bloom_filter = chunks_with_bloom_filter
                    .checked_add(row_group_blooms)
                    .ok_or(StructureError::CorruptFooter)?;
            } else {
                unreadable_row_group_count += 1;
            }
            max_compressed_row_group_bytes =
                max_compressed_row_group_bytes.max(row_group_compressed);
            max_uncompressed_row_group_bytes =
                max_uncompressed_row_group_bytes.max(row_group_uncompressed);

            row_groups.push(RowGroupFacts {
                row_count: row_group_rows,
                compressed_bytes: row_group_compressed,
                uncompressed_bytes: row_group_uncompressed,
                chunk_count: row_group.columns().len(),
                chunks_with_bloom_filter: row_group_blooms,
                is_readable,
                first_row_offset,
            });
            first_row_offset = if row_group.num_rows() < 0 {
                None
            } else {
                first_row_offset.and_then(|offset| offset.checked_add(row_group_rows))
            };
            progress.completed_row_groups.store(
                u64::try_from(index + 1).unwrap_or(u64::MAX),
                Ordering::Release,
            );
        }

        assign_cumulative_shares(
            &mut columns,
            compressed_bytes,
            StructureByteUnit::Compressed,
        );
        assign_cumulative_shares(
            &mut columns,
            uncompressed_bytes,
            StructureByteUnit::Uncompressed,
        );

        let key_value_metadata = file_metadata.key_value_metadata();
        let key_value_count = key_value_metadata.map_or(0, Vec::len);
        let key_value_entries = key_value_metadata
            .map(|entries| {
                entries
                    .iter()
                    .take(MAX_KEY_VALUE_ENTRIES)
                    .enumerate()
                    .map(|(index, entry)| StructureKeyValueEntry {
                        index,
                        key: entry.key.clone(),
                        value_bytes: entry.value.as_ref().map(|value| value.len() as u64),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let summary = StructureSummary {
            compressed_bytes,
            uncompressed_bytes,
            compression_ratio: compression_ratio(compressed_bytes, uncompressed_bytes),
            format_version: file_metadata.version(),
            created_by: file_metadata.created_by().map(str::to_owned),
            row_count,
            row_group_count,
            column_count,
            rows_per_row_group: (row_group_count > 0)
                .then(|| row_count as f64 / row_group_count as f64),
            footer_bytes,
            codecs: codec_names(codecs),
            chunk_count,
            chunks_with_statistics,
            chunks_with_bloom_filter,
            unreadable_row_group_count,
            key_value_count,
            key_value_metadata: key_value_entries,
        };

        Ok(Self {
            path,
            lens_totals: lens.finish(),
            summary,
            row_groups,
            columns,
            max_compressed_row_group_bytes,
            max_uncompressed_row_group_bytes,
            layout_overview: overview
                .into_iter()
                .enumerate()
                .map(|(bucket, facts)| {
                    facts.finish(
                        bucket,
                        row_group_count.min(MAX_LAYOUT_OVERVIEW_BUCKETS),
                        row_group_count,
                    )
                })
                .collect(),
            metadata,
        })
    }

    /// Returns the file card's facts.
    pub fn summary(&self) -> &StructureSummary {
        &self.summary
    }

    /// Returns the legend totals of every lens.
    pub fn lens_totals(&self) -> &StructureLensTotals {
        &self.lens_totals
    }

    /// Returns one key-value metadata value, cut when it exceeds the read limit.
    pub fn key_value(&self, index: usize) -> Result<StructureKeyValue, StructureError> {
        let entry = self
            .metadata
            .file_metadata()
            .key_value_metadata()
            .and_then(|entries| entries.get(index))
            .ok_or(StructureError::UnknownKeyValue)?;
        let (value, is_truncated) = match &entry.value {
            None => (None, false),
            Some(value) if value.len() <= MAX_KEY_VALUE_BYTES => (Some(value.clone()), false),
            Some(value) => {
                let mut end = MAX_KEY_VALUE_BYTES;
                while end > 0 && !value.is_char_boundary(end) {
                    end -= 1;
                }
                (Some(value[..end].to_owned()), true)
            }
        };
        Ok(StructureKeyValue {
            index,
            key: entry.key.clone(),
            value,
            is_truncated,
        })
    }

    /// Returns the zero-based source row at which a row group starts.
    pub fn first_row_offset(&self, row_group_index: usize) -> Result<u64, StructureError> {
        let facts = self
            .row_groups
            .get(row_group_index)
            .ok_or(StructureError::UnknownRowGroup)?;
        if !facts.is_readable {
            return Err(StructureError::CorruptFooter);
        }
        facts.first_row_offset.ok_or(StructureError::CorruptFooter)
    }

    /// Returns a bounded window of layout rows in file order.
    ///
    /// Each row keeps its largest segments in `unit` and collapses the rest into a
    /// tail, so the payload stays bounded on schemas of any width.
    pub fn layout(
        &self,
        unit: StructureByteUnit,
        offset: usize,
        limit: usize,
        segment_limit: usize,
    ) -> StructureLayout {
        let limit = limit.min(MAX_LAYOUT_ROWS);
        let segment_limit = segment_limit.min(MAX_LAYOUT_SEGMENTS);
        let end = offset.saturating_add(limit).min(self.row_groups.len());
        let rows = (offset.min(end)..end)
            .map(|index| self.layout_row(index, unit, segment_limit))
            .collect();

        StructureLayout {
            offset: offset.min(self.row_groups.len()),
            total_count: self.row_groups.len(),
            max_compressed_bytes: self.max_compressed_row_group_bytes,
            max_uncompressed_bytes: self.max_uncompressed_row_group_bytes,
            overview: self.layout_overview.clone(),
            rows,
        }
    }

    /// Marks bounded minimap buckets that contain bytes for one leaf column.
    fn layout_row(
        &self,
        index: usize,
        unit: StructureByteUnit,
        segment_limit: usize,
    ) -> StructureLayoutRow {
        let facts = &self.row_groups[index];
        let mut segments = Vec::new();
        let mut tail = StructureLayoutTail {
            segment_count: 0,
            compressed_bytes: 0,
            uncompressed_bytes: 0,
        };

        if facts.is_readable && segment_limit > 0 {
            let chunks = self.metadata.row_group(index).columns();
            // A bounded min-heap keeps the pass linear in the number of columns,
            // which matters on the hundred-thousand-column files this must survive.
            // Ties keep the lower column index so repeated requests agree.
            let mut largest = BinaryHeap::with_capacity(segment_limit + 1);
            for (column_index, chunk) in chunks.iter().enumerate() {
                largest.push(Reverse((chunk_bytes(chunk, unit), Reverse(column_index))));
                if largest.len() > segment_limit {
                    let Reverse((_, Reverse(dropped_index))) =
                        largest.pop().expect("the heap just grew past its limit");
                    let dropped = &chunks[dropped_index];
                    tail.segment_count += 1;
                    tail.compressed_bytes += u64::try_from(dropped.compressed_size()).unwrap_or(0);
                    tail.uncompressed_bytes +=
                        u64::try_from(dropped.uncompressed_size()).unwrap_or(0);
                }
            }
            let mut kept = largest
                .into_iter()
                .map(|Reverse((bytes, Reverse(column_index)))| (bytes, column_index))
                .collect::<Vec<_>>();
            kept.sort_unstable_by(|left, right| {
                right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1))
            });
            segments = kept
                .into_iter()
                .map(|(_, column_index)| self.layout_segment(column_index, &chunks[column_index]))
                .collect();
        }

        StructureLayoutRow {
            index,
            compressed_bytes: facts.compressed_bytes,
            uncompressed_bytes: facts.uncompressed_bytes,
            is_readable: facts.is_readable,
            segments,
            tail: (tail.segment_count > 0).then_some(tail),
        }
    }

    fn layout_segment(
        &self,
        column_index: usize,
        chunk: &ColumnChunkMetaData,
    ) -> StructureLayoutSegment {
        let compressed_bytes = u64::try_from(chunk.compressed_size()).unwrap_or(0);
        let uncompressed_bytes = u64::try_from(chunk.uncompressed_size()).unwrap_or(0);
        StructureLayoutSegment {
            column_index,
            column_name: self
                .columns
                .get(column_index)
                .map(|facts| facts.name.clone())
                .unwrap_or_else(|| chunk.column_path().string()),
            compressed_bytes,
            uncompressed_bytes,
            compression_ratio: compression_ratio(compressed_bytes, uncompressed_bytes),
            codec: codec_name(chunk.compression()).to_owned(),
            encodings: chunk_encoding_names(chunk),
            has_statistics: chunk.statistics().is_some(),
            has_bloom_filter: chunk.bloom_filter_offset().is_some(),
            has_page_index: chunk.column_index_offset().is_some(),
        }
    }

    /// Returns a bounded window of the row-group table in the requested ordering.
    pub fn row_group_page(
        &self,
        unit: StructureByteUnit,
        sort: StructureRowGroupSort,
        direction: StructureSortDirection,
        offset: usize,
        limit: usize,
    ) -> StructureRowGroupPage {
        let mut order = (0..self.row_groups.len()).collect::<Vec<_>>();
        order.sort_by(|left, right| {
            let left_facts = &self.row_groups[*left];
            let right_facts = &self.row_groups[*right];
            let ordering = match sort {
                StructureRowGroupSort::Index => left.cmp(right),
                StructureRowGroupSort::RowCount => left_facts.row_count.cmp(&right_facts.row_count),
                StructureRowGroupSort::Bytes => structure_bytes(
                    left_facts.compressed_bytes,
                    left_facts.uncompressed_bytes,
                    unit,
                )
                .cmp(&structure_bytes(
                    right_facts.compressed_bytes,
                    right_facts.uncompressed_bytes,
                    unit,
                )),
                StructureRowGroupSort::CompressionRatio => {
                    compression_ratio(left_facts.compressed_bytes, left_facts.uncompressed_bytes)
                        .unwrap_or(0.0)
                        .total_cmp(
                            &compression_ratio(
                                right_facts.compressed_bytes,
                                right_facts.uncompressed_bytes,
                            )
                            .unwrap_or(0.0),
                        )
                }
                StructureRowGroupSort::BloomFilters => left_facts
                    .chunks_with_bloom_filter
                    .cmp(&right_facts.chunks_with_bloom_filter),
            };
            direction_ordering(ordering, direction).then_with(|| left.cmp(right))
        });

        let (offset, window) = page_window(&order, offset, limit);
        StructureRowGroupPage {
            offset,
            total_count: self.row_groups.len(),
            row_groups: window
                .iter()
                .map(|index| self.row_group_summary(*index))
                .collect(),
        }
    }

    fn row_group_summary(&self, index: usize) -> StructureRowGroupSummary {
        let facts = &self.row_groups[index];
        StructureRowGroupSummary {
            index,
            row_count: facts.row_count,
            compressed_bytes: facts.compressed_bytes,
            uncompressed_bytes: facts.uncompressed_bytes,
            compression_ratio: compression_ratio(facts.compressed_bytes, facts.uncompressed_bytes),
            chunk_count: facts.chunk_count,
            chunks_with_bloom_filter: facts.chunks_with_bloom_filter,
            is_readable: facts.is_readable,
        }
    }

    /// Returns a bounded window of the columns table in the requested ordering.
    pub fn column_page(
        &self,
        unit: StructureByteUnit,
        sort: StructureColumnSort,
        direction: StructureSortDirection,
        offset: usize,
        limit: usize,
    ) -> StructureColumnPage {
        let mut order = (0..self.columns.len()).collect::<Vec<_>>();
        match sort {
            StructureColumnSort::Name => order.sort_by(|left, right| {
                let ordering = self.columns[*left].name.cmp(&self.columns[*right].name);
                direction_ordering(ordering, direction).then_with(|| left.cmp(right))
            }),
            _ => order.sort_by(|left, right| {
                let left_facts = &self.columns[*left];
                let right_facts = &self.columns[*right];
                let ordering = match sort {
                    StructureColumnSort::Name => std::cmp::Ordering::Equal,
                    StructureColumnSort::Bytes => structure_bytes(
                        left_facts.compressed_bytes,
                        left_facts.uncompressed_bytes,
                        unit,
                    )
                    .cmp(&structure_bytes(
                        right_facts.compressed_bytes,
                        right_facts.uncompressed_bytes,
                        unit,
                    )),
                    StructureColumnSort::CompressionRatio => compression_ratio(
                        left_facts.compressed_bytes,
                        left_facts.uncompressed_bytes,
                    )
                    .unwrap_or(0.0)
                    .total_cmp(
                        &compression_ratio(
                            right_facts.compressed_bytes,
                            right_facts.uncompressed_bytes,
                        )
                        .unwrap_or(0.0),
                    ),
                };
                direction_ordering(ordering, direction).then_with(|| left.cmp(right))
            }),
        }

        let total = match unit {
            StructureByteUnit::Compressed => self.summary.compressed_bytes,
            StructureByteUnit::Uncompressed => self.summary.uncompressed_bytes,
        };
        let (offset, window) = page_window(&order, offset, limit);
        StructureColumnPage {
            offset,
            total_count: self.columns.len(),
            total_compressed_bytes: self.summary.compressed_bytes,
            total_uncompressed_bytes: self.summary.uncompressed_bytes,
            columns: window
                .iter()
                .map(|index| self.column_summary(*index, unit, total))
                .collect(),
        }
    }

    fn column_summary(
        &self,
        index: usize,
        unit: StructureByteUnit,
        total: u64,
    ) -> StructureColumnSummary {
        let facts = &self.columns[index];
        let bytes = match unit {
            StructureByteUnit::Compressed => facts.compressed_bytes,
            StructureByteUnit::Uncompressed => facts.uncompressed_bytes,
        };
        StructureColumnSummary {
            index,
            name: facts.name.clone(),
            physical_type: facts.physical_type.clone(),
            logical_type: facts.logical_type.clone(),
            compressed_bytes: facts.compressed_bytes,
            uncompressed_bytes: facts.uncompressed_bytes,
            compression_ratio: compression_ratio(facts.compressed_bytes, facts.uncompressed_bytes),
            encodings: encoding_names(facts.encodings),
            share: if total == 0 {
                0.0
            } else {
                bytes as f64 / total as f64
            },
            cumulative_share: match unit {
                StructureByteUnit::Compressed => facts.cumulative_share_compressed,
                StructureByteUnit::Uncompressed => facts.cumulative_share_uncompressed,
            },
        }
    }

    /// Returns everything the chunk panel states about one column chunk.
    pub fn chunk_details(
        &self,
        row_group_index: usize,
        column_index: usize,
    ) -> Result<StructureChunkDetails, StructureError> {
        let chunk = self
            .metadata
            .row_groups()
            .get(row_group_index)
            .ok_or(StructureError::UnknownRowGroup)?
            .columns()
            .get(column_index)
            .ok_or(StructureError::UnknownColumn)?;
        let compressed_bytes = u64::try_from(chunk.compressed_size()).unwrap_or(0);
        let uncompressed_bytes = u64::try_from(chunk.uncompressed_size()).unwrap_or(0);

        Ok(StructureChunkDetails {
            row_group_index,
            column_index,
            column_name: chunk.column_path().string(),
            physical_type: physical_type_name(&chunk.column_type()).to_owned(),
            codec: codec_name(chunk.compression()).to_owned(),
            encodings: chunk_encoding_names(chunk),
            value_count: u64::try_from(chunk.num_values()).unwrap_or(0),
            compressed_bytes,
            uncompressed_bytes,
            compression_ratio: compression_ratio(compressed_bytes, uncompressed_bytes),
            data_page_offset: u64::try_from(chunk.data_page_offset()).unwrap_or(0),
            dictionary_page_offset: chunk
                .dictionary_page_offset()
                .and_then(|offset| u64::try_from(offset).ok()),
            bloom_filter_bytes: chunk
                .bloom_filter_length()
                .and_then(|length| u64::try_from(length).ok()),
            has_bloom_filter: chunk.bloom_filter_offset().is_some(),
            column_has_bloom_filter: self.metadata.row_groups().iter().any(|row_group| {
                row_group
                    .columns()
                    .get(column_index)
                    .is_some_and(|column| column.bloom_filter_offset().is_some())
            }),
            has_page_index: chunk.column_index_offset().is_some(),
            has_offset_index: chunk.offset_index_offset().is_some(),
            statistics: chunk.statistics().map(chunk_statistics),
        })
    }

    /// Builds a deterministic, bounded, path-free Markdown structure digest.
    pub fn report(&self, viewda_version: &str, unit: StructureByteUnit) -> String {
        let summary = &self.summary;
        let mut report = String::with_capacity(48 * 1024);
        writeln!(report, "# Viewda structure report\n").expect("writing to a string cannot fail");
        writeln!(report, "## Versions\n").expect("writing to a string cannot fail");
        writeln!(report, "- Viewda: {}", markdown_cell(viewda_version))
            .expect("writing to a string cannot fail");
        writeln!(report, "- Parquet format: v{}", summary.format_version)
            .expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Created by: {}\n",
            summary
                .created_by
                .as_deref()
                .map(markdown_cell)
                .unwrap_or_else(|| "—".to_owned())
        )
        .expect("writing to a string cannot fail");

        writeln!(report, "## File facts\n").expect("writing to a string cannot fail");
        for (label, value) in [
            ("Rows", summary.row_count.to_string()),
            ("Row groups", summary.row_group_count.to_string()),
            ("Columns", summary.column_count.to_string()),
            (
                "Compressed chunk bytes",
                summary.compressed_bytes.to_string(),
            ),
            (
                "Uncompressed chunk bytes",
                summary.uncompressed_bytes.to_string(),
            ),
            ("Footer bytes", summary.footer_bytes.to_string()),
            ("Chunks", summary.chunk_count.to_string()),
            (
                "Chunks with statistics",
                summary.chunks_with_statistics.to_string(),
            ),
            (
                "Chunks with bloom filters",
                summary.chunks_with_bloom_filter.to_string(),
            ),
            (
                "Unreadable row groups",
                summary.unreadable_row_group_count.to_string(),
            ),
        ] {
            writeln!(report, "- {label}: {value}").expect("writing to a string cannot fail");
        }
        writeln!(
            report,
            "- Compression ratio: {}",
            report_ratio(summary.compression_ratio)
        )
        .expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Rows per group: {}",
            report_ratio(summary.rows_per_row_group)
        )
        .expect("writing to a string cannot fail");
        writeln!(report, "- Codecs: {}\n", summary.codecs.join(" + "))
            .expect("writing to a string cannot fail");

        writeln!(report, "## Lens totals\n").expect("writing to a string cannot fail");
        for codec in &self.lens_totals.codecs {
            writeln!(
                report,
                "- Codec {}: {} chunks · {} bytes",
                markdown_cell(&codec.codec),
                codec.total.chunk_count,
                lens_bytes(codec.total, unit)
            )
            .expect("writing to a string cannot fail");
        }
        for (index, step) in self.lens_totals.ratio_steps.iter().enumerate() {
            let label = step
                .max_ratio
                .map_or_else(|| "> 10".to_owned(), |value| format!("≤ {value:.1}"));
            writeln!(
                report,
                "- Ratio step {} ({label}): {} chunks · {} bytes",
                index + 1,
                step.total.chunk_count,
                lens_bytes(step.total, unit)
            )
            .expect("writing to a string cannot fail");
        }
        writeln!(
            report,
            "- Statistics present: {} chunks · {} bytes",
            self.lens_totals.statistics.present.chunk_count,
            lens_bytes(self.lens_totals.statistics.present, unit)
        )
        .expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Statistics absent: {} chunks · {} bytes",
            self.lens_totals.statistics.absent.chunk_count,
            lens_bytes(self.lens_totals.statistics.absent, unit)
        )
        .expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Bloom filters present: {} chunks · {} bytes",
            self.lens_totals.bloom_filters.present.chunk_count,
            lens_bytes(self.lens_totals.bloom_filters.present, unit)
        )
        .expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Bloom filters absent: {} chunks · {} bytes\n",
            self.lens_totals.bloom_filters.absent.chunk_count,
            lens_bytes(self.lens_totals.bloom_filters.absent, unit)
        )
        .expect("writing to a string cannot fail");

        writeln!(report, "## Row groups ({} bytes)\n\n| Index | Rows | Bytes | Ratio | Bloom filters | Readable |\n| ---: | ---: | ---: | ---: | ---: | :--- |", report_unit(unit))
            .expect("writing to a string cannot fail");
        for index in 0..self.row_groups.len().min(MAX_REPORT_TABLE_ROWS) {
            let row = self.row_group_summary(index);
            writeln!(
                report,
                "| {} | {} | {} | {} | {} of {} | {} |",
                row.index,
                row.row_count,
                structure_bytes(row.compressed_bytes, row.uncompressed_bytes, unit),
                report_ratio(row.compression_ratio),
                row.chunks_with_bloom_filter,
                row.chunk_count,
                if row.is_readable { "yes" } else { "no" }
            )
            .expect("writing to a string cannot fail");
        }
        if self.row_groups.len() > MAX_REPORT_TABLE_ROWS {
            writeln!(
                report,
                "\n…and {} more row groups · {} bytes total",
                self.row_groups.len() - MAX_REPORT_TABLE_ROWS,
                structure_bytes(summary.compressed_bytes, summary.uncompressed_bytes, unit)
            )
            .expect("writing to a string cannot fail");
        }

        writeln!(report, "\n## Columns ({} bytes)\n\n| Column | Type | Bytes | Ratio | Encodings | Cumulative share |\n| :--- | :--- | ---: | ---: | :--- | ---: |", report_unit(unit))
            .expect("writing to a string cannot fail");
        let report_columns = self.column_page(
            unit,
            StructureColumnSort::Bytes,
            StructureSortDirection::Descending,
            0,
            MAX_REPORT_TABLE_ROWS,
        );
        for column in report_columns.columns {
            writeln!(
                report,
                "| {} | {} | {} | {} | {} | {:.2}% |",
                markdown_cell(&column.name),
                markdown_cell(&column.physical_type),
                structure_bytes(column.compressed_bytes, column.uncompressed_bytes, unit),
                report_ratio(column.compression_ratio),
                markdown_cell(&column.encodings.join(" + ")),
                column.cumulative_share * 100.0
            )
            .expect("writing to a string cannot fail");
        }
        if self.columns.len() > MAX_REPORT_TABLE_ROWS {
            writeln!(
                report,
                "\n…and {} more columns · {} bytes total",
                self.columns.len() - MAX_REPORT_TABLE_ROWS,
                structure_bytes(summary.compressed_bytes, summary.uncompressed_bytes, unit)
            )
            .expect("writing to a string cannot fail");
        }

        writeln!(report, "\n## Key-value metadata\n").expect("writing to a string cannot fail");
        if summary.key_value_metadata.is_empty() {
            writeln!(report, "None").expect("writing to a string cannot fail");
        } else {
            for entry in &summary.key_value_metadata {
                let size = entry
                    .value_bytes
                    .map_or_else(|| "—".to_owned(), |bytes| format!("{bytes} bytes"));
                writeln!(report, "- {}: {size}", markdown_cell(&entry.key))
                    .expect("writing to a string cannot fail");
            }
            if summary.key_value_count > summary.key_value_metadata.len() {
                writeln!(
                    report,
                    "- …and {} more keys",
                    summary.key_value_count - summary.key_value_metadata.len()
                )
                .expect("writing to a string cannot fail");
            }
        }
        truncate_report(report)
    }

    /// Asks each row group's bloom filter whether one value can be present.
    ///
    /// The probe text is read as a value of the column's physical type, because a
    /// bloom filter only answers for the exact bytes the writer hashed.
    pub fn probe_bloom_filter(
        &self,
        column_index: usize,
        value: &str,
        offset: usize,
        limit: usize,
        cancellation: &StructureCancellation,
    ) -> Result<StructureBloomProbe, StructureError> {
        let descriptor = self
            .metadata
            .file_metadata()
            .schema_descr()
            .columns()
            .get(column_index)
            .ok_or(StructureError::UnknownColumn)?;
        let probe = ProbeValue::parse(descriptor.physical_type(), descriptor.type_length(), value)?;
        let (file, _) = open_local_source(&self.path)?;
        let reader = BoundedBloomReader::new(file, MAX_BLOOM_PROBE_BYTES);

        let limit = limit.min(MAX_PROBE_ROW_GROUPS);
        let end = offset.saturating_add(limit).min(self.row_groups.len());
        let mut results = Vec::new();
        for index in offset.min(end)..end {
            cancellation.check()?;
            let chunk = self.metadata.row_group(index).columns().get(column_index);
            let outcome = match chunk {
                None => StructureBloomProbeOutcome::Unreadable,
                Some(chunk) if chunk.bloom_filter_offset().is_none() => {
                    StructureBloomProbeOutcome::NoFilter
                }
                Some(chunk) => match Sbbf::read_from_column_chunk(chunk, &reader) {
                    Ok(Some(filter)) if probe.check(&filter) => {
                        StructureBloomProbeOutcome::MayContain
                    }
                    Ok(Some(_)) => StructureBloomProbeOutcome::DefinitelyAbsent,
                    Ok(None) => StructureBloomProbeOutcome::NoFilter,
                    Err(_) => StructureBloomProbeOutcome::Unreadable,
                },
            };
            results.push(StructureBloomProbeResult { index, outcome });
        }

        Ok(StructureBloomProbe {
            column_index,
            offset: offset.min(self.row_groups.len()),
            total_count: self.row_groups.len(),
            row_groups: results,
        })
    }
}

struct BoundedBloomReader {
    file: File,
    remaining: AtomicUsize,
}

impl BoundedBloomReader {
    fn new(file: File, budget: usize) -> Self {
        Self {
            file,
            remaining: AtomicUsize::new(budget),
        }
    }
}

impl Length for BoundedBloomReader {
    fn len(&self) -> u64 {
        self.file.len()
    }
}

impl ChunkReader for BoundedBloomReader {
    type T = Cursor<Vec<u8>>;

    fn get_read(&self, _start: u64) -> Result<Self::T, ParquetError> {
        Err(ParquetError::General(
            "Sequential bloom reads are not supported.".to_owned(),
        ))
    }

    fn get_bytes(&self, start: u64, length: usize) -> Result<bytes::Bytes, ParquetError> {
        self.remaining
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(length)
            })
            .map_err(|_| {
                ParquetError::General("Bloom probe exceeded its read limit.".to_owned())
            })?;
        self.file.get_bytes(start, length)
    }
}

fn structure_bytes(compressed: u64, uncompressed: u64, unit: StructureByteUnit) -> u64 {
    match unit {
        StructureByteUnit::Compressed => compressed,
        StructureByteUnit::Uncompressed => uncompressed,
    }
}

fn lens_bytes(total: StructureLensTotal, unit: StructureByteUnit) -> u64 {
    structure_bytes(total.compressed_bytes, total.uncompressed_bytes, unit)
}

fn report_ratio(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.2}"))
}

fn report_unit(unit: StructureByteUnit) -> &'static str {
    match unit {
        StructureByteUnit::Compressed => "compressed",
        StructureByteUnit::Uncompressed => "uncompressed",
    }
}

fn markdown_cell(value: &str) -> String {
    cut_report_field(value)
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\r', '\n'], " ")
}

fn cut_report_field(value: &str) -> String {
    if value.len() <= MAX_REPORT_FIELD_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_REPORT_FIELD_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn truncate_report(mut report: String) -> String {
    if report.len() <= MAX_REPORT_BYTES {
        return report;
    }
    let suffix = "\n\n…report truncated to stay within 256 KiB.\n";
    let mut end = MAX_REPORT_BYTES.saturating_sub(suffix.len());
    while end > 0 && !report.is_char_boundary(end) {
        end -= 1;
    }
    report.truncate(end);
    report.push_str(suffix);
    report
}

/// A probe value already converted to the column's physical representation.
///
/// The variants exist so the filter is asked with the exact bytes the Parquet
/// writer hashed; hashing a rendered string instead would answer for a value the
/// file never stored.
enum ProbeValue {
    Boolean(bool),
    Int32(i32),
    Int64(i64),
    Float(f32),
    Double(f64),
    ByteArray(ByteArray),
    FixedLenByteArray(FixedLenByteArray),
}

impl ProbeValue {
    fn parse(
        physical_type: PhysicalType,
        type_length: i32,
        value: &str,
    ) -> Result<Self, StructureError> {
        Ok(match physical_type {
            PhysicalType::BOOLEAN => Self::Boolean(
                value
                    .parse()
                    .map_err(|_| StructureError::InvalidProbeValue)?,
            ),
            PhysicalType::INT32 => Self::Int32(
                value
                    .parse()
                    .map_err(|_| StructureError::InvalidProbeValue)?,
            ),
            PhysicalType::INT64 => Self::Int64(
                value
                    .parse()
                    .map_err(|_| StructureError::InvalidProbeValue)?,
            ),
            PhysicalType::FLOAT => Self::Float(
                value
                    .parse()
                    .map_err(|_| StructureError::InvalidProbeValue)?,
            ),
            PhysicalType::DOUBLE => Self::Double(
                value
                    .parse()
                    .map_err(|_| StructureError::InvalidProbeValue)?,
            ),
            PhysicalType::BYTE_ARRAY => Self::ByteArray(value.as_bytes().to_vec().into()),
            PhysicalType::FIXED_LEN_BYTE_ARRAY => {
                if usize::try_from(type_length) != Ok(value.len()) {
                    return Err(StructureError::InvalidProbeValue);
                }
                Self::FixedLenByteArray(FixedLenByteArray::from(value.as_bytes().to_vec()))
            }
            // An INT96 is three little-endian words with no textual spelling that
            // reproduces the writer's hash input.
            PhysicalType::INT96 => return Err(StructureError::UnsupportedProbeColumn),
        })
    }

    fn check(&self, filter: &Sbbf) -> bool {
        match self {
            Self::Boolean(value) => filter.check(value),
            Self::Int32(value) => filter.check(value),
            Self::Int64(value) => filter.check(value),
            Self::Float(value) => filter.check(value),
            Self::Double(value) => filter.check(value),
            Self::ByteArray(value) => filter.check(value),
            Self::FixedLenByteArray(value) => filter.check(value),
        }
    }
}

#[derive(Default)]
struct LensAccumulator {
    codecs: Vec<(usize, StructureLensTotal)>,
    ratio_steps: [StructureLensTotal; RATIO_STEP_BOUNDS.len() + 1],
    unrated_chunk_count: u64,
    statistics: StructurePresenceTotalsAccumulator,
    bloom_filters: StructurePresenceTotalsAccumulator,
}

#[derive(Clone, Default)]
struct LayoutOverviewAccumulator {
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    ratio_compressed_bytes: [u64; RATIO_STEP_BOUNDS.len() + 1],
    ratio_uncompressed_bytes: [u64; RATIO_STEP_BOUNDS.len() + 1],
    codec_compressed_bytes: [u64; CODEC_NAMES.len()],
    codec_uncompressed_bytes: [u64; CODEC_NAMES.len()],
    statistics_compressed_bytes: u64,
    statistics_uncompressed_bytes: u64,
    has_bloom_filter: bool,
    has_readable_group: bool,
}

impl LayoutOverviewAccumulator {
    fn add(
        &mut self,
        chunk: &ColumnChunkMetaData,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
    ) -> Result<(), StructureError> {
        self.compressed_bytes = self
            .compressed_bytes
            .checked_add(compressed_bytes)
            .ok_or(StructureError::CorruptFooter)?;
        self.uncompressed_bytes = self
            .uncompressed_bytes
            .checked_add(uncompressed_bytes)
            .ok_or(StructureError::CorruptFooter)?;
        let ratio_step = compression_ratio(compressed_bytes, uncompressed_bytes).map(|ratio| {
            RATIO_STEP_BOUNDS
                .iter()
                .position(|bound| ratio <= *bound)
                .unwrap_or(RATIO_STEP_BOUNDS.len())
        });
        if let Some(step) = ratio_step {
            self.ratio_compressed_bytes[step] = self.ratio_compressed_bytes[step]
                .checked_add(compressed_bytes)
                .ok_or(StructureError::CorruptFooter)?;
            self.ratio_uncompressed_bytes[step] = self.ratio_uncompressed_bytes[step]
                .checked_add(uncompressed_bytes)
                .ok_or(StructureError::CorruptFooter)?;
        }
        let codec = codec_index(chunk.compression());
        self.codec_compressed_bytes[codec] = self.codec_compressed_bytes[codec]
            .checked_add(compressed_bytes)
            .ok_or(StructureError::CorruptFooter)?;
        self.codec_uncompressed_bytes[codec] = self.codec_uncompressed_bytes[codec]
            .checked_add(uncompressed_bytes)
            .ok_or(StructureError::CorruptFooter)?;
        if chunk.statistics().is_some() {
            self.statistics_compressed_bytes = self
                .statistics_compressed_bytes
                .checked_add(compressed_bytes)
                .ok_or(StructureError::CorruptFooter)?;
            self.statistics_uncompressed_bytes = self
                .statistics_uncompressed_bytes
                .checked_add(uncompressed_bytes)
                .ok_or(StructureError::CorruptFooter)?;
        }
        self.has_bloom_filter |= chunk.bloom_filter_offset().is_some();
        Ok(())
    }

    fn finish(
        self,
        bucket: usize,
        bucket_count: usize,
        row_count: usize,
    ) -> StructureLayoutOverviewBucket {
        let row_start = bucket.saturating_mul(row_count).div_ceil(bucket_count);
        let row_end = (bucket + 1)
            .saturating_mul(row_count)
            .div_ceil(bucket_count)
            .min(row_count);
        StructureLayoutOverviewBucket {
            row_start,
            row_end,
            compressed_bytes: self.compressed_bytes,
            uncompressed_bytes: self.uncompressed_bytes,
            dominant_ratio_step_compressed: dominant_index(&self.ratio_compressed_bytes),
            dominant_ratio_step_uncompressed: dominant_index(&self.ratio_uncompressed_bytes),
            dominant_codec_compressed: dominant_index(&self.codec_compressed_bytes)
                .map(|index| CODEC_NAMES[index].to_owned()),
            dominant_codec_uncompressed: dominant_index(&self.codec_uncompressed_bytes)
                .map(|index| CODEC_NAMES[index].to_owned()),
            statistics_share_compressed: if self.compressed_bytes == 0 {
                0.0
            } else {
                self.statistics_compressed_bytes as f64 / self.compressed_bytes as f64
            },
            statistics_share_uncompressed: if self.uncompressed_bytes == 0 {
                0.0
            } else {
                self.statistics_uncompressed_bytes as f64 / self.uncompressed_bytes as f64
            },
            has_bloom_filter: self.has_bloom_filter,
            has_readable_group: self.has_readable_group,
        }
    }
}

fn dominant_index<const N: usize>(values: &[u64; N]) -> Option<usize> {
    values
        .iter()
        .enumerate()
        .filter(|(_, value)| **value > 0)
        .max_by_key(|(index, value)| (**value, Reverse(*index)))
        .map(|(index, _)| index)
}

#[derive(Default)]
struct StructurePresenceTotalsAccumulator {
    present: StructureLensTotal,
    absent: StructureLensTotal,
}

impl StructurePresenceTotalsAccumulator {
    fn add(
        &mut self,
        present: bool,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
    ) -> Result<(), StructureError> {
        let side = if present {
            &mut self.present
        } else {
            &mut self.absent
        };
        side.add(compressed_bytes, uncompressed_bytes)
    }

    fn finish(self) -> StructurePresenceTotals {
        StructurePresenceTotals {
            present: self.present,
            absent: self.absent,
        }
    }
}

impl LensAccumulator {
    fn add(
        &mut self,
        chunk: &ColumnChunkMetaData,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
    ) -> Result<(), StructureError> {
        let codec = codec_index(chunk.compression());
        match self.codecs.iter_mut().find(|(index, _)| *index == codec) {
            Some((_, total)) => total.add(compressed_bytes, uncompressed_bytes)?,
            None => {
                let mut total = StructureLensTotal::default();
                total.add(compressed_bytes, uncompressed_bytes)?;
                self.codecs.push((codec, total));
            }
        }

        match compression_ratio(compressed_bytes, uncompressed_bytes) {
            None => {
                self.unrated_chunk_count = self
                    .unrated_chunk_count
                    .checked_add(1)
                    .ok_or(StructureError::CorruptFooter)?;
            }
            Some(ratio) => {
                let step = RATIO_STEP_BOUNDS
                    .iter()
                    .position(|bound| ratio <= *bound)
                    .unwrap_or(RATIO_STEP_BOUNDS.len());
                self.ratio_steps[step].add(compressed_bytes, uncompressed_bytes)?;
            }
        }

        self.statistics.add(
            chunk.statistics().is_some(),
            compressed_bytes,
            uncompressed_bytes,
        )?;
        self.bloom_filters.add(
            chunk.bloom_filter_offset().is_some(),
            compressed_bytes,
            uncompressed_bytes,
        )?;
        Ok(())
    }

    fn finish(mut self) -> StructureLensTotals {
        self.codecs.sort_unstable_by_key(|(index, _)| *index);
        StructureLensTotals {
            codecs: self
                .codecs
                .into_iter()
                .map(|(index, total)| StructureCodecTotal {
                    codec: CODEC_NAMES[index].to_owned(),
                    total,
                })
                .collect(),
            ratio_steps: self
                .ratio_steps
                .into_iter()
                .enumerate()
                .map(|(index, total)| StructureRatioStep {
                    max_ratio: RATIO_STEP_BOUNDS.get(index).copied(),
                    total,
                })
                .collect(),
            unrated_chunk_count: self.unrated_chunk_count,
            statistics: self.statistics.finish(),
            bloom_filters: self.bloom_filters.finish(),
        }
    }
}

/// Records, per column, the share of the file covered by that column and every
/// larger one.
///
/// Ranking is the file's own fact, so the running total is computed once against
/// the bytes-descending order and stays valid under any ordering a caller asks for.
fn assign_cumulative_shares(columns: &mut [ColumnFacts], total: u64, unit: StructureByteUnit) {
    let bytes = |facts: &ColumnFacts| match unit {
        StructureByteUnit::Compressed => facts.compressed_bytes,
        StructureByteUnit::Uncompressed => facts.uncompressed_bytes,
    };
    let mut order = (0..columns.len()).collect::<Vec<_>>();
    order.sort_unstable_by(|left, right| {
        bytes(&columns[*right])
            .cmp(&bytes(&columns[*left]))
            .then_with(|| left.cmp(right))
    });

    let mut running = 0_u64;
    for index in order {
        running += bytes(&columns[index]);
        let share = if total == 0 {
            0.0
        } else {
            running as f64 / total as f64
        };
        match unit {
            StructureByteUnit::Compressed => columns[index].cumulative_share_compressed = share,
            StructureByteUnit::Uncompressed => columns[index].cumulative_share_uncompressed = share,
        }
    }
}

/// Reports whether a row group's footer entry can be summarized as written.
///
/// An inconsistent entry is excluded from every total and counted separately, so
/// one damaged row group cannot silently distort the file card.
fn is_readable_row_group(row_group: &RowGroupMetaData, column_count: usize) -> bool {
    row_group.num_rows() >= 0
        && row_group.total_byte_size() >= 0
        && row_group.columns().len() == column_count
        && row_group
            .columns()
            .iter()
            .all(|chunk| chunk.compressed_size() >= 0 && chunk.uncompressed_size() >= 0)
}

fn chunk_bytes(chunk: &ColumnChunkMetaData, unit: StructureByteUnit) -> u64 {
    let size = match unit {
        StructureByteUnit::Compressed => chunk.compressed_size(),
        StructureByteUnit::Uncompressed => chunk.uncompressed_size(),
    };
    u64::try_from(size).unwrap_or(0)
}

fn compression_ratio(compressed_bytes: u64, uncompressed_bytes: u64) -> Option<f64> {
    (compressed_bytes > 0).then(|| uncompressed_bytes as f64 / compressed_bytes as f64)
}

fn direction_ordering(
    ordering: std::cmp::Ordering,
    direction: StructureSortDirection,
) -> std::cmp::Ordering {
    match direction {
        StructureSortDirection::Ascending => ordering,
        StructureSortDirection::Descending => ordering.reverse(),
    }
}

fn page_window(order: &[usize], offset: usize, limit: usize) -> (usize, &[usize]) {
    let limit = limit.min(MAX_PAGE_SIZE);
    let start = offset.min(order.len());
    let end = start.saturating_add(limit).min(order.len());
    (start, &order[start..end])
}

fn chunk_encoding_names(chunk: &ColumnChunkMetaData) -> Vec<String> {
    let mut mask = 0;
    for encoding in chunk.encodings() {
        mask |= encoding_bit(encoding);
    }
    encoding_names(mask)
}

fn chunk_statistics(statistics: &Statistics) -> StructureChunkStatistics {
    let (minimum, maximum) = match statistics {
        Statistics::Boolean(values) => (
            values.min_opt().map(bool::to_string),
            values.max_opt().map(bool::to_string),
        ),
        Statistics::Int32(values) => (
            values.min_opt().map(i32::to_string),
            values.max_opt().map(i32::to_string),
        ),
        Statistics::Int64(values) => (
            values.min_opt().map(i64::to_string),
            values.max_opt().map(i64::to_string),
        ),
        Statistics::Int96(values) => (
            values.min_opt().map(ToString::to_string),
            values.max_opt().map(ToString::to_string),
        ),
        Statistics::Float(values) => (
            values.min_opt().map(f32::to_string),
            values.max_opt().map(f32::to_string),
        ),
        Statistics::Double(values) => (
            values.min_opt().map(f64::to_string),
            values.max_opt().map(f64::to_string),
        ),
        Statistics::ByteArray(values) => (
            values.min_opt().map(|value| render_bytes(value.data())),
            values.max_opt().map(|value| render_bytes(value.data())),
        ),
        Statistics::FixedLenByteArray(values) => (
            values.min_opt().map(|value| render_bytes(value.data())),
            values.max_opt().map(|value| render_bytes(value.data())),
        ),
    };

    StructureChunkStatistics {
        minimum: minimum.map(cut_statistic),
        maximum: maximum.map(cut_statistic),
        minimum_is_exact: statistics.min_is_exact(),
        maximum_is_exact: statistics.max_is_exact(),
        null_count: statistics.null_count_opt(),
        distinct_count: statistics.distinct_count_opt(),
    }
}

fn render_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    }
}

fn cut_statistic(value: String) -> String {
    if value.chars().count() <= MAX_STATISTIC_CHARACTERS {
        return value;
    }
    value
        .chars()
        .take(MAX_STATISTIC_CHARACTERS)
        .chain(std::iter::once('\u{2026}'))
        .collect()
}

/// Stable codec names, in the order a mixed-codec file card lists them.
const CODEC_NAMES: [&str; 8] = [
    "uncompressed",
    "snappy",
    "gzip",
    "lzo",
    "brotli",
    "lz4",
    "zstd",
    "lz4_raw",
];

/// Compression levels are writer settings rather than stored facts, so every
/// level of one algorithm maps to the same name.
fn codec_index(compression: Compression) -> usize {
    match compression {
        Compression::UNCOMPRESSED => 0,
        Compression::SNAPPY => 1,
        Compression::GZIP(_) => 2,
        Compression::LZO => 3,
        Compression::BROTLI(_) => 4,
        Compression::LZ4 => 5,
        Compression::ZSTD(_) => 6,
        Compression::LZ4_RAW => 7,
    }
}

fn codec_name(compression: Compression) -> &'static str {
    CODEC_NAMES[codec_index(compression)]
}

fn codec_bit(compression: Compression) -> u16 {
    1 << codec_index(compression)
}

fn codec_names(mask: u16) -> Vec<String> {
    CODEC_NAMES
        .iter()
        .enumerate()
        .filter(|(index, _)| mask & (1 << index) != 0)
        .map(|(_, name)| (*name).to_owned())
        .collect()
}

/// Stable encoding names, in Parquet's own declaration order.
const ENCODING_NAMES: [&str; 9] = [
    "PLAIN",
    "PLAIN_DICTIONARY",
    "RLE",
    "BIT_PACKED",
    "DELTA_BINARY_PACKED",
    "DELTA_LENGTH_BYTE_ARRAY",
    "DELTA_BYTE_ARRAY",
    "RLE_DICTIONARY",
    "BYTE_STREAM_SPLIT",
];

// BIT_PACKED is deprecated but still appears in files written by older writers,
// so the mapping has to name it.
#[allow(deprecated)]
fn encoding_bit(encoding: Encoding) -> u16 {
    let index = match encoding {
        Encoding::PLAIN => 0,
        Encoding::PLAIN_DICTIONARY => 1,
        Encoding::RLE => 2,
        Encoding::BIT_PACKED => 3,
        Encoding::DELTA_BINARY_PACKED => 4,
        Encoding::DELTA_LENGTH_BYTE_ARRAY => 5,
        Encoding::DELTA_BYTE_ARRAY => 6,
        Encoding::RLE_DICTIONARY => 7,
        Encoding::BYTE_STREAM_SPLIT => 8,
    };
    1 << index
}

fn encoding_names(mask: u16) -> Vec<String> {
    ENCODING_NAMES
        .iter()
        .enumerate()
        .filter(|(index, _)| mask & (1 << index) != 0)
        .map(|(_, name)| (*name).to_owned())
        .collect()
}

fn map_structure_parquet_error(error: ParquetError) -> StructureError {
    map_parquet_error(error).into()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parquet::{
        basic::Repetition,
        file::metadata::{ColumnChunkMetaData, FileMetaData, KeyValue, RowGroupMetaData},
        schema::types::{SchemaDescriptor, Type},
    };

    use super::*;

    #[test]
    fn treats_a_row_group_with_negative_sizes_as_unreadable() {
        let schema = test_schema();
        let metadata = test_metadata(vec![
            test_row_group(&schema, 2, 40, 10, 30),
            test_row_group(&schema, 2, 40, -1, 30),
        ]);

        let reader = summarize_metadata(metadata).expect("inconsistent entries stay summarizable");

        assert_eq!(reader.summary().unreadable_row_group_count, 1);
        assert_eq!(reader.summary().compressed_bytes, 10);
        assert_eq!(reader.summary().uncompressed_bytes, 30);
        assert_eq!(reader.summary().chunk_count, 1);
        assert!(!reader.row_group_summary(1).is_readable);
        assert_eq!(reader.row_group_summary(1).compressed_bytes, 0);
    }

    #[test]
    fn rejects_footer_size_totals_that_overflow() {
        let schema = test_schema_with_columns(3);
        let chunks = (0..3)
            .map(|index| {
                ColumnChunkMetaData::builder(schema.column(index))
                    .set_total_compressed_size(i64::MAX)
                    .set_total_uncompressed_size(i64::MAX)
                    .build()
                    .expect("chunk metadata")
            })
            .collect();
        let row_group = RowGroupMetaData::builder(Arc::clone(&schema))
            .set_num_rows(1)
            .set_total_byte_size(i64::MAX)
            .set_column_metadata(chunks)
            .build()
            .expect("row group metadata");

        assert_eq!(
            summarize_metadata(test_metadata(vec![row_group])).err(),
            Some(StructureError::CorruptFooter)
        );
    }

    #[test]
    fn sorts_integer_sizes_without_losing_precision() {
        let schema = test_schema();
        let metadata = test_metadata(vec![
            test_row_group(&schema, 1, 40, 10, 30),
            test_row_group(&schema, 1, 40, 10, 30),
        ]);
        let mut reader = summarize_metadata(metadata).expect("fixture is summarizable");
        reader.row_groups[0].compressed_bytes = (1_u64 << 53) + 1;
        reader.row_groups[1].compressed_bytes = 1_u64 << 53;

        let page = reader.row_group_page(
            StructureByteUnit::Compressed,
            StructureRowGroupSort::Bytes,
            StructureSortDirection::Descending,
            0,
            2,
        );

        assert_eq!(
            page.row_groups
                .iter()
                .map(|row| row.index)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn overview_uses_the_selected_unit_for_its_dominant_codec() {
        let schema = test_schema_with_columns(2);
        let snappy = ColumnChunkMetaData::builder(schema.column(0))
            .set_compression(Compression::SNAPPY)
            .set_total_compressed_size(100)
            .set_total_uncompressed_size(1_000)
            .build()
            .expect("snappy chunk");
        let zstd = ColumnChunkMetaData::builder(schema.column(1))
            .set_compression(Compression::ZSTD(Default::default()))
            .set_total_compressed_size(200)
            .set_total_uncompressed_size(300)
            .build()
            .expect("zstd chunk");
        let mut overview = LayoutOverviewAccumulator::default();
        overview.add(&snappy, 100, 1_000).expect("bounded totals");
        overview.add(&zstd, 200, 300).expect("bounded totals");

        let bucket = overview.finish(0, 1, 1);

        assert_eq!(bucket.dominant_codec_compressed.as_deref(), Some("zstd"));
        assert_eq!(
            bucket.dominant_codec_uncompressed.as_deref(),
            Some("snappy")
        );
    }

    #[test]
    fn keeps_row_offsets_of_row_groups_it_cannot_summarize() {
        let schema = test_schema();
        let metadata = test_metadata(vec![
            test_row_group(&schema, 5, 40, -1, 30),
            test_row_group(&schema, 7, 40, 10, 30),
        ]);

        let reader = summarize_metadata(metadata).expect("inconsistent entries stay summarizable");

        assert_eq!(
            reader.first_row_offset(0),
            Err(StructureError::CorruptFooter)
        );
        assert_eq!(reader.first_row_offset(1), Ok(5));
        assert_eq!(
            reader.first_row_offset(2),
            Err(StructureError::UnknownRowGroup)
        );
    }

    #[test]
    fn rejects_offsets_after_a_negative_row_count() {
        let schema = test_schema();
        let metadata = test_metadata(vec![
            test_row_group(&schema, -1, 40, 10, 30),
            test_row_group(&schema, 7, 40, 10, 30),
        ]);

        let reader = summarize_metadata(metadata).expect("footer remains inspectable");

        assert_eq!(
            reader.first_row_offset(0),
            Err(StructureError::CorruptFooter)
        );
        assert_eq!(
            reader.first_row_offset(1),
            Err(StructureError::CorruptFooter)
        );
    }

    #[test]
    fn stops_summarizing_when_the_caller_cancels() {
        let schema = test_schema();
        let metadata = test_metadata(vec![test_row_group(&schema, 2, 40, 10, 30)]);
        let cancellation = StructureCancellation::default();
        cancellation.cancel();

        assert_eq!(
            StructureReader::summarize(
                PathBuf::new(),
                metadata,
                8,
                &StructureLoadProgress::default(),
                &cancellation,
            )
            .err(),
            Some(StructureError::Cancelled)
        );
    }

    #[test]
    fn bounds_total_bloom_bytes_read_by_one_probe() {
        use std::io::Write as _;

        let mut source = tempfile::NamedTempFile::new().expect("temporary file");
        source.write_all(&[0; 32]).expect("fixture bytes");
        let reader = BoundedBloomReader::new(source.reopen().expect("fixture can reopen"), 8);

        assert!(reader.get_bytes(0, 4).is_ok());
        assert!(reader.get_bytes(4, 4).is_ok());
        assert!(reader.get_bytes(8, 1).is_err());
    }

    #[test]
    fn report_is_bounded_and_excludes_source_identity_and_values() {
        let schema = test_schema();
        let row_groups = (0..MAX_REPORT_TABLE_ROWS + 1)
            .map(|_| test_row_group(&schema, 2, 40, 10, 30))
            .collect::<Vec<_>>();
        let metadata = ParquetMetaData::new(
            FileMetaData::new(
                2,
                row_groups.iter().map(RowGroupMetaData::num_rows).sum(),
                Some("writer-version".to_owned()),
                Some(vec![KeyValue::new(
                    format!("metadata-key-{}", "K".repeat(10_000)),
                    Some("SECRET_METADATA_VALUE".to_owned()),
                )]),
                Arc::clone(&schema),
                None,
            ),
            row_groups,
        );
        let reader = StructureReader::summarize(
            PathBuf::from("/private/SOURCE_IDENTITY.parquet"),
            metadata,
            8,
            &StructureLoadProgress::default(),
            &StructureCancellation::default(),
        )
        .expect("fixture is summarizable");

        let report = reader.report("9.8.7", StructureByteUnit::Compressed);

        assert!(report.contains("Viewda: 9.8.7"));
        assert!(report.contains("Created by: writer-version"));
        assert!(report.contains("metadata-key-"));
        assert!(report.contains("…: 21 bytes"));
        assert!(report.contains("…and 1 more row groups"));
        assert!(!report.contains("SOURCE_IDENTITY"));
        assert!(!report.contains("SECRET_METADATA_VALUE"));
        assert!(report.len() <= MAX_REPORT_BYTES);
    }

    #[test]
    fn counts_key_value_entries_beyond_the_described_ones() {
        let schema = test_schema();
        let entries = (0..MAX_KEY_VALUE_ENTRIES + 3)
            .map(|index| KeyValue::new(format!("key-{index}"), Some(index.to_string())))
            .collect::<Vec<_>>();
        let metadata = ParquetMetaData::new(
            FileMetaData::new(2, 2, None, Some(entries), Arc::clone(&schema), None),
            vec![test_row_group(&schema, 2, 40, 10, 30)],
        );

        let reader = summarize_metadata(metadata).expect("key-value metadata is summarizable");

        assert_eq!(reader.summary().key_value_count, MAX_KEY_VALUE_ENTRIES + 3);
        assert_eq!(
            reader.summary().key_value_metadata.len(),
            MAX_KEY_VALUE_ENTRIES
        );
        assert_eq!(
            reader.summary().key_value_metadata[0],
            StructureKeyValueEntry {
                index: 0,
                key: "key-0".to_owned(),
                value_bytes: Some(1),
            }
        );
        assert_eq!(
            reader.key_value(MAX_KEY_VALUE_ENTRIES + 2),
            Ok(StructureKeyValue {
                index: MAX_KEY_VALUE_ENTRIES + 2,
                key: format!("key-{}", MAX_KEY_VALUE_ENTRIES + 2),
                value: Some((MAX_KEY_VALUE_ENTRIES + 2).to_string()),
                is_truncated: false,
            })
        );
        assert_eq!(
            reader.key_value(MAX_KEY_VALUE_ENTRIES + 3),
            Err(StructureError::UnknownKeyValue)
        );
    }

    #[test]
    fn reads_probe_text_as_the_column_physical_type() {
        assert!(matches!(
            ProbeValue::parse(PhysicalType::INT32, 0, "17"),
            Ok(ProbeValue::Int32(17))
        ));
        assert_eq!(
            ProbeValue::parse(PhysicalType::INT32, 0, "seventeen").err(),
            Some(StructureError::InvalidProbeValue)
        );
        assert_eq!(
            ProbeValue::parse(PhysicalType::FIXED_LEN_BYTE_ARRAY, 4, "abc").err(),
            Some(StructureError::InvalidProbeValue)
        );
        assert!(ProbeValue::parse(PhysicalType::FIXED_LEN_BYTE_ARRAY, 4, "abcd").is_ok());
        assert_eq!(
            ProbeValue::parse(PhysicalType::INT96, 0, "17").err(),
            Some(StructureError::UnsupportedProbeColumn)
        );
    }

    #[test]
    fn renders_non_text_statistics_as_hexadecimal() {
        assert_eq!(render_bytes(b"north"), "north");
        assert_eq!(render_bytes(&[0xff, 0x00]), "ff00");
    }

    #[test]
    fn marks_a_cut_statistics_value_with_an_ellipsis() {
        let long = "a".repeat(MAX_STATISTIC_CHARACTERS + 1);

        let cut = cut_statistic(long);

        assert_eq!(cut.chars().count(), MAX_STATISTIC_CHARACTERS + 1);
        assert!(cut.ends_with('\u{2026}'));
        assert_eq!(
            cut_statistic("short".to_owned()),
            "short".to_owned(),
            "values within the limit stay untouched"
        );
    }

    #[test]
    fn names_every_codec_and_encoding_it_can_report() {
        assert_eq!(codec_name(Compression::LZ4_RAW), "lz4_raw");
        assert_eq!(
            codec_names(codec_bit(Compression::SNAPPY) | codec_bit(Compression::UNCOMPRESSED)),
            vec!["uncompressed".to_owned(), "snappy".to_owned()]
        );
        assert_eq!(
            encoding_names(encoding_bit(Encoding::RLE_DICTIONARY) | encoding_bit(Encoding::PLAIN)),
            vec!["PLAIN".to_owned(), "RLE_DICTIONARY".to_owned()]
        );
    }

    fn summarize_metadata(metadata: ParquetMetaData) -> Result<StructureReader, StructureError> {
        StructureReader::summarize(
            PathBuf::new(),
            metadata,
            8,
            &StructureLoadProgress::default(),
            &StructureCancellation::default(),
        )
    }

    fn test_schema() -> Arc<SchemaDescriptor> {
        test_schema_with_columns(1)
    }

    fn test_schema_with_columns(count: usize) -> Arc<SchemaDescriptor> {
        let fields = (0..count)
            .map(|index| {
                Arc::new(
                    Type::primitive_type_builder(
                        match index {
                            0 => "value_0",
                            1 => "value_1",
                            _ => "value_2",
                        },
                        PhysicalType::INT64,
                    )
                    .with_repetition(Repetition::REQUIRED)
                    .build()
                    .expect("primitive field is valid"),
                )
            })
            .collect();
        let root = Type::group_type_builder("schema")
            .with_fields(fields)
            .build()
            .expect("schema is valid");
        Arc::new(SchemaDescriptor::new(Arc::new(root)))
    }

    fn test_metadata(row_groups: Vec<RowGroupMetaData>) -> ParquetMetaData {
        let num_rows = row_groups.iter().map(RowGroupMetaData::num_rows).sum();
        let schema = row_groups
            .first()
            .expect("fixtures always have a row group")
            .schema_descr_ptr();
        ParquetMetaData::new(
            FileMetaData::new(2, num_rows, None, None, schema, None),
            row_groups,
        )
    }

    fn test_row_group(
        schema: &Arc<SchemaDescriptor>,
        num_rows: i64,
        total_byte_size: i64,
        compressed_size: i64,
        uncompressed_size: i64,
    ) -> RowGroupMetaData {
        let chunk = ColumnChunkMetaData::builder(schema.column(0))
            .set_compression(Compression::SNAPPY)
            .set_total_compressed_size(compressed_size)
            .set_total_uncompressed_size(uncompressed_size)
            .build()
            .expect("column chunk metadata is valid");
        RowGroupMetaData::builder(Arc::clone(schema))
            .set_num_rows(num_rows)
            .set_total_byte_size(total_byte_size)
            .set_column_metadata(vec![chunk])
            .build()
            .expect("row group metadata is valid")
    }
}
