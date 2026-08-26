import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import {
  PARTITION_WORKING_PAGE_BUDGET,
  trimPartitionTreeCache,
} from "./DatasetPartitionTree";
import { DatasetStructureNavigator } from "./DatasetViews";

const structureGridProps = vi.hoisted(() => vi.fn());

vi.mock("../structure/StructureGrid", () => ({
  StructureGrid: (props: { label: string }) => {
    structureGridProps(props);
    return <section aria-label={props.label} />;
  },
}));

beforeEach(() => {
  structureGridProps.mockClear();
  vi.restoreAllMocks();
  vi.spyOn(desktop, "getDatasetMembers").mockResolvedValue({
    offset: 0,
    total: 96,
    members: [member(0, "part-000.parquet")],
  });
  vi.spyOn(desktop, "getDatasetSchemaDriftMembers").mockResolvedValue({
    offset: 0,
    total: 0,
    members: [],
  });
  vi.spyOn(desktop, "getDatasetPartitions").mockResolvedValue({
    nodes: [],
    nextAfter: null,
  });
});

afterEach(cleanup);

it("keeps the committed file visible until the next file is selected", async () => {
  const selected = deferred<desktop.DatasetMemberSummary>();
  vi.spyOn(desktop, "selectDatasetStructureMember").mockReturnValue(
    selected.promise,
  );
  const onSelected = vi.fn();
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary()}
      active
      onSelected={onSelected}
    />,
  );

  expect(await screen.findByText("part-000.parquet")).toHaveAttribute(
    "title",
    "part-000.parquet",
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(screen.getByText("part-000.parquet")).toBeVisible();
  expect(screen.getByText(/1 of 96/)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading file 2 for Structure…",
  );
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(onSelected).not.toHaveBeenCalled();

  await act(async () => selected.resolve(member(1, "part-001.parquet")));

  expect(screen.getByText("part-001.parquet")).toHaveAttribute(
    "title",
    "part-001.parquet",
  );
  expect(screen.getByText(/2 of 96/)).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(onSelected).toHaveBeenCalledTimes(1);
});

it("keeps the previous file and allows retry after selection fails", async () => {
  const select = vi
    .spyOn(desktop, "selectDatasetStructureMember")
    .mockRejectedValueOnce(new Error("failed"))
    .mockResolvedValue(member(1, "part-001.parquet"));
  const onSelected = vi.fn();
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary()}
      active
      onSelected={onSelected}
    />,
  );
  await screen.findByText("part-000.parquet");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(
    await screen.findByText(/The previous file remains selected/),
  ).toBeVisible();
  expect(screen.getByText("part-000.parquet")).toBeVisible();
  expect(onSelected).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(select).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(onSelected).toHaveBeenCalledTimes(1));
  expect(screen.getByText("part-001.parquet")).toBeVisible();
  expect(
    screen.queryByText(/The previous file remains selected/),
  ).not.toBeInTheDocument();
});

it("states the scope of the selected file and exposes a long path in full", async () => {
  const path = "year=2026/month=08/a-very-long-member-name.parquet";
  vi.mocked(desktop.getDatasetMembers).mockResolvedValue({
    offset: 0,
    total: 96,
    members: [member(0, path)],
  });
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary()}
      active
      onSelected={() => {}}
    />,
  );

  expect(await screen.findByText(path)).toHaveAttribute("title", path);
  expect(
    screen.getByText(
      "Structure shows this file. Data shows the entire dataset.",
    ),
  ).toBeVisible();
});

it("uses a schema-drift member's global ordinal for the shared selector", async () => {
  vi.mocked(desktop.getDatasetSchemaDriftMembers).mockResolvedValue({
    offset: 0,
    total: 1,
    members: [member(42, "part-042.parquet")],
  });
  const select = vi
    .spyOn(desktop, "selectDatasetStructureMember")
    .mockResolvedValue(member(42, "part-042.parquet"));
  const ready = readySummary();
  ready.schemaDriftMemberCount = 1;
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  fireEvent.click(screen.getByText("Members with schema differences"));
  act(() => latestGrid("Schema drift members").onViewportChange(0, 1));
  await waitFor(() =>
    expect(desktop.getDatasetSchemaDriftMembers).toHaveBeenCalledWith(
      7,
      0,
      256,
    ),
  );
  act(() => latestGrid("Schema drift members").onActivateRow?.(0));

  await waitFor(() => expect(select).toHaveBeenCalledWith(7, 42));
});

it("keeps member navigation open until activation and returns focus to its summary", async () => {
  vi.mocked(desktop.getDatasetMembers).mockResolvedValue({
    offset: 0,
    total: 96,
    members: [member(0, "part-000.parquet"), member(1, "part-001.parquet")],
  });
  const select = vi
    .spyOn(desktop, "selectDatasetStructureMember")
    .mockResolvedValue(member(1, "part-001.parquet"));
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary()}
      active
      onSelected={() => {}}
    />,
  );

  const label = await screen.findByText("Dataset file");
  const summary = label.closest("summary");
  const details = label.closest("details");
  if (summary === null || details === null) {
    throw new Error("member selector was not rendered");
  }
  fireEvent.click(summary);
  await waitFor(() =>
    expect(
      structureGridProps.mock.calls.some(
        ([props]) => props.label === "Dataset members",
      ),
    ).toBe(true),
  );
  act(() => latestGrid("Dataset members").onViewportChange(0, 2));
  await waitFor(() =>
    expect(desktop.getDatasetMembers).toHaveBeenCalledWith(7, 0, 256),
  );

  const memberGrid = latestGrid("Dataset members");
  expect(memberGrid.onSelectRow).toBeUndefined();
  expect(details).toHaveAttribute("open");
  const renderedGrid = screen.getByLabelText("Dataset members");
  renderedGrid.tabIndex = -1;
  renderedGrid.focus();

  act(() => memberGrid.onActivateRow?.(1));

  expect(select).toHaveBeenCalledWith(7, 1);
  expect(details).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
});

it("appends partition pages when the loaded boundary becomes visible", async () => {
  const firstCursor = { key: "year", value: "2025" };
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, _parent, after) =>
      after === null
        ? {
            nodes: [{ partition: firstCursor, memberCount: 2 }],
            nextAfter: firstCursor,
          }
        : {
            nodes: [
              {
                partition: { key: "year", value: "2026" },
                memberCount: 3,
              },
            ],
            nextAfter: null,
          },
    );
  const ready = readySummary();
  ready.partitionColumnIndices = [0];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  expect(await screen.findByText("year=2025")).toBeVisible();
  expect(await screen.findByText("year=2026")).toBeVisible();
  expect(partitions).toHaveBeenNthCalledWith(1, 7, [], null, 256);
  expect(partitions).toHaveBeenNthCalledWith(2, 7, [], firstCursor, 256);
  expect(screen.queryByText("Next partitions")).not.toBeInTheDocument();
  expect(
    screen.getByRole("tree", { name: "Dataset partition values" }),
  ).toHaveStyle({ height: "68px" });
  const items = screen.getAllByRole("treeitem");
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveAttribute("tabindex", "0");
  expect(items[0]).toHaveAttribute("aria-posinset", "1");
  expect(items[0]).toHaveAttribute("aria-setsize", "2");
  expect(items[0]).toHaveAccessibleName("year=2025 · 2 files");
  expect(items[1]).toHaveAccessibleName("year=2026 · 3 files");
  expect(items[1]).toHaveAttribute("tabindex", "-1");
});

it("keeps sibling partition branches expanded", async () => {
  const year2025 = { key: "year", value: "2025" };
  const year2026 = { key: "year", value: "2026" };
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, parent) => {
      if (parent.length === 0) {
        return {
          nodes: [
            { partition: year2025, memberCount: 2 },
            { partition: year2026, memberCount: 3 },
          ],
          nextAfter: null,
        };
      }
      return {
        nodes: [
          {
            partition: {
              key: "month",
              value: parent[0]!.value === "2025" ? "01" : "02",
            },
            memberCount: 1,
          },
        ],
        nextAfter: null,
      };
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const firstYear = await screen.findByRole("treeitem", {
    name: /year=2025/,
  });
  const secondYear = screen.getByRole("treeitem", { name: /year=2026/ });
  fireEvent.click(firstYear);
  fireEvent.click(secondYear);

  expect(await screen.findByText("month=01")).toBeVisible();
  expect(await screen.findByText("month=02")).toBeVisible();
  expect(firstYear).toHaveAttribute("aria-expanded", "true");
  expect(secondYear).toHaveAttribute("aria-expanded", "true");
  expect(partitions).toHaveBeenCalledWith(7, [year2025], null, 256);
  expect(partitions).toHaveBeenCalledWith(7, [year2026], null, 256);
});

it("supports tree keyboard navigation and keeps focus while children load", async () => {
  const year2025 = { key: "year", value: "2025" };
  const year2026 = { key: "year", value: "2026" };
  const children = deferred<desktop.DatasetPartitionPage>();
  const secondChildren = deferred<desktop.DatasetPartitionPage>();
  vi.spyOn(desktop, "getDatasetPartitions").mockImplementation(
    (_generation, parent) => {
      if (parent.length === 0) {
        return Promise.resolve({
          nodes: [
            { partition: year2025, memberCount: 2 },
            { partition: year2026, memberCount: 3 },
          ],
          nextAfter: null,
        });
      }
      if (parent[0]!.value === "2025") return children.promise;
      return secondChildren.promise;
    },
  );
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const firstYear = await screen.findByRole("treeitem", {
    name: /year=2025/,
  });
  const secondYear = screen.getByRole("treeitem", { name: /year=2026/ });
  act(() => firstYear.focus());
  fireEvent.keyDown(firstYear, { key: "ArrowDown" });
  await waitFor(() => expect(secondYear).toHaveFocus());
  fireEvent.keyDown(secondYear, { key: "Home" });
  await waitFor(() => expect(firstYear).toHaveFocus());

  fireEvent.keyDown(firstYear, { key: "ArrowRight" });
  expect(firstYear).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Loading partitions");
  await act(async () =>
    children.resolve({
      nodes: [
        {
          partition: { key: "month", value: "01" },
          memberCount: 1,
        },
      ],
      nextAfter: null,
    }),
  );
  const month = await screen.findByRole("treeitem", { name: /month=01/ });
  expect(month).toHaveAccessibleName("month=01 · 1 file");
  expect(firstYear).toHaveFocus();

  fireEvent.keyDown(firstYear, { key: "ArrowRight" });
  await waitFor(() => expect(month).toHaveFocus());
  fireEvent.keyDown(month, { key: "ArrowLeft" });
  await waitFor(() => expect(firstYear).toHaveFocus());
  fireEvent.keyDown(firstYear, { key: "ArrowLeft" });
  expect(firstYear).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("month=01")).not.toBeInTheDocument();
  fireEvent.keyDown(firstYear, { key: "End" });
  await waitFor(() => expect(secondYear).toHaveFocus());
  fireEvent.keyDown(secondYear, { key: " " });
  expect(secondYear).toHaveAttribute("aria-expanded", "true");
});

it("focuses the final partition after a terminal cursor page finishes loading", async () => {
  const finalPage = deferred<desktop.DatasetPartitionPage>();
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation((_generation, _parent, after) => {
      if (after !== null) return finalPage.promise;
      return Promise.resolve({
        nodes: bucketNodes(0, 256),
        nextAfter: { key: "bucket", value: "255" },
      });
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  await screen.findByRole("tree", {
    name: "Dataset partition values",
  });
  const first = await screen.findByRole("treeitem", {
    name: "bucket=0 · 1 file",
  });
  expect(partitions).toHaveBeenCalledTimes(1);
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  await waitFor(() => expect(partitions).toHaveBeenCalledTimes(2));

  await act(async () =>
    finalPage.resolve({
      nodes: bucketNodes(256, 4),
      nextAfter: null,
    }),
  );
  const finalItem = await screen.findByRole("treeitem", {
    name: "bucket=259 · 1 file",
  });
  await waitFor(() => expect(finalItem).toHaveFocus());
  expect(partitions).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(17);
});

it("keeps a newer keyboard focus while an End page request finishes", async () => {
  const finalPage = deferred<desktop.DatasetPartitionPage>();
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation((_generation, _parent, after) => {
      if (after !== null) return finalPage.promise;
      return Promise.resolve({
        nodes: bucketNodes(0, 2),
        nextAfter: { key: "bucket", value: "1" },
      });
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const first = await screen.findByRole("treeitem", {
    name: "bucket=0 · 1 file",
  });
  const second = screen.getByRole("treeitem", {
    name: "bucket=1 · 1 file",
  });
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  await waitFor(() => expect(partitions).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(first, { key: "ArrowDown" });
  await waitFor(() => expect(second).toHaveFocus());

  await act(async () =>
    finalPage.resolve({
      nodes: bucketNodes(2, 1),
      nextAfter: null,
    }),
  );
  await screen.findByRole("treeitem", { name: "bucket=2 · 1 file" });
  expect(second).toHaveFocus();
});

it("applies a pending child page after collapse and immediate re-expand", async () => {
  const firstChildren = deferred<desktop.DatasetPartitionPage>();
  const secondChildren = deferred<desktop.DatasetPartitionPage>();
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation((_generation, parent) => {
      if (parent.length === 0) {
        return Promise.resolve({
          nodes: [
            {
              partition: { key: "year", value: "2025" },
              memberCount: 1,
            },
            {
              partition: { key: "year", value: "2026" },
              memberCount: 1,
            },
          ],
          nextAfter: null,
        });
      }
      return parent[0]?.value === "2025"
        ? firstChildren.promise
        : secondChildren.promise;
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const first = await screen.findByRole("treeitem", {
    name: "year=2025 · 1 file",
  });
  fireEvent.click(first);
  fireEvent.click(first);
  fireEvent.click(first);
  expect(
    partitions.mock.calls.filter(([, parent]) => parent[0]?.value === "2025"),
  ).toHaveLength(1);
  await act(async () =>
    firstChildren.resolve({
      nodes: [
        {
          partition: { key: "month", value: "01" },
          memberCount: 1,
        },
      ],
      nextAfter: null,
    }),
  );
  expect(
    await screen.findByRole("treeitem", { name: "month=01 · 1 file" }),
  ).toBeVisible();

  const second = screen.getByRole("treeitem", {
    name: "year=2026 · 1 file",
  });
  fireEvent.click(second);
  fireEvent.click(second);
  await act(async () =>
    secondChildren.resolve({
      nodes: [
        {
          partition: { key: "month", value: "02" },
          memberCount: 1,
        },
      ],
      nextAfter: null,
    }),
  );
  expect(screen.queryByText("month=02")).not.toBeInTheDocument();
  expect(first).toHaveAttribute("aria-expanded", "true");
  expect(second).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByRole("treeitem")).toHaveLength(3);
});

it("bounds cached and rendered partitions while revisiting a 100,000-value level", async () => {
  const total = 100_000;
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, _parent, after, limit) => {
      const start = after === null ? 0 : Number(after.value) + 1;
      const end = Math.min(start + limit, total);
      return {
        nodes: Array.from({ length: end - start }, (_, index) => ({
          partition: { key: "id", value: String(start + index) },
          memberCount: 1,
        })),
        nextAfter: end < total ? { key: "id", value: String(end - 1) } : null,
      };
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const tree = await screen.findByRole("tree", {
    name: "Dataset partition values",
  });
  const first = (await screen.findAllByRole("treeitem"))[0]!;
  expect(first).toHaveTextContent("id=0");
  act(() => first.focus());
  expect(partitions).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(16);

  for (
    let pageIndex = 1;
    pageIndex <= PARTITION_WORKING_PAGE_BUDGET + 2;
    pageIndex += 1
  ) {
    fireEvent.scroll(tree, {
      target: { scrollTop: pageIndex * 256 * 34 - 320 },
    });
    const firstValue = pageIndex * 256;
    const item = await screen.findByRole("treeitem", {
      name: `id=${firstValue} · 1 file`,
    });
    act(() => item.focus());
    expect(partitions).toHaveBeenCalledWith(
      7,
      [],
      { key: "id", value: String(firstValue - 1) },
      256,
    );
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(17);
  }

  expect(first).toHaveAttribute("aria-setsize", "-1");
  expect(partitions).toHaveBeenCalledTimes(PARTITION_WORKING_PAGE_BUDGET + 3);
  const focusedBeforeReturn = screen.getByRole("treeitem", {
    name: `id=${(PARTITION_WORKING_PAGE_BUDGET + 2) * 256} · 1 file`,
  });
  expect(focusedBeforeReturn).toHaveFocus();

  fireEvent.scroll(tree, { target: { scrollTop: 0 } });
  await screen.findByRole("treeitem", { name: "id=0 · 1 file" });
  expect(
    partitions.mock.calls.filter(([, , after]) => after === null),
  ).toHaveLength(2);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(17);
  expect(focusedBeforeReturn).toHaveFocus();

  const restoredFirst = screen.getByRole("treeitem", {
    name: "id=0 · 1 file",
  });
  act(() => restoredFirst.focus());
  fireEvent.scroll(tree, { target: { scrollTop: 256 * 34 } });
  await screen.findByRole("treeitem", { name: "id=256 · 1 file" });
  expect(
    partitions.mock.calls.filter(
      ([, , after]) => after?.key === "id" && after.value === "255",
    ),
  ).toHaveLength(2);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(17);
});

it("releases collapsed branches in a 100,000-value partition tree", async () => {
  const branchCount = 12;
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, parent) => ({
      nodes: Array.from(
        { length: parent.length === 0 ? 256 : 32 },
        (_, index) => ({
          partition: {
            key: parent.length === 0 ? "id" : "leaf",
            value: String(index),
          },
          memberCount: 1,
        }),
      ),
      nextAfter: parent.length === 0 ? { key: "id", value: "255" } : null,
    }));
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  for (let index = 0; index < branchCount; index += 1) {
    const branch = await screen.findByRole("treeitem", {
      name: `id=${index} · 1 file`,
    });
    fireEvent.click(branch);
    await waitFor(() =>
      expect(
        partitions.mock.calls.filter(
          ([, parent]) => parent[0]?.value === String(index),
        ),
      ).toHaveLength(1),
    );
    fireEvent.click(branch);
    expect(branch).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(16);
  }

  fireEvent.click(screen.getByRole("treeitem", { name: "id=0 · 1 file" }));
  await waitFor(() =>
    expect(
      partitions.mock.calls.filter(([, parent]) => parent[0]?.value === "0"),
    ).toHaveLength(2),
  );
});

it("keeps visible expanded branches loaded within bounded viewport overhead", async () => {
  const branchCount = 8;
  vi.spyOn(desktop, "getDatasetPartitions").mockImplementation(
    async (_generation, parent) => ({
      nodes:
        parent.length === 0
          ? Array.from({ length: branchCount }, (_, index) => ({
              partition: { key: "id", value: String(index) },
              memberCount: 1,
            }))
          : [
              {
                partition: {
                  key: "leaf",
                  value: `child-${parent[0]!.value}`,
                },
                memberCount: 1,
              },
            ],
      nextAfter: null,
    }),
  );
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  await screen.findByRole("tree", { name: "Dataset partition values" });
  for (let index = 0; index < branchCount; index += 1) {
    const branch = screen.getByRole("treeitem", {
      name: `id=${index} · 1 file`,
    });
    fireEvent.click(branch);
    await screen.findByRole("treeitem", {
      name: `leaf=child-${index} · 1 file`,
    });
  }

  expect(
    screen.queryByText("Loading partition values…"),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(16);
  for (let index = 0; index < branchCount; index += 1) {
    expect(
      screen.getByRole("treeitem", { name: `id=${index} · 1 file` }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("treeitem", {
        name: `leaf=child-${index} · 1 file`,
      }),
    ).toBeVisible();
  }
});

it("explains when the bounded cache collapses an offscreen branch", async () => {
  vi.spyOn(desktop, "getDatasetPartitions").mockImplementation(
    async (_generation, parent) => ({
      nodes:
        parent.length === 0
          ? Array.from({ length: 12 }, (_, index) => ({
              partition: { key: "id", value: String(index) },
              memberCount: 1,
            }))
          : [
              {
                partition: { key: "leaf", value: parent[0]!.value },
                memberCount: 1,
              },
            ],
      nextAfter: null,
    }),
  );
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const tree = await screen.findByRole("tree", {
    name: "Dataset partition values",
  });
  for (let index = 0; index < 5; index += 1) {
    fireEvent.click(
      screen.getByRole("treeitem", { name: `id=${index} · 1 file` }),
    );
    await screen.findByRole("treeitem", { name: `leaf=${index} · 1 file` });
  }

  fireEvent.scroll(tree, { target: { scrollTop: 10 * 34 } });
  const later = await screen.findByRole("treeitem", { name: "id=10 · 1 file" });
  fireEvent.click(later);
  await screen.findByRole("treeitem", { name: "leaf=10 · 1 file" });

  expect(
    screen.getByText(
      "Older expanded branches were collapsed to keep partition browsing responsive.",
    ),
  ).toBeVisible();
});

it("bounds retained levels after thousands of expanded sibling branches", () => {
  type CacheLevels = Parameters<typeof trimPartitionTreeCache>[0];
  const rootId = JSON.stringify([]);
  const branchPath = (index: number): desktop.PartitionValue[] => [
    { key: "id", value: String(index) },
  ];
  const branchId = (index: number) =>
    JSON.stringify(branchPath(index).map(({ key, value }) => [key, value]));
  const cachePage = (
    nodes: desktop.DatasetPartitionNode[],
    touched: number,
  ) => ({
    after: null,
    nextAfter: null,
    count: nodes.length,
    nodes,
    pending: false,
    failed: false,
    touched,
  });
  const branchCount = 2_000;
  const focused = branchPath(branchCount - 1);
  const levels: CacheLevels = new Map([
    [
      rootId,
      {
        parent: [],
        pages: [
          cachePage(
            [
              {
                partition: focused[0]!,
                memberCount: 1,
              },
            ],
            0,
          ),
        ],
      },
    ],
  ]);
  const expanded = new Set<string>();
  for (let index = 0; index < branchCount; index += 1) {
    const parent = branchPath(index);
    const id = branchId(index);
    levels.set(id, {
      parent,
      pages: [
        cachePage(
          [
            {
              partition: { key: "leaf", value: String(index) },
              memberCount: 1,
            },
          ],
          index + 1,
        ),
      ],
    });
    expanded.add(id);
  }

  const trimmed = trimPartitionTreeCache(levels, expanded, focused, 2);
  const residentPages = [...trimmed.levels.values()].flatMap((level) =>
    level.pages.filter(({ nodes }) => nodes !== null),
  );
  const residentNodes = residentPages.reduce(
    (count, page) => count + page.nodes!.length,
    0,
  );

  expect(trimmed.levels.size).toBe(6);
  expect(trimmed.expanded.size).toBe(5);
  expect(residentPages).toHaveLength(5);
  expect(residentNodes).toBeLessThanOrEqual(5 * 256);
  expect(trimmed.levels.has(rootId)).toBe(true);
  expect(trimmed.levels.has(branchId(branchCount - 1))).toBe(true);
  expect(trimmed.levels.has(branchId(0))).toBe(false);
  expect(trimmed.levels.get(branchId(branchCount - 5))?.pages[0]).toMatchObject(
    {
      after: null,
      nextAfter: null,
      count: 1,
      nodes: null,
    },
  );
});

it("shows a failed partition page and retries it", async () => {
  const year = { key: "year", value: "2026" };
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, parent) => {
      if (parent.length === 0) {
        return {
          nodes: [{ partition: year, memberCount: 3 }],
          nextAfter: null,
        };
      }
      if (
        partitions.mock.calls.filter(([, path]) => path.length === 1).length ===
        1
      ) {
        throw new Error("failed");
      }
      return {
        nodes: [
          {
            partition: { key: "month", value: "08" },
            memberCount: 3,
          },
        ],
        nextAfter: null,
      };
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("treeitem", { name: /year=2026/ }));
  expect(
    await screen.findByText("This partition page could not be loaded."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByText("month=08")).toBeVisible();
  expect(
    screen.queryByText("This partition page could not be loaded."),
  ).not.toBeInTheDocument();
});

it("bounds failed partition branches across the whole tree", async () => {
  const branchCount = 12;
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, parent) => {
      if (parent.length === 0) {
        return {
          nodes: Array.from({ length: branchCount }, (_, index) => ({
            partition: { key: "id", value: String(index) },
            memberCount: 1,
          })),
          nextAfter: null,
        };
      }
      throw new Error("failed");
    });
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  await screen.findByRole("tree", { name: "Dataset partition values" });
  for (let index = 0; index < branchCount; index += 1) {
    fireEvent.click(
      screen.getByRole("treeitem", { name: `id=${index} · 1 file` }),
    );
    await waitFor(() =>
      expect(
        partitions.mock.calls.filter(
          ([, parent]) => parent[0]?.value === String(index),
        ),
      ).toHaveLength(1),
    );
  }

  const retainedLevelLimit =
    1 + ready.partitionColumnIndices.length + PARTITION_WORKING_PAGE_BUDGET;
  expect(screen.getAllByRole("alert").length).toBeLessThanOrEqual(
    retainedLevelLimit - 1,
  );
  expect(
    screen.getByRole("treeitem", { name: "id=0 · 1 file" }),
  ).toHaveAttribute("tabindex", "0");

  fireEvent.click(screen.getAllByRole("button", { name: "Retry" }).at(-1)!);
  await waitFor(() =>
    expect(
      partitions.mock.calls.filter(
        ([, parent]) => parent[0]?.value === String(branchCount - 1),
      ),
    ).toHaveLength(2),
  );
  expect(screen.getAllByRole("alert").length).toBeLessThanOrEqual(
    retainedLevelLimit - 1,
  );
});

it("stops showing disclosure after a partition has no child values", async () => {
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, parent) => ({
      nodes:
        parent.length === 0
          ? [
              {
                partition: { key: "year", value: "2026" },
                memberCount: 1,
              },
            ]
          : [],
      nextAfter: null,
    }));
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  const year = await screen.findByRole("treeitem", {
    name: "year=2026 · 1 file",
  });
  fireEvent.click(year);
  await waitFor(() => expect(year).not.toHaveAttribute("aria-expanded"));
  expect(partitions).toHaveBeenCalledTimes(2);

  fireEvent.click(year);
  expect(partitions).toHaveBeenCalledTimes(2);
});

it("drops stale partition levels when the dataset generation changes", async () => {
  const staleChildren = deferred<desktop.DatasetPartitionPage>();
  vi.spyOn(desktop, "getDatasetPartitions").mockImplementation(
    async (generation, parent) => {
      if (generation === 7 && parent.length > 0) {
        return staleChildren.promise;
      }
      return {
        nodes: [
          {
            partition: {
              key: "year",
              value: generation === 7 ? "old" : "new",
            },
            memberCount: 1,
          },
        ],
        nextAfter: null,
      };
    },
  );
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1];
  const view = render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  fireEvent.click(
    await screen.findByRole("treeitem", { name: "year=old · 1 file" }),
  );
  await waitFor(() =>
    expect(desktop.getDatasetPartitions).toHaveBeenCalledWith(
      7,
      [{ key: "year", value: "old" }],
      null,
      256,
    ),
  );
  view.rerender(
    <DatasetStructureNavigator
      generation={8}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );
  await screen.findByRole("tree", { name: "Dataset partition values" });
  expect(
    await screen.findByRole("treeitem", { name: "year=new · 1 file" }),
  ).toBeVisible();

  await act(async () =>
    staleChildren.resolve({
      nodes: [
        {
          partition: { key: "month", value: "stale" },
          memberCount: 1,
        },
      ],
      nextAfter: null,
    }),
  );
  expect(screen.queryByText("month=stale")).not.toBeInTheDocument();
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
});

it("keeps a deep partition branch expanded across a member switch", async () => {
  const year = { key: "year", value: "2026" };
  const month = { key: "month", value: "08" };
  const day = { key: "day", value: "21" };
  const partitions = vi
    .spyOn(desktop, "getDatasetPartitions")
    .mockImplementation(async (_generation, parent) => ({
      nodes: [
        {
          partition:
            parent.length === 0 ? year : parent.length === 1 ? month : day,
          memberCount: 2,
        },
      ],
      nextAfter: null,
    }));
  vi.spyOn(desktop, "selectDatasetStructureMember").mockResolvedValue(
    member(1, "part-001.parquet"),
  );
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1, 2];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("treeitem", { name: /year=2026/ }));
  fireEvent.click(await screen.findByRole("treeitem", { name: /month=08/ }));
  expect(await screen.findByText("day=21")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("part-001.parquet");

  expect(screen.getByText("day=21")).toBeVisible();
  expect(partitions).toHaveBeenCalledTimes(3);
});

function latestGrid(label: string): {
  onSelectRow?: (row: number) => void;
  onActivateRow?: (row: number) => void;
  onViewportChange: (rowStart: number, rowCount: number) => void;
} {
  const call = structureGridProps.mock.calls.findLast(
    ([props]) => props.label === label,
  );
  if (call === undefined) throw new Error(`${label} grid was not rendered`);
  return call[0] as {
    onSelectRow?: (row: number) => void;
    onActivateRow?: (row: number) => void;
    onViewportChange: (rowStart: number, rowCount: number) => void;
  };
}

function member(
  ordinal: number,
  relativePath: string,
): desktop.DatasetMemberSummary {
  return { ordinal, relativePath, partitions: [] };
}

function bucketNodes(
  start: number,
  count: number,
): desktop.DatasetPartitionNode[] {
  return Array.from({ length: count }, (_, index) => ({
    partition: { key: "bucket", value: String(start + index) },
    memberCount: 1,
  }));
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function readySummary(): desktop.DatasetReadySummary {
  return {
    displayName: "dataset/",
    memberCount: 96,
    ignoredFileCount: 14,
    sizeBytes: 100,
    rowCount: 10,
    rowGroupCount: 2,
    columnCount: 2,
    schema: [],
    schemaNodeCount: 0,
    schemaIsTruncated: false,
    stringsTruncated: false,
    schemaDriftMemberCount: 0,
    partitionColumnIndices: [],
    provenanceColumnIndex: 1,
  };
}
