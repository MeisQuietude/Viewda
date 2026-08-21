import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import {
  STRUCTURE_PROGRESS_INTERVAL_MS,
  useStructureSummary,
} from "./use-structure-summary";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("ignores progress returned for the previously selected dataset member", async () => {
  vi.useFakeTimers();
  vi.spyOn(desktop, "getStructureSummary").mockImplementation(
    () => new Promise(() => {}),
  );
  let resolveOldProgress:
    ((progress: desktop.StructureLoadProgress | null) => void) | undefined;
  vi.spyOn(desktop, "getStructureLoadProgress").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOldProgress = resolve;
      }),
  );

  const { result, rerender } = renderHook(
    ({ revision }) => useStructureSummary(7, true, revision),
    { initialProps: { revision: 0 } },
  );
  await act(async () => {});
  act(() => vi.advanceTimersByTime(STRUCTURE_PROGRESS_INTERVAL_MS));
  expect(desktop.getStructureLoadProgress).toHaveBeenCalledWith(7);

  rerender({ revision: 1 });
  await act(async () => {});
  await act(async () => {
    resolveOldProgress?.({
      completedRowGroups: 9,
      totalRowGroups: 10,
      completedChunks: 90,
      totalChunks: 100,
    });
  });

  expect(result.current.state).toEqual({ kind: "loading", progress: null });
});
