/** Renderer-independent contracts for the Data view grid. */

import { VALUE_COPY_CHARACTER_LIMIT } from "./value-json-serializer";

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
  columnAnchor?: number;
  rowAnchor?: number;
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
  segments?: readonly GridCellSegment[];
}

export interface GridCellSegment {
  text: string;
  tone:
    "key" | "string" | "number" | "boolean" | "null" | "secondary" | "value";
}

export type GridCell = LoadingGridCell | TextGridCell;

export interface GridColumn {
  id: string;
  title: string;
  titlePrefix?: string;
  titleLeaf?: string;
  groupRail?: { title: string; start: boolean; end: boolean };
  width: number;
  monospace: boolean;
  pinned: boolean;
  pending: boolean;
  sortable: boolean;
  filterable: boolean;
  sort: {
    direction: "neutral" | "ascending" | "descending";
    priority?: number;
  };
}

export interface CopyBufferContents {
  textPlain: string;
  textHtml: string;
}

export class CopyBufferLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      `The selection copy exceeds the ${limit.toLocaleString("en-US")}-character aggregate copy limit.`,
    );
    this.name = "CopyBufferLimitError";
  }
}

const COPY_ESCAPE_CHUNK_CHARACTERS = 4_096;

/** Retains only escaped output chunks and the cell currently being appended. */
export class IncrementalCopyBuffer {
  readonly #plain: string[] = [];
  readonly #html: string[] = ["<table><tbody>"];
  readonly #characterLimit: number;
  #characters = this.#html[0]!.length;
  #cell:
    | {
        value: string;
        phase: "scan" | "plain" | "html";
        offset: number;
        quoted: boolean;
      }
    | undefined;
  #finished = false;

  constructor(characterLimit = VALUE_COPY_CHARACTER_LIMIT) {
    this.#characterLimit = characterLimit;
  }

  get remainingCharacters(): number {
    return this.#characterLimit - this.#characters;
  }

  beginCell(value: string, firstColumn: boolean, firstRow: boolean): void {
    if (this.#cell !== undefined || this.#finished) {
      throw new Error("The copy buffer is not ready for another cell.");
    }
    if (firstColumn) {
      if (!firstRow) this.#append(this.#plain, "\n");
      this.#append(this.#html, "<tr>");
    } else {
      this.#append(this.#plain, "\t");
    }
    this.#cell = {
      value,
      phase: "scan",
      offset: 0,
      quoted: false,
    };
  }

  stepCell(
    deadline: number,
    maxUnits: number,
    now = () => performance.now(),
  ): { done: boolean; units: number } {
    let units = 0;
    while (
      this.#cell !== undefined &&
      units < maxUnits &&
      (units === 0 || now() < deadline)
    ) {
      units += 1;
      const cell = this.#cell;
      const end = Math.min(
        cell.value.length,
        cell.offset + COPY_ESCAPE_CHUNK_CHARACTERS,
      );
      const chunk = cell.value.slice(cell.offset, end);
      if (cell.phase === "scan") {
        cell.quoted ||= /[\t\r\n"]/.test(chunk);
        cell.offset = end;
        if (end >= cell.value.length) {
          cell.phase = "plain";
          cell.offset = 0;
          if (cell.quoted) this.#append(this.#plain, '"');
        }
      } else if (cell.phase === "plain") {
        this.#append(
          this.#plain,
          cell.quoted ? chunk.replaceAll('"', '""') : chunk,
        );
        cell.offset = end;
        if (end >= cell.value.length) {
          if (cell.quoted) this.#append(this.#plain, '"');
          cell.phase = "html";
          cell.offset = 0;
          this.#append(this.#html, '<td style="white-space: pre-wrap">');
        }
      } else {
        this.#append(this.#html, escapeHtmlChunk(chunk));
        cell.offset = end;
        if (end >= cell.value.length) {
          this.#append(this.#html, "</td>");
          this.#cell = undefined;
        }
      }
    }
    return { done: this.#cell === undefined, units };
  }

  endRow(): void {
    if (this.#cell !== undefined || this.#finished) {
      throw new Error("The copy buffer row cannot end yet.");
    }
    this.#append(this.#html, "</tr>");
  }

  finish(): CopyBufferContents {
    if (this.#cell !== undefined || this.#finished) {
      throw new Error("The copy buffer cannot finish yet.");
    }
    this.#finished = true;
    this.#append(this.#html, "</tbody></table>");
    return {
      // Clipboard APIs require contiguous strings. The aggregate cap has
      // already accounted for both escaped outputs at this boundary.
      textPlain: this.#plain.join(""),
      textHtml: this.#html.join(""),
    };
  }

  #append(output: string[], text: string): void {
    this.#characters += text.length;
    if (this.#characters > this.#characterLimit) {
      throw new CopyBufferLimitError(this.#characterLimit);
    }
    output.push(text);
  }
}

export function copyBufferContents(
  rows: readonly (readonly GridCell[])[],
  columnIndices: readonly number[],
): CopyBufferContents {
  const textRows = rows.map((row) =>
    columnIndices.map((column) => {
      const cell = row[column];
      return cell?.kind === "text" ? cell.copyData : "";
    }),
  );
  return {
    textPlain: textRows.map((row) => row.map(escapeTsv).join("\t")).join("\n"),
    textHtml: `<table><tbody>${textRows
      .map(
        (row) =>
          `<tr>${row
            .map(
              (value) =>
                `<td style="white-space: pre-wrap">${escapeHtmlChunk(value)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("")}</tbody></table>`,
  };
}

function escapeTsv(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function escapeHtmlChunk(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(/\r\n?|\n/g, "<br>");
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
