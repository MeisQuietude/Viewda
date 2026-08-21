import { useEffect, useState } from "react";

import {
  cancelStructureBloomProbe,
  getStructureChunk,
  probeStructureBloomFilter,
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

export interface SelectedChunk {
  rowGroupIndex: number;
  columnIndex: number;
}

export function ChunkPanel({
  generation,
  selected,
  onClose,
}: {
  generation: number;
  selected: SelectedChunk;
  onClose: () => void;
}) {
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

  return (
    <aside className="chunk-panel" aria-label="Column chunk details">
      <div className="chunk-panel-heading">
        <div>
          <span>Row group {formatNumber(selected.rowGroupIndex)}</span>
          <h3>{details?.columnName ?? "Column chunk"}</h3>
        </div>
        <button
          type="button"
          aria-label="Close chunk details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {error !== null && <p className="structure-status-error">{error}</p>}
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

  useEffect(() => {
    setValue("");
    setResult(null);
    setStatus("idle");
  }, [details.columnIndex]);

  if (!details.columnHasBloomFilter) {
    return (
      <section className="chunk-section">
        <h4>
          <StructureHelp term="Bloom filter" />
        </h4>
        <p>This column chunk has no bloom filter to probe.</p>
      </section>
    );
  }

  const probe = async (offset = 0) => {
    setStatus("loading");
    setResult(null);
    try {
      setResult(
        await probeStructureBloomFilter(
          generation,
          details.columnIndex,
          value,
          offset,
          256,
        ),
      );
      setStatus("idle");
    } catch {
      setStatus("error");
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
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="submit"
          disabled={status === "loading" || value.length === 0}
        >
          Probe
        </button>
        {status === "loading" && (
          <button
            type="button"
            onClick={() => void cancelStructureBloomProbe(generation)}
          >
            Cancel
          </button>
        )}
      </form>
      {status === "error" && (
        <p className="structure-status-error">
          The value could not be probed for this column type.
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
