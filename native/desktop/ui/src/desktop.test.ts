import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ColumnStatisticsCommandError,
  getColumnStatistics,
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
});
