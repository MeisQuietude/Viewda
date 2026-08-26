import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { CompactSelection } from "../data-grid/grid-model";
import type { ViewdaGridProps } from "../data-grid/ViewdaGrid";
import { StructureGrid, type StructureGridColumn } from "./StructureGrid";

const grid = vi.hoisted(() => ({
  props: undefined as ViewdaGridProps | undefined,
}));

vi.mock("../data-grid/ViewdaGrid", async () => {
  const React = await import("react");
  return {
    ViewdaGrid: React.forwardRef((_props: ViewdaGridProps) => {
      grid.props = _props;
      return <div data-testid="grid" />;
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  grid.props = undefined;
});

const columns: readonly StructureGridColumn[] = [
  {
    id: "name",
    title: "Column",
    width: 120,
    alignment: "left",
    monospace: false,
    sortable: true,
  },
  {
    id: "bytes",
    title: "Bytes",
    width: 100,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
];

it.each([
  [0, "44px"],
  [1, "72px"],
  [5, "184px"],
  [100, "320px"],
])("clamps a %i-row table to its useful height", (rowCount, height) => {
  const { container } = render(
    <StructureGrid
      label="Sized table"
      columns={columns}
      rowCount={rowCount}
      sortColumnId="name"
      sortDirection="ascending"
      contentRevision={1}
      heldPage={{ offset: 0, length: rowCount }}
      getCell={() => null}
      onSort={() => {}}
      onViewportChange={() => {}}
    />,
  );

  expect(container.querySelector(".structure-grid")).toHaveStyle({
    "--structure-grid-height": height,
  });
});

it("copies only exact held rows from a 100k-row column selection", () => {
  vi.useFakeTimers();
  const getCell = vi.fn((row: number, columnId: string) =>
    row < 80 ? { text: `${columnId}-${row}`, faded: false } : null,
  );
  render(
    <StructureGrid
      label="Columns"
      columns={columns}
      rowCount={100_000}
      sortColumnId="name"
      sortDirection="ascending"
      contentRevision={1}
      heldPage={{ offset: 0, length: 80 }}
      getCell={getCell}
      onSort={() => {}}
      onViewportChange={() => {}}
    />,
  );
  act(() => {
    grid.props?.onSelectionChange({
      columns: CompactSelection.fromSingleSelection([0, 1]),
      rows: CompactSelection.empty(),
    });
  });
  const copied = new Map<string, string>();
  const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (type: string, value: string) => copied.set(type, value),
    },
  });

  act(() => grid.props?.onCopy(event));

  const text = copied.get("text/plain") ?? "";
  expect(text.split("\n")).toHaveLength(80);
  expect(text.split("\n")[0]).toBe("name-0");
  expect(text.split("\n")[79]).toBe("name-79");
  expect(text).not.toContain("loading");
  expect(getCell).toHaveBeenCalledTimes(80);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Copied 80 loaded rows. 99,920 selected rows were not copied.",
  );
  expect(screen.getByRole("status").parentElement).toHaveClass(
    "structure-grid-shell",
  );
  expect(screen.getByTestId("grid").parentElement).toHaveClass(
    "structure-grid",
  );

  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("reports selection and activation independently with the table label", () => {
  const onSelectRow = vi.fn();
  const onActivateRow = vi.fn();
  render(
    <StructureGrid
      label="Members"
      columns={columns}
      rowCount={100_000}
      sortColumnId="name"
      sortDirection="ascending"
      contentRevision={1}
      heldPage={{ offset: 400, length: 200 }}
      getCell={() => ({ text: "member", faded: false })}
      onSort={() => {}}
      onViewportChange={() => {}}
      onSelectRow={onSelectRow}
      onActivateRow={onActivateRow}
    />,
  );

  act(() => {
    grid.props?.onSelectionChange({
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { row: 450, column: 0 },
        range: { x: 0, y: 450, width: 1, height: 1 },
        rangeStack: [],
      },
    });
  });

  expect(onSelectRow).toHaveBeenCalledWith(450);
  expect(onActivateRow).not.toHaveBeenCalled();
  expect(grid.props?.label).toBe("Members");

  act(() => grid.props?.onCellActivate?.({ row: 451, column: 0 }));

  expect(onActivateRow).toHaveBeenCalledWith(451);
});
