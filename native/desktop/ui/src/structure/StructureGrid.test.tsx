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

it("copies only exact held rows from a 100k-row column selection", () => {
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
});
