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
    members: [],
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

it("allows retrying the same member after its selection fails", async () => {
  const select = vi
    .spyOn(desktop, "selectDatasetStructureMember")
    .mockRejectedValueOnce(new Error("failed"))
    .mockResolvedValue({ relativePath: "part-1.parquet", partitions: [] });
  const onSelected = vi.fn();
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary()}
      active
      onSelected={onSelected}
    />,
  );
  const onSelectRow = latestMemberGrid().onSelectRow;

  act(() => onSelectRow(1));
  expect(
    await screen.findByText("This dataset member could not be selected."),
  ).toBeInTheDocument();
  act(() => latestMemberGrid().onSelectRow(1));

  await waitFor(() => expect(select).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(onSelected).toHaveBeenCalledTimes(1));
  expect(
    screen.queryByText("This dataset member could not be selected."),
  ).not.toBeInTheDocument();
});

it("reports parquet and ignored file counts with stable pluralization", () => {
  const view = render(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary(1, 1)}
      active={false}
      onSelected={() => {}}
    />,
  );
  expect(
    screen.getByText("1 parquet file · 1 other file ignored"),
  ).toBeVisible();

  view.rerender(
    <DatasetStructureNavigator
      generation={7}
      ready={readySummary(96, 14)}
      active={false}
      onSelected={() => {}}
    />,
  );
  expect(
    screen.getByText("96 parquet files · 14 other files ignored"),
  ).toBeVisible();
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
  vi.spyOn(desktop, "selectDatasetStructureMember").mockResolvedValue({
    relativePath: "part-1.parquet",
    partitions: [],
  });
  const onSelected = vi.fn();
  const ready = readySummary();
  ready.partitionColumnIndices = [0, 1, 2];
  render(
    <DatasetStructureNavigator
      generation={7}
      ready={ready}
      active
      onSelected={onSelected}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: /year=2026/ }));
  fireEvent.click(await screen.findByRole("button", { name: /month=08/ }));
  expect(await screen.findByText("day=21")).toBeVisible();
  expect(
    screen.getByRole("list", {
      name: "Partition values under year=2026 / month=08",
    }),
  ).toHaveAttribute("tabindex", "0");
  expect(partitions).toHaveBeenCalledTimes(3);

  act(() => latestMemberGrid().onSelectRow(1));
  await waitFor(() => expect(onSelected).toHaveBeenCalledTimes(1));
  expect(screen.getByText("day=21")).toBeVisible();
  expect(partitions).toHaveBeenCalledTimes(3);
});

function latestMemberGrid(): { onSelectRow: (row: number) => void } {
  const call = structureGridProps.mock.calls.findLast(
    ([props]) => props.label === "Dataset members",
  );
  if (call === undefined)
    throw new Error("Dataset member grid was not rendered");
  return call[0] as { onSelectRow: (row: number) => void };
}

function readySummary(
  memberCount = 96,
  ignoredFileCount = 14,
): desktop.DatasetReadySummary {
  return {
    displayName: "dataset/",
    memberCount,
    ignoredFileCount,
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
