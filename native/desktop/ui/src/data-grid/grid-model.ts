/** Renderer-independent contracts for the data table. */

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CompactSelection implements Iterable<number> {
  readonly #ranges: readonly (readonly [number, number])[];

  private constructor(ranges: readonly (readonly [number, number])[]) {
    this.#ranges = normalizeSelectionRanges(ranges);
  }

  static empty(): CompactSelection {
    return new CompactSelection([]);
  }

  static fromSingleSelection(
    selection: number | readonly [number, number],
  ): CompactSelection {
    const range =
      typeof selection === "number"
        ? ([selection, selection + 1] as const)
        : selection;
    return new CompactSelection([range]);
  }

  get length(): number {
    return this.#ranges.reduce((total, [start, end]) => total + end - start, 0);
  }

  add(selection: number | readonly [number, number]): CompactSelection {
    const range =
      typeof selection === "number"
        ? ([selection, selection + 1] as const)
        : selection;
    return new CompactSelection([...this.#ranges, range]);
  }

  union(selection: CompactSelection): CompactSelection {
    return new CompactSelection([...this.#ranges, ...selection.#ranges]);
  }

  remove(index: number): CompactSelection {
    const ranges = this.#ranges.flatMap(([start, end]) => {
      if (index < start || index >= end) {
        return [[start, end] as const];
      }
      return [
        start < index ? ([start, index] as const) : null,
        index + 1 < end ? ([index + 1, end] as const) : null,
      ].filter((range): range is readonly [number, number] => range !== null);
    });
    return new CompactSelection(ranges);
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
    cell: readonly [number, number];
    range: Rectangle;
    rangeStack: Rectangle[];
  };
}

export const GridCellKind = {
  Loading: "loading",
  Text: "text",
} as const;

export interface LoadingGridCell {
  kind: typeof GridCellKind.Loading;
}

export interface TextGridCell {
  kind: typeof GridCellKind.Text;
  displayData: string;
  copyData: string;
  contentAlign: "left" | "right" | "center";
  style: "faded" | "normal";
}

export type GridCell = LoadingGridCell | TextGridCell;
export type CellArray = GridCell[][];

export interface ColumnSortIndicator {
  direction: "neutral" | "ascending" | "descending";
  priority?: number;
}

export interface GridColumn {
  title: string;
  width: number;
  monospace: boolean;
  sort: ColumnSortIndicator;
}

export interface CopyBufferContents {
  textPlain: string;
  textHtml: string;
}

export function getCopyBufferContents(
  rows: readonly (readonly GridCell[])[],
  columnIndices: readonly number[],
): CopyBufferContents {
  const copyRows = rows.map((row) =>
    columnIndices.map((column) => {
      const cell = row[column];
      return cell?.kind === GridCellKind.Text ? cell.copyData : "";
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
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const sorted = ranges
    .filter(([start, end]) => Number.isInteger(start) && end > start)
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
