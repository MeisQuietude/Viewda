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
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import type { SchemaField } from "../desktop";
import { FilterEditor } from "./filter-controls";
import { filterInputFromCell } from "./filter-query";

beforeEach(() => {
  vi.spyOn(desktop, "getTextValueSuggestions").mockResolvedValue(
    suggestionResult([]),
  );
  vi.spyOn(desktop, "cancelTextValueSuggestions").mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
        sourceGeneration={7}
        nextSuggestionRevision={revisionCounter()}
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
        sourceGeneration={7}
        nextSuggestionRevision={revisionCounter()}
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
  it("offers every text operator and applies Match case to substring operators", () => {
    const onApply = vi.fn();
    renderTextEditor(onApply);
    const editor = screen.getByRole("form", { name: "Filter label" });
    const condition = within(editor).getByRole("combobox", {
      name: "Condition",
    });

    expect(
      Array.from(
        condition.querySelectorAll("option"),
        (option) => option.value,
      ),
    ).toEqual([
      "equals",
      "notEquals",
      "oneOf",
      "textContains",
      "notContains",
      "startsWith",
      "endsWith",
      "isNull",
      "isNotNull",
    ]);

    for (const operator of [
      "textContains",
      "notContains",
      "startsWith",
      "endsWith",
    ]) {
      fireEvent.change(condition, { target: { value: operator } });
      expect(
        within(editor).getByRole("button", { name: "Match case" }),
      ).toBeInTheDocument();
    }

    fireEvent.change(condition, { target: { value: "startsWith" } });
    fireEvent.change(within(editor).getByLabelText("Value"), {
      target: { value: "View" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Match case" }));
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );

    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "startsWith",
      values: ["View"],
      matchCase: true,
    });
  });

  it("disables host text correction and explains Match case", () => {
    renderTextEditor(vi.fn());
    const editor = screen.getByRole("form", { name: "Filter label" });
    const input = within(editor).getByLabelText("Value");

    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");

    fireEvent.change(
      within(editor).getByRole("combobox", { name: "Condition" }),
      { target: { value: "textContains" } },
    );
    const toggle = within(editor).getByRole("button", { name: "Match case" });
    const tooltip = within(toggle).getByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "Match case: match uppercase and lowercase exactly",
    );
    expect(toggle).not.toHaveAttribute("title");
    expect(toggle).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("requires intent before applying an empty text equality condition", () => {
    const onApply = vi.fn();
    renderTextEditor(onApply);
    const editor = screen.getByRole("form", { name: "Filter label" });
    const input = within(editor).getByLabelText("Value");
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    expect(apply).toBeDisabled();
    fireEvent.submit(editor);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "value" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "equals",
      values: [""],
    });
  });

  it("applies an empty text value prefilled from a cell", () => {
    const onApply = vi.fn();
    renderTextEditor(onApply, "");
    const editor = screen.getByRole("form", { name: "Filter label" });
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "equals",
      values: [""],
    });
  });

  it("loads suggestions for an empty value and reports progress", async () => {
    vi.useFakeTimers();
    const request = deferred<desktop.TextValueSuggestions>();
    vi.mocked(desktop.getTextValueSuggestions).mockReturnValue(request.promise);
    renderTextEditor(vi.fn());
    const editor = screen.getByRole("form", { name: "Filter label" });
    const input = within(editor).getByLabelText("Value");

    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(within(editor).getByRole("status")).toHaveTextContent(
      "Loading suggestions…",
    );
    expect(
      within(editor).getByRole("progressbar", {
        name: "Loading suggestions",
      }),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-busy", "true");
    await act(async () => vi.advanceTimersByTime(150));
    expect(desktop.getTextValueSuggestions).toHaveBeenCalledWith(
      7,
      1,
      0,
      "",
      "equals",
    );

    await act(async () => request.resolve(suggestionResult(["Alpha", "Beta"])));
    expect(
      within(editor).queryByRole("progressbar", {
        name: "Loading suggestions",
      }),
    ).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-busy", "false");
    expect(suggestionValues()).toEqual(["Alpha", "Beta"]);
    expect(screen.getByRole("listbox").querySelector("mark")).toBeNull();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(
      within(editor).getByRole("button", { name: "Add condition" }),
    ).toBeDisabled();
  });

  it.each([false, true])(
    "keeps a finished empty result visible without the obsolete row bound",
    async (isPartial) => {
      vi.useFakeTimers();
      vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
        suggestionResult([], isPartial),
      );
      renderTextEditor(vi.fn());
      const input = screen.getByLabelText("Value");

      fireEvent.focus(input);
      await act(async () => vi.advanceTimersByTime(150));

      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("status")).toHaveTextContent(
        "No matching values",
      );
      expect(screen.getByRole("status")).not.toHaveTextContent("rows");
      expect(screen.getByRole("listbox")).toBeEmptyDOMElement();
    },
  );

  it("shows a non-interactive limit note only for a truncated result", async () => {
    vi.useFakeTimers();
    const values = Array.from({ length: 20 }, (_, index) => `value-${index}`);
    vi.mocked(desktop.getTextValueSuggestions)
      .mockResolvedValueOnce(suggestionResult(values, true))
      .mockResolvedValueOnce(suggestionResult(["one", "two", "three"]));
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.focus(input);
    await act(async () => vi.advanceTimersByTime(150));

    const listbox = screen.getByRole("listbox");
    const limit = screen.getByRole("status");
    expect(limit).toHaveTextContent("Showing the first 20 matches");
    expect(within(listbox).queryByText(limit.textContent ?? "")).toBeNull();
    expect(
      [...listbox.children].every(
        (child) => child.getAttribute("role") === "option",
      ),
    ).toBe(true);

    fireEvent.change(input, { target: { value: "three" } });
    await act(async () => vi.advanceTimersByTime(150));

    expect(suggestionValues()).toEqual(["three"]);
    expect(screen.queryByText("Showing the first 20 matches")).toBeNull();
  });

  it("does not navigate or apply the empty suggestion row", async () => {
    vi.useFakeTimers();
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult([]),
    );
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.focus(input);
    await act(async () => vi.advanceTimersByTime(150));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
    expect(
      within(screen.getByRole("listbox")).queryByRole("option"),
    ).not.toBeInTheDocument();
  });

  it("debounces suggestions and ignores a stale response", async () => {
    vi.useFakeTimers();
    const first = deferred<desktop.TextValueSuggestions>();
    const second = deferred<desktop.TextValueSuggestions>();
    vi.mocked(desktop.getTextValueSuggestions)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "a" } });
    expect(desktop.getTextValueSuggestions).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(150));
    expect(desktop.getTextValueSuggestions).toHaveBeenCalledWith(
      7,
      1,
      0,
      "a",
      "equals",
    );

    fireEvent.change(input, { target: { value: "al" } });
    expect(desktop.cancelTextValueSuggestions).toHaveBeenCalledWith(7, 1);
    await act(async () => vi.advanceTimersByTime(150));
    expect(desktop.getTextValueSuggestions).toHaveBeenLastCalledWith(
      7,
      2,
      0,
      "al",
      "equals",
    );

    await act(async () =>
      second.resolve(suggestionResult(["Alpha", "Alpine"])),
    );
    expect(suggestionValues()).toEqual(["Alpha", "Alpine"]);
    await act(async () => first.resolve(suggestionResult(["stale"])));
    expect(suggestionValues()).toEqual(["Alpha", "Alpine"]);
  });

  it("keeps loaded suggestions while a narrower request is pending", async () => {
    vi.useFakeTimers();
    const next = deferred<desktop.TextValueSuggestions>();
    vi.mocked(desktop.getTextValueSuggestions)
      .mockResolvedValueOnce(suggestionResult(["Alpha", "Aster"]))
      .mockReturnValueOnce(next.promise);
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "a" } });
    await act(async () => vi.advanceTimersByTime(150));
    expect(suggestionValues()).toEqual(["Alpha", "Aster"]);

    fireEvent.change(input, { target: { value: "al" } });
    expect(suggestionValues()).toEqual(["Alpha"]);
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(within(listbox).queryByRole("status")).not.toBeInTheDocument();
    expect(
      [...listbox.children].every(
        (child) => child.getAttribute("role") === "option",
      ),
    ).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading suggestions…",
    );
    await act(async () => vi.advanceTimersByTime(150));
    expect(suggestionValues()).toEqual(["Alpha"]);

    await act(async () => next.resolve(suggestionResult(["Alpha", "Alpine"])));
    expect(suggestionValues()).toEqual(["Alpha", "Alpine"]);
  });

  it.each([
    ["equals", "ph", ["Alpha"]],
    ["notEquals", "ph", ["Alpha"]],
    ["textContains", "ph", ["Alpha"]],
    ["notContains", "ph", ["Alpha"]],
    ["startsWith", "ph", []],
    ["startsWith", "al", ["Alpha"]],
    ["endsWith", "ph", []],
    ["endsWith", "ta", ["Beta"]],
  ] as const)(
    "filters pending %s suggestions with the current input",
    async (operator, value, expected) => {
      vi.useFakeTimers();
      vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
        suggestionResult(["Alpha", "Aster", "Beta"]),
      );
      renderTextEditor(vi.fn());
      const condition = screen.getByRole("combobox", { name: "Condition" });
      const input = screen.getByLabelText("Value");

      fireEvent.change(condition, { target: { value: operator } });
      fireEvent.change(input, { target: { value } });
      await act(async () => vi.advanceTimersByTime(150));

      expect(suggestionValues()).toEqual(expected);
      expect(desktop.getTextValueSuggestions).toHaveBeenCalledWith(
        7,
        1,
        0,
        value,
        operator,
      );
    },
  );

  it("highlights every case-insensitive match without changing the accessible name", async () => {
    vi.useFakeTimers();
    const suggestion = "Alpha alpha ALPHA";
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult([suggestion]),
    );
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "aLpHa" } });
    await act(async () => vi.advanceTimersByTime(150));

    const option = screen.getByRole("option", { name: suggestion });
    expect(
      [...option.querySelectorAll("mark")].map((mark) => mark.textContent),
    ).toEqual(["Alpha", "alpha", "ALPHA"]);
    expect(option).toHaveTextContent(suggestion);
  });

  it("highlights non-ASCII matches when lowercasing preserves offsets", async () => {
    vi.useFakeTimers();
    const suggestion = "Été ÉTÉ";
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult([suggestion]),
    );
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "été" } });
    await act(async () => vi.advanceTimersByTime(150));

    expect(
      [
        ...screen
          .getByRole("option", { name: suggestion })
          .querySelectorAll("mark"),
      ].map((mark) => mark.textContent),
    ).toEqual(["Été", "ÉTÉ"]);
  });

  it("does not highlight values whose lowercase form changes length", async () => {
    vi.useFakeTimers();
    const suggestion = "İstanbul";
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult([suggestion]),
    );
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "i" } });
    await act(async () => vi.advanceTimersByTime(150));

    expect(
      screen.getByRole("option", { name: suggestion }).querySelector("mark"),
    ).toBeNull();
  });

  it("shifts a long suggestion so a match near the end is visible", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "option" ? 120 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "option" ? 600 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const left = this.tagName === "MARK" ? 340 : 40;
        const width = this.tagName === "MARK" ? 60 : 120;
        return {
          bottom: 20,
          height: 20,
          left,
          right: left + width,
          top: 0,
          width,
          x: left,
          y: 0,
          toJSON: () => ({}),
        };
      },
    );
    const suggestion = `${"long-value-".repeat(30)}tail-match`;
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult([suggestion]),
    );
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "tail-match" } });
    await act(async () => vi.advanceTimersByTime(150));

    const option = screen.getByRole("option", { name: suggestion });
    expect(option.querySelector("mark")).toHaveTextContent("tail-match");
    expect(option.scrollLeft).toBe(270);
    expect(option).toHaveAttribute("data-overflow-start");
    expect(option).toHaveAttribute("data-overflow-end");
    expect(option.textContent).toBe(suggestion);
  });

  it("keeps the suggestion list open while typing and supports keyboard selection", async () => {
    vi.useFakeTimers();
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult(["Alpha", "Aster"]),
    );
    renderTextEditor(vi.fn());
    const input = screen.getByLabelText("Value");

    fireEvent.change(input, { target: { value: "a" } });
    await act(async () => vi.advanceTimersByTime(150));
    expect(input).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(input, { target: { value: "al" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(suggestionValues()).toEqual(["Alpha"]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Alpha");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("closes an open suggestion popup before cancelling the editor", async () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    vi.mocked(desktop.getTextValueSuggestions).mockResolvedValue(
      suggestionResult(["Alpha"]),
    );
    renderTextEditor(vi.fn(), undefined, onCancel);
    const input = screen.getByLabelText("Value");

    input.focus();
    fireEvent.change(input, { target: { value: "a" } });
    await act(async () => vi.advanceTimersByTime(150));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.getByRole("form", { name: "Filter label" }),
    ).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("a");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps single-Escape cancellation for non-text editors", () => {
    const number = renderNumberEditor();
    fireEvent.keyDown(within(number.editor).getByLabelText("Value"), {
      key: "Escape",
    });
    expect(number.onCancel).toHaveBeenCalledTimes(1);

    cleanup();
    const temporal = renderTemporalEditor(
      temporalField("day", "INT32", "Date"),
    );
    fireEvent.keyDown(within(temporal.editor).getByLabelText("Value"), {
      key: "Escape",
    });
    expect(temporal.onCancel).toHaveBeenCalledTimes(1);
  });
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
  const onCancel = vi.fn();
  render(
    <FilterEditor
      request={{ sourceIndex: 0, left: 0, top: 0 }}
      field={field}
      sourceGeneration={7}
      nextSuggestionRevision={revisionCounter()}
      onApply={onApply}
      onCancel={onCancel}
    />,
  );
  return {
    editor: screen.getByRole("form", { name: `Filter ${field.name}` }),
    onApply,
    onCancel,
  };
}

function renderTemporalEditor(
  field: ReturnType<typeof temporalField>,
  initialValue?: string,
) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <FilterEditor
      request={{ sourceIndex: 0, left: 0, top: 0, initialValue }}
      field={field}
      sourceGeneration={7}
      nextSuggestionRevision={revisionCounter()}
      onApply={onApply}
      onCancel={onCancel}
    />,
  );
  return {
    editor: screen.getByRole("form", { name: `Filter ${field.name}` }),
    onApply,
    onCancel,
  };
}

function renderTextEditor(
  onApply: (filter: desktop.DataFilter) => void,
  initialValue?: string,
  onCancel = vi.fn(),
) {
  render(
    <FilterEditor
      request={{ sourceIndex: 0, left: 0, top: 0, initialValue }}
      field={{
        name: "label",
        physicalType: "BYTE_ARRAY",
        logicalType: "String",
        children: [],
      }}
      sourceGeneration={7}
      nextSuggestionRevision={revisionCounter()}
      onApply={onApply}
      onCancel={onCancel}
    />,
  );
}

function temporalField(
  name: string,
  physicalType: string,
  logicalType: string | null,
) {
  return { name, physicalType, logicalType, children: [] };
}

function suggestionValues(): string[] {
  return screen
    .queryAllByRole("option")
    .filter((option) => option.closest("[role=listbox]") !== null)
    .map((option) => option.textContent ?? "");
}

function suggestionResult(
  values: string[],
  isPartial = false,
): desktop.TextValueSuggestions {
  return { values, isPartial };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function revisionCounter(): () => number {
  let revision = 0;
  return () => {
    revision += 1;
    return revision;
  };
}
