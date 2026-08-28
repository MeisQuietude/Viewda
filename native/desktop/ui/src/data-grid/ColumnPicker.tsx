import { useEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 48;
const VIEWPORT_HEIGHT = 336;
const OVERSCAN_ROWS = 3;
const MAX_TREE_INDENT = 12;
const BIDI_CONTROL_CHARACTER =
  /([\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069])/u;

export type ColumnPickerSelection = "none" | "partial" | "all";

export interface ColumnPickerColumn {
  id: string;
  name: string;
  namePrefix?: string;
  nameLeaf?: string;
  type: string;
  depth: number;
  selection: ColumnPickerSelection;
  exact: boolean;
  pinned: boolean;
  ancestorIds: readonly string[];
  disabledReason?: string;
}

export function ColumnPicker({
  columns,
  projectedCount,
  onHideAll,
  onShowAll,
  onToggle,
  onTogglePinned,
}: {
  columns: readonly ColumnPickerColumn[];
  projectedCount: number;
  onHideAll: () => void;
  onShowAll: () => void;
  onToggle: (id: string, selected: boolean) => void;
  onTogglePinned: (id: string, pinned: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLInputElement>());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredColumns = useMemo(() => {
    if (normalizedQuery.length === 0) return columns;
    const included = new Set<string>();
    for (const column of columns) {
      if (!column.name.toLocaleLowerCase().includes(normalizedQuery)) continue;
      included.add(column.id);
      column.ancestorIds.forEach((id) => included.add(id));
    }
    return columns.filter((column) => included.has(column.id));
  }, [columns, normalizedQuery]);
  const firstRow = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS,
  );
  const renderedRowCount =
    Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const renderedColumns = filteredColumns.slice(
    firstRow,
    firstRow + renderedRowCount,
  );

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setScrollTop(0);
    if (listRef.current !== null) listRef.current.scrollTop = 0;
  }, [normalizedQuery]);

  const focusOption = (start: number, direction: -1 | 1) => {
    let index = start;
    while (
      index >= 0 &&
      index < filteredColumns.length &&
      filteredColumns[index]?.disabledReason !== undefined
    ) {
      index += direction;
    }
    const column = filteredColumns[index];
    if (column === undefined) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const nextScrollTop =
      rowTop < scrollTop
        ? rowTop
        : rowBottom > scrollTop + VIEWPORT_HEIGHT
          ? rowBottom - VIEWPORT_HEIGHT
          : scrollTop;
    if (nextScrollTop !== scrollTop) {
      if (listRef.current !== null) listRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
    const current = optionRefs.current.get(column.id);
    if (current !== undefined) {
      current.focus();
      return;
    }
    requestAnimationFrame(() => optionRefs.current.get(column.id)?.focus());
  };

  return (
    <div className="column-picker" role="dialog" aria-label="SELECT columns">
      <div className="column-picker-toolbar">
        <input
          ref={searchRef}
          type="search"
          aria-label="Search columns"
          placeholder="Search columns"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusOption(0, 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusOption(filteredColumns.length - 1, -1);
            }
          }}
        />
        <button type="button" onClick={onShowAll}>
          Show all
        </button>
        <button
          type="button"
          disabled={projectedCount === 0}
          onClick={onHideAll}
        >
          Hide all
        </button>
      </div>
      <div
        ref={listRef}
        className="column-picker-list"
        role="tree"
        aria-label="Columns"
        style={{ maxHeight: VIEWPORT_HEIGHT }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {filteredColumns.length === 0 ? (
          <p>No matching columns.</p>
        ) : (
          <div
            className="column-picker-list-content"
            style={{ height: filteredColumns.length * ROW_HEIGHT }}
          >
            {renderedColumns.map((column, renderedIndex) => {
              const filteredIndex = firstRow + renderedIndex;
              const selected = column.selection === "all";
              return (
                <div
                  className={`column-picker-row${column.disabledReason === undefined ? "" : " is-disabled"}`}
                  key={column.id}
                  role="treeitem"
                  aria-level={column.depth + 1}
                  aria-selected={column.selection !== "none"}
                  style={{
                    height: ROW_HEIGHT,
                    paddingLeft: `${8 + Math.min(column.depth, MAX_TREE_INDENT) * 14}px`,
                    transform: `translateY(${filteredIndex * ROW_HEIGHT}px)`,
                  }}
                  onClick={(event) => {
                    if (column.disabledReason !== undefined) return;
                    const target = event.target;
                    if (
                      target instanceof HTMLInputElement ||
                      (target instanceof Element &&
                        target.closest("button") !== null)
                    ) {
                      return;
                    }
                    onToggle(column.id, !selected);
                  }}
                >
                  <input
                    ref={(input) => {
                      if (input === null) {
                        optionRefs.current.delete(column.id);
                      } else {
                        input.indeterminate = column.selection === "partial";
                        optionRefs.current.set(column.id, input);
                      }
                    }}
                    type="checkbox"
                    aria-label={`Project ${column.name}`}
                    checked={selected}
                    disabled={column.disabledReason !== undefined}
                    onChange={(event) =>
                      onToggle(column.id, event.target.checked)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusOption(filteredIndex + 1, 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusOption(filteredIndex - 1, -1);
                      } else if (event.key === " ") {
                        event.preventDefault();
                        onToggle(column.id, !selected);
                      }
                    }}
                  />
                  {column.exact ? (
                    <button
                      className="column-picker-pin"
                      type="button"
                      aria-label={`${column.pinned ? "Unpin" : "Pin"} ${column.name}`}
                      aria-pressed={column.pinned}
                      title={`${column.pinned ? "Unpin" : "Pin"} column`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePinned(column.id, !column.pinned);
                      }}
                    >
                      <PinIcon />
                    </button>
                  ) : (
                    <span className="column-picker-pin-spacer" />
                  )}
                  <span className="column-picker-label">
                    <span
                      className={`column-picker-name${column.namePrefix === undefined ? " is-plain" : " is-path"}`}
                      title={safeNativeTooltipTitle(column.name)}
                    >
                      {column.namePrefix === undefined ? (
                        safeVisualPathText(column.name)
                      ) : (
                        <>
                          <span className="column-picker-prefix">
                            <span className="column-picker-prefix-text">
                              <span
                                className="column-picker-prefix-content"
                                dir="ltr"
                              >
                                {safeVisualPathText(
                                  column.namePrefix.endsWith(".")
                                    ? column.namePrefix.slice(0, -1)
                                    : column.namePrefix,
                                )}
                              </span>
                            </span>
                            {column.namePrefix.endsWith(".") && (
                              <span
                                className="column-picker-prefix-separator"
                                aria-hidden="true"
                              >
                                .
                              </span>
                            )}
                          </span>
                          <span className="column-picker-leaf">
                            {safeVisualPathText(column.nameLeaf ?? "")}
                          </span>
                        </>
                      )}
                    </span>
                    {column.disabledReason !== undefined && (
                      <span className="column-picker-reason">
                        {column.disabledReason}
                      </span>
                    )}
                  </span>
                  <span className="column-picker-type" title={column.type}>
                    {column.type}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <span className="column-picker-count" role="status">
        {normalizedQuery.length === 0
          ? `${projectedCount.toLocaleString("en-US")} projected columns`
          : `${filteredColumns.length.toLocaleString("en-US")} matching fields`}
      </span>
    </div>
  );
}

function safeVisualPathText(text: string) {
  return text.split(BIDI_CONTROL_CHARACTER).map((part, index) =>
    BIDI_CONTROL_CHARACTER.test(part) ? (
      <span className="viewda-grid-header-bidi-control" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function safeNativeTooltipTitle(text: string): string | undefined {
  return BIDI_CONTROL_CHARACTER.test(text) ? undefined : text;
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3h8l-1 6 3 3H6l3-3-1-6Z" />
      <path d="M12 12v9" />
    </svg>
  );
}
