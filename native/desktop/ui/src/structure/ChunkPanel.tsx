import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelStructureBloomProbe,
  getStructureChunk,
  probeStructureBloomFilter,
  StructureCommandError,
  type StructureBloomProbe,
  type StructureChunkDetails,
} from "../desktop";
import {
  formatEncodings,
  formatFileSize,
  formatNumber,
  formatRatio,
  MISSING_FACT,
} from "./format";
import { StructureHelp } from "./StructureHelp";
import { structureErrorMessage } from "./use-structure-summary";

const MAX_BLOOM_PROBE_VALUE_BYTES = 4 * 1024;

export interface SelectedChunk {
  rowGroupIndex: number;
  columnIndex: number;
}

export function ChunkPanel({
  generation,
  selected,
  showColumnIndex = false,
  onClose,
}: {
  generation: number;
  selected: SelectedChunk;
  showColumnIndex?: boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [details, setDetails] = useState<StructureChunkDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setError(null);
    void getStructureChunk(
      generation,
      selected.rowGroupIndex,
      selected.columnIndex,
    ).then(
      (value) => active && setDetails(value),
      (reason: unknown) => active && setError(structureErrorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [generation, selected.columnIndex, selected.rowGroupIndex]);

  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "nearest" });
    panel.current?.focus();
  }, [selected.columnIndex, selected.rowGroupIndex]);

  return (
    <aside
      ref={panel}
      className="chunk-panel"
      aria-label="Column chunk details"
      tabIndex={-1}
    >
      <div className="chunk-panel-heading">
        <div>
          <span>Row group {formatNumber(selected.rowGroupIndex)}</span>
          <h3>
            {details === null
              ? "Column chunk"
              : showColumnIndex
                ? `#${formatNumber(details.columnIndex + 1)} · ${details.columnName}`
                : details.columnName}
          </h3>
        </div>
        <button
          type="button"
          aria-label="Close chunk details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {error !== null && (
        <p className="structure-status-error" role="alert">
          {error}
        </p>
      )}
      {details === null && error === null && (
        <p role="status">Reading chunk…</p>
      )}
      {details !== null && (
        <>
          <dl className="chunk-facts">
            <ChunkFact label="Type" value={details.physicalType} />
            <ChunkFact
              label={<StructureHelp term="Codec" />}
              value={details.codec}
            />
            <ChunkFact
              label={<StructureHelp term="Encodings" />}
              value={formatEncodings(details.encodings)}
            />
            <ChunkFact
              label="Values"
              value={formatNumber(details.valueCount)}
            />
            <ChunkFact
              label="On disk"
              value={formatFileSize(details.compressedBytes)}
            />
            <ChunkFact
              label="Uncompressed"
              value={formatFileSize(details.uncompressedBytes)}
            />
            <ChunkFact
              label={
                <StructureHelp term="Compression ratio">Ratio</StructureHelp>
              }
              value={formatRatio(details.compressionRatio)}
            />
            <ChunkFact
              label="Data page offset"
              value={formatNumber(details.dataPageOffset)}
            />
            <ChunkFact
              label="Dictionary page offset"
              value={formatOptionalNumber(details.dictionaryPageOffset)}
            />
            <ChunkFact
              label={<StructureHelp term="Page index" />}
              value={details.hasPageIndex ? "Present" : MISSING_FACT}
            />
            <ChunkFact
              label="Offset index"
              value={details.hasOffsetIndex ? "Present" : MISSING_FACT}
            />
            <ChunkFact
              label={
                <StructureHelp term="Bloom filter">Bloom bytes</StructureHelp>
              }
              value={
                !details.hasBloomFilter
                  ? MISSING_FACT
                  : details.bloomFilterBytes === null
                    ? "Present · size unknown"
                    : formatFileSize(details.bloomFilterBytes)
              }
            />
          </dl>
          <Statistics details={details} />
          <BloomProbe generation={generation} details={details} />
        </>
      )}
    </aside>
  );
}

function Statistics({ details }: { details: StructureChunkDetails }) {
  const statistics = details.statistics;
  return (
    <section className="chunk-section">
      <h4>
        <StructureHelp term="Statistics" />
      </h4>
      {statistics === null ? (
        <p title="The writer stored no footer statistics for this chunk.">
          {MISSING_FACT}
        </p>
      ) : (
        <dl className="chunk-facts">
          <ChunkFact
            label="Minimum"
            value={statistics.minimum ?? MISSING_FACT}
            detail={
              statistics.minimum === null
                ? undefined
                : statistics.minimumIsExact
                  ? "exact"
                  : "estimated"
            }
          />
          <ChunkFact
            label="Maximum"
            value={statistics.maximum ?? MISSING_FACT}
            detail={
              statistics.maximum === null
                ? undefined
                : statistics.maximumIsExact
                  ? "exact"
                  : "estimated"
            }
          />
          <ChunkFact
            label="Nulls"
            value={formatOptionalNumber(statistics.nullCount)}
          />
          <ChunkFact
            label="Distinct"
            value={formatOptionalNumber(statistics.distinctCount)}
          />
        </dl>
      )}
    </section>
  );
}

function BloomProbe({
  generation,
  details,
}: {
  generation: number;
  details: StructureChunkDetails;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<StructureBloomProbe | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const activeNativeRequest = useRef<string | null>(null);
  const valueBytes = new TextEncoder().encode(value).length;
  const valueTooLarge = valueBytes > MAX_BLOOM_PROBE_VALUE_BYTES;

  const cancelActiveProbe = useCallback(() => {
    const active = activeNativeRequest.current;
    activeNativeRequest.current = null;
    if (active !== null) {
      void cancelStructureBloomProbe(generation, active).catch(() => {});
    }
  }, [generation]);

  useEffect(() => {
    request.current += 1;
    setValue("");
    setResult(null);
    setStatus("idle");
    setError(null);
    return () => {
      request.current += 1;
      cancelActiveProbe();
    };
  }, [cancelActiveProbe, details.columnIndex, generation]);

  if (!details.columnHasBloomFilter) {
    return (
      <section className="chunk-section">
        <h4>
          <StructureHelp term="Bloom filter" />
        </h4>
        <p>No row group records a Bloom filter for this column.</p>
      </section>
    );
  }

  const probe = async (offset = 0) => {
    if (valueTooLarge) return;
    const token = ++request.current;
    const nativeRequest = crypto.randomUUID();
    activeNativeRequest.current = nativeRequest;
    setStatus("loading");
    setResult(null);
    setError(null);
    try {
      const next = await probeStructureBloomFilter(
        generation,
        nativeRequest,
        details.columnIndex,
        value,
        offset,
        256,
      );
      if (request.current === token) {
        activeNativeRequest.current = null;
        setResult(next);
        setStatus("idle");
      }
    } catch (reason) {
      if (request.current === token) {
        activeNativeRequest.current = null;
        setStatus("error");
        setError(bloomProbeErrorMessage(reason));
      }
    }
  };

  return (
    <section className="chunk-section">
      <h4>
        <StructureHelp term="Bloom filter">Probe</StructureHelp>
      </h4>
      <form
        className="bloom-probe"
        onSubmit={(event) => {
          event.preventDefault();
          void probe(0);
        }}
      >
        <input
          aria-label="Probe value"
          maxLength={MAX_BLOOM_PROBE_VALUE_BYTES}
          value={value}
          onChange={(event) => {
            const wasLoading = status === "loading";
            request.current += 1;
            setValue(event.target.value);
            setResult(null);
            setStatus("idle");
            setError(null);
            if (wasLoading) {
              cancelActiveProbe();
            }
          }}
        />
        <button
          type="submit"
          disabled={status === "loading" || value.length === 0 || valueTooLarge}
        >
          Probe
        </button>
        {status === "loading" && (
          <button
            type="button"
            onClick={() => {
              request.current += 1;
              setStatus("idle");
              setError(null);
              cancelActiveProbe();
            }}
          >
            Cancel
          </button>
        )}
      </form>
      {valueTooLarge && (
        <p className="structure-status-error" role="alert">
          Probe values are limited to 4,096 UTF-8 bytes.
        </p>
      )}
      {status === "error" && error !== null && (
        <p className="structure-status-error" role="alert">
          {error}
        </p>
      )}
      {result !== null && (
        <>
          <ul className="probe-results">
            {result.rowGroups.map((row) => (
              <li key={row.index}>
                Row group {formatNumber(row.index)}: {probeOutcome(row.outcome)}
              </li>
            ))}
          </ul>
          {result.totalCount > result.rowGroups.length && (
            <div className="probe-pages">
              <button
                type="button"
                disabled={result.offset === 0}
                onClick={() => void probe(Math.max(0, result.offset - 256))}
              >
                Previous
              </button>
              <span>
                {formatNumber(result.offset + 1)}–
                {formatNumber(result.offset + result.rowGroups.length)} of{" "}
                {formatNumber(result.totalCount)}
              </span>
              <button
                type="button"
                disabled={
                  result.offset + result.rowGroups.length >= result.totalCount
                }
                onClick={() =>
                  void probe(result.offset + result.rowGroups.length)
                }
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function bloomProbeErrorMessage(error: unknown): string {
  if (error instanceof StructureCommandError) {
    if (error.code === "invalidProbeValue") {
      return "The value could not be probed for this column type.";
    }
    if (error.code === "unsupportedProbeColumn") {
      return "Bloom filters cannot be probed for this column type.";
    }
  }
  return structureErrorMessage(error);
}

function ChunkFact({
  label,
  value,
  detail,
}: {
  label: React.ReactNode;
  value: string;
  detail?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {detail === undefined ? "" : ` · ${detail}`}
      </dd>
    </div>
  );
}

function formatOptionalNumber(value: number | null): string {
  return value === null ? MISSING_FACT : formatNumber(value);
}

function probeOutcome(
  outcome: StructureBloomProbe["rowGroups"][number]["outcome"],
): string {
  return {
    mayContain: "may contain",
    definitelyAbsent: "definitely not",
    noFilter: "no filter",
    unreadable: "filter unreadable",
  }[outcome];
}
