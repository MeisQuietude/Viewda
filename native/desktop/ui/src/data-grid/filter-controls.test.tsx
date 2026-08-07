import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  TimeUnit,
  dateDay,
  timeMicrosecond,
  timestamp,
} from "@uwdata/flechette";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SchemaField } from "../desktop";
import { FilterEditor } from "./filter-controls";
import { filterInputFromCell } from "./filter-query";

afterEach(cleanup);

describe("FilterEditor", () => {
  it("accepts numeric literals but not free-form expressions", () => {
    const { editor, onApply } = renderNumberEditor();
    const input = within(editor).getByRole("textbox", { name: "Value" });
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    fireEvent.change(input, { target: { value: "1 OR 1=1" } });
    expect(apply).toBeDisabled();

    fireEvent.change(input, { target: { value: "-1.25e3" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "equals",
      values: ["-1.25e3"],
    });
  });

  it("rejects fractional input for integer columns", () => {
    const { editor, onApply } = renderNumberEditor({
      name: "n",
      physicalType: "INT64",
      logicalType: "Int64",
      children: [],
    });
    const input = within(editor).getByRole("textbox", { name: "Value" });
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    fireEvent.change(input, { target: { value: "12.5" } });
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Enter an integer.",
    );
    expect(apply).toBeDisabled();

    fireEvent.change(input, { target: { value: "12" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "equals",
      values: ["12"],
    });
  });

  it("builds a one-of list from one value per line", () => {
    const { editor, onApply } = renderNumberEditor();
    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      {
        target: { value: "oneOf" },
      },
    );
    fireEvent.change(
      within(editor).getByRole("textbox", { name: "Values, one per line" }),
      { target: { value: "1\n\n 2 " } },
    );
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );

    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "oneOf",
      values: ["1", "2"],
    });
  });

  it("requires both range boundaries", () => {
    const { editor, onApply } = renderNumberEditor();
    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      {
        target: { value: "range" },
      },
    );
    const apply = within(editor).getByRole("button", { name: "Add condition" });
    fireEvent.change(within(editor).getByRole("textbox", { name: "From" }), {
      target: { value: "-2" },
    });
    expect(apply).toBeDisabled();
    fireEvent.change(within(editor).getByRole("textbox", { name: "To" }), {
      target: { value: "9" },
    });
    fireEvent.click(apply);

    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "range",
      values: ["-2", "9"],
    });
  });

  it.each([
    ["greaterThan", "is greater than"],
    ["greaterThanOrEqual", "is greater than or equal to"],
    ["lessThan", "is less than"],
    ["lessThanOrEqual", "is less than or equal to"],
  ] as const)(
    "builds a single-value %s numeric comparison",
    (operator, label) => {
      const { editor, onApply } = renderNumberEditor();
      const condition = within(editor).getByRole("combobox", {
        name: "Condition",
      });
      expect(
        within(condition).getByRole("option", { name: label }),
      ).toHaveValue(operator);

      fireEvent.change(condition, { target: { value: operator } });
      fireEvent.change(within(editor).getByRole("textbox", { name: "Value" }), {
        target: { value: "2.5" },
      });
      expect(
        within(editor).queryByRole("textbox", { name: "From" }),
      ).not.toBeInTheDocument();
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add condition" }),
      );

      expect(onApply).toHaveBeenCalledWith({
        columnIndex: 0,
        operator,
        values: ["2.5"],
      });
    },
  );

  it("offers numeric comparisons for Float16", () => {
    const onApply = vi.fn();
    render(
      <FilterEditor
        request={{ sourceIndex: 0, left: 0, top: 0 }}
        field={{
          name: "half",
          physicalType: "FIXED_LEN_BYTE_ARRAY",
          logicalType: "Float16",
          children: [],
        }}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    const editor = screen.getByRole("form", { name: "Filter half" });
    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      { target: { value: "greaterThan" } },
    );
    fireEvent.change(within(editor).getByRole("textbox", { name: "Value" }), {
      target: { value: "1.5" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );

    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "greaterThan",
      values: ["1.5"],
    });
  });

  it("emits no values for a null check", () => {
    const { editor, onApply } = renderNumberEditor();
    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      {
        target: { value: "isNull" },
      },
    );
    expect(
      within(editor).queryByRole("textbox", { name: "Value" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );

    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "isNull",
      values: [],
    });
  });

  it("initializes the visible boolean value when leaving a null check", () => {
    const onApply = vi.fn();
    render(
      <FilterEditor
        request={{
          sourceIndex: 0,
          left: 0,
          top: 0,
          filterIndex: 0,
          initialFilter: {
            columnIndex: 0,
            operator: "isNull",
            values: [],
          },
        }}
        field={{
          name: "active",
          physicalType: "BOOLEAN",
          logicalType: null,
          children: [],
        }}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    const editor = screen.getByRole("form", { name: "Filter active" });

    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      { target: { value: "equals" } },
    );

    expect(within(editor).getByRole("combobox", { name: "Value" })).toHaveValue(
      "true",
    );
    const apply = within(editor).getByRole("button", {
      name: "Save condition",
    });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "equals",
      values: ["true"],
    });
  });

  it("validates a temporal comparison before applying it", () => {
    const { editor, onApply } = renderTemporalEditor(
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
    );
    const condition = within(editor).getByRole("combobox", {
      name: "Condition",
    });
    const input = within(editor).getByRole("textbox", { name: "Value" });
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    expect(
      within(condition).getByRole("option", { name: "is after" }),
    ).toHaveValue("greaterThan");
    fireEvent.change(condition, { target: { value: "greaterThan" } });
    fireEvent.change(input, {
      target: { value: "2026-02-29T06:07:08.123456Z" },
    });
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Invalid calendar date.",
    );
    expect(apply).toBeDisabled();
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: " 2026-08-01T06:07:08Z " },
    });
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "greaterThan",
      values: ["2026-08-01T06:07:08Z"],
    });
  });

  it.each([
    [
      "Date",
      temporalField("day", "INT32", "Date"),
      "date",
      "Format: YYYY-MM-DD",
      "2024-02-29",
    ],
    [
      "local nanosecond timestamp",
      temporalField("local_nanos", "INT64", "Timestamp (nanoseconds, local)"),
      "text",
      "Format: YYYY-MM-DDTHH:mm:ss; fraction: optional, 1–9 digits; timezone suffix: not allowed; column: nanoseconds, local",
      "2026-08-07T12:34:56.123456789",
    ],
    [
      "UTC millisecond timestamp",
      temporalField("utc_millis", "INT64", "Timestamp (milliseconds, UTC)"),
      "text",
      "Format: YYYY-MM-DDTHH:mm:ss; fraction: optional, 1–9 digits; timezone: required, Z or ±HH:mm; column: milliseconds, UTC",
      "2026-08-07T12:34:56.1234+03:00",
    ],
    [
      "microsecond time",
      temporalField("clock", "INT64", "Time (microseconds, UTC)"),
      "text",
      "Format: HH:mm:ss; fraction: optional, 1–9 digits; offset: optional, ±HH:mm; column: microseconds, UTC",
      "23:59:59+03:00",
    ],
    [
      "microsecond UTC time without an offset",
      temporalField("clock", "INT64", "Time (microseconds, UTC)"),
      "text",
      "Format: HH:mm:ss; fraction: optional, 1–9 digits; offset: optional, ±HH:mm; column: microseconds, UTC",
      "12:34:56",
    ],
    [
      "leap-day local timestamp",
      temporalField("leap_at", "INT64", "Timestamp (microseconds, local)"),
      "text",
      "Format: YYYY-MM-DDTHH:mm:ss; fraction: optional, 1–9 digits; timezone suffix: not allowed; column: microseconds, local",
      "2024-02-29T12:34:56",
    ],
    [
      "INT96 timestamp",
      temporalField("legacy_at", "INT96", null),
      "text",
      "Format: YYYY-MM-DDTHH:mm:ss; fraction: optional, 1–9 digits; timezone suffix: not allowed; column: INT96",
      "2026-08-07T12:34:56.123456789",
    ],
  ])(
    "renders the field format and accepts a valid %s value",
    (_name, field, inputType, hint, enteredValue) => {
      const { editor, onApply } = renderTemporalEditor(field);
      const input = within(editor).getByLabelText<HTMLInputElement>("Value");
      const formatHint = within(editor).getByText(hint);

      expect(input).toHaveAttribute("type", inputType);
      expect(input).toHaveAccessibleName("Value");
      expect(input).toHaveAttribute("aria-describedby", formatHint.id);
      expect(formatHint).toBeInTheDocument();
      if (inputType === "date") {
        expect(input).not.toHaveAttribute("placeholder");
      }

      fireEvent.change(input, { target: { value: enteredValue } });
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add condition" }),
      );
      expect(onApply).toHaveBeenCalledWith({
        columnIndex: 0,
        operator: "equals",
        values: [enteredValue],
      });
    },
  );

  it.each([
    [
      "non-leap date",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, local)"),
      "2026-02-29T12:34:56",
      "Invalid calendar date.",
    ],
    [
      "invalid date shape",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, local)"),
      "2026/08/07T12:34:56",
      "Expected YYYY-MM-DD.",
    ],
    [
      "missing date-time separator",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, local)"),
      "2026-08-07 12:34:56",
      "Expected T between date and time.",
    ],
    [
      "time after the end of day",
      temporalField("clock", "INT64", "Time (nanoseconds, local)"),
      "24:00:00",
      "Time must be within 00:00:00–23:59:59.",
    ],
    [
      "incomplete time",
      temporalField("clock", "INT64", "Time (nanoseconds, local)"),
      "12:34",
      "Expected HH:mm:ss with an optional fraction.",
    ],
    [
      "missing UTC suffix",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
      "2026-08-07T12:34:56",
      "Timezone suffix required: Z or ±HH:mm.",
    ],
    [
      "invalid UTC time offset",
      temporalField("clock", "INT64", "Time (microseconds, UTC)"),
      "12:34:56+24:00",
      "Invalid timezone offset.",
    ],
    [
      "Z suffix on UTC time",
      temporalField("clock", "INT64", "Time (microseconds, UTC)"),
      "12:34:56Z",
      "Use a numeric offset (±HH:mm), not Z.",
    ],
    [
      "invalid UTC offset",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
      "2026-08-07T12:34:56+24:00",
      "Invalid timezone offset.",
    ],
    [
      "unexpected local suffix",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, local)"),
      "2026-08-07T12:34:56Z",
      "Timezone suffix not allowed.",
    ],
    [
      "INT96 overprecision",
      temporalField("legacy_at", "INT96", null),
      "2026-08-07T12:34:56.1234567890",
      "Fraction must have 1–9 digits.",
    ],
  ])("rejects %s", (_name, field, value, expectedError) => {
    const { editor, onApply } = renderTemporalEditor(field);
    const input = within(editor).getByLabelText("Value");
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    fireEvent.change(input, { target: { value } });

    expect(apply).toBeDisabled();
    expect(within(editor).getByRole("alert")).toHaveTextContent(expectedError);
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("validates both temporal range boundaries", () => {
    const field = temporalField(
      "recorded_at",
      "INT64",
      "Timestamp (milliseconds, local)",
    );
    const { editor, onApply } = renderTemporalEditor(field);
    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      { target: { value: "range" } },
    );
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });
    fireEvent.change(within(editor).getByRole("textbox", { name: "From" }), {
      target: { value: "2026-02-29T12:34:56" },
    });
    fireEvent.change(within(editor).getByRole("textbox", { name: "To" }), {
      target: { value: "2026-08-08T12:34:56.1234" },
    });
    expect(apply).toBeDisabled();
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Invalid calendar date.",
    );
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(within(editor).getByRole("textbox", { name: "From" }), {
      target: { value: "2026-08-07T12:34:56" },
    });
    fireEvent.change(within(editor).getByRole("textbox", { name: "To" }), {
      target: { value: "2026-02-29T12:34:56.1234" },
    });
    expect(apply).toBeDisabled();
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Invalid calendar date.",
    );
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(within(editor).getByRole("textbox", { name: "To" }), {
      target: { value: "2026-08-08T12:34:56.1234" },
    });
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "range",
      values: ["2026-08-07T12:34:56", "2026-08-08T12:34:56.1234"],
    });
  });

  it("validates every temporal one-of value", () => {
    const field = temporalField("clock", "INT64", "Time (milliseconds, local)");
    const { editor, onApply } = renderTemporalEditor(field);
    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      { target: { value: "oneOf" } },
    );
    const values = within(editor).getByRole("textbox", {
      name: "Values, one per line",
    });
    const formatHint = within(editor).getByText(
      "Format: HH:mm:ss; fraction: optional, 1–9 digits; timezone suffix: not allowed; column: milliseconds, local",
    );
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });
    expect(values).toHaveAccessibleName("Values, one per line");
    expect(values).toHaveAttribute("aria-describedby", formatHint.id);
    fireEvent.change(values, { target: { value: "00:00:00\n24:00:00" } });
    expect(apply).toBeDisabled();
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Time must be within 00:00:00–23:59:59.",
    );
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(values, { target: { value: "24:00:00\n23:59:59" } });
    expect(apply).toBeDisabled();
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Time must be within 00:00:00–23:59:59.",
    );
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(values, {
      target: { value: " 00:00:00 \n 23:59:59.9 " },
    });
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "oneOf",
      values: ["00:00:00", "23:59:59.9"],
    });
  });

  it.each([
    [
      "Date",
      temporalField("day", "INT32", "Date"),
      dateDay(),
      Date.parse("2026-08-01T00:00:00Z"),
      "2026-08-01",
    ],
    [
      "milliseconds local",
      temporalField("recorded_at", "INT64", "Timestamp (milliseconds, local)"),
      timestamp(TimeUnit.MICROSECOND),
      1_785_564_428_009_000n,
      "2026-08-01T06:07:08.009",
    ],
    [
      "milliseconds UTC",
      temporalField("recorded_at", "INT64", "Timestamp (milliseconds, UTC)"),
      timestamp(TimeUnit.MICROSECOND, "Asia/Yekaterinburg"),
      1_785_564_428_009_000n,
      "2026-08-01T06:07:08.009Z",
    ],
    [
      "microseconds local",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, local)"),
      timestamp(TimeUnit.MICROSECOND),
      1_785_564_428_009_456n,
      "2026-08-01T06:07:08.009456",
    ],
    [
      "microseconds UTC",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
      timestamp(TimeUnit.MICROSECOND, "Asia/Yekaterinburg"),
      1_785_564_428_009_456n,
      "2026-08-01T06:07:08.009456Z",
    ],
    [
      "nanoseconds local",
      temporalField("recorded_at", "INT64", "Timestamp (nanoseconds, local)"),
      timestamp(TimeUnit.NANOSECOND),
      1_785_564_428_009_456_789n,
      "2026-08-01T06:07:08.009456789",
    ],
    [
      "nanoseconds UTC",
      temporalField("recorded_at", "INT64", "Timestamp (nanoseconds, UTC)"),
      timestamp(TimeUnit.MICROSECOND, "Asia/Yekaterinburg"),
      1_785_564_428_009_456n,
      "2026-08-01T06:07:08.009456Z",
    ],
    [
      "time milliseconds local",
      temporalField("clock", "INT32", "Time (milliseconds, local)"),
      timeMicrosecond(),
      22_028_009_000n,
      "06:07:08.009",
    ],
    [
      "time milliseconds UTC",
      temporalField("clock", "INT32", "Time (milliseconds, UTC)"),
      timeMicrosecond(),
      22_028_009_000n,
      "06:07:08.009+00:00",
    ],
    [
      "time microseconds local",
      temporalField("clock", "INT64", "Time (microseconds, local)"),
      timeMicrosecond(),
      22_028_009_456n,
      "06:07:08.009456",
    ],
    [
      "time microseconds UTC",
      temporalField("clock", "INT64", "Time (microseconds, UTC)"),
      timeMicrosecond(),
      22_028_009_456n,
      "06:07:08.009456+00:00",
    ],
    [
      "time nanoseconds local normalized by DuckDB",
      temporalField("clock", "INT64", "Time (nanoseconds, local)"),
      timeMicrosecond(),
      22_028_009_456n,
      "06:07:08.009456",
    ],
    [
      "time nanoseconds UTC normalized by DuckDB",
      temporalField("clock", "INT64", "Time (nanoseconds, UTC)"),
      timeMicrosecond(),
      22_028_009_456n,
      "06:07:08.009456+00:00",
    ],
    [
      "legacy TIMESTAMP_MILLIS exposed by DuckDB without timezone",
      temporalField("recorded_at", "INT64", "Timestamp (milliseconds, UTC)"),
      timestamp(TimeUnit.MICROSECOND),
      1_785_564_428_009_000n,
      "2026-08-01T06:07:08.009Z",
    ],
    [
      "legacy TIMESTAMP_MICROS exposed by DuckDB without timezone",
      temporalField("recorded_at", "INT64", "Timestamp (microseconds, UTC)"),
      timestamp(TimeUnit.MICROSECOND),
      1_785_564_428_009_456n,
      "2026-08-01T06:07:08.009456Z",
    ],
    [
      "legacy TIME_MILLIS exposed by DuckDB without timezone",
      temporalField("clock", "INT32", "Time (milliseconds, UTC)"),
      timeMicrosecond(),
      22_028_009_000n,
      "06:07:08.009+00:00",
    ],
    [
      "legacy TIME_MICROS exposed by DuckDB without timezone",
      temporalField("clock", "INT64", "Time (microseconds, UTC)"),
      timeMicrosecond(),
      22_028_009_456n,
      "06:07:08.009456+00:00",
    ],
    [
      "INT96 exposed by DuckDB at microsecond precision",
      temporalField("recorded_at", "INT96", null),
      timestamp(TimeUnit.MICROSECOND),
      1_785_564_428_009_456n,
      "2026-08-01T06:07:08.009456",
    ],
  ])(
    "round-trips cell prefill for %s",
    (_name, field, dataType, value, expected) => {
      const prefill = filterInputFromCell(value, dataType, field);
      const { editor, onApply } = renderTemporalEditor(field, prefill);
      const input = within(editor).getByLabelText("Value");
      const apply = within(editor).getByRole("button", {
        name: "Add condition",
      });

      expect(prefill).toBe(expected);
      expect(input).toHaveValue(expected);
      expect(apply).toBeEnabled();
      fireEvent.click(apply);
      expect(onApply).toHaveBeenCalledWith({
        columnIndex: 0,
        operator: "equals",
        values: [expected],
      });
    },
  );
});

function renderNumberEditor(
  field: SchemaField = {
    name: "amount",
    physicalType: "DOUBLE",
    logicalType: null,
    children: [],
  },
) {
  const onApply = vi.fn();
  render(
    <FilterEditor
      request={{ sourceIndex: 0, left: 0, top: 0 }}
      field={field}
      onApply={onApply}
      onCancel={vi.fn()}
    />,
  );
  return {
    editor: screen.getByRole("form", { name: `Filter ${field.name}` }),
    onApply,
  };
}

function renderTemporalEditor(
  field: ReturnType<typeof temporalField>,
  initialValue?: string,
) {
  const onApply = vi.fn();
  render(
    <FilterEditor
      request={{ sourceIndex: 0, left: 0, top: 0, initialValue }}
      field={field}
      onApply={onApply}
      onCancel={vi.fn()}
    />,
  );
  return {
    editor: screen.getByRole("form", { name: `Filter ${field.name}` }),
    onApply,
  };
}

function temporalField(
  name: string,
  physicalType: string,
  logicalType: string | null,
) {
  return { name, physicalType, logicalType, children: [] };
}
