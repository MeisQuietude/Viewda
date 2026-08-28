import { useEffect, useMemo, useRef, useState } from "react";

import {
  inferJsonSchema,
  type FieldPath,
  type JsonFieldTarget,
  type JsonPath,
  type JsonSchemaInference,
  type JsonSchemaNode,
  type JsonValueType,
} from "../desktop";
import {
  formatJsonPath,
  jsonPathKey,
  parseJsonPath,
  sameJsonPath,
} from "./json-path";

const ROW_HEIGHT = 44;
const VIEWPORT_HEIGHT = 220;
const OVERSCAN_ROWS = 3;
const INFERENCE_CACHE_LIMIT = 8;
const inferenceCache = new Map<string, Promise<JsonSchemaInference>>();

interface JsonPathRow {
  id: string;
  path: JsonPath;
  node: JsonSchemaNode;
  depth: number;
  ancestorIds: readonly string[];
  label: string;
}

export function JsonPathPicker({
  generation,
  sourceRevisionKey = "",
  fieldPath,
  target,
  onChange,
}: {
  generation: number;
  sourceRevisionKey?: string;
  fieldPath: FieldPath;
  target: JsonFieldTarget | null;
  onChange: (target: JsonFieldTarget | null) => void;
}) {
  const sourceKey = jsonSchemaInferenceKey(
    generation,
    sourceRevisionKey,
    fieldPath,
  );
  const fieldPathRef = useRef(fieldPath);
  fieldPathRef.current = fieldPath;
  const [inference, setInference] = useState<JsonSchemaInference | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [manualPath, setManualPath] = useState(() =>
    target === null ? "" : formatJsonPath(target.path),
  );
  const [manualType, setManualType] = useState<JsonValueType>(
    target?.valueType ?? "text",
  );

  useEffect(() => {
    let active = true;
    setInference(null);
    setLoading(true);
    setLoadFailed(false);
    setActiveRowId(null);
    void cachedJsonSchemaInference(
      generation,
      sourceRevisionKey,
      fieldPathRef.current,
    ).then(
      (result) => {
        if (!active) return;
        setInference(result);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [sourceKey, generation, sourceRevisionKey]);

  const rows = useMemo(
    () => flattenJsonSchema(inference?.nodes ?? []),
    [inference],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredRows = useMemo(() => {
    if (normalizedQuery.length === 0) return rows;
    const included = new Set<string>();
    for (const row of rows) {
      if (!row.label.toLocaleLowerCase().includes(normalizedQuery)) continue;
      included.add(row.id);
      row.ancestorIds.forEach((id) => included.add(id));
    }
    return rows.filter((row) => included.has(row.id));
  }, [normalizedQuery, rows]);
  const firstRow = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS,
  );
  const renderedRowCount =
    Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const renderedRows = filteredRows.slice(
    firstRow,
    firstRow + renderedRowCount,
  );
  const firstVisibleRow = Math.floor(scrollTop / ROW_HEIGHT);
  const rovingRowId =
    activeRowId !== null && renderedRows.some((row) => row.id === activeRowId)
      ? activeRowId
      : (filteredRows[firstVisibleRow]?.id ?? renderedRows[0]?.id);
  const parsedManualPath = parseJsonPath(manualPath);

  const focusRow = (index: number) => {
    const row = filteredRows[index];
    if (row === undefined) return;
    setActiveRowId(row.id);
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const nextScrollTop =
      rowTop < scrollTop
        ? rowTop
        : rowBottom > scrollTop + VIEWPORT_HEIGHT
          ? rowBottom - VIEWPORT_HEIGHT
          : scrollTop;
    if (nextScrollTop !== scrollTop) {
      if (treeRef.current !== null) treeRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
    const current = rowRefs.current.get(row.id);
    if (current !== undefined) {
      current.focus();
      return;
    }
    requestAnimationFrame(() => rowRefs.current.get(row.id)?.focus());
  };

  const updateManualTarget = (pathText: string, valueType: JsonValueType) => {
    const parsed = parseJsonPath(pathText);
    onChange(parsed.path === null ? null : { path: parsed.path, valueType });
  };

  return (
    <section className="json-path-picker" aria-label="JSON field">
      <p className="json-path-cost-note">
        JSON field extraction scans the JSON column and may take longer on large
        files.
      </p>
      {loading && <p role="status">Finding fields in the JSON sample…</p>}
      {loadFailed && (
        <p role="alert">
          Sampled fields could not be loaded. Enter a path manually below.
        </p>
      )}
      {inference !== null && (
        <>
          <p className="json-path-sample-note">
            Sample-derived fields from at most the first{" "}
            {inference.sampleRowLimit.toLocaleString("en-US")} rows;{" "}
            {inference.sampledRowCount.toLocaleString("en-US")} rows were
            sampled.
          </p>
          {inference.hasMoreRows && (
            <p className="json-path-sample-note">
              Later rows may contain other fields. Enter those paths manually.
            </p>
          )}
          {inference.isTruncated && (
            <p className="json-path-sample-warning" role="status">
              Some fields could not be listed because sampled values were too
              deep, too wide, or too large.
            </p>
          )}
          {inference.invalidValueCount > 0 && (
            <p className="json-path-sample-warning" role="status">
              {inference.invalidValueCount.toLocaleString("en-US")} sampled{" "}
              {inference.invalidValueCount === 1 ? "value was" : "values were"}{" "}
              not valid JSON.
            </p>
          )}
          {inference.oversizedValueCount > 0 && (
            <p className="json-path-sample-warning" role="status">
              {inference.oversizedValueCount.toLocaleString("en-US")} sampled{" "}
              {inference.oversizedValueCount === 1
                ? "value was"
                : "values were"}{" "}
              too large to inspect.
            </p>
          )}
          <input
            ref={searchRef}
            type="search"
            aria-label="Search sampled JSON fields"
            placeholder="Search sampled fields"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setScrollTop(0);
              setActiveRowId(null);
              if (treeRef.current !== null) treeRef.current.scrollTop = 0;
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusRow(0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusRow(filteredRows.length - 1);
              }
            }}
          />
          <div
            ref={treeRef}
            className="json-path-tree"
            role="tree"
            aria-label="Sampled JSON fields"
            style={{
              height: Math.min(
                VIEWPORT_HEIGHT,
                filteredRows.length * ROW_HEIGHT,
              ),
            }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {filteredRows.length === 0 ? (
              <p>No sampled fields match.</p>
            ) : (
              <div style={{ height: filteredRows.length * ROW_HEIGHT }}>
                {renderedRows.map((row, renderedIndex) => {
                  const selected =
                    target !== null && sameJsonPath(target.path, row.path);
                  const selectable = row.node.effectiveType !== null;
                  return (
                    <button
                      ref={(button) => {
                        if (button === null) rowRefs.current.delete(row.id);
                        else rowRefs.current.set(row.id, button);
                      }}
                      key={row.id}
                      className="json-path-tree-row"
                      type="button"
                      role="treeitem"
                      aria-level={row.depth + 1}
                      aria-selected={selected}
                      aria-disabled={!selectable}
                      aria-label={`${row.label} ${
                        row.node.effectiveType === null
                          ? "container"
                          : jsonValueTypeLabel(row.node.effectiveType)
                      }`}
                      tabIndex={row.id === rovingRowId ? 0 : -1}
                      style={{
                        paddingLeft: 8 + row.depth * 14 + "px",
                        transform:
                          "translateY(" +
                          (firstRow + renderedIndex) * ROW_HEIGHT +
                          "px)",
                      }}
                      onClick={() => {
                        const valueType = row.node.effectiveType;
                        if (valueType === null) return;
                        const pathText = formatJsonPath(row.path);
                        setManualPath(pathText);
                        setManualType(valueType);
                        onChange({ path: row.path, valueType });
                      }}
                      onFocus={() => setActiveRowId(row.id)}
                      onKeyDown={(event) => {
                        const index = firstRow + renderedIndex;
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          focusRow(index + 1);
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          if (index === 0) searchRef.current?.focus();
                          else focusRow(index - 1);
                        }
                      }}
                    >
                      <code>{row.label}</code>
                      <span>
                        {row.node.effectiveType === null
                          ? "container"
                          : jsonValueTypeLabel(row.node.effectiveType)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
      <label>
        <span>Manual JSON path</span>
        <input
          value={manualPath}
          aria-invalid={manualPath.length > 0 && parsedManualPath.path === null}
          placeholder={'items[0]."unit.price"'}
          onChange={(event) => {
            const next = event.target.value;
            setManualPath(next);
            updateManualTarget(next, manualType);
          }}
        />
      </label>
      <label>
        <span>Value type</span>
        <select
          value={manualType}
          onChange={(event) => {
            const next = event.target.value as JsonValueType;
            setManualType(next);
            updateManualTarget(manualPath, next);
          }}
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="mixed">Mixed values (text operators)</option>
        </select>
      </label>
      {manualPath.length > 0 && parsedManualPath.error !== null && (
        <p className="json-path-manual-error" role="alert">
          {parsedManualPath.error}
        </p>
      )}
      <p className="json-path-manual-hint">
        Use dots between object keys, double quotes around keys with spaces or
        punctuation, doubled quotes inside a quoted key, and brackets for array
        indices.
      </p>
    </section>
  );
}

function cachedJsonSchemaInference(
  generation: number,
  sourceRevisionKey: string,
  fieldPath: FieldPath,
): Promise<JsonSchemaInference> {
  const key = jsonSchemaInferenceKey(generation, sourceRevisionKey, fieldPath);
  const existing = inferenceCache.get(key);
  if (existing !== undefined) {
    inferenceCache.delete(key);
    inferenceCache.set(key, existing);
    return existing;
  }

  const request = inferJsonSchema(generation, fieldPath);
  void request.catch(() => {
    if (inferenceCache.get(key) === request) inferenceCache.delete(key);
  });
  inferenceCache.set(key, request);
  if (inferenceCache.size > INFERENCE_CACHE_LIMIT) {
    const oldestKey = inferenceCache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) inferenceCache.delete(oldestKey);
  }
  return request;
}

function jsonSchemaInferenceKey(
  generation: number,
  sourceRevisionKey: string,
  fieldPath: FieldPath,
): string {
  return JSON.stringify([generation, sourceRevisionKey, fieldPath]);
}

function flattenJsonSchema(nodes: readonly JsonSchemaNode[]): JsonPathRow[] {
  const rows: JsonPathRow[] = [];
  const visit = (
    node: JsonSchemaNode,
    path: JsonPath,
    depth: number,
    ancestorIds: readonly string[],
  ) => {
    const id = jsonPathKey(path);
    rows.push({
      id,
      path,
      node,
      depth,
      ancestorIds,
      label: formatJsonPath(path),
    });
    for (const child of node.children) {
      visit(child, [...path, child.segment], depth + 1, [...ancestorIds, id]);
    }
  };
  for (const node of nodes) visit(node, [node.segment], 0, []);
  return rows;
}

function jsonValueTypeLabel(valueType: JsonValueType): string {
  switch (valueType) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "text":
      return "text";
    case "mixed":
      return "mixed · text";
  }
}
