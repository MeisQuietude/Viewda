import { useEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 36;
const VIEWPORT_HEIGHT = 288;
const OVERSCAN_ROWS = 3;

export interface ColumnPickerColumn {
  sourceIndex: number;
  name: string;
  type: string;
  visible: boolean;
}

export function ColumnPicker({
  columns,
  onHideAll,
  onShowAll,
  onToggle,
}: {
  columns: readonly ColumnPickerColumn[];
  onHideAll: () => void;
  onShowAll: () => void;
  onToggle: (sourceIndex: number, visible: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<number, HTMLInputElement>());
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
    const current = optionRefs.current.get(column.sourceIndex);
    if (current !== undefined) {
      current.focus();
      return;
    }
    requestAnimationFrame(() =>
      optionRefs.current.get(column.sourceIndex)?.focus(),
    );
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
        style={{ height: VIEWPORT_HEIGHT }}
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
                <label
                  className="column-picker-row"
                  key={column.sourceIndex}
                  style={{
                    height: ROW_HEIGHT,
                    transform: `translateY(${filteredIndex * ROW_HEIGHT}px)`,
                  }}
                >
                  <input
                    ref={(input) => {
                      if (input === null) {
                        optionRefs.current.delete(column.sourceIndex);
                      } else {
                        optionRefs.current.set(column.sourceIndex, input);
                      }
                    }}
                    type="checkbox"
                    aria-label={`Show ${column.name}`}
                    checked={column.visible}
                    onChange={(event) =>
                      onToggle(column.sourceIndex, event.target.checked)
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
                        onToggle(column.sourceIndex, !column.visible);
                      }
                    }}
                  />
                  <span className="column-picker-name" title={column.name}>
                    {column.name}
                  </span>
                  <span className="column-picker-type" title={column.type}>
                    {column.type}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <span className="column-picker-count" role="status">
        {normalizedQuery.length === 0
          ? `${visibleCount.toLocaleString("en-US")} of ${columns.length.toLocaleString("en-US")} shown`
          : `${filteredColumns.length.toLocaleString("en-US")} matching columns`}
      </span>
    </div>
  );
}
