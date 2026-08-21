import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { ChunkPanel } from "./ChunkPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("ignores a probe result after selecting another column", async () => {
  vi.spyOn(desktop, "getStructureChunk").mockImplementation(
    async (_generation, rowGroupIndex, columnIndex) =>
      chunk(rowGroupIndex, columnIndex),
  );
  const stale = deferred<desktop.StructureBloomProbe>();
  vi.spyOn(desktop, "probeStructureBloomFilter").mockReturnValue(stale.promise);
  vi.spyOn(desktop, "cancelStructureBloomProbe").mockResolvedValue();

  const view = render(
    <ChunkPanel
      generation={4}
      selected={{ rowGroupIndex: 0, columnIndex: 1 }}
      onClose={() => {}}
    />,
  );
  await screen.findByText("column-1");
  expect(
    screen.getByRole("complementary", { name: "Column chunk details" }),
  ).toHaveFocus();
  fireEvent.change(screen.getByRole("textbox", { name: "Probe value" }), {
    target: { value: "old" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Probe" }));

  view.rerender(
    <ChunkPanel
      generation={4}
      selected={{ rowGroupIndex: 0, columnIndex: 2 }}
      onClose={() => {}}
    />,
  );
  await screen.findByText("column-2");
  stale.resolve({
    columnIndex: 1,
    offset: 0,
    totalCount: 1,
    rowGroups: [{ index: 7, outcome: "definitelyAbsent" }],
  });

  await waitFor(() => {
    expect(screen.queryByText(/Row group 7:/)).not.toBeInTheDocument();
  });
  expect(screen.getByRole("textbox", { name: "Probe value" })).toHaveValue("");
});

it("invalidates an in-flight probe when its input changes", async () => {
  vi.spyOn(desktop, "getStructureChunk").mockResolvedValue(chunk(0, 1));
  const stale = deferred<desktop.StructureBloomProbe>();
  vi.spyOn(desktop, "probeStructureBloomFilter").mockReturnValue(stale.promise);
  const cancel = vi
    .spyOn(desktop, "cancelStructureBloomProbe")
    .mockResolvedValue();

  render(
    <ChunkPanel
      generation={4}
      selected={{ rowGroupIndex: 0, columnIndex: 1 }}
      onClose={() => {}}
    />,
  );
  const input = await screen.findByRole("textbox", { name: "Probe value" });
  fireEvent.change(input, { target: { value: "old" } });
  fireEvent.click(screen.getByRole("button", { name: "Probe" }));
  fireEvent.change(input, { target: { value: "new" } });
  stale.resolve({
    columnIndex: 1,
    offset: 0,
    totalCount: 1,
    rowGroups: [{ index: 9, outcome: "definitelyAbsent" }],
  });

  await waitFor(() => expect(cancel).toHaveBeenCalledWith(4));
  expect(screen.queryByText(/Row group 9:/)).not.toBeInTheDocument();
  expect(input).toHaveValue("new");
});

function chunk(
  rowGroupIndex: number,
  columnIndex: number,
): desktop.StructureChunkDetails {
  return {
    rowGroupIndex,
    columnIndex,
    columnName: `column-${columnIndex}`,
    physicalType: "BYTE_ARRAY",
    codec: "zstd",
    encodings: ["PLAIN"],
    valueCount: 1,
    compressedBytes: 10,
    uncompressedBytes: 20,
    compressionRatio: 2,
    dataPageOffset: 4,
    dictionaryPageOffset: null,
    bloomFilterBytes: 32,
    hasBloomFilter: true,
    columnHasBloomFilter: true,
    hasPageIndex: false,
    hasOffsetIndex: false,
    statistics: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
