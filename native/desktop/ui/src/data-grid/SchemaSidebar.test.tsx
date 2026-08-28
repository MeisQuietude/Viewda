import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
        name: "nested",
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
    nullCount: 0,
    nullShare: 0,
    approximateDistinctCount: 1,
    containerCount: null,
  });
  vi.spyOn(desktop, "cancelColumnStatistics").mockResolvedValue();
}

describe("SchemaSidebar logical schema", () => {
  it("uses physical schema until an accepted Arrow window supplies a type", () => {
    readyStatistics();
    render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        onSelectPath={vi.fn()}
        onFlattenPath={vi.fn()}
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
        selectedPath={null}
        source={source()}
        dataTypes={
          new Map<string, DataType>([
            ['["duplicate"]', struct({ address: struct({ city: utf8() }) })],
            ['["nested"]', list(struct({ item_id: int32(), label: utf8() }))],
            ['["unloaded"]', map(utf8(), int32())],
          ])
        }
        onSelectPath={vi.fn()}
        onFlattenPath={vi.fn()}
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
    expect(
      screen.getAllByText(
        "Fields inside a list or map cannot be used as columns.",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("item_id").closest("button")).toHaveAttribute(
      "title",
      "Fields inside a list or map cannot be used as columns.",
    );
    expect(screen.queryByText(/Schema is incomplete/)).not.toBeInTheDocument();
  });

  it("selects a top-level field by its structured path", () => {
    readyStatistics();
    const onSelectPath = vi.fn();
    render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        dataTypes={new Map([['["nested"]', list(struct({ child: utf8() }))]])}
        onSelectPath={onSelectPath}
        onFlattenPath={vi.fn()}
      />,
    );

    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    const nestedButton = within(sidebar)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith("nested"));
    fireEvent.click(nestedButton!);

    expect(onSelectPath).toHaveBeenCalledWith(["nested"]);
    expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
      7,
      ["nested"],
      false,
    );
    expect(screen.getByText("child").closest("button")).toBeDisabled();
  });

  it("addresses struct descendants for statistics and schema flattening", () => {
    readyStatistics();
    const onSelectPath = vi.fn();
    const onFlattenPath = vi.fn();
    render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        onSelectPath={onSelectPath}
        onFlattenPath={onFlattenPath}
      />,
    );

    fireEvent.click(screen.getByText("physical_child").closest("button")!);
    expect(onSelectPath).toHaveBeenCalledWith(["duplicate", "physical_child"]);
    expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
      7,
      ["duplicate", "physical_child"],
      true,
    );
    fireEvent.contextMenu(screen.getByText("duplicate").closest("button")!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Flatten duplicate" }),
    );
    expect(onFlattenPath).toHaveBeenCalledWith(["duplicate"]);
  });

  it("disables ambiguous nested path actions without hiding the parent struct", () => {
    readyStatistics();
    const onSelectPath = vi.fn();
    const onFlattenPath = vi.fn();
    const duplicateChildren: desktop.SourceSummary = {
      ...source(),
      schema: [
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "city",
              physicalType: "BYTE_ARRAY",
              logicalType: "String",
              children: [],
            },
            {
              name: "city",
              physicalType: "BYTE_ARRAY",
              logicalType: "String",
              children: [],
            },
          ],
        },
      ],
      schemaNodeCount: 3,
      schemaIsTruncated: false,
    };
    const view = render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={duplicateChildren}
        onSelectPath={onSelectPath}
        onFlattenPath={onFlattenPath}
      />,
    );

    const parent = screen.getByText("profile").closest("li")!;
    fireEvent.click(within(parent).getByText("profile").closest("button")!);
    expect(onSelectPath).toHaveBeenCalledWith(["profile"]);
    expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
      7,
      ["profile"],
      true,
    );

    fireEvent.contextMenu(
      within(parent).getByText("profile").closest("button")!,
    );
    const flatten = screen.getByRole("menuitem", {
      name: "Flatten profile. Flatten is unavailable because this struct contains duplicate child names.",
    });
    expect(flatten).toBeDisabled();
    expect(flatten).toHaveAccessibleName(
      "Flatten profile. Flatten is unavailable because this struct contains duplicate child names.",
    );
    expect(flatten).toHaveTextContent(
      "Flatten profileFlatten is unavailable because this struct contains duplicate child names.",
    );
    const ambiguousFields = within(parent)
      .getAllByText("city")
      .map((name) => name.closest("button"));
    expect(ambiguousFields).toHaveLength(2);
    ambiguousFields.forEach((button) => {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute(
        "title",
        "This field cannot be selected because its parent contains multiple fields named city.",
      );
    });
    expect(onFlattenPath).not.toHaveBeenCalled();

    view.rerender(
      <SchemaSidebar
        open
        selectedPath={null}
        source={duplicateChildren}
        dataTypes={
          new Map([
            [
              '["profile"]',
              struct([field("city", utf8()), field("city", utf8())]),
            ],
          ])
        }
        onSelectPath={onSelectPath}
        onFlattenPath={onFlattenPath}
      />,
    );
    fireEvent.contextMenu(
      screen
        .getByText("profile", { selector: ".schema-name" })
        .closest("button")!,
    );
    expect(
      screen.getByRole("menuitem", {
        name: "Flatten profile. Flatten is unavailable because this struct contains duplicate child names.",
      }),
    ).toBeDisabled();
  });

  it("does not offer an executable flatten action without loaded child fields", () => {
    const emptyStruct: desktop.SourceSummary = {
      ...source(),
      schema: [
        {
          name: "empty",
          physicalType: "GROUP",
          logicalType: null,
          children: [],
        },
      ],
      schemaNodeCount: 1,
      schemaIsTruncated: false,
    };
    render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={emptyStruct}
        dataTypes={new Map([['["empty"]', struct({ runtime_child: utf8() })]])}
        onSelectPath={vi.fn()}
        onFlattenPath={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("empty").closest("button")!);
    const flatten = screen.getByRole("menuitem", {
      name: "Flatten empty. Flatten is unavailable because this struct has no child fields.",
    });
    expect(flatten).toBeDisabled();
    expect(flatten).toHaveAccessibleName(
      "Flatten empty. Flatten is unavailable because this struct has no child fields.",
    );
    expect(flatten).toHaveTextContent(
      "Flatten emptyFlatten is unavailable because this struct has no child fields.",
    );
  });

  it("includes the duplicate-source reason in physical and logical Flatten controls", () => {
    readyStatistics();
    const view = render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        pathActionsEnabled={false}
        onSelectPath={vi.fn()}
        onFlattenPath={vi.fn()}
      />,
    );

    const accessibleName =
      "Flatten duplicate. Unavailable because this source has duplicate column names.";
    fireEvent.contextMenu(screen.getByText("duplicate").closest("button")!);
    const physicalFlatten = screen.getByRole("menuitem", {
      name: accessibleName,
    });
    expect(physicalFlatten).toBeDisabled();
    expect(physicalFlatten).toHaveTextContent(
      "Flatten duplicateUnavailable because this source has duplicate column names.",
    );

    view.rerender(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        dataTypes={
          new Map([['["duplicate"]', struct({ physical_child: int32() })]])
        }
        pathActionsEnabled={false}
        onSelectPath={vi.fn()}
        onFlattenPath={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText("duplicate").closest("button")!);
    const logicalFlatten = screen.getByRole("menuitem", {
      name: "Flatten duplicate. Unavailable because this source has duplicate column names.",
    });
    expect(logicalFlatten).toBeDisabled();
    expect(logicalFlatten).toHaveAccessibleName(accessibleName);
    expect(logicalFlatten).toHaveTextContent(
      "Flatten duplicateUnavailable because this source has duplicate column names.",
    );
  });

  it("opens one keyboard-focusable action to toggle Flatten and Unflatten", () => {
    readyStatistics();
    const onFlattenPath = vi.fn();
    const onUnflattenPath = vi.fn();
    const view = render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        onSelectPath={vi.fn()}
        onFlattenPath={onFlattenPath}
        onUnflattenPath={onUnflattenPath}
      />,
    );

    const field = screen.getByText("duplicate").closest("button")!;
    field.focus();
    fireEvent.keyDown(field, { key: "F10", shiftKey: true });
    const flatten = screen.getByRole("menuitem", {
      name: "Flatten duplicate",
    });
    expect(document.activeElement).toBe(flatten);
    fireEvent.click(flatten);
    expect(onFlattenPath).toHaveBeenCalledWith(["duplicate"]);
    expect(field).toHaveFocus();

    view.rerender(
      <SchemaSidebar
        open
        selectedPath={null}
        source={source()}
        flattenedPathKeys={new Set(['["duplicate"]'])}
        onSelectPath={vi.fn()}
        onFlattenPath={onFlattenPath}
        onUnflattenPath={onUnflattenPath}
      />,
    );
    const flattenedField = screen.getByText("duplicate").closest("button")!;
    fireEvent.keyDown(flattenedField, { key: "ContextMenu" });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Unflatten duplicate" }),
    );
    expect(onUnflattenPath).toHaveBeenCalledWith(["duplicate"]);
    expect(flattenedField).toHaveFocus();
  });

  it("labels list lengths and map pair counts without offering scalar min and max", async () => {
    const nestedContainers: desktop.SourceSummary = {
      ...source(),
      schema: [
        {
          name: "tags",
          physicalType: "GROUP",
          logicalType: "List",
          children: [],
        },
        {
          name: "attributes",
          physicalType: "GROUP",
          logicalType: "Map",
          children: [],
        },
      ],
    };
    vi.spyOn(desktop, "getColumnStatistics").mockImplementation(
      async (_generation, fieldPath) => ({
        minimum: null,
        maximum: null,
        minMaxComputed: false,
        nullCount: 1,
        nullShare: 0.25,
        approximateDistinctCount: null,
        containerCount:
          fieldPath[0] === "tags"
            ? { minimum: 0, average: 1.5, maximum: 3, emptyCount: 2 }
            : { minimum: 0, average: 2, maximum: 4, emptyCount: 1 },
      }),
    );
    vi.spyOn(desktop, "cancelColumnStatistics").mockResolvedValue();
    render(
      <SchemaSidebar
        open
        selectedPath={null}
        source={nestedContainers}
        onSelectPath={vi.fn()}
        onFlattenPath={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("tags").closest("button")!);
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenLastCalledWith(
        7,
        ["tags"],
        false,
      ),
    );
    expect(screen.getByText("Minimum length")).toBeInTheDocument();
    expect(screen.getByText("Average length")).toBeInTheDocument();
    expect(screen.getByText("Maximum length")).toBeInTheDocument();
    expect(screen.getByText("Empty lists")).toBeInTheDocument();
    expect(screen.queryByText("Distinct")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Compute min/max" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("attributes").closest("button")!);
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenLastCalledWith(
        7,
        ["attributes"],
        false,
      ),
    );
    expect(screen.getByText("Minimum pair count")).toBeInTheDocument();
    expect(screen.getByText("Average pair count")).toBeInTheDocument();
    expect(screen.getByText("Maximum pair count")).toBeInTheDocument();
    expect(screen.getByText("Empty maps")).toBeInTheDocument();
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
