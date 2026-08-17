/** Renderer-independent contracts for the Data view grid. */

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridAddress {
  row: number;
  column: number;
}

export type SelectionRange = readonly [start: number, end: number];

export class CompactSelection implements Iterable<number> {
  readonly #ranges: readonly SelectionRange[];

  private constructor(ranges: readonly SelectionRange[]) {
    this.#ranges = normalizeSelectionRanges(ranges);
  }

  static empty(): CompactSelection {
    return new CompactSelection([]);
  }

  static fromSingleSelection(
    selection: number | SelectionRange,
  ): CompactSelection {
    return CompactSelection.empty().add(selection);
  }

  get length(): number {
    return this.#ranges.reduce((total, [start, end]) => total + end - start, 0);
  }

  add(selection: number | SelectionRange): CompactSelection {
    const range =
      typeof selection === "number"
        ? ([selection, selection + 1] as const)
        : selection;
    return new CompactSelection([...this.#ranges, range]);
  }

  remove(selection: number | SelectionRange): CompactSelection {
    const [removeStart, removeEnd] =
      typeof selection === "number"
        ? ([selection, selection + 1] as const)
        : selection;
    return new CompactSelection(
      this.#ranges.flatMap(([start, end]) => {
        if (removeEnd <= start || removeStart >= end) {
          return [[start, end] as const];
        }
        const remaining: SelectionRange[] = [];
        if (start < removeStart) {
          remaining.push([start, removeStart]);
        }
        if (removeEnd < end) {
          remaining.push([removeEnd, end]);
        }
        return remaining;
      }),
    );
  }

  hasIndex(index: number): boolean {
    return this.#ranges.some(([start, end]) => start <= index && index < end);
  }

  first(): number | undefined {
    return this.#ranges[0]?.[0];
  }

  last(): number | undefined {
    const range = this.#ranges.at(-1);
    return range === undefined ? undefined : range[1] - 1;
  }

  ranges(): readonly SelectionRange[] {
    return this.#ranges;
  }

  *[Symbol.iterator](): Iterator<number> {
    for (const [start, end] of this.#ranges) {
      for (let index = start; index < end; index += 1) {
        yield index;
      }
    }
  }
}

export interface GridSelection {
  columns: CompactSelection;
  rows: CompactSelection;
  current?: {
    cell: GridAddress;
    range: Rectangle;
    rangeStack: Rectangle[];
  };
}

export type CellAlignment = "left" | "right" | "center";

export interface LoadingGridCell {
  kind: "loading";
}

export interface TextGridCell {
  kind: "text";
  displayData: string;
  copyData: string;
  alignment: CellAlignment;
  faded: boolean;
}

export type GridCell = LoadingGridCell | TextGridCell;

export interface GridColumn {
  id: string;
  title: string;
  width: number;
  monospace: boolean;
  sort: {
    direction: "neutral" | "ascending" | "descending";
    priority?: number;
  };
}

export interface CopyBufferContents {
  textPlain: string;
  textHtml: string;
}

export function copyBufferContents(
  rows: readonly (readonly GridCell[])[],
  columnIndices: readonly number[],
): CopyBufferContents {
  const copyRows = rows.map((row) =>
    columnIndices.map((column) => {
      const cell = row[column];
      return cell?.kind === "text" ? cell.copyData : "";
    }),
  );
  return {
    textPlain: copyRows.map((row) => row.map(escapeTsv).join("\t")).join("\n"),
    textHtml: `<table><tbody>${copyRows
      .map(
        (row) =>
          `<tr>${row.map((value) => `<td>${escapeHtml(value).replaceAll(/\r\n?|\n/g, "<br>")}</td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table>`,
  };
}

function escapeTsv(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeSelectionRanges(
  ranges: readonly SelectionRange[],
): readonly SelectionRange[] {
  const sorted = ranges
    .filter(
      ([start, end]) =>
        Number.isInteger(start) && Number.isInteger(end) && end > start,
    )
    .map(([start, end]) => [start, end] as const)
    .sort(([left], [right]) => left - right);
  const normalized: [number, number][] = [];
  for (const [start, end] of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      normalized.push([start, end]);
    }
  }
  return normalized;
}
