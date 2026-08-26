import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  getDatasetPartitions,
  type DatasetPartitionNode,
  type PartitionValue,
} from "../desktop";

const PAGE_SIZE = 256;
export const PARTITION_WORKING_PAGE_BUDGET = 3;
// The engine rejects partition paths deeper than this protocol limit.
const MAX_PARTITION_DEPTH = 256;
const ROW_HEIGHT = 34;
const VIEWPORT_HEIGHT = 320;
const OVERSCAN = 3;
const ROOT_PATH: PartitionValue[] = [];

interface Page {
  // Cursor/count records remain after node eviction so virtual backward scroll
  // can refetch a page without retaining its member metadata in memory.
  after: PartitionValue | null;
  nextAfter: PartitionValue | null;
  count: number;
  nodes: DatasetPartitionNode[] | null;
  pending: boolean;
  failed: boolean;
  touched: number;
}

interface Level {
  parent: PartitionValue[];
  pages: Page[];
}

interface TreeItem {
  id: string;
  parentId: string | null;
  path: PartitionValue[];
  node: DatasetPartitionNode;
  depth: number;
  position: number;
  setSize: number;
  expandable: boolean;
  expanded: boolean;
}

interface ItemEntry {
  kind: "item";
  index: number;
  span: 1;
  levelId: string;
  pageIndex: number;
  item: TreeItem;
}

interface GapEntry {
  kind: "gap";
  index: number;
  span: number;
  levelId: string;
  pageIndex: number;
}

type LayoutEntry = ItemEntry | GapEntry;

interface Layout {
  entries: LayoutEntry[];
  rowCount: number;
  itemIndices: Map<string, number>;
  nextPageBoundaries: Array<{ levelId: string; index: number }>;
}

function pathId(path: PartitionValue[]): string {
  return JSON.stringify(path.map(({ key, value }) => [key, value]));
}

function appendNode(
  parent: PartitionValue[],
  node: DatasetPartitionNode,
): PartitionValue[] {
  return [...parent, node.partition];
}

function partitionLabel(node: DatasetPartitionNode): string {
  const unit = node.memberCount === 1 ? "file" : "files";
  return `${node.partition.key}=${node.partition.value} · ${node.memberCount.toLocaleString("en-US")} ${unit}`;
}

function isPathPrefix(
  prefix: PartitionValue[],
  path: PartitionValue[] | null,
): boolean {
  return (
    path !== null &&
    prefix.every(
      (part, index) =>
        part.key === path[index]?.key && part.value === path[index]?.value,
    )
  );
}

function trimResidentPages(
  levels: Map<string, Level>,
  focusedPath: PartitionValue[] | null,
  depth: number,
  protectedPages: ReadonlySet<string>,
): Map<string, Level> {
  const resident = [...levels.entries()].flatMap(([levelId, level]) =>
    level.pages.flatMap((page, pageIndex) =>
      page.nodes === null ? [] : [{ levelId, level, page, pageIndex }],
    ),
  );
  const limit =
    Math.min(depth, MAX_PARTITION_DEPTH) + PARTITION_WORKING_PAGE_BUDGET;
  if (resident.length <= limit) return levels;

  // The virtual viewport bounds this set independently of dataset size. Keeping
  // its pages resident prevents an evict/refetch loop while rows stay visible.
  const candidates = resident
    .filter(
      ({ levelId, level, page, pageIndex }) =>
        !protectedPages.has(`${levelId}:${pageIndex}`) &&
        !page.nodes!.some((node) =>
          isPathPrefix(appendNode(level.parent, node), focusedPath),
        ),
    )
    .sort((left, right) => left.page.touched - right.page.touched);
  let residentCount = resident.length;
  for (const candidate of candidates) {
    if (residentCount <= limit) break;
    const level = levels.get(candidate.levelId);
    const page = level?.pages[candidate.pageIndex];
    if (level === undefined || page === undefined || page.nodes === null)
      continue;
    const pages = [...level.pages];
    pages[candidate.pageIndex] = {
      ...page,
      nodes: null,
    };
    levels.set(candidate.levelId, { ...level, pages });
    residentCount -= 1;
  }
  return levels;
}

function trimLevels(
  levels: Map<string, Level>,
  focusedPath: PartitionValue[] | null,
  depth: number,
  protectedPages: ReadonlySet<string>,
): Set<string> {
  const limit =
    1 + Math.min(depth, MAX_PARTITION_DEPTH) + PARTITION_WORKING_PAGE_BUDGET;
  if (levels.size <= limit) return new Set();

  const candidates = [...levels.entries()]
    .filter(
      ([levelId, level]) =>
        levelId !== pathId(ROOT_PATH) &&
        ![...protectedPages].some((key) => key.startsWith(`${levelId}:`)) &&
        !isPathPrefix(level.parent, focusedPath),
    )
    .sort((left, right) => {
      const touched = (level: Level) =>
        Math.max(0, ...level.pages.map((page) => page.touched));
      return touched(left[1]) - touched(right[1]);
    });
  const discarded = new Set<string>();
  for (const [, candidate] of candidates) {
    if (levels.size <= limit) break;
    for (const [levelId, level] of levels) {
      if (isPathPrefix(candidate.parent, level.parent)) {
        levels.delete(levelId);
        discarded.add(levelId);
      }
    }
  }
  return discarded;
}

export function trimPartitionTreeCache(
  levels: Map<string, Level>,
  expanded: Set<string>,
  focusedPath: PartitionValue[] | null,
  depth: number,
  protectedPages: ReadonlySet<string> = new Set(),
): { levels: Map<string, Level>; expanded: Set<string> } {
  const discardedLevelIds = trimLevels(
    levels,
    focusedPath,
    depth,
    protectedPages,
  );
  return {
    levels: trimResidentPages(levels, focusedPath, depth, protectedPages),
    expanded:
      discardedLevelIds.size === 0
        ? expanded
        : new Set(
            [...expanded].filter(
              (expandedId) => !discardedLevelIds.has(expandedId),
            ),
          ),
  };
}

function buildLayout(
  levels: ReadonlyMap<string, Level>,
  expanded: ReadonlySet<string>,
  maxDepth: number,
): Layout {
  const entries: LayoutEntry[] = [];
  const itemIndices = new Map<string, number>();
  const nextPageBoundaries: Array<{ levelId: string; index: number }> = [];
  let rowCount = 0;

  const appendLevel = (parent: PartitionValue[], parentId: string | null) => {
    const levelId = pathId(parent);
    const level = levels.get(levelId);
    if (level === undefined) return;
    const siblingCount = level.pages.reduce(
      (count, page) => count + page.count,
      0,
    );
    const lastPage = level.pages.at(-1);
    const setSize =
      lastPage !== undefined &&
      lastPage.nodes !== null &&
      lastPage.nextAfter === null
        ? siblingCount
        : -1;
    let siblingIndex = 0;

    level.pages.forEach((page, pageIndex) => {
      if (page.nodes === null) {
        if (page.count > 0) {
          entries.push({
            kind: "gap",
            index: rowCount,
            span: page.count,
            levelId,
            pageIndex,
          });
          rowCount += page.count;
        }
      } else {
        page.nodes.forEach((node) => {
          const path = appendNode(parent, node);
          const id = pathId(path);
          const firstChildPage = levels.get(id)?.pages[0];
          const knownLeaf =
            firstChildPage?.nodes?.length === 0 &&
            firstChildPage.nextAfter === null;
          const expandable = path.length < maxDepth && !knownLeaf;
          const item: TreeItem = {
            id,
            parentId,
            path,
            node,
            depth: path.length,
            position: siblingIndex + 1,
            setSize,
            expandable,
            expanded: expandable && expanded.has(id),
          };
          entries.push({
            kind: "item",
            index: rowCount,
            span: 1,
            levelId,
            pageIndex,
            item,
          });
          itemIndices.set(id, rowCount);
          rowCount += 1;
          if (item.expanded) appendLevel(path, id);
          siblingIndex += 1;
        });
      }
      if (page.nodes === null) siblingIndex += page.count;
    });

    if (
      lastPage !== undefined &&
      lastPage.nodes !== null &&
      lastPage.nextAfter !== null &&
      lastPage.nodes.length > 0
    ) {
      const lastId = pathId(appendNode(parent, lastPage.nodes.at(-1)!));
      const index = itemIndices.get(lastId);
      if (index !== undefined) nextPageBoundaries.push({ levelId, index });
    }
  };

  appendLevel(ROOT_PATH, null);
  return { entries, rowCount, itemIndices, nextPageBoundaries };
}

function entryAt(entries: readonly LayoutEntry[], index: number) {
  return entries.find(
    (entry) => index >= entry.index && index < entry.index + entry.span,
  );
}

export function DatasetPartitionTree({
  generation,
  depth,
}: {
  generation: number;
  depth: number;
}) {
  const [levels, setLevels] = useState<Map<string, Level>>(() => new Map());
  const levelsRef = useRef(levels);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const expandedRef = useRef(expanded);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedPath = useRef<PartitionValue[] | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const requestedFocus = useRef<string | null>(null);
  const requestedIndex = useRef<number | null>(null);
  const requestedEnd = useRef(false);
  const requestEpoch = useRef(0);
  const inFlight = useRef(new Set<string>());
  const visiblePageKeys = useRef(new Set<string>());
  const clock = useRef(0);
  const [cacheNotice, setCacheNotice] = useState(false);

  const updateLevels = useCallback(
    (update: (previous: Map<string, Level>) => Map<string, Level>) => {
      const next = update(levelsRef.current);
      levelsRef.current = next;
      setLevels(next);
    },
    [],
  );
  const updateExpanded = useCallback(
    (update: (previous: Set<string>) => Set<string>) => {
      const next = update(expandedRef.current);
      expandedRef.current = next;
      setExpanded(next);
    },
    [],
  );

  const loadPage = useCallback(
    (
      parent: PartitionValue[],
      pageIndex: number,
      after: PartitionValue | null,
    ) => {
      const levelId = pathId(parent);
      const requestKey = `${levelId}:${pageIndex}`;
      const current = levelsRef.current.get(levelId)?.pages[pageIndex];
      if (
        current?.pending ||
        (current !== undefined && current.nodes !== null) ||
        inFlight.current.has(requestKey)
      ) {
        return;
      }
      const epoch = requestEpoch.current;
      inFlight.current.add(requestKey);
      updateLevels((previous) => {
        const next = new Map(previous);
        const level = next.get(levelId) ?? { parent, pages: [] };
        const pages = [...level.pages];
        const known = pages[pageIndex];
        pages[pageIndex] = {
          after,
          nextAfter: known?.nextAfter ?? null,
          count: known?.count ?? 0,
          nodes: null,
          pending: true,
          failed: false,
          touched: known?.touched ?? 0,
        };
        next.set(levelId, { parent, pages });
        return next;
      });
      void getDatasetPartitions(generation, parent, after, PAGE_SIZE).then(
        (result) => {
          inFlight.current.delete(requestKey);
          if (epoch !== requestEpoch.current) return;
          let retainedExpanded = expandedRef.current;
          let collapsedByBudget = false;
          updateLevels((previous) => {
            const level = previous.get(levelId);
            if (
              level === undefined &&
              levelId !== pathId(ROOT_PATH) &&
              !expandedRef.current.has(levelId)
            ) {
              return previous;
            }
            const pages = [...(level?.pages ?? [])];
            pages[pageIndex] = {
              after,
              nextAfter: result.nextAfter,
              count: result.nodes.length,
              nodes: result.nodes,
              pending: false,
              failed: false,
              touched: ++clock.current,
            };
            const next = new Map(previous);
            next.set(levelId, { parent: level?.parent ?? parent, pages });
            const protectedPages = new Set(visiblePageKeys.current);
            protectedPages.add(requestKey);
            const trimmed = trimPartitionTreeCache(
              next,
              expandedRef.current,
              focusedPath.current,
              depth,
              protectedPages,
            );
            collapsedByBudget =
              trimmed.expanded.size < expandedRef.current.size;
            retainedExpanded = trimmed.expanded;
            return trimmed.levels;
          });
          if (collapsedByBudget) setCacheNotice(true);
          if (
            pageIndex === 0 &&
            result.nodes.length === 0 &&
            result.nextAfter === null &&
            retainedExpanded.has(levelId)
          ) {
            retainedExpanded = new Set(retainedExpanded);
            retainedExpanded.delete(levelId);
          }
          if (retainedExpanded !== expandedRef.current) {
            updateExpanded(() => retainedExpanded);
          }
        },
        () => {
          inFlight.current.delete(requestKey);
          if (epoch !== requestEpoch.current) return;
          let retainedExpanded = expandedRef.current;
          let collapsedByBudget = false;
          updateLevels((previous) => {
            const level = previous.get(levelId);
            if (
              level === undefined &&
              levelId !== pathId(ROOT_PATH) &&
              !expandedRef.current.has(levelId)
            ) {
              return previous;
            }
            const pages = [...(level?.pages ?? [])];
            const page = pages[pageIndex];
            pages[pageIndex] = {
              after,
              nextAfter: page?.nextAfter ?? null,
              count: page?.count ?? 0,
              nodes: null,
              pending: false,
              failed: true,
              touched: page?.touched ?? 0,
            };
            const next = new Map(previous);
            next.set(levelId, { parent: level?.parent ?? parent, pages });
            const protectedPages = new Set(visiblePageKeys.current);
            protectedPages.add(requestKey);
            const trimmed = trimPartitionTreeCache(
              next,
              expandedRef.current,
              focusedPath.current,
              depth,
              protectedPages,
            );
            collapsedByBudget =
              trimmed.expanded.size < expandedRef.current.size;
            retainedExpanded = trimmed.expanded;
            return trimmed.levels;
          });
          if (collapsedByBudget) setCacheNotice(true);
          if (retainedExpanded !== expandedRef.current) {
            updateExpanded(() => retainedExpanded);
          }
        },
      );
    },
    [depth, generation, updateExpanded, updateLevels],
  );

  const loadLevel = useCallback(
    (parent: PartitionValue[]) => {
      const first = levelsRef.current.get(pathId(parent))?.pages[0];
      if (first?.pending || (first !== undefined && first.nodes !== null))
        return;
      loadPage(parent, 0, first?.after ?? null);
    },
    [loadPage],
  );

  const loadNextPage = useCallback(
    (levelId: string) => {
      const level = levelsRef.current.get(levelId);
      const last = level?.pages.at(-1);
      if (
        level === undefined ||
        last === undefined ||
        last.nodes === null ||
        last.pending ||
        last.failed ||
        last.nextAfter === null
      ) {
        return;
      }
      loadPage(level.parent, level.pages.length, last.nextAfter);
    },
    [loadPage],
  );

  useEffect(() => {
    requestEpoch.current += 1;
    inFlight.current.clear();
    const empty = new Map<string, Level>();
    levelsRef.current = empty;
    setLevels(empty);
    expandedRef.current = new Set();
    setExpanded(new Set());
    focusedPath.current = null;
    setFocusedId(null);
    requestedFocus.current = null;
    requestedIndex.current = null;
    requestedEnd.current = false;
    visiblePageKeys.current.clear();
    setCacheNotice(false);
    setScrollTop(0);
    loadLevel(ROOT_PATH);
    return () => {
      requestEpoch.current += 1;
      inFlight.current.clear();
    };
  }, [generation, loadLevel]);

  const layout = useMemo(
    () => buildLayout(levels, expanded, depth),
    [depth, expanded, levels],
  );
  const viewportHeight = Math.min(
    VIEWPORT_HEIGHT,
    Math.max(ROW_HEIGHT, layout.rowCount * ROW_HEIGHT),
  );
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const renderedRows = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const lastRow = Math.min(layout.rowCount, firstRow + renderedRows);
  const viewportEntries = useMemo(
    () =>
      layout.entries.filter(
        (entry) => entry.index < lastRow && entry.index + entry.span > firstRow,
      ),
    [firstRow, lastRow, layout.entries],
  );
  useEffect(() => {
    visiblePageKeys.current = new Set(
      viewportEntries.map((entry) => `${entry.levelId}:${entry.pageIndex}`),
    );
  }, [viewportEntries]);
  const renderedItems = useMemo(() => {
    const items = viewportEntries.filter(
      (entry): entry is ItemEntry => entry.kind === "item",
    );
    const focusIndex =
      focusedId === null ? undefined : layout.itemIndices.get(focusedId);
    const focused =
      focusIndex === undefined
        ? undefined
        : entryAt(layout.entries, focusIndex);
    return focused?.kind === "item" &&
      !items.some(({ item }) => item.id === focused.item.id)
      ? [...items, focused].sort((left, right) => left.index - right.index)
      : items;
  }, [focusedId, layout.entries, layout.itemIndices, viewportEntries]);

  const selectFocus = useCallback((item: TreeItem) => {
    focusedPath.current = item.path;
    setFocusedId(item.id);
  }, []);

  useEffect(() => {
    if (focusedId !== null) return;
    const first = layout.entries.find(
      (entry): entry is ItemEntry => entry.kind === "item",
    );
    if (first !== undefined) selectFocus(first.item);
  }, [focusedId, layout.entries, selectFocus]);

  useEffect(() => {
    const index = requestedIndex.current;
    if (index === null) return;
    const entry = entryAt(layout.entries, index);
    if (entry?.kind !== "item") return;
    requestedIndex.current = null;
    requestedFocus.current = entry.item.id;
    selectFocus(entry.item);
  }, [layout.entries, selectFocus]);

  useEffect(() => {
    if (requestedFocus.current === null || requestedFocus.current !== focusedId)
      return;
    const item = itemRefs.current.get(requestedFocus.current);
    if (item !== undefined) {
      requestedFocus.current = null;
      item.focus();
    }
  }, [focusedId, renderedItems]);

  useEffect(() => {
    viewportEntries.forEach((entry) => {
      if (entry.kind !== "gap") return;
      const level = levelsRef.current.get(entry.levelId);
      const page = level?.pages[entry.pageIndex];
      if (level !== undefined && page !== undefined) {
        loadPage(level.parent, entry.pageIndex, page.after);
      }
    });
    layout.nextPageBoundaries.forEach((boundary) => {
      if (boundary.index >= firstRow && boundary.index < lastRow) {
        loadNextPage(boundary.levelId);
      }
    });
    levels.forEach((level, levelId) => {
      const last = level.pages.at(-1);
      if (last?.nodes?.length === 0 && last.nextAfter !== null) {
        loadNextPage(levelId);
      }
    });
  }, [
    firstRow,
    lastRow,
    layout.nextPageBoundaries,
    levels,
    loadNextPage,
    loadPage,
    viewportEntries,
  ]);

  const ensureVisible = useCallback(
    (index: number) => {
      const tree = treeRef.current;
      if (tree === null) return;
      const top = index * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      let next = tree.scrollTop;
      if (top < next) next = top;
      else if (bottom > next + viewportHeight) next = bottom - viewportHeight;
      if (next !== tree.scrollTop) tree.scrollTop = next;
      setScrollTop(next);
    },
    [viewportHeight],
  );

  const focusIndex = useCallback(
    (index: number) => {
      requestedEnd.current = false;
      if (layout.rowCount === 0) return;
      const target = Math.max(0, Math.min(index, layout.rowCount - 1));
      const entry = entryAt(layout.entries, target);
      if (entry === undefined) return;
      ensureVisible(target);
      if (entry.kind === "gap") {
        requestedIndex.current = target;
        const level = levelsRef.current.get(entry.levelId);
        const page = level?.pages[entry.pageIndex];
        if (level !== undefined && page !== undefined) {
          loadPage(level.parent, entry.pageIndex, page.after);
        }
      } else {
        requestedFocus.current = entry.item.id;
        selectFocus(entry.item);
      }
    },
    [ensureVisible, layout.entries, layout.rowCount, loadPage, selectFocus],
  );

  const continueEndNavigation = useCallback(() => {
    let parent = ROOT_PATH;
    while (true) {
      const levelId = pathId(parent);
      const level = levelsRef.current.get(levelId);
      if (level === undefined) {
        loadLevel(parent);
        return;
      }
      const lastPageIndex = level.pages.length - 1;
      const lastPage = level.pages[lastPageIndex];
      if (lastPage === undefined || lastPage.pending || lastPage.failed) return;
      if (lastPage.nodes === null) {
        loadPage(parent, lastPageIndex, lastPage.after);
        return;
      }
      if (lastPage.nextAfter !== null) {
        loadNextPage(levelId);
        return;
      }

      let lastNode: DatasetPartitionNode | undefined;
      for (let pageIndex = lastPageIndex; pageIndex >= 0; pageIndex -= 1) {
        const page = level.pages[pageIndex]!;
        if (page.count === 0) continue;
        if (page.nodes === null) {
          loadPage(parent, pageIndex, page.after);
          return;
        }
        lastNode = page.nodes.at(-1);
        if (lastNode !== undefined) break;
      }
      if (lastNode === undefined) {
        requestedEnd.current = false;
        return;
      }

      const path = appendNode(parent, lastNode);
      const id = pathId(path);
      if (expandedRef.current.has(id)) {
        parent = path;
        continue;
      }
      const index = layout.itemIndices.get(id);
      if (index === undefined) return;
      requestedEnd.current = false;
      focusIndex(index);
      return;
    }
  }, [focusIndex, layout.itemIndices, loadLevel, loadNextPage, loadPage]);

  useEffect(() => {
    if (requestedEnd.current) continueEndNavigation();
  }, [continueEndNavigation, expanded, levels]);

  const toggle = useCallback(
    (item: TreeItem) => {
      requestedEnd.current = false;
      if (!item.expandable) return;
      if (item.expanded) {
        const discardedLevelIds = new Set(
          [...levelsRef.current]
            .filter(([, level]) => isPathPrefix(item.path, level.parent))
            .map(([levelId]) => levelId),
        );
        updateLevels((previous) => {
          const next = new Map(previous);
          for (const [levelId, level] of next) {
            if (isPathPrefix(item.path, level.parent)) next.delete(levelId);
          }
          return next;
        });
        updateExpanded(
          (previous) =>
            new Set(
              [...previous].filter(
                (id) => id !== item.id && !discardedLevelIds.has(id),
              ),
            ),
        );
        return;
      }
      updateExpanded((previous) => {
        const next = new Set(previous);
        next.add(item.id);
        return next;
      });
      loadLevel(item.path);
    },
    [loadLevel, updateExpanded, updateLevels],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent, item: TreeItem) => {
      const index = layout.itemIndices.get(item.id);
      if (index === undefined) return;
      if (event.key === "End") {
        requestedEnd.current = true;
        continueEndNavigation();
      } else if (event.key === "ArrowDown") focusIndex(index + 1);
      else if (event.key === "ArrowUp") focusIndex(index - 1);
      else if (event.key === "Home") focusIndex(0);
      else if (event.key === "ArrowRight" && item.expandable) {
        if (!item.expanded) toggle(item);
        else {
          const child = entryAt(layout.entries, index + 1);
          if (child?.kind === "item" && child.item.parentId === item.id) {
            focusIndex(index + 1);
          } else if (child?.kind === "gap" && child.levelId === item.id) {
            focusIndex(index + 1);
          }
        }
      } else if (event.key === "ArrowLeft") {
        if (item.expanded) toggle(item);
        else if (item.parentId !== null) {
          const parent = layout.itemIndices.get(item.parentId);
          if (parent !== undefined) focusIndex(parent);
        }
      } else if (event.key === "Enter" || event.key === " ") toggle(item);
      else return;
      event.preventDefault();
    },
    [continueEndNavigation, focusIndex, layout, toggle],
  );

  const failed = [...levels.entries()].flatMap(([levelId, level]) =>
    level.pages.flatMap((page, pageIndex) =>
      page.failed ? [{ levelId, level, page, pageIndex }] : [],
    ),
  );
  const loading = [...levels.values()].some((level) =>
    level.pages.some(({ pending }) => pending),
  );
  return (
    <div className="dataset-partition-tree-shell">
      <div
        ref={treeRef}
        className="dataset-partition-tree"
        style={{ height: viewportHeight }}
        role="tree"
        aria-label="Dataset partition values"
        aria-busy={loading}
        onScroll={(event) => {
          requestedEnd.current = false;
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        <div
          className="dataset-partition-tree-space"
          role="presentation"
          style={{ height: layout.rowCount * ROW_HEIGHT }}
        >
          {viewportEntries.map((entry) =>
            entry.kind === "gap" ? (
              <div
                aria-hidden="true"
                className="dataset-partition-placeholder"
                key={`${entry.levelId}:${entry.pageIndex}`}
                style={{
                  top: Math.max(entry.index, firstRow) * ROW_HEIGHT,
                  height:
                    (Math.min(entry.index + entry.span, lastRow) -
                      Math.max(entry.index, firstRow)) *
                    ROW_HEIGHT,
                }}
              >
                Loading partition values…
              </div>
            ) : null,
          )}
          {renderedItems.map(({ item, index }) => (
            <button
              key={item.id}
              ref={(element) => {
                if (element === null) itemRefs.current.delete(item.id);
                else itemRefs.current.set(item.id, element);
              }}
              className="dataset-partition-node"
              style={{
                top: index * ROW_HEIGHT,
                paddingLeft: 10 + (item.depth - 1) * 18,
              }}
              type="button"
              role="treeitem"
              aria-level={item.depth}
              aria-posinset={item.position}
              aria-setsize={item.setSize}
              aria-expanded={item.expandable ? item.expanded : undefined}
              aria-label={partitionLabel(item.node)}
              tabIndex={focusedId === item.id ? 0 : -1}
              onFocus={() => {
                requestedEnd.current = false;
                selectFocus(item);
              }}
              onClick={() => toggle(item)}
              onKeyDown={(event) => onKeyDown(event, item)}
            >
              <span className="dataset-partition-disclosure" aria-hidden="true">
                {item.expandable ? (item.expanded ? "▾" : "▸") : ""}
              </span>
              <span>
                {item.node.partition.key}={item.node.partition.value}
              </span>
              <span>
                {" · "}
                {item.node.memberCount.toLocaleString("en-US")}{" "}
                {item.node.memberCount === 1 ? "file" : "files"}
              </span>
            </button>
          ))}
        </div>
      </div>
      {loading && (
        <p className="dataset-partition-status" role="status">
          Loading partitions…
        </p>
      )}
      {cacheNotice && (
        <p className="dataset-partition-status">
          Older expanded branches were collapsed to keep partition browsing
          responsive.
        </p>
      )}
      {failed.map(({ levelId, level, page, pageIndex }) => (
        <p
          className="dataset-partition-status"
          role="alert"
          key={`${levelId}:${pageIndex}`}
        >
          This partition page could not be loaded.
          <button
            className="text-button"
            type="button"
            onClick={() => loadPage(level.parent, pageIndex, page.after)}
          >
            Retry
          </button>
        </p>
      ))}
    </div>
  );
}
