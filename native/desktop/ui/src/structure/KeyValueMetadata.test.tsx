import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import type { StructureSummary } from "../desktop";
import { KeyValueMetadata } from "./KeyValueMetadata";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

function summaryOf(overrides: Partial<StructureSummary>): StructureSummary {
  return {
    compressedBytes: 1_000,
    uncompressedBytes: 3_000,
    compressionRatio: 3,
    formatVersion: 2,
    createdBy: null,
    rowCount: 10,
    rowGroupCount: 1,
    columnCount: 1,
    rowsPerRowGroup: 10,
    footerBytes: 512,
    codecs: ["zstd"],
    chunkCount: 1,
    chunksWithStatistics: 1,
    chunksWithBloomFilter: 0,
    unreadableRowGroupCount: 0,
    keyValueCount: 0,
    keyValueMetadata: [],
    ...overrides,
  };
}

function openEntry(key: string) {
  const details = screen.getByText(key).closest("details");
  if (details === null) {
    throw new Error(`No entry for ${key}.`);
  }
  details.open = true;
  fireEvent(details, new Event("toggle", { bubbles: false }));
  return details;
}

describe("KeyValueMetadata", () => {
  it("stays out of the way when the footer has no metadata", () => {
    const { container } = render(
      <KeyValueMetadata generation={1} summary={summaryOf({})} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("lists keys with their sizes and fetches a value only when opened", async () => {
    const getValue = vi
      .spyOn(desktop, "getStructureKeyValue")
      .mockResolvedValue({
        index: 0,
        key: "pandas",
        value: '{"columns":["id"]}',
        isTruncated: false,
      });
    render(
      <KeyValueMetadata
        generation={7}
        summary={summaryOf({
          keyValueCount: 2,
          keyValueMetadata: [
            { index: 0, key: "pandas", valueBytes: 18_000 },
            { index: 1, key: "marker", valueBytes: null },
          ],
        })}
      />,
    );

    expect(screen.getByText("pandas")).toHaveClass("key-value-key");
    expect(screen.getByText("18.0 kB")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(getValue).not.toHaveBeenCalled();

    openEntry("pandas");

    await waitFor(() => expect(getValue).toHaveBeenCalledWith(7, 0));
    await screen.findByText(/"columns"/);
  });

  it("pretty-prints a value that parses as JSON and leaves other text alone", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockResolvedValue({
      index: 0,
      key: "pandas",
      value: '{"a":1,"b":[2]}',
      isTruncated: false,
    });
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 1,
          keyValueMetadata: [{ index: 0, key: "pandas", valueBytes: 15 }],
        })}
      />,
    );

    openEntry("pandas");

    const rendered = await screen.findByText(/"a": 1/);
    expect(rendered).toHaveClass("key-value-value");
    expect(rendered.textContent).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it("keeps a value the engine could not parse exactly as written", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockResolvedValue({
      index: 0,
      key: "notes",
      value: "written by hand",
      isTruncated: false,
    });
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 1,
          keyValueMetadata: [{ index: 0, key: "notes", valueBytes: 15 }],
        })}
      />,
    );

    openEntry("notes");

    expect(await screen.findByText("written by hand")).toHaveClass(
      "key-value-value",
    );
  });

  it("says when a value was cut and when entries were left out", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockResolvedValue({
      index: 0,
      key: "pandas",
      value: "{",
      isTruncated: true,
    });
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 259,
          keyValueMetadata: [
            { index: 0, key: "pandas", valueBytes: 4_000_000 },
          ],
        })}
      />,
    );

    expect(
      screen.getByText("258 further entries are not listed."),
    ).toBeInTheDocument();

    openEntry("pandas");

    expect(
      await screen.findByText(
        "The value is longer than Viewda reads in one go and is cut here.",
      ),
    ).toBeInTheDocument();
  });

  it("copies the raw value and announces the result", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockResolvedValue({
      index: 0,
      key: "pandas",
      value: '{"a":1}',
      isTruncated: false,
    });
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 1,
          keyValueMetadata: [{ index: 0, key: "pandas", valueBytes: 7 }],
        })}
      />,
    );

    const details = openEntry("pandas");
    const copy = await within(details).findByRole("button", {
      name: "Copy value",
    });
    fireEvent.click(copy);

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{"a":1}'),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Value copied.",
    );
  });

  it("reports a copy the platform refused", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockResolvedValue({
      index: 0,
      key: "pandas",
      value: "{}",
      isTruncated: false,
    });
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
      new Error("denied"),
    );
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 1,
          keyValueMetadata: [{ index: 0, key: "pandas", valueBytes: 2 }],
        })}
      />,
    );

    const details = openEntry("pandas");
    fireEvent.click(
      await within(details).findByRole("button", { name: "Copy value" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed.");
  });

  it("shows why a value could not be read", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockRejectedValue(
      new desktop.StructureCommandError("permissionDenied"),
    );
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 1,
          keyValueMetadata: [{ index: 0, key: "pandas", valueBytes: 7 }],
        })}
      />,
    );

    openEntry("pandas");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Viewda no longer has permission to read this file.",
    );
  });

  it("names an entry that stores no value at all", async () => {
    vi.spyOn(desktop, "getStructureKeyValue").mockResolvedValue({
      index: 0,
      key: "marker",
      value: null,
      isTruncated: false,
    });
    render(
      <KeyValueMetadata
        generation={1}
        summary={summaryOf({
          keyValueCount: 1,
          keyValueMetadata: [{ index: 0, key: "marker", valueBytes: null }],
        })}
      />,
    );

    openEntry("marker");

    expect(
      await screen.findByText("This entry stores no value."),
    ).toBeInTheDocument();
  });
});
