import { useState } from "react";

import { getStructureReport, type StructureByteUnit } from "../desktop";

const PRIVACY =
  "Copies structure only: no file path or name, data values, statistics min/max, or metadata values.";

export function CopyStructureReport({
  generation,
  unit,
}: {
  generation: number;
  unit: StructureByteUnit;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    setStatus("idle");
    try {
      await navigator.clipboard.writeText(
        await getStructureReport(generation, unit),
      );
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div className="copy-structure-report">
      <button type="button" title={PRIVACY} onClick={() => void copy()}>
        Copy report
      </button>
      {status !== "idle" && (
        <span role="status" aria-live="polite">
          {status === "copied" ? "Report copied." : "Copy failed."}
        </span>
      )}
    </div>
  );
}
