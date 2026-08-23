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
    offset: 0,
    totalCount: 1,
    rowGroups: [{ index: 9, outcome: "definitelyAbsent" }],
  });

  await waitFor(() =>
    expect(cancel).toHaveBeenCalledWith(4, expect.any(String)),
  );
  expect(desktop.probeStructureBloomFilter).toHaveBeenCalledWith(
    4,
    expect.any(String),
    1,
    "old",
    0,
    256,
  );
  expect(screen.queryByText(/Row group 9:/)).not.toBeInTheDocument();
  expect(input).toHaveValue("new");
});

it("describes the column-wide empty Bloom state", async () => {
  vi.spyOn(desktop, "getStructureChunk").mockResolvedValue({
    ...chunk(0, 1),
    hasBloomFilter: false,
    columnHasBloomFilter: false,
    bloomFilterBytes: null,
  });

  render(
    <ChunkPanel
      generation={4}
      selected={{ rowGroupIndex: 0, columnIndex: 1 }}
      onClose={() => {}}
    />,
  );

  expect(
    await screen.findByText(
      "No row group records a Bloom filter for this column.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Probe value" })).toBeNull();
});

it.each([
  ["invalidProbeValue", "The value could not be probed for this column type."],
  [
    "unsupportedProbeColumn",
    "Bloom filters cannot be probed for this column type.",
  ],
  [
    "sourceChanged",
    "The open file changed. Reopen it to inspect its structure.",
  ],
  ["corruptFooter", "The Parquet footer is damaged or incomplete."],
  ["unsupported", "The file structure could not be read."],
] as const)(
  "maps the %s Bloom probe error truthfully",
  async (code, message) => {
    vi.spyOn(desktop, "getStructureChunk").mockResolvedValue(chunk(0, 1));
    vi.spyOn(desktop, "probeStructureBloomFilter").mockRejectedValue(
      new desktop.StructureCommandError(code),
    );
    vi.spyOn(desktop, "cancelStructureBloomProbe").mockResolvedValue();

    render(
      <ChunkPanel
        generation={4}
        selected={{ rowGroupIndex: 0, columnIndex: 1 }}
        onClose={() => {}}
      />,
    );
    const input = await screen.findByRole("textbox", { name: "Probe value" });
    fireEvent.change(input, { target: { value: "17" } });
    fireEvent.click(screen.getByRole("button", { name: "Probe" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  },
);

it("rejects an oversized UTF-8 probe before invoking native code", async () => {
  vi.spyOn(desktop, "getStructureChunk").mockResolvedValue(chunk(0, 1));
  const probe = vi.spyOn(desktop, "probeStructureBloomFilter");

  render(
    <ChunkPanel
      generation={4}
      selected={{ rowGroupIndex: 0, columnIndex: 1 }}
      onClose={() => {}}
    />,
  );
  const input = await screen.findByRole("textbox", { name: "Probe value" });
  fireEvent.change(input, { target: { value: "界".repeat(1_366) } });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Probe values are limited to 4,096 UTF-8 bytes.",
  );
  expect(screen.getByRole("button", { name: "Probe" })).toBeDisabled();
  expect(probe).not.toHaveBeenCalled();
});

function chunk(
  _rowGroupIndex: number,
  columnIndex: number,
): desktop.StructureChunkDetails {
  return {
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
