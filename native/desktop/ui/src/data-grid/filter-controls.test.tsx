import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SchemaField } from "../desktop";
import { FilterEditor } from "./filter-controls";

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

  it("trims temporal values and explains whitespace-only input", () => {
    const onApply = vi.fn();
    render(
      <FilterEditor
        request={{ sourceIndex: 0, left: 0, top: 0 }}
        field={{
          name: "recorded_at",
          physicalType: "INT64",
          logicalType: "Timestamp (microseconds, UTC)",
          children: [],
        }}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    const editor = screen.getByRole("form", { name: "Filter recorded_at" });
    const input = within(editor).getByRole("textbox", { name: "Value" });
    const apply = within(editor).getByRole("button", {
      name: "Add condition",
    });

    fireEvent.change(input, { target: { value: "   " } });
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Enter a date or time value.",
    );
    expect(apply).toBeDisabled();

    fireEvent.change(input, {
      target: { value: " 2026-08-01T06:07:08Z " },
    });
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      columnIndex: 0,
      operator: "equals",
      values: ["2026-08-01T06:07:08Z"],
    });
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
