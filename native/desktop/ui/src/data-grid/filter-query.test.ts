import {
  dateDay,
  decimal128,
  TimeUnit,
  timeMicrosecond,
  timestamp,
} from "@uwdata/flechette";
import { describe, expect, it } from "vitest";

import type { DataFilter, SchemaField } from "../desktop";
import {
  columnFilterKind,
  filterInputFromCell,
  formatFilterCondition,
  formatWhereClause,
} from "./filter-query";

const field = (
  name: string,
  physicalType: string,
  logicalType: string | null,
): SchemaField => ({ name, physicalType, logicalType, children: [] });

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
      `"value""quoted" BETWEEN -2 AND 9 AND contains(CAST("label" AS VARCHAR), 'O''Reilly')`,
    );
    expect(formatFilterCondition(filters[0]!, schema[0]!)).toBe(
      `"value""quoted" BETWEEN -2 AND 9`,
    );
  });

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
  ] satisfies [DataFilter, SchemaField, string][])(
    "renders structured operator %# canonically",
    (filter, schemaField, expected) => {
      expect(formatFilterCondition(filter, schemaField)).toBe(expected);
    },
  );
});

describe("filter prefill", () => {
  const rawTimestamp =
    BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf()) * 1_000n + 456n;

  it("formats timestamps with timezone", () => {
    expect(
      filterInputFromCell(rawTimestamp, timestamp(TimeUnit.MICROSECOND, "UTC")),
    ).toBe("2026-08-01T06:07:08.009456Z");
  });

  it("formats timestamps without timezone as local timestamp text", () => {
    expect(
      filterInputFromCell(rawTimestamp, timestamp(TimeUnit.MICROSECOND)),
    ).toBe("2026-08-01T06:07:08.009456");
  });

  it("formats time values", () => {
    expect(filterInputFromCell(22_028_009_456n, timeMicrosecond())).toBe(
      "06:07:08.009456",
    );
  });

  it("formats date values", () => {
    expect(
      filterInputFromCell(Date.parse("2026-08-01T00:00:00.000Z"), dateDay()),
    ).toBe("2026-08-01");
  });

  it("applies the Arrow decimal scale", () => {
    expect(filterInputFromCell(12_345n, decimal128(20, 2))).toBe("123.45");
  });
});
