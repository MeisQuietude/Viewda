import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelFilteredRowCount,
  ColumnStatisticsCommandError,
  DataWindowCommandError,
  getColumnStatistics,
  getDataWindow,
  getFilteredRowCount,
  takePostUpdateState,
} from "./desktop";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ show: vi.fn() })),
}));

describe("desktop seam", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unwraps a restored source error from the Rust wire shape", async () => {
    invokeMock.mockResolvedValue({
      version: "0.1.0",
      source: null,
      sourceError: { code: "notFound" },
    });

    await expect(takePostUpdateState()).resolves.toEqual({
      version: "0.1.0",
      source: null,
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

  it("passes one filter AST unchanged to windows and counts", async () => {
    const filters = [
      { columnIndex: 2, operator: "range" as const, values: ["-2", "9"] },
    ];
    invokeMock
      .mockResolvedValueOnce(new ArrayBuffer(0))
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(undefined);

    await expect(getDataWindow(7, 0, 512, filters)).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    await expect(getFilteredRowCount(7, 3, filters)).resolves.toBe(4);
    await expect(cancelFilteredRowCount(7, 3)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_data_window", {
      generation: 7,
      rowOffset: 0,
      rowCount: 512,
      filters,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_filtered_row_count", {
      generation: 7,
      filterRevision: 3,
      filters,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "cancel_filtered_row_count", {
      generation: 7,
      filterRevision: 3,
    });
  });

  it.each([
    "invalidFilter",
    "cancelled",
    "resourceExhausted",
    "queryFailed",
  ] as const)("keeps the %s data-window error typed", async (code) => {
    invokeMock.mockRejectedValue({ code });

    await expect(getDataWindow(7, 0, 1)).rejects.toEqual(
      new DataWindowCommandError(code),
    );
  });
});
