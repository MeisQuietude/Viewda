import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  binaryValueBytes,
  formatBinaryHexRow,
  formatByteSize,
  formatValuePath,
  formatValuePreviewTokens,
  fullValueText,
  isNestedValue,
  valueChildAt,
  valueChildCount,
  valueToJson,
  valueTypeLabel,
  type TypedValue,
  type ValuePathSegment,
} from "./value-format";

const TREE_ROW_HEIGHT = 28;
const TREE_OVERSCAN_ROWS = 4;
const HEX_ROW_HEIGHT = 20;
const HEX_OVERSCAN_ROWS = 4;

interface TreeNode {
  id: string;
  parentId: string | null;
  label: string;
  value: TypedValue;
  path: ValuePathSegment[];
  depth: number;
  siblingCount: number;
}

export interface ValueTreeHandle {
  focus(): void;
  copyJson(): void;
  copyPath(): void;
}

export const ValueTree = forwardRef<
  ValueTreeHandle,
  {
    value: TypedValue;
    label: string;
    onCopy: (text: string) => void;
  }
>(function ValueTree({ value, label, onCopy }, forwardedRef) {
  const treeRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([""]),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const expansion = useMemo(() => expansionIndex(expanded), [expanded]);
  const root = useMemo<TreeNode>(
    () => ({
      id: "",
      parentId: null,
      label,
      value,
      path: [],
      depth: 0,
      siblingCount: 1,
    }),
    [label, value],
  );
  const rowCount = visibleSize(root, expanded, expansion);
  const clampedActiveIndex = Math.min(activeIndex, Math.max(0, rowCount - 1));
  const activeNode = nodeAtVisibleIndex(
    root,
    clampedActiveIndex,
    expanded,
    expansion,
  );
  const viewportHeight = treeRef.current?.clientHeight || 340;
  const start = Math.max(
    0,
    Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN_ROWS,
  );
  const end = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) +
      TREE_OVERSCAN_ROWS,
  );
  const rows: Array<{ index: number; node: TreeNode }> = [];
  const rowIndexes = Array.from(
    { length: end - start },
    (_unused, index) => start + index,
  );
  if (clampedActiveIndex < start || clampedActiveIndex >= end) {
    rowIndexes.push(clampedActiveIndex);
    rowIndexes.sort((left, right) => left - right);
  }
  for (const index of rowIndexes) {
    const node = nodeAtVisibleIndex(root, index, expanded, expansion);
    if (node !== undefined) rows.push({ index, node });
  }

  const selectIndex = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(rowCount - 1, index));
      setActiveIndex(next);
      const tree = treeRef.current;
      if (tree !== null) {
        const top = next * TREE_ROW_HEIGHT;
        const bottom = top + TREE_ROW_HEIGHT;
        if (top < tree.scrollTop) tree.scrollTop = top;
        else if (bottom > tree.scrollTop + tree.clientHeight) {
          tree.scrollTop = bottom - tree.clientHeight;
        }
      }
    },
    [rowCount],
  );

  const toggle = useCallback((node: TreeNode, force?: boolean) => {
    if (valueChildCount(node.value) === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      const shouldExpand = force ?? !next.has(node.id);
      if (shouldExpand) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
  }, []);

  const copyNodeJson = useCallback(() => {
    if (activeNode !== undefined) onCopy(valueToJson(activeNode.value));
  }, [activeNode, onCopy]);
  const copyNodePath = useCallback(() => {
    if (activeNode !== undefined) onCopy(formatValuePath(activeNode.path));
  }, [activeNode, onCopy]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => treeRef.current?.focus(),
      copyJson: copyNodeJson,
      copyPath: copyNodePath,
    }),
    [copyNodeJson, copyNodePath],
  );

  useEffect(() => {
    if (activeIndex !== clampedActiveIndex) {
      setActiveIndex(clampedActiveIndex);
    }
  }, [activeIndex, clampedActiveIndex]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const primary = event.metaKey || event.ctrlKey;
    if (primary && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (event.altKey) copyNodePath();
      else copyNodeJson();
      return;
    }
    if (activeNode === undefined) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectIndex(clampedActiveIndex - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selectIndex(clampedActiveIndex + 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (valueChildCount(activeNode.value) === 0) return;
      if (!expanded.has(activeNode.id)) toggle(activeNode, true);
      else selectIndex(clampedActiveIndex + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expanded.has(activeNode.id)) toggle(activeNode, false);
      else if (activeNode.parentId !== null) {
        selectIndex(
          visibleIndexForId(root, activeNode.parentId, expanded, expansion),
        );
      }
    }
  };

  const binaryBytes = binaryValueBytes(root.value);
  const scalarDetail =
    binaryBytes === null && !isNestedValue(root.value)
      ? fullValueText(root.value)
      : null;

  return (
    <div className="value-tree-wrap">
      <div
        ref={treeRef}
        className="value-tree"
        role="tree"
        aria-label={`${label} value`}
        aria-activedescendant={treeRowId(treeId, activeNode?.id ?? "")}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className="value-tree-spacer"
          style={{ height: rowCount * TREE_ROW_HEIGHT }}
        >
          {rows.map(({ index, node }) => {
            const childCount = valueChildCount(node.value);
            const open = expanded.has(node.id);
            return (
              <div
                id={treeRowId(treeId, node.id)}
                key={node.id}
                className={`value-tree-row${index === clampedActiveIndex ? " is-active" : ""}${
                  node.value.kind === "value" && node.value.value == null
                    ? " is-null"
                    : ""
                }`}
                role="treeitem"
                aria-level={node.depth + 1}
                aria-posinset={
                  node.id === ""
                    ? 1
                    : Number(node.id.slice(node.id.lastIndexOf("/") + 1)) + 1
                }
                aria-setsize={node.siblingCount}
                aria-expanded={childCount === 0 ? undefined : open}
                aria-selected={index === clampedActiveIndex}
                data-tree-node-id={node.id || "root"}
                style={{
                  top: index * TREE_ROW_HEIGHT,
                  paddingLeft: 8 + node.depth * 16,
                }}
                onClick={() => {
                  setActiveIndex(index);
                  treeRef.current?.focus();
                }}
                onDoubleClick={() => toggle(node)}
              >
                <button
                  className="value-tree-chevron"
                  type="button"
                  tabIndex={-1}
                  aria-label={
                    open ? `Collapse ${node.label}` : `Expand ${node.label}`
                  }
                  disabled={childCount === 0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveIndex(index);
                    toggle(node);
                    treeRef.current?.focus();
                  }}
                >
                  {childCount === 0 ? "" : open ? "▾" : "▸"}
                </button>
                <span className="value-tree-name">{node.label}</span>
                <span className="value-tree-preview">
                  {formatValuePreviewTokens(node.value, 84).map(
                    (token, tokenIndex) => (
                      <span
                        key={tokenIndex}
                        className={`cell-preview-${token.tone}`}
                      >
                        {token.text}
                      </span>
                    ),
                  )}
                </span>
                <span className="value-tree-type">
                  {valueTypeLabel(node.value)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {binaryBytes !== null ? (
        <BinaryDetail bytes={binaryBytes} label={label} />
      ) : (
        scalarDetail !== null && (
          <pre className="value-peek-detail">{scalarDetail}</pre>
        )
      )}
    </div>
  );
});

// Expanded ids are ordinal paths. Visible sizes skip collapsed sibling ranges
// arithmetically, so lookup visits only the target path and expanded subtrees.
function expansionIndex(
  expanded: ReadonlySet<string>,
): ReadonlyMap<string, number[]> {
  const children = new Map<string, number[]>();
  for (const id of expanded) {
    if (id === "") continue;
    const separator = id.lastIndexOf("/");
    const parent = id.slice(0, separator);
    const ordinal = Number(id.slice(separator + 1));
    const ordinals = children.get(parent) ?? [];
    ordinals.push(ordinal);
    children.set(parent, ordinals);
  }
  for (const ordinals of children.values()) ordinals.sort((a, b) => a - b);
  return children;
}

function visibleSize(
  node: TreeNode,
  expanded: ReadonlySet<string>,
  expansion: ReadonlyMap<string, readonly number[]>,
): number {
  if (!expanded.has(node.id)) return 1;
  let size = 1 + valueChildCount(node.value);
  for (const ordinal of expansion.get(node.id) ?? []) {
    const child = childNode(node, ordinal);
    if (child !== undefined)
      size += visibleSize(child, expanded, expansion) - 1;
  }
  return size;
}

function nodeAtVisibleIndex(
  node: TreeNode,
  index: number,
  expanded: ReadonlySet<string>,
  expansion: ReadonlyMap<string, readonly number[]>,
): TreeNode | undefined {
  if (index === 0) return node;
  if (!expanded.has(node.id)) return undefined;
  let remaining = index - 1;
  let ordinal = 0;
  for (const expandedOrdinal of expansion.get(node.id) ?? []) {
    const gap = expandedOrdinal - ordinal;
    if (remaining < gap) return childNode(node, ordinal + remaining);
    remaining -= gap;
    const child = childNode(node, expandedOrdinal);
    if (child === undefined) return undefined;
    const childSize = visibleSize(child, expanded, expansion);
    if (remaining < childSize) {
      return nodeAtVisibleIndex(child, remaining, expanded, expansion);
    }
    remaining -= childSize;
    ordinal = expandedOrdinal + 1;
  }
  return childNode(node, ordinal + remaining);
}

function visibleIndexForId(
  root: TreeNode,
  id: string,
  expanded: ReadonlySet<string>,
  expansion: ReadonlyMap<string, readonly number[]>,
): number {
  if (id === "") return 0;
  const ordinals = id.slice(1).split("/").map(Number);
  let node = root;
  let index = 0;
  for (const targetOrdinal of ordinals) {
    index += 1 + targetOrdinal;
    for (const expandedOrdinal of expansion.get(node.id) ?? []) {
      if (expandedOrdinal >= targetOrdinal) break;
      const expandedChild = childNode(node, expandedOrdinal);
      if (expandedChild !== undefined) {
        index += visibleSize(expandedChild, expanded, expansion) - 1;
      }
    }
    const child = childNode(node, targetOrdinal);
    if (child === undefined) break;
    node = child;
  }
  return index;
}

function childNode(parent: TreeNode, ordinal: number): TreeNode | undefined {
  const child = valueChildAt(parent.value, ordinal);
  return child === undefined
    ? undefined
    : {
        id: `${parent.id}/${ordinal}`,
        parentId: parent.id,
        label: child.label,
        value: child.value,
        path: [...parent.path, child.pathSegment],
        depth: parent.depth + 1,
        siblingCount: valueChildCount(parent.value),
      };
}

function BinaryDetail({ bytes, label }: { bytes: Uint8Array; label: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rowCount = Math.ceil(bytes.byteLength / 16);
  const viewportHeight = viewportRef.current?.clientHeight || 120;
  const start = Math.max(
    0,
    Math.floor(scrollTop / HEX_ROW_HEIGHT) - HEX_OVERSCAN_ROWS,
  );
  const end = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportHeight) / HEX_ROW_HEIGHT) +
      HEX_OVERSCAN_ROWS,
  );
  const rows: number[] = [];
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    rows.push(rowIndex);
  }

  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0;
  }, [bytes]);

  return (
    <div className="value-peek-detail is-binary">
      <div className="value-peek-binary-summary">
        binary · {formatByteSize(bytes.byteLength)}
      </div>
      <div
        ref={viewportRef}
        className="value-peek-binary-viewport"
        role="region"
        aria-label={`${label} hex dump`}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className="value-peek-binary-spacer"
          style={{ height: rowCount * HEX_ROW_HEIGHT }}
        >
          {rows.map((rowIndex) => (
            <code
              key={rowIndex}
              className="value-peek-binary-row"
              style={{ top: rowIndex * HEX_ROW_HEIGHT }}
            >
              {formatBinaryHexRow(bytes, rowIndex)}
            </code>
          ))}
        </div>
      </div>
    </div>
  );
}

function treeRowId(prefix: string, id: string): string {
  return `${prefix}-value-tree-row-${
    id === "" ? "root" : id.slice(1).replaceAll("/", "-")
  }`;
}
