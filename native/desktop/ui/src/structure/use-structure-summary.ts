/** Load lifecycle for the footer parse behind Structure mode. */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelStructureLoad,
  getStructureLoadProgress,
  getStructureSummary,
  StructureCommandError,
  type StructureLoadProgress,
  type StructureSummary,
} from "../desktop";

/** How often the running parse is asked how far it has come. */
export const STRUCTURE_PROGRESS_INTERVAL_MS = 250;

export type StructureSummaryState =
  | { kind: "idle" }
  | { kind: "loading"; progress: StructureLoadProgress | null }
  | { kind: "ready"; summary: StructureSummary; refreshing: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface StructureSummaryController {
  state: StructureSummaryState;
  cancel: () => void;
  retry: () => void;
}

/**
 * Parses the footer once per opened source, on first activation of the mode.
 *
 * Re-entering asks the backend idempotently so an evicted cache entry can be
 * rebuilt without discarding this component's view state. A cancelled parse
 * leaves a state the caller can retry from.
 */
export function useStructureSummary(
  generation: number,
  active: boolean,
): StructureSummaryController {
  const [state, setState] = useState<StructureSummaryState>({ kind: "idle" });
  const requestVersion = useRef(0);
  const aliveRef = useRef(true);
  const wasActive = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setState((current) =>
      current.kind === "ready"
        ? { ...current, refreshing: true }
        : { kind: "loading", progress: null },
    );

    void getStructureSummary(generation).then(
      (summary) => {
        if (aliveRef.current && requestVersion.current === version) {
          setState({ kind: "ready", summary, refreshing: false });
        }
      },
      (error: unknown) => {
        if (!aliveRef.current || requestVersion.current !== version) {
          return;
        }
        if (
          error instanceof StructureCommandError &&
          error.code === "cancelled"
        ) {
          setState({ kind: "cancelled" });
        } else {
          setState({ kind: "error", message: structureErrorMessage(error) });
        }
      },
    );
  }, [generation]);

  useEffect(() => {
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (activated) {
      load();
    }
  }, [active, load]);

  useEffect(() => {
    if (state.kind !== "loading") {
      return;
    }
    const timer = setInterval(() => {
      void getStructureLoadProgress(generation).then(
        (progress) => {
          if (progress !== null && aliveRef.current) {
            setState((current) =>
              current.kind === "loading" ? { ...current, progress } : current,
            );
          }
        },
        () => {
          // Progress is a convenience; the load result is what the mode waits on.
        },
      );
    }, STRUCTURE_PROGRESS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [generation, state.kind]);

  const cancel = useCallback(() => {
    void cancelStructureLoad(generation).catch(() => {
      // The parse reports its own cancellation; a failed request changes nothing.
    });
  }, [generation]);

  return { state, cancel, retry: load };
}

export function structureErrorMessage(error: unknown): string {
  if (error instanceof StructureCommandError) {
    if (error.code === "notFound" || error.code === "noSourceOpen") {
      return "The open file is no longer available.";
    }
    if (error.code === "permissionDenied") {
      return "Viewda no longer has permission to read this file.";
    }
    if (error.code === "corruptFooter" || error.code === "notParquet") {
      return "The Parquet footer is damaged or incomplete.";
    }
    if (error.code === "sourceChanged") {
      return "The open file changed. Reopen it to inspect its structure.";
    }
  }
  return "The file structure could not be read.";
}
