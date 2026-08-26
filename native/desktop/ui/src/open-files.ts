// The window's model of the sources that are open. Rust owns the set, the
// most-recently-used order and the display metadata; the window adds what only
// it knows: the summary it received when the file opened and the view mode.

import type { OpenedSourceEntry, SourceSummary } from "./desktop";

export type SourceMode = "data" | "structure";

export interface OpenFile extends OpenedSourceEntry {
  summary: SourceSummary;
  mode: SourceMode;
  busy: boolean;
  dataTargetRow: { row: number; request: number } | null;
}

/**
 * Rebuilds the open sources from a native listing, keeping per-source window state.
 *
 * A source whose summary never reached the window cannot be rendered and is left
 * out; it stays open natively until it is closed.
 */
export function mergeOpenFiles(
  entries: readonly OpenedSourceEntry[],
  summaries: ReadonlyMap<number, SourceSummary>,
  previous: OpenFile[],
): OpenFile[] {
  const merged = entries.flatMap((entry) => {
    const summary = summaries.get(entry.generation);
    if (summary === undefined) {
      return [];
    }
    const kept = previous.find((file) => file.generation === entry.generation);
    return [
      {
        ...entry,
        summary,
        mode: kept?.mode ?? "data",
        busy: kept?.busy ?? false,
        dataTargetRow: kept?.dataTargetRow ?? null,
      },
    ];
  });
  return sameOpenFiles(previous, merged) ? previous : merged;
}

function sameOpenFiles(
  left: readonly OpenFile[],
  right: readonly OpenFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        file.generation === other.generation &&
        file.kind === other.kind &&
        file.datasetMemberCount === other.datasetMemberCount &&
        file.datasetIgnoredFileCount === other.datasetIgnoredFileCount &&
        file.name === other.name &&
        file.directory === other.directory &&
        file.path === other.path &&
        file.active === other.active &&
        file.summary === other.summary &&
        file.mode === other.mode &&
        file.busy === other.busy &&
        file.dataTargetRow === other.dataTargetRow
      );
    })
  );
}

export function activeOpenFile(files: readonly OpenFile[]): OpenFile | null {
  return files.find((file) => file.active) ?? null;
}

/**
 * Shortest trailing directories that tell equally named open files apart.
 *
 * Returns `null` while the name is unambiguous, and falls back to the shortened
 * directory when no tail of one path can distinguish it from another.
 */
export function distinguishingTail(
  file: OpenFile,
  files: readonly OpenFile[],
): string | null {
  const rivals = files
    .filter(
      (other) =>
        other.generation !== file.generation && other.name === file.name,
    )
    .map((other) => directorySegments(other.path));
  if (rivals.length === 0) {
    return null;
  }
  const segments = directorySegments(file.path);
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const tail = segments.slice(segments.length - depth);
    if (rivals.every((rival) => !endsWith(rival, tail))) {
      return tail.join("/");
    }
  }

  return file.directory;
}

function directorySegments(path: string): string[] {
  return path
    .split(/[/\\]/)
    .slice(0, -1)
    .filter((segment) => segment.length > 0);
}

function endsWith(
  segments: readonly string[],
  tail: readonly string[],
): boolean {
  return (
    segments.length >= tail.length &&
    tail.every(
      (segment, index) =>
        segments[segments.length - tail.length + index] === segment,
    )
  );
}
