import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Type, type DataType } from "@uwdata/flechette";

import { ChunkScheduler } from "./chunk-scheduler";
import {
  ChunkedJsonSource,
  createIncrementalJsonParser,
  sourceSlice,
} from "./json-value";
import { arrowUtf8Bytes } from "./arrow-value";
import {
  createValueJsonSerializer,
  ValueCopyLimitError,
} from "./value-json-serializer";
import { codePointSafePrefix } from "./unicode";
import type { FieldPath } from "../desktop";
import { formatFieldPath, formatFieldPathSegment } from "./field-path";
import {
  BINARY_HEX_ROW_BYTES,
  binaryValueBytes,
  formatBinaryHexRow,
  formatByteSize,
  formatValuePreviewTokens,
  fullValueText,
  invalidJsonValue,
  rawJsonValue,
  parsedJsonValue,
  valueChildAt,
  valueChildCount,
  valueSearchText,
  valueTypeLabel,
  type PreviewToken,
  type TypedValue,
  type ValueSearchText,
} from "./value-format";
import {
  AllExpansionBuilder,
  IncrementalTreeSearch,
  ReverseDepthFirstTreeWalker,
  allVisibleSize,
  collapsedRanges,
  rawIndexAtVisibleIndex,
  visibleIndexForRawIndex,
  type AllExpansionIndex,
  type CollapsedRange,
  type SearchSnippet,
  type TreeSearchAdapter,
  type TreeSearchMatch,
} from "./value-tree-model";

const TREE_ROW_HEIGHT = 28;
const TREE_OVERSCAN_ROWS = 4;
const HEX_ROW_HEIGHT = 20;
const HEX_OVERSCAN_ROWS = 4;
const JSON_PARSE_CHARACTERS = 16_384;
const OPERATION_NODES = 256;
const SEARCH_CHARACTERS = 32_768;
const MATCH_CACHE_SIZE = 256;
const MATCH_CACHE_PREFIX = 64;
const RAW_PREVIEW_CHARACTERS = 8_192;
const MAX_TREE_INDENT = 32;

interface TreeNode {
  id: string;
  parent: TreeNode | null;
  ordinal: number;
  label: string;
  labelSearch?: ValueSearchText;
  objectKey?: string;
  key: boolean;
  value: TypedValue;
  depth: number;
  siblingCount: number;
}

interface TreeLocator {
  parent: TreeLocator | null;
  ordinal: number;
}

interface TraversalNode {
  parent: TraversalNode | null;
  locator: TreeLocator;
  ordinal: number;
  depth: number;
  labelSearch?: ValueSearchText;
  key: boolean;
  value: TypedValue;
}

interface CachedSearchMatch {
  ordinal: number;
  locator: TreeLocator;
  rawIndex: number | null;
  location: "key" | "value";
  snippet: SearchSnippet;
}

interface CurrentSearchMatch extends CachedSearchMatch {
  id: string;
}

interface LocateCursor {
  scan: IncrementalTreeSearch<TraversalNode>;
  seen: number;
}

type OperationStatus =
  | {
      kind: "expand";
      phase: "running" | "canceled";
      visited: number;
    }
  | {
      kind: "search";
      phase: "running" | "canceled" | "complete" | "locating";
      visited: number;
      characters: number;
      matches: number;
      current: number;
    };

interface SearchViewSnapshot {
  expanded: ReadonlySet<string>;
  allIndex: AllExpansionIndex | null;
  collapsed: ReadonlySet<number>;
  activeId: string;
}

export interface ValueTreeHandle {
  focus(): void;
}

export type ValueCopyHandlers =
  | {
      onCopy: (text: string) => void | Promise<void>;
      onCopyIntent?: never;
    }
  | {
      onCopy?: never;
      onCopyIntent: (text: Promise<string>) => void | Promise<void>;
    };

export const ValueTree = forwardRef<
  ValueTreeHandle,
  {
    value: TypedValue;
    label: string;
    fieldPath?: FieldPath;
    onPromoteField?: (fieldPath: FieldPath) => void;
  } & ValueCopyHandlers
>(function ValueTree(
  { value, label, fieldPath, onPromoteField, onCopy, onCopyIntent },
  forwardedRef,
) {
  const treeRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const [schedulerRef] = useState(() => ({ current: new ChunkScheduler() }));
  const [copySchedulerRef] = useState(() => ({
    current: new ChunkScheduler(),
  }));
  const copyGenerationRef = useRef(0);
  const copyWritingGenerationRef = useRef<number | null>(null);
  const copyIntentRef = useRef<{
    generation: number;
    reject: (reason: unknown) => void;
  } | null>(null);
  const generationRef = useRef(0);
  const firstValueEffectRef = useRef(true);
  const [preparedValue, setPreparedValue] = useState(value);
  const [parseStatus, setParseStatus] = useState<{
    phase: "running" | "canceled";
    offset: number;
    total: number;
  } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(["root"]),
  );
  const [allIndex, setAllIndex] = useState<AllExpansionIndex | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [activeId, setActiveId] = useState("root");
  const [scrollTop, setScrollTop] = useState(0);
  const [query, setQuery] = useState("");
  const [operation, setOperation] = useState<OperationStatus | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [currentMatch, setCurrentMatch] = useState<CurrentSearchMatch | null>(
    null,
  );
  const [matchCacheRef] = useState(() => ({
    current: new Map<number, CachedSearchMatch>(),
  }));
  const locateCursorsRef = useRef<{
    forward: LocateCursor | null;
    reverse: LocateCursor | null;
  }>({ forward: null, reverse: null });
  const currentOrdinalRef = useRef(0);
  const searchSnapshotRef = useRef<SearchViewSnapshot | null>(null);

  const root = useMemo<TreeNode>(
    () => createRootNode(label, preparedValue),
    [label, preparedValue],
  );
  const scheduleJsonParse = useCallback(
    (input: Extract<TypedValue, { kind: "jsonText" }>) => {
      const generation = ++generationRef.current;
      schedulerRef.current.cancel();
      const parser = createIncrementalJsonParser(input.value);
      setPreparedValue(input);
      setParseStatus({
        phase: "running",
        offset: 0,
        total: input.value.length,
      });
      schedulerRef.current.start({
        runChunk: () => {
          if (generationRef.current !== generation) return true;
          const result = parser.step(JSON_PARSE_CHARACTERS);
          if (result.status === "pending") {
            setParseStatus({
              phase: "running",
              offset: result.offset,
              total: input.value.length,
            });
            return false;
          }
          setParseStatus(null);
          setPreparedValue(
            result.status === "done"
              ? parsedJsonValue(input.value, result.node, true)
              : result.status === "metadataLimit"
                ? rawJsonValue(input.value, input.dataType)
                : invalidJsonValue(input.value, input.dataType, result.offset),
          );
          return true;
        },
      });
    },
    [],
  );
  const scheduleArrowJsonParse = useCallback(
    (input: Extract<TypedValue, { kind: "arrow" }>) => {
      const range = arrowUtf8Bytes(input);
      if (range === null) return;
      const generation = ++generationRef.current;
      schedulerRef.current.cancel();
      const source = new ChunkedJsonSource();
      const decoder = new TextDecoder();
      let byteOffset = range.start;
      let parser: ReturnType<typeof createIncrementalJsonParser> | null = null;
      // The parser-owned rope also backs the raw detail while parsing. This
      // keeps Cancel in control of the only Arrow byte-advance job.
      setPreparedValue({
        kind: "jsonText",
        value: source,
        dataType: input.dataType,
      });
      setParseStatus({
        phase: "running",
        offset: 0,
        total: range.end - range.start,
      });
      schedulerRef.current.start({
        runChunk: (deadline, maxUnits) => {
          if (generationRef.current !== generation) return true;
          if (parser === null) {
            let worked = false;
            let units = 0;
            const unitLimit = Math.min(maxUnits, 64);
            while (
              byteOffset < range.end &&
              units < unitLimit &&
              (!worked || performance.now() < deadline)
            ) {
              worked = true;
              units += 1;
              const end = Math.min(range.end, byteOffset + 16_384);
              source.append(
                decoder.decode(range.bytes.subarray(byteOffset, end), {
                  stream: end < range.end,
                }),
              );
              byteOffset = end;
            }
            setParseStatus({
              phase: "running",
              offset: byteOffset - range.start,
              total: range.end - range.start,
            });
            if (byteOffset < range.end) return false;
            parser = createIncrementalJsonParser(source);
          }
          const result = parser.step(JSON_PARSE_CHARACTERS);
          if (result.status === "pending") {
            setParseStatus({
              phase: "running",
              offset: result.offset,
              total: source.length,
            });
            return false;
          }
          setParseStatus(null);
          setPreparedValue(
            result.status === "done"
              ? parsedJsonValue(source, result.node, true)
              : result.status === "metadataLimit"
                ? rawJsonValue(source, input.dataType)
                : invalidJsonValue(source, input.dataType, result.offset),
          );
          return true;
        },
      });
    },
    [],
  );

  useEffect(() => {
    generationRef.current += 1;
    const firstValue = firstValueEffectRef.current;
    firstValueEffectRef.current = false;
    schedulerRef.current.cancel();
    copyGenerationRef.current += 1;
    copySchedulerRef.current.cancel();
    copyIntentRef.current?.reject(copyAbortError());
    copyIntentRef.current = null;
    copyWritingGenerationRef.current = null;
    setCopying(false);
    setCopyError(null);
    setCopyMessage(null);
    const arrowJson = value.kind === "arrow" && value.logicalType === "JSON";
    if (!firstValue || value.kind === "jsonText" || arrowJson) {
      setPreparedValue(value);
      setParseStatus(null);
      setExpanded(new Set(["root"]));
      setAllIndex(null);
      setCollapsed(new Set());
      setActiveId("root");
      setScrollTop(0);
      setQuery("");
      setOperation(null);
      setCurrentMatch(null);
      matchCacheRef.current.clear();
      locateCursorsRef.current = { forward: null, reverse: null };
      currentOrdinalRef.current = 0;
      searchSnapshotRef.current = null;
    }
    if (value.kind === "jsonText") {
      scheduleJsonParse(value);
    } else if (arrowJson) {
      scheduleArrowJsonParse(value);
    }
    return () => {
      generationRef.current += 1;
      schedulerRef.current.cancel();
    };
  }, [scheduleArrowJsonParse, scheduleJsonParse, value]);

  useEffect(
    () => () => {
      copyGenerationRef.current += 1;
      copySchedulerRef.current.cancel();
      copyIntentRef.current?.reject(copyAbortError());
      copyIntentRef.current = null;
      copyWritingGenerationRef.current = null;
    },
    [],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({ focus: () => treeRef.current?.focus() }),
    [],
  );

  const sparseExpansion = useMemo(
    () => expansionIndex(root, expanded),
    [expanded, root],
  );
  const ranges = useMemo(
    () => (allIndex === null ? [] : collapsedRanges(allIndex, collapsed)),
    [allIndex, collapsed],
  );
  const rowCount =
    allIndex === null
      ? visibleSize(root, expanded, sparseExpansion)
      : allVisibleSize(allIndex, ranges);
  const nodeAtIndex = useCallback(
    (index: number) =>
      allIndex === null
        ? nodeAtVisibleIndex(root, index, expanded, sparseExpansion)
        : nodeAtAllVisibleIndex(root, allIndex, ranges, index),
    [allIndex, expanded, ranges, root, sparseExpansion],
  );
  const { computedActiveIndex, activeIndex, activeNode, rows } = useMemo(() => {
    const computed =
      allIndex === null
        ? visibleIndexForNode(
            nodeForId(root, activeId),
            expanded,
            sparseExpansion,
          )
        : visibleIndexForAllNode(allIndex, ranges, nodeForId(root, activeId));
    const selected =
      computed === undefined
        ? 0
        : Math.min(computed, Math.max(0, rowCount - 1));
    const materializeAll =
      allIndex === null ? null : createAllNodeMaterializer(root, allIndex);
    const nodeForIndex = (index: number) => {
      if (allIndex === null) {
        return nodeAtVisibleIndex(root, index, expanded, sparseExpansion);
      }
      const rawIndex = rawIndexAtVisibleIndex(allIndex, ranges, index);
      return rawIndex === undefined ? undefined : materializeAll!(rawIndex);
    };
    const selectedNode = nodeForIndex(selected);
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
    const rowIndexes = Array.from(
      { length: end - start },
      (_unused, index) => start + index,
    );
    // aria-activedescendant must resolve even after manual scrolling moves the
    // selected row outside the virtual window.
    if (selected < start || selected >= end) {
      rowIndexes.push(selected);
      rowIndexes.sort((left, right) => left - right);
    }
    const nextRows: Array<{ index: number; node: TreeNode }> = [];
    for (const index of rowIndexes) {
      const node = nodeForIndex(index);
      if (node !== undefined) nextRows.push({ index, node });
    }
    return {
      computedActiveIndex: computed,
      activeIndex: selected,
      activeNode: selectedNode,
      rows: nextRows,
    };
  }, [
    activeId,
    allIndex,
    expanded,
    ranges,
    root,
    rowCount,
    scrollTop,
    sparseExpansion,
  ]);

  useEffect(() => {
    if (computedActiveIndex === undefined) setActiveId("root");
  }, [computedActiveIndex]);

  useEffect(() => {
    const tree = treeRef.current;
    if (tree === null) return;
    const top = activeIndex * TREE_ROW_HEIGHT;
    const bottom = top + TREE_ROW_HEIGHT;
    if (top < tree.scrollTop) tree.scrollTop = top;
    else if (bottom > tree.scrollTop + tree.clientHeight) {
      tree.scrollTop = bottom - tree.clientHeight;
    }
  }, [activeIndex]);

  const selectIndex = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(rowCount - 1, index));
      const node = nodeAtIndex(next);
      if (node !== undefined) setActiveId(node.id);
    },
    [nodeAtIndex, rowCount],
  );

  const isOpen = useCallback(
    (node: TreeNode) => {
      if (allIndex === null) return expanded.has(node.id);
      const rawIndex = rawIndexForNode(allIndex, node);
      return rawIndex !== undefined && !collapsed.has(rawIndex);
    },
    [allIndex, collapsed, expanded],
  );

  const toggle = useCallback(
    (node: TreeNode, force?: boolean) => {
      if (valueChildCount(node.value) === 0) return;
      if (allIndex !== null) {
        const rawIndex = rawIndexForNode(allIndex, node);
        if (rawIndex === undefined) return;
        setCollapsed((current) => {
          const next = new Set(current);
          const shouldExpand = force ?? next.has(rawIndex);
          if (shouldExpand) next.delete(rawIndex);
          else next.add(rawIndex);
          return next;
        });
      } else {
        setExpanded((current) => {
          const next = new Set(current);
          const shouldExpand = force ?? !next.has(node.id);
          if (shouldExpand) next.add(node.id);
          else next.delete(node.id);
          return next;
        });
      }
    },
    [allIndex],
  );
  const activateRow = useCallback((node: TreeNode) => {
    setActiveId(node.id);
    treeRef.current?.focus();
  }, []);
  const toggleRow = useCallback(
    (node: TreeNode) => {
      setActiveId(node.id);
      toggle(node);
      treeRef.current?.focus();
    },
    [toggle],
  );

  const revealMatch = useCallback(
    (match: CachedSearchMatch) => {
      const node = materializeLocator(root, match.locator);
      if (node === undefined) return;
      const ancestors = ancestorIds(node);
      if (allIndex === null) {
        setExpanded(
          (current) =>
            new Set([
              ...(searchSnapshotRef.current?.expanded ?? current),
              ...ancestors,
            ]),
        );
      } else {
        const matchRawPath =
          match.rawIndex === null
            ? rawPathForNode(allIndex, node)
            : rawParentPath(allIndex, match.rawIndex);
        setCollapsed((current) => {
          const next = new Set(current);
          if (matchRawPath !== undefined) {
            for (const rawIndex of matchRawPath.slice(0, -1)) {
              next.delete(rawIndex);
            }
          }
          return next;
        });
      }
      currentOrdinalRef.current = match.ordinal;
      setCurrentMatch({ ...match, id: node.id });
      setActiveId(node.id);
    },
    [allIndex, root],
  );

  const cacheMatch = useCallback((match: CachedSearchMatch) => {
    const cache = matchCacheRef.current;
    cache.set(match.ordinal, match);
    if (cache.size <= MATCH_CACHE_SIZE) return;
    for (const ordinal of cache.keys()) {
      if (
        ordinal > MATCH_CACHE_PREFIX &&
        ordinal !== currentOrdinalRef.current
      ) {
        cache.delete(ordinal);
        break;
      }
    }
  }, []);

  const startSearch = useCallback(
    (nextQuery: string) => {
      const generation = ++generationRef.current;
      schedulerRef.current.cancel();
      matchCacheRef.current.clear();
      locateCursorsRef.current = { forward: null, reverse: null };
      currentOrdinalRef.current = 0;
      setCurrentMatch(null);
      const traversal = createTraversal(root.value);
      const scan = new IncrementalTreeSearch(
        traversal.root,
        traversal.adapter,
        nextQuery,
      );
      let matches = 0;
      setOperation({
        kind: "search",
        phase: "running",
        visited: 0,
        characters: 0,
        matches: 0,
        current: 0,
      });
      schedulerRef.current.start({
        runChunk: () => {
          if (generationRef.current !== generation) return true;
          let first: CachedSearchMatch | null = null;
          const result = scan.run(
            OPERATION_NODES,
            SEARCH_CHARACTERS,
            (found: TreeSearchMatch<TraversalNode>) => {
              matches += 1;
              const match: CachedSearchMatch = {
                ordinal: matches,
                locator: found.node.locator,
                rawIndex: scan.visited,
                location: found.location,
                snippet: found.snippet,
              };
              cacheMatch(match);
              first ??= match;
            },
          );
          if (currentOrdinalRef.current === 0 && first !== null) {
            revealMatch(first);
          }
          setOperation({
            kind: "search",
            phase: result.done ? "complete" : "running",
            visited: result.visited,
            characters: result.characters,
            matches,
            current: currentOrdinalRef.current || (matches > 0 ? 1 : 0),
          });
          return result.done;
        },
      });
    },
    [cacheMatch, revealMatch, root.value],
  );

  const startLocate = useCallback(
    (
      ordinal: number,
      matches: number,
      totalVisited: number,
      totalCharacters: number,
      direction: 1 | -1,
    ) => {
      const generation = ++generationRef.current;
      schedulerRef.current.cancel();
      const cursorKey = direction > 0 ? "forward" : "reverse";
      const targetPosition = direction > 0 ? ordinal : matches - ordinal + 1;
      let cursor = locateCursorsRef.current[cursorKey];
      if (cursor === null || cursor.seen >= targetPosition) {
        const traversal = createTraversal(root.value);
        const walker =
          direction > 0
            ? undefined
            : new ReverseDepthFirstTreeWalker(
                traversal.root,
                traversal.adapter,
              );
        cursor = {
          scan: new IncrementalTreeSearch(
            traversal.root,
            traversal.adapter,
            query,
            walker,
          ),
          seen: 0,
        };
        locateCursorsRef.current[cursorKey] = cursor;
      }
      const activeCursor = cursor;
      setOperation((current) =>
        current?.kind === "search"
          ? { ...current, phase: "locating", current: ordinal }
          : current,
      );
      schedulerRef.current.start({
        runChunk: () => {
          if (generationRef.current !== generation) return true;
          let located: CachedSearchMatch | null = null;
          const result = activeCursor.scan.run(
            OPERATION_NODES,
            SEARCH_CHARACTERS,
            (found: TreeSearchMatch<TraversalNode>) => {
              activeCursor.seen += 1;
              const foundOrdinal =
                direction > 0
                  ? activeCursor.seen
                  : matches - activeCursor.seen + 1;
              const match: CachedSearchMatch = {
                ordinal: foundOrdinal,
                locator: found.node.locator,
                rawIndex:
                  direction > 0
                    ? activeCursor.scan.visited
                    : allIndex === null
                      ? null
                      : allIndex.ordinals.length -
                        activeCursor.scan.visited -
                        1,
                location: found.location,
                snippet: found.snippet,
              };
              cacheMatch(match);
              if (activeCursor.seen !== targetPosition) return false;
              located = match;
              return true;
            },
          );
          if (located !== null) {
            revealMatch(located);
            setOperation({
              kind: "search",
              phase: "complete",
              visited: totalVisited,
              characters: totalCharacters,
              matches,
              current: ordinal,
            });
            return true;
          }
          setOperation({
            kind: "search",
            phase: "locating",
            visited: result.visited,
            characters: result.characters,
            matches,
            current: ordinal,
          });
          return result.done || result.paused;
        },
      });
    },
    [allIndex, cacheMatch, query, revealMatch, root.value],
  );

  const navigateMatch = useCallback(
    (direction: 1 | -1) => {
      if (operation?.kind !== "search" || operation.matches === 0) return;
      const current = currentOrdinalRef.current || 1;
      const target =
        direction > 0
          ? current >= operation.matches
            ? 1
            : current + 1
          : current <= 1
            ? operation.matches
            : current - 1;
      const cached = matchCacheRef.current.get(target);
      if (cached !== undefined) {
        revealMatch(cached);
        setOperation({ ...operation, current: target });
      } else if (operation.phase === "complete") {
        startLocate(
          target,
          operation.matches,
          operation.visited,
          operation.characters,
          direction,
        );
      }
    },
    [operation, revealMatch, startLocate],
  );

  const changeQuery = (next: string) => {
    setCopyMessage(null);
    if (query.length === 0 && next.length > 0) {
      searchSnapshotRef.current = {
        expanded,
        allIndex,
        collapsed,
        activeId,
      };
    }
    setQuery(next);
    if (next.length === 0) {
      generationRef.current += 1;
      schedulerRef.current.cancel();
      const snapshot = searchSnapshotRef.current;
      if (snapshot !== null) {
        setExpanded(snapshot.expanded);
        setAllIndex(snapshot.allIndex);
        setCollapsed(snapshot.collapsed);
        setActiveId(snapshot.activeId);
      }
      searchSnapshotRef.current = null;
      matchCacheRef.current.clear();
      locateCursorsRef.current = { forward: null, reverse: null };
      currentOrdinalRef.current = 0;
      setCurrentMatch(null);
      setOperation(null);
    } else if (parseStatus === null) {
      startSearch(next);
    }
  };

  const expandAll = useCallback(() => {
    if (allIndex !== null) {
      setCollapsed(new Set());
      return;
    }
    const generation = ++generationRef.current;
    schedulerRef.current.cancel();
    const traversal = createTraversal(root.value);
    const builder = new AllExpansionBuilder(traversal.root, traversal.adapter);
    let visited = 0;
    setOperation({ kind: "expand", phase: "running", visited: 0 });
    schedulerRef.current.start({
      runChunk: () => {
        if (generationRef.current !== generation) return true;
        const result = builder.run(OPERATION_NODES);
        visited += result.visited;
        if (result.done) {
          setAllIndex(builder.finish());
          setCollapsed(new Set());
          setOperation(null);
          return true;
        }
        setOperation({ kind: "expand", phase: "running", visited });
        return false;
      },
    });
  }, [allIndex, root.value]);

  const collapseAll = useCallback(() => {
    generationRef.current += 1;
    schedulerRef.current.cancel();
    const collapsedView: SearchViewSnapshot = {
      expanded: new Set(),
      allIndex: null,
      collapsed: new Set(),
      activeId: "root",
    };
    if (searchSnapshotRef.current !== null) {
      searchSnapshotRef.current = collapsedView;
    }
    setExpanded(collapsedView.expanded);
    setAllIndex(null);
    setCollapsed(collapsedView.collapsed);
    setActiveId("root");
    setOperation(null);
    setCurrentMatch(null);
    matchCacheRef.current.clear();
    locateCursorsRef.current = { forward: null, reverse: null };
    currentOrdinalRef.current = 0;
  }, []);

  const cancelOperation = () => {
    if (!schedulerRef.current.pause()) return;
    if (parseStatus !== null) {
      setParseStatus({ ...parseStatus, phase: "canceled" });
      return;
    }
    setOperation((current) =>
      current === null || current.phase === "complete"
        ? current
        : { ...current, phase: "canceled" },
    );
  };

  const resumeOperation = () => {
    if (!schedulerRef.current.resume()) return;
    if (parseStatus !== null) {
      setParseStatus({ ...parseStatus, phase: "running" });
      return;
    }
    setOperation((current) =>
      current === null || current.phase === "complete"
        ? current
        : { ...current, phase: "running" },
    );
  };

  const copyNodeJson = () => {
    if (parseStatus !== null) {
      setCopyError("Wait for JSON parsing to finish before copying.");
      return;
    }
    if (activeNode === undefined || copyWritingGenerationRef.current !== null) {
      return;
    }
    copyIntentRef.current?.reject(copyAbortError());
    copyIntentRef.current = null;
    const generation = ++copyGenerationRef.current;
    const serializer = createValueJsonSerializer(activeNode.value);
    copySchedulerRef.current.cancel();
    setCopyError(null);
    setCopyMessage(null);
    setCopying(true);
    let resolveText!: (text: string) => void;
    let rejectText!: (reason: unknown) => void;
    const text = new Promise<string>((resolve, reject) => {
      resolveText = resolve;
      rejectText = reject;
    });
    copyIntentRef.current = { generation, reject: rejectText };
    const submitCopy =
      onCopyIntent ??
      ((prepared: Promise<string>) =>
        prepared.then((result) => onCopy?.(result)));
    let write: Promise<void>;
    try {
      write = Promise.resolve(submitCopy(text));
    } catch (error) {
      write = Promise.reject(error);
    }
    const settle = (copied: boolean, error?: unknown) => {
      if (copyWritingGenerationRef.current === generation) {
        copyWritingGenerationRef.current = null;
      }
      if (copyGenerationRef.current !== generation) return;
      copyIntentRef.current = null;
      if (!copied) {
        copySchedulerRef.current.cancel();
        rejectText(error);
      }
      setCopying(false);
      if (copied) setCopyMessage("Copied JSON.");
      else {
        setCopyError(
          error instanceof ValueCopyLimitError
            ? error.message
            : "The JSON value could not be copied.",
        );
      }
    };
    void Promise.all([text, write]).then(
      () => settle(true),
      (error: unknown) => settle(false, error),
    );
    copySchedulerRef.current.start({
      runChunk: (deadline, maxUnits) => {
        if (copyGenerationRef.current !== generation) return true;
        const result = serializer.stepUntil(
          deadline,
          () => performance.now(),
          maxUnits,
        );
        if (result.status === "pending") return false;
        if (result.status === "limit") {
          if (copyIntentRef.current?.generation === generation) {
            copyIntentRef.current = null;
            rejectText(result.error);
          }
          return true;
        }
        if (copyIntentRef.current?.generation === generation) {
          copyIntentRef.current = null;
          copyWritingGenerationRef.current = generation;
          resolveText(result.text);
        }
        return true;
      },
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const primary = event.metaKey || event.ctrlKey;
    if (primary && !event.altKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyNodeJson();
      return;
    }
    if (event.key === " ") {
      // Space toggles Peek only while the grid owns focus. Inside the tree it
      // must not bubble into page scrolling or close the current inspection.
      event.preventDefault();
      return;
    }
    if (activeNode === undefined) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectIndex(activeIndex - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selectIndex(activeIndex + 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (valueChildCount(activeNode.value) === 0) return;
      if (!isOpen(activeNode)) toggle(activeNode, true);
      else selectIndex(activeIndex + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isOpen(activeNode)) toggle(activeNode, false);
      else if (activeNode.parent !== null) setActiveId(activeNode.parent.id);
    }
  };

  const binaryBytes = binaryValueBytes(root.value);
  const scalarDetail =
    binaryBytes === null && valueChildCount(root.value) === 0
      ? root.value
      : null;
  const hasDetail = binaryBytes !== null || scalarDetail !== null;
  const invalidOffset =
    preparedValue.kind === "invalidJson" ? preparedValue.errorOffset + 1 : null;
  const showTreeControls =
    parseStatus !== null ||
    preparedValue.kind === "invalidJson" ||
    preparedValue.kind === "rawJson" ||
    valueChildCount(root.value) > 0;
  const showToolbar = fieldPath !== undefined || showTreeControls;
  const progressText = operationText(operation, parseStatus);
  const progressRunning =
    parseStatus?.phase === "running" ||
    operation?.phase === "running" ||
    operation?.phase === "locating";
  const promoteFieldPath =
    fieldPath === undefined || onPromoteField === undefined
      ? undefined
      : structNodeFieldPath(fieldPath, activeNode);

  return (
    <div className={`value-tree-wrap${hasDetail ? " has-detail" : ""}`}>
      {showToolbar && (
        <div className="value-tree-toolbar">
          {showTreeControls && (
            <input
              type="search"
              value={query}
              aria-label={
                preparedValue.kind === "rawJson"
                  ? "Search raw JSON source"
                  : "Search keys and values"
              }
              placeholder={
                preparedValue.kind === "rawJson"
                  ? "Search raw JSON source"
                  : "Search keys and values"
              }
              disabled={parseStatus !== null}
              onChange={(event) => changeQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  navigateMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
          )}
          <div className="value-tree-toolbar-actions">
            {promoteFieldPath !== undefined && (
              <button
                type="button"
                onClick={() => onPromoteField?.(promoteFieldPath)}
              >
                Promote to column
              </button>
            )}
            {fieldPath !== undefined && (
              <button
                type="button"
                disabled={activeNode === undefined}
                onClick={() => {
                  if (activeNode === undefined) return;
                  const text = valueNodePath(fieldPath, activeNode);
                  const submit =
                    onCopyIntent ??
                    ((prepared: Promise<string>) =>
                      prepared.then((result) => onCopy?.(result)));
                  void Promise.resolve(submit(Promise.resolve(text))).then(
                    () => setCopyMessage("Copied path."),
                    () => setCopyError("The value path could not be copied."),
                  );
                }}
              >
                Copy path
              </button>
            )}
            {showTreeControls && (
              <>
                <button
                  type="button"
                  disabled={
                    parseStatus !== null ||
                    preparedValue.kind === "invalidJson" ||
                    preparedValue.kind === "rawJson" ||
                    valueChildCount(root.value) === 0 ||
                    query.length > 0
                  }
                  onClick={expandAll}
                >
                  Expand all
                </button>
                <button
                  type="button"
                  disabled={
                    parseStatus !== null ||
                    valueChildCount(root.value) === 0 ||
                    query.length > 0
                  }
                  onClick={collapseAll}
                >
                  Collapse all
                </button>
              </>
            )}
            {(parseStatus !== null ||
              (operation !== null && operation.phase !== "complete")) &&
              (parseStatus?.phase === "canceled" ||
              operation?.phase === "canceled" ? (
                <>
                  <button type="button" onClick={resumeOperation}>
                    Resume
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (parseStatus !== null) {
                        if (value.kind === "jsonText") scheduleJsonParse(value);
                        else if (value.kind === "arrow")
                          scheduleArrowJsonParse(value);
                      } else if (operation?.kind === "search") {
                        startSearch(query);
                      } else {
                        expandAll();
                      }
                    }}
                  >
                    Restart
                  </button>
                </>
              ) : (
                <button type="button" onClick={cancelOperation}>
                  Cancel
                </button>
              ))}
          </div>
        </div>
      )}
      {(copying ||
        copyError !== null ||
        copyMessage !== null ||
        progressText !== null ||
        preparedValue.kind === "rawJson" ||
        invalidOffset !== null) && (
        <div
          className="value-tree-status"
          aria-live={progressRunning ? "off" : "polite"}
        >
          {copyError !== null
            ? copyError
            : copyMessage !== null
              ? copyMessage
              : preparedValue.kind === "rawJson"
                ? `JSON tree is too large; showing raw source with literal-source search.${
                    copying ? " · Preparing JSON for copy…" : ""
                  }${progressText === null ? "" : ` · ${progressText}`}`
                : invalidOffset === null
                  ? copying
                    ? "Preparing JSON for copy…"
                    : progressText
                  : `Invalid JSON at character ${invalidOffset}. Showing raw text.${
                      copying
                        ? " · Preparing JSON for copy…"
                        : progressText === null
                          ? ""
                          : ` · ${progressText}`
                    }`}
        </div>
      )}
      <div
        ref={treeRef}
        className="value-tree"
        role="tree"
        aria-label={`${label} value`}
        aria-activedescendant={treeRowId(treeId, activeNode?.id ?? "root")}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className="value-tree-spacer"
          style={{ height: rowCount * TREE_ROW_HEIGHT }}
        >
          <ValueTreeRows
            treeId={treeId}
            rows={rows}
            activeIndex={activeIndex}
            currentMatch={currentMatch}
            isOpen={isOpen}
            onActivate={activateRow}
            onToggle={toggleRow}
          />
        </div>
      </div>
      {binaryBytes !== null ? (
        <BinaryDetail bytes={binaryBytes} label={label} />
      ) : (
        scalarDetail !== null && <RawTextDetail value={scalarDetail} />
      )}
    </div>
  );
});

const ValueTreeRows = memo(function ValueTreeRows({
  treeId,
  rows,
  activeIndex,
  currentMatch,
  isOpen,
  onActivate,
  onToggle,
}: {
  treeId: string;
  rows: readonly { index: number; node: TreeNode }[];
  activeIndex: number;
  currentMatch: CurrentSearchMatch | null;
  isOpen: (node: TreeNode) => boolean;
  onActivate: (node: TreeNode) => void;
  onToggle: (node: TreeNode) => void;
}) {
  return rows.map(({ index, node }) => {
    const childCount = valueChildCount(node.value);
    const open = isOpen(node);
    const match = currentMatch?.id === node.id ? currentMatch : null;
    return (
      <div
        id={treeRowId(treeId, node.id)}
        key={node.id}
        className={`value-tree-row${index === activeIndex ? " is-active" : ""}${
          node.value.kind === "value" && node.value.value == null
            ? " is-null"
            : ""
        }`}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-posinset={nodePosition(node)}
        aria-setsize={node.siblingCount}
        aria-expanded={childCount === 0 ? undefined : open}
        aria-selected={index === activeIndex}
        data-tree-node-id={node.id}
        style={{
          top: index * TREE_ROW_HEIGHT,
          paddingLeft: 8 + Math.min(node.depth, MAX_TREE_INDENT) * 16,
        }}
        onClick={() => onActivate(node)}
        onDoubleClick={() => onToggle(node)}
      >
        <button
          className="value-tree-chevron"
          type="button"
          tabIndex={-1}
          aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
          disabled={childCount === 0}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node);
          }}
        >
          {childCount === 0 ? "" : open ? "▾" : "▸"}
        </button>
        <span className={`value-tree-name${node.key ? " is-key" : ""}`}>
          {match?.location === "key"
            ? renderSearchSnippet(match.snippet)
            : node.label}
        </span>
        <span className="value-tree-preview">
          {match?.location === "value"
            ? renderSearchSnippet(match.snippet)
            : renderPreviewTokens(formatValuePreviewTokens(node.value, 84))}
        </span>
        <span className="value-tree-type">{valueTypeLabel(node.value)}</span>
      </div>
    );
  });
});

function operationText(
  operation: OperationStatus | null,
  parse: {
    phase: "running" | "canceled";
    offset: number;
    total: number;
  } | null,
): string | null {
  if (parse !== null) {
    const progress = `${parse.offset.toLocaleString()} of ${parse.total.toLocaleString()} characters`;
    return parse.phase === "canceled"
      ? `Canceled JSON parsing after ${progress}`
      : `Parsing JSON · ${progress}`;
  }
  if (operation?.kind === "expand") {
    return `${operation.phase === "canceled" ? "Canceled" : "Expanding"} after ${operation.visited.toLocaleString()} nodes`;
  }
  if (operation?.kind === "search") {
    if (operation.phase === "complete") {
      return operation.matches === 0
        ? `No matches · ${operation.visited.toLocaleString()} nodes · ${operation.characters.toLocaleString()} characters scanned`
        : `${operation.current.toLocaleString()} of ${operation.matches.toLocaleString()} matches · ${operation.visited.toLocaleString()} nodes · ${operation.characters.toLocaleString()} characters scanned`;
    }
    if (operation.phase === "locating") {
      return `Locating match ${(operation.current || 1).toLocaleString()} of ${operation.matches.toLocaleString()} · ${operation.visited.toLocaleString()} nodes · ${operation.characters.toLocaleString()} characters`;
    }
    return `${operation.phase === "canceled" ? "Canceled" : "Searching"} after ${operation.visited.toLocaleString()} nodes · ${operation.characters.toLocaleString()} characters · ${operation.matches.toLocaleString()} found`;
  }
  return null;
}

function renderPreviewTokens(tokens: readonly PreviewToken[]) {
  return tokens.map((token, index) => (
    <span key={index} className={`cell-preview-${token.tone}`}>
      {token.text}
    </span>
  ));
}

function renderSearchSnippet(snippet: SearchSnippet) {
  return (
    <>
      {snippet.before}
      <mark>{snippet.match}</mark>
    </>
  );
}

interface SparseExpansionIndex {
  children: ReadonlyMap<string, readonly number[]>;
  sizes: ReadonlyMap<string, number>;
}

// Sparse mode indexes only expanded rows; all-mode uses compact
// parent/ordinal arrays, so renders never rescan the whole value.
function expansionIndex(
  root: TreeNode,
  expanded: ReadonlySet<string>,
): SparseExpansionIndex {
  const children = new Map<string, number[]>();
  const nodesByDepth: TreeNode[][] = [];
  let maxDepth = 0;
  for (const id of expanded) {
    const node = nodeForId(root, id);
    if (node === undefined) continue;
    const depthNodes = nodesByDepth[node.depth] ?? [];
    depthNodes.push(node);
    nodesByDepth[node.depth] = depthNodes;
    maxDepth = Math.max(maxDepth, node.depth);
    if (node.parent === null) continue;
    const ordinals = children.get(node.parent.id) ?? [];
    ordinals.push(node.ordinal);
    children.set(node.parent.id, ordinals);
  }
  for (const ordinals of children.values()) ordinals.sort((a, b) => a - b);
  const sizes = new Map<string, number>();
  for (let depth = maxDepth; depth >= 0; depth -= 1) {
    for (const node of nodesByDepth[depth] ?? []) {
      let size = 1 + valueChildCount(node.value);
      for (const ordinal of children.get(node.id) ?? []) {
        const child = childNode(node, ordinal);
        if (child !== undefined) size += (sizes.get(child.id) ?? 1) - 1;
      }
      sizes.set(node.id, size);
    }
  }
  return { children, sizes };
}

function visibleSize(
  node: TreeNode,
  expanded: ReadonlySet<string>,
  expansion: SparseExpansionIndex,
): number {
  return expanded.has(node.id) ? (expansion.sizes.get(node.id) ?? 1) : 1;
}

function nodeAtVisibleIndex(
  node: TreeNode,
  index: number,
  expanded: ReadonlySet<string>,
  expansion: SparseExpansionIndex,
): TreeNode | undefined {
  let current = node;
  let remaining = index;
  descend: while (true) {
    if (remaining === 0) return current;
    if (!expanded.has(current.id)) return undefined;
    remaining -= 1;
    let ordinal = 0;
    for (const expandedOrdinal of expansion.children.get(current.id) ?? []) {
      const gap = expandedOrdinal - ordinal;
      if (remaining < gap) return childNode(current, ordinal + remaining);
      remaining -= gap;
      const child = childNode(current, expandedOrdinal);
      if (child === undefined) return undefined;
      const childSize = expansion.sizes.get(child.id) ?? 1;
      if (remaining < childSize) {
        current = child;
        continue descend;
      }
      remaining -= childSize;
      ordinal = expandedOrdinal + 1;
    }
    return childNode(current, ordinal + remaining);
  }
}

function visibleIndexForNode(
  target: TreeNode | undefined,
  expanded: ReadonlySet<string>,
  expansion: SparseExpansionIndex,
): number | undefined {
  if (target === undefined) return undefined;
  const chain: TreeNode[] = [];
  for (let node: TreeNode | null = target; node?.parent !== null;) {
    chain.push(node);
    node = node.parent;
  }
  chain.reverse();
  let parent: TreeNode | undefined = rootNode(target);
  let index = 0;
  for (const child of chain) {
    if (parent === undefined || !expanded.has(parent.id)) return undefined;
    index += 1 + child.ordinal;
    for (const expandedOrdinal of expansion.children.get(parent.id) ?? []) {
      if (expandedOrdinal >= child.ordinal) break;
      const expandedChild = childNode(parent, expandedOrdinal);
      if (expandedChild !== undefined) {
        index += (expansion.sizes.get(expandedChild.id) ?? 1) - 1;
      }
    }
    parent = child;
  }
  return index;
}

function nodeAtAllVisibleIndex(
  root: TreeNode,
  index: AllExpansionIndex,
  ranges: readonly CollapsedRange[],
  visibleIndex: number,
): TreeNode | undefined {
  const rawIndex = rawIndexAtVisibleIndex(index, ranges, visibleIndex);
  return rawIndex === undefined
    ? undefined
    : nodeAtAllRawIndex(root, index, rawIndex);
}

function visibleIndexForAllNode(
  index: AllExpansionIndex,
  ranges: readonly CollapsedRange[],
  node: TreeNode | undefined,
): number | undefined {
  const raw = node === undefined ? undefined : rawIndexForNode(index, node);
  return raw === undefined ? undefined : visibleIndexForRawIndex(ranges, raw);
}

function nodeAtAllRawIndex(
  root: TreeNode,
  index: AllExpansionIndex,
  rawIndex: number,
): TreeNode | undefined {
  return createAllNodeMaterializer(root, index)(rawIndex);
}

function createAllNodeMaterializer(
  root: TreeNode,
  index: AllExpansionIndex,
): (rawIndex: number) => TreeNode | undefined {
  const materialized = new Map<number, TreeNode>([[0, root]]);
  return (rawIndex) => {
    if (rawIndex < 0 || rawIndex >= index.ordinals.length) return undefined;
    const missing: number[] = [];
    let ancestor = rawIndex;
    while (!materialized.has(ancestor)) {
      missing.push(ancestor);
      const parent = index.parentIndices[ancestor];
      if (parent === null || parent === undefined) return undefined;
      ancestor = parent;
    }
    let node = materialized.get(ancestor)!;
    for (let offset = missing.length - 1; offset >= 0; offset -= 1) {
      const raw = missing[offset]!;
      const child = childNode(node, index.ordinals[raw]!);
      if (child === undefined) return undefined;
      materialized.set(raw, child);
      node = child;
    }
    return node;
  };
}

function rawParentPath(
  index: AllExpansionIndex,
  rawIndex: number,
): number[] | undefined {
  if (rawIndex < 0 || rawIndex >= index.ordinals.length) return undefined;
  const reversed: number[] = [];
  let current = rawIndex;
  while (true) {
    reversed.push(current);
    if (current === 0) break;
    const parent = index.parentIndices[current];
    if (parent === null || parent === undefined) return undefined;
    current = parent;
  }
  return reversed.reverse();
}

function rawIndexForNode(
  index: AllExpansionIndex,
  node: TreeNode,
): number | undefined {
  return rawPathForNode(index, node)?.at(-1);
}

function rawPathForNode(
  index: AllExpansionIndex,
  node: TreeNode,
): number[] | undefined {
  const ordinals: number[] = [];
  for (let current: TreeNode | null = node; current.parent !== null;) {
    ordinals.push(current.ordinal);
    current = current.parent;
  }
  ordinals.reverse();
  const path = [0];
  let parent = 0;
  for (const ordinal of ordinals) {
    const child = allChildRawIndex(index, parent, ordinal);
    if (child === undefined) return undefined;
    path.push(child);
    parent = child;
  }
  return path;
}

function allChildRawIndex(
  index: AllExpansionIndex,
  parent: number,
  ordinal: number,
): number | undefined {
  const end = index.subtreeEnds[parent] ?? parent + 1;
  let child = parent + 1;
  while (child < end) {
    if (
      index.parentIndices[child] === parent &&
      index.ordinals[child] === ordinal
    ) {
      return child;
    }
    child = index.subtreeEnds[child] ?? end;
  }
  return undefined;
}

function createTraversal(value: TypedValue): {
  root: TraversalNode;
  adapter: TreeSearchAdapter<TraversalNode>;
} {
  const rootLocator: TreeLocator = { parent: null, ordinal: 0 };
  const root: TraversalNode = {
    parent: null,
    locator: rootLocator,
    ordinal: 0,
    depth: 0,
    key: false,
    value,
  };
  const adapter: TreeSearchAdapter<TraversalNode> = {
    childCount: (node) => valueChildCount(node.value),
    childAt: (parent, ordinal) => {
      const child = valueChildAt(parent.value, ordinal);
      if (child === undefined) return undefined;
      const locator: TreeLocator = {
        parent: parent.locator,
        ordinal,
      };
      return {
        parent,
        locator,
        ordinal,
        depth: parent.depth + 1,
        labelSearch: child.labelSearch,
        key: child.key,
        value: child.value,
      };
    },
    searchSources: (node) => {
      const sources: Array<{
        location: "key" | "value";
        text: ValueSearchText;
      }> = [];
      if (node.key && node.labelSearch !== undefined) {
        sources.push({ location: "key", text: node.labelSearch });
      }
      const scalar = valueSearchText(node.value);
      if (scalar !== null) sources.push({ location: "value", text: scalar });
      return sources;
    },
  };
  return { root, adapter };
}

function materializeLocator(
  root: TreeNode,
  locator: TreeLocator,
): TreeNode | undefined {
  const ordinals: number[] = [];
  for (let current: TreeLocator | null = locator; current.parent !== null;) {
    ordinals.push(current.ordinal);
    current = current.parent;
  }
  let node = root;
  for (let index = ordinals.length - 1; index >= 0; index -= 1) {
    const child = childNode(node, ordinals[index]!);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

function childNode(parent: TreeNode, ordinal: number): TreeNode | undefined {
  const child = valueChildAt(parent.value, ordinal);
  if (child === undefined) return undefined;
  return {
    id: `${parent.id}/${ordinal}`,
    parent,
    ordinal,
    label: child.label,
    labelSearch: child.labelSearch,
    objectKey: child.objectKey,
    key: child.key,
    value: child.value,
    depth: parent.depth + 1,
    siblingCount: valueChildCount(parent.value),
  };
}

function valueNodePath(fieldPath: FieldPath, node: TreeNode): string {
  const descendants: TreeNode[] = [];
  for (let current: TreeNode | null = node; current?.parent !== null;) {
    descendants.push(current);
    current = current.parent;
  }
  let path = formatFieldPath(fieldPath);
  for (const descendant of descendants.reverse()) {
    if (descendant.objectKey !== undefined) {
      path += `.${formatFieldPathSegment(descendant.objectKey)}`;
    } else if (/^\[\d+\]$/.test(descendant.label)) {
      path += descendant.label;
    } else if (descendant.key) {
      path += `[${JSON.stringify(descendant.label)}]`;
    } else {
      path += `[${descendant.ordinal}]`;
    }
  }
  return path;
}

function structNodeFieldPath(
  fieldPath: FieldPath,
  node: TreeNode | undefined,
): FieldPath | undefined {
  if (
    node === undefined ||
    node.parent === null ||
    !isStructValue(node.value)
  ) {
    return undefined;
  }
  const segments: string[] = [];
  for (let current: TreeNode = node; current.parent !== null;) {
    if (current.objectKey === undefined) return undefined;
    segments.push(current.objectKey);
    current = current.parent;
  }
  return [...fieldPath, ...segments.reverse()];
}

function isStructValue(value: TypedValue | undefined): boolean {
  if (
    value === undefined ||
    (value.kind !== "arrow" && value.kind !== "value")
  ) {
    return false;
  }
  let dataType: DataType = value.dataType;
  while (dataType.typeId === Type.Dictionary) dataType = dataType.dictionary;
  return dataType.typeId === Type.Struct;
}

function createRootNode(label: string, value: TypedValue): TreeNode {
  return {
    id: "root",
    parent: null,
    ordinal: 0,
    label,
    key: false,
    value,
    depth: 0,
    siblingCount: 1,
  };
}

function nodeForId(root: TreeNode, id: string): TreeNode | undefined {
  if (id === "root") return root;
  if (!id.startsWith("root/")) return undefined;
  let node = root;
  for (const part of id.slice(5).split("/")) {
    const ordinal = Number(part);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
    const child = childNode(node, ordinal);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

function rootNode(node: TreeNode): TreeNode {
  let root = node;
  while (root.parent !== null) root = root.parent;
  return root;
}

function ancestorIds(node: TreeNode | undefined): string[] {
  const ancestors: string[] = [];
  for (let parent = node?.parent; parent !== null && parent !== undefined;) {
    ancestors.push(parent.id);
    parent = parent.parent;
  }
  return ancestors;
}

function nodePosition(node: TreeNode): number {
  return node.parent === null ? 1 : node.ordinal + 1;
}

function BinaryDetail({ bytes, label }: { bytes: Uint8Array; label: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rowCount = Math.ceil(bytes.byteLength / BINARY_HEX_ROW_BYTES);
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
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) rows.push(rowIndex);

  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0;
  }, [bytes]);

  return (
    <div className="value-peek-detail is-binary">
      <div className="value-peek-binary-summary">
        <span>binary · {formatByteSize(bytes.byteLength)}</span>
        <span>Dot (.) means a non-printable byte.</span>
      </div>
      <div
        className="value-peek-binary-table"
        role="table"
        aria-label={`${label} hex dump`}
      >
        <div className="value-peek-binary-head" role="row">
          <span role="columnheader">Offset</span>
          <span role="columnheader">Hex bytes</span>
          <span role="columnheader">ASCII</span>
        </div>
        <div
          ref={viewportRef}
          className="value-peek-binary-viewport"
          role="rowgroup"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div
            className="value-peek-binary-spacer"
            style={{ height: rowCount * HEX_ROW_HEIGHT }}
          >
            {rows.map((rowIndex) => {
              const row = formatBinaryHexRow(bytes, rowIndex);
              const offset = row.slice(0, 8);
              const hex = row.slice(10, 10 + BINARY_HEX_ROW_BYTES * 3 - 1);
              const ascii = row.slice(10 + BINARY_HEX_ROW_BYTES * 3 + 1);
              return (
                <code
                  key={rowIndex}
                  className="value-peek-binary-row"
                  role="row"
                  style={{ top: rowIndex * HEX_ROW_HEIGHT }}
                >
                  <span role="cell">{offset}</span>
                  <span role="cell">{hex}</span>
                  <span role="cell">{ascii}</span>
                </code>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function RawTextDetail({ value }: { value: TypedValue }) {
  if (value.kind === "arrow" && arrowUtf8Bytes(value) !== null) {
    return <ArrowUtf8Detail value={value} />;
  }
  if (
    (value.kind === "jsonText" ||
      value.kind === "rawJson" ||
      value.kind === "invalidJson") &&
    typeof value.value !== "string"
  ) {
    return (
      <ChunkedRawTextDetail
        source={value.value}
        start={0}
        end={value.value.length}
      />
    );
  }
  if (value.kind === "json" && typeof value.source !== "string") {
    return (
      <ChunkedRawTextDetail
        source={value.source}
        start={value.root ? 0 : value.node.start}
        end={value.root ? value.source.length : value.node.end}
      />
    );
  }
  return <MaterializedRawTextDetail text={fullValueText(value)} />;
}

function ChunkedRawTextDetail({
  source,
  start,
  end,
}: {
  source: ChunkedJsonSource;
  start: number;
  end: number;
}) {
  const total = end - start;
  const preview = codePointSafePrefix(
    sourceSlice(
      source,
      start,
      Math.min(end, start + RAW_PREVIEW_CHARACTERS + 1),
    ),
    RAW_PREVIEW_CHARACTERS,
  );
  return (
    <RawTextPreview
      preview={preview}
      total={total}
      truncated={total > preview.length}
    />
  );
}

function ArrowUtf8Detail({
  value,
}: {
  value: Extract<TypedValue, { kind: "arrow" }>;
}) {
  const [detail, setDetail] = useState({ preview: "", total: 0, done: false });
  useEffect(() => {
    const range = arrowUtf8Bytes(value);
    if (range === null) return;
    const scheduler = new ChunkScheduler();
    const decoder = new TextDecoder();
    let offset = range.start;
    let sample = "";
    let total = 0;
    scheduler.start({
      runChunk: (deadline, maxUnits) => {
        let worked = false;
        let units = 0;
        const unitLimit = Math.min(maxUnits, 64);
        while (
          offset < range.end &&
          units < unitLimit &&
          (!worked || performance.now() < deadline)
        ) {
          worked = true;
          units += 1;
          const end = Math.min(range.end, offset + 16_384);
          const text = decoder.decode(range.bytes.subarray(offset, end), {
            stream: end < range.end,
          });
          offset = end;
          total += text.length;
          if (sample.length < RAW_PREVIEW_CHARACTERS + 1) {
            sample += text.slice(0, RAW_PREVIEW_CHARACTERS + 1 - sample.length);
          }
        }
        const done = offset >= range.end;
        setDetail({
          preview: codePointSafePrefix(sample, RAW_PREVIEW_CHARACTERS),
          total,
          done,
        });
        return done;
      },
    });
    return () => scheduler.cancel();
  }, [value]);
  return (
    <RawTextPreview
      preview={detail.preview}
      total={detail.done ? detail.total : null}
      truncated={!detail.done || detail.total > detail.preview.length}
    />
  );
}

function MaterializedRawTextDetail({ text }: { text: string }) {
  const truncated = text.length > RAW_PREVIEW_CHARACTERS;
  const preview = codePointSafePrefix(text, RAW_PREVIEW_CHARACTERS);
  return (
    <RawTextPreview
      preview={preview}
      total={text.length}
      truncated={truncated}
    />
  );
}

function RawTextPreview({
  preview,
  total,
  truncated,
}: {
  preview: string;
  total: number | null;
  truncated: boolean;
}) {
  return (
    <div className="value-peek-raw-detail">
      {truncated && (
        <div className="value-peek-raw-note">
          {total === null ? (
            <>Reading the complete value…</>
          ) : (
            <>
              Showing the first {preview.length.toLocaleString()} of{" "}
              {total.toLocaleString()} characters. Copy still uses the complete
              value.
            </>
          )}
        </div>
      )}
      <pre className="value-peek-detail">
        {preview}
        {truncated ? "…" : ""}
      </pre>
    </div>
  );
}

function treeRowId(prefix: string, id: string): string {
  return `${prefix}-value-tree-row-${id.replaceAll("/", "-")}`;
}

function copyAbortError(): DOMException {
  return new DOMException("Copy preparation canceled.", "AbortError");
}
