import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect as useReactEffect, useRef as useReactRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, formatFileSize } from "./App";
import * as desktop from "./desktop";

const dataGridProps = vi.hoisted(() => vi.fn());
const decodePreview = vi.hoisted(() => vi.fn());
const structureGridProps = vi.hoisted(() => vi.fn());
vi.mock("./data-grid/DataGrid", () => ({
  DataGrid: (props: unknown) => {
    dataGridProps(props);
    return <section aria-label="Data">Grid data</section>;
  },
}));
vi.mock("./data-grid/arrow-window", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./data-grid/arrow-window")>();
  return { ...actual, decodeArrowWindow: decodePreview };
});
vi.mock("./structure/StructureGrid", () => ({
  StructureGrid: (props: {
    label: string;
    onViewportChange?: (start: number, count: number) => void;
  }) => {
    structureGridProps(props);
    const initialViewport = useReactRef(props.onViewportChange);
    useReactEffect(() => initialViewport.current?.(0, 20), []);
    return <section aria-label={props.label} />;
  },
}));

const structureSummary: desktop.StructureSummary = {
  compressedBytes: 1_200_000,
  uncompressedBytes: 3_600_000,
  compressionRatio: 3,
  formatVersion: 2,
  createdBy: "parquet-mr version 1.13.1",
  rowCount: 1_234_567,
  rowGroupCount: 12,
  columnCount: 2,
  rowsPerRowGroup: 102_880.58,
  minRowGroupRows: 100_000,
  maxRowGroupRows: 103_000,
  minRowGroupCompressedBytes: 90_000,
  maxRowGroupCompressedBytes: 110_000,
  minRowGroupUncompressedBytes: 270_000,
  maxRowGroupUncompressedBytes: 330_000,
  footerBytes: 4_096,
  codecs: ["snappy", "zstd"],
  chunkCount: 24,
  chunksWithStatistics: 24,
  chunksWithBloomFilter: 0,
  chunkAggregatesComplete: true,
  unreadableRowGroupCount: 0,
  keyValueCount: 0,
  keyValueMetadata: [],
  columnPathsTruncated: false,
};

let requestSettings: (() => void) | undefined;
let requestOpenSource: (() => void) | undefined;
let requestCloseSource: ((generation: number) => void) | undefined;
let reportUpdate: ((update: desktop.UpdateInfo) => void) | undefined;
let reportOpenedSource: (() => void) | undefined;
let reportSourceDrag: ((state: desktop.SourceDragState) => void) | undefined;
let reportDatasetStatusChanged:
  ((event: desktop.DatasetStatusChangedEvent) => void) | undefined;
let unlistenSourceDrag = vi.fn();
let requestDataExportClose:
  ((dialog: desktop.DataExportCloseDialog) => void) | undefined;
let systemDark = false;
let themeChangeListeners = new Set<EventListener>();
let listedSources: desktop.OpenedSourceEntry[] = [];

function listedSource(
  generation: number,
  name: string,
  active = true,
): desktop.OpenedSourceEntry {
  return {
    generation,
    kind: "file",
    datasetMemberCount: null,
    datasetIgnoredFileCount: null,
    name,
    directory: "~/Data",
    path: `/home/test/Data/${name}`,
    active,
  };
}

function sourceSummary(
  generation = 1,
  displayName = "people.parquet",
): desktop.SourceSummary {
  return {
    generation,
    displayName,
    sizeBytes: 8,
    rowCount: 1,
    rowGroupCount: 1,
    columnCount: 1,
    schema: [
      {
        name: "value",
        physicalType: "INT64",
        logicalType: null,
        children: [],
      },
    ],
    schemaNodeCount: 1,
    schemaIsTruncated: false,
    stringsTruncated: false,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

beforeEach(() => {
  requestSettings = undefined;
  requestOpenSource = undefined;
  requestCloseSource = undefined;
  reportUpdate = undefined;
  reportOpenedSource = undefined;
  reportSourceDrag = undefined;
  reportDatasetStatusChanged = undefined;
  unlistenSourceDrag = vi.fn();
  requestDataExportClose = undefined;
  dataGridProps.mockClear();
  structureGridProps.mockClear();
  decodePreview.mockReset();
  decodePreview.mockReturnValue({
    rowOffset: 0,
    rowCount: 1,
    sourceIndices: [0],
    sourceColumnOffsets: new Map([[0, 0]]),
    table: { getChildAt: () => ({ at: () => 42 }) },
  });
  systemDark = false;
  themeChangeListeners = new Set();
  listedSources = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_type: string, listener: EventListener) =>
        themeChangeListeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) =>
        themeChangeListeners.delete(listener),
    })),
  );
  vi.spyOn(desktop, "getEngineStatus").mockResolvedValue({
    name: "Viewda data engine",
    version: "0.0.1",
    queryEngineVersion: "v1.5.5",
  });
  vi.spyOn(desktop, "getRecentSources").mockResolvedValue([]);
  vi.spyOn(desktop, "getStructureSummary").mockResolvedValue(structureSummary);
  vi.spyOn(desktop, "getStructureLoadProgress").mockResolvedValue(null);
  vi.spyOn(desktop, "cancelStructureLoad").mockResolvedValue();
  vi.spyOn(desktop, "cancelSourceOpen").mockResolvedValue("cancelled");
  vi.spyOn(desktop, "getSourceOpenProgress").mockResolvedValue(null);
  vi.spyOn(desktop, "getStructureLensTotals").mockResolvedValue({
    codecs: ["snappy", "zstd"].map((codec) => ({
      codec,
      total: {
        chunkCount: 12,
        compressedBytes: 600_000,
        uncompressedBytes: 1_800_000,
      },
    })),
    ratioSteps: [],
    unrated: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    statistics: {
      present: {
        chunkCount: 24,
        compressedBytes: 1_200_000,
        uncompressedBytes: 3_600_000,
      },
      absent: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    },
    bloomFilters: {
      present: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      absent: {
        chunkCount: 24,
        compressedBytes: 1_200_000,
        uncompressedBytes: 3_600_000,
      },
    },
  });
  vi.spyOn(desktop, "getStructureLayout").mockResolvedValue({
    columns: [],
    remainingColumnCount: 0,
    overview: [],
    rows: [],
  });
  vi.spyOn(desktop, "getStructureRowOffset").mockResolvedValue(0);
  vi.spyOn(desktop, "getStructureReport").mockResolvedValue("# report");
  vi.spyOn(desktop, "getStructureRowGroups").mockResolvedValue({
    offset: 0,
    totalCount: 0,
    rowGroups: [],
  });
  vi.spyOn(desktop, "getStructureColumns").mockResolvedValue({
    offset: 0,
    totalCount: 0,
    columns: [],
  });
  vi.spyOn(desktop, "openRecentSource").mockRejectedValue(
    new desktop.OpenSourceError("unsupported"),
  );
  vi.spyOn(desktop, "onOpenSourceRequested").mockImplementation((handler) => {
    requestOpenSource = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onOpenFolderRequested").mockResolvedValue(() => {});
  vi.spyOn(desktop, "openLocalFolder").mockResolvedValue(null);
  vi.spyOn(desktop, "onSettingsRequested").mockImplementation((handler) => {
    requestSettings = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onUpdateAvailable").mockImplementation((handler) => {
    reportUpdate = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onOpenedSourceAvailable").mockImplementation((handler) => {
    reportOpenedSource = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onSourceDragState").mockImplementation((handler) => {
    reportSourceDrag = handler;
    return Promise.resolve(unlistenSourceDrag);
  });
  vi.spyOn(desktop, "onDatasetStatusChanged").mockImplementation((handler) => {
    reportDatasetStatusChanged = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onDataExportCloseRequested").mockImplementation(
    (handler) => {
      requestDataExportClose = handler;
      return Promise.resolve(() => {});
    },
  );
  vi.spyOn(desktop, "getPendingDataExportCloseDialog").mockResolvedValue(null);
  vi.spyOn(desktop, "resolveDataExportCloseDialog").mockResolvedValue(true);
  vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
    channel: "stable",
    automaticChecks: true,
  });
  vi.spyOn(desktop, "getDataViewSettings").mockResolvedValue({
    memoryLimit: "mb384",
  });
  vi.spyOn(desktop, "checkForUpdate").mockResolvedValue(null);
  vi.spyOn(desktop, "setUpdateSettings").mockResolvedValue();
  vi.spyOn(desktop, "setDataViewSettings").mockResolvedValue();
  vi.spyOn(desktop, "setThemePreference").mockResolvedValue();
  vi.spyOn(desktop, "syncSystemTheme").mockResolvedValue();
  vi.spyOn(desktop, "discardPendingUpdate").mockResolvedValue();
  vi.spyOn(desktop, "installPendingUpdate").mockResolvedValue(true);
  vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue(null);
  vi.spyOn(desktop, "takeOpenedSource").mockResolvedValue(null);
  vi.spyOn(desktop, "listOpenedSources").mockImplementation(async () =>
    listedSources.map((entry) => ({ ...entry })),
  );
  vi.spyOn(desktop, "getOpenedSourceSummary").mockResolvedValue(null);
  vi.spyOn(desktop, "activateOpenedSource").mockResolvedValue();
  vi.spyOn(desktop, "cycleOpenedSource").mockResolvedValue(null);
  vi.spyOn(desktop, "closeOpenedSource").mockResolvedValue(true);
  vi.spyOn(desktop, "removeRecentSource").mockResolvedValue();
  vi.spyOn(desktop, "revealOpenedSource").mockResolvedValue();
  vi.spyOn(desktop, "onCloseSourceRequested").mockImplementation((handler) => {
    requestCloseSource = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onRecentSourcesChanged").mockResolvedValue(() => {});
  vi.spyOn(desktop, "openReleasesPage").mockResolvedValue();
  vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
    kind: "canSet",
  });
  vi.spyOn(desktop, "setDefaultApplication").mockResolvedValue({
    kind: "default",
  });
});

async function openSettings() {
  await waitFor(() => expect(requestSettings).toBeTypeOf("function"));
  act(() => requestSettings?.());
  return screen.findByRole("dialog", { name: "Settings" });
}

async function readyOpenButton() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled(),
  );
  return screen.getByRole("button", { name: "Open Parquet file…" });
}

function renderWithOpenSources(...sources: desktop.OpenedSourceEntry[]) {
  listedSources = sources;
  vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
    version: "0.1.0",
    sourceError: null,
    restoreIncomplete: false,
    sources: sources.map((source) => ({
      generation: source.generation,
      displayName: source.name,
      sizeBytes: 8,
      rowCount: 1,
      rowGroupCount: 1,
      columnCount: 0,
      schema: [],
      schemaNodeCount: 0,
      schemaIsTruncated: false,
      stringsTruncated: false,
    })),
  });
  render(<App />);
}

function expectShortcutHints() {
  const shortcuts = screen.getByLabelText("Keyboard shortcuts");

  expect(within(shortcuts).getByText("Open file")).toBeInTheDocument();
  expect(within(shortcuts).getByText("Settings")).toBeInTheDocument();
  expect(within(shortcuts).getByText("Ctrl+O").tagName).toBe("KBD");
  expect(within(shortcuts).getByText("Ctrl+,").tagName).toBe("KBD");
}

async function openStableDowngrade() {
  vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
    channel: "latest",
    automaticChecks: false,
  });
  vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
    version: "0.1.0",
    currentVersion: "0.2.0-alpha.1",
    isDowngrade: true,
  });

  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Update channel"), {
    target: { value: "stable" },
  });

  return screen.findByRole("dialog", {
    name: "Stable is currently older.",
  });
}

describe("App", () => {
  it("shows engine startup without presenting the Open action as ready", () => {
    vi.spyOn(desktop, "getEngineStatus").mockReturnValue(new Promise(() => {}));
    render(<App />);

    expect(
      screen.getByRole("button", { name: "Open Parquet file…" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Starting the local data engine…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Your data never leaves this machine."),
    ).not.toBeInTheDocument();
    expect(desktop.getRecentSources).not.toHaveBeenCalled();
    expectShortcutHints();
  });

  it("shows the ready empty state and platform shortcuts", async () => {
    render(<App />);

    await readyOpenButton();
    expect(
      screen.getByRole("button", { name: "Open folder as dataset" }),
    ).toHaveAttribute(
      "title",
      "Open every Parquet file in the selected folder and its subfolders as one dataset. Hive-style key=value folders become columns.",
    );
    expect(screen.getByText("No file open")).toHaveClass(
      "file-context",
      "is-empty",
    );
    expect(
      screen.getByText("Your data never leaves this machine."),
    ).toBeInTheDocument();
    expectShortcutHints();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(
      await screen.findByRole("region", { name: "Source switcher" }),
    ).toBeInTheDocument();
  });

  it("updates the native file-drop affordance and hides it after leave or drop", async () => {
    render(<App />);
    await waitFor(() => expect(reportSourceDrag).toBeTypeOf("function"));

    act(() => reportSourceDrag?.({ state: "enter", kind: "folder" }));
    let overlay = screen.getByRole("status", { name: "Source drop" });
    expect(overlay).toHaveTextContent("Open folder as dataset");
    expect(overlay).not.toHaveTextContent("add as dataset");

    act(() => reportSourceDrag?.({ state: "enter", kind: "files" }));
    overlay = screen.getByRole("status", { name: "Source drop" });
    expect(overlay).toHaveTextContent("Open files");
    expect(within(overlay).getByText("Alt", { selector: "kbd" })).toBeVisible();
    expect(overlay).toHaveTextContent("Alt — add as dataset");

    act(() => reportSourceDrag?.({ state: "enter", kind: "mixed" }));
    overlay = screen.getByRole("status", { name: "Source drop" });
    expect(overlay).toHaveTextContent("This drop is not supported");
    expect(overlay).toHaveTextContent(
      "Drop a folder or Parquet files separately.",
    );
    expect(overlay).not.toHaveTextContent("add as dataset");

    act(() => reportSourceDrag?.({ state: "leave", kind: "mixed" }));
    expect(
      screen.queryByRole("status", { name: "Source drop" }),
    ).not.toBeInTheDocument();

    act(() => reportSourceDrag?.({ state: "enter", kind: "files" }));
    expect(screen.getByRole("status", { name: "Source drop" })).toBeVisible();
    act(() => reportSourceDrag?.({ state: "drop", kind: "files" }));
    expect(
      screen.queryByRole("status", { name: "Source drop" }),
    ).not.toBeInTheDocument();
  });

  it("stops listening for native file-drop state after unmount", async () => {
    const view = render(<App />);
    await waitFor(() => expect(reportSourceDrag).toBeTypeOf("function"));

    view.unmount();

    expect(unlistenSourceDrag).toHaveBeenCalledOnce();
  });

  it("renders recent files and opens the keyboard-selected entry by id", async () => {
    listedSources = [listedSource(1, "events.parquet")];
    vi.spyOn(desktop, "getRecentSources").mockResolvedValue([
      {
        id: "recent-8",
        kind: "file",
        name: "people.parquet",
        directory: "~/Data",
        path: "/home/tester/Data/people.parquet",
      },
      {
        id: "recent-7",
        kind: "file",
        name: "events.parquet",
        directory: "~/Projects/metrics",
        path: "/home/tester/Projects/metrics/events.parquet",
      },
    ]);
    vi.spyOn(desktop, "openRecentSource").mockResolvedValue({
      generation: 1,
      displayName: "events.parquet",
      sizeBytes: 2048,
      rowCount: 4,
      rowGroupCount: 1,
      columnCount: 0,
      schema: [],
      schemaNodeCount: 0,
      schemaIsTruncated: false,
      stringsTruncated: false,
    });

    render(<App />);
    const list = await screen.findByRole("list", { name: "Recent sources" });
    const entries = within(list).getAllByRole("button");
    const firstEntry = entries[0]!;
    const secondEntry = entries[1]!;

    expect(within(firstEntry).getByText("people.parquet")).toHaveClass(
      "recent-file-name",
    );
    expect(within(firstEntry).getByText("~/Data")).toHaveClass(
      "recent-file-directory",
    );
    firstEntry.focus();
    fireEvent.keyDown(firstEntry, { key: "ArrowDown" });
    expect(secondEntry).toHaveFocus();
    fireEvent.keyDown(secondEntry, { key: "Enter" });

    await waitFor(() =>
      expect(desktop.openRecentSource).toHaveBeenCalledWith(
        "recent-7",
        expect.any(String),
      ),
    );
    expect(
      (await screen.findAllByText("events.parquet")).some((element) =>
        element.closest(".file-context"),
      ),
    ).toBe(true);
  });

  it("does not render the recent-files block for an empty list", async () => {
    render(<App />);

    await readyOpenButton();
    await waitFor(() => expect(desktop.getRecentSources).toHaveBeenCalled());
    expect(
      screen.queryByRole("list", { name: "Recent sources" }),
    ).not.toBeInTheDocument();
  });

  it("removes a vanished recent file and shows the existing not-found error", async () => {
    vi.spyOn(desktop, "getRecentSources").mockResolvedValue([
      {
        id: "recent-missing",
        kind: "file",
        name: "gone.parquet",
        directory: "~/Data",
        path: "/home/tester/Data/gone.parquet",
      },
    ]);
    vi.spyOn(desktop, "openRecentSource").mockRejectedValue(
      new desktop.OpenSourceError("notFound"),
    );

    render(<App />);
    const list = await screen.findByRole("list", { name: "Recent sources" });
    fireEvent.click(within(list).getByRole("button"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is no longer available. Choose it again.",
    );
    expect(
      screen.queryByRole("list", { name: "Recent sources" }),
    ).not.toBeInTheDocument();
  });

  it("shows a recoverable startup error", async () => {
    vi.spyOn(desktop, "getEngineStatus").mockRejectedValue(
      new Error("engine unavailable"),
    );

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restart Viewda and try again.",
    );
    expect(
      screen.queryByRole("button", { name: "Open Parquet file…" }),
    ).not.toBeInTheDocument();
    expect(desktop.getRecentSources).not.toHaveBeenCalled();
    expectShortcutHints();
  });

  it("opens a local source and renders its path-free summary", async () => {
    listedSources = [listedSource(1, "people.parquet")];
    vi.mocked(desktop.getStructureSummary).mockResolvedValue({
      ...structureSummary,
      keyValueCount: 1,
      keyValueMetadata: [{ index: 0, key: "source", valueBytes: 6 }],
    });
    const openSource = vi.spyOn(desktop, "openLocalSource").mockResolvedValue({
      sources: [
        {
          generation: 1,
          displayName: "people.parquet",
          sizeBytes: 1_300_000,
          rowCount: 1_234_567,
          rowGroupCount: 12,
          columnCount: 2,
          schema: [
            {
              name: "created_on",
              physicalType: "INT32",
              logicalType: "Date",
              children: [],
            },
            {
              name: "related_urls",
              physicalType: "GROUP",
              logicalType: "List",
              children: [
                {
                  name: "list",
                  physicalType: "GROUP",
                  logicalType: null,
                  children: [
                    {
                      name: "element",
                      physicalType: "BYTE_ARRAY",
                      logicalType: "String",
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
          schemaNodeCount: 4,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
      ],
      sourceError: null,
    });

    const { container } = render(<App />);
    fireEvent.click(await readyOpenButton());

    expect(
      (await screen.findByText("people.parquet")).closest(".file-context"),
    ).not.toBeNull();
    expect(screen.queryByText("Parquet source")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const dataGrid = await screen.findByLabelText("Data");
    expect(dataGrid).toHaveTextContent("Grid data");
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    expect(screen.getByLabelText("Data")).toBe(dataGrid);
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({
      active: false,
    });
    expect(container.querySelector(".source-heading")).not.toHaveTextContent(
      "people.parquet",
    );

    const facts = screen.getByLabelText("File facts");
    expect(
      Array.from(
        facts.querySelectorAll("dt"),
        ({ textContent }) => textContent,
      ),
    ).toEqual(["Shape", "Storage"]);
    expect(
      Array.from(
        facts.querySelectorAll("strong.is-technical"),
        ({ textContent }) => textContent,
      ),
    ).toEqual(["1,234,567", "2", "12", "—", "1.3 MB"]);
    expect(within(facts).getByText("1.3 MB")).toHaveAttribute(
      "title",
      "1,300,000 bytes",
    );
    await waitFor(() =>
      expect(
        Array.from(
          facts.querySelectorAll("dt"),
          ({ textContent }) => textContent,
        ),
      ).toEqual(["Shape", "Storage", "Metadata"]),
    );
    expect(within(facts).getByText("≈ 102,881")).toHaveClass("is-technical");
    expect(facts).toHaveTextContent("snappy + zstd · ×3.0");
    const chunkFacts = screen.getByLabelText("Chunk facts");
    expect(chunkFacts).toHaveTextContent(
      "12 row groups × 2 columns · 24 chunks",
    );
    expect(chunkFacts).toHaveTextContent("Statistics100% · 24 of 24 chunks");
    expect(chunkFacts).toHaveTextContent("Bloom filters0% · 0 of 24 chunks");
    await waitFor(() =>
      expect(chunkFacts).toHaveTextContent("snappy 50% · 12 of 24 chunks"),
    );
    const orderedSections = [
      screen.getByRole("region", { name: "Chunk overview" }),
      screen.getByRole("heading", { name: "Row groups" }).closest("section"),
      screen.getByRole("heading", { name: "Columns" }).closest("section"),
      screen.getByRole("region", { name: "Key-value metadata" }),
    ];
    for (const [index, section] of orderedSections.entries()) {
      if (index === 0) continue;
      expect(
        orderedSections[index - 1]!.compareDocumentPosition(section!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    }

    expect(screen.getAllByRole("heading", { name: "Columns" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Schema" })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      within(
        document.querySelector(
          ".structure-mode-panel:not([hidden])",
        ) as HTMLElement,
      ).getByLabelText("Columns"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Data preview is not in this build yet."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/[/\\]people\.parquet/)).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Data")).toBe(dataGrid);
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({
      active: true,
    });
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    openSource.mockRejectedValueOnce(
      new desktop.OpenSourceError("permissionDenied"),
    );
    await act(async () => requestOpenSource?.());
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Viewda cannot read that file. Check its permissions and try again.",
    );
  });

  it("keeps one source-open attempt authoritative while menu and recent opens repeat", async () => {
    vi.spyOn(desktop, "getRecentSources").mockResolvedValue([
      {
        id: "recent-1",
        kind: "file",
        name: "other.parquet",
        directory: "~/Data",
        path: "/home/test/Data/other.parquet",
      },
    ]);
    let resolveOpen:
      ((source: desktop.OpenedSourceBatch | null) => void) | undefined;
    vi.spyOn(desktop, "openLocalSource").mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );
    render(<App />);
    const recent = await screen.findByRole("button", {
      name: /other\.parquet/,
    });
    fireEvent.click(await readyOpenButton());
    expect(
      await screen.findByRole("button", { name: "Cancel opening" }),
    ).toBeEnabled();

    fireEvent.click(recent);
    await act(async () => requestOpenSource?.());
    expect(desktop.openLocalSource).toHaveBeenCalledTimes(1);
    expect(desktop.openRecentSource).not.toHaveBeenCalled();

    listedSources = [listedSource(1, "people.parquet")];
    await act(async () =>
      resolveOpen?.({ sources: [sourceSummary()], sourceError: null }),
    );
    expect(await screen.findByText("people.parquet")).toBeInTheDocument();
  });

  it("shows discovery without fake data and lets the user cancel", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview");
    vi.spyOn(desktop, "getDatasetStatus").mockResolvedValue(
      datasetDiscoveringStatus(),
    );
    vi.spyOn(desktop, "cancelDatasetInspection").mockResolvedValue(false);

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );

    const discovery = (
      await screen.findByText("Finding Parquet files… 5 Parquet files found")
    ).closest("aside")!;
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();
    expect(desktop.getDatasetPreview).not.toHaveBeenCalled();
    expect(within(discovery).queryByText(/rows|row groups/i)).toBeNull();
    expect(screen.getByText("dataset/")).toHaveClass("file-context-name");
    expect(screen.queryByText("dataset//")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(desktop.cancelDatasetInspection).toHaveBeenCalledWith(7);
  });

  it("mounts the fixed sample when the first status poll is inspecting", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(
      new ArrayBuffer(1),
    );
    vi.spyOn(desktop, "getDatasetStatus")
      .mockResolvedValueOnce(datasetInspectingStatus())
      .mockReturnValue(new Promise(() => {}));

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );

    expect(
      await screen.findByRole("region", { name: "Data" }),
    ).toBeInTheDocument();
    expect(dataGridProps.mock.lastCall?.[0]).toMatchObject({
      contentIdentity: "early-sample",
      exportEnabled: false,
      source: { rowCount: 12, columnCount: 2 },
    });
    expect(desktop.getDatasetPreview).toHaveBeenCalledTimes(1);
    expect(decodePreview).toHaveBeenCalledTimes(1);
  });

  it("requests a failed inspection preview again only after Retry", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview")
      .mockRejectedValueOnce(new Error("preview unavailable"))
      .mockResolvedValueOnce(new ArrayBuffer(1));
    vi.spyOn(desktop, "getDatasetStatus")
      .mockResolvedValueOnce(datasetInspectingStatus())
      .mockResolvedValueOnce(datasetInspectingStatus())
      .mockReturnValue(new Promise(() => {}));

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Structure" }));
    expect(
      await screen.findByText(
        "Preview is unavailable while inspection continues.",
      ),
    ).toBeVisible();
    expect(desktop.getDatasetPreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("table", { name: "Dataset preview" }),
    ).toBeVisible();
    expect(desktop.getDatasetPreview).toHaveBeenCalledTimes(2);
    expect(decodePreview).toHaveBeenCalledTimes(1);
  });

  it("mounts one early sample and preserves the grid through dataset phases", async () => {
    vi.useFakeTimers();
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(
      new ArrayBuffer(1),
    );
    vi.spyOn(desktop, "getDatasetStatus")
      .mockResolvedValueOnce(datasetDiscoveringStatus())
      .mockResolvedValueOnce(datasetDiscoveringStatus(true))
      .mockResolvedValueOnce(datasetDiscoveringStatus(true))
      .mockResolvedValueOnce(datasetInspectingStatus())
      .mockResolvedValueOnce(datasetInspectingStatus())
      .mockResolvedValue(datasetReadyStatus());

    render(<App />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Open folder as dataset" }),
    );
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("region", { name: "Data" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Early sample; final dataset order and totals are pending.",
      ),
    ).toBeInTheDocument();
    expect(decodePreview).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      0,
      [0, 1],
    );
    expect(dataGridProps.mock.lastCall?.[0]).toMatchObject({
      contentIdentity: "early-sample",
      exportEnabled: false,
      source: { rowCount: 12 },
    });
    const rendersAfterSample = dataGridProps.mock.calls.length;

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(desktop.getDatasetPreview).toHaveBeenCalledTimes(1);
    expect(decodePreview).toHaveBeenCalledTimes(1);
    expect(dataGridProps).toHaveBeenCalledTimes(rendersAfterSample);

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(dataGridProps.mock.lastCall?.[0]).toMatchObject({
      contentIdentity: "early-sample",
      exportEnabled: false,
      source: { rowCount: 12 },
    });
    expect(
      screen.getByText(
        "Early sample (12 rows); final dataset order and totals are pending.",
      ),
    ).toBeInTheDocument();
    expect(desktop.getDatasetPreview).toHaveBeenCalledTimes(1);
    expect(decodePreview).toHaveBeenCalledTimes(1);
    const rendersAfterInspectionPreview = dataGridProps.mock.calls.length;

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(desktop.getDatasetPreview).toHaveBeenCalledTimes(1);
    expect(decodePreview).toHaveBeenCalledTimes(1);
    expect(dataGridProps).toHaveBeenCalledTimes(rendersAfterInspectionPreview);

    await act(async () => vi.advanceTimersByTimeAsync(250));
    const props = dataGridProps.mock.lastCall?.[0] as {
      contentIdentity: string;
      exportEnabled: boolean;
      source: desktop.SourceSummary;
      defaultPinnedSourceIndices: ReadonlySet<number>;
    };
    expect(props.contentIdentity).toBe("complete");
    expect(props.exportEnabled).toBe(true);
    expect(props.source).toMatchObject({ generation: 7, columnCount: 2 });
    expect(props.defaultPinnedSourceIndices.has(1)).toBe(true);
    expect(dataGridProps).toHaveBeenCalledTimes(
      rendersAfterInspectionPreview + 1,
    );
  });

  it("ignores a late dataset-ready result after the generation closes", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(
      new ArrayBuffer(1),
    );
    let resolveStatus: ((status: desktop.DatasetStatus) => void) | undefined;
    vi.spyOn(desktop, "getDatasetStatus")
      .mockResolvedValueOnce(datasetDiscoveringStatus(true))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      );
    vi.mocked(desktop.closeOpenedSource).mockImplementation(async () => {
      listedSources = [];
      return true;
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );
    expect(
      await screen.findByRole("region", { name: "Data" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2),
    );
    const callsBeforeClose = dataGridProps.mock.calls.length;
    await act(async () => requestCloseSource?.(7));
    await waitFor(() =>
      expect(screen.queryByText("dataset/")).not.toBeInTheDocument(),
    );
    await act(async () => resolveStatus?.(datasetReadyStatus()));

    expect(dataGridProps).toHaveBeenCalledTimes(callsBeforeClose);
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping dataset reloads into one native replacement", async () => {
    let resolveReload: ((source: desktop.SourceSummary) => void) | undefined;
    vi.spyOn(desktop, "reloadOpenedSource").mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve;
      }),
    );
    await renderReadyDataset();

    openDatasetContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reload dataset" }));
    openDatasetContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reload dataset" }));
    expect(desktop.reloadOpenedSource).toHaveBeenCalledTimes(1);

    const replacement = { ...datasetProvisionalSummary(), generation: 8 };
    listedSources = [listedDataset(8)];
    await act(async () => resolveReload?.(replacement));
    await waitFor(() => {
      const props = dataGridProps.mock.lastCall?.[0] as
        { source: desktop.SourceSummary } | undefined;
      expect(props?.source.generation).toBe(8);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers the existing dataset reload from a source-changed error", async () => {
    let rejectReload: ((error: unknown) => void) | undefined;
    const reload = vi.spyOn(desktop, "reloadOpenedSource").mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectReload = reject;
      }),
    );
    await renderReadyDataset();
    expect(
      (dataGridProps.mock.lastCall?.[0] as { onReloadDataset?: () => void })
        .onReloadDataset,
    ).toBeTypeOf("function");
    vi.mocked(desktop.takeOpenedSource)
      .mockResolvedValueOnce({
        source: null,
        sourceError: {
          code: "sourceChanged",
          member: "year=2026/part-1.parquet",
        },
      })
      .mockResolvedValueOnce(null);

    await act(async () => reportOpenedSource?.());
    let alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "A dataset member changed after inspection. Reload the dataset.",
    );
    expect(
      within(alert).getByRole("button", { name: "Reload dataset" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("button", { name: "Reload dataset" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", {
        name: "Reload dataset",
      }),
    );

    expect(reload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledWith(7, expect.any(String));
    let reloadProgress = await screen.findByRole("complementary", {
      name: "Dataset reload progress",
    });
    expect(
      within(reloadProgress).getByText("Reloading dataset…"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    reloadProgress = await screen.findByRole("complementary", {
      name: "Dataset reload progress",
    });
    fireEvent.click(
      within(reloadProgress).getByRole("button", { name: "Cancel" }),
    );
    const attempt = reload.mock.calls[0]![1];
    expect(desktop.cancelSourceOpen).toHaveBeenCalledWith(attempt);
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", {
          name: "Dataset reload progress",
        }),
      ).not.toBeInTheDocument(),
    );
    await act(async () =>
      rejectReload?.(new desktop.OpenSourceError("sourceChanged")),
    );
    expect(screen.getByText("dataset/")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A dataset member changed after inspection. Reload the dataset.",
    );
  });

  it("closes a replacement published before the reload response", async () => {
    let resolveReload: ((source: desktop.SourceSummary) => void) | undefined;
    vi.spyOn(desktop, "reloadOpenedSource").mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve;
      }),
    );
    vi.mocked(desktop.closeOpenedSource).mockImplementation(async () => {
      listedSources = [];
      return true;
    });
    await renderReadyDataset();
    vi.mocked(desktop.listOpenedSources).mockRejectedValueOnce(
      new Error("listing unavailable"),
    );

    openDatasetContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reload dataset" }));
    openDatasetContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    listedSources = [listedDataset(8)];
    await act(async () =>
      resolveReload?.({ ...datasetProvisionalSummary(), generation: 8 }),
    );

    await waitFor(() =>
      expect(desktop.closeOpenedSource).toHaveBeenCalledWith(8),
    );
    await waitFor(() =>
      expect(screen.queryByText("dataset/")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not publish a reload error after close", async () => {
    let rejectReload: ((error: unknown) => void) | undefined;
    vi.spyOn(desktop, "reloadOpenedSource").mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectReload = reject;
      }),
    );
    vi.mocked(desktop.closeOpenedSource).mockImplementation(async () => {
      listedSources = [];
      return true;
    });
    await renderReadyDataset();

    openDatasetContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reload dataset" }));
    openDatasetContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    await act(async () =>
      rejectReload?.(new desktop.OpenSourceError("sourceChanged")),
    );

    await waitFor(() =>
      expect(screen.queryByText("dataset/")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("waits for the dataset poll interval and keeps only one request in flight", async () => {
    vi.useFakeTimers();
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetProvisionalSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(
      new ArrayBuffer(1),
    );
    let resolveSecond: ((status: desktop.DatasetStatus) => void) | undefined;
    vi.spyOn(desktop, "getDatasetStatus")
      .mockResolvedValueOnce({
        state: "inspecting",
        sampleSummary: datasetSampleSummary(),
        progress: {
          completedMemberCount: 1,
          totalMemberCount: 2,
          rowCount: 1,
          rowGroupCount: 1,
        },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(<App />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Open folder as dataset" }),
    );
    await act(async () => {});
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2);

    await act(async () => resolveSecond?.(datasetReadyStatus()));
    expect(dataGridProps).toHaveBeenCalled();
  });

  it("stops failed status polling and offers an explicit retry", async () => {
    vi.useFakeTimers();
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview");
    vi.spyOn(desktop, "getDatasetStatus").mockRejectedValue(
      new Error("status unavailable"),
    );

    render(<App />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Open folder as dataset" }),
    );
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Discovery status is unavailable",
    );
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();
    expect(desktop.getDatasetPreview).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(4);
  });

  it("shows one path-free alert when background inspection fails", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview");
    vi.spyOn(desktop, "getDatasetStatus").mockResolvedValue({
      state: "failed",
      error: {
        code: "invalidMember",
        member: "year=2026/broken.parquet",
      },
    });
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("year=2026/broken.parquet");
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();
    expect(desktop.getDatasetPreview).not.toHaveBeenCalled();
  });

  it("lets a lifecycle failure event supersede a pending ready poll", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    let resolveReady: ((status: desktop.DatasetStatus) => void) | undefined;
    vi.spyOn(desktop, "getDatasetStatus")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveReady = resolve;
        }),
      )
      .mockResolvedValue({
        state: "failed",
        error: {
          code: "memberPermissionDenied",
          member: "year=2026/private.parquet",
        },
      });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );
    await waitFor(() =>
      expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(reportDatasetStatusChanged).toBeTypeOf("function"),
    );

    await act(async () => {
      reportDatasetStatusChanged?.({ generation: 99 });
      await Promise.resolve();
    });
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      reportDatasetStatusChanged?.({ generation: 7 });
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("year=2026/private.parquet");
    expect(alert).toHaveTextContent("Check its permissions, then reload");
    expect(
      within(alert).getByRole("button", { name: "Reload dataset" }),
    ).toBeEnabled();
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2);

    await act(async () => resolveReady?.(datasetReadyStatus()));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "year=2026/private.parquet",
    );
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();

    await act(async () => {
      reportDatasetStatusChanged?.({ generation: 7 });
      await Promise.resolve();
    });
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2);
  });

  it("resumes polling when a lifecycle event supersedes an in-flight poll", async () => {
    vi.useFakeTimers();
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    let resolvePending: ((status: desktop.DatasetStatus) => void) | undefined;
    vi.spyOn(desktop, "getDatasetStatus")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
      )
      .mockResolvedValue(datasetReadyStatus());

    render(<App />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Open folder as dataset" }),
    );
    await act(async () => {});
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      reportDatasetStatusChanged?.({ generation: 7 });
    });
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(2);

    await act(async () => resolvePending?.(datasetInspectingStatus()));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("region", { name: "Data" })).toBeInTheDocument();
  });

  it("shows an empty-folder failure without mounting a grid", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetDiscoveringSourceSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview");
    vi.spyOn(desktop, "getDatasetStatus").mockResolvedValue({
      state: "failed",
      error: { code: "noParquetFiles" },
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That folder contains no supported Parquet files.",
    );
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();
    expect(desktop.getDatasetPreview).not.toHaveBeenCalled();
  });

  it("polls only the active dataset", async () => {
    const active = listedDataset(7);
    const hidden = listedDataset(8, false);
    vi.spyOn(desktop, "getDatasetStatus").mockReturnValue(
      new Promise(() => {}),
    );

    renderWithOpenSources(active, hidden);
    await waitFor(() => expect(desktop.getDatasetStatus).toHaveBeenCalled());

    expect(desktop.getDatasetStatus).toHaveBeenCalledTimes(1);
    expect(desktop.getDatasetStatus).toHaveBeenCalledWith(7);
  });

  it("pages members, commits one selection, and navigates the partition tree", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetProvisionalSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(
      new ArrayBuffer(1),
    );
    const readyStatus = datasetReadyStatus();
    if (readyStatus.state === "ready") {
      readyStatus.summary.memberCount = 600;
      readyStatus.summary.schemaDriftMemberCount = 2;
      readyStatus.summary.partitionColumnIndices = [0, 1];
    }
    vi.spyOn(desktop, "getDatasetStatus").mockResolvedValue(readyStatus);
    vi.spyOn(desktop, "getDatasetMembers").mockImplementation(
      async (_generation, offset) => ({
        offset,
        total: 600,
        members: [
          {
            ordinal: offset,
            relativePath: `part-${offset}.parquet`,
            partitions: [],
          },
        ],
      }),
    );
    vi.spyOn(desktop, "getDatasetSchemaDriftMembers").mockResolvedValue({
      offset: 0,
      total: 2,
      members: [],
    });
    const partition = { key: "year", value: "2026" };
    const secondPartition = { key: "year", value: "2027" };
    const month = { key: "month", value: "08" };
    const secondMonth = { key: "month", value: "09" };
    const after = { key: "year", value: "2027" };
    vi.spyOn(desktop, "getDatasetPartitions").mockImplementation(
      async (_generation, parent, cursor) =>
        parent.length === 0 && cursor === null
          ? {
              nodes: [
                { partition, memberCount: 2 },
                { partition: secondPartition, memberCount: 1 },
              ],
              nextAfter: after,
            }
          : parent.length === 1 &&
              parent[0]!.value === partition.value &&
              cursor === null
            ? { nodes: [{ partition: month, memberCount: 2 }], nextAfter: null }
            : parent.length === 1 && cursor === null
              ? {
                  nodes: [{ partition: secondMonth, memberCount: 1 }],
                  nextAfter: null,
                }
              : { nodes: [], nextAfter: null },
    );
    let resolveFirstSelection:
      ((member: desktop.DatasetMemberSummary) => void) | undefined;
    vi.spyOn(desktop, "selectDatasetStructureMember")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSelection = resolve;
          }),
      )
      .mockResolvedValue({
        ordinal: 0,
        relativePath: "part-0.parquet",
        partitions: [],
      });

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );
    await waitFor(() => expect(dataGridProps).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    fireEvent.click(await screen.findByText("Dataset file"));

    expect(
      await screen.findByRole("tree", { name: "Dataset partition values" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("treeitem", { name: /year=2026/ }),
    ).toBeVisible();
    expect(
      await screen.findByRole("treeitem", { name: /year=2027/ }),
    ).toBeVisible();
    const memberGrid = structureGridProps.mock.calls
      .map(
        ([props]) =>
          props as {
            label: string;
            onViewportChange: (start: number, count: number) => void;
            onActivateRow: (row: number) => void;
            getCell: (row: number, column: string) => unknown;
          },
      )
      .find((props) => props.label === "Dataset members");
    act(() => memberGrid?.onViewportChange(450, 20));
    await waitFor(() =>
      expect(desktop.getDatasetMembers).toHaveBeenCalledWith(7, 400, 256),
    );
    const updatedMemberGrid = structureGridProps.mock.calls
      .map(([props]) => props as typeof memberGrid)
      .findLast((props) => props?.label === "Dataset members");
    expect(updatedMemberGrid?.getCell(400, "path")).toMatchObject({
      text: "part-400.parquet",
    });
    const unit = screen.getByRole("group", { name: "Size" });
    fireEvent.click(
      within(unit).getByRole("button", { name: "Before compression" }),
    );
    fireEvent.click(screen.getByText("Inspect chunk map"));
    fireEvent.click(await screen.findByRole("button", { name: "Codec" }));
    expect(screen.getByRole("button", { name: "Codec" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => updatedMemberGrid?.onActivateRow(400));
    await waitFor(() =>
      expect(desktop.selectDatasetStructureMember).toHaveBeenCalledWith(7, 400),
    );
    const summariesBeforeReturn = vi.mocked(desktop.getStructureSummary).mock
      .calls.length;
    act(() =>
      resolveFirstSelection?.({
        ordinal: 400,
        relativePath: "part-400.parquet",
        partitions: [],
      }),
    );
    await waitFor(() =>
      expect(desktop.selectDatasetStructureMember).toHaveBeenLastCalledWith(
        7,
        400,
      ),
    );
    await waitFor(() =>
      expect(desktop.getStructureSummary).toHaveBeenCalledTimes(
        summariesBeforeReturn + 1,
      ),
    );
    expect(
      within(unit).getByRole("button", { name: "Before compression" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByText("Inspect chunk map"));
    expect(
      await screen.findByRole("button", { name: "Codec" }),
    ).toHaveAttribute("aria-pressed", "true");

    const firstYear = screen.getByRole("treeitem", { name: /year=2026/ });
    const secondYear = screen.getByRole("treeitem", { name: /year=2027/ });
    fireEvent.click(firstYear);
    fireEvent.click(secondYear);
    await waitFor(() =>
      expect(desktop.getDatasetPartitions).toHaveBeenCalledWith(
        7,
        [partition],
        null,
        256,
      ),
    );
    await waitFor(() =>
      expect(desktop.getDatasetPartitions).toHaveBeenCalledWith(
        7,
        [secondPartition],
        null,
        256,
      ),
    );
    expect(firstYear).toHaveAttribute("aria-expanded", "true");
    expect(secondYear).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("treeitem", { name: /month=08/ }),
    ).toBeVisible();
    expect(
      await screen.findByRole("treeitem", { name: /month=09/ }),
    ).toBeVisible();
    await waitFor(() =>
      expect(desktop.getDatasetPartitions).toHaveBeenCalledWith(
        7,
        [],
        after,
        256,
      ),
    );
    expect(screen.queryByText("Next partitions")).not.toBeInTheDocument();
  });

  it("drops a late virtual member page after its dataset generation closes", async () => {
    listedSources = [listedDataset(7)];
    vi.mocked(desktop.openLocalFolder).mockResolvedValue(
      datasetProvisionalSummary(),
    );
    vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(
      new ArrayBuffer(1),
    );
    const readyStatus = datasetReadyStatus();
    if (readyStatus.state === "ready") readyStatus.summary.memberCount = 600;
    vi.spyOn(desktop, "getDatasetStatus").mockResolvedValue(readyStatus);
    let resolvePage: ((page: desktop.DatasetMemberPage) => void) | undefined;
    vi.spyOn(desktop, "getDatasetMembers").mockImplementation(
      async (_generation, offset) =>
        offset === 0
          ? { offset: 0, total: 600, members: [] }
          : new Promise((resolve) => {
              resolvePage = resolve;
            }),
    );
    vi.mocked(desktop.closeOpenedSource).mockImplementation(async () => {
      listedSources = [];
      return true;
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder as dataset" }),
    );
    await waitFor(() => expect(dataGridProps).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    fireEvent.click(screen.getByText("Dataset file"));
    const memberGrid = await waitFor(() => {
      const props = structureGridProps.mock.calls
        .map(
          ([candidate]) =>
            candidate as {
              label: string;
              onViewportChange: (start: number, count: number) => void;
            },
        )
        .findLast((candidate) => candidate.label === "Dataset members");
      expect(props).toBeDefined();
      return props!;
    });
    act(() => memberGrid.onViewportChange(450, 20));
    await waitFor(() =>
      expect(desktop.getDatasetMembers).toHaveBeenCalledWith(7, 400, 256),
    );
    await act(async () => requestCloseSource?.(7));
    const rendersAfterClose = structureGridProps.mock.calls.length;
    await act(async () =>
      resolvePage?.({
        offset: 400,
        total: 600,
        members: [
          { ordinal: 400, relativePath: "late.parquet", partitions: [] },
        ],
      }),
    );

    expect(structureGridProps).toHaveBeenCalledTimes(rendersAfterClose);
    expect(screen.queryByText("dataset/")).not.toBeInTheDocument();
  });

  it("detaches a cancelled source open and ignores its stale result", async () => {
    let resolveOpen:
      ((source: desktop.OpenedSourceBatch | null) => void) | undefined;
    vi.spyOn(desktop, "openLocalSource").mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );
    vi.mocked(desktop.getSourceOpenProgress).mockResolvedValue("readingFooter");

    render(<App />);
    fireEvent.click(await readyOpenButton());
    expect(
      await screen.findByText("Reading the Parquet footer…"),
    ).toHaveAttribute("role", "status");
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel opening" }),
    );

    expect(desktop.cancelSourceOpen).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled();
    await act(async () =>
      resolveOpen?.({ sources: [sourceSummary()], sourceError: null }),
    );
    expect(screen.queryByText("people.parquet")).not.toBeInTheDocument();
    expect(dataGridProps).not.toHaveBeenCalled();
  });

  it("discards a late local-open result after native confirms cancellation", async () => {
    let resolveOpen:
      ((source: desktop.OpenedSourceBatch | null) => void) | undefined;
    vi.spyOn(desktop, "openLocalSource").mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );
    vi.mocked(desktop.getSourceOpenProgress).mockResolvedValue("readingFooter");

    render(<App />);
    fireEvent.click(await readyOpenButton());
    expect(
      await screen.findByText("Reading the Parquet footer…"),
    ).toHaveAttribute("role", "status");
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel opening" }),
    );

    const attempt = vi.mocked(desktop.openLocalSource).mock.calls[0]?.[0];
    expect(desktop.cancelSourceOpen).toHaveBeenCalledWith(attempt);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Parquet file…" }),
      ).toBeEnabled(),
    );
    await act(async () =>
      resolveOpen?.({ sources: [sourceSummary()], sourceError: null }),
    );
    expect(screen.queryByText("people.parquet")).not.toBeInTheDocument();
  });

  it("treats dialog cancellation as an unchanged empty state", async () => {
    vi.spyOn(desktop, "openLocalSource").mockResolvedValue(null);

    render(<App />);
    fireEvent.click(await readyOpenButton());

    expect(
      await screen.findByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("groups a multi-file dialog only while Alt is held and resets on blur", async () => {
    vi.spyOn(desktop, "openLocalSource").mockResolvedValue(null);
    render(<App />);

    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.click(await readyOpenButton());
    await waitFor(() =>
      expect(desktop.openLocalSource).toHaveBeenCalledWith(
        expect.any(String),
        true,
      ),
    );
    fireEvent.blur(window);
    fireEvent.click(await readyOpenButton());
    await waitFor(() =>
      expect(desktop.openLocalSource).toHaveBeenLastCalledWith(
        expect.any(String),
        false,
      ),
    );
  });

  it("keeps published batch sources visible beside a path-free partial error", async () => {
    listedSources = [listedSource(1, "people.parquet")];
    vi.spyOn(desktop, "openLocalSource").mockResolvedValue({
      sources: [sourceSummary()],
      sourceError: {
        code: "invalidMember",
        member: "year=2026/broken.parquet",
      },
    });
    render(<App />);

    fireEvent.click(await readyOpenButton());

    expect(await screen.findByText("people.parquet")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "year=2026/broken.parquet",
    );
  });

  it("renders a recoverable source error from the stable taxonomy", async () => {
    vi.spyOn(desktop, "openLocalSource").mockRejectedValue(
      new desktop.OpenSourceError("corruptFooter"),
    );

    render(<App />);
    fireEvent.click(await readyOpenButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Parquet footer is damaged or incomplete.",
    );
    expect(
      screen.getByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled();
  });

  it("renders a path-free source forwarded by native file activation", async () => {
    listedSources = [listedSource(2, "launched.parquet")];
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        source: {
          generation: 2,
          displayName: "launched.parquet",
          sizeBytes: 128,
          rowCount: 3,
          rowGroupCount: 1,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
        sourceError: null,
      });
    render(<App />);

    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));
    act(() => reportOpenedSource?.());

    expect(
      (await screen.findByText("launched.parquet")).closest(".file-context"),
    ).not.toBeNull();
  });

  it("merges a partial post-update restore after an explicit activation", async () => {
    listedSources = [listedSource(2, "launched.parquet")];
    let resolveRestore: (
      state: desktop.PostUpdateState | null,
    ) => void = () => {};
    vi.spyOn(desktop, "takePostUpdateState").mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      }),
    );
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce({
        source: {
          generation: 2,
          displayName: "launched.parquet",
          sizeBytes: 128,
          rowCount: 3,
          rowGroupCount: 1,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
        sourceError: null,
      })
      .mockResolvedValue(null);
    render(<App />);

    expect(await screen.findByText("launched.parquet")).toBeInTheDocument();
    listedSources = [
      listedSource(2, "launched.parquet"),
      { ...listedSource(1, "restored.parquet"), active: false },
    ];
    await act(async () => {
      resolveRestore({
        version: "0.1.0",
        sources: [
          {
            generation: 1,
            displayName: "restored.parquet",
            sizeBytes: 256,
            rowCount: 6,
            rowGroupCount: 1,
            columnCount: 0,
            schema: [],
            schemaNodeCount: 0,
            schemaIsTruncated: false,
            stringsTruncated: false,
          },
        ],
        sourceError: null,
        restoreIncomplete: false,
      });
    });

    expect(screen.getByText("launched.parquet")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(
      await screen.findByRole("option", { name: /restored\.parquet/ }),
    ).toBeInTheDocument();
  });

  it("shows one global warning when an update restores only some sources", async () => {
    listedSources = [listedSource(1, "restored.parquet")];
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.2.0",
      sources: [sourceSummary(1, "restored.parquet")],
      sourceError: null,
      restoreIncomplete: true,
    });

    render(<App />);

    expect(
      await screen.findByText(
        "The update installed, but some sources could not be reopened.",
      ),
    ).toHaveAttribute("role", "status");
    expect(
      screen.getAllByText(/some sources could not be reopened/),
    ).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("switches and closes independent file sessions in native MRU order", async () => {
    listedSources = [
      {
        ...listedSource(2, "part-0.parquet"),
        directory: "~/data/2026/08",
        path: "/data/2026/08/part-0.parquet",
      },
      {
        ...listedSource(1, "part-0.parquet", false),
        directory: "~/data/2026/07",
        path: "/data/2026/07/part-0.parquet",
      },
    ];
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0",
      sourceError: null,
      restoreIncomplete: false,
      sources: [
        {
          generation: 2,
          displayName: "part-0.parquet",
          sizeBytes: 16,
          rowCount: 2,
          rowGroupCount: 1,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
        {
          generation: 1,
          displayName: "part-0.parquet",
          sizeBytes: 8,
          rowCount: 1,
          rowGroupCount: 1,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
      ],
    });

    render(<App />);
    const title = await screen.findByRole("button", { name: "Switch sources" });
    expect(title).toHaveTextContent("part-0.parquet— 08· 2▾");

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const openRows = await screen.findAllByRole("option", {
      name: /part-0\.parquet/,
    });
    expect(
      openRows.map((row) =>
        row.closest(".file-switcher-row")?.getAttribute("title"),
      ),
    ).toEqual(["/data/2026/08/part-0.parquet", "/data/2026/07/part-0.parquet"]);
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search sources" }),
      {
        key: "Escape",
      },
    );

    vi.spyOn(desktop, "cycleOpenedSource").mockImplementation(async () => {
      listedSources = [
        { ...listedSources[1]!, active: true },
        { ...listedSources[0]!, active: false },
      ];
      return 1;
    });
    expect(fireEvent.keyDown(window, { key: "Tab", ctrlKey: true })).toBe(
      false,
    );
    await waitFor(() =>
      expect(desktop.cycleOpenedSource).toHaveBeenCalledWith(false),
    );
    act(() => requestCloseSource?.(2));
    await waitFor(() =>
      expect(desktop.closeOpenedSource).toHaveBeenCalledWith(2),
    );
  });

  it("retains Structure mode, unit, and chunk map lens per file generation", async () => {
    const second = listedSource(2, "second.parquet", true);
    const first = listedSource(1, "first.parquet", false);
    let secondLoads = 0;
    let resolveSecondRefresh:
      ((summary: desktop.StructureSummary) => void) | undefined;
    vi.mocked(desktop.getStructureSummary).mockImplementation((generation) => {
      if (generation !== 2 || secondLoads++ === 0) {
        return Promise.resolve(structureSummary);
      }
      return new Promise((resolve) => {
        resolveSecondRefresh = resolve;
      });
    });
    vi.mocked(desktop.activateOpenedSource).mockImplementation(
      async (generation) => {
        listedSources = listedSources.map((entry) => ({
          ...entry,
          active: entry.generation === generation,
        }));
      },
    );
    renderWithOpenSources(second, first);

    await screen.findByText("second.parquet");
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    const size = await screen.findByRole("group", { name: "Size" });
    fireEvent.click(
      within(size).getByRole("button", { name: "Before compression" }),
    );
    fireEvent.click(screen.getByText("Inspect chunk map"));
    fireEvent.click(await screen.findByRole("button", { name: "Codec" }));
    const secondPanel = document.querySelector(
      ".structure-mode-panel:not([hidden])",
    ) as HTMLElement;
    secondPanel.scrollTop = 137;

    fireEvent.click(screen.getByRole("button", { name: "Switch sources" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /first\.parquet/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    expect(
      within(await screen.findByRole("group", { name: "Size" })).getByRole(
        "button",
        { name: "On disk" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(
        document.querySelector(
          ".structure-mode-panel:not([hidden])",
        ) as HTMLElement,
      ).getByLabelText("Columns"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch sources" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /second\.parquet/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(desktop.getStructureSummary).toHaveBeenCalledWith(2);
    expect(desktop.getStructureSummary).toHaveBeenCalledWith(1);
    await waitFor(() =>
      expect(
        vi
          .mocked(desktop.getStructureSummary)
          .mock.calls.filter(([generation]) => generation === 2),
      ).toHaveLength(2),
    );
    const reactivatedPanel = document.querySelector(
      ".structure-mode-panel:not([hidden])",
    ) as HTMLElement;
    const reactivatedSource = reactivatedPanel.querySelector(
      '.source-view[aria-label="Parquet source"]',
    ) as HTMLElement;
    const buttonNamed = (name: string) =>
      Array.from(reactivatedSource.querySelectorAll("button")).find(
        (button) => button.textContent === name,
      ) as HTMLButtonElement;
    expect(reactivatedPanel).toBe(secondPanel);
    expect(reactivatedSource).toHaveAttribute("aria-busy", "true");
    expect(reactivatedSource).toHaveAttribute("inert");
    expect(
      within(reactivatedSource).getByText("Refreshing file structure…"),
    ).toHaveClass("visually-hidden");
    expect(
      reactivatedSource.querySelector('section[aria-label="Chunk overview"]'),
    ).toBeInTheDocument();
    expect(buttonNamed("Before compression")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(buttonNamed("Codec")).toHaveAttribute("aria-pressed", "true");
    expect(reactivatedPanel.scrollTop).toBe(137);

    const layoutCallsBeforeRefresh = vi
      .mocked(desktop.getStructureLayout)
      .mock.calls.filter(([generation]) => generation === 2).length;
    const onDisk = buttonNamed("On disk");
    fireEvent.click(onDisk);
    expect(
      vi
        .mocked(desktop.getStructureLayout)
        .mock.calls.filter(([generation]) => generation === 2),
    ).toHaveLength(layoutCallsBeforeRefresh);
    expect(onDisk).toHaveAttribute("aria-pressed", "false");

    await act(async () => resolveSecondRefresh?.(structureSummary));
    await waitFor(() => {
      expect(reactivatedSource).not.toHaveAttribute("aria-busy");
      expect(reactivatedSource).not.toHaveAttribute("inert");
    });
    fireEvent.click(onDisk);
    await waitFor(() =>
      expect(
        vi
          .mocked(desktop.getStructureLayout)
          .mock.calls.filter(([generation]) => generation === 2),
      ).toHaveLength(layoutCallsBeforeRefresh + 1),
    );
    expect(onDisk).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores late row-offset navigation after A switches to B and back", async () => {
    const first = listedSource(1, "first.parquet", true);
    const second = listedSource(2, "second.parquet", false);
    vi.mocked(desktop.activateOpenedSource).mockImplementation(
      async (generation) => {
        listedSources = listedSources.map((entry) => ({
          ...entry,
          active: entry.generation === generation,
        }));
      },
    );
    vi.mocked(desktop.getStructureLayout).mockResolvedValue({
      columns: [],
      remainingColumnCount: 0,
      overview: [],
      rows: [
        {
          index: 0,
          compressedBytes: 100,
          uncompressedBytes: 200,
          isReadable: true,
          hasLayoutFacts: true,
          segments: [],
          tail: null,
        },
      ],
    });
    let resolveRowOffset: ((row: number) => void) | undefined;
    vi.mocked(desktop.getStructureRowOffset).mockReturnValue(
      new Promise((resolve) => {
        resolveRowOffset = resolve;
      }),
    );
    renderWithOpenSources(first, second);

    await screen.findByText("first.parquet");
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    fireEvent.click(await screen.findByText("Inspect chunk map"));
    fireEvent.doubleClick(await screen.findByRole("button", { name: "RG 0" }));
    expect(desktop.getStructureRowOffset).toHaveBeenCalledWith(1, 0);

    fireEvent.click(screen.getByRole("button", { name: "Switch sources" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /second\.parquet/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch sources" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /first\.parquet/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await act(async () => resolveRowOffset?.(42));

    expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const firstGridCalls = dataGridProps.mock.calls
      .map(
        ([props]) =>
          props as { source: desktop.SourceSummary; requestedRow: unknown },
      )
      .filter(({ source }) => source.generation === 1);
    expect(firstGridCalls.at(-1)?.requestedRow).toBeNull();
  });

  it("does not resurrect a closed file when its Structure load resolves late", async () => {
    const first = listedSource(1, "first.parquet", true);
    const second = listedSource(2, "second.parquet", false);
    let resolveFirst: ((summary: desktop.StructureSummary) => void) | undefined;
    vi.mocked(desktop.getStructureSummary).mockImplementation((generation) =>
      generation === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(structureSummary),
    );
    renderWithOpenSources(first, second);

    await screen.findByText("first.parquet");
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    await waitFor(() =>
      expect(desktop.getStructureSummary).toHaveBeenCalledWith(1),
    );

    listedSources = [{ ...second, active: true }];
    await act(async () => requestCloseSource?.(1));
    await waitFor(() =>
      expect(screen.getByText("second.parquet")).toBeInTheDocument(),
    );
    await act(async () => resolveFirst?.(structureSummary));

    expect(screen.queryByText("first.parquet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("dismisses the switcher when native closes its last open file", async () => {
    renderWithOpenSources(listedSource(1, "single.parquet"));
    vi.spyOn(desktop, "closeOpenedSource").mockImplementation(async () => {
      listedSources = [];
      return true;
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch sources" }),
    );
    await waitFor(() => expect(requestCloseSource).toBeTypeOf("function"));
    act(() => requestCloseSource?.(1));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Source switcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No file open")).toBeInTheDocument();
  });

  it.each([
    {
      condition: "export cancellation leaves native close unconfirmed",
      outcome: false,
      expectedListCalls: 0,
    },
    {
      condition: "native close rejects while the file remains open",
      outcome: new Error("native close failed"),
      expectedListCalls: 1,
    },
  ])(
    "keeps the switcher open when $condition",
    async ({ outcome, expectedListCalls }) => {
      renderWithOpenSources(listedSource(1, "single.parquet"));
      let settleClose = () => {};
      vi.spyOn(desktop, "closeOpenedSource").mockImplementation(
        () =>
          new Promise<boolean>((resolve, reject) => {
            settleClose = () => {
              if (outcome instanceof Error) reject(outcome);
              else resolve(outcome);
            };
          }),
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "Switch sources" }),
      );
      const listCalls = vi.mocked(desktop.listOpenedSources).mock.calls.length;
      fireEvent.click(
        screen.getByRole("button", { name: "Close single.parquet" }),
      );

      await waitFor(() =>
        expect(desktop.closeOpenedSource).toHaveBeenCalledWith(1),
      );
      await act(async () => settleClose());
      expect(desktop.listOpenedSources).toHaveBeenCalledTimes(
        listCalls + expectedListCalls,
      );
      expect(
        screen.getByRole("region", { name: "Source switcher" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /single\.parquet/ }),
      ).toBeInTheDocument();
    },
  );

  it("dismisses after a rejected native close if the source is gone", async () => {
    renderWithOpenSources(listedSource(1, "single.parquet"));
    vi.spyOn(desktop, "closeOpenedSource").mockImplementation(async () => {
      listedSources = [];
      throw new Error("native response was lost");
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch sources" }),
    );
    act(() => requestCloseSource?.(1));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Source switcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No file open")).toBeInTheDocument();
  });

  it("dismisses after two open rows are closed without waiting between clicks", async () => {
    renderWithOpenSources(
      listedSource(2, "second.parquet"),
      listedSource(1, "first.parquet", false),
    );
    vi.spyOn(desktop, "closeOpenedSource").mockImplementation(
      async (generation) => {
        listedSources = listedSources.filter(
          (source) => source.generation !== generation,
        );
        return true;
      },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch sources" }),
    );
    const firstClose = screen.getByRole("button", {
      name: "Close first.parquet",
    });
    const secondClose = screen.getByRole("button", {
      name: "Close second.parquet",
    });
    fireEvent.click(firstClose);
    fireEvent.click(secondClose);

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Source switcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(desktop.closeOpenedSource).toHaveBeenCalledTimes(2);
  });

  it("ignores an older empty listing after a newer file is synchronized", async () => {
    renderWithOpenSources(listedSource(1, "old.parquet"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch sources" }),
    );
    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));

    let resolveOldListing: (
      entries: desktop.OpenedSourceEntry[],
    ) => void = () => undefined;
    vi.mocked(desktop.listOpenedSources)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldListing = resolve;
          }),
      )
      .mockResolvedValueOnce([listedSource(2, "new.parquet")]);
    const listCalls = vi.mocked(desktop.listOpenedSources).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Close old.parquet" }));
    await waitFor(() =>
      expect(desktop.listOpenedSources).toHaveBeenCalledTimes(listCalls + 1),
    );

    vi.mocked(desktop.takeOpenedSource)
      .mockResolvedValueOnce({
        source: {
          generation: 2,
          displayName: "new.parquet",
          sizeBytes: 8,
          rowCount: 1,
          rowGroupCount: 1,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
        sourceError: null,
      })
      .mockResolvedValueOnce(null);
    act(() => reportOpenedSource?.());

    expect(
      await screen.findByRole("option", { name: /new\.parquet/ }),
    ).toBeInTheDocument();
    const recentCalls = vi.mocked(desktop.getRecentSources).mock.calls.length;
    await act(async () => resolveOldListing([]));
    await waitFor(() =>
      expect(desktop.getRecentSources).toHaveBeenCalledTimes(recentCalls + 1),
    );

    expect(
      screen.getByRole("option", { name: /new\.parquet/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No file open")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Source switcher" }),
    ).toBeInTheDocument();
  });

  it("captures Ctrl+Tab and serializes rapid native MRU cycles", async () => {
    listedSources = [listedSource(1, "single.parquet")];
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce({
        source: {
          generation: 1,
          displayName: "single.parquet",
          sizeBytes: 8,
          rowCount: 1,
          rowGroupCount: 1,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
        sourceError: null,
      })
      .mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByText("single.parquet")).toBeInTheDocument();

    let resolveFirst = () => {};
    vi.mocked(desktop.cycleOpenedSource)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve(1);
          }),
      )
      .mockResolvedValue(null);

    expect(fireEvent.keyDown(window, { key: "Tab", ctrlKey: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(window, { key: "Tab", ctrlKey: true })).toBe(
      false,
    );
    await waitFor(() =>
      expect(desktop.cycleOpenedSource).toHaveBeenCalledOnce(),
    );
    act(resolveFirst);
    await waitFor(() =>
      expect(desktop.cycleOpenedSource).toHaveBeenCalledTimes(2),
    );
    expect(desktop.cycleOpenedSource).toHaveBeenNthCalledWith(2, false);
  });

  it("shows a recoverable error for a missing native file activation", async () => {
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        source: null,
        sourceError: { code: "notFound" },
      });
    render(<App />);

    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));
    act(() => reportOpenedSource?.());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is no longer available. Choose it again.",
    );
  });

  it("reconciles an installed source when a later native activation only reports an error", async () => {
    const installed = sourceSummary(2, "installed.parquet");
    let resolveSummary: (summary: desktop.SourceSummary) => void = () => {};
    vi.mocked(desktop.getOpenedSourceSummary).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
    );
    vi.mocked(desktop.takeOpenedSource)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        source: null,
        sourceError: { code: "notFound" },
      })
      .mockResolvedValueOnce(null);
    render(<App />);

    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));
    listedSources = [listedSource(2, "installed.parquet")];
    act(() => reportOpenedSource?.());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is no longer available. Choose it again.",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(desktop.getOpenedSourceSummary).toHaveBeenCalledWith(2);

    await act(async () => resolveSummary(installed));
    expect(await screen.findByText("installed.parquet")).toBeInTheDocument();

    vi.mocked(desktop.takeOpenedSource)
      .mockResolvedValueOnce({
        source: null,
        sourceError: { code: "notFound" },
      })
      .mockResolvedValueOnce(null);
    act(() => reportOpenedSource?.());
    await waitFor(() =>
      expect(desktop.listOpenedSources).toHaveBeenCalledTimes(2),
    );
    expect(desktop.getOpenedSourceSummary).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("restores a pending export close dialog when the webview mounts", async () => {
    vi.mocked(desktop.getPendingDataExportCloseDialog).mockResolvedValue({
      message:
        "“orders-view.csv” is still being exported. If you close Viewda now, the unfinished file will be deleted.",
      destructiveButton: "Close Viewda",
    });

    render(<App />);

    const dialog = await screen.findByRole("dialog", {
      name: "Export in progress",
    });
    expect(dialog).toHaveTextContent("orders-view.csv");
    expect(
      within(dialog).getByRole("button", { name: "Close Viewda" }),
    ).toBeInTheDocument();
  });

  it("keeps a running export when the close dialog is dismissed", async () => {
    render(<App />);

    await waitFor(() => expect(requestDataExportClose).toBeTypeOf("function"));
    act(() =>
      requestDataExportClose?.({
        message:
          "“orders-view.csv” is still being exported. If you close Viewda now, the unfinished file will be deleted.",
        destructiveButton: "Close Viewda",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Export in progress",
    });
    expect(dialog).toHaveTextContent("orders-view.csv");
    expect(dialog).toHaveTextContent("unfinished file will be deleted");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Keep Exporting" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() =>
      expect(desktop.resolveDataExportCloseDialog).toHaveBeenCalledWith(false),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the explicit destructive action to cancel the export and close", async () => {
    render(<App />);

    await waitFor(() => expect(requestDataExportClose).toBeTypeOf("function"));
    act(() =>
      requestDataExportClose?.({
        message: "2 exports are still running.",
        destructiveButton: "Close Viewda",
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Close Viewda" }),
    );

    await waitFor(() =>
      expect(desktop.resolveDataExportCloseDialog).toHaveBeenCalledWith(true),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("installs an available update directly from the titlebar", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockImplementation((onProgress) => {
        onProgress({ percent: 37 });
        return new Promise<boolean>(() => {});
      });

    render(<App />);

    const indicator = await screen.findByRole("button", {
      name: "update to 0.1.0",
    });
    expect(desktop.checkForUpdate).toHaveBeenCalledWith({
      automaticCheck: true,
    });
    fireEvent.click(indicator);

    expect(install).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("updating…");
    expect(
      screen.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("aria-valuenow", "37");
  });

  it("shows indeterminate progress when the update size is unknown", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    vi.spyOn(desktop, "installPendingUpdate").mockReturnValue(
      new Promise<boolean>(() => {}),
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    );

    const progress = screen.getByRole("progressbar", {
      name: "Downloading update",
    });
    expect(progress).toHaveClass("is-indeterminate");
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });

  it("keeps a failed update actionable for retry", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockRejectedValueOnce(new Error("download failed"))
      .mockReturnValue(new Promise<boolean>(() => {}));

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    );

    const retry = await screen.findByRole("button", {
      name: "update to 0.1.0",
    });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);

    expect(install).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("updating…");
  });

  it("keeps an available update when the export cancellation is declined", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    vi.spyOn(desktop, "installPendingUpdate").mockResolvedValue(false);

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    );

    expect(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("The update could not be installed. Try again."),
    ).not.toBeInTheDocument();
  });

  it("uses the same titlebar indicator for an update found by the native menu", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    render(<App />);

    await waitFor(() => expect(reportUpdate).toBeTypeOf("function"));
    expect(desktop.checkForUpdate).not.toHaveBeenCalled();
    act(() =>
      reportUpdate?.({
        version: "0.0.3",
        currentVersion: "0.0.1",
        isDowngrade: false,
      }),
    );

    expect(
      screen.getByRole("button", { name: "update to 0.0.3" }),
    ).toBeInTheDocument();
  });

  it("opens Settings from the native menu and persists update controls", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    const persist = vi.spyOn(desktop, "setUpdateSettings");
    const persistMemory = vi.spyOn(desktop, "setDataViewSettings");
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByRole("button", { name: "Make default" }),
    ).toBeInTheDocument();
    const defaultApplicationLabel = within(dialog).getByText(
      "Default application",
    );
    const defaultApplicationCopy =
      defaultApplicationLabel.closest(".settings-row-copy");
    expect(defaultApplicationCopy).toContainElement(
      within(dialog).getByText("Open .parquet files in Viewda by default."),
    );
    expect(defaultApplicationLabel).toHaveClass("settings-row-label");
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toHaveClass("tonal-button");
    expect(within(dialog).getByText("0.0.1 · DuckDB v1.5.5")).toHaveClass(
      "settings-version",
    );
    expect(
      within(dialog).getByText(/Grid windows are not affected/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/up to 90% of the drive's currently free space/),
    ).toBeInTheDocument();
    const performanceHelp = within(dialog)
      .getByText("How memory and temporary disk work", { selector: "summary" })
      .closest("details");
    expect(performanceHelp).not.toHaveAttribute("open");
    fireEvent.change(within(dialog).getByLabelText("Preparation memory"), {
      target: { value: "mb1536" },
    });
    await waitFor(() =>
      expect(persistMemory).toHaveBeenCalledWith({ memoryLimit: "mb1536" }),
    );
    const theme = screen.getByLabelText("Theme");
    expect(theme).toHaveFocus();
    const channel = screen.getByLabelText("Update channel");
    fireEvent.change(channel, { target: { value: "latest" } });
    await waitFor(() =>
      expect(persist).toHaveBeenCalledWith({
        channel: "latest",
        automaticChecks: false,
      }),
    );

    fireEvent.click(screen.getByLabelText("Automatic update checks"));
    await waitFor(() =>
      expect(persist).toHaveBeenCalledWith({
        channel: "latest",
        automaticChecks: true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(
      await screen.findByText("Viewda is up to date."),
    ).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Make default" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("applies and persists an explicit theme immediately", async () => {
    const persist = vi.spyOn(desktop, "setThemePreference");
    render(<App initialTheme="light" />);

    const dialog = await openSettings();
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.change(within(dialog).getByLabelText("Theme"), {
      target: { value: "dark" },
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(persist).toHaveBeenCalledWith("dark"));
  });

  it("keeps System mode synchronized with live OS theme changes", async () => {
    render(<App initialTheme="system" />);
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      systemDark = true;
      const event = new Event("change");
      for (const listener of themeChangeListeners) {
        listener(event);
      }
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() =>
      expect(desktop.syncSystemTheme).toHaveBeenLastCalledWith("dark"),
    );
  });

  it("changes the default application only after the Settings action", async () => {
    const makeDefault = vi.spyOn(desktop, "setDefaultApplication");
    render(<App />);

    const dialog = await openSettings();
    expect(makeDefault).not.toHaveBeenCalled();
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Make default" }),
    );

    expect(
      await within(dialog).findByText("Viewda is the default"),
    ).toHaveClass("settings-note");
    expect(makeDefault).toHaveBeenCalledOnce();
  });

  it("defers the Windows default choice to system Settings", async () => {
    vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
      kind: "systemSettings",
    });
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByText("Finish the choice in Windows Settings."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open Default apps" }),
    );
    expect(desktop.setDefaultApplication).toHaveBeenCalledOnce();
  });

  it("disables the Linux action when xdg-utils is unavailable", async () => {
    vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
      kind: "unavailable",
    });
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByText("xdg-utils is not installed."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toBeDisabled();
  });

  it("disables the action for an unintegrated AppImage", async () => {
    vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
      kind: "unintegratedAppImage",
    });
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByText("Integrate the AppImage first."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toBeDisabled();
  });

  it("surfaces a prerelease from the Latest channel without changing its version", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "latest",
      automaticChecks: false,
    });
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.2.0-beta.2",
      currentVersion: "0.2.0-alpha.3",
      isDowngrade: false,
    });
    render(<App />);

    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(
      await screen.findByRole("button", { name: "update to 0.2.0-beta.2" }),
    ).toBeInTheDocument();
  });

  it("restores the source and removes post-update status after one minute", async () => {
    vi.useFakeTimers();
    listedSources = [listedSource(2, "restored.parquet")];
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0",
      sourceError: null,
      restoreIncomplete: false,
      sources: [
        {
          generation: 2,
          displayName: "restored.parquet",
          sizeBytes: 4096,
          rowCount: 12,
          rowGroupCount: 2,
          columnCount: 0,
          schema: [],
          schemaNodeCount: 0,
          schemaIsTruncated: false,
          stringsTruncated: false,
        },
      ],
    });
    render(<App />);
    await act(async () => Promise.resolve());

    expect(
      screen.getByText("restored.parquet").closest(".file-context"),
    ).not.toBeNull();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("updated to 0.1.0 · what's new");

    act(() => vi.advanceTimersByTime(59_800));
    expect(status).toHaveClass("is-dismissing");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens the Rust-owned releases list and explicitly dismisses post-update status", async () => {
    vi.useFakeTimers();
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0-alpha.2",
      sourceError: null,
      restoreIncomplete: false,
      sources: [],
    });
    const openPage = vi.spyOn(desktop, "openReleasesPage");
    render(<App />);
    await act(async () => Promise.resolve());

    const status = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "what's new" }));
    expect(openPage.mock.calls).toEqual([[]]);
    expect(status).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss update status" }),
    );
    expect(status).toHaveClass("is-dismissing");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("simulates the UI flow without calling the installer", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    const install = vi.spyOn(desktop, "installPendingUpdate");
    render(<App />);
    await openSettings();
    const summary = screen.getByText("Debug — for Viewda developers", {
      selector: "summary",
    });
    const debug = summary.closest("details");
    expect(debug).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(debug).toHaveAttribute("open");
    fireEvent.click(
      screen.getByRole("button", { name: "Simulate update flow" }),
    );

    const indicator = screen.getByRole("button", {
      name: /update to 99\.99\.99 simulated/i,
    });
    vi.useFakeTimers();
    fireEvent.click(indicator);
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("updating…simulated");
    const progress = screen.getByRole("progressbar", {
      name: "Downloading update",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "0");

    act(() => vi.advanceTimersByTime(160));
    expect(progress).toHaveAttribute("aria-valuenow", "25");

    act(() => vi.advanceTimersByTime(640));
    expect(screen.getByRole("status")).toHaveTextContent(
      "updated to 99.99.99 · what's new simulated",
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("keeps a stopped grid performance report available for automation and copy fallback", async () => {
    const clipboardWrite = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    render(<App />);
    let dialog = await openSettings();
    let now = 1_000;
    let timerCallback: (() => void) | null = null;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      timerCallback = typeof handler === "function" ? handler : null;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const clearRecordingInterval = vi
      .spyOn(window, "clearInterval")
      .mockImplementation(() => undefined);
    fireEvent.click(
      within(dialog).getByText("Debug — for Viewda developers", {
        selector: "summary",
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Start recording" }),
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Recording grid performance",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const recordingStatus = screen.getByLabelText("Grid performance recording");
    expect(recordingStatus).toHaveTextContent(
      "Recording grid performance0:00Stop recording",
    );
    now = 66_000;
    act(() => timerCallback?.());
    expect(recordingStatus).toHaveTextContent(
      "Recording grid performance1:05Stop recording",
    );
    fireEvent.click(
      within(recordingStatus).getByRole("button", { name: "Stop recording" }),
    );
    expect(clearRecordingInterval).toHaveBeenCalledWith(1);
    const completedStatus = screen.getByLabelText(
      "Grid performance recording completed",
    );
    expect(completedStatus).not.toHaveTextContent(
      "Grid performance report ready",
    );
    const duration = within(completedStatus).getByLabelText(
      "Recording duration 1 minute 5 seconds",
    );
    expect(duration.tagName).toBe("TIME");
    expect(duration).toHaveTextContent("1:05");
    expect(within(completedStatus).queryByText("Copy report")).toBeNull();
    expect(within(completedStatus).queryByText("Record again")).toBeNull();
    const copyReport = within(completedStatus).getByRole("button", {
      name: "Copy report",
    });
    const recordAgain = within(completedStatus).getByRole("button", {
      name: "Record again",
    });
    expect(copyReport).toHaveAttribute("title", "Copy report");
    expect(recordAgain).toHaveAttribute("title", "Record again");
    expect(copyReport).not.toHaveClass("is-copied");
    expect(
      copyReport.querySelector(".grid-performance-copy-glyph"),
    ).toBeInTheDocument();
    expect(
      copyReport.querySelector(".grid-performance-copy-check"),
    ).toBeInTheDocument();
    const completedActions = within(completedStatus).getAllByRole("button");
    expect(completedActions).toHaveLength(3);
    const dismiss = completedActions[completedActions.length - 1];
    if (dismiss === undefined) {
      throw new Error("Completed performance actions are missing.");
    }
    expect(dismiss).toHaveAccessibleName("Dismiss performance report");
    expect(dismiss).toHaveAttribute("title", "Dismiss performance report");

    fireEvent.click(copyReport);
    const copyError = await within(completedStatus).findByRole("status");
    expect(copyError).toHaveTextContent(
      "Copy failed; report remains available in Settings.",
    );
    expect(copyError).toHaveClass("grid-performance-copy-error");
    expect(copyError).toBeVisible();

    fireEvent.click(copyReport);
    await waitFor(() => expect(copyReport).toHaveClass("is-copied"));
    const copySuccess = within(completedStatus).getByRole("status");
    expect(copySuccess).toHaveTextContent("Report copied.");
    expect(copySuccess).toHaveClass("grid-performance-live");
    expect(copySuccess).not.toHaveClass("grid-performance-copy-error");

    fireEvent.click(dismiss);
    expect(
      screen.queryByLabelText("Grid performance recording completed"),
    ).not.toBeInTheDocument();
    dialog = await openSettings();
    fireEvent.click(
      within(dialog).getByText("Debug — for Viewda developers", {
        selector: "summary",
      }),
    );
    const report = within(dialog).getByLabelText("Grid performance report");
    expect(report).toHaveAttribute("readonly");
    expect(JSON.parse((report as HTMLTextAreaElement).value)).toMatchObject({
      schemaVersion: 1,
      runtime: {
        appVersion: "0.0.1",
        queryEngineVersion: "v1.5.5",
        theme: "light",
      },
      grid: { maximumDomCells: 0 },
      wheel: { inputEvents: 0 },
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy report" }),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(3));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Report copied",
    );
    expect(within(dialog).getByLabelText("Grid performance report")).toBe(
      report,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Record again" }),
    );
    expect(
      screen.getByLabelText("Grid performance recording"),
    ).toHaveTextContent("0:00");
    expect(
      within(dialog).queryByLabelText("Grid performance report"),
    ).not.toBeInTheDocument();
  });

  it("asks whether to downgrade or wait when moving from latest to stable", async () => {
    const discard = vi.spyOn(desktop, "discardPendingUpdate");

    await openStableDowngrade();
    expect(desktop.checkForUpdate).toHaveBeenCalledWith({
      allowDowngrade: true,
    });
    const wait = screen.getByRole("button", { name: "Wait for next stable" });
    await waitFor(() => expect(wait).toHaveFocus());
    fireEvent.keyDown(wait, { key: "Escape" });
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("dialog", {
        name: "Stable is currently older.",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("installs a stable downgrade only after the user chooses it", async () => {
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockImplementation((onProgress) => {
        onProgress({ percent: 63 });
        return new Promise<boolean>(() => {});
      });

    await openStableDowngrade();
    fireEvent.click(screen.getByRole("button", { name: "Downgrade to 0.1.0" }));

    expect(install).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(
      screen.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("aria-valuenow", "63");
  });

  it("explains why a Debian package cannot update itself", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    vi.spyOn(desktop, "checkForUpdate").mockRejectedValue(
      new desktop.UpdateCommandError("manualInstall"),
    );

    render(<App />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(
      await screen.findByText(
        "This package uses manual updates. Install the AppImage to update inside Viewda.",
      ),
    ).toBeInTheDocument();
  });
});

describe("shortcutModifierFor", () => {
  it("uses native-looking shortcuts on Apple and non-Apple platforms", () => {
    expect(desktop.shortcutModifierFor("MacIntel")).toBe("⌘");
    expect(desktop.shortcutModifierFor("Win32")).toBe("Ctrl+");
    expect(desktop.shortcutModifierFor("Linux x86_64")).toBe("Ctrl+");
  });
});

describe("formatFileSize", () => {
  it.each([
    [999, "999 B"],
    [1_000, "1.0 kB"],
    [999_999, "1.0 MB"],
    [1_300_000, "1.3 MB"],
    [2_500_000_000, "2.5 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});

async function renderReadyDataset() {
  listedSources = [listedDataset(7)];
  vi.mocked(desktop.openLocalFolder).mockResolvedValue(
    datasetProvisionalSummary(),
  );
  vi.spyOn(desktop, "getDatasetPreview").mockResolvedValue(new ArrayBuffer(1));
  vi.spyOn(desktop, "getDatasetStatus").mockResolvedValue(datasetReadyStatus());
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open folder as dataset" }),
  );
  await waitFor(() => expect(dataGridProps).toHaveBeenCalled());
}

function openDatasetContextMenu() {
  if (screen.queryByRole("option", { name: /dataset/ }) === null) {
    fireEvent.click(screen.getByRole("button", { name: "Switch sources" }));
  }
  fireEvent.contextMenu(screen.getByRole("option", { name: /dataset/ }), {
    clientX: 20,
    clientY: 20,
  });
}

function listedDataset(
  generation: number,
  active = true,
): desktop.OpenedSourceEntry {
  return {
    generation,
    kind: "folderDataset",
    datasetMemberCount: 2,
    datasetIgnoredFileCount: 1,
    name: "dataset/",
    directory: "~/Data",
    path: "/home/test/Data/dataset",
    active,
  };
}

function datasetDiscoveringSourceSummary(): desktop.SourceSummary {
  return {
    generation: 7,
    displayName: "dataset/",
    sizeBytes: 0,
    rowCount: 0,
    rowGroupCount: 0,
    columnCount: 0,
    schema: [],
    schemaNodeCount: 0,
    schemaIsTruncated: false,
    stringsTruncated: false,
  };
}

function datasetProvisionalSummary(): desktop.SourceSummary {
  return {
    generation: 7,
    displayName: "dataset/",
    sizeBytes: 100,
    rowCount: 1,
    rowGroupCount: 1,
    columnCount: 1,
    schema: [
      { name: "id", physicalType: "INT64", logicalType: null, children: [] },
    ],
    schemaNodeCount: 1,
    schemaIsTruncated: false,
    stringsTruncated: false,
  };
}

function datasetReadyStatus(): desktop.DatasetStatus {
  return {
    state: "ready",
    summary: {
      displayName: "dataset/",
      memberCount: 2,
      ignoredFileCount: 1,
      sizeBytes: 200,
      rowCount: 3,
      rowGroupCount: 2,
      columnCount: 2,
      schema: [
        {
          name: "id",
          physicalType: "INT64",
          logicalType: null,
          children: [],
        },
        {
          name: "file",
          physicalType: "BYTE_ARRAY",
          logicalType: "String",
          children: [],
        },
      ],
      schemaNodeCount: 2,
      schemaIsTruncated: false,
      stringsTruncated: false,
      schemaDriftMemberCount: 0,
      partitionColumnIndices: [],
      provenanceColumnIndex: 1,
    },
  };
}

function datasetSampleSummary(): desktop.DatasetReadySummary {
  const ready = datasetReadyStatus();
  if (ready.state !== "ready") throw new Error("ready fixture is invalid");
  return {
    displayName: "dataset/",
    memberCount: 2,
    ignoredFileCount: 1,
    sizeBytes: 120,
    rowCount: 12,
    rowGroupCount: 2,
    columnCount: 2,
    schema: ready.summary.schema,
    schemaNodeCount: 2,
    schemaIsTruncated: false,
    stringsTruncated: false,
    schemaDriftMemberCount: 0,
    partitionColumnIndices: [],
    provenanceColumnIndex: 1,
  };
}

function datasetDiscoveringStatus(sampleReady = false): desktop.DatasetStatus {
  return {
    state: "discovering",
    progress: {
      scannedEntryCount: 9,
      discoveredMemberCount: 5,
      ignoredFileCount: 4,
    },
    sampleSummary: sampleReady ? datasetSampleSummary() : null,
  };
}

function datasetInspectingStatus(): desktop.DatasetStatus {
  return {
    state: "inspecting",
    sampleSummary: datasetSampleSummary(),
    progress: {
      completedMemberCount: 3,
      totalMemberCount: 5,
      rowCount: 21,
      rowGroupCount: 3,
    },
  };
}
