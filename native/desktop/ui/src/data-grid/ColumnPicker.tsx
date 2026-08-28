import { useEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 36;
const VIEWPORT_HEIGHT = 288;
const OVERSCAN_ROWS = 3;
const BIDI_CONTROL_CHARACTER =
  /([\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069])/u;

export interface ColumnPickerColumn {
  id: string;
  name: string;
  titlePrefix?: string;
  titleLeaf?: string;
  type: string;
  visible: boolean;
  pinned: boolean;
}

export function ColumnPicker({
  columns,
  onHideAll,
  onShowAll,
  onToggle,
  onTogglePinned,
}: {
  columns: readonly ColumnPickerColumn[];
  onHideAll: () => void;
  onShowAll: () => void;
  onToggle: (id: string, visible: boolean) => void;
  onTogglePinned: (id: string, pinned: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLInputElement>());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredColumns = useMemo(
    () =>
      normalizedQuery.length === 0
        ? columns
        : columns.filter((column) =>
            column.name.toLocaleLowerCase().includes(normalizedQuery),
          ),
    [columns, normalizedQuery],
  );
  const visibleCount = columns.reduce(
    (count, column) => count + Number(column.visible),
    0,
  );
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
    if (listRef.current !== null) {
      listRef.current.scrollTop = 0;
    }
  }, [normalizedQuery]);

  const focusOption = (index: number) => {
    const column = filteredColumns[index];
    if (column === undefined) {
      return;
    }
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const nextScrollTop =
      rowTop < scrollTop
        ? rowTop
        : rowBottom > scrollTop + VIEWPORT_HEIGHT
          ? rowBottom - VIEWPORT_HEIGHT
          : scrollTop;
    if (nextScrollTop !== scrollTop) {
      if (listRef.current !== null) {
        listRef.current.scrollTop = nextScrollTop;
      }
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
              focusOption(0);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusOption(filteredColumns.length - 1);
            }
          }}
        />
        <button
          type="button"
          disabled={visibleCount === columns.length}
          onClick={onShowAll}
        >
          Show all
        </button>
        <button type="button" disabled={visibleCount === 0} onClick={onHideAll}>
          Hide all
        </button>
      </div>
      <div
        ref={listRef}
        className="column-picker-list"
        role="list"
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
              return (
                <div
                  className="column-picker-row"
                  key={column.id}
                  role="listitem"
                  style={{
                    height: ROW_HEIGHT,
                    transform: `translateY(${filteredIndex * ROW_HEIGHT}px)`,
                  }}
                  onClick={(event) => {
                    const target = event.target;
                    if (
                      target instanceof HTMLInputElement ||
                      (target instanceof Element &&
                        target.closest("button") !== null)
                    ) {
                      return;
                    }
                    onToggle(column.id, !column.visible);
                  }}
                >
                  <input
                    ref={(input) => {
                      if (input === null) {
                        optionRefs.current.delete(column.id);
                      } else {
                        optionRefs.current.set(column.id, input);
                      }
                    }}
                    type="checkbox"
                    aria-label={`Show ${column.name}`}
                    checked={column.visible}
                    onChange={(event) =>
                      onToggle(column.id, event.target.checked)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusOption(filteredIndex + 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusOption(filteredIndex - 1);
                      } else if (event.key === " ") {
                        event.preventDefault();
                        onToggle(column.id, !column.visible);
                      }
                    }}
                  />
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
                  <ColumnName column={column} />
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
          ? `${visibleCount.toLocaleString("en-US")} of ${columns.length.toLocaleString("en-US")} visible`
          : `${filteredColumns.length.toLocaleString("en-US")} matching columns`}
      </span>
    </div>
  );
}

function ColumnName({ column }: { column: ColumnPickerColumn }) {
  const pathTitle = column.titlePrefix !== undefined;
  return (
    <span
      className={`column-picker-name ${pathTitle ? "is-path" : "is-plain"}`}
      title={safeNativeTooltipTitle(column.name)}
    >
      {pathTitle ? (
        <>
          <span className="viewda-grid-header-prefix">
            <span className="viewda-grid-header-prefix-text">
              <span className="viewda-grid-header-prefix-content" dir="ltr">
                {safeVisualPathText(
                  column.titlePrefix?.endsWith(".")
                    ? column.titlePrefix.slice(0, -1)
                    : (column.titlePrefix ?? ""),
                )}
              </span>
            </span>
            {column.titlePrefix?.endsWith(".") && (
              <span
                className="viewda-grid-header-prefix-separator"
                aria-hidden="true"
              >
                .
              </span>
            )}
          </span>
          <span className="viewda-grid-header-leaf">
            {safeVisualPathText(column.titleLeaf ?? "")}
          </span>
        </>
      ) : (
        safeVisualPathText(column.name)
      )}
    </span>
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
