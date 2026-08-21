use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle as _;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
};

use parquet::{
    basic::{
        ConvertedType, EdgeInterpolationAlgorithm, LogicalType, TimeUnit,
        Type as ParquetPhysicalType,
    },
    errors::ParquetError,
    file::metadata::{FooterTail, ParquetMetaData, ParquetMetaDataReader},
    schema::types::Type,
};
use serde::Serialize;
use thiserror::Error;

const PARQUET_MAGIC: &[u8; 4] = b"PAR1";
/// Schema nodes handed to the UI when a source opens.
const MAX_SOURCE_SCHEMA_NODES: usize = 256;
/// UTF-8 bytes retained from one footer- or filesystem-controlled display string.
const MAX_SOURCE_FIELD_BYTES: usize = 128;
const MAX_FOOTER_BYTES: usize = 256 * 1024 * 1024;
const FOOTER_READ_CHUNK_BYTES: usize = 64 * 1024;

/// Truthful coarse phases of opening a local Parquet footer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceOpenPhase {
    /// The bounded footer bytes are being read from disk.
    ReadingFooter,
    /// One non-interruptible Thrift decode is running over the retained bytes.
    DecodingFooter,
    /// The bounded wire summary is being derived from decoded metadata.
    Summarizing,
}

/// A path-free description of an inspected local Parquet source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    /// File name suitable for display without its directory.
    pub display_name: String,
    /// File size reported by the local filesystem.
    pub size_bytes: u64,
    /// Total rows recorded in the Parquet footer.
    pub row_count: u64,
    /// Number of row groups recorded in the Parquet footer.
    pub row_group_count: usize,
    /// Leaf columns in the complete physical schema.
    pub column_count: usize,
    /// Physical Parquet schema, preserving nested fields.
    pub schema: Vec<SchemaField>,
    /// Nodes present in the complete physical schema.
    pub schema_node_count: usize,
    /// Whether `schema` is only a prefix of the physical schema.
    pub schema_is_truncated: bool,
    /// Whether any display string was shortened to keep the wire payload bounded.
    pub strings_truncated: bool,
}

/// One field in the physical Parquet schema tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    /// Field name from the Parquet schema.
    pub name: String,
    /// Stable physical type name, or `GROUP` for nested fields.
    pub physical_type: String,
    /// Optional Parquet logical type annotation.
    pub logical_type: Option<String>,
    /// Nested fields in declaration order.
    pub children: Vec<SchemaField>,
}

/// Stable errors that can cross the data-engine boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SourceError {
    /// The selected source no longer exists.
    #[error("The selected file no longer exists.")]
    NotFound,
    /// The operating system denied access to the selected source.
    #[error("Viewda does not have permission to read the selected file.")]
    PermissionDenied,
    /// The path no longer identifies the file that the caller opened.
    #[error("The selected file changed after it was opened.")]
    SourceChanged,
    /// The selected source does not have Parquet file markers.
    #[error("The selected file is not a Parquet file.")]
    NotParquet,
    /// Parquet markers exist, but the footer cannot be decoded.
    #[error("The Parquet footer is damaged or incomplete.")]
    CorruptFooter,
    /// The source uses a shape that this bootstrap does not support.
    #[error("This source is not supported yet.")]
    Unsupported,
}

/// One verified local file and its decoded Parquet footer.
///
/// Footer decoding is a single non-interruptible Thrift call. Desktop callers
/// keep this snapshot after the blocking open finishes so Structure can add
/// cancellable per-chunk analysis without decoding the footer a second time.
pub struct SourceSnapshot {
    file: File,
    metadata: Arc<ParquetMetaData>,
    file_bytes: u64,
    footer_bytes: u64,
    data_end: u64,
    identity: SourceIdentity,
}

/// Narrow filesystem identity captured when a source is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIdentity {
    len: u64,
    modified_nanos: Option<u128>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    change_seconds: i64,
    #[cfg(unix)]
    change_nanos: i64,
    #[cfg(windows)]
    volume_serial_number: Option<u32>,
    #[cfg(windows)]
    file_index: Option<u64>,
}

impl SourceIdentity {
    fn from_file(file: &File) -> Result<Self, SourceError> {
        let metadata = file.metadata().map_err(map_io_error)?;
        let modified_nanos = metadata.modified().ok().and_then(|modified| {
            modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_nanos())
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                len: metadata.len(),
                modified_nanos,
                device: metadata.dev(),
                inode: metadata.ino(),
                change_seconds: metadata.ctime(),
                change_nanos: metadata.ctime_nsec(),
            })
        }
        #[cfg(windows)]
        {
            let (volume_serial_number, file_index) = windows_file_identity(file)
                .map(|(volume, file_index)| (Some(volume), Some(file_index)))
                .map_err(map_io_error)?;
            Ok(Self {
                len: metadata.len(),
                modified_nanos,
                volume_serial_number,
                file_index,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self {
                len: metadata.len(),
                modified_nanos,
            })
        }
    }

    /// Rejects a path that no longer identifies the opened file.
    pub fn validate_path(&self, path: &Path) -> Result<(), SourceError> {
        let file = File::open(path).map_err(map_io_error)?;
        if Self::from_file(&file)? == *self {
            Ok(())
        } else {
            Err(SourceError::SourceChanged)
        }
    }

    pub(crate) fn validate_file(&self, file: &File) -> Result<(), SourceError> {
        if self.matches_retained_file(&Self::from_file(file)?) {
            Ok(())
        } else {
            Err(SourceError::SourceChanged)
        }
    }

    #[cfg(unix)]
    fn matches_retained_file(&self, current: &Self) -> bool {
        // Renaming or unlinking a Unix directory entry may change inode ctime even
        // though the retained descriptor still exposes unchanged bytes.
        // Path validation keeps the strict ctime check. A retained descriptor
        // cannot distinguish a ctime-only content change from a directory-entry
        // rename, so it uses identity, size, and modification time.
        self.len == current.len
            && self.modified_nanos == current.modified_nanos
            && self.device == current.device
            && self.inode == current.inode
    }

    #[cfg(not(unix))]
    fn matches_retained_file(&self, current: &Self) -> bool {
        self == current
    }
}

#[cfg(windows)]
pub(crate) fn windows_file_identity(file: &File) -> io::Result<(u32, u64)> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` keeps the handle valid and `information` is writable for the call.
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        information.dwVolumeSerialNumber,
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    ))
}

impl SourceSnapshot {
    /// Opens and decodes one local Parquet source without reading data pages.
    pub fn open(path: &Path) -> Result<Self, SourceError> {
        Self::open_cancellable(path, |_| true)?.ok_or(SourceError::Unsupported)
    }

    /// Opens one snapshot while allowing cancellation between bounded reads.
    ///
    /// Footer Thrift decoding remains one library atom. The callback runs before
    /// and after that atom so callers can serialize it and discard stale work.
    pub fn open_cancellable(
        path: &Path,
        mut keep_going: impl FnMut(SourceOpenPhase) -> bool,
    ) -> Result<Option<Self>, SourceError> {
        let (file, file_bytes) = open_local_source(path)?;
        let identity = SourceIdentity::from_file(&file)?;
        if !keep_going(SourceOpenPhase::ReadingFooter) {
            return Ok(None);
        }
        let mut footer_tail = [0_u8; 8];
        (&file)
            .seek(SeekFrom::End(-8))
            .and_then(|_| (&file).read_exact(&mut footer_tail))
            .map_err(map_io_error)?;
        let metadata_bytes = FooterTail::try_from(footer_tail)
            .map_err(map_parquet_error)?
            .metadata_length();
        let footer_bytes = metadata_bytes
            .checked_add(footer_tail.len())
            .ok_or(SourceError::CorruptFooter)?;
        if footer_bytes > MAX_FOOTER_BYTES
            || u64::try_from(footer_bytes).map_err(|_| SourceError::CorruptFooter)? > file_bytes
        {
            return Err(SourceError::CorruptFooter);
        }
        (&file)
            .seek(SeekFrom::End(
                -i64::try_from(footer_bytes).map_err(|_| SourceError::CorruptFooter)?,
            ))
            .map_err(map_io_error)?;
        let mut suffix = Vec::new();
        while suffix.len() < footer_bytes {
            if !keep_going(SourceOpenPhase::ReadingFooter) {
                return Ok(None);
            }
            let read_bytes = FOOTER_READ_CHUNK_BYTES.min(footer_bytes - suffix.len());
            suffix
                .try_reserve_exact(read_bytes)
                .map_err(|_| SourceError::Unsupported)?;
            let start = suffix.len();
            suffix.resize(start + read_bytes, 0);
            (&file)
                .read_exact(&mut suffix[start..])
                .map_err(map_io_error)?;
        }
        if !keep_going(SourceOpenPhase::DecodingFooter) {
            return Ok(None);
        }
        let mut metadata_reader = ParquetMetaDataReader::new();
        metadata_reader
            .try_parse_sized(&bytes::Bytes::from(suffix), file_bytes)
            .map_err(map_parquet_error)?;
        if !keep_going(SourceOpenPhase::Summarizing) {
            return Ok(None);
        }
        let decoded_footer_bytes = u64::try_from(
            metadata_reader
                .metadata_size()
                .ok_or(SourceError::CorruptFooter)?,
        )
        .map_err(|_| SourceError::CorruptFooter)?;
        let metadata = metadata_reader.finish().map_err(map_parquet_error)?;
        let data_end = file_bytes
            .checked_sub(decoded_footer_bytes)
            .ok_or(SourceError::CorruptFooter)?;
        Ok(Some(Self {
            file,
            metadata: Arc::new(metadata),
            file_bytes,
            footer_bytes: decoded_footer_bytes,
            data_end,
            identity,
        }))
    }

    pub(crate) fn cloned_file(&self) -> Result<File, SourceError> {
        self.file.try_clone().map_err(map_io_error)
    }

    pub(crate) fn metadata(&self) -> &ParquetMetaData {
        &self.metadata
    }

    pub(crate) fn metadata_snapshot(&self) -> Arc<ParquetMetaData> {
        Arc::clone(&self.metadata)
    }

    pub(crate) fn file_bytes(&self) -> u64 {
        self.file_bytes
    }

    pub(crate) fn footer_bytes(&self) -> u64 {
        self.footer_bytes
    }

    pub(crate) fn data_end(&self) -> u64 {
        self.data_end
    }

    /// Returns the filesystem identity paired with this footer snapshot.
    pub fn identity(&self) -> &SourceIdentity {
        &self.identity
    }

    /// Verifies that both the retained handle and canonical path still identify this snapshot.
    pub fn validate_for_install(&self, path: &Path) -> Result<(), SourceError> {
        self.identity.validate_file(&self.file)?;
        self.identity.validate_path(path)
    }

    /// Returns the complete logical schema for native query planning.
    ///
    /// This value stays native. UI callers use [`SourceSummary::schema`] and
    /// bounded schema pages instead of serializing this potentially wide tree.
    pub fn query_schema(&self) -> Vec<SchemaField> {
        let mut remaining = usize::MAX;
        let mut strings_truncated = false;
        self.metadata
            .file_metadata()
            .schema_descr()
            .root_schema()
            .get_fields()
            .iter()
            .filter_map(|field| {
                schema_field_bounded(field, &mut remaining, &mut strings_truncated, usize::MAX)
            })
            .collect()
    }
}

/// Reads local Parquet metadata without loading row values or exposing the path.
pub fn inspect_local_source(path: &Path) -> Result<SourceSummary, SourceError> {
    inspect_local_source_snapshot(path).map(|(summary, _)| summary)
}

/// Opens a source once and returns both its bounded summary and retained footer snapshot.
pub fn inspect_local_source_snapshot(
    path: &Path,
) -> Result<(SourceSummary, SourceSnapshot), SourceError> {
    let snapshot = SourceSnapshot::open(path)?;
    let summary = source_summary(
        path,
        &snapshot,
        MAX_SOURCE_SCHEMA_NODES,
        MAX_SOURCE_FIELD_BYTES,
    )?;
    Ok((summary, snapshot))
}

/// Opens one snapshot and derives its summary under the caller's cancellation policy.
pub fn inspect_local_source_snapshot_cancellable(
    path: &Path,
    mut keep_going: impl FnMut(SourceOpenPhase) -> bool,
) -> Result<Option<(SourceSummary, SourceSnapshot)>, SourceError> {
    let Some(snapshot) = SourceSnapshot::open_cancellable(path, &mut keep_going)? else {
        return Ok(None);
    };
    if !keep_going(SourceOpenPhase::Summarizing) {
        return Ok(None);
    }
    let summary = source_summary(
        path,
        &snapshot,
        MAX_SOURCE_SCHEMA_NODES,
        MAX_SOURCE_FIELD_BYTES,
    )?;
    Ok(Some((summary, snapshot)))
}

#[cfg(feature = "query-engine")]
pub(crate) fn inspect_local_source_for_query(path: &Path) -> Result<SourceSummary, SourceError> {
    let snapshot = SourceSnapshot::open(path)?;
    source_summary(path, &snapshot, usize::MAX, usize::MAX)
}

fn source_summary(
    path: &Path,
    snapshot: &SourceSnapshot,
    schema_node_limit: usize,
    field_byte_limit: usize,
) -> Result<SourceSummary, SourceError> {
    let parquet_metadata = snapshot.metadata();
    let file_metadata = parquet_metadata.file_metadata();
    let row_count =
        u64::try_from(file_metadata.num_rows()).map_err(|_| SourceError::CorruptFooter)?;
    let schema_node_count = file_metadata
        .schema_descr()
        .root_schema()
        .get_fields()
        .iter()
        .fold(0_usize, |count, field| {
            count.saturating_add(schema_node_count(field))
        });
    let mut remaining_schema_nodes = schema_node_limit;
    let mut strings_truncated = false;
    let schema = file_metadata
        .schema_descr()
        .root_schema()
        .get_fields()
        .iter()
        .filter_map(|field| {
            schema_field_bounded(
                field,
                &mut remaining_schema_nodes,
                &mut strings_truncated,
                field_byte_limit,
            )
        })
        .collect();
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or(SourceError::Unsupported)?;
    let (display_name, display_name_truncated) =
        truncate_utf8(&display_name, MAX_SOURCE_FIELD_BYTES);
    strings_truncated |= display_name_truncated;

    let summary = SourceSummary {
        display_name,
        size_bytes: snapshot.file_bytes,
        row_count,
        row_group_count: parquet_metadata.num_row_groups(),
        column_count: file_metadata.schema_descr().num_columns(),
        schema,
        schema_node_count,
        schema_is_truncated: schema_node_count > schema_node_limit,
        strings_truncated,
    };
    Ok(summary)
}

pub(crate) fn open_local_source(path: &Path) -> Result<(File, u64), SourceError> {
    let mut file = File::open(path).map_err(map_io_error)?;
    let metadata = file.metadata().map_err(map_io_error)?;

    if !metadata.is_file() {
        return Err(SourceError::Unsupported);
    }

    verify_magic(&mut file, metadata.len())?;
    Ok((file, metadata.len()))
}

fn verify_magic(file: &mut File, size: u64) -> Result<(), SourceError> {
    if size < 8 {
        return Err(SourceError::NotParquet);
    }

    let mut leading = [0; 4];
    let mut trailing = [0; 4];
    file.read_exact(&mut leading).map_err(map_io_error)?;
    file.seek(SeekFrom::End(-4)).map_err(map_io_error)?;
    file.read_exact(&mut trailing).map_err(map_io_error)?;

    if &leading != PARQUET_MAGIC || &trailing != PARQUET_MAGIC {
        return Err(SourceError::NotParquet);
    }

    Ok(())
}

fn map_io_error(error: io::Error) -> SourceError {
    match error.kind() {
        io::ErrorKind::NotFound => SourceError::NotFound,
        io::ErrorKind::PermissionDenied => SourceError::PermissionDenied,
        _ => SourceError::Unsupported,
    }
}

pub(crate) fn map_parquet_error(error: ParquetError) -> SourceError {
    match error {
        ParquetError::NYI(_) => SourceError::Unsupported,
        ParquetError::External(external) => external
            .downcast_ref::<io::Error>()
            .map(|error| map_io_error(io::Error::from(error.kind())))
            .unwrap_or(SourceError::CorruptFooter),
        _ => SourceError::CorruptFooter,
    }
}

fn schema_field_bounded(
    field: &Type,
    remaining: &mut usize,
    strings_truncated: &mut bool,
    field_byte_limit: usize,
) -> Option<SchemaField> {
    *remaining = remaining.checked_sub(1)?;
    let basic = field.get_basic_info();
    let logical_type = basic
        .logical_type_ref()
        .map(logical_type_name)
        .or_else(|| converted_type_name(field, basic.converted_type()));

    let (name, name_truncated) = truncate_utf8(field.name(), field_byte_limit);
    *strings_truncated |= name_truncated;
    match field {
        Type::PrimitiveType { physical_type, .. } => Some(SchemaField {
            name,
            physical_type: physical_type_name(physical_type).to_owned(),
            logical_type,
            children: Vec::new(),
        }),
        Type::GroupType { fields, .. } => Some(SchemaField {
            name,
            physical_type: "GROUP".to_owned(),
            logical_type,
            children: fields
                .iter()
                .filter_map(|child| {
                    schema_field_bounded(child, remaining, strings_truncated, field_byte_limit)
                })
                .collect::<Vec<_>>(),
        }),
    }
}

fn schema_node_count(field: &Type) -> usize {
    match field {
        Type::PrimitiveType { .. } => 1,
        Type::GroupType { fields, .. } => fields.iter().fold(1, |count, child| {
            count.saturating_add(schema_node_count(child))
        }),
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut end = max_bytes.saturating_sub('…'.len_utf8());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &value[..end]), true)
}

pub(crate) fn physical_type_name(physical_type: &ParquetPhysicalType) -> &'static str {
    match physical_type {
        ParquetPhysicalType::BOOLEAN => "BOOLEAN",
        ParquetPhysicalType::INT32 => "INT32",
        ParquetPhysicalType::INT64 => "INT64",
        ParquetPhysicalType::INT96 => "INT96",
        ParquetPhysicalType::FLOAT => "FLOAT",
        ParquetPhysicalType::DOUBLE => "DOUBLE",
        ParquetPhysicalType::BYTE_ARRAY => "BYTE_ARRAY",
        ParquetPhysicalType::FIXED_LEN_BYTE_ARRAY => "FIXED_LEN_BYTE_ARRAY",
    }
}

pub(crate) fn logical_type_name(logical_type: &LogicalType) -> String {
    match logical_type {
        LogicalType::String => "String".to_owned(),
        LogicalType::Map => "Map".to_owned(),
        LogicalType::List => "List".to_owned(),
        LogicalType::Enum => "Enum".to_owned(),
        LogicalType::Decimal { scale, precision } => {
            format!("Decimal (precision {precision}, scale {scale})")
        }
        LogicalType::Date => "Date".to_owned(),
        LogicalType::Time {
            is_adjusted_to_u_t_c,
            unit,
        } => format!(
            "Time ({}, {})",
            time_unit_name(unit),
            timezone_name(*is_adjusted_to_u_t_c)
        ),
        LogicalType::Timestamp {
            is_adjusted_to_u_t_c,
            unit,
        } => format!(
            "Timestamp ({}, {})",
            time_unit_name(unit),
            timezone_name(*is_adjusted_to_u_t_c)
        ),
        LogicalType::Integer {
            bit_width,
            is_signed,
        } => format!("{}Int{bit_width}", if *is_signed { "" } else { "U" }),
        LogicalType::Unknown => "Unknown".to_owned(),
        LogicalType::Json => "JSON".to_owned(),
        LogicalType::Bson => "BSON".to_owned(),
        LogicalType::Uuid => "UUID".to_owned(),
        LogicalType::Float16 => "Float16".to_owned(),
        LogicalType::Variant {
            specification_version,
        } => specification_version.map_or_else(
            || "Variant".to_owned(),
            |version| format!("Variant (version {version})"),
        ),
        LogicalType::Geometry { crs } => crs.as_ref().map_or_else(
            || "Geometry".to_owned(),
            |crs| format!("Geometry (CRS {crs})"),
        ),
        LogicalType::Geography { crs, algorithm } => {
            let algorithm =
                edge_interpolation_name(algorithm.unwrap_or(EdgeInterpolationAlgorithm::SPHERICAL));
            match crs {
                Some(crs) => format!("Geography (CRS {crs}, {algorithm})"),
                None => format!("Geography ({algorithm})"),
            }
        }
        LogicalType::_Unknown { field_id } => format!("Unknown (field ID {field_id})"),
    }
}

pub(crate) fn converted_type_name(field: &Type, converted_type: ConvertedType) -> Option<String> {
    let name = match converted_type {
        ConvertedType::NONE => return None,
        ConvertedType::UTF8 => "String".to_owned(),
        ConvertedType::MAP => "Map".to_owned(),
        ConvertedType::MAP_KEY_VALUE => "Map key-value".to_owned(),
        ConvertedType::LIST => "List".to_owned(),
        ConvertedType::ENUM => "Enum".to_owned(),
        ConvertedType::DECIMAL => match field {
            Type::PrimitiveType {
                scale, precision, ..
            } => format!("Decimal (precision {precision}, scale {scale})"),
            Type::GroupType { .. } => "Decimal".to_owned(),
        },
        ConvertedType::DATE => "Date".to_owned(),
        // Deprecated time annotations have the Parquet meaning of UTC adjustment.
        ConvertedType::TIME_MILLIS => "Time (milliseconds, UTC)".to_owned(),
        ConvertedType::TIME_MICROS => "Time (microseconds, UTC)".to_owned(),
        ConvertedType::TIMESTAMP_MILLIS => "Timestamp (milliseconds, UTC)".to_owned(),
        ConvertedType::TIMESTAMP_MICROS => "Timestamp (microseconds, UTC)".to_owned(),
        ConvertedType::UINT_8 => "UInt8".to_owned(),
        ConvertedType::UINT_16 => "UInt16".to_owned(),
        ConvertedType::UINT_32 => "UInt32".to_owned(),
        ConvertedType::UINT_64 => "UInt64".to_owned(),
        ConvertedType::INT_8 => "Int8".to_owned(),
        ConvertedType::INT_16 => "Int16".to_owned(),
        ConvertedType::INT_32 => "Int32".to_owned(),
        ConvertedType::INT_64 => "Int64".to_owned(),
        ConvertedType::JSON => "JSON".to_owned(),
        ConvertedType::BSON => "BSON".to_owned(),
        ConvertedType::INTERVAL => "Interval".to_owned(),
    };
    Some(name)
}

fn time_unit_name(unit: &TimeUnit) -> &'static str {
    match unit {
        TimeUnit::MILLIS => "milliseconds",
        TimeUnit::MICROS => "microseconds",
        TimeUnit::NANOS => "nanoseconds",
    }
}

fn timezone_name(is_adjusted_to_utc: bool) -> &'static str {
    if is_adjusted_to_utc { "UTC" } else { "local" }
}

fn edge_interpolation_name(algorithm: EdgeInterpolationAlgorithm) -> String {
    match algorithm {
        EdgeInterpolationAlgorithm::SPHERICAL => "spherical".to_owned(),
        EdgeInterpolationAlgorithm::VINCENTY => "Vincenty".to_owned(),
        EdgeInterpolationAlgorithm::THOMAS => "Thomas".to_owned(),
        EdgeInterpolationAlgorithm::ANDOYER => "Andoyer".to_owned(),
        EdgeInterpolationAlgorithm::KARNEY => "Karney".to_owned(),
        EdgeInterpolationAlgorithm::_Unknown(id) => format!("algorithm {id}"),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use arrow_array::{ArrayRef, Int32Array, Int64Array, RecordBatch, StringArray, StructArray};
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::{
        arrow::ArrowWriter,
        basic::{Repetition, Type as PhysicalType},
        file::writer::SerializedFileWriter,
        schema::types::TypePtr,
    };
    use tempfile::NamedTempFile;

    use super::*;

    #[test]
    fn bounds_schema_nodes_before_the_summary_crosses_the_ui_boundary() {
        let children = (0..4)
            .map(|index| {
                Arc::new(
                    Type::primitive_type_builder(
                        match index {
                            0 => "column_0",
                            1 => "column_1",
                            2 => "column_2",
                            _ => "column_3",
                        },
                        ParquetPhysicalType::INT64,
                    )
                    .with_repetition(parquet::basic::Repetition::OPTIONAL)
                    .build()
                    .expect("field"),
                )
            })
            .collect();
        let group = Type::group_type_builder("record")
            .with_fields(children)
            .build()
            .expect("group");
        let mut remaining = 3;
        let mut strings_truncated = false;

        let bounded = schema_field_bounded(
            &group,
            &mut remaining,
            &mut strings_truncated,
            MAX_SOURCE_FIELD_BYTES,
        )
        .expect("root fits");

        assert_eq!(bounded.children.len(), 2);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn bounds_the_serialized_open_summary_for_a_wide_long_named_schema() {
        let fields = (0..10_000)
            .map(|index| {
                Arc::new(
                    Type::primitive_type_builder(
                        &format!("column_{index}_{}", "界|\\".repeat(100)),
                        ParquetPhysicalType::INT64,
                    )
                    .with_repetition(parquet::basic::Repetition::OPTIONAL)
                    .build()
                    .expect("field"),
                )
            })
            .collect::<Vec<_>>();
        let mut remaining = MAX_SOURCE_SCHEMA_NODES;
        let mut strings_truncated = false;
        let schema = fields
            .iter()
            .filter_map(|field| {
                schema_field_bounded(
                    field,
                    &mut remaining,
                    &mut strings_truncated,
                    MAX_SOURCE_FIELD_BYTES,
                )
            })
            .collect::<Vec<_>>();
        let summary = SourceSummary {
            display_name: "wide.parquet".to_owned(),
            size_bytes: 8,
            row_count: 0,
            row_group_count: 0,
            column_count: fields.len(),
            schema,
            schema_node_count: fields.len(),
            schema_is_truncated: fields.len() > MAX_SOURCE_SCHEMA_NODES,
            strings_truncated,
        };

        let wire = serde_json::to_vec(&summary).expect("summary serializes");

        assert_eq!(summary.schema.len(), MAX_SOURCE_SCHEMA_NODES);
        assert!(summary.schema_is_truncated);
        assert!(summary.strings_truncated);
        assert!(
            wire.len() < 80 * 1024,
            "bounded JSON was {} bytes",
            wire.len()
        );
        assert!(
            summary
                .schema
                .iter()
                .all(|field| field.name.len() <= MAX_SOURCE_FIELD_BYTES)
        );
    }

    #[test]
    fn snapshot_keeps_complete_wide_and_nested_query_schemas_native() {
        let wide = write_empty_parquet(
            (0..300)
                .map(|index| {
                    primitive_field(
                        format!("column_{index}"),
                        PhysicalType::INT64,
                        None,
                        ConvertedType::NONE,
                        None,
                        None,
                    )
                })
                .collect(),
        );
        let nested = write_empty_parquet(vec![Arc::new(
            Type::group_type_builder("wrapper")
                .with_repetition(Repetition::OPTIONAL)
                .with_fields(
                    (0..300)
                        .map(|index| {
                            primitive_field(
                                format!("nested_{index}"),
                                PhysicalType::INT64,
                                None,
                                ConvertedType::NONE,
                                None,
                                None,
                            )
                        })
                        .collect(),
                )
                .build()
                .expect("nested wrapper"),
        )]);

        for source in [wide, nested] {
            let (summary, snapshot) =
                inspect_local_source_snapshot(source.path()).expect("wide source snapshot");
            let query_schema = snapshot.query_schema();

            assert!(summary.schema_is_truncated);
            assert!(summary.schema_node_count > summary.schema.len());
            assert_eq!(
                query_schema.len(),
                snapshot
                    .metadata()
                    .file_metadata()
                    .schema_descr()
                    .root_schema()
                    .get_fields()
                    .len(),
            );
            assert_eq!(
                query_schema
                    .iter()
                    .map(schema_node_count_from_summary)
                    .sum::<usize>(),
                summary.schema_node_count,
            );
        }
    }

    fn schema_node_count_from_summary(field: &SchemaField) -> usize {
        field.children.iter().fold(1, |count, child| {
            count.saturating_add(schema_node_count_from_summary(child))
        })
    }

    #[test]
    fn inspects_basic_parquet_metadata_without_returning_a_path() {
        let source = write_basic_parquet();

        let summary = inspect_local_source(source.path()).expect("basic Parquet should open");

        assert_eq!(
            summary,
            SourceSummary {
                display_name: source
                    .path()
                    .file_name()
                    .expect("temporary file has a name")
                    .to_string_lossy()
                    .into_owned(),
                size_bytes: fs::metadata(source.path())
                    .expect("temporary file metadata is readable")
                    .len(),
                row_count: 3,
                row_group_count: 1,
                column_count: 2,
                schema: vec![
                    SchemaField {
                        name: "id".to_owned(),
                        physical_type: "INT64".to_owned(),
                        logical_type: None,
                        children: vec![],
                    },
                    SchemaField {
                        name: "name".to_owned(),
                        physical_type: "BYTE_ARRAY".to_owned(),
                        logical_type: Some("String".to_owned()),
                        children: vec![],
                    },
                ],
                schema_node_count: 2,
                schema_is_truncated: false,
                strings_truncated: false,
            }
        );
    }

    #[test]
    fn source_identity_rejects_path_replacement_and_in_place_mutation() {
        let source = write_basic_parquet();
        let replacement = write_basic_parquet();
        let snapshot = SourceSnapshot::open(source.path()).expect("source snapshot");

        snapshot
            .identity()
            .validate_path(source.path())
            .expect("unchanged source");
        std::fs::rename(replacement.path(), source.path()).expect("replace source path");
        assert_eq!(
            snapshot.validate_for_install(source.path()),
            Err(SourceError::SourceChanged)
        );

        let mutated = write_basic_parquet();
        let mutated_snapshot = SourceSnapshot::open(mutated.path()).expect("mutable snapshot");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(mutated.path())
            .expect("mutable source");
        std::io::Write::write_all(&mut file, b"changed").expect("mutate in place");
        assert_eq!(
            mutated_snapshot.validate_for_install(mutated.path()),
            Err(SourceError::SourceChanged)
        );
    }

    #[cfg(unix)]
    #[test]
    fn retained_file_ignores_entry_ctime_without_weakening_path_identity() {
        let source = write_basic_parquet();
        let identity = SourceIdentity::from_file(source.as_file()).expect("identity");
        let mut changed_ctime = identity.clone();
        changed_ctime.change_nanos = changed_ctime.change_nanos.wrapping_add(1);

        assert_ne!(identity, changed_ctime);
        assert!(identity.matches_retained_file(&changed_ctime));
    }

    #[test]
    fn cancellable_snapshot_reports_real_phases_before_summary() {
        let source = write_basic_parquet();
        let mut reading_calls = 0;
        let cancelled_read = SourceSnapshot::open_cancellable(source.path(), |phase| {
            if phase == SourceOpenPhase::ReadingFooter {
                reading_calls += 1;
            }
            reading_calls < 2
        })
        .expect("cancelled footer read");
        assert!(cancelled_read.is_none());

        let mut phases = Vec::new();

        let snapshot = SourceSnapshot::open_cancellable(source.path(), |phase| {
            phases.push(phase);
            phase != SourceOpenPhase::Summarizing
        })
        .expect("cancellable source open");

        assert!(snapshot.is_none());
        assert!(phases.starts_with(&[
            SourceOpenPhase::ReadingFooter,
            SourceOpenPhase::ReadingFooter,
        ]));
        assert!(phases.contains(&SourceOpenPhase::DecodingFooter));
        assert_eq!(phases.last(), Some(&SourceOpenPhase::Summarizing));
    }

    #[test]
    fn preserves_nested_schema_fields() {
        let source = write_nested_parquet();

        let summary = inspect_local_source(source.path()).expect("nested Parquet should open");

        assert_eq!(summary.row_count, 2);
        assert_eq!(
            summary.schema,
            vec![SchemaField {
                name: "profile".to_owned(),
                physical_type: "GROUP".to_owned(),
                logical_type: None,
                children: vec![
                    SchemaField {
                        name: "city".to_owned(),
                        physical_type: "BYTE_ARRAY".to_owned(),
                        logical_type: Some("String".to_owned()),
                        children: vec![],
                    },
                    SchemaField {
                        name: "postal_code".to_owned(),
                        physical_type: "INT32".to_owned(),
                        logical_type: None,
                        children: vec![],
                    },
                ],
            }]
        );
    }

    #[test]
    fn renders_every_parquet_physical_type_with_stable_names() {
        let cases = physical_type_cases();
        let source = write_empty_parquet(
            cases
                .iter()
                .enumerate()
                .map(|(index, (physical_type, _))| {
                    primitive_field(
                        format!("physical_{index}"),
                        *physical_type,
                        None,
                        ConvertedType::NONE,
                        (*physical_type == PhysicalType::FIXED_LEN_BYTE_ARRAY).then_some(4),
                        None,
                    )
                })
                .collect(),
        );

        let summary =
            inspect_local_source(source.path()).expect("physical types Parquet should open");
        let names = summary
            .schema
            .iter()
            .map(|field| field.physical_type.as_str())
            .collect::<Vec<_>>();

        let expected = cases
            .iter()
            .map(|(_, expected)| *expected)
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
    }

    #[test]
    fn renders_every_parquet_logical_type_with_stable_names() {
        let cases = logical_type_cases();
        let source = write_empty_parquet(
            cases
                .iter()
                .enumerate()
                .map(|(index, (logical_type, _))| {
                    logical_field(format!("logical_{index}"), logical_type.clone())
                })
                .collect(),
        );

        let summary =
            inspect_local_source(source.path()).expect("logical types Parquet should open");
        let names = summary
            .schema
            .iter()
            .map(|field| field.logical_type.as_deref())
            .collect::<Vec<_>>();

        let expected = cases
            .iter()
            .map(|(_, expected)| Some(*expected))
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
    }

    #[test]
    fn renders_legacy_converted_types_with_the_same_vocabulary() {
        let cases = converted_type_cases();
        let source = write_empty_parquet(
            cases
                .iter()
                .enumerate()
                .map(|(index, (converted_type, _))| {
                    converted_field(format!("converted_{index}"), *converted_type)
                })
                .collect(),
        );

        let summary = inspect_local_source(source.path()).expect("legacy Parquet should open");
        let names = summary
            .schema
            .iter()
            .map(|field| field.logical_type.as_deref())
            .collect::<Vec<_>>();

        let expected = cases
            .iter()
            .map(|(_, expected)| *expected)
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
    }

    #[test]
    fn rejects_non_parquet_input_before_parsing_a_footer() {
        let source = NamedTempFile::new().expect("temporary file can be created");
        fs::write(source.path(), b"ordinary text").expect("temporary file can be written");

        assert_eq!(
            inspect_local_source(source.path()),
            Err(SourceError::NotParquet)
        );
    }

    #[test]
    fn maps_a_damaged_parquet_footer_to_our_error_taxonomy() {
        let source = write_basic_parquet();
        fs::write(
            source.path(),
            [
                PARQUET_MAGIC.as_slice(),
                &[0xff; 4],
                PARQUET_MAGIC.as_slice(),
            ]
            .concat(),
        )
        .expect("corrupt fixture can be written");

        assert_eq!(
            inspect_local_source(source.path()),
            Err(SourceError::CorruptFooter)
        );
    }

    #[test]
    fn maps_io_errors_without_exposing_platform_messages() {
        assert_eq!(
            map_io_error(io::Error::from(io::ErrorKind::NotFound)),
            SourceError::NotFound
        );
        assert_eq!(
            map_io_error(io::Error::from(io::ErrorKind::PermissionDenied)),
            SourceError::PermissionDenied
        );
        assert_eq!(
            map_io_error(io::Error::from(io::ErrorKind::Other)),
            SourceError::Unsupported
        );
    }

    fn write_basic_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file can be created");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3])) as ArrayRef,
                Arc::new(StringArray::from(vec![Some("Ada"), None, Some("Lin")])) as ArrayRef,
            ],
        )
        .expect("basic record batch is valid");

        write_batch(&source, schema, &batch);
        source
    }

    fn write_nested_parquet() -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file can be created");
        let nested_fields = Fields::from(vec![
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
        let schema = Arc::new(Schema::new(vec![Field::new(
            "profile",
            DataType::Struct(nested_fields),
            false,
        )]));
        let batch = RecordBatch::try_new(Arc::clone(&schema), vec![Arc::new(profile) as ArrayRef])
            .expect("nested record batch is valid");

        write_batch(&source, schema, &batch);
        source
    }

    fn logical_type_cases() -> Vec<(LogicalType, &'static str)> {
        vec![
            (LogicalType::String, "String"),
            (LogicalType::Map, "Map"),
            (LogicalType::List, "List"),
            (LogicalType::Enum, "Enum"),
            (
                LogicalType::Decimal {
                    precision: 38,
                    scale: 4,
                },
                "Decimal (precision 38, scale 4)",
            ),
            (LogicalType::Date, "Date"),
            (
                logical_time(TimeUnit::MILLIS, false),
                "Time (milliseconds, local)",
            ),
            (
                logical_time(TimeUnit::MICROS, true),
                "Time (microseconds, UTC)",
            ),
            (
                logical_time(TimeUnit::NANOS, false),
                "Time (nanoseconds, local)",
            ),
            (
                logical_timestamp(TimeUnit::MILLIS, true),
                "Timestamp (milliseconds, UTC)",
            ),
            (
                logical_timestamp(TimeUnit::MICROS, false),
                "Timestamp (microseconds, local)",
            ),
            (
                logical_timestamp(TimeUnit::NANOS, true),
                "Timestamp (nanoseconds, UTC)",
            ),
            (logical_integer(8, true), "Int8"),
            (logical_integer(16, true), "Int16"),
            (logical_integer(32, true), "Int32"),
            (logical_integer(64, true), "Int64"),
            (logical_integer(8, false), "UInt8"),
            (logical_integer(16, false), "UInt16"),
            (logical_integer(32, false), "UInt32"),
            (logical_integer(64, false), "UInt64"),
            (LogicalType::Unknown, "Unknown"),
            (LogicalType::Json, "JSON"),
            (LogicalType::Bson, "BSON"),
            (LogicalType::Uuid, "UUID"),
            (LogicalType::Float16, "Float16"),
            (logical_variant(None), "Variant"),
            (logical_variant(Some(1)), "Variant (version 1)"),
            (logical_geometry(None), "Geometry"),
            (
                logical_geometry(Some("OGC:CRS84")),
                "Geometry (CRS OGC:CRS84)",
            ),
            (logical_geography(None, None), "Geography (spherical)"),
            (
                logical_geography(None, Some(EdgeInterpolationAlgorithm::VINCENTY)),
                "Geography (Vincenty)",
            ),
            (
                logical_geography(None, Some(EdgeInterpolationAlgorithm::THOMAS)),
                "Geography (Thomas)",
            ),
            (
                logical_geography(None, Some(EdgeInterpolationAlgorithm::ANDOYER)),
                "Geography (Andoyer)",
            ),
            (
                logical_geography(Some("EPSG:4326"), Some(EdgeInterpolationAlgorithm::KARNEY)),
                "Geography (CRS EPSG:4326, Karney)",
            ),
            (
                logical_geography(None, Some(EdgeInterpolationAlgorithm::_Unknown(17))),
                "Geography (algorithm 17)",
            ),
        ]
    }

    fn physical_type_cases() -> [(PhysicalType, &'static str); 8] {
        [
            (PhysicalType::BOOLEAN, "BOOLEAN"),
            (PhysicalType::INT32, "INT32"),
            (PhysicalType::INT64, "INT64"),
            (PhysicalType::INT96, "INT96"),
            (PhysicalType::FLOAT, "FLOAT"),
            (PhysicalType::DOUBLE, "DOUBLE"),
            (PhysicalType::BYTE_ARRAY, "BYTE_ARRAY"),
            (PhysicalType::FIXED_LEN_BYTE_ARRAY, "FIXED_LEN_BYTE_ARRAY"),
        ]
    }

    fn logical_time(unit: TimeUnit, is_adjusted_to_u_t_c: bool) -> LogicalType {
        LogicalType::Time {
            unit,
            is_adjusted_to_u_t_c,
        }
    }

    fn logical_timestamp(unit: TimeUnit, is_adjusted_to_u_t_c: bool) -> LogicalType {
        LogicalType::Timestamp {
            unit,
            is_adjusted_to_u_t_c,
        }
    }

    fn logical_integer(bit_width: i8, is_signed: bool) -> LogicalType {
        LogicalType::Integer {
            bit_width,
            is_signed,
        }
    }

    fn logical_variant(specification_version: Option<i8>) -> LogicalType {
        LogicalType::Variant {
            specification_version,
        }
    }

    fn logical_geometry(crs: Option<&str>) -> LogicalType {
        LogicalType::Geometry {
            crs: crs.map(str::to_owned),
        }
    }

    fn logical_geography(
        crs: Option<&str>,
        algorithm: Option<EdgeInterpolationAlgorithm>,
    ) -> LogicalType {
        LogicalType::Geography {
            crs: crs.map(str::to_owned),
            algorithm,
        }
    }

    fn converted_type_cases() -> Vec<(ConvertedType, Option<&'static str>)> {
        vec![
            (ConvertedType::NONE, None),
            (ConvertedType::UTF8, Some("String")),
            (ConvertedType::MAP, Some("Map")),
            (ConvertedType::MAP_KEY_VALUE, Some("Map key-value")),
            (ConvertedType::LIST, Some("List")),
            (ConvertedType::ENUM, Some("Enum")),
            (
                ConvertedType::DECIMAL,
                Some("Decimal (precision 38, scale 4)"),
            ),
            (ConvertedType::DATE, Some("Date")),
            (ConvertedType::TIME_MILLIS, Some("Time (milliseconds, UTC)")),
            (ConvertedType::TIME_MICROS, Some("Time (microseconds, UTC)")),
            (
                ConvertedType::TIMESTAMP_MILLIS,
                Some("Timestamp (milliseconds, UTC)"),
            ),
            (
                ConvertedType::TIMESTAMP_MICROS,
                Some("Timestamp (microseconds, UTC)"),
            ),
            (ConvertedType::UINT_8, Some("UInt8")),
            (ConvertedType::UINT_16, Some("UInt16")),
            (ConvertedType::UINT_32, Some("UInt32")),
            (ConvertedType::UINT_64, Some("UInt64")),
            (ConvertedType::INT_8, Some("Int8")),
            (ConvertedType::INT_16, Some("Int16")),
            (ConvertedType::INT_32, Some("Int32")),
            (ConvertedType::INT_64, Some("Int64")),
            (ConvertedType::JSON, Some("JSON")),
            (ConvertedType::BSON, Some("BSON")),
            (ConvertedType::INTERVAL, Some("Interval")),
        ]
    }

    fn logical_field(name: String, logical_type: LogicalType) -> TypePtr {
        if matches!(
            logical_type,
            LogicalType::Map | LogicalType::List | LogicalType::Variant { .. }
        ) {
            return group_field(name, Some(logical_type), ConvertedType::NONE);
        }

        let (physical_type, length, decimal) = match &logical_type {
            LogicalType::String
            | LogicalType::Enum
            | LogicalType::Json
            | LogicalType::Bson
            | LogicalType::Geometry { .. }
            | LogicalType::Geography { .. }
            | LogicalType::_Unknown { .. } => (PhysicalType::BYTE_ARRAY, None, None),
            LogicalType::Decimal { precision, scale } => (
                PhysicalType::FIXED_LEN_BYTE_ARRAY,
                Some(16),
                Some((*precision, *scale)),
            ),
            LogicalType::Date | LogicalType::Unknown => (PhysicalType::INT32, None, None),
            LogicalType::Time { unit, .. } => (
                if *unit == TimeUnit::MILLIS {
                    PhysicalType::INT32
                } else {
                    PhysicalType::INT64
                },
                None,
                None,
            ),
            LogicalType::Timestamp { .. } => (PhysicalType::INT64, None, None),
            LogicalType::Integer { bit_width, .. } => (
                if *bit_width <= 32 {
                    PhysicalType::INT32
                } else {
                    PhysicalType::INT64
                },
                None,
                None,
            ),
            LogicalType::Uuid => (PhysicalType::FIXED_LEN_BYTE_ARRAY, Some(16), None),
            LogicalType::Float16 => (PhysicalType::FIXED_LEN_BYTE_ARRAY, Some(2), None),
            LogicalType::Map | LogicalType::List | LogicalType::Variant { .. } => unreachable!(),
        };
        primitive_field(
            name,
            physical_type,
            Some(logical_type),
            ConvertedType::NONE,
            length,
            decimal,
        )
    }

    fn converted_field(name: String, converted_type: ConvertedType) -> TypePtr {
        if matches!(
            converted_type,
            ConvertedType::MAP | ConvertedType::MAP_KEY_VALUE | ConvertedType::LIST
        ) {
            return group_field(name, None, converted_type);
        }

        let (physical_type, length, decimal) = match converted_type {
            ConvertedType::NONE
            | ConvertedType::DATE
            | ConvertedType::TIME_MILLIS
            | ConvertedType::UINT_8
            | ConvertedType::UINT_16
            | ConvertedType::UINT_32
            | ConvertedType::INT_8
            | ConvertedType::INT_16
            | ConvertedType::INT_32 => (PhysicalType::INT32, None, None),
            ConvertedType::TIME_MICROS
            | ConvertedType::TIMESTAMP_MILLIS
            | ConvertedType::TIMESTAMP_MICROS
            | ConvertedType::UINT_64
            | ConvertedType::INT_64 => (PhysicalType::INT64, None, None),
            ConvertedType::UTF8
            | ConvertedType::ENUM
            | ConvertedType::JSON
            | ConvertedType::BSON => (PhysicalType::BYTE_ARRAY, None, None),
            ConvertedType::DECIMAL => (PhysicalType::FIXED_LEN_BYTE_ARRAY, Some(16), Some((38, 4))),
            ConvertedType::INTERVAL => (PhysicalType::FIXED_LEN_BYTE_ARRAY, Some(12), None),
            ConvertedType::MAP | ConvertedType::MAP_KEY_VALUE | ConvertedType::LIST => {
                unreachable!()
            }
        };
        primitive_field(name, physical_type, None, converted_type, length, decimal)
    }

    fn primitive_field(
        name: String,
        physical_type: PhysicalType,
        logical_type: Option<LogicalType>,
        converted_type: ConvertedType,
        length: Option<i32>,
        decimal: Option<(i32, i32)>,
    ) -> TypePtr {
        let mut builder = Type::primitive_type_builder(&name, physical_type)
            .with_repetition(Repetition::OPTIONAL)
            .with_logical_type(logical_type)
            .with_converted_type(converted_type);
        if let Some(length) = length {
            builder = builder.with_length(length);
        }
        if let Some((precision, scale)) = decimal {
            builder = builder.with_precision(precision).with_scale(scale);
        }
        Arc::new(builder.build().expect("type field is valid"))
    }

    fn group_field(
        name: String,
        logical_type: Option<LogicalType>,
        converted_type: ConvertedType,
    ) -> TypePtr {
        Arc::new(
            Type::group_type_builder(&name)
                .with_repetition(Repetition::OPTIONAL)
                .with_logical_type(logical_type)
                .with_converted_type(converted_type)
                .with_fields(vec![primitive_field(
                    "value".to_owned(),
                    PhysicalType::BYTE_ARRAY,
                    None,
                    ConvertedType::NONE,
                    None,
                    None,
                )])
                .build()
                .expect("group type is valid"),
        )
    }

    fn write_empty_parquet(fields: Vec<TypePtr>) -> NamedTempFile {
        let source = NamedTempFile::new().expect("temporary file can be created");
        let schema = Arc::new(
            Type::group_type_builder("schema")
                .with_fields(fields)
                .build()
                .expect("type schema is valid"),
        );
        let file = source.reopen().expect("temporary file can be reopened");
        SerializedFileWriter::new(file, schema, Default::default())
            .expect("Parquet writer can be created")
            .close()
            .expect("empty Parquet file can be closed");
        source
    }

    fn write_batch(source: &NamedTempFile, schema: Arc<Schema>, batch: &RecordBatch) {
        let file = source.reopen().expect("temporary file can be reopened");
        let mut writer =
            ArrowWriter::try_new(file, schema, None).expect("Parquet writer can be created");
        writer.write(batch).expect("record batch can be written");
        writer.close().expect("Parquet footer can be written");
    }
}
