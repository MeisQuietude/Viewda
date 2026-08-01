use std::{error::Error, fmt, fs::OpenOptions, path::PathBuf, process::ExitCode, sync::Arc};

use arrow_array::{
    ArrayRef, RecordBatch,
    builder::{
        BinaryBuilder, BooleanBuilder, Decimal128Builder, Float64Builder, Int32Builder,
        Int64Builder, ListBuilder, StringBuilder, StructBuilder, TimestampMillisecondBuilder,
        TimestampNanosecondBuilder,
    },
};
use arrow_schema::{DataType, Field, Fields, Schema, TimeUnit};
use parquet::{
    arrow::ArrowWriter,
    basic::{Compression, ZstdLevel},
    file::properties::WriterProperties,
};
use viewda_data_engine::inspect_local_source;

const DEFAULT_SEED: u64 = 42;
const DEFAULT_NULL_RATE: NullRate = NullRate {
    numerator: 1,
    denominator: 10,
};
const NARROW_COLUMN_COUNT: usize = 10;
const MINIMUM_ROW_GROUP_COUNT: u64 = 2;

type GeneratorResult<T> = Result<T, Box<dyn Error>>;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("generate-samples: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> GeneratorResult<()> {
    let Some(config) = Config::parse(std::env::args().skip(1).collect())? else {
        print_usage();
        return Ok(());
    };

    generate(&config)
}

#[derive(Debug)]
struct GeneratorError(String);

impl fmt::Display for GeneratorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for GeneratorError {}

fn invalid(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(GeneratorError(message.into()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preset {
    Rows,
    Size,
    Wide,
}

impl Preset {
    fn parse(value: &str) -> GeneratorResult<Self> {
        match value {
            "rows" => Ok(Self::Rows),
            "size" => Ok(Self::Size),
            "wide" => Ok(Self::Wide),
            _ => Err(invalid(format!(
                "unknown preset `{value}`; expected rows, size, or wide"
            ))),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Rows => "rows",
            Self::Size => "size",
            Self::Wide => "wide",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct NullRate {
    numerator: u64,
    denominator: u64,
}

impl NullRate {
    fn parse(value: &str) -> GeneratorResult<Self> {
        let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
        if fractional.len() > 9 || !whole.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid(format!(
                "invalid --null-rate `{value}`; expected a decimal from 0 to 1"
            )));
        }
        if !fractional.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid(format!(
                "invalid --null-rate `{value}`; expected a decimal from 0 to 1"
            )));
        }

        let denominator =
            10_u64.pow(u32::try_from(fractional.len()).expect("nine decimal places fit in u32"));
        let whole = whole.parse::<u64>()?;
        let fractional = if fractional.is_empty() {
            0
        } else {
            fractional.parse::<u64>()?
        };
        let numerator = whole
            .checked_mul(denominator)
            .and_then(|value| value.checked_add(fractional))
            .ok_or_else(|| invalid("--null-rate is too large"))?;
        if numerator >= denominator {
            return Err(invalid(format!(
                "invalid --null-rate `{value}`; expected a decimal from 0 (inclusive) to 1 (exclusive)"
            )));
        }

        Ok(Self {
            numerator,
            denominator,
        })
    }

    fn is_null(self, seed: u64, row: u64, column: u64) -> bool {
        self.numerator > 0
            && deterministic_value(seed, row, column, 0) % self.denominator < self.numerator
    }
}

#[derive(Debug)]
struct Config {
    preset: Preset,
    output: PathBuf,
    rows: Option<u64>,
    target_size: Option<u64>,
    columns: usize,
    batch_rows: usize,
    row_group_rows: usize,
    null_rate: NullRate,
    seed: u64,
    text_bytes: usize,
    binary_bytes: usize,
}

impl Config {
    fn parse(arguments: Vec<String>) -> GeneratorResult<Option<Self>> {
        if arguments.len() == 1 && matches!(arguments[0].as_str(), "-h" | "--help") {
            return Ok(None);
        }
        if arguments.len() < 2 {
            return Err(invalid(
                "expected PRESET and OUTPUT_FILE; run with --help for usage",
            ));
        }

        let preset = Preset::parse(&arguments[0])?;
        let output = PathBuf::from(&arguments[1]);
        let (mut rows, mut target_size, mut columns, mut batch_rows, mut row_group_rows) =
            match preset {
                Preset::Rows => (Some(100_000_000), None, 10, 65_536, 1_000_000),
                Preset::Size => (None, Some(10_000_000_000), 10, 4_096, 131_072),
                Preset::Wide => (Some(1_000), None, 10_000, 50, 250),
            };
        let mut null_rate = DEFAULT_NULL_RATE;
        let mut seed = DEFAULT_SEED;

        let mut index = 2;
        while index < arguments.len() {
            let option = arguments[index].as_str();
            if matches!(option, "-h" | "--help") {
                return Ok(None);
            }
            let value = arguments
                .get(index + 1)
                .ok_or_else(|| invalid(format!("missing value for `{option}`")))?;
            match option {
                "--rows" => rows = Some(parse_positive_u64(option, value)?),
                "--target-size" => target_size = Some(parse_size(value)?),
                "--columns" => columns = parse_positive_usize(option, value)?,
                "--batch-rows" => batch_rows = parse_positive_usize(option, value)?,
                "--row-group-rows" => row_group_rows = parse_positive_usize(option, value)?,
                "--null-rate" => null_rate = NullRate::parse(value)?,
                "--seed" => seed = parse_u64(option, value)?,
                _ => return Err(invalid(format!("unknown option `{option}`"))),
            }
            index += 2;
        }

        if output.file_name().is_none() {
            return Err(invalid("OUTPUT_FILE must include a file name"));
        }
        if columns < NARROW_COLUMN_COUNT {
            return Err(invalid(format!(
                "--columns must be at least {NARROW_COLUMN_COUNT} to preserve type coverage"
            )));
        }
        if batch_rows > row_group_rows {
            return Err(invalid("--batch-rows cannot exceed --row-group-rows"));
        }
        match preset {
            Preset::Rows | Preset::Wide => {
                let row_count = rows.expect("row presets set a row count");
                if target_size.is_some() {
                    return Err(invalid("--target-size is only valid for the size preset"));
                }
                if row_count <= row_group_rows as u64 {
                    return Err(invalid(
                        "--rows must exceed --row-group-rows so the file has multiple row groups",
                    ));
                }
            }
            Preset::Size => {
                if rows.is_some() {
                    return Err(invalid("--rows is not valid for the size preset"));
                }
            }
        }

        let (text_bytes, binary_bytes) = match preset {
            Preset::Size => (256, 1_024),
            Preset::Rows | Preset::Wide => (24, 16),
        };

        Ok(Some(Self {
            preset,
            output,
            rows,
            target_size,
            columns,
            batch_rows,
            row_group_rows,
            null_rate,
            seed,
            text_bytes,
            binary_bytes,
        }))
    }
}

fn parse_u64(option: &str, value: &str) -> GeneratorResult<u64> {
    value
        .replace('_', "")
        .parse::<u64>()
        .map_err(|_| invalid(format!("invalid value `{value}` for {option}")))
}

fn parse_positive_u64(option: &str, value: &str) -> GeneratorResult<u64> {
    let parsed = parse_u64(option, value)?;
    if parsed == 0 {
        return Err(invalid(format!("{option} must be greater than zero")));
    }
    Ok(parsed)
}

fn parse_positive_usize(option: &str, value: &str) -> GeneratorResult<usize> {
    let parsed = parse_positive_u64(option, value)?;
    usize::try_from(parsed).map_err(|_| invalid(format!("{option} is too large for this host")))
}

fn parse_size(value: &str) -> GeneratorResult<u64> {
    let normalized = value.replace('_', "").to_ascii_uppercase();
    let digits = normalized
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(normalized.len());
    let (number, suffix) = normalized.split_at(digits);
    let number = parse_positive_u64("--target-size", number)?;
    let multiplier = match suffix {
        "" | "B" => 1,
        "KB" => 1_000,
        "MB" => 1_000_000,
        "GB" => 1_000_000_000,
        "KIB" => 1_024,
        "MIB" => 1_048_576,
        "GIB" => 1_073_741_824,
        _ => {
            return Err(invalid(format!(
                "invalid size suffix in `{value}`; use B, KB, MB, GB, KiB, MiB, or GiB"
            )));
        }
    };
    number
        .checked_mul(multiplier)
        .ok_or_else(|| invalid("--target-size is too large"))
}

fn print_usage() {
    println!(
        "Usage: scripts/generate-samples.sh <rows|size|wide> OUTPUT_FILE [OPTIONS]\n\
         \n\
         Preset defaults:\n\
           rows  --rows 100000000 --columns 10 --batch-rows 65536 --row-group-rows 1000000\n\
           size  --target-size 10GB --columns 10 --batch-rows 4096 --row-group-rows 131072\n\
           wide  --rows 1000 --columns 10000 --batch-rows 50 --row-group-rows 250\n\
         \n\
         Common options:\n\
           --null-rate RATE       Null fraction, 0 <= RATE < 1 (default: 0.1)\n\
           --seed SEED            Deterministic unsigned integer seed (default: 42)\n\
           --batch-rows ROWS      Rows materialized per Arrow batch\n\
           --row-group-rows ROWS  Maximum rows per Parquet row group\n\
           --columns COLUMNS      Top-level fields (wide default: 10000)\n\
           --rows ROWS            Total rows for rows and wide\n\
           --target-size SIZE     Size target; accepts GB/GiB suffixes and may overshoot by one row group"
    );
}

fn generate(config: &Config) -> GeneratorResult<()> {
    let schema = Arc::new(build_schema(config.columns));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&config.output)
        .map_err(|error| {
            invalid(format!(
                "cannot create `{}`: {error}; choose a new output path with an existing parent directory",
                config.output.display()
            ))
        })?;
    let properties = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::default()))
        .set_max_row_group_row_count(Some(config.row_group_rows))
        .build();
    let mut writer = ArrowWriter::try_new(file, Arc::clone(&schema), Some(properties))?;

    println!(
        "[generate-samples] preset={} output={} fields={} batch_rows={} row_group_rows={} seed={} null_rate={}/{}",
        config.preset.name(),
        config.output.display(),
        config.columns,
        config.batch_rows,
        config.row_group_rows,
        config.seed,
        config.null_rate.numerator,
        config.null_rate.denominator,
    );

    let row_count = match (config.rows, config.target_size) {
        (Some(rows), None) => write_fixed_rows(config, &schema, &mut writer, rows)?,
        (None, Some(target_size)) => {
            println!("[generate-samples] target_bytes={target_size}");
            write_to_size(config, &schema, &mut writer, target_size)?
        }
        _ => unreachable!("preset validation sets exactly one stopping condition"),
    };
    writer.close()?;

    let expected_row_groups = row_count.div_ceil(config.row_group_rows as u64);
    let summary = inspect_local_source(&config.output)?;
    let actual_row_groups = u64::try_from(summary.row_group_count)
        .map_err(|_| invalid("row-group count does not fit in u64"))?;
    if summary.row_count != row_count
        || actual_row_groups != expected_row_groups
        || summary.schema.len() != config.columns
    {
        return Err(invalid(format!(
            "self-check failed: expected rows={row_count}, row_groups={expected_row_groups}, fields={}; got rows={}, row_groups={}, fields={}",
            config.columns,
            summary.row_count,
            summary.row_group_count,
            summary.schema.len(),
        )));
    }
    if let Some(target_size) = config.target_size
        && summary.size_bytes < target_size
    {
        return Err(invalid(format!(
            "self-check failed: expected at least {target_size} bytes, got {}",
            summary.size_bytes
        )));
    }
    if actual_row_groups < MINIMUM_ROW_GROUP_COUNT {
        return Err(invalid(format!(
            "self-check failed: expected multiple row groups, got {actual_row_groups}"
        )));
    }

    println!(
        "[generate-samples] complete rows={} bytes={} row_groups={} fields={}",
        summary.row_count,
        summary.size_bytes,
        summary.row_group_count,
        summary.schema.len(),
    );
    Ok(())
}

fn write_fixed_rows(
    config: &Config,
    schema: &Arc<Schema>,
    writer: &mut ArrowWriter<std::fs::File>,
    target_rows: u64,
) -> GeneratorResult<u64> {
    let mut rows_written = 0;
    let mut reported_row_groups = 0;
    while rows_written < target_rows {
        let remaining = target_rows - rows_written;
        let batch_rows = usize::try_from(remaining.min(config.batch_rows as u64))
            .expect("batch length is bounded by usize");
        let batch = build_batch(config, schema, rows_written, batch_rows)?;
        writer.write(&batch)?;
        rows_written += batch_rows as u64;
        report_progress(
            writer,
            rows_written,
            &mut reported_row_groups,
            rows_written == target_rows,
        )?;
    }
    Ok(rows_written)
}

fn write_to_size(
    config: &Config,
    schema: &Arc<Schema>,
    writer: &mut ArrowWriter<std::fs::File>,
    target_size: u64,
) -> GeneratorResult<u64> {
    let mut rows_written = 0_u64;
    let mut reported_row_groups = 0;
    loop {
        let batch = build_batch(config, schema, rows_written, config.batch_rows)?;
        writer.write(&batch)?;
        rows_written = rows_written
            .checked_add(config.batch_rows as u64)
            .ok_or_else(|| invalid("generated row count overflowed u64"))?;
        report_progress(writer, rows_written, &mut reported_row_groups, false)?;

        let row_groups = writer.flushed_row_groups().len() as u64;
        if row_groups >= MINIMUM_ROW_GROUP_COUNT && writer.bytes_written() as u64 >= target_size {
            break;
        }
    }
    Ok(rows_written)
}

fn report_progress(
    writer: &mut ArrowWriter<std::fs::File>,
    rows_written: u64,
    reported_row_groups: &mut usize,
    final_batch: bool,
) -> GeneratorResult<()> {
    let row_groups = writer.flushed_row_groups().len();
    if row_groups != *reported_row_groups || final_batch {
        writer.sync()?;
        println!(
            "[generate-samples] rows={} bytes={} row_groups={}",
            rows_written,
            writer.bytes_written(),
            row_groups,
        );
        *reported_row_groups = row_groups;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum ColumnKind {
    Int64,
    Float64,
    Utf8,
    Timestamp,
    TimestampUtc,
    Decimal,
    List,
    Struct,
    Binary,
    Boolean,
}

impl ColumnKind {
    const ALL: [Self; NARROW_COLUMN_COUNT] = [
        Self::Int64,
        Self::Float64,
        Self::Utf8,
        Self::Timestamp,
        Self::TimestampUtc,
        Self::Decimal,
        Self::List,
        Self::Struct,
        Self::Binary,
        Self::Boolean,
    ];

    fn for_column(index: usize) -> Self {
        Self::ALL[index % Self::ALL.len()]
    }

    fn name(self) -> &'static str {
        match self {
            Self::Int64 => "int64",
            Self::Float64 => "float64",
            Self::Utf8 => "utf8",
            Self::Timestamp => "timestamp_ns",
            Self::TimestampUtc => "timestamp_ms_utc",
            Self::Decimal => "decimal128",
            Self::List => "list_int32",
            Self::Struct => "struct",
            Self::Binary => "binary",
            Self::Boolean => "boolean",
        }
    }

    fn data_type(self) -> DataType {
        match self {
            Self::Int64 => DataType::Int64,
            Self::Float64 => DataType::Float64,
            Self::Utf8 => DataType::Utf8,
            Self::Timestamp => DataType::Timestamp(TimeUnit::Nanosecond, None),
            Self::TimestampUtc => {
                DataType::Timestamp(TimeUnit::Millisecond, Some(Arc::from("UTC")))
            }
            Self::Decimal => DataType::Decimal128(18, 4),
            Self::List => DataType::List(Arc::new(Field::new("item", DataType::Int32, true))),
            Self::Struct => DataType::Struct(struct_fields()),
            Self::Binary => DataType::Binary,
            Self::Boolean => DataType::Boolean,
        }
    }
}

fn struct_fields() -> Fields {
    vec![
        Arc::new(Field::new("enabled", DataType::Boolean, true)),
        Arc::new(Field::new("code", DataType::Utf8, true)),
    ]
    .into()
}

fn build_schema(column_count: usize) -> Schema {
    let narrow_names = [
        "id",
        "score",
        "label",
        "created_at",
        "observed_at_utc",
        "amount",
        "tags",
        "profile",
        "payload",
        "active",
    ];
    let fields = (0..column_count)
        .map(|index| {
            let kind = ColumnKind::for_column(index);
            let name = if column_count == NARROW_COLUMN_COUNT {
                narrow_names[index].to_owned()
            } else {
                format!("c{index:05}_{}", kind.name())
            };
            Field::new(name, kind.data_type(), true)
        })
        .collect::<Vec<_>>();
    Schema::new(fields)
}

fn build_batch(
    config: &Config,
    schema: &Arc<Schema>,
    start_row: u64,
    row_count: usize,
) -> GeneratorResult<RecordBatch> {
    let columns = (0..config.columns)
        .map(|column| build_column(config, start_row, row_count, column))
        .collect::<GeneratorResult<Vec<_>>>()?;
    Ok(RecordBatch::try_new(Arc::clone(schema), columns)?)
}

fn build_column(
    config: &Config,
    start_row: u64,
    row_count: usize,
    column: usize,
) -> GeneratorResult<ArrayRef> {
    let column_id = column as u64;
    let null_rate = config.null_rate;
    let seed = config.seed;
    let row = |offset: usize| start_row + offset as u64;
    let is_null = |current_row| null_rate.is_null(seed, current_row, column_id);

    let array: ArrayRef = match ColumnKind::for_column(column) {
        ColumnKind::Int64 => {
            let mut builder = Int64Builder::with_capacity(row_count);
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    builder
                        .append_value(deterministic_value(seed, current_row, column_id, 1) as i64);
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Float64 => {
            let mut builder = Float64Builder::with_capacity(row_count);
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else if current_row % 100_003 == 0 {
                    builder.append_value(f64::NAN);
                } else if current_row % 100_019 == 0 {
                    builder.append_value(f64::INFINITY);
                } else {
                    let value = deterministic_value(seed, current_row, column_id, 1);
                    let bits = (value & 0x8000_0000_0000_0000)
                        | 0x3ff0_0000_0000_0000
                        | (value & 0x000f_ffff_ffff_ffff);
                    builder.append_value(f64::from_bits(bits));
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Utf8 => {
            let mut builder = StringBuilder::with_capacity(
                row_count,
                row_count.saturating_mul(config.text_bytes),
            );
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    let value = deterministic_text(seed, current_row, column_id, config.text_bytes);
                    builder.append_value(value);
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Timestamp => {
            let mut builder = TimestampNanosecondBuilder::with_capacity(row_count);
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    builder.append_value(
                        1_700_000_000_000_000_000_i64
                            + (current_row % 100_000_000_000) as i64 * 1_000,
                    );
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::TimestampUtc => {
            let mut builder =
                TimestampMillisecondBuilder::with_capacity(row_count).with_timezone("UTC");
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    builder
                        .append_value(1_700_000_000_000_i64 + (current_row % 1_000_000_000) as i64);
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Decimal => {
            let mut builder =
                Decimal128Builder::with_capacity(row_count).with_precision_and_scale(18, 4)?;
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    let raw = deterministic_value(seed, current_row, column_id, 1)
                        % 1_000_000_000_000_000_000;
                    builder.append_value(raw as i128 - 500_000_000_000_000_000_i128);
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::List => {
            let item_field = Arc::new(Field::new("item", DataType::Int32, true));
            let mut builder = ListBuilder::with_capacity(
                Int32Builder::with_capacity(row_count.saturating_mul(3)),
                row_count,
            )
            .with_field(item_field);
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append(false);
                } else {
                    for item in 0..3_u64 {
                        if (current_row + item) % 17 == 0 {
                            builder.values().append_null();
                        } else {
                            builder.values().append_value(deterministic_value(
                                seed,
                                current_row,
                                column_id,
                                item + 1,
                            ) as i32);
                        }
                    }
                    builder.append(true);
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Struct => {
            let fields = struct_fields();
            let mut builder = StructBuilder::new(
                fields,
                vec![
                    Box::new(BooleanBuilder::with_capacity(row_count)),
                    Box::new(StringBuilder::with_capacity(
                        row_count,
                        row_count.saturating_mul(12),
                    )),
                ],
            );
            for offset in 0..row_count {
                let current_row = row(offset);
                let valid = !is_null(current_row);
                {
                    let enabled = builder
                        .field_builder::<BooleanBuilder>(0)
                        .expect("struct boolean builder");
                    if valid {
                        enabled.append_value(
                            deterministic_value(seed, current_row, column_id, 1) & 1 == 1,
                        );
                    } else {
                        enabled.append_null();
                    }
                }
                {
                    let code = builder
                        .field_builder::<StringBuilder>(1)
                        .expect("struct string builder");
                    if valid && current_row % 13 != 0 {
                        code.append_value(format!("p-{:08x}", current_row as u32));
                    } else {
                        code.append_null();
                    }
                }
                builder.append(valid);
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Binary => {
            let mut builder = BinaryBuilder::with_capacity(
                row_count,
                row_count.saturating_mul(config.binary_bytes),
            );
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    builder.append_value(deterministic_bytes(
                        seed,
                        current_row,
                        column_id,
                        config.binary_bytes,
                    ));
                }
            }
            Arc::new(builder.finish())
        }
        ColumnKind::Boolean => {
            let mut builder = BooleanBuilder::with_capacity(row_count);
            for offset in 0..row_count {
                let current_row = row(offset);
                if is_null(current_row) {
                    builder.append_null();
                } else {
                    builder.append_value(
                        deterministic_value(seed, current_row, column_id, 1) & 1 == 1,
                    );
                }
            }
            Arc::new(builder.finish())
        }
    };
    Ok(array)
}

fn deterministic_text(seed: u64, row: u64, column: u64, length: usize) -> String {
    const ALPHABET: &[u8; 64] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
    let mut bytes = deterministic_bytes(seed, row, column, length);
    for byte in &mut bytes {
        *byte = ALPHABET[usize::from(*byte & 63)];
    }
    String::from_utf8(bytes).expect("the synthetic alphabet is valid UTF-8")
}

fn deterministic_bytes(seed: u64, row: u64, column: u64, length: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(length);
    let mut lane = 1_u64;
    while bytes.len() < length {
        let value = deterministic_value(seed, row, column, lane).to_le_bytes();
        let remaining = length - bytes.len();
        bytes.extend_from_slice(&value[..remaining.min(value.len())]);
        lane += 1;
    }
    bytes
}

fn deterministic_value(seed: u64, row: u64, column: u64, lane: u64) -> u64 {
    splitmix64(
        seed ^ row.wrapping_mul(0x9e37_79b9_7f4a_7c15)
            ^ column.wrapping_mul(0xbf58_476d_1ce4_e5b9)
            ^ lane.wrapping_mul(0x94d0_49bb_1331_11eb),
    )
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}
