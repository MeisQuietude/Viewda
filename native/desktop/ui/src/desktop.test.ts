import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateOpenedSource,
  cancelDataView,
  cancelSourceOpen,
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
  DatasetCommandError,
  getDatasetMembers,
  getDatasetPartitions,
  getDatasetPreview,
  getDatasetStatus,
  getOpenedSourceSummary,
  getSourceOpenProgress,
  getStructureColumns,
  getStructureLoadProgress,
  getStructureSummary,
  getTextValueSuggestions,
  installPendingUpdate,
  listOpenedSources,
  openLocalFolder,
  prepareDataView,
  probeStructureBloomFilter,
  revealDataExport,
  revealOpenedSource,
  reloadOpenedSource,
  closeOpenedSource,
  removeRecentSource,
  clearRecentSources,
  cycleOpenedSource,
  setDataViewSettings,
  startDataExport,
  StructureCommandError,
  takePostUpdateState,
  openLocalSource,
  openRecentSource,
  onDatasetStatusChanged,
  onSourceDragState,
  type DatasetStatus,
} from "./desktop";

const { channelHandlers, invokeMock, listenMock } = vi.hoisted(() => ({
  channelHandlers: [] as Array<(message: unknown) => void>,
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(onmessage: (message: unknown) => void) {
      channelHandlers.push(onmessage);
    }
  },
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
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

  it("forwards the typed native file-drop state and returns its unlisten handle", async () => {
    const unlisten = vi.fn();
    const handler = vi.fn();
    listenMock.mockResolvedValue(unlisten);

    await expect(onSourceDragState(handler)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith(
      "source-drag-state",
      expect.any(Function),
    );
    const nativeHandler = listenMock.mock.calls[0]?.[1] as
      | ((event: {
          payload: {
            state: "enter" | "leave" | "drop";
            kind: "folder" | "files" | "mixed";
          };
        }) => void)
      | undefined;
    nativeHandler?.({ payload: { state: "enter", kind: "folder" } });

    expect(handler).toHaveBeenCalledWith({ state: "enter", kind: "folder" });
  });

  it("forwards the dataset generation from lifecycle notifications", async () => {
    const unlisten = vi.fn();
    const handler = vi.fn();
    listenMock.mockResolvedValue(unlisten);

    await expect(onDatasetStatusChanged(handler)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith(
      "dataset-status-changed",
      expect.any(Function),
    );
    const nativeHandler = listenMock.mock.calls[0]?.[1] as
      ((event: { payload: { generation: number } }) => void) | undefined;
    nativeHandler?.({ payload: { generation: 17 } });

    expect(handler).toHaveBeenCalledWith({ generation: 17 });
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

  it("passes generation-scoped structure paging and probe arguments", async () => {
    invokeMock
      .mockResolvedValueOnce({ offset: 0, totalCount: 1, columns: [] })
      .mockResolvedValueOnce({
        offset: 0,
        totalCount: 1,
        rowGroups: [{ index: 0, outcome: "definitelyAbsent" }],
      })
      .mockResolvedValueOnce(undefined);

    await getStructureColumns(7, "uncompressed", "bytes", "descending", 20, 50);
    await probeStructureBloomFilter(7, "probe-a", 1, "north", 0, 64);
    await cancelStructureBloomProbe(7, "probe-a");

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
      {
        generation: 7,
        request: "probe-a",
        columnIndex: 1,
        value: "north",
        offset: 0,
        limit: 64,
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "cancel_structure_bloom_probe",
      { generation: 7, request: "probe-a" },
    );
  });

  it("uses one opaque attempt for local, recent, and cancellation commands", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ generation: 4 })
      .mockResolvedValueOnce({ generation: 5 })
      .mockResolvedValueOnce("published");

    await openLocalSource("app-session:9");
    await openRecentSource("recent-4", "app-session:10");
    await reloadOpenedSource(4, "app-session:11");
    await expect(cancelSourceOpen("app-session:10")).resolves.toBe("published");

    expect(invokeMock.mock.calls).toEqual([
      [
        "open_local_source",
        { attempt: "app-session:9", groupAsDataset: false },
      ],
      ["open_recent_source", { id: "recent-4", attempt: "app-session:10" }],
      ["reload_opened_source", { generation: 4, attempt: "app-session:11" }],
      ["cancel_source_open", { attempt: "app-session:10" }],
    ]);
  });

  it("keeps structure errors typed and progress generation-scoped", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "notLoaded" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("decodingFooter");

    await expect(getStructureSummary(1)).rejects.toEqual(
      new StructureCommandError("notLoaded"),
    );
    await expect(getStructureLoadProgress(3)).resolves.toBeNull();
    await expect(getSourceOpenProgress()).resolves.toBe("decodingFooter");
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "get_structure_load_progress",
      {
        generation: 3,
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "get_source_open_progress",
      undefined,
    );
  });

  it("uses generation-scoped commands for open file sessions", async () => {
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(4);

    await expect(listOpenedSources()).resolves.toEqual([]);
    await expect(getOpenedSourceSummary(7)).resolves.toBeNull();
    await expect(activateOpenedSource(7)).resolves.toBeUndefined();
    await expect(closeOpenedSource(7)).resolves.toBe(true);
    await expect(revealOpenedSource(7)).resolves.toBeUndefined();
    await expect(cycleOpenedSource(true)).resolves.toBe(4);

    expect(invokeMock.mock.calls).toEqual([
      ["list_opened_sources"],
      ["get_opened_source_summary", { generation: 7 }],
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

  it("keeps dataset paging and grouping arguments path-free", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "inspecting" })
      .mockResolvedValueOnce({ members: [], offset: 100, total: 100 })
      .mockResolvedValueOnce({ nodes: [], nextAfter: null });

    await openLocalSource("files", true);
    await openLocalFolder("folder");
    await getDatasetStatus(9);
    await getDatasetMembers(9, 100, 50);
    await getDatasetPartitions(
      9,
      [{ key: "year", value: "2026" }],
      { key: "month", value: "08" },
      50,
    );

    expect(invokeMock.mock.calls).toEqual([
      ["open_local_source", { attempt: "files", groupAsDataset: true }],
      ["open_local_folder", { attempt: "folder" }],
      ["get_dataset_status", { generation: 9 }],
      ["get_dataset_members", { generation: 9, offset: 100, limit: 50 }],
      [
        "get_dataset_partitions",
        {
          generation: 9,
          parent: [{ key: "year", value: "2026" }],
          after: { key: "month", value: "08" },
          limit: 50,
        },
      ],
    ]);
  });

  it("keeps the discovering dataset status wire shape", async () => {
    const status = {
      state: "discovering" as const,
      progress: {
        scannedEntryCount: 4_096,
        discoveredMemberCount: 37,
        ignoredFileCount: 12,
      },
      sampleSummary: null,
    };
    invokeMock.mockResolvedValue(status);

    await expect(getDatasetStatus(9)).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("get_dataset_status", {
      generation: 9,
    });
  });

  it("keeps the inspecting sample summary separate from growing progress", async () => {
    const status: DatasetStatus = {
      state: "inspecting",
      progress: {
        completedMemberCount: 37,
        totalMemberCount: 100,
        rowCount: 8_000,
        rowGroupCount: 50,
      },
      sampleSummary: {
        displayName: "events/",
        memberCount: 8,
        ignoredFileCount: 2,
        sizeBytes: 4_096,
        rowCount: 320,
        rowGroupCount: 8,
        columnCount: 2,
        schema: [
          {
            name: "event_id",
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
    invokeMock.mockResolvedValue(status);

    await expect(getDatasetStatus(9)).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("get_dataset_status", {
      generation: 9,
    });
  });

  it("preserves the relative dataset member in typed errors", async () => {
    invokeMock.mockRejectedValue({
      code: "sourceChanged",
      member: "year=2026/part-01.parquet",
    });

    const error = await getDatasetStatus(3).catch((caught) => caught);

    expect(error).toBeInstanceOf(DatasetCommandError);
    expect(error).toMatchObject({
      detail: {
        code: "sourceChanged",
        member: "year=2026/part-01.parquet",
      },
    });
  });

  it("preserves a dataset member permission failure", async () => {
    invokeMock.mockRejectedValue({
      code: "memberPermissionDenied",
      member: "year=2026/private.parquet",
    });

    const error = await getDatasetStatus(3).catch((caught) => caught);

    expect(error).toBeInstanceOf(DatasetCommandError);
    expect(error).toMatchObject({
      detail: {
        code: "memberPermissionDenied",
        member: "year=2026/private.parquet",
      },
    });
  });

  it("preserves a duplicate Hive partition key and its relative member", async () => {
    invokeMock.mockRejectedValue({
      code: "duplicatePartitionKey",
      key: "year",
      member: "year=2026/year=2025/part.parquet",
    });

    const error = await getDatasetStatus(3).catch((caught) => caught);

    expect(error).toBeInstanceOf(DatasetCommandError);
    expect(error).toMatchObject({
      detail: {
        code: "duplicatePartitionKey",
        key: "year",
        member: "year=2026/year=2025/part.parquet",
      },
    });
  });

  it("preserves session and nested dataset window errors", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "noSourceOpen" })
      .mockRejectedValueOnce({
        code: "window",
        error: { code: "resourceExhausted" },
      })
      .mockRejectedValueOnce({
        code: "window",
        error: { code: "queryFailed" },
      });

    await expect(getDatasetStatus(3)).rejects.toMatchObject({
      detail: { code: "noSourceOpen" },
    });
    await expect(getDatasetPreview(3)).rejects.toMatchObject({
      detail: {
        code: "window",
        error: { code: "resourceExhausted" },
      },
    });
    await expect(getDataWindow(3, 0, 0, 10, [["value"]])).rejects.toMatchObject(
      {
        code: "queryFailed",
      },
    );
  });

  it("preserves relative members from direct and prepared data errors", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "sourceChanged" })
      .mockRejectedValueOnce({
        code: "sourceChanged",
        member: "year=2026/changed.parquet",
      })
      .mockRejectedValueOnce({
        code: "invalidMember",
        member: "year=2026/broken.parquet",
      })
      .mockRejectedValueOnce({
        code: "memberPermissionDenied",
        member: "year=2026/private.parquet",
      });

    const session = await getDataWindow(3, 0, 0, 10, [["value"]]).catch(
      (error) => error,
    );
    const direct = await getDataWindow(3, 0, 0, 10, [["value"]]).catch(
      (error) => error,
    );
    const prepared = await prepareDataView(3, 1, [], [], {
      memoryLimit: "mb384",
    }).catch((error) => error);
    const permission = await getDataViewStatus(3).catch((error) => error);

    expect(session).toMatchObject({
      code: "sourceChanged",
      detail: { code: "sourceChanged" },
    });
    expect(session.detail).not.toHaveProperty("member");
    expect(direct).toMatchObject({
      code: "sourceChanged",
      detail: {
        code: "sourceChanged",
        member: "year=2026/changed.parquet",
      },
    });
    expect(prepared).toMatchObject({
      code: "invalidMember",
      detail: {
        code: "invalidMember",
        member: "year=2026/broken.parquet",
      },
    });
    expect(permission).toMatchObject({
      code: "memberPermissionDenied",
      detail: {
        code: "memberPermissionDenied",
        member: "year=2026/private.parquet",
      },
    });
  });

  it("narrows structure failures to their closed code set", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "notReady" })
      .mockRejectedValueOnce({ code: "notLoaded" })
      .mockRejectedValueOnce({ code: "a code this build does not know" });

    const notReady = await getStructureSummary(1).catch(
      (error: unknown) => error,
    );
    expect(notReady).toBeInstanceOf(StructureCommandError);
    expect(notReady).toMatchObject({ code: "notReady" });

    await expect(getStructureSummary(1)).rejects.toMatchObject({
      code: "notLoaded",
    });

    await expect(getStructureSummary(1)).rejects.toMatchObject({
      code: "unsupported",
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
      getTextValueSuggestions(7, 4, ["record", "label"], "Al", "textContains"),
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
        fieldPath: ["record", "label"],
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
      restoreIncomplete: true,
    });

    await expect(takePostUpdateState()).resolves.toEqual({
      version: "0.1.0",
      sources: [],
      sourceError: { code: "notFound" },
      restoreIncomplete: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("take_post_update_state");
  });

  it.each(["cancelled", "resourceExhausted", "queryFailed"] as const)(
    "keeps the %s statistics error typed",
    async (code) => {
      invokeMock.mockRejectedValue({ code });

      await expect(
        getColumnStatistics(3, ["record", "value"], false),
      ).rejects.toEqual(new ColumnStatisticsCommandError(code));
      expect(invokeMock).toHaveBeenCalledWith("get_column_statistics", {
        generation: 3,
        fieldPath: ["record", "value"],
        includeMinMax: false,
      });
    },
  );

  it("passes one view revision through preparation, windows, status and cancellation", async () => {
    const filters = [
      {
        fieldPath: ["record", "value"],
        operator: "range" as const,
        values: ["-2", "9"],
      },
    ];
    const sort = [
      { fieldPath: ["record", "label"], direction: "descending" as const },
    ];
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
    await expect(
      getDataWindow(7, 3, 0, 512, [["record", "label"], ["other"]]),
    ).resolves.toBeInstanceOf(ArrayBuffer);
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
      fieldPaths: [["record", "label"], ["other"]],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "get_data_view_status", {
      generation: 7,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "cancel_data_view", {
      generation: 7,
      viewRevision: 3,
    });
  });

  it("passes dotted and quoted field-path segments through the window invoke", async () => {
    const encodedWindow = Uint8Array.from([4, 8, 15, 16, 23, 42]).buffer;
    invokeMock.mockResolvedValue(encodedWindow);

    const window = await getDataWindow(7, 3, 10, 20, [
      ["record.with.dot", 'label"quoted'],
    ]);

    expect(Array.from(new Uint8Array(window))).toEqual([4, 8, 15, 16, 23, 42]);
    expect(invokeMock).toHaveBeenCalledWith("get_data_window", {
      generation: 7,
      viewRevision: 3,
      rowOffset: 10,
      rowCount: 20,
      fieldPaths: [["record.with.dot", 'label"quoted']],
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

    await expect(getDataWindow(7, 0, 0, 1, [["value"]])).rejects.toEqual(
      new DataWindowCommandError(code),
    );
  });

  it("keeps export paths native while passing the active view revision", async () => {
    const request = {
      fieldPaths: [["record", "value"], ["id"]],
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
    expect(JSON.stringify(invokeMock.mock.calls[0])).not.toMatch(
      /"[^"]*path"\s*:/i,
    );
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
        fieldPaths: [["value"]],
        rowRanges: [],
        output: { format: "csv", options: {} },
      }),
    ).rejects.toEqual(new DataExportCommandError(code));
    await expect(revealDataExport(4)).rejects.toEqual(
      new DataExportCommandError(code),
    );
  });
});
