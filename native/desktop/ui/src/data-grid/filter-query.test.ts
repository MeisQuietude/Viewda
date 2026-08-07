import {
  dateDay,
  decimal128,
  TimeUnit,
  timeMillisecond,
  timeMicrosecond,
  timeNanosecond,
  timestamp,
} from "@uwdata/flechette";
import { describe, expect, it } from "vitest";

import type { DataFilter, SchemaField, SortColumn } from "../desktop";
import {
  columnFilterKind,
  filterInputFromCell,
  formatFilterCondition,
  formatOrderByClause,
  formatWhereClause,
} from "./filter-query";

const field = (
  name: string,
  physicalType: string,
  logicalType: string | null,
): SchemaField => ({ name, physicalType, logicalType, children: [] });

describe("column filter kinds", () => {
  it.each([
    [field("uuid_value", "FIXED_LEN_BYTE_ARRAY", "UUID"), "text"],
    [field("json_value", "BYTE_ARRAY", "JSON"), "text"],
    [field("binary_value", "BYTE_ARRAY", null), "nullOnly"],
    [field("bson_value", "BYTE_ARRAY", "BSON"), "nullOnly"],
    [field("variant_value", "GROUP", "Variant (version 1)"), "nullOnly"],
    [
      field("geometry_value", "BYTE_ARRAY", "Geometry (CRS OGC:CRS84)"),
      "nullOnly",
    ],
    [
      field("geography_value", "BYTE_ARRAY", "Geography (spherical)"),
      "nullOnly",
    ],
  ] as const)("maps %s to %s", (schemaField, expected) => {
    expect(columnFilterKind(schemaField)).toBe(expected);
  });
});

describe("canonical filter query formatting", () => {
  it.each([
    [field("name", "BYTE_ARRAY", "String"), "O'Reilly", "'O''Reilly'"],
    [field("delta", "INT64", null), "-42", "-42"],
    [
      field(
        "amount",
        "FIXED_LEN_BYTE_ARRAY",
        "Decimal (precision 10, scale 2)",
      ),
      "12.50",
      `cast_to_type('12.50', "amount")`,
    ],
    [field("day", "INT32", "Date"), "2026-08-01", "DATE '2026-08-01'"],
    [
      field("local_at", "INT64", "Timestamp (microseconds, local)"),
      "2026-08-01T06:07:08.009456",
      "TIMESTAMP '2026-08-01T06:07:08.009456'",
    ],
    [
      field("utc_at", "INT64", "Timestamp (microseconds, UTC)"),
      "2026-08-01T06:07:08.009456Z",
      "TIMESTAMP '2026-08-01T06:07:08.009456Z'",
    ],
    [
      field("clock", "INT64", "Time (microseconds, local)"),
      "06:07:08.009456",
      "TIME '06:07:08.009456'",
    ],
  ])("formats %s literals", (schemaField, value, expected) => {
    expect(
      formatFilterCondition(
        { columnIndex: 0, operator: "equals", values: [value] },
        schemaField,
      ),
    ).toBe(`"${schemaField.name}" = ${expected}`);
  });

  it("renders the AST deterministically with SQL identifier quoting", () => {
    const schema = [
      field('value"quoted', "INT64", null),
      field("label", "BYTE_ARRAY", "String"),
    ];
    const filters: DataFilter[] = [
      { columnIndex: 0, operator: "range", values: ["-2", "9"] },
      {
        columnIndex: 1,
        operator: "textContains",
        values: ["O'Reilly"],
      },
    ];

    expect(formatWhereClause(filters, schema)).toBe(
      `"value""quoted" BETWEEN -2 AND 9 AND contains(lower(CAST("label" AS VARCHAR)), lower('O''Reilly'))`,
    );
    expect(formatFilterCondition(filters[0]!, schema[0]!)).toBe(
      `"value""quoted" BETWEEN -2 AND 9`,
    );
  });

  it.each([
    [
      { columnIndex: 0, operator: "textContains", values: ["Alpha"] },
      `contains(lower(CAST("label" AS VARCHAR)), lower('Alpha'))`,
    ],
    [
      { columnIndex: 0, operator: "notContains", values: ["Alpha"] },
      `NOT contains(lower(CAST("label" AS VARCHAR)), lower('Alpha'))`,
    ],
    [
      {
        columnIndex: 0,
        operator: "startsWith",
        values: ["Alpha"],
        matchCase: true,
      },
      `starts_with(CAST("label" AS VARCHAR), 'Alpha')`,
    ],
    [
      { columnIndex: 0, operator: "endsWith", values: ["Alpha"] },
      `ends_with(lower(CAST("label" AS VARCHAR)), lower('Alpha'))`,
    ],
  ] satisfies [DataFilter, string][])(
    "renders text condition %# canonically",
    (filter, expected) => {
      expect(
        formatFilterCondition(filter, field("label", "BYTE_ARRAY", "String")),
      ).toBe(expected);
    },
  );

  it("renders numeric comparisons in the WHERE bar", () => {
    const schema = [field("amount", "DOUBLE", null)];
    const filters: DataFilter[] = [
      { columnIndex: 0, operator: "greaterThan", values: ["1"] },
      { columnIndex: 0, operator: "greaterThanOrEqual", values: ["2"] },
      { columnIndex: 0, operator: "lessThan", values: ["9"] },
      { columnIndex: 0, operator: "lessThanOrEqual", values: ["8"] },
    ];

    expect(formatWhereClause(filters, schema)).toBe(
      `"amount" > 1 AND "amount" >= 2 AND "amount" < 9 AND "amount" <= 8`,
    );
  });

  it("classifies Float16 as numeric", () => {
    expect(
      columnFilterKind(field("half", "FIXED_LEN_BYTE_ARRAY", "Float16")),
    ).toBe("number");
  });

  it.each([
    [
      { columnIndex: 0, operator: "equals", values: ["true"] },
      field("active", "BOOLEAN", null),
      '"active" = TRUE',
    ],
    [
      { columnIndex: 0, operator: "oneOf", values: ["-2", "9"] },
      field("amount", "INT64", null),
      '"amount" IN (-2, 9)',
    ],
    [
      { columnIndex: 0, operator: "isNull", values: [] },
      field("label", "BYTE_ARRAY", "String"),
      '"label" IS NULL',
    ],
    [
      { columnIndex: 0, operator: "isNotNull", values: [] },
      field("label", "BYTE_ARRAY", "String"),
      '"label" IS NOT NULL',
    ],
    [
      { columnIndex: 0, operator: "greaterThan", values: ["2026-08-01"] },
      field("day", "INT32", "Date"),
      "\"day\" > DATE '2026-08-01'",
    ],
    [
      {
        columnIndex: 0,
        operator: "greaterThanOrEqual",
        values: ["06:07:08.009+00:00"],
      },
      field("clock", "INT32", "Time (milliseconds, UTC)"),
      "\"clock\" >= TIME '06:07:08.009+00:00'",
    ],
    [
      {
        columnIndex: 0,
        operator: "lessThan",
        values: ["2026-08-01T06:07:08.009456Z"],
      },
      field("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
      "\"recorded_at\" < TIMESTAMP '2026-08-01T06:07:08.009456Z'",
    ],
    [
      {
        columnIndex: 0,
        operator: "lessThanOrEqual",
        values: ["2026-08-01T06:07:08.009456789"],
      },
      field("legacy_at", "INT96", null),
      "\"legacy_at\" <= TIMESTAMP '2026-08-01T06:07:08.009456789'",
    ],
  ] satisfies [DataFilter, SchemaField, string][])(
    "renders structured operator %# canonically",
    (filter, schemaField, expected) => {
      expect(formatFilterCondition(filter, schemaField)).toBe(expected);
    },
  );

  it("renders ORDER BY with the same identifier quoting as the engine", () => {
    const schema = [
      field('value"quoted', "INT64", null),
      field("label", "BYTE_ARRAY", "String"),
    ];
    const sort: SortColumn[] = [
      { sourceIndex: 1, direction: "descending" },
      { sourceIndex: 0, direction: "ascending" },
    ];

    expect(formatOrderByClause(sort, schema)).toBe(
      '"label" DESC, "value""quoted" ASC',
    );
  });
});

describe("filter prefill", () => {
  const milliseconds = BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf());
  const rawTimestamp = milliseconds * 1_000n + 456n;

  it.each([
    [TimeUnit.MILLISECOND, milliseconds, "2026-08-01T06:07:08.009"],
    [
      TimeUnit.MICROSECOND,
      milliseconds * 1_000n + 456n,
      "2026-08-01T06:07:08.009456",
    ],
    [
      TimeUnit.NANOSECOND,
      milliseconds * 1_000_000n + 456_789n,
      "2026-08-01T06:07:08.009456789",
    ],
  ])("formats local timestamp unit %s", (unit, value, expected) => {
    const unitName =
      unit === TimeUnit.MILLISECOND
        ? "milliseconds"
        : unit === TimeUnit.MICROSECOND
          ? "microseconds"
          : "nanoseconds";
    expect(
      filterInputFromCell(
        value,
        timestamp(unit),
        field("local_at", "INT64", `Timestamp (${unitName}, local)`),
      ),
    ).toBe(expected);
  });

  it("formats timestamps with timezone", () => {
    expect(
      filterInputFromCell(
        rawTimestamp,
        timestamp(TimeUnit.MICROSECOND, "UTC"),
        field("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
      ),
    ).toBe("2026-08-01T06:07:08.009456Z");
  });

  it("formats timestamps without timezone as local timestamp text", () => {
    expect(
      filterInputFromCell(
        rawTimestamp,
        timestamp(TimeUnit.MICROSECOND),
        field("local_at", "INT64", "Timestamp (microseconds, local)"),
      ),
    ).toBe("2026-08-01T06:07:08.009456");
  });

  it.each([
    [timeMillisecond(), 22_028_009, "06:07:08.009"],
    [timeMicrosecond(), 22_028_009_456n, "06:07:08.009456"],
    [timeNanosecond(), 22_028_009_456_789n, "06:07:08.009456789"],
  ])(
    "formats time values for supported Parquet units",
    (type, value, expected) => {
      const unitName =
        type.unit === TimeUnit.MILLISECOND
          ? "milliseconds"
          : type.unit === TimeUnit.MICROSECOND
            ? "microseconds"
            : "nanoseconds";
      expect(
        filterInputFromCell(
          value,
          type,
          field("clock", "INT64", `Time (${unitName}, local)`),
        ),
      ).toBe(expected);
    },
  );

  it("adds the declared UTC offset to a timezone-naive Arrow time", () => {
    expect(
      filterInputFromCell(
        22_028_009_456n,
        timeMicrosecond(),
        field("clock", "INT64", "Time (microseconds, UTC)"),
      ),
    ).toBe("06:07:08.009456+00:00");
  });

  it("formats date values", () => {
    expect(
      filterInputFromCell(
        Date.parse("2026-08-01T00:00:00.000Z"),
        dateDay(),
        field("day", "INT32", "Date"),
      ),
    ).toBe("2026-08-01");
  });

  it("applies the Arrow decimal scale", () => {
    expect(
      filterInputFromCell(
        12_345n,
        decimal128(20, 2),
        field("amount", "FIXED_LEN_BYTE_ARRAY", "Decimal (20, 2)"),
      ),
    ).toBe("123.45");
  });
});
