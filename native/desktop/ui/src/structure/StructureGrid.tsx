import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  ViewdaGrid,
  type GridMeasurementPort,
  type ViewdaGridHandle,
} from "../data-grid/ViewdaGrid";
import {
  copyBufferContents,
  type CellAlignment,
  type GridCell,
  type GridColumn,
} from "../data-grid/grid-model";
import {
  boundedSelectionScope,
  emptyGridSelection,
  selectRow,
} from "../data-grid/grid-selection";
import { copyRowLimit } from "../data-grid/copy-limit";

const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 480;
const COPY_FEEDBACK_MS = 1_000;

export interface StructureGridColumn {
  id: string;
  title: string;
  width: number;
  alignment: CellAlignment;
  monospace: boolean;
  sortable: boolean;
}

export interface StructureGridCell {
  text: string;
  faded: boolean;
}

/**
 * Read-only table shell over the Data view's grid.
 *
 * Ordering is the caller's: this component reports which header was clicked and
 * renders whatever order the caller supplies. Rows outside the caller's held
 * page render as pending until it delivers them.
 */
export function StructureGrid({
  label,
  columns,
  rowCount,
  sortColumnId,
  sortDirection,
  contentRevision,
  getCell,
  onSort,
  onViewportChange,
  heldPage,
  requestedRow,
  measurementPort,
}: {
  label: string;
  columns: readonly StructureGridColumn[];
  rowCount: number;
  sortColumnId: string;
  sortDirection: "ascending" | "descending";
  contentRevision: number;
  getCell: (row: number, columnId: string) => StructureGridCell | null;
  onSort: (columnId: string) => void;
  onViewportChange: (rowStart: number, rowCount: number) => void;
  heldPage: { offset: number; length: number } | null;
  requestedRow?: { row: number; request: number } | null;
  measurementPort?: GridMeasurementPort;
}) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState(emptyGridSelection);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const gridRef = useRef<ViewdaGridHandle>(null);
  const appliedRequest = useRef<number | null>(null);
  const copyFeedbackTimer = useRef<number | null>(null);

  const showCopyFeedback = useCallback((message: string) => {
    if (copyFeedbackTimer.current !== null) {
      window.clearTimeout(copyFeedbackTimer.current);
    }
    setCopyFeedback(message);
    copyFeedbackTimer.current = window.setTimeout(() => {
      copyFeedbackTimer.current = null;
      setCopyFeedback(null);
    }, COPY_FEEDBACK_MS);
  }, []);

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current !== null) {
        window.clearTimeout(copyFeedbackTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (
      requestedRow === null ||
      requestedRow === undefined ||
      appliedRequest.current === requestedRow.request
    ) {
      return;
    }
    appliedRequest.current = requestedRow.request;
    setSelection((current) =>
      selectRow(current, requestedRow.row, false, false),
    );
    gridRef.current?.scrollToRow(requestedRow.row);
  }, [requestedRow]);

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        title: column.title,
        width: widths[column.id] ?? column.width,
        monospace: column.monospace,
        pinned: false,
        pending: false,
        sortable: column.sortable,
        filterable: false,
        sort: {
          direction:
            column.sortable && column.id === sortColumnId
              ? sortDirection
              : "neutral",
        },
      })),
    [columns, sortColumnId, sortDirection, widths],
  );

  const getCellContent = useCallback(
    ({ row, column }: { row: number; column: number }): GridCell => {
      const details = columns[column];
      const cell = details === undefined ? null : getCell(row, details.id);
      if (cell === null) {
        return { kind: "loading" };
      }
      return {
        kind: "text",
        displayData: cell.text,
        copyData: cell.text,
        alignment: details?.alignment ?? "left",
        faded: cell.faded,
      };
    },
    [columns, getCell],
  );

  const copySelection = useCallback(
    (event: ClipboardEvent) => {
      const scope = boundedSelectionScope(selection, rowCount, columns.length);
      if (scope === null) {
        return;
      }
      event.preventDefault();
      if (heldPage === null) {
        showCopyFeedback("Nothing copied. Load the selected rows first.");
        return;
      }
      const heldEnd = heldPage.offset + heldPage.length;
      const rowLimit = copyRowLimit(scope.columnIndices.length);
      const rows: GridCell[][] = [];
      for (const [start, end] of scope.rowRanges) {
        const clippedStart = Math.max(start, heldPage.offset);
        const clippedEnd = Math.min(end, heldEnd);
        for (let row = clippedStart; row < clippedEnd; row += 1) {
          if (rows.length === rowLimit) {
            break;
          }
          const cells: GridCell[] = [];
          for (const column of scope.columnIndices) {
            cells[column] = getCellContent({ row, column });
          }
          if (
            scope.columnIndices.some(
              (column) => cells[column]?.kind === "loading",
            )
          ) {
            showCopyFeedback("Nothing copied. Load the selected rows first.");
            return;
          }
          rows.push(cells);
        }
        if (rows.length === rowLimit) {
          break;
        }
      }
      if (rows.length === 0) {
        showCopyFeedback("Nothing copied. Load the selected rows first.");
        return;
      }
      const { textPlain, textHtml } = copyBufferContents(
        rows,
        scope.columnIndices,
      );
      event.clipboardData?.setData("text/plain", textPlain);
      event.clipboardData?.setData("text/html", textHtml);
      const omitted = scope.rowCount - rows.length;
      showCopyFeedback(
        omitted > 0
          ? `Copied ${rows.length.toLocaleString()} loaded rows. ${omitted.toLocaleString()} selected rows were not copied.`
          : `Copied ${rows.length.toLocaleString()} rows.`,
      );
    },
    [columns, getCellContent, heldPage, rowCount, selection, showCopyFeedback],
  );

  return (
    <section className="structure-grid-shell" aria-label={label}>
      <div
        className="structure-grid"
        style={
          {
            "--structure-grid-height": `${Math.min(320, 44 + rowCount * 28)}px`,
          } as CSSProperties
        }
      >
        <ViewdaGrid
          ref={gridRef}
          columns={gridColumns}
          rowCount={rowCount}
          selection={selection}
          contentRevision={contentRevision}
          getCellContent={getCellContent}
          measurementPort={measurementPort}
          onSelectionChange={setSelection}
          onViewportChange={(viewport) =>
            onViewportChange(viewport.rowStart, viewport.rowCount)
          }
          onColumnResize={(column, width) => {
            const id = columns[column]?.id;
            if (id !== undefined) {
              setWidths((current) => ({
                ...current,
                [id]: Math.min(
                  MAX_COLUMN_WIDTH,
                  Math.max(MIN_COLUMN_WIDTH, Math.round(width)),
                ),
              }));
            }
          }}
          onColumnAutoFit={(column) => {
            // Structure columns hold known-shape facts, so their declared widths
            // already fit; double-click restores the width the table shipped with.
            const id = columns[column]?.id;
            if (id !== undefined) {
              setWidths((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(([key]) => key !== id),
                ),
              );
            }
          }}
          onSort={(column) => {
            const details = columns[column];
            if (details?.sortable === true) {
              onSort(details.id);
            }
          }}
          onCopy={copySelection}
          onFilter={() => {}}
          onHeaderContextMenu={() => {}}
          onCellContextMenu={() => {}}
          onHorizontalExtentChange={() => {}}
        />
      </div>
      {copyFeedback !== null && (
        <p className="structure-copy-feedback" role="status" aria-live="polite">
          {copyFeedback}
        </p>
      )}
    </section>
  );
}
