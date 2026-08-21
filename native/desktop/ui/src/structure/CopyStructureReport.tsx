import { useEffect, useRef, useState } from "react";

import { getStructureReport, type StructureByteUnit } from "../desktop";

const PRIVACY =
  "Includes the writer, column names and metadata keys. Excludes the file path and name, data values, statistics min/max and metadata values.";
const COPIED_CONFIRMATION_MS = 1_000;

export function CopyStructureReport({
  generation,
  unit,
  active,
}: {
  generation: number;
  unit: StructureByteUnit;
  active: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copyRequest = useRef(0);
  const resetTimer = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const clearResetTimer = () => {
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  };

  useEffect(
    () => () => {
      copyRequest.current += 1;
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
    },
    [active, generation, unit],
  );

  useEffect(() => {
    setStatus("idle");
  }, [active, generation, unit]);

  const copy = async () => {
    if (!activeRef.current) {
      return;
    }
    const request = copyRequest.current + 1;
    copyRequest.current = request;
    clearResetTimer();
    setStatus("idle");
    try {
      const report = await getStructureReport(generation, unit);
      if (!activeRef.current || copyRequest.current !== request) {
        return;
      }
      await navigator.clipboard.writeText(report);
      if (!activeRef.current || copyRequest.current !== request) {
        return;
      }
      setStatus("copied");
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null;
        setStatus("idle");
      }, COPIED_CONFIRMATION_MS);
    } catch {
      if (copyRequest.current === request) {
        setStatus("failed");
      }
    }
  };

  return (
    <div className="copy-structure-report">
      <button
        className={
          status === "copied"
            ? "is-copied"
            : status === "failed"
              ? "is-failed"
              : undefined
        }
        type="button"
        title={
          status === "failed" ? `Copy failed. Try again. ${PRIVACY}` : PRIVACY
        }
        onClick={() => void copy()}
      >
        <span className="copy-structure-icons" aria-hidden="true">
          <svg className="copy-structure-glyph" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="3" width="8" height="9" rx="1.5" />
            <path d="M3 6.5v5A1.5 1.5 0 0 0 4.5 13H9" />
          </svg>
          <svg className="copy-structure-check" viewBox="0 0 16 16" fill="none">
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
          <svg
            className="copy-structure-failure"
            viewBox="0 0 16 16"
            fill="none"
          >
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </span>
        <span>Copy report</span>
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {status === "copied"
          ? "Report copied."
          : status === "failed"
            ? "Copy failed."
            : ""}
      </span>
    </div>
  );
}
