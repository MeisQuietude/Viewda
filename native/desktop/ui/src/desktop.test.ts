import { beforeEach, describe, expect, it, vi } from "vitest";

import { takePostUpdateState } from "./desktop";

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
});
