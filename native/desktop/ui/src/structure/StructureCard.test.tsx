import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceSummary, StructureSummary } from "../desktop";
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
  schema: [
    { name: "id", physicalType: "INT64", logicalType: null, children: [] },
    {
      name: "city",
      physicalType: "BYTE_ARRAY",
      logicalType: "String",
      children: [],
    },
  ],
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
    footerBytes: 4_096,
    codecs: ["zstd"],
    chunkCount: 24,
    chunksWithStatistics: 24,
    chunksWithBloomFilter: 0,
    unreadableRowGroupCount: 0,
    keyValueCount: 0,
    keyValueMetadata: [],
    ...overrides,
  };
}

function factLabels(): string[] {
  return Array.from(
    screen.getByLabelText("File facts").querySelectorAll("dt"),
    (label) => label.textContent ?? "",
  );
}

function factValue(label: string): string {
  const entry = Array.from(
    screen.getByLabelText("File facts").querySelectorAll("div"),
  ).find((division) => division.querySelector("dt")?.textContent === label);
  if (entry === undefined) {
    throw new Error(`No fact labelled ${label}.`);
  }
  return entry.querySelector(".fact-value")?.textContent ?? "";
}

describe("StructureCard", () => {
  it("shows the counts it already has before the footer is parsed", () => {
    render(<StructureCard source={source} summary={null} />);

    expect(factLabels()).toEqual([
      "Rows",
      "Row groups",
      "Columns",
      "Rows per group",
      "File size",
    ]);
    expect(factValue("Rows")).toBe("1,200");
    expect(factValue("Columns")).toBe("2");
    expect(factValue("Rows per group")).toBe("—");
    expect(factValue("File size")).toBe("1.3 MB");
  });

  it("states the footer facts as counts once the parse is in", () => {
    render(<StructureCard source={source} summary={summaryOf()} />);

    expect(factLabels()).toEqual([
      "Rows",
      "Row groups",
      "Columns",
      "Rows per group",
      "File size",
      "Stored chunks",
      "Uncompressed chunks",
      "Format",
      "Footer",
      "Codec",
      "Statistics",
      "Bloom filters",
    ]);
    expect(factValue("Rows per group")).toBe("≈ 100");
    expect(factValue("Stored chunks")).toBe("1.0 MB");
    expect(factValue("Uncompressed chunks")).toBe("3.0 MB");
    expect(factValue("Format")).toBe("v2");
    expect(factValue("Footer")).toBe("4.1 kB");
    expect(factValue("Codec")).toBe("zstd");
    expect(factValue("Statistics")).toBe("24 of 24 chunks");
    expect(factValue("Bloom filters")).toBe("0 of 24 chunks");
    expect(
      within(screen.getByLabelText("File facts")).getByText(
        "×3.0 of stored chunks",
      ),
    ).toHaveClass("fact-detail");
    expect(
      within(screen.getByLabelText("File facts")).getByText(
        "parquet-mr version 1.13.1",
      ),
    ).toHaveClass("fact-detail");
  });

  it("names every codec of a mixed file", () => {
    render(
      <StructureCard
        source={source}
        summary={summaryOf({ codecs: ["snappy", "zstd"] })}
      />,
    );

    expect(factValue("Codec")).toBe("snappy + zstd");
  });

  it("counts unreadable row groups only when the file has some", () => {
    const { rerender } = render(
      <StructureCard source={source} summary={summaryOf()} />,
    );
    expect(factLabels()).not.toContain("Unreadable groups");

    rerender(
      <StructureCard
        source={source}
        summary={summaryOf({ unreadableRowGroupCount: 3 })}
      />,
    );

    expect(factValue("Unreadable groups")).toBe("3");
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

    expect(factValue("Row groups")).toBe("0");
    expect(factValue("Rows per group")).toBe("—");
    expect(factValue("Statistics")).toBe("—");
    expect(factValue("Bloom filters")).toBe("—");
  });

  it("names a writer the footer does not record", () => {
    render(
      <StructureCard
        source={source}
        summary={summaryOf({ createdBy: null })}
      />,
    );

    expect(
      within(screen.getByLabelText("File facts")).getAllByText("—").length,
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

  it("counts summarized row groups against the total", () => {
    render(
      <StructureLoadStatus
        state={{
          kind: "loading",
          progress: { completedRowGroups: 40, totalRowGroups: 96 },
        }}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Summarizing 40 of 96 row groups…",
    );
    const progress = screen.getByLabelText("Summarizing row groups");
    expect(progress).toHaveAttribute("value", "40");
    expect(progress).toHaveAttribute("max", "96");
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
        state={{ kind: "ready", summary: summaryOf() }}
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

    const group = screen.getByRole("group", { name: "Byte unit" });
    expect(
      within(group).getByRole("button", { name: "On disk" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: "Uncompressed" }),
    ).toHaveAttribute("aria-pressed", "false");

    within(group).getByRole("button", { name: "Uncompressed" }).click();
    expect(onUnit).toHaveBeenCalledWith("uncompressed");

    rerender(<StructureUnitToggle unit="uncompressed" onUnit={onUnit} />);
    expect(
      within(group).getByRole("button", { name: "Uncompressed" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
