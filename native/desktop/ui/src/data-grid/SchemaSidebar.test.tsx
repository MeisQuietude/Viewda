import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  int32,
  field,
  list,
  map,
  struct,
  utf8,
  type DataType,
} from "@uwdata/flechette";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { _projectLogicalSchema, SchemaSidebar } from "./SchemaSidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function source(): desktop.SourceSummary {
  return {
    generation: 7,
    displayName: "nested.parquet",
    sizeBytes: 1,
    rowCount: 1,
    rowGroupCount: 1,
    columnCount: 3,
    schema: [
      {
        name: "duplicate",
        physicalType: "BYTE_ARRAY",
        logicalType: "String",
        children: [],
      },
      {
        name: "duplicate",
        physicalType: "GROUP",
        logicalType: null,
        children: [
          {
            name: "physical_child",
            physicalType: "INT32",
            logicalType: null,
            children: [],
          },
        ],
      },
      {
        name: "unloaded",
        physicalType: "GROUP",
        logicalType: null,
        children: [],
      },
    ],
    schemaNodeCount: 4,
    schemaIsTruncated: true,
    stringsTruncated: false,
  };
}

function readyStatistics() {
  vi.spyOn(desktop, "getColumnStatistics").mockResolvedValue({
    minimum: null,
    maximum: null,
    minMaxComputed: true,
    nullShare: 0,
    approximateDistinctCount: 1,
  });
  vi.spyOn(desktop, "cancelColumnStatistics").mockResolvedValue();
}

describe("SchemaSidebar logical schema", () => {
  it("uses physical schema until an accepted Arrow window supplies a type", () => {
    readyStatistics();
    render(
      <SchemaSidebar
        open
        selectedColumn={null}
        source={source()}
        onSelectColumn={vi.fn()}
      />,
    );

    expect(screen.getByText("BYTE_ARRAY · String")).toBeInTheDocument();
    expect(screen.getAllByText("GROUP")).toHaveLength(2);
    expect(screen.getByText("physical_child")).toBeInTheDocument();
    expect(screen.queryByText(/struct</)).not.toBeInTheDocument();
    expect(screen.getByText(/Schema is incomplete/)).toBeInTheDocument();
  });

  it("shows Flechette logical types while hiding list and map wrapper rows", () => {
    readyStatistics();
    render(
      <SchemaSidebar
        open
        selectedColumn={null}
        source={source()}
        dataTypes={
          new Map<number, DataType>([
            [0, struct({ address: struct({ city: utf8() }) })],
            [1, list(struct({ item_id: int32(), label: utf8() }))],
            [2, map(utf8(), int32())],
          ])
        }
        onSelectColumn={vi.fn()}
      />,
    );

    expect(screen.getByText("address")).toBeInTheDocument();
    expect(screen.getByText("city")).toBeInTheDocument();
    expect(screen.getByText("item_id")).toBeInTheDocument();
    expect(screen.getByText("label")).toBeInTheDocument();
    expect(screen.getByText("key")).toBeInTheDocument();
    expect(screen.getByText("value")).toBeInTheDocument();
    expect(screen.queryByText("item")).not.toBeInTheDocument();
    expect(screen.queryByText("entries")).not.toBeInTheDocument();
    expect(screen.queryByText("physical_child")).not.toBeInTheDocument();
    expect(screen.getByTitle("map<string, int32>")).toBeInTheDocument();
    expect(screen.queryByText(/Schema is incomplete/)).not.toBeInTheDocument();
  });

  it("maps duplicate top-level names to their exact source indices", () => {
    readyStatistics();
    const onSelectColumn = vi.fn();
    render(
      <SchemaSidebar
        open
        selectedColumn={null}
        source={source()}
        dataTypes={new Map([[1, list(struct({ child: utf8() }))]])}
        onSelectColumn={onSelectColumn}
      />,
    );

    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    const duplicateButtons = within(sidebar)
      .getAllByRole("button")
      .filter((button) => button.textContent?.startsWith("duplicate"));
    fireEvent.click(duplicateButtons[1]!);

    expect(onSelectColumn).toHaveBeenCalledWith(1);
    expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 1, true);
    expect(screen.getByText("child").closest("button")).toBeNull();
  });

  it("bounds wide and deeply wrapped logical schema projections", () => {
    const wide = struct(
      Array.from({ length: 10_000 }, (_unused, index) =>
        field(`field_${index}`, int32()),
      ),
    );
    const wideProjection = _projectLogicalSchema("wide", wide);
    expect(wideProjection.rows.length).toBeLessThanOrEqual(2_049);
    expect(wideProjection.rows.at(-1)).toMatchObject({ name: "…" });

    let deep: DataType = int32();
    for (let index = 0; index < 10_000; index += 1) {
      deep = list(struct([field(`level_${index}`, deep)]));
    }
    expect(() => _projectLogicalSchema("deep", deep)).not.toThrow();
    const deepProjection = _projectLogicalSchema("deep", deep);
    expect(deepProjection.rows.length).toBeLessThanOrEqual(66);
    expect(deepProjection.rows.at(-1)).toMatchObject({ name: "…" });
  });

  it("bounds untrusted field names without splitting code points", () => {
    const projection = _projectLogicalSchema(
      `${"x".repeat(1_000_000)}🙂tail`,
      struct([field(`${"y".repeat(1_000_000)}🙂tail`, int32())]),
    );

    expect(projection.name.length).toBeLessThanOrEqual(161);
    expect(projection.rows[0]?.name.length).toBeLessThanOrEqual(161);
    expect(projection.name).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(projection.rows[0]?.name).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
