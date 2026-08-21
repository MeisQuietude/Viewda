import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateOpenedSource,
  cancelDataView,
  cancelStructureBloomProbe,
  cancelTextValueSuggestions,
  ColumnStatisticsCommandError,
  DataExportCommandError,
  DataWindowCommandError,
  dismissDataExport,
  getColumnStatistics,
  getDataExportStatus,
  getDataViewSettings,
  getDataWindow,
  getDataViewStatus,
  getStructureColumns,
  getStructureLoadProgress,
  getStructureSummary,
  getTextValueSuggestions,
  probeStructureBloomFilter,
  StructureCommandError,
  installPendingUpdate,
  listOpenedSources,
  prepareDataView,
  revealDataExport,
  revealOpenedSource,
  closeOpenedSource,
  removeRecentSource,
  clearRecentSources,
  cycleOpenedSource,
  setDataViewSettings,
  startDataExport,
  takePostUpdateState,
} from "./desktop";

const { channelHandlers, invokeMock } = vi.hoisted(() => ({
  channelHandlers: [] as Array<(message: unknown) => void>,
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(onmessage: (message: unknown) => void) {
      channelHandlers.push(onmessage);
    }
  },
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ show: vi.fn() })),
}));

describe("desktop seam", () => {
  beforeEach(() => {
    channelHandlers.length = 0;
    vi.clearAllMocks();
  });

  it("passes update progress through the install command channel", async () => {
    invokeMock.mockResolvedValue(true);
    const onProgress = vi.fn();

    await expect(installPendingUpdate(onProgress)).resolves.toBe(true);
    channelHandlers[0]?.({ percent: 42 });

    expect(onProgress).toHaveBeenCalledWith({ percent: 42 });
    expect(invokeMock).toHaveBeenCalledWith("install_pending_update", {
      onProgress: expect.anything(),
    });
  });

  it("reads and persists the preparation memory setting", async () => {
    invokeMock
      .mockResolvedValueOnce({ memoryLimit: "mb384" })
      .mockResolvedValueOnce(undefined);

    await expect(getDataViewSettings()).resolves.toEqual({
      memoryLimit: "mb384",
    });
    await expect(
      setDataViewSettings({ memoryLimit: "mb1536" }),
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_data_view_settings");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "set_data_view_settings", {
      settings: { memoryLimit: "mb1536" },
    });
  });

  it("uses generation-scoped commands for open file sessions", async () => {
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(4);

    await expect(listOpenedSources()).resolves.toEqual([]);
    await expect(activateOpenedSource(7)).resolves.toBeUndefined();
    await expect(closeOpenedSource(7)).resolves.toBe(true);
    await expect(revealOpenedSource(7)).resolves.toBeUndefined();
    await expect(cycleOpenedSource(true)).resolves.toBe(4);

    expect(invokeMock.mock.calls).toEqual([
      ["list_opened_sources"],
      ["activate_opened_source", { generation: 7 }],
      ["close_opened_source", { generation: 7 }],
      ["reveal_opened_source", { generation: 7 }],
      ["cycle_opened_source", { reverse: true }],
    ]);
  });

  it("mutates recent history only through opaque identifiers", async () => {
    invokeMock.mockResolvedValue(undefined);

    await removeRecentSource("recent-4");
    await clearRecentSources();

    expect(invokeMock.mock.calls).toEqual([
      ["remove_recent_source", { id: "recent-4" }],
      ["clear_recent_sources"],
    ]);
  });

  it("passes structure paging and probe arguments through the desktop seam", async () => {
    invokeMock
      .mockResolvedValueOnce({
        offset: 0,
        totalCount: 1,
        totalCompressedBytes: 10,
        totalUncompressedBytes: 30,
        columns: [],
      })
      .mockResolvedValueOnce({
        columnIndex: 1,
        offset: 0,
        totalCount: 1,
        rowGroups: [{ index: 0, outcome: "definitelyAbsent" }],
      })
      .mockResolvedValueOnce(undefined);

    await getStructureColumns(7, "uncompressed", "bytes", "descending", 20, 50);
    await probeStructureBloomFilter(7, 1, "north", 0, 64);
    await cancelStructureBloomProbe(7);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_structure_columns", {
      generation: 7,
      unit: "uncompressed",
      sort: "bytes",
      direction: "descending",
      offset: 20,
      limit: 50,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "probe_structure_bloom_filter",
      { generation: 7, columnIndex: 1, value: "north", offset: 0, limit: 64 },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "cancel_structure_bloom_probe",
      { generation: 7 },
    );
  });

  it("narrows structure failures to their closed code set", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "notLoaded" })
      .mockRejectedValueOnce({ code: "a code this build does not know" });

    const known = await getStructureSummary(1).catch((error: unknown) => error);
    expect(known).toBeInstanceOf(StructureCommandError);
    expect(known).toMatchObject({ code: "notLoaded" });

    await expect(getStructureSummary(1)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("reports an absent structure load as no progress", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(getStructureLoadProgress(3)).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("get_structure_load_progress", {
      generation: 3,
    });
  });

  it("passes text suggestion revisions through the desktop seam", async () => {
    invokeMock
      .mockResolvedValueOnce({
        values: ["Alpha", "Alpine"],
        isPartial: true,
      })
      .mockResolvedValueOnce(undefined);

    await expect(
      getTextValueSuggestions(7, 4, 2, "Al", "textContains"),
    ).resolves.toEqual({
      values: ["Alpha", "Alpine"],
      isPartial: true,
    });
    await expect(cancelTextValueSuggestions(7, 4)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "get_text_value_suggestions",
      {
        generation: 7,
        suggestionRevision: 4,
        columnIndex: 2,
        prefix: "Al",
        operator: "textContains",
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "cancel_text_value_suggestions",
      {
        generation: 7,
        suggestionRevision: 4,
      },
    );
  });

  it("unwraps a restored source error from the Rust wire shape", async () => {
    invokeMock.mockResolvedValue({
      version: "0.1.0",
      sources: [],
      sourceError: { code: "notFound" },
    });

    await expect(takePostUpdateState()).resolves.toEqual({
      version: "0.1.0",
      sources: [],
      sourceError: "notFound",
    });
    expect(invokeMock).toHaveBeenCalledWith("take_post_update_state");
  });

  it.each(["cancelled", "resourceExhausted", "queryFailed"] as const)(
    "keeps the %s statistics error typed",
    async (code) => {
      invokeMock.mockRejectedValue({ code });

      await expect(getColumnStatistics(3, 2, false)).rejects.toEqual(
        new ColumnStatisticsCommandError(code),
      );
      expect(invokeMock).toHaveBeenCalledWith("get_column_statistics", {
        generation: 3,
        columnIndex: 2,
        includeMinMax: false,
      });
    },
  );

  it("passes one view revision through preparation, windows, status and cancellation", async () => {
    const filters = [
      { columnIndex: 2, operator: "range" as const, values: ["-2", "9"] },
    ];
    const sort = [{ sourceIndex: 1, direction: "descending" as const }];
    invokeMock
      .mockResolvedValueOnce({ revision: 3, rowCount: 4 })
      .mockResolvedValueOnce(new ArrayBuffer(0))
      .mockResolvedValueOnce({ revision: 3, rowCount: 4 })
      .mockResolvedValueOnce(undefined);

    const settings = { memoryLimit: "mb768" as const };
    await expect(
      prepareDataView(7, 3, filters, sort, settings),
    ).resolves.toEqual({
      revision: 3,
      rowCount: 4,
    });
    await expect(getDataWindow(7, 3, 0, 512, [1, 3])).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    await expect(getDataViewStatus(7)).resolves.toEqual({
      revision: 3,
      rowCount: 4,
    });
    await expect(cancelDataView(7, 3)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "prepare_data_view", {
      generation: 7,
      viewRevision: 3,
      filters,
      sort,
      settings,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_data_window", {
      generation: 7,
      viewRevision: 3,
      rowOffset: 0,
      rowCount: 512,
      sourceIndices: [1, 3],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "get_data_view_status", {
      generation: 7,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "cancel_data_view", {
      generation: 7,
      viewRevision: 3,
    });
  });

  it.each(["memoryExhausted", "temporaryStorageExhausted"] as const)(
    "keeps the %s preparation diagnostics typed",
    async (code) => {
      const diagnostics = {
        operation: "preparation" as const,
        applicationVersion: "0.1.0-alpha.2",
        operatingSystem: "macos",
        architecture: "aarch64",
        queryEngineVersion: "v1.5.5",
        message: "Out of Memory Error: allocation failed",
        memoryLimit: "366.2 MiB",
        maxTemporaryDirectorySize: "45.0 GiB",
        threads: 10,
        rowCount: 3_514_000,
        sourceSizeBytes: 1_000_000_000,
        rowGroupCount: 29,
        columnCount: 43,
        filterCount: 0,
        sortColumns: [
          {
            physicalType: "INT32",
            logicalType: "UInt16",
            direction: "ascending" as const,
          },
        ],
      };
      invokeMock.mockRejectedValue({ code, diagnostics });

      await expect(
        prepareDataView(7, 1, [], [], { memoryLimit: "mb384" }),
      ).rejects.toEqual(new DataWindowCommandError(code, diagnostics));
    },
  );

  it("drops malformed preparation diagnostics at the native boundary", async () => {
    invokeMock.mockRejectedValue({
      code: "memoryExhausted",
      diagnostics: { message: "/private/source.parquet" },
    });

    await expect(
      prepareDataView(7, 1, [], [], { memoryLimit: "mb384" }),
    ).rejects.toEqual(new DataWindowCommandError("memoryExhausted"));
  });

  it.each([
    "invalidFilter",
    "cancelled",
    "viewChanged",
    "invalidSort",
    "resourceExhausted",
    "queryFailed",
  ] as const)("keeps the %s data-window error typed", async (code) => {
    invokeMock.mockRejectedValue({ code });

    await expect(getDataWindow(7, 0, 0, 1, [0])).rejects.toEqual(
      new DataWindowCommandError(code),
    );
  });

  it("keeps export paths native while passing the active view revision", async () => {
    const request = {
      columnIndices: [3, 1],
      rowRanges: [{ start: 10, end: 20 }],
      output: { format: "csv" as const, options: {} },
    };
    invokeMock.mockResolvedValue({
      state: "running",
      id: 12,
      fileName: "orders-view.csv",
      bytesWritten: 4096,
    });

    await expect(startDataExport(7, 4, "view", request)).resolves.toMatchObject(
      {
        state: "running",
        id: 12,
      },
    );
    expect(invokeMock).toHaveBeenCalledWith("start_data_export", {
      generation: 7,
      viewRevision: 4,
      scope: "view",
      request,
    });
    expect(JSON.stringify(invokeMock.mock.calls[0])).not.toContain("path");
  });

  it("uses narrow commands for export status and dismissal", async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(true);

    await expect(getDataExportStatus(7)).resolves.toBeNull();
    await expect(dismissDataExport(9)).resolves.toBe(true);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_data_export_status", {
      generation: 7,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "dismiss_data_export", {
      id: 9,
    });
  });

  it.each([
    "viewChanged",
    "alreadyRunning",
    "permissionDenied",
    "diskFull",
    "resourceExhausted",
  ] as const)("keeps the %s export error typed", async (code) => {
    invokeMock.mockRejectedValue({ code });

    await expect(
      startDataExport(7, 4, "view", {
        columnIndices: [0],
        rowRanges: [],
        output: { format: "csv", options: {} },
      }),
    ).rejects.toEqual(new DataExportCommandError(code));
    await expect(revealDataExport(4)).rejects.toEqual(
      new DataExportCommandError(code),
    );
  });
});
