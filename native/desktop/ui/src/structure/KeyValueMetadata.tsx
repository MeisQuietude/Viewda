import { useCallback, useState } from "react";

import { getStructureKeyValue, type StructureSummary } from "../desktop";
import { formatFileSize, formatNumber, MISSING_FACT } from "./format";
import { structureErrorMessage } from "./use-structure-summary";

type EntryState =
  | { kind: "collapsed" }
  | { kind: "loading" }
  | { kind: "ready"; value: string | null; isTruncated: boolean }
  | { kind: "error"; message: string };

/**
 * Lists footer key-value metadata, fetching each value only when opened.
 *
 * The summary carries keys and sizes alone, so a schema blob written by pandas
 * or Spark never crosses into the view until someone asks for it.
 */
export function KeyValueMetadata({
  generation,
  summary,
}: {
  generation: number;
  summary: StructureSummary;
}) {
  const [entries, setEntries] = useState<Record<number, EntryState>>({});

  const open = useCallback(
    (index: number) => {
      setEntries((current) => ({ ...current, [index]: { kind: "loading" } }));
      void getStructureKeyValue(generation, index).then(
        (entry) => {
          setEntries((current) => ({
            ...current,
            [index]: {
              kind: "ready",
              value: entry.value,
              isTruncated: entry.isTruncated,
            },
          }));
        },
        (error: unknown) => {
          setEntries((current) => ({
            ...current,
            [index]: { kind: "error", message: structureErrorMessage(error) },
          }));
        },
      );
    },
    [generation],
  );

  if (summary.keyValueCount === 0) {
    return null;
  }

  const undelivered = summary.keyValueCount - summary.keyValueMetadata.length;

  return (
    <section className="structure-card" aria-label="Key-value metadata">
      <h2>Key-value metadata</h2>
      <ul className="key-value-entries">
        {summary.keyValueMetadata.map((entry) => (
          <li key={entry.index}>
            <details
              onToggle={(event) => {
                if (
                  event.currentTarget.open &&
                  entries[entry.index] === undefined
                ) {
                  open(entry.index);
                }
              }}
            >
              <summary>
                <span className="key-value-key">{entry.key}</span>
                <span className="key-value-size">
                  {entry.valueBytes === null
                    ? MISSING_FACT
                    : formatFileSize(entry.valueBytes)}
                </span>
              </summary>
              <KeyValueBody
                state={entries[entry.index] ?? { kind: "collapsed" }}
              />
            </details>
          </li>
        ))}
      </ul>
      {undelivered > 0 && (
        <p className="structure-truncation">
          {formatNumber(undelivered)} further{" "}
          {undelivered === 1 ? "entry is" : "entries are"} not listed.
        </p>
      )}
    </section>
  );
}

function KeyValueBody({ state }: { state: EntryState }) {
  const [copyResult, setCopyResult] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  if (state.kind === "collapsed" || state.kind === "loading") {
    return (
      <p className="key-value-loading" role="status">
        Reading value…
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <p className="structure-status-error" role="alert">
        {state.message}
      </p>
    );
  }

  if (state.value === null) {
    return <p className="key-value-empty">This entry stores no value.</p>;
  }

  const rendered = prettyPrintJson(state.value);
  const copy = async () => {
    setCopyResult("idle");
    try {
      await navigator.clipboard.writeText(state.value ?? "");
      setCopyResult("copied");
    } catch {
      setCopyResult("failed");
    }
  };

  return (
    <div className="key-value-body">
      <div className="key-value-actions">
        <button
          className={`key-value-copy${copyResult === "copied" ? " is-copied" : ""}`}
          type="button"
          aria-label="Copy value"
          title="Copy value"
          onClick={() => void copy()}
        >
          Copy
        </button>
        {copyResult !== "idle" && (
          <span className="key-value-live" role="status" aria-live="polite">
            {copyResult === "copied" ? "Value copied." : "Copy failed."}
          </span>
        )}
      </div>
      <pre className="key-value-value">{rendered}</pre>
      {state.isTruncated && (
        <p className="structure-truncation">
          The value is longer than Viewda reads in one go and is cut here.
        </p>
      )}
    </div>
  );
}

/**
 * Renders schema-like entries readably.
 *
 * Writers store pandas and Spark schemas as one long JSON line; anything that
 * does not parse is shown exactly as the file holds it.
 */
function prettyPrintJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
