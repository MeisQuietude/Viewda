import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DatasetReadySummary,
  SourceSummary,
  StructureSummary,
} from "../desktop";
import {
  StructureCard,
  StructureLoadStatus,
  StructureUnitToggle,
} from "./StructureCard";

afterEach(cleanup);

const source: SourceSummary = {
  generation: 1,
  displayName: "orders.parquet",
  sizeBytes: 1_300_000,
  rowCount: 1_200,
  rowGroupCount: 12,
  columnCount: 2,
  schema: [
    { name: "id", physicalType: "INT64", logicalType: null, children: [] },
    {
      name: "city",
      physicalType: "BYTE_ARRAY",
      logicalType: "String",
      children: [],
    },
  ],
  schemaNodeCount: 2,
  schemaIsTruncated: false,
  stringsTruncated: false,
};

const dataset: DatasetReadySummary = {
  displayName: "orders/",
  memberCount: 96,
  ignoredFileCount: 14,
  sizeBytes: 9_000_000,
  rowCount: 80_000,
  rowGroupCount: 800,
  columnCount: 4,
  schema: source.schema,
  schemaNodeCount: 2,
  schemaIsTruncated: false,
  stringsTruncated: false,
  schemaDriftMemberCount: 3,
  partitionColumnIndices: [],
  provenanceColumnIndex: 4,
};

function summaryOf(
  overrides: Partial<StructureSummary> = {},
): StructureSummary {
  return {
    compressedBytes: 1_000_000,
    uncompressedBytes: 3_000_000,
    compressionRatio: 3,
    formatVersion: 2,
    createdBy: "parquet-mr version 1.13.1",
    rowCount: 1_200,
    rowGroupCount: 12,
    columnCount: 2,
    rowsPerRowGroup: 100,
    minRowGroupRows: 90,
    maxRowGroupRows: 110,
    minRowGroupCompressedBytes: 70_000,
    maxRowGroupCompressedBytes: 95_000,
    minRowGroupUncompressedBytes: 210_000,
    maxRowGroupUncompressedBytes: 285_000,
    footerBytes: 4_096,
    codecs: ["zstd"],
    chunkCount: 24,
    chunksWithStatistics: 24,
    chunksWithBloomFilter: 0,
    chunkAggregatesComplete: true,
    unreadableRowGroupCount: 0,
    keyValueCount: 0,
    keyValueMetadata: [],
    columnPathsTruncated: false,
    ...overrides,
  };
}

function summaryLabels(): string[] {
  return Array.from(
    screen.getByLabelText("File facts").querySelectorAll("dt"),
    (label) => label.textContent ?? "",
  );
}

function summaryRow(label: string): HTMLElement {
  const row = Array.from(
    screen.getByLabelText("File facts").querySelectorAll("div"),
  ).find((division) => division.querySelector("dt")?.textContent === label);
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No summary row labelled ${label}.`);
  }
  return row;
}

describe("StructureCard", () => {
  it("separates dataset totals from the selected file footer", () => {
    render(
      <StructureCard
        source={source}
        summary={summaryOf()}
        dataset={dataset}
        datasetNavigator={<nav aria-label="Dataset navigator" />}
      />,
    );

    const datasetFacts = screen.getByLabelText("Dataset facts");
    expect(datasetFacts).toHaveTextContent("96 Parquet files");
    expect(datasetFacts).toHaveTextContent("14 other files ignored");
    expect(datasetFacts).toHaveTextContent("3 with schema differences");
    expect(datasetFacts).toHaveTextContent("80,000 rows");
    expect(datasetFacts).toHaveTextContent("800 row groups");
    expect(datasetFacts).toHaveTextContent("Dataset on disk 9.0 MB");
    expect(datasetFacts).not.toHaveTextContent("File on disk");

    const selectedFileFacts = screen.getByLabelText("Selected file facts");
    const navigator = screen.getByLabelText("Dataset navigator");
    expect(Array.from(datasetFacts.parentElement?.children ?? [])).toEqual([
      datasetFacts,
      navigator,
      selectedFileFacts,
    ]);
    expect(selectedFileFacts).toHaveTextContent("1,200 rows");
    expect(selectedFileFacts).toHaveTextContent("12 row groups");
    expect(selectedFileFacts).toHaveTextContent("≈ 100 rows/group");
    expect(selectedFileFacts).toHaveTextContent("Before compression 3.0 MB");
    expect(selectedFileFacts).toHaveTextContent("Column data on disk 1.0 MB");
    expect(selectedFileFacts).toHaveTextContent("Footer 4.1 kB");
    expect(selectedFileFacts).not.toHaveTextContent("80,000 rows");
  });

  it("shows the counts it already has before the footer is parsed", () => {
    render(<StructureCard source={source} summary={null} />);

    expect(summaryLabels()).toEqual(["Shape", "Storage"]);
    expect(summaryRow("Shape")).toHaveTextContent("1,200 rows");
    expect(summaryRow("Shape")).toHaveTextContent("2 columns");
    expect(summaryRow("Shape")).toHaveTextContent("12 row groups");
    expect(summaryRow("Shape")).toHaveTextContent("— rows/group");
    expect(summaryRow("Storage")).toHaveTextContent("File on disk 1.3 MB");
  });

  it("relates file, column, and footer storage without inventing a remainder", () => {
    render(<StructureCard source={source} summary={summaryOf()} />);

    expect(summaryLabels()).toEqual(["Shape", "Storage", "Metadata"]);
    expect(summaryRow("Shape")).toHaveTextContent("≈ 100 rows/group");
    expect(summaryRow("Storage")).toHaveTextContent(
      "Before compression 3.0 MB",
    );
    expect(summaryRow("Storage")).toHaveTextContent(
      "Column data on disk 1.0 MB",
    );
    expect(summaryRow("Storage")).toHaveTextContent("zstd · ×3.0");
    expect(summaryRow("Storage")).toHaveTextContent("Footer 4.1 kB");
    expect(summaryRow("Storage")).not.toHaveTextContent("Other");
    const storageHelp = within(summaryRow("Storage")).getByRole("button", {
      name: "About Storage",
    });
    fireEvent.focus(storageHelp);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Column data on disk sums compressed page data in column chunks",
    );
    fireEvent.blur(storageHelp);
    expect(summaryRow("Metadata")).toHaveTextContent(
      "Parquet metadata version 2",
    );
    const versionHelp = within(summaryRow("Metadata")).getByRole("button", {
      name: "About Parquet metadata version",
    });
    fireEvent.focus(versionHelp);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "integer version stored in Parquet metadata, not a semantic version",
    );
    expect(summaryRow("Metadata")).toHaveTextContent(
      "Writer parquet-mr version 1.13.1",
    );
  });

  it("names every codec of a mixed file", () => {
    render(
      <StructureCard
        source={source}
        summary={summaryOf({ codecs: ["snappy", "zstd"] })}
      />,
    );

    expect(summaryRow("Storage")).toHaveTextContent("snappy + zstd · ×3.0");
  });

  it("does not present partial chunk aggregates as file totals", () => {
    render(
      <StructureCard
        source={source}
        summary={summaryOf({
          chunkAggregatesComplete: false,
          codecs: null,
          chunksWithStatistics: null,
          chunksWithBloomFilter: null,
        })}
      />,
    );

    const storage = summaryRow("Storage");
    expect(storage).toHaveTextContent("File on disk 1.3 MB");
    expect(storage).toHaveTextContent("Before compression —");
    expect(storage).toHaveTextContent("Column data on disk —");
    expect(storage).not.toHaveTextContent("3.0 MB");
    expect(storage).not.toHaveTextContent("1.0 MB");
    expect(storage).not.toHaveTextContent("×3.0");
  });

  it("reads a file without row groups as facts, not as an error", () => {
    render(
      <StructureCard
        source={{ ...source, rowCount: 0, rowGroupCount: 0 }}
        summary={summaryOf({
          rowCount: 0,
          rowGroupCount: 0,
          rowsPerRowGroup: null,
          compressedBytes: 0,
          uncompressedBytes: 0,
          compressionRatio: null,
          chunkCount: 0,
          chunksWithStatistics: 0,
          chunksWithBloomFilter: 0,
        })}
      />,
    );

    expect(summaryRow("Shape")).toHaveTextContent("0 row groups");
    expect(summaryRow("Shape")).toHaveTextContent("— rows/group");
  });

  it("names a writer the footer does not record", () => {
    render(
      <StructureCard
        source={source}
        summary={summaryOf({ createdBy: null })}
      />,
    );

    expect(
      within(summaryRow("Metadata")).getAllByText("—").length,
    ).toBeGreaterThan(0);
  });
});

describe("StructureLoadStatus", () => {
  it("reports the footer read before any row group is counted", () => {
    render(
      <StructureLoadStatus
        state={{ kind: "loading", progress: null }}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading the Parquet footer…",
    );
    expect(
      screen.getByLabelText("Reading the Parquet footer"),
    ).not.toHaveAttribute("value");
  });

  it("counts summarized column chunks against the total", () => {
    render(
      <StructureLoadStatus
        state={{
          kind: "loading",
          progress: {
            completedRowGroups: 40,
            totalRowGroups: 96,
            completedChunks: 400,
            totalChunks: 960,
          },
        }}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Summarizing 400 of 960 column chunks…",
    );
    const progress = screen.getByLabelText("Summarizing column chunks");
    expect(progress).toHaveAttribute("value", "400");
    expect(progress).toHaveAttribute("max", "960");
  });

  it("cancels the running parse", () => {
    const onCancel = vi.fn();
    render(
      <StructureLoadStatus
        state={{ kind: "loading", progress: null }}
        onCancel={onCancel}
        onRetry={() => {}}
      />,
    );

    screen.getByRole("button", { name: "Cancel" }).click();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers a retry after a cancelled parse", () => {
    const onRetry = vi.fn();
    render(
      <StructureLoadStatus
        state={{ kind: "cancelled" }}
        onCancel={() => {}}
        onRetry={onRetry}
      />,
    );

    expect(
      screen.getByText("Reading the structure was cancelled."),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Read again" }).click();

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a failure with a way back", () => {
    render(
      <StructureLoadStatus
        state={{
          kind: "error",
          message: "The open file is no longer available.",
        }}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The open file is no longer available.",
    );
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("shows nothing once the parse is in", () => {
    const { container } = render(
      <StructureLoadStatus
        state={{ kind: "ready", summary: summaryOf(), refreshing: false }}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("StructureUnitToggle", () => {
  it("presses exactly the active unit and reports a change once", () => {
    const onUnit = vi.fn();
    const { rerender } = render(
      <StructureUnitToggle unit="compressed" onUnit={onUnit} />,
    );

    expect(screen.getByText("Size:")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Size" });
    expect(
      within(group).getByRole("button", { name: "On disk" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: "Before compression" }),
    ).toHaveAttribute("aria-pressed", "false");

    within(group).getByRole("button", { name: "Before compression" }).click();
    expect(onUnit).toHaveBeenCalledWith("uncompressed");

    rerender(<StructureUnitToggle unit="uncompressed" onUnit={onUnit} />);
    expect(
      within(group).getByRole("button", { name: "Before compression" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
