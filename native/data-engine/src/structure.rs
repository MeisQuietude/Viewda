//! Footer-only facts about the physical layout of one Parquet source.
//!
//! The footer is parsed once into a [`StructureReader`], which every later query
//! reads without touching the file again. The single exception is
//! [`StructureReader::probe_bloom_filter`], which reads the byte range that holds
//! one bloom filter from the retained source snapshot. No data page is ever
//! decoded, so damaged page contents still produce a layout description. Page
//! ranges that no longer fit before the footer are marked unreadable.

use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    fmt::Write,
    fs::File,
    io::Cursor,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

#[cfg(test)]
type ChunkProgressObserver = Arc<dyn Fn(StructureLoadSnapshot) + Send + Sync>;

use parquet::{
    basic::{Compression, ConvertedType, Encoding, LogicalType, Type as PhysicalType},
    bloom_filter::Sbbf,
    data_type::{ByteArray, FixedLenByteArray},
    errors::ParquetError,
    file::{
        metadata::{ColumnChunkMetaData, ParquetMetaData, RowGroupMetaData},
        reader::{ChunkReader, Length},
        statistics::Statistics,
    },
    thrift::TSerializable,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use thrift::protocol::TCompactInputProtocol;

use crate::source::{
    MAX_SAFE_WIRE_INTEGER, SourceError, SourceIdentity, SourceSnapshot, converted_type_name,
    logical_type_name, physical_type_name,
};

/// Key-value metadata entries described in one summary; the rest are counted only.
const MAX_KEY_VALUE_ENTRIES: usize = 256;
/// Largest key-value payload handed to a caller in one read.
const MAX_KEY_VALUE_BYTES: usize = 1 << 20;
/// Layout rows returned by one request.
const MAX_LAYOUT_ROWS: usize = 80;
/// Named columns in the aligned layout matrix; the remainder is one aggregate.
const MAX_LAYOUT_COLUMNS: usize = 12;
/// Minimap buckets returned with any layout window.
const MAX_LAYOUT_OVERVIEW_BUCKETS: usize = 256;
/// Rows returned by one row-group or column page.
const MAX_PAGE_SIZE: usize = 1_000;
/// Bloom filters read by one probe request.
const MAX_PROBE_ROW_GROUPS: usize = 256;
/// Largest UTF-8 probe value accepted before parsing or copying.
pub const MAX_BLOOM_PROBE_VALUE_BYTES: usize = 4 * 1024;
/// Largest bloom-filter byte range one probe may read from a chunk.
const MAX_BLOOM_PROBE_BYTES: usize = 16 << 20;
/// Largest physical byte width accepted by a scalar Bloom probe.
const MAX_BLOOM_PROBE_PHYSICAL_BYTES: usize = 16;
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
    /// The source path or retained file changed after open.
    #[error("The selected file changed after it was opened.")]
    SourceChanged,
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
            SourceError::SourceChanged => Self::SourceChanged,
            SourceError::NotParquet => Self::NotParquet,
            SourceError::CorruptFooter => Self::CorruptFooter,
            SourceError::Unsupported => Self::Unsupported,
        }
    }
}

/// Cancellation shared with an in-flight structure load or bloom probe.
///
/// Cancellation is observed after opening, after the footer decode, and within
/// row-group chunk/range passes. The Thrift footer decode is one library call
/// and cannot be interrupted part-way.
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
    completed_chunks: Arc<AtomicU64>,
    total_chunks: Arc<AtomicU64>,
    #[cfg(test)]
    chunk_observer: Option<ChunkProgressObserver>,
}

impl StructureLoadProgress {
    /// Reads the current counters. Both stay zero until the footer is decoded.
    pub fn snapshot(&self) -> StructureLoadSnapshot {
        StructureLoadSnapshot {
            completed_row_groups: self.completed_row_groups.load(Ordering::Acquire),
            total_row_groups: self.total_row_groups.load(Ordering::Acquire),
            completed_chunks: self.completed_chunks.load(Ordering::Acquire),
            total_chunks: self.total_chunks.load(Ordering::Acquire),
        }
    }

    #[cfg(test)]
    fn observe_chunks(&mut self, observer: impl Fn(StructureLoadSnapshot) + Send + Sync + 'static) {
        self.chunk_observer = Some(Arc::new(observer));
    }

    #[cfg(test)]
    fn notify_chunk_observer(&self) {
        if let Some(observer) = &self.chunk_observer {
            observer(self.snapshot());
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
    /// Column chunks already summarized.
    pub completed_chunks: u64,
    /// Column chunks recorded in the decoded footer.
    pub total_chunks: u64,
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
    /// Leaf position in the file schema.
    Index,
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
    /// Parquet metadata version recorded in the footer.
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
    /// Row groups whose local data-page ranges cannot be opened safely.
    /// Structurally valid footer facts still contribute to totals and layout.
    pub unreadable_row_group_count: usize,
    /// Key-value metadata entries in the footer.
    pub key_value_count: usize,
    /// The first [`MAX_KEY_VALUE_ENTRIES`] key-value entries, values excluded.
    pub key_value_metadata: Vec<StructureKeyValueEntry>,
    /// Whether any footer-controlled display string was shortened for the wire payload.
    pub strings_truncated: bool,
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
    /// Inclusive upper ratio bound, absent for the unbounded final step.
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
    /// Chunks that store no compressed bytes and therefore have no ratio.
    pub unrated: StructureLensTotal,
    /// Statistics lens.
    pub statistics: StructurePresenceTotals,
    /// Bloom-filter lens.
    pub bloom_filters: StructurePresenceTotals,
}

/// One named cell of a layout row.
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
    /// Fraction of the row group's bytes in the requested unit.
    pub share: f64,
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

/// All columns omitted from the aligned named slots.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayoutTail {
    /// Columns represented by the aggregate.
    pub column_count: usize,
    /// Stored bytes of the collapsed segments.
    pub compressed_bytes: u64,
    /// Uncompressed bytes of the collapsed segments.
    pub uncompressed_bytes: u64,
    /// Fraction of the row group's bytes in the requested unit.
    pub share: f64,
    /// Whether at least one omitted chunk carries a bloom filter.
    pub has_bloom_filter: bool,
}

/// One whole-file column slot shared by every returned row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayoutColumn {
    /// Leaf column position in the schema.
    pub column_index: usize,
    /// Dotted schema path of the column.
    pub column_name: String,
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
    /// Whether every recorded local data-page range is available in the opened file.
    pub is_readable: bool,
    /// Whether recorded footer facts are structurally usable for visualization.
    pub has_layout_facts: bool,
    /// Cells in the whole-file column order declared by the layout.
    pub segments: Vec<StructureLayoutSegment>,
    /// Every column outside the named slots, absent when nothing was omitted.
    pub tail: Option<StructureLayoutTail>,
}

/// A bounded window of layout rows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureLayout {
    /// Whole-file column order shared by every row.
    pub columns: Vec<StructureLayoutColumn>,
    /// Columns aggregated into each row's remaining cell.
    pub remaining_column_count: usize,
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
    pub has_layout_facts: bool,
    /// Bytes of the optionally focused column within this bucket.
    pub focused_compressed_bytes: u64,
    pub focused_uncompressed_bytes: u64,
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
    /// Whether every recorded local data-page range is available in the opened file.
    pub is_readable: bool,
    /// Whether recorded footer facts are structurally usable for visualization.
    pub has_layout_facts: bool,
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
    has_layout_facts: bool,
    first_row_offset: Option<u64>,
    optional_chunks: Vec<Result<ValidatedChunkOptionalFacts, StructureError>>,
}

struct ColumnFacts {
    name: String,
    physical_type: String,
    logical_type: Option<String>,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    encodings: u16,
    has_bloom_filter: bool,
    cumulative_share_compressed: f64,
    cumulative_share_uncompressed: f64,
}

#[derive(Clone, Copy)]
struct ValidatedChunkOptionalFacts {
    bloom_filter_bytes: Option<u64>,
    has_bloom_filter: bool,
    has_page_index: bool,
    has_offset_index: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct RowGroupOrderKey {
    unit: StructureByteUnit,
    sort: StructureRowGroupSort,
    direction: StructureSortDirection,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ColumnOrderKey {
    unit: StructureByteUnit,
    sort: StructureColumnSort,
    direction: StructureSortDirection,
}

struct CachedOrder<Key> {
    key: Key,
    indices: Arc<[usize]>,
}

/// The parsed footer of one source, shared by every structure query.
///
/// Construction is the only step that reads the footer. Callers are expected to
/// keep one reader per opened source for as long as that source stays open.
pub struct StructureReader {
    file: Option<File>,
    metadata: Arc<ParquetMetaData>,
    summary: StructureSummary,
    lens_totals: StructureLensTotals,
    row_groups: Vec<RowGroupFacts>,
    columns: Vec<ColumnFacts>,
    layout_overview: Vec<StructureLayoutOverviewBucket>,
    row_group_order: Mutex<Option<CachedOrder<RowGroupOrderKey>>>,
    column_order: Mutex<Option<CachedOrder<ColumnOrderKey>>>,
    #[cfg(test)]
    row_group_order_builds: AtomicUsize,
    #[cfg(test)]
    column_order_builds: AtomicUsize,
    file_bytes: u64,
    data_end: u64,
    source_identity: Option<SourceIdentity>,
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
        let snapshot = SourceSnapshot::open(&path)?;
        cancellation.check()?;
        Self::from_snapshot(&snapshot, progress, cancellation)
    }

    /// Adds cancellable structure facts to a footer snapshot decoded during source open.
    pub fn from_snapshot(
        snapshot: &SourceSnapshot,
        progress: &StructureLoadProgress,
        cancellation: &StructureCancellation,
    ) -> Result<Self, StructureError> {
        cancellation.check()?;
        let mut reader = Self::summarize(
            snapshot.metadata_snapshot(),
            snapshot.file_bytes(),
            snapshot.footer_bytes(),
            snapshot.data_end(),
            progress,
            cancellation,
        )?;
        reader.file = Some(snapshot.cloned_file()?);
        reader.source_identity = Some(snapshot.identity().clone());
        Ok(reader)
    }

    fn summarize(
        metadata: Arc<ParquetMetaData>,
        file_bytes: u64,
        footer_bytes: u64,
        data_end: u64,
        progress: &StructureLoadProgress,
        cancellation: &StructureCancellation,
    ) -> Result<Self, StructureError> {
        let file_metadata = metadata.file_metadata();
        let schema = file_metadata.schema_descr();
        let column_count = schema.num_columns();
        let row_count =
            u64::try_from(file_metadata.num_rows()).map_err(|_| StructureError::CorruptFooter)?;
        let row_group_count = metadata.num_row_groups();
        ensure_safe_wire_integer(file_bytes)?;
        ensure_safe_wire_integer(footer_bytes)?;
        ensure_safe_wire_integer(row_count)?;
        ensure_safe_wire_count(row_group_count)?;
        ensure_safe_wire_count(column_count)?;
        progress.total_row_groups.store(
            u64::try_from(row_group_count).map_err(|_| StructureError::CorruptFooter)?,
            Ordering::Release,
        );
        let total_chunks = metadata
            .row_groups()
            .iter()
            .try_fold(0_u64, |total, row_group| {
                total
                    .checked_add(
                        u64::try_from(row_group.columns().len())
                            .map_err(|_| StructureError::CorruptFooter)?,
                    )
                    .ok_or(StructureError::CorruptFooter)
            })?;
        ensure_safe_wire_integer(total_chunks)?;
        progress.total_chunks.store(total_chunks, Ordering::Release);

        let mut columns = schema
            .columns()
            .iter()
            .map(|descriptor| {
                let (name, _) = bounded_column_path(descriptor.path());
                ColumnFacts {
                    name,
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
                    has_bloom_filter: false,
                    cumulative_share_compressed: 0.0,
                    cumulative_share_uncompressed: 0.0,
                }
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
        let mut first_row_offset = Some(0_u64);
        let mut overview = vec![
            LayoutOverviewAccumulator::default();
            row_group_count.min(MAX_LAYOUT_OVERVIEW_BUCKETS)
        ];

        for (index, row_group) in metadata.row_groups().iter().enumerate() {
            cancellation.check()?;
            let optional_chunks = row_group
                .columns()
                .iter()
                .map(validate_chunk_optional_facts)
                .collect::<Vec<_>>();
            for (column_index, optional) in optional_chunks.iter().enumerate() {
                if optional.as_ref().is_ok_and(|facts| facts.has_bloom_filter)
                    && let Some(column) = columns.get_mut(column_index)
                {
                    column.has_bloom_filter = true;
                }
            }
            let has_layout_facts =
                has_valid_row_group_facts(row_group, column_count, cancellation)?
                    && optional_chunks.iter().all(Result::is_ok);
            let is_readable =
                has_layout_facts && row_group_data_is_readable(row_group, data_end, cancellation)?;
            let row_group_rows = u64::try_from(row_group.num_rows()).unwrap_or(0);
            if row_group.num_rows() >= 0 {
                ensure_safe_wire_integer(row_group_rows)?;
            }
            let mut row_group_compressed = 0_u64;
            let mut row_group_uncompressed = 0_u64;
            let mut row_group_blooms = 0_u64;
            if !is_readable {
                unreadable_row_group_count = unreadable_row_group_count
                    .checked_add(1)
                    .ok_or(StructureError::CorruptFooter)?;
            }

            if has_layout_facts {
                if !overview.is_empty() {
                    let bucket = index * overview.len() / row_group_count;
                    overview[bucket].has_layout_facts = true;
                }
                for (column_index, (chunk, optional)) in
                    row_group.columns().iter().zip(&optional_chunks).enumerate()
                {
                    cancellation.check()?;
                    let optional = optional
                        .as_ref()
                        .expect("layout facts include valid optional fields");
                    let chunk_compressed = u64::try_from(chunk.compressed_size()).unwrap_or(0);
                    let chunk_uncompressed = u64::try_from(chunk.uncompressed_size()).unwrap_or(0);
                    ensure_safe_wire_integer(chunk_compressed)?;
                    ensure_safe_wire_integer(chunk_uncompressed)?;
                    row_group_compressed = row_group_compressed
                        .checked_add(chunk_compressed)
                        .ok_or(StructureError::CorruptFooter)?;
                    row_group_uncompressed = row_group_uncompressed
                        .checked_add(chunk_uncompressed)
                        .ok_or(StructureError::CorruptFooter)?;
                    let has_statistics = chunk.statistics().is_some();
                    let has_bloom_filter = optional.has_bloom_filter;
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
                    lens.add(
                        chunk,
                        optional.has_bloom_filter,
                        chunk_compressed,
                        chunk_uncompressed,
                    )?;
                    if !overview.is_empty() {
                        let bucket = index * overview.len() / row_group_count;
                        overview[bucket].add(
                            chunk,
                            optional.has_bloom_filter,
                            chunk_compressed,
                            chunk_uncompressed,
                        )?;
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
                    progress.completed_chunks.fetch_add(1, Ordering::Release);
                    #[cfg(test)]
                    progress.notify_chunk_observer();
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
                progress.completed_chunks.fetch_add(
                    u64::try_from(row_group.columns().len()).unwrap_or(u64::MAX),
                    Ordering::Release,
                );
                #[cfg(test)]
                progress.notify_chunk_observer();
            }
            row_groups.push(RowGroupFacts {
                row_count: row_group_rows,
                compressed_bytes: row_group_compressed,
                uncompressed_bytes: row_group_uncompressed,
                chunk_count: row_group.columns().len(),
                chunks_with_bloom_filter: row_group_blooms,
                is_readable,
                has_layout_facts,
                first_row_offset,
                optional_chunks,
            });
            first_row_offset = if row_group.num_rows() < 0 {
                None
            } else {
                first_row_offset.and_then(|offset| offset.checked_add(row_group_rows))
            };
            if let Some(offset) = first_row_offset {
                ensure_safe_wire_integer(offset)?;
            }
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
        let strings_truncated = file_metadata
            .created_by()
            .is_some_and(|value| value.len() > MAX_REPORT_FIELD_BYTES)
            || schema
                .columns()
                .iter()
                .any(|column| column_path_len(column.path()) > MAX_REPORT_FIELD_BYTES)
            || key_value_metadata.is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.key.len() > MAX_REPORT_FIELD_BYTES)
            });
        let key_value_entries = key_value_metadata
            .map(|entries| {
                entries
                    .iter()
                    .take(MAX_KEY_VALUE_ENTRIES)
                    .enumerate()
                    .map(|(index, entry)| StructureKeyValueEntry {
                        index,
                        key: bounded_wire_field(&entry.key).0,
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
            created_by: file_metadata
                .created_by()
                .map(|value| bounded_wire_field(value).0),
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
            strings_truncated,
        };

        for value in [
            summary.compressed_bytes,
            summary.uncompressed_bytes,
            summary.row_count,
            summary.footer_bytes,
            summary.chunk_count,
            summary.chunks_with_statistics,
            summary.chunks_with_bloom_filter,
        ] {
            ensure_safe_wire_integer(value)?;
        }
        ensure_safe_wire_count(summary.row_group_count)?;
        ensure_safe_wire_count(summary.column_count)?;
        ensure_safe_wire_count(summary.unreadable_row_group_count)?;
        ensure_safe_wire_count(summary.key_value_count)?;

        Ok(Self {
            file: None,
            lens_totals: lens.finish(),
            summary,
            row_groups,
            columns,
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
            row_group_order: Mutex::new(None),
            column_order: Mutex::new(None),
            #[cfg(test)]
            row_group_order_builds: AtomicUsize::new(0),
            #[cfg(test)]
            column_order_builds: AtomicUsize::new(0),
            file_bytes,
            data_end,
            source_identity: None,
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
            key: bounded_wire_field(&entry.key).0,
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
    /// One bounded whole-file ranking selects the named columns. Every row uses
    /// that order and collapses all omitted columns into one exact aggregate.
    pub fn layout(
        &self,
        unit: StructureByteUnit,
        offset: usize,
        limit: usize,
        column_limit: usize,
        focused_column: Option<usize>,
    ) -> StructureLayout {
        let limit = limit.min(MAX_LAYOUT_ROWS);
        let column_indices = self.layout_column_indices(unit, column_limit, focused_column);
        let columns = column_indices
            .iter()
            .map(|column_index| StructureLayoutColumn {
                column_index: *column_index,
                column_name: self.columns[*column_index].name.clone(),
            })
            .collect();
        let remaining_column_count = self
            .columns
            .len()
            .checked_sub(column_indices.len())
            .expect("the bounded layout selection cannot exceed the schema");
        let end = offset.saturating_add(limit).min(self.row_groups.len());
        let rows = (offset.min(end)..end)
            .map(|index| self.layout_row(index, unit, &column_indices))
            .collect();
        let mut overview = self.layout_overview.clone();
        if let Some(column_index) = focused_column.filter(|index| *index < self.columns.len()) {
            let bucket_count = overview.len();
            if bucket_count > 0 {
                for (row_index, row_group) in self.metadata.row_groups().iter().enumerate() {
                    if !self.row_groups[row_index].has_layout_facts {
                        continue;
                    }
                    let Some(chunk) = row_group.columns().get(column_index) else {
                        continue;
                    };
                    let bucket = row_index.saturating_mul(bucket_count) / self.row_groups.len();
                    overview[bucket].focused_compressed_bytes = overview[bucket]
                        .focused_compressed_bytes
                        .saturating_add(u64::try_from(chunk.compressed_size()).unwrap_or(0));
                    overview[bucket].focused_uncompressed_bytes = overview[bucket]
                        .focused_uncompressed_bytes
                        .saturating_add(u64::try_from(chunk.uncompressed_size()).unwrap_or(0));
                }
            }
        }

        StructureLayout {
            columns,
            remaining_column_count,
            overview,
            rows,
        }
    }

    /// Selects one stable whole-file column order in O(columns log K).
    fn layout_column_indices(
        &self,
        unit: StructureByteUnit,
        requested_limit: usize,
        focused_column: Option<usize>,
    ) -> Vec<usize> {
        let limit = requested_limit
            .min(MAX_LAYOUT_COLUMNS)
            .min(self.columns.len());
        if limit == 0 {
            return Vec::new();
        }
        let mut largest = BinaryHeap::with_capacity(limit + 1);
        for (column_index, column) in self.columns.iter().enumerate() {
            let bytes = structure_bytes(column.compressed_bytes, column.uncompressed_bytes, unit);
            largest.push(Reverse((bytes, Reverse(column_index))));
            if largest.len() > limit {
                largest.pop();
            }
        }
        let mut selected = largest
            .into_iter()
            .map(|Reverse((bytes, Reverse(column_index)))| (bytes, column_index))
            .collect::<Vec<_>>();
        selected.sort_unstable_by(|left, right| {
            right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1))
        });

        if let Some(focused) = focused_column.filter(|index| *index < self.columns.len())
            && !selected.iter().any(|(_, index)| *index == focused)
        {
            selected.truncate(limit - 1);
            selected.push((
                structure_bytes(
                    self.columns[focused].compressed_bytes,
                    self.columns[focused].uncompressed_bytes,
                    unit,
                ),
                focused,
            ));
        }
        selected.into_iter().map(|(_, index)| index).collect()
    }

    /// Builds one row in O(K) after the global slots have been selected.
    fn layout_row(
        &self,
        index: usize,
        unit: StructureByteUnit,
        column_indices: &[usize],
    ) -> StructureLayoutRow {
        let facts = &self.row_groups[index];
        let mut segments = Vec::new();
        let mut tail = None;

        if facts.has_layout_facts {
            let chunks = self.metadata.row_group(index).columns();
            let mut selected_compressed = 0_u64;
            let mut selected_uncompressed = 0_u64;
            let mut selected_bloom_filters = 0_u64;
            segments = column_indices
                .iter()
                .map(|column_index| {
                    let chunk = &chunks[*column_index];
                    let optional = facts.optional_chunks[*column_index]
                        .as_ref()
                        .expect("layout facts include valid optional fields");
                    let compressed = u64::try_from(chunk.compressed_size()).unwrap_or(0);
                    let uncompressed = u64::try_from(chunk.uncompressed_size()).unwrap_or(0);
                    selected_compressed = selected_compressed
                        .checked_add(compressed)
                        .expect("validated row-group compressed total contains selected chunks");
                    selected_uncompressed = selected_uncompressed
                        .checked_add(uncompressed)
                        .expect("validated row-group uncompressed total contains selected chunks");
                    selected_bloom_filters += u64::from(optional.has_bloom_filter);
                    self.layout_segment(*column_index, chunk, optional, unit, facts)
                })
                .collect();
            let remaining_count = chunks
                .len()
                .checked_sub(column_indices.len())
                .expect("validated row-group chunks match the schema");
            if remaining_count > 0 {
                let compressed_bytes = facts
                    .compressed_bytes
                    .checked_sub(selected_compressed)
                    .expect("validated row-group compressed total covers selected chunks");
                let uncompressed_bytes = facts
                    .uncompressed_bytes
                    .checked_sub(selected_uncompressed)
                    .expect("validated row-group uncompressed total covers selected chunks");
                let remaining_blooms = facts
                    .chunks_with_bloom_filter
                    .checked_sub(selected_bloom_filters)
                    .expect("validated bloom total covers selected chunks");
                tail = Some(StructureLayoutTail {
                    column_count: remaining_count,
                    compressed_bytes,
                    uncompressed_bytes,
                    share: byte_share(
                        structure_bytes(compressed_bytes, uncompressed_bytes, unit),
                        structure_bytes(facts.compressed_bytes, facts.uncompressed_bytes, unit),
                    ),
                    has_bloom_filter: remaining_blooms > 0,
                });
            }
        }

        StructureLayoutRow {
            index,
            compressed_bytes: facts.compressed_bytes,
            uncompressed_bytes: facts.uncompressed_bytes,
            is_readable: facts.is_readable,
            has_layout_facts: facts.has_layout_facts,
            segments,
            tail,
        }
    }

    fn layout_segment(
        &self,
        column_index: usize,
        chunk: &ColumnChunkMetaData,
        optional: &ValidatedChunkOptionalFacts,
        unit: StructureByteUnit,
        row: &RowGroupFacts,
    ) -> StructureLayoutSegment {
        let compressed_bytes = u64::try_from(chunk.compressed_size()).unwrap_or(0);
        let uncompressed_bytes = u64::try_from(chunk.uncompressed_size()).unwrap_or(0);
        StructureLayoutSegment {
            column_index,
            column_name: self.columns[column_index].name.clone(),
            compressed_bytes,
            uncompressed_bytes,
            compression_ratio: compression_ratio(compressed_bytes, uncompressed_bytes),
            share: byte_share(
                structure_bytes(compressed_bytes, uncompressed_bytes, unit),
                structure_bytes(row.compressed_bytes, row.uncompressed_bytes, unit),
            ),
            codec: codec_name(chunk.compression()).to_owned(),
            encodings: chunk_encoding_names(chunk),
            has_statistics: chunk.statistics().is_some(),
            has_bloom_filter: optional.has_bloom_filter,
            has_page_index: optional.has_page_index,
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
        let (offset, window) = if sort == StructureRowGroupSort::Index {
            direct_index_page(self.row_groups.len(), offset, limit, direction)
        } else {
            let key = RowGroupOrderKey {
                unit: normalized_row_group_unit(sort, unit),
                sort,
                direction,
            };
            let order = self.cached_row_group_order(key);
            let (offset, window) = page_window(&order, offset, limit);
            (offset, window.to_vec())
        };
        StructureRowGroupPage {
            offset,
            total_count: self.row_groups.len(),
            row_groups: window
                .iter()
                .map(|index| self.row_group_summary(*index))
                .collect(),
        }
    }

    fn cached_row_group_order(&self, key: RowGroupOrderKey) -> Arc<[usize]> {
        let mut cache = self
            .row_group_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = cache.as_ref().filter(|cached| cached.key == key) {
            return Arc::clone(&cached.indices);
        }
        let mut order = (0..self.row_groups.len()).collect::<Vec<_>>();
        order.sort_by(|left, right| {
            let left_facts = &self.row_groups[*left];
            let right_facts = &self.row_groups[*right];
            let ordering = match key.sort {
                StructureRowGroupSort::Index => left.cmp(right),
                StructureRowGroupSort::RowCount => left_facts.row_count.cmp(&right_facts.row_count),
                StructureRowGroupSort::Bytes => structure_bytes(
                    left_facts.compressed_bytes,
                    left_facts.uncompressed_bytes,
                    key.unit,
                )
                .cmp(&structure_bytes(
                    right_facts.compressed_bytes,
                    right_facts.uncompressed_bytes,
                    key.unit,
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
            direction_ordering(ordering, key.direction).then_with(|| left.cmp(right))
        });
        #[cfg(test)]
        self.row_group_order_builds.fetch_add(1, Ordering::Relaxed);
        let indices: Arc<[usize]> = Arc::from(order);
        *cache = Some(CachedOrder {
            key,
            indices: Arc::clone(&indices),
        });
        indices
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
            has_layout_facts: facts.has_layout_facts,
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
        let (offset, window) = if sort == StructureColumnSort::Index {
            direct_index_page(self.columns.len(), offset, limit, direction)
        } else {
            let key = ColumnOrderKey {
                unit: normalized_column_unit(sort, unit),
                sort,
                direction,
            };
            let order = self.cached_column_order(key);
            let (offset, window) = page_window(&order, offset, limit);
            (offset, window.to_vec())
        };
        StructureColumnPage {
            offset,
            total_count: self.columns.len(),
            columns: window
                .iter()
                .map(|index| self.column_summary(*index, unit))
                .collect(),
        }
    }

    fn cached_column_order(&self, key: ColumnOrderKey) -> Arc<[usize]> {
        let mut cache = self
            .column_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = cache.as_ref().filter(|cached| cached.key == key) {
            return Arc::clone(&cached.indices);
        }
        let mut order = (0..self.columns.len()).collect::<Vec<_>>();
        match key.sort {
            StructureColumnSort::Index => {}
            StructureColumnSort::Name => order.sort_by(|left, right| {
                let ordering = self.columns[*left].name.cmp(&self.columns[*right].name);
                direction_ordering(ordering, key.direction).then_with(|| left.cmp(right))
            }),
            _ => order.sort_by(|left, right| {
                let left_facts = &self.columns[*left];
                let right_facts = &self.columns[*right];
                let ordering = match key.sort {
                    StructureColumnSort::Index | StructureColumnSort::Name => {
                        std::cmp::Ordering::Equal
                    }
                    StructureColumnSort::Bytes => structure_bytes(
                        left_facts.compressed_bytes,
                        left_facts.uncompressed_bytes,
                        key.unit,
                    )
                    .cmp(&structure_bytes(
                        right_facts.compressed_bytes,
                        right_facts.uncompressed_bytes,
                        key.unit,
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
                direction_ordering(ordering, key.direction).then_with(|| left.cmp(right))
            }),
        }
        #[cfg(test)]
        self.column_order_builds.fetch_add(1, Ordering::Relaxed);
        let indices: Arc<[usize]> = Arc::from(order);
        *cache = Some(CachedOrder {
            key,
            indices: Arc::clone(&indices),
        });
        indices
    }

    fn column_summary(&self, index: usize, unit: StructureByteUnit) -> StructureColumnSummary {
        let facts = &self.columns[index];
        StructureColumnSummary {
            name: facts.name.clone(),
            physical_type: facts.physical_type.clone(),
            logical_type: facts.logical_type.clone(),
            compressed_bytes: facts.compressed_bytes,
            uncompressed_bytes: facts.uncompressed_bytes,
            compression_ratio: compression_ratio(facts.compressed_bytes, facts.uncompressed_bytes),
            encodings: encoding_names(facts.encodings),
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
        let row_group = self
            .metadata
            .row_groups()
            .get(row_group_index)
            .ok_or(StructureError::UnknownRowGroup)?;
        let chunk = row_group
            .columns()
            .get(column_index)
            .ok_or(StructureError::UnknownColumn)?;
        let optional = *self.row_groups[row_group_index]
            .optional_chunks
            .get(column_index)
            .ok_or(StructureError::UnknownColumn)?;
        let optional = optional?;
        let value_count = signed_wire_integer(chunk.num_values())?;
        let compressed_bytes = signed_wire_integer(chunk.compressed_size())?;
        let uncompressed_bytes = signed_wire_integer(chunk.uncompressed_size())?;
        let data_page_offset = signed_wire_integer(chunk.data_page_offset())?;
        let dictionary_page_offset = optional_signed_wire_integer(chunk.dictionary_page_offset())?;
        let statistics = chunk.statistics().map(chunk_statistics);
        if let Some(statistics) = &statistics {
            if let Some(null_count) = statistics.null_count {
                ensure_safe_wire_integer(null_count)?;
            }
            if let Some(distinct_count) = statistics.distinct_count {
                ensure_safe_wire_integer(distinct_count)?;
            }
        }

        Ok(StructureChunkDetails {
            column_index,
            column_name: self.columns[column_index].name.clone(),
            physical_type: physical_type_name(&chunk.column_type()).to_owned(),
            codec: codec_name(chunk.compression()).to_owned(),
            encodings: chunk_encoding_names(chunk),
            value_count,
            compressed_bytes,
            uncompressed_bytes,
            compression_ratio: compression_ratio(compressed_bytes, uncompressed_bytes),
            data_page_offset,
            dictionary_page_offset,
            bloom_filter_bytes: optional.bloom_filter_bytes,
            has_bloom_filter: optional.has_bloom_filter,
            column_has_bloom_filter: self.columns[column_index].has_bloom_filter,
            has_page_index: optional.has_page_index,
            has_offset_index: optional.has_offset_index,
            statistics,
        })
    }

    /// Builds a deterministic, bounded, path-free Markdown structure digest.
    pub fn report(&self, unit: StructureByteUnit) -> String {
        let summary = &self.summary;
        let mut report = String::with_capacity(48 * 1024);
        writeln!(report, "# Parquet structure report\n").expect("writing to a string cannot fail");
        writeln!(report, "## File metadata\n").expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Parquet metadata version: {}",
            summary.format_version
        )
        .expect("writing to a string cannot fail");
        writeln!(
            report,
            "- Writer: {}\n",
            summary
                .created_by
                .as_deref()
                .map(markdown_literal)
                .unwrap_or_else(|| "—".to_owned())
        )
        .expect("writing to a string cannot fail");

        writeln!(report, "## File facts\n").expect("writing to a string cannot fail");
        for (label, value) in [
            ("File bytes", self.file_bytes.to_string()),
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
        writeln!(
            report,
            "- Codecs: {}\n",
            if summary.codecs.is_empty() {
                "—".to_owned()
            } else {
                summary.codecs.join(" + ")
            }
        )
        .expect("writing to a string cannot fail");

        writeln!(
            report,
            "## Lens totals\n\n- Byte unit: {}",
            match unit {
                StructureByteUnit::Compressed => "compressed",
                StructureByteUnit::Uncompressed => "uncompressed",
            }
        )
        .expect("writing to a string cannot fail");
        for codec in &self.lens_totals.codecs {
            writeln!(
                report,
                "- Codec {}: {} chunks · {} bytes",
                markdown_literal(&codec.codec),
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
            "- No stored bytes: {} chunks · {} bytes",
            self.lens_totals.unrated.chunk_count,
            lens_bytes(self.lens_totals.unrated, unit)
        )
        .expect("writing to a string cannot fail");
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
            if !row.has_layout_facts {
                writeln!(report, "| {} | — | — | — | — | no |", row.index)
                    .expect("writing to a string cannot fail");
                continue;
            }
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
            let column_type = column.logical_type.as_ref().map_or_else(
                || column.physical_type.clone(),
                |logical| format!("{} · {logical}", column.physical_type),
            );
            writeln!(
                report,
                "| {} | {} | {} | {} | {} | {:.2}% |",
                markdown_literal(&column.name),
                markdown_literal(&column_type),
                structure_bytes(column.compressed_bytes, column.uncompressed_bytes, unit),
                report_ratio(column.compression_ratio),
                if column.encodings.is_empty() {
                    "—".to_owned()
                } else {
                    markdown_literal(&column.encodings.join(" + "))
                },
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
                writeln!(report, "- {}: {size}", markdown_literal(&entry.key))
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
    /// Supported logical annotations are converted to the exact physical value
    /// the writer hashed. Other annotations fail instead of guessing membership.
    pub fn probe_bloom_filter(
        &self,
        column_index: usize,
        value: &str,
        offset: usize,
        limit: usize,
        cancellation: &StructureCancellation,
    ) -> Result<StructureBloomProbe, StructureError> {
        if value.len() > MAX_BLOOM_PROBE_VALUE_BYTES {
            return Err(StructureError::InvalidProbeValue);
        }
        let descriptor = self
            .metadata
            .file_metadata()
            .schema_descr()
            .columns()
            .get(column_index)
            .ok_or(StructureError::UnknownColumn)?;
        let probe = ProbeValue::parse(
            descriptor.physical_type(),
            descriptor.type_length(),
            descriptor.logical_type_ref(),
            descriptor.converted_type(),
            descriptor.type_precision(),
            descriptor.type_scale(),
            value,
        )?;
        let file = self.file.as_ref().ok_or(StructureError::Unsupported)?;
        if let Some(identity) = &self.source_identity {
            identity.validate_file(file)?;
        }
        let file = file.try_clone().map_err(|_| StructureError::Unsupported)?;
        let reader = BoundedBloomReader::new(file, MAX_BLOOM_PROBE_BYTES);

        let limit = limit.min(MAX_PROBE_ROW_GROUPS);
        let end = offset.saturating_add(limit).min(self.row_groups.len());
        let mut results = Vec::new();
        for index in offset.min(end)..end {
            cancellation.check()?;
            let chunk = self.metadata.row_group(index).columns().get(column_index);
            let optional = self.row_groups[index].optional_chunks.get(column_index);
            let outcome = probe_chunk_bloom(chunk, optional, &probe, &reader, self.data_end);
            results.push(StructureBloomProbeResult { index, outcome });
        }

        if let (Some(identity), Some(file)) = (&self.source_identity, &self.file) {
            identity.validate_file(file)?;
        }
        Ok(StructureBloomProbe {
            offset: offset.min(self.row_groups.len()),
            total_count: self.row_groups.len(),
            row_groups: results,
        })
    }
}

fn probe_chunk_bloom(
    chunk: Option<&ColumnChunkMetaData>,
    optional: Option<&Result<ValidatedChunkOptionalFacts, StructureError>>,
    probe: &ProbeValue,
    reader: &BoundedBloomReader,
    data_end: u64,
) -> StructureBloomProbeOutcome {
    match chunk {
        None => StructureBloomProbeOutcome::Unreadable,
        Some(chunk) if chunk.file_path().is_some() => StructureBloomProbeOutcome::Unreadable,
        Some(_) if !matches!(optional, Some(Ok(_))) => StructureBloomProbeOutcome::Unreadable,
        Some(_)
            if optional
                .is_some_and(|facts| facts.as_ref().is_ok_and(|facts| !facts.has_bloom_filter)) =>
        {
            StructureBloomProbeOutcome::NoFilter
        }
        Some(chunk) => match read_validated_bloom_filter(chunk, reader, data_end) {
            Ok(Some(filter)) if probe.check(&filter) => StructureBloomProbeOutcome::MayContain,
            Ok(Some(_)) => StructureBloomProbeOutcome::DefinitelyAbsent,
            Ok(None) => StructureBloomProbeOutcome::NoFilter,
            Err(_) => StructureBloomProbeOutcome::Unreadable,
        },
    }
}

#[allow(deprecated)] // parquet exposes no maintained BloomFilterHeader decoder yet.
fn read_validated_bloom_filter(
    chunk: &ColumnChunkMetaData,
    reader: &BoundedBloomReader,
    data_end: u64,
) -> Result<Option<Sbbf>, ParquetError> {
    let Some(raw_offset) = chunk.bloom_filter_offset() else {
        return Ok(None);
    };
    let offset = u64::try_from(raw_offset)
        .map_err(|_| ParquetError::General("Bloom filter offset is invalid".to_owned()))?;
    let declared_length = chunk
        .bloom_filter_length()
        .map(|length| {
            usize::try_from(length)
                .map_err(|_| ParquetError::General("Bloom filter length is invalid".to_owned()))
        })
        .transpose()?;
    let initial_length = declared_length.unwrap_or(20);
    let initial_end = offset
        .checked_add(initial_length as u64)
        .filter(|end| *end <= data_end)
        .ok_or_else(|| ParquetError::General("Bloom filter range is invalid".to_owned()))?;
    let initial = reader.get_bytes(offset, initial_length)?;
    let mut cursor = Cursor::new(initial.as_ref());
    let mut protocol = TCompactInputProtocol::new(&mut cursor);
    let header = parquet::format::BloomFilterHeader::read_from_in_protocol(&mut protocol)
        .map_err(|_| ParquetError::General("Bloom filter header is invalid".to_owned()))?;
    drop(protocol);
    let header_length = usize::try_from(cursor.position())
        .map_err(|_| ParquetError::General("Bloom filter header is invalid".to_owned()))?;
    let bitset_length = usize::try_from(header.num_bytes)
        .map_err(|_| ParquetError::General("Bloom filter bitset is invalid".to_owned()))?;
    if bitset_length < 32 || bitset_length % 32 != 0 {
        return Err(ParquetError::General(
            "Bloom filter bitset is invalid".to_owned(),
        ));
    }

    let bitset = match declared_length {
        Some(length) => {
            if header_length.checked_add(bitset_length) != Some(length) {
                return Err(ParquetError::General(
                    "Bloom filter length does not match its header".to_owned(),
                ));
            }
            initial.slice(header_length..)
        }
        None => {
            let bitset_offset = offset
                .checked_add(header_length as u64)
                .ok_or_else(|| ParquetError::General("Bloom filter range is invalid".to_owned()))?;
            bitset_offset
                .checked_add(bitset_length as u64)
                .filter(|end| *end <= data_end && *end >= initial_end)
                .ok_or_else(|| ParquetError::General("Bloom filter range is invalid".to_owned()))?;
            reader.get_bytes(bitset_offset, bitset_length)?
        }
    };
    Ok(Some(Sbbf::new(&bitset)))
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

fn markdown_literal(value: &str) -> String {
    let value = cut_report_field(value)
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\r', '\n'], " ");
    let longest_fence = value
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest_fence + 1);
    format!("{fence} {value} {fence}")
}

fn cut_report_field(value: &str) -> String {
    if value.len() <= MAX_REPORT_FIELD_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_REPORT_FIELD_BYTES - '…'.len_utf8();
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
        logical_type: Option<&LogicalType>,
        converted_type: ConvertedType,
        converted_precision: i32,
        converted_scale: i32,
        value: &str,
    ) -> Result<Self, StructureError> {
        if value.len() > MAX_BLOOM_PROBE_VALUE_BYTES {
            return Err(StructureError::InvalidProbeValue);
        }
        let decimal = match logical_type {
            Some(LogicalType::Decimal { precision, scale }) => Some((*precision, *scale)),
            Some(LogicalType::String) => None,
            Some(_) => return Err(StructureError::UnsupportedProbeColumn),
            None if converted_type == ConvertedType::DECIMAL => {
                Some((converted_precision, converted_scale))
            }
            None if matches!(converted_type, ConvertedType::NONE | ConvertedType::UTF8) => None,
            None => return Err(StructureError::UnsupportedProbeColumn),
        };
        if let Some((precision, scale)) = decimal {
            return Self::decimal(physical_type, type_length, value, precision, scale);
        }
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
            PhysicalType::FLOAT => {
                let value = value
                    .parse::<f32>()
                    .map_err(|_| StructureError::InvalidProbeValue)?;
                if value.is_nan() {
                    return Err(StructureError::UnsupportedProbeColumn);
                }
                Self::Float(value)
            }
            PhysicalType::DOUBLE => {
                let value = value
                    .parse::<f64>()
                    .map_err(|_| StructureError::InvalidProbeValue)?;
                if value.is_nan() {
                    return Err(StructureError::UnsupportedProbeColumn);
                }
                Self::Double(value)
            }
            PhysicalType::BYTE_ARRAY => Self::ByteArray(value.as_bytes().to_vec().into()),
            PhysicalType::FIXED_LEN_BYTE_ARRAY => {
                let length = usize::try_from(type_length)
                    .map_err(|_| StructureError::UnsupportedProbeColumn)?;
                if length > MAX_BLOOM_PROBE_VALUE_BYTES || length != value.len() {
                    return Err(StructureError::InvalidProbeValue);
                }
                Self::FixedLenByteArray(FixedLenByteArray::from(value.as_bytes().to_vec()))
            }
            // An INT96 is three little-endian words with no textual spelling that
            // reproduces the writer's hash input.
            PhysicalType::INT96 => return Err(StructureError::UnsupportedProbeColumn),
        })
    }

    fn decimal(
        physical_type: PhysicalType,
        type_length: i32,
        value: &str,
        precision: i32,
        scale: i32,
    ) -> Result<Self, StructureError> {
        let precision = usize::try_from(precision)
            .ok()
            .filter(|precision| (1..=38).contains(precision))
            .ok_or(StructureError::UnsupportedProbeColumn)?;
        let scale = usize::try_from(scale)
            .ok()
            .filter(|scale| *scale <= precision)
            .ok_or(StructureError::UnsupportedProbeColumn)?;
        match physical_type {
            PhysicalType::INT32 if precision > 9 => {
                return Err(StructureError::UnsupportedProbeColumn);
            }
            PhysicalType::INT64 if precision > 18 => {
                return Err(StructureError::UnsupportedProbeColumn);
            }
            PhysicalType::FIXED_LEN_BYTE_ARRAY => {
                let length = usize::try_from(type_length)
                    .ok()
                    .filter(|length| (1..=MAX_BLOOM_PROBE_PHYSICAL_BYTES).contains(length))
                    .ok_or(StructureError::UnsupportedProbeColumn)?;
                const MAX_PRECISION_BY_BYTES: [usize; MAX_BLOOM_PROBE_PHYSICAL_BYTES] =
                    [2, 4, 6, 9, 11, 14, 16, 18, 21, 23, 26, 28, 31, 33, 35, 38];
                if precision > MAX_PRECISION_BY_BYTES[length - 1] {
                    return Err(StructureError::UnsupportedProbeColumn);
                }
            }
            PhysicalType::INT32 | PhysicalType::INT64 | PhysicalType::BYTE_ARRAY => {}
            _ => return Err(StructureError::UnsupportedProbeColumn),
        }
        let unscaled = parse_decimal_unscaled(value, precision, scale)?;
        Ok(match physical_type {
            PhysicalType::INT32 => {
                Self::Int32(i32::try_from(unscaled).map_err(|_| StructureError::InvalidProbeValue)?)
            }
            PhysicalType::INT64 => {
                Self::Int64(i64::try_from(unscaled).map_err(|_| StructureError::InvalidProbeValue)?)
            }
            PhysicalType::BYTE_ARRAY => Self::ByteArray(decimal_bytes(unscaled).into()),
            PhysicalType::FIXED_LEN_BYTE_ARRAY => {
                let length = usize::try_from(type_length)
                    .expect("validated fixed decimal width is positive");
                let bytes = decimal_bytes(unscaled);
                if bytes.len() > length {
                    return Err(StructureError::InvalidProbeValue);
                }
                let mut padded = vec![if unscaled < 0 { 0xff } else { 0 }; length];
                padded[length - bytes.len()..].copy_from_slice(&bytes);
                Self::FixedLenByteArray(FixedLenByteArray::from(padded))
            }
            _ => return Err(StructureError::UnsupportedProbeColumn),
        })
    }

    fn check(&self, filter: &Sbbf) -> bool {
        match self {
            Self::Boolean(value) => filter.check(value),
            Self::Int32(value) => filter.check(value),
            Self::Int64(value) => filter.check(value),
            Self::Float(value) if *value == 0.0 => {
                filter.check(&0.0_f32) || filter.check(&-0.0_f32)
            }
            Self::Double(value) if *value == 0.0 => {
                filter.check(&0.0_f64) || filter.check(&-0.0_f64)
            }
            Self::Float(value) => filter.check(value),
            Self::Double(value) => filter.check(value),
            Self::ByteArray(value) => filter.check(value),
            Self::FixedLenByteArray(value) => filter.check(value),
        }
    }
}

fn parse_decimal_unscaled(
    value: &str,
    precision: usize,
    scale: usize,
) -> Result<i128, StructureError> {
    let (negative, unsigned) = value
        .strip_prefix('-')
        .map_or((false, value), |rest| (true, rest));
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty()
        || fraction.len() > scale
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit())
    {
        return Err(StructureError::InvalidProbeValue);
    }
    let mut magnitude = 0_i128;
    for digit in whole.bytes().chain(fraction.bytes()) {
        magnitude = magnitude
            .checked_mul(10)
            .and_then(|value| value.checked_add(i128::from(digit - b'0')))
            .ok_or(StructureError::InvalidProbeValue)?;
    }
    for _ in fraction.len()..scale {
        magnitude = magnitude
            .checked_mul(10)
            .ok_or(StructureError::InvalidProbeValue)?;
    }
    let mut precision_limit = 1_i128;
    for _ in 0..precision {
        precision_limit = precision_limit
            .checked_mul(10)
            .ok_or(StructureError::UnsupportedProbeColumn)?;
    }
    if magnitude >= precision_limit {
        return Err(StructureError::InvalidProbeValue);
    }
    if negative {
        magnitude
            .checked_neg()
            .ok_or(StructureError::InvalidProbeValue)
    } else {
        Ok(magnitude)
    }
}

fn decimal_bytes(value: i128) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let mut first = 0;
    while first < bytes.len() - 1
        && ((bytes[first] == 0 && bytes[first + 1] & 0x80 == 0)
            || (bytes[first] == 0xff && bytes[first + 1] & 0x80 != 0))
    {
        first += 1;
    }
    bytes[first..].to_vec()
}

#[derive(Default)]
struct LensAccumulator {
    codecs: Vec<(usize, StructureLensTotal)>,
    ratio_steps: [StructureLensTotal; RATIO_STEP_BOUNDS.len() + 1],
    unrated: StructureLensTotal,
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
    has_layout_facts: bool,
}

impl LayoutOverviewAccumulator {
    fn add(
        &mut self,
        chunk: &ColumnChunkMetaData,
        has_bloom_filter: bool,
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
        self.has_bloom_filter |= has_bloom_filter;
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
            has_layout_facts: self.has_layout_facts,
            focused_compressed_bytes: 0,
            focused_uncompressed_bytes: 0,
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
        has_bloom_filter: bool,
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
                self.unrated.add(compressed_bytes, uncompressed_bytes)?;
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
        self.bloom_filters
            .add(has_bloom_filter, compressed_bytes, uncompressed_bytes)?;
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
            unrated: self.unrated,
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
fn has_valid_row_group_facts(
    row_group: &RowGroupMetaData,
    column_count: usize,
    cancellation: &StructureCancellation,
) -> Result<bool, StructureError> {
    if row_group.num_rows() < 0
        || row_group.total_byte_size() < 0
        || row_group.columns().len() != column_count
    {
        return Ok(false);
    }
    for chunk in row_group.columns() {
        cancellation.check()?;
        if chunk.compressed_size() < 0 || chunk.uncompressed_size() < 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn chunk_range_is_readable(chunk: &ColumnChunkMetaData, data_end: u64) -> bool {
    if chunk.file_path().is_some() || chunk.compressed_size() < 0 || chunk.uncompressed_size() < 0 {
        return false;
    }
    let Ok(data_start) = u64::try_from(chunk.data_page_offset()) else {
        return false;
    };
    let dictionary_start = match chunk.dictionary_page_offset() {
        Some(offset) => match u64::try_from(offset) {
            Ok(offset) => Some(offset),
            Err(_) => return false,
        },
        None => None,
    };
    if data_start < 4
        || data_start >= data_end
        || dictionary_start.is_some_and(|offset| offset < 4 || offset >= data_end)
    {
        return false;
    }
    if dictionary_start.is_some_and(|offset| offset > data_start) {
        return false;
    }
    let start = dictionary_start.map_or(data_start, |offset| offset.min(data_start));
    let Ok(length) = u64::try_from(chunk.compressed_size()) else {
        return false;
    };
    start
        .checked_add(length)
        .is_some_and(|end| data_start < end && end <= data_end)
}

fn row_group_data_is_readable(
    row_group: &RowGroupMetaData,
    data_end: u64,
    cancellation: &StructureCancellation,
) -> Result<bool, StructureError> {
    for chunk in row_group.columns() {
        cancellation.check()?;
        if !chunk_range_is_readable(chunk, data_end) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn byte_share(bytes: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        bytes as f64 / total as f64
    }
}

fn ensure_safe_wire_integer(value: u64) -> Result<u64, StructureError> {
    if value > MAX_SAFE_WIRE_INTEGER {
        return Err(StructureError::Unsupported);
    }
    Ok(value)
}

fn ensure_safe_wire_count(value: usize) -> Result<(), StructureError> {
    let value = u64::try_from(value).map_err(|_| StructureError::Unsupported)?;
    ensure_safe_wire_integer(value).map(|_| ())
}

fn signed_wire_integer(value: i64) -> Result<u64, StructureError> {
    let value = u64::try_from(value).map_err(|_| StructureError::CorruptFooter)?;
    ensure_safe_wire_integer(value)
}

fn optional_signed_wire_integer(value: Option<i64>) -> Result<Option<u64>, StructureError> {
    value.map(signed_wire_integer).transpose()
}

fn has_optional_signed_wire_integer(value: Option<i64>) -> Result<bool, StructureError> {
    value
        .map(signed_wire_integer)
        .transpose()
        .map(|value| value.is_some())
}

fn validate_optional_signed_wire_length(value: Option<i32>) -> Result<(), StructureError> {
    value
        .map(|value| signed_wire_integer(i64::from(value)))
        .transpose()
        .map(|_| ())
}

fn validate_chunk_optional_facts(
    chunk: &ColumnChunkMetaData,
) -> Result<ValidatedChunkOptionalFacts, StructureError> {
    has_optional_signed_wire_integer(chunk.index_page_offset())?;
    let has_bloom_filter = has_optional_signed_wire_integer(chunk.bloom_filter_offset())?;
    let bloom_filter_bytes = chunk
        .bloom_filter_length()
        .map(|length| signed_wire_integer(i64::from(length)))
        .transpose()?;
    let has_page_index = has_optional_signed_wire_integer(chunk.column_index_offset())?;
    validate_optional_signed_wire_length(chunk.column_index_length())?;
    let has_offset_index = has_optional_signed_wire_integer(chunk.offset_index_offset())?;
    validate_optional_signed_wire_length(chunk.offset_index_length())?;
    Ok(ValidatedChunkOptionalFacts {
        bloom_filter_bytes,
        has_bloom_filter,
        has_page_index,
        has_offset_index,
    })
}

fn bounded_wire_field(value: &str) -> (String, bool) {
    if value.len() <= MAX_REPORT_FIELD_BYTES {
        return (value.to_owned(), false);
    }
    let mut end = MAX_REPORT_FIELD_BYTES - '…'.len_utf8();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &value[..end]), true)
}

fn column_path_len(path: &parquet::schema::types::ColumnPath) -> usize {
    path.parts()
        .iter()
        .enumerate()
        .fold(0, |total, (index, part)| {
            total
                .saturating_add(usize::from(index > 0))
                .saturating_add(part.len())
        })
}

fn bounded_column_path(path: &parquet::schema::types::ColumnPath) -> (String, bool) {
    let full_length = column_path_len(path);
    let truncated = full_length > MAX_REPORT_FIELD_BYTES;
    let content_limit = if truncated {
        MAX_REPORT_FIELD_BYTES - '…'.len_utf8()
    } else {
        MAX_REPORT_FIELD_BYTES
    };
    let mut value = String::with_capacity(full_length.min(MAX_REPORT_FIELD_BYTES));
    for (index, part) in path.parts().iter().enumerate() {
        let separator_bytes = usize::from(index > 0);
        let available = content_limit.saturating_sub(value.len());
        if available <= separator_bytes {
            break;
        }
        let remaining = available - separator_bytes;
        let mut end = remaining.min(part.len());
        while !part.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            break;
        }
        if index > 0 {
            value.push('.');
        }
        value.push_str(&part[..end]);
    }
    if truncated {
        value.push('…');
    }
    (value, truncated)
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

fn normalized_row_group_unit(
    sort: StructureRowGroupSort,
    unit: StructureByteUnit,
) -> StructureByteUnit {
    if sort == StructureRowGroupSort::Bytes {
        unit
    } else {
        StructureByteUnit::Compressed
    }
}

fn normalized_column_unit(sort: StructureColumnSort, unit: StructureByteUnit) -> StructureByteUnit {
    if sort == StructureColumnSort::Bytes {
        unit
    } else {
        StructureByteUnit::Compressed
    }
}

fn direct_index_page(
    total: usize,
    offset: usize,
    limit: usize,
    direction: StructureSortDirection,
) -> (usize, Vec<usize>) {
    let limit = limit.min(MAX_PAGE_SIZE);
    let start = offset.min(total);
    let end = start.saturating_add(limit).min(total);
    let indices = match direction {
        StructureSortDirection::Ascending => (start..end).collect(),
        StructureSortDirection::Descending => (start..end).map(|index| total - index - 1).collect(),
    };
    (start, indices)
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
            values
                .min_opt()
                .map(|value| render_bounded_bytes(value.data())),
            values
                .max_opt()
                .map(|value| render_bounded_bytes(value.data())),
        ),
        Statistics::FixedLenByteArray(values) => (
            values
                .min_opt()
                .map(|value| render_bounded_bytes(value.data())),
            values
                .max_opt()
                .map(|value| render_bounded_bytes(value.data())),
        ),
    };

    StructureChunkStatistics {
        minimum: minimum.map(|value| cut_statistic(&value)),
        maximum: maximum.map(|value| cut_statistic(&value)),
        minimum_is_exact: statistics.min_is_exact(),
        maximum_is_exact: statistics.max_is_exact(),
        null_count: statistics.null_count_opt(),
        distinct_count: statistics.distinct_count_opt(),
    }
}

fn render_bounded_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => cut_statistic(text),
        Err(_) => {
            let byte_limit = MAX_STATISTIC_CHARACTERS / 2;
            let mut rendered = String::with_capacity(MAX_STATISTIC_CHARACTERS + 1);
            for byte in bytes.iter().take(byte_limit) {
                write!(rendered, "{byte:02x}").expect("writing to a string cannot fail");
            }
            if bytes.len() > byte_limit {
                rendered.push('…');
            }
            rendered
        }
    }
}

fn cut_statistic(value: &str) -> String {
    let mut chars = value.chars();
    let mut bounded = String::with_capacity(MAX_STATISTIC_CHARACTERS + 1);
    for _ in 0..MAX_STATISTIC_CHARACTERS {
        let Some(character) = chars.next() else {
            return bounded;
        };
        bounded.push(character);
    }
    if chars.next().is_some() {
        bounded.push('…');
    }
    bounded
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
    fn converts_decimal_probe_text_to_exact_physical_values() {
        let value = ProbeValue::parse(
            PhysicalType::INT64,
            0,
            Some(&LogicalType::Decimal {
                precision: 12,
                scale: 2,
            }),
            ConvertedType::NONE,
            0,
            0,
            "-12.34",
        )
        .expect("decimal probe");
        assert!(matches!(value, ProbeValue::Int64(-1234)));
        assert!(matches!(
            ProbeValue::parse(
                PhysicalType::INT32,
                0,
                None,
                ConvertedType::DECIMAL,
                9,
                2,
                "12.34",
            ),
            Ok(ProbeValue::Int32(1234))
        ));
        assert_eq!(
            ProbeValue::parse(
                PhysicalType::INT32,
                0,
                Some(&LogicalType::Date),
                ConvertedType::NONE,
                0,
                0,
                "2026-08-21",
            )
            .err(),
            Some(StructureError::UnsupportedProbeColumn)
        );
    }

    #[test]
    fn rejects_decimal_metadata_before_allocating_physical_probe_bytes() {
        let decimal = |physical_type, type_length, precision, scale, value| {
            ProbeValue::parse(
                physical_type,
                type_length,
                Some(&LogicalType::Decimal { precision, scale }),
                ConvertedType::NONE,
                0,
                0,
                value,
            )
        };

        assert!(
            decimal(
                PhysicalType::FIXED_LEN_BYTE_ARRAY,
                16,
                38,
                0,
                "99999999999999999999999999999999999999",
            )
            .is_ok()
        );
        for (label, result) in [
            (
                "precision above i128",
                decimal(PhysicalType::BYTE_ARRAY, 0, 39, 0, "1"),
            ),
            (
                "scale above precision",
                decimal(PhysicalType::BYTE_ARRAY, 0, 38, i32::MAX, "1"),
            ),
            (
                "fixed width above i128",
                decimal(PhysicalType::FIXED_LEN_BYTE_ARRAY, i32::MAX, 38, 0, "1"),
            ),
        ] {
            assert_eq!(
                result.err(),
                Some(StructureError::UnsupportedProbeColumn),
                "{label}"
            );
        }
        assert_eq!(
            ProbeValue::parse(
                PhysicalType::BYTE_ARRAY,
                0,
                None,
                ConvertedType::NONE,
                0,
                0,
                &"x".repeat(MAX_BLOOM_PROBE_VALUE_BYTES + 1),
            )
            .err(),
            Some(StructureError::InvalidProbeValue)
        );
    }

    #[test]
    fn float_zero_probes_cover_both_signed_hash_inputs_and_reject_nan() {
        for stored in [0.0_f32, -0.0_f32] {
            let mut filter = Sbbf::new_with_num_of_bytes(32);
            filter.insert(&stored);
            let probe =
                ProbeValue::parse(PhysicalType::FLOAT, 0, None, ConvertedType::NONE, 0, 0, "0")
                    .expect("zero float probe");
            assert!(probe.check(&filter));
        }
        for stored in [0.0_f64, -0.0_f64] {
            let mut filter = Sbbf::new_with_num_of_bytes(32);
            filter.insert(&stored);
            let probe = ProbeValue::parse(
                PhysicalType::DOUBLE,
                0,
                None,
                ConvertedType::NONE,
                0,
                0,
                "-0",
            )
            .expect("zero double probe");
            assert!(probe.check(&filter));
        }
        for bits in [
            0x7ff8_0000_0000_0000,
            0x7ff8_0000_0000_0001,
            0xfff8_0000_0000_0042,
        ] {
            let nan = f64::from_bits(bits);
            let mut filter = Sbbf::new_with_num_of_bytes(32);
            filter.insert(&nan);
            assert!(filter.check(&nan), "direct filter stores each NaN payload");
        }
        for nan in ["NaN", "nan", "-NaN"] {
            assert_eq!(
                ProbeValue::parse(
                    PhysicalType::DOUBLE,
                    0,
                    None,
                    ConvertedType::NONE,
                    0,
                    0,
                    nan,
                )
                .err(),
                Some(StructureError::UnsupportedProbeColumn),
            );
        }
    }

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
        assert!(
            reader
                .report(StructureByteUnit::Compressed)
                .contains("| 1 | — | — | — | — | no |"),
            "invalid footer facts stay unavailable in the report"
        );
        let no_valid_chunks =
            summarize_metadata(test_metadata(vec![test_row_group(&schema, 2, 40, -1, 30)]))
                .expect("an invalid-only footer stays reportable");
        assert!(
            no_valid_chunks
                .report(StructureByteUnit::Compressed)
                .contains("- Codecs: —")
        );
    }

    #[test]
    fn chunk_details_reject_every_negative_signed_fact() {
        let schema = test_schema();
        let chunk = || {
            ColumnChunkMetaData::builder(schema.column(0))
                .set_num_values(1)
                .set_data_page_offset(4)
                .set_total_compressed_size(10)
                .set_total_uncompressed_size(20)
        };
        let invalid = [
            ("values", chunk().set_num_values(-1).build()),
            (
                "compressed size",
                chunk().set_total_compressed_size(-1).build(),
            ),
            (
                "uncompressed size",
                chunk().set_total_uncompressed_size(-1).build(),
            ),
            ("data offset", chunk().set_data_page_offset(-1).build()),
            (
                "dictionary offset",
                chunk().set_dictionary_page_offset(Some(-1)).build(),
            ),
            (
                "index page offset",
                chunk().set_index_page_offset(Some(-1)).build(),
            ),
            (
                "Bloom offset",
                chunk().set_bloom_filter_offset(Some(-1)).build(),
            ),
            (
                "Bloom length",
                chunk().set_bloom_filter_length(Some(-1)).build(),
            ),
            (
                "column index offset",
                chunk().set_column_index_offset(Some(-1)).build(),
            ),
            (
                "column index length",
                chunk().set_column_index_length(Some(-1)).build(),
            ),
            (
                "offset index offset",
                chunk().set_offset_index_offset(Some(-1)).build(),
            ),
            (
                "offset index length",
                chunk().set_offset_index_length(Some(-1)).build(),
            ),
        ];

        for (label, chunk) in invalid {
            let chunk = chunk.expect("the metadata model preserves signed footer facts");
            let row_group = RowGroupMetaData::builder(Arc::clone(&schema))
                .set_num_rows(1)
                .set_total_byte_size(20)
                .set_column_metadata(vec![chunk])
                .build()
                .expect("row group metadata");
            let reader = summarize_metadata(test_metadata(vec![row_group]))
                .expect("the footer remains available for bounded structure facts");

            assert_eq!(
                reader.chunk_details(0, 0),
                Err(StructureError::CorruptFooter),
                "{label}"
            );
            if matches!(
                label,
                "index page offset"
                    | "Bloom offset"
                    | "Bloom length"
                    | "column index offset"
                    | "column index length"
                    | "offset index offset"
                    | "offset index length"
            ) {
                let row = reader.row_group_summary(0);
                assert!(!row.has_layout_facts, "{label}");
                let layout = reader.layout(StructureByteUnit::Compressed, 0, 1, 1, None);
                assert!(!layout.rows[0].has_layout_facts, "{label}");
                assert!(layout.rows[0].segments.is_empty(), "{label}");
                assert_eq!(reader.summary().chunk_count, 0, "{label}");
            }
        }
    }

    #[test]
    fn chunk_details_keep_valid_footer_facts_when_data_pages_are_truncated() {
        let schema = test_schema();
        let metadata = test_metadata(vec![test_row_group(&schema, 2, 40, 10, 30)]);
        let reader = StructureReader::summarize(
            Arc::new(metadata),
            128,
            8,
            4,
            &StructureLoadProgress::default(),
            &StructureCancellation::default(),
        )
        .expect("valid footer facts remain available");

        assert!(!reader.row_group_summary(0).is_readable);
        assert!(reader.row_group_summary(0).has_layout_facts);
        assert_eq!(
            reader
                .chunk_details(0, 0)
                .expect("details do not depend on readable data pages")
                .compressed_bytes,
            10
        );
        assert!(
            reader
                .report(StructureByteUnit::Compressed)
                .contains("| 0 | 2 | 10 | 3.00 | 0 of 1 | no |")
        );
    }

    #[test]
    fn chunk_details_reuse_validated_column_bloom_presence() {
        let schema = test_schema();
        let chunk = |bloom: bool| {
            let mut builder = ColumnChunkMetaData::builder(schema.column(0))
                .set_num_values(1)
                .set_data_page_offset(4)
                .set_total_compressed_size(10)
                .set_total_uncompressed_size(20);
            if bloom {
                builder = builder
                    .set_bloom_filter_offset(Some(40))
                    .set_bloom_filter_length(Some(32));
            }
            builder.build().expect("chunk metadata")
        };
        let row_group = |chunk| {
            RowGroupMetaData::builder(Arc::clone(&schema))
                .set_num_rows(1)
                .set_total_byte_size(20)
                .set_column_metadata(vec![chunk])
                .build()
                .expect("row group metadata")
        };
        let reader = summarize_metadata(test_metadata(vec![
            row_group(chunk(true)),
            row_group(chunk(false)),
        ]))
        .expect("valid optional facts are cached");

        let details = reader.chunk_details(1, 0).expect("second chunk details");
        assert!(!details.has_bloom_filter);
        assert!(details.column_has_bloom_filter);
    }

    #[test]
    fn rejects_structure_facts_the_javascript_wire_cannot_preserve() {
        let schema = test_schema();
        let unsafe_integer = i64::try_from(MAX_SAFE_WIRE_INTEGER + 1).expect("limit fits i64");
        let unsafe_size = test_metadata(vec![test_row_group(
            &schema,
            1,
            unsafe_integer,
            unsafe_integer,
            unsafe_integer,
        )]);
        assert_eq!(
            summarize_metadata(unsafe_size).err(),
            Some(StructureError::Unsupported)
        );

        let chunk = ColumnChunkMetaData::builder(schema.column(0))
            .set_num_values(unsafe_integer)
            .set_data_page_offset(4)
            .set_total_compressed_size(10)
            .set_total_uncompressed_size(20)
            .build()
            .expect("chunk metadata");
        let row_group = RowGroupMetaData::builder(Arc::clone(&schema))
            .set_num_rows(1)
            .set_total_byte_size(20)
            .set_column_metadata(vec![chunk])
            .build()
            .expect("row group metadata");
        let reader = summarize_metadata(test_metadata(vec![row_group]))
            .expect("summary does not publish the chunk value count");
        assert_eq!(reader.chunk_details(0, 0), Err(StructureError::Unsupported));
    }

    #[test]
    fn rejects_footer_sizes_outside_the_javascript_wire_range() {
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
            Some(StructureError::Unsupported)
        );
    }

    #[test]
    fn rejects_lens_totals_that_overflow() {
        let mut total = StructureLensTotal {
            chunk_count: u64::MAX,
            compressed_bytes: u64::MAX,
            uncompressed_bytes: u64::MAX,
        };

        assert_eq!(total.add(1, 1), Err(StructureError::CorruptFooter));
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
    fn caches_each_table_order_across_subsequent_pages() {
        let schema = test_schema_with_columns(3);
        let reader = summarize_metadata(test_metadata(vec![
            test_row_group_with_column_sizes(&schema, &[(30, 60), (20, 40), (10, 20)]),
            test_row_group_with_column_sizes(&schema, &[(10, 20), (30, 60), (20, 40)]),
            test_row_group_with_column_sizes(&schema, &[(20, 40), (10, 20), (30, 60)]),
        ]))
        .expect("fixture is summarizable");

        reader.row_group_page(
            StructureByteUnit::Compressed,
            StructureRowGroupSort::Bytes,
            StructureSortDirection::Descending,
            0,
            1,
        );
        reader.row_group_page(
            StructureByteUnit::Compressed,
            StructureRowGroupSort::Bytes,
            StructureSortDirection::Descending,
            1,
            1,
        );
        assert_eq!(reader.row_group_order_builds.load(Ordering::Relaxed), 1);
        reader.row_group_page(
            StructureByteUnit::Uncompressed,
            StructureRowGroupSort::RowCount,
            StructureSortDirection::Ascending,
            0,
            1,
        );
        reader.row_group_page(
            StructureByteUnit::Compressed,
            StructureRowGroupSort::RowCount,
            StructureSortDirection::Ascending,
            1,
            1,
        );
        assert_eq!(reader.row_group_order_builds.load(Ordering::Relaxed), 2);

        reader.column_page(
            StructureByteUnit::Compressed,
            StructureColumnSort::Bytes,
            StructureSortDirection::Descending,
            0,
            1,
        );
        reader.column_page(
            StructureByteUnit::Compressed,
            StructureColumnSort::Bytes,
            StructureSortDirection::Descending,
            1,
            1,
        );
        assert_eq!(reader.column_order_builds.load(Ordering::Relaxed), 1);
        reader.column_page(
            StructureByteUnit::Uncompressed,
            StructureColumnSort::Name,
            StructureSortDirection::Ascending,
            0,
            1,
        );
        reader.column_page(
            StructureByteUnit::Compressed,
            StructureColumnSort::Name,
            StructureSortDirection::Ascending,
            1,
            1,
        );
        assert_eq!(reader.column_order_builds.load(Ordering::Relaxed), 2);

        reader.row_group_page(
            StructureByteUnit::Compressed,
            StructureRowGroupSort::Index,
            StructureSortDirection::Ascending,
            0,
            1,
        );
        reader.column_page(
            StructureByteUnit::Compressed,
            StructureColumnSort::Index,
            StructureSortDirection::Ascending,
            0,
            1,
        );
        assert_eq!(reader.row_group_order_builds.load(Ordering::Relaxed), 2);
        assert_eq!(reader.column_order_builds.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn layout_aligns_whole_file_columns_and_conserves_the_remaining_tail() {
        let schema = test_schema_with_columns(4);
        let metadata = test_metadata(vec![
            test_row_group_with_column_sizes(&schema, &[(100, 1_000), (20, 40), (10, 20), (1, 2)]),
            test_row_group_with_column_sizes(&schema, &[(1, 2), (90, 180), (20, 40), (5, 10)]),
        ]);
        let reader = summarize_metadata(metadata).expect("fixture is summarizable");

        let layout = reader.layout(StructureByteUnit::Compressed, 0, 80, 3, None);

        assert_eq!(
            layout
                .columns
                .iter()
                .map(|column| column.column_index)
                .collect::<Vec<_>>(),
            vec![1, 0, 2],
            "whole-file totals, not local row sizes, define every x position"
        );
        assert_eq!(layout.remaining_column_count, 1);
        for row in &layout.rows {
            assert_eq!(
                row.segments
                    .iter()
                    .map(|segment| segment.column_index)
                    .collect::<Vec<_>>(),
                vec![1, 0, 2]
            );
            let tail = row.tail.expect("one column remains");
            assert_eq!(tail.column_count, 1);
            assert_eq!(
                row.segments
                    .iter()
                    .map(|segment| segment.compressed_bytes)
                    .sum::<u64>()
                    + tail.compressed_bytes,
                row.compressed_bytes
            );
            assert_eq!(
                row.segments
                    .iter()
                    .map(|segment| segment.uncompressed_bytes)
                    .sum::<u64>()
                    + tail.uncompressed_bytes,
                row.uncompressed_bytes
            );
        }
        assert_eq!(layout.rows[0].tail.expect("tail").compressed_bytes, 1);
        assert_eq!(layout.rows[1].tail.expect("tail").compressed_bytes, 5);

        let uncompressed = reader.layout(StructureByteUnit::Uncompressed, 0, 80, 3, None);
        assert_eq!(
            uncompressed
                .columns
                .iter()
                .map(|column| column.column_index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2],
            "changing the active unit changes the one whole-file ranking"
        );
    }

    #[test]
    fn layout_reserves_the_last_bounded_slot_for_a_focused_tail_column() {
        let schema = test_schema_with_columns(13);
        let sizes = (1..=13)
            .rev()
            .map(|size| (size, size * 2))
            .collect::<Vec<_>>();
        let reader = summarize_metadata(test_metadata(vec![test_row_group_with_column_sizes(
            &schema, &sizes,
        )]))
        .expect("fixture is summarizable");

        let ordinary = reader.layout(StructureByteUnit::Compressed, 0, 80, usize::MAX, None);
        assert_eq!(ordinary.columns.len(), MAX_LAYOUT_COLUMNS);
        assert_eq!(ordinary.remaining_column_count, 1);
        assert_eq!(
            ordinary.columns.last().map(|column| column.column_index),
            Some(11)
        );

        let focused = reader.layout(StructureByteUnit::Compressed, 0, 80, usize::MAX, Some(12));
        assert_eq!(focused.columns.len(), MAX_LAYOUT_COLUMNS);
        assert_eq!(
            focused.columns.last().map(|column| column.column_index),
            Some(12)
        );
        assert_eq!(
            focused.rows[0]
                .segments
                .last()
                .map(|segment| segment.column_index),
            Some(12)
        );
        let tail = focused.rows[0].tail.expect("one displaced column remains");
        assert_eq!(tail.column_count, 1);
        assert_eq!(tail.compressed_bytes, 2);
        assert_eq!(tail.uncompressed_bytes, 4);
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
        overview
            .add(&snappy, false, 100, 1_000)
            .expect("bounded totals");
        overview
            .add(&zstd, false, 200, 300)
            .expect("bounded totals");

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
                Arc::new(metadata),
                MAX_SAFE_WIRE_INTEGER,
                8,
                MAX_SAFE_WIRE_INTEGER - 8,
                &StructureLoadProgress::default(),
                &cancellation,
            )
            .err(),
            Some(StructureError::Cancelled)
        );
    }

    #[test]
    fn publishes_chunk_progress_inside_one_wide_row_group() {
        const COLUMN_COUNT: usize = 10_000;
        let schema = test_schema_with_columns(COLUMN_COUNT);
        let chunks = (0..COLUMN_COUNT)
            .map(|index| {
                ColumnChunkMetaData::builder(schema.column(index))
                    .set_total_compressed_size(1)
                    .set_total_uncompressed_size(1)
                    .build()
                    .expect("column chunk metadata is valid")
            })
            .collect();
        let row_group = RowGroupMetaData::builder(Arc::clone(&schema))
            .set_num_rows(1)
            .set_total_byte_size(COLUMN_COUNT as i64)
            .set_column_metadata(chunks)
            .build()
            .expect("wide row group metadata is valid");
        let metadata = test_metadata(vec![row_group]);
        let mut progress = StructureLoadProgress::default();
        let intermediate = Arc::new(Mutex::new(None));
        let observed = Arc::clone(&intermediate);
        progress.observe_chunks(move |snapshot| {
            if snapshot.completed_chunks > 0
                && snapshot.completed_chunks < snapshot.total_chunks
                && snapshot.completed_row_groups == 0
            {
                observed
                    .lock()
                    .expect("observed progress lock")
                    .get_or_insert(snapshot);
            }
        });
        let reader = StructureReader::summarize(
            Arc::new(metadata),
            MAX_SAFE_WIRE_INTEGER,
            8,
            MAX_SAFE_WIRE_INTEGER - 8,
            &progress,
            &StructureCancellation::default(),
        )
        .expect("wide footer is summarizable");

        assert_eq!(reader.summary().column_count, COLUMN_COUNT);
        assert_eq!(
            intermediate
                .lock()
                .expect("observed progress lock")
                .expect("chunk progress advances before the row group ends")
                .total_chunks,
            COLUMN_COUNT as u64
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
            Arc::new(metadata),
            MAX_SAFE_WIRE_INTEGER,
            8,
            MAX_SAFE_WIRE_INTEGER - 8,
            &StructureLoadProgress::default(),
            &StructureCancellation::default(),
        )
        .expect("fixture is summarizable");

        let report = reader.report(StructureByteUnit::Compressed);
        let uncompressed_report = reader.report(StructureByteUnit::Uncompressed);

        assert!(!report.contains("Viewda"));
        assert!(report.starts_with("# Parquet structure report\n"));
        assert!(report.contains("Parquet metadata version: 2"));
        assert!(report.contains("Writer: ` writer-version `"));
        assert!(report.contains("metadata-key-"));
        assert!(report.contains("… `: 21 bytes"));
        assert!(report.contains("…and 1 more row groups"));
        assert!(!report.contains("SOURCE_IDENTITY"));
        assert!(!report.contains("SECRET_METADATA_VALUE"));
        assert!(report.len() <= MAX_REPORT_BYTES);
        assert!(uncompressed_report.contains("Byte unit: uncompressed"));
        assert!(uncompressed_report.contains("## Columns (uncompressed bytes)"));
        assert_ne!(report, uncompressed_report);
        let key = &reader.summary().key_value_metadata[0].key;
        assert!(key.ends_with('…'));
        assert!(key.len() <= MAX_REPORT_FIELD_BYTES);
    }

    #[test]
    fn report_renders_footer_text_as_inert_literals_and_includes_logical_types() {
        let column_name = "[column](https://evil.invalid)<script>";
        let field = Arc::new(
            Type::primitive_type_builder(column_name, PhysicalType::BYTE_ARRAY)
                .with_repetition(Repetition::REQUIRED)
                .with_logical_type(Some(LogicalType::String))
                .build()
                .expect("hostile field name remains valid footer text"),
        );
        let root = Type::group_type_builder("schema")
            .with_fields(vec![field])
            .build()
            .expect("schema");
        let schema = Arc::new(SchemaDescriptor::new(Arc::new(root)));
        let row_group = test_row_group(&schema, 1, 10, 10, 10);
        let writer = "[writer](https://evil.invalid)<img src=x>";
        let key = "[key](https://evil.invalid)<iframe>";
        let metadata = ParquetMetaData::new(
            FileMetaData::new(
                2,
                1,
                Some(writer.to_owned()),
                Some(vec![KeyValue::new(key.to_owned(), None)]),
                schema,
                None,
            ),
            vec![row_group],
        );
        let reader = summarize_metadata(metadata).expect("footer text is summarizable");

        let report = reader.report(StructureByteUnit::Compressed);

        assert!(report.contains(&format!("Writer: ` {writer} `")));
        assert!(report.contains(&format!("| ` {column_name} ` | ` BYTE_ARRAY · String ` |")));
        assert!(report.contains(&format!("- ` {key} `: —")));
        assert!(!report.contains(&format!("Writer: {writer}")));
        assert!(!report.contains(&format!("| {column_name} |")));
        assert!(!report.contains(&format!("- {key}:")));
    }

    #[test]
    fn bounded_wire_fields_keep_the_ellipsis_inside_the_byte_limit() {
        let source = "界|\\".repeat(100);
        let (value, truncated) = bounded_wire_field(&source);

        assert!(truncated);
        assert!(value.ends_with('…'));
        assert!(value.len() <= MAX_REPORT_FIELD_BYTES);
    }

    #[test]
    fn never_treats_external_column_offsets_as_local_data_ranges() {
        let schema = test_schema();
        let chunk = ColumnChunkMetaData::builder(schema.column(0))
            .set_file_path("external.parquet".to_owned())
            .set_data_page_offset(4)
            .set_total_compressed_size(32)
            .set_total_uncompressed_size(32)
            .build()
            .expect("external chunk metadata");

        assert!(!chunk_range_is_readable(&chunk, 1_024));
        let source = tempfile::NamedTempFile::new().expect("temporary file");
        let reader = BoundedBloomReader::new(source.reopen().expect("fixture can reopen"), 32);
        let optional = validate_chunk_optional_facts(&chunk);
        assert_eq!(
            probe_chunk_bloom(
                Some(&chunk),
                Some(&optional),
                &ProbeValue::Int32(1),
                &reader,
                1_024,
            ),
            StructureBloomProbeOutcome::Unreadable,
        );
    }

    #[test]
    fn requires_data_pages_to_fall_inside_the_recorded_chunk_range() {
        let schema = test_schema();
        let after_chunk = ColumnChunkMetaData::builder(schema.column(0))
            .set_dictionary_page_offset(Some(4))
            .set_data_page_offset(999)
            .set_total_compressed_size(32)
            .set_total_uncompressed_size(32)
            .build()
            .expect("chunk metadata");
        let reversed = ColumnChunkMetaData::builder(schema.column(0))
            .set_dictionary_page_offset(Some(128))
            .set_data_page_offset(64)
            .set_total_compressed_size(128)
            .set_total_uncompressed_size(128)
            .build()
            .expect("chunk metadata");

        assert!(!chunk_range_is_readable(&after_chunk, 1_024));
        assert!(!chunk_range_is_readable(&reversed, 1_024));
    }

    #[test]
    #[allow(deprecated)] // Test headers use the same generated Parquet boundary type.
    fn rejects_empty_and_length_mismatched_bloom_bitsets_before_membership_checks() {
        use parquet::format::{
            BloomFilterAlgorithm, BloomFilterCompression, BloomFilterHash, BloomFilterHeader,
            SplitBlockAlgorithm, Uncompressed, XxHash,
        };
        use std::io::Write as _;
        use thrift::protocol::TCompactOutputProtocol;

        let schema = test_schema();
        for (declared_bitset, actual_bitset) in [(0, 0), (32, 64)] {
            let header = BloomFilterHeader::new(
                declared_bitset,
                BloomFilterAlgorithm::BLOCK(SplitBlockAlgorithm::new()),
                BloomFilterHash::XXHASH(XxHash::new()),
                BloomFilterCompression::UNCOMPRESSED(Uncompressed::new()),
            );
            let mut bytes = Vec::new();
            header
                .write_to_out_protocol(&mut TCompactOutputProtocol::new(&mut bytes))
                .expect("header serializes");
            bytes.resize(bytes.len() + actual_bitset as usize, 0);
            let mut source = tempfile::NamedTempFile::new().expect("temporary file");
            source.write_all(&bytes).expect("fixture bytes");
            let chunk = ColumnChunkMetaData::builder(schema.column(0))
                .set_bloom_filter_offset(Some(0))
                .set_bloom_filter_length(Some(bytes.len() as i32))
                .build()
                .expect("bloom metadata");
            let reader = BoundedBloomReader::new(
                source.reopen().expect("fixture can reopen"),
                MAX_BLOOM_PROBE_BYTES,
            );

            assert!(read_validated_bloom_filter(&chunk, &reader, bytes.len() as u64).is_err());
        }
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
            ProbeValue::parse(
                PhysicalType::INT32,
                0,
                None,
                ConvertedType::NONE,
                0,
                0,
                "17"
            ),
            Ok(ProbeValue::Int32(17))
        ));
        assert_eq!(
            ProbeValue::parse(
                PhysicalType::INT32,
                0,
                None,
                ConvertedType::NONE,
                0,
                0,
                "seventeen",
            )
            .err(),
            Some(StructureError::InvalidProbeValue)
        );
        assert_eq!(
            ProbeValue::parse(
                PhysicalType::FIXED_LEN_BYTE_ARRAY,
                4,
                None,
                ConvertedType::NONE,
                0,
                0,
                "abc",
            )
            .err(),
            Some(StructureError::InvalidProbeValue)
        );
        assert!(
            ProbeValue::parse(
                PhysicalType::FIXED_LEN_BYTE_ARRAY,
                4,
                None,
                ConvertedType::NONE,
                0,
                0,
                "abcd",
            )
            .is_ok()
        );
        assert_eq!(
            ProbeValue::parse(
                PhysicalType::INT96,
                0,
                None,
                ConvertedType::NONE,
                0,
                0,
                "17"
            )
            .err(),
            Some(StructureError::UnsupportedProbeColumn)
        );
    }

    #[test]
    fn renders_non_text_statistics_as_hexadecimal() {
        assert_eq!(render_bounded_bytes(b"north"), "north");
        assert_eq!(render_bounded_bytes(&[0xff, 0x00]), "ff00");
        let text = "界".repeat(MAX_STATISTIC_CHARACTERS + 10);
        let rendered_text = render_bounded_bytes(text.as_bytes());
        assert_eq!(rendered_text.chars().count(), MAX_STATISTIC_CHARACTERS + 1);
        assert!(rendered_text.ends_with('…'));
        let rendered_binary = render_bounded_bytes(&vec![0xff; 10_000]);
        assert_eq!(
            rendered_binary.chars().count(),
            MAX_STATISTIC_CHARACTERS + 1
        );
        assert!(rendered_binary.ends_with('…'));
    }

    #[test]
    fn marks_a_cut_statistics_value_with_an_ellipsis() {
        let long = "a".repeat(MAX_STATISTIC_CHARACTERS + 1);

        let cut = cut_statistic(&long);

        assert_eq!(cut.chars().count(), MAX_STATISTIC_CHARACTERS + 1);
        assert!(cut.ends_with('\u{2026}'));
        assert_eq!(
            cut_statistic("short"),
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
            Arc::new(metadata),
            MAX_SAFE_WIRE_INTEGER,
            8,
            MAX_SAFE_WIRE_INTEGER - 8,
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
                let name = format!("value_{index}");
                Arc::new(
                    Type::primitive_type_builder(&name, PhysicalType::INT64)
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
            .set_data_page_offset(4)
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

    fn test_row_group_with_column_sizes(
        schema: &Arc<SchemaDescriptor>,
        sizes: &[(i64, i64)],
    ) -> RowGroupMetaData {
        let chunks = sizes
            .iter()
            .enumerate()
            .map(|(column_index, (compressed, uncompressed))| {
                ColumnChunkMetaData::builder(schema.column(column_index))
                    .set_compression(Compression::SNAPPY)
                    .set_data_page_offset(4)
                    .set_total_compressed_size(*compressed)
                    .set_total_uncompressed_size(*uncompressed)
                    .build()
                    .expect("column chunk metadata is valid")
            })
            .collect();
        RowGroupMetaData::builder(Arc::clone(schema))
            .set_num_rows(1)
            .set_total_byte_size(sizes.iter().map(|(_, uncompressed)| uncompressed).sum())
            .set_column_metadata(chunks)
            .build()
            .expect("row group metadata is valid")
    }
}
