import {
  type CSSProperties,
  type ReactNode,
  type UIEvent as ReactUIEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Keeps browser scrollbars outside Glide's canvas header.
 *
 * Glide renders its header and rows behind one full-height scroll element. An
 * overlay scrollbar therefore covers the last column header, and Glide's
 * canvas receives pointer events through that scrollbar. DataEditor does not
 * expose its scroll element, so this wrapper discovers it without relying on
 * Glide class names and mirrors its physical offsets to sibling browser scroll
 * elements. Glide remains responsible for mapping those physical offsets to
 * logical rows in very large data sets.
 *
 * Platforms with classic scrollbars keep Glide's own scrollbars. Remove this
 * wrapper when Glide provides a body-scoped scrollbar or a public raw scroll
 * element reference.
 */
const FLOATING_SCROLLBAR_SIZE = 16;
const MAX_SPACER_SIZE = 5_000_000;

interface ScrollMetrics {
  hasHorizontal: boolean;
  hasVertical: boolean;
  horizontalExtent: number;
  verticalExtent: number;
}

const emptyScrollMetrics: ScrollMetrics = {
  hasHorizontal: false,
  hasVertical: false,
  horizontalExtent: 0,
  verticalExtent: 0,
};

function sameScrollMetrics(left: ScrollMetrics, right: ScrollMetrics): boolean {
  return (
    left.hasHorizontal === right.hasHorizontal &&
    left.hasVertical === right.hasVertical &&
    left.horizontalExtent === right.horizontalExtent &&
    left.verticalExtent === right.verticalExtent
  );
}

function scrollableDistance(element: HTMLElement): number {
  return (
    Math.max(0, element.scrollHeight - element.clientHeight) +
    Math.max(0, element.scrollWidth - element.clientWidth)
  );
}

function usesOverlayScrollbars(): boolean {
  // Overlay scrollbars consume no layout width; classic scrollbars do.
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.width = "100px";
  probe.style.height = "100px";
  probe.style.overflow = "scroll";
  document.body.append(probe);
  const overlay = probe.offsetWidth === probe.clientWidth;
  probe.remove();
  return overlay;
}

function findGridScroller(root: HTMLElement): HTMLElement | null {
  let result: HTMLElement | null = null;
  let resultArea = 0;

  // The main Glide scroller is the largest descendant that both overflows and
  // allows scrolling. Several of its ancestors also report overflow because
  // they clip the same large spacer; accepting them would leave the actual
  // scroller disconnected. Detecting the behavior avoids coupling this
  // workaround to `.dvn-scroller`.
  for (const candidate of root.querySelectorAll<HTMLElement>("*")) {
    const style = window.getComputedStyle(candidate);
    const overflowY = style.overflowY || style.overflow;
    const overflowX = style.overflowX || style.overflow;
    const canScrollVertically =
      candidate.scrollHeight > candidate.clientHeight &&
      (overflowY === "auto" || overflowY === "scroll");
    const canScrollHorizontally =
      candidate.scrollWidth > candidate.clientWidth &&
      (overflowX === "auto" || overflowX === "scroll");
    if (!canScrollVertically && !canScrollHorizontally) {
      continue;
    }

    const area = candidate.clientWidth * candidate.clientHeight;
    if (area > resultArea) {
      result = candidate;
      resultArea = area;
    }
  }

  return result;
}

function spacerChunks(extent: number): number[] {
  // Browsers can ignore a single enormous CSS dimension. Glide uses the same
  // ceiling for its internal scroll spacers.
  const chunks: number[] = [];
  let remaining = Math.max(0, extent);
  while (remaining > 0) {
    const chunk = Math.min(MAX_SPACER_SIZE, remaining);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

function ScrollSpacer({
  axis,
  extent,
}: {
  axis: "horizontal" | "vertical";
  extent: number;
}) {
  const chunks = useMemo(() => spacerChunks(extent), [extent]);

  return (
    <div className={`grid-scroll-spacer grid-scroll-spacer-${axis}`}>
      {chunks.map((chunk, index) => (
        <div
          key={index}
          style={axis === "vertical" ? { height: chunk } : { width: chunk }}
        />
      ))}
    </div>
  );
}

export function GridScrollViewport({
  children,
  headerHeight,
}: {
  children: ReactNode;
  headerHeight: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const gridScrollerRef = useRef<HTMLElement | null>(null);
  const verticalRef = useRef<HTMLDivElement>(null);
  const horizontalRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [showExternalScrollbars, setShowExternalScrollbars] = useState(false);
  const [metrics, setMetrics] = useState(emptyScrollMetrics);

  const updateMetrics = useCallback(
    (scroller: HTMLElement): void => {
      const root = rootRef.current;
      if (root === null || root.clientWidth === 0 || root.clientHeight === 0) {
        return;
      }

      const verticalDistance = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      const horizontalDistance = Math.max(
        0,
        scroller.scrollWidth - scroller.clientWidth,
      );
      const hasVertical = verticalDistance > 0;
      const hasHorizontal = horizontalDistance > 0;
      const verticalViewport = Math.max(0, root.clientHeight - headerHeight);
      const horizontalViewport = root.clientWidth;
      // Both scroll elements need the same maximum physical offset:
      // external extent - external viewport = internal scroll distance.
      const nextMetrics = {
        hasHorizontal,
        hasVertical,
        horizontalExtent: horizontalViewport + horizontalDistance,
        verticalExtent: verticalViewport + verticalDistance,
      };

      setMetrics((current) =>
        sameScrollMetrics(current, nextMetrics) ? current : nextMetrics,
      );
    },
    [headerHeight],
  );

  const connectGridScroller = useCallback(
    (scroller: HTMLElement): void => {
      if (gridScrollerRef.current !== scroller) {
        gridScrollerRef.current = scroller;
        resizeObserverRef.current?.observe(scroller);
      }
      updateMetrics(scroller);
    },
    [updateMetrics],
  );

  const discoverGridScroller = useCallback((): void => {
    const current = gridScrollerRef.current;
    if (current?.isConnected === true) {
      updateMetrics(current);
      return;
    }

    const editor = editorRef.current;
    if (editor === null) {
      return;
    }

    const scroller = findGridScroller(editor);
    if (scroller !== null) {
      connectGridScroller(scroller);
    }
  }, [connectGridScroller, updateMetrics]);

  const syncScrollbarsFromGrid = useCallback((scroller: HTMLElement): void => {
    // Copy physical offsets. Glide owns their logical row/column translation.
    const vertical = verticalRef.current;
    const horizontal = horizontalRef.current;
    if (vertical !== null && vertical.scrollTop !== scroller.scrollTop) {
      vertical.scrollTop = scroller.scrollTop;
    }
    if (horizontal !== null && horizontal.scrollLeft !== scroller.scrollLeft) {
      horizontal.scrollLeft = scroller.scrollLeft;
    }
  }, []);

  const handleGridScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const current = gridScrollerRef.current;
      if (current === null || current.isConnected === false) {
        const root = rootRef.current;
        if (
          root === null ||
          scrollableDistance(target) === 0 ||
          target.clientWidth < root.clientWidth - FLOATING_SCROLLBAR_SIZE ||
          target.clientHeight < root.clientHeight - FLOATING_SCROLLBAR_SIZE
        ) {
          return;
        }
        connectGridScroller(target);
      } else if (target !== current) {
        return;
      }

      syncScrollbarsFromGrid(target);
    },
    [connectGridScroller, syncScrollbarsFromGrid],
  );

  const handleVerticalScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>): void => {
      const scroller = gridScrollerRef.current;
      if (
        scroller !== null &&
        scroller.scrollTop !== event.currentTarget.scrollTop
      ) {
        scroller.scrollTop = event.currentTarget.scrollTop;
      }
    },
    [],
  );

  const handleHorizontalScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>): void => {
      const scroller = gridScrollerRef.current;
      if (
        scroller !== null &&
        scroller.scrollLeft !== event.currentTarget.scrollLeft
      ) {
        scroller.scrollLeft = event.currentTarget.scrollLeft;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    const editor = editorRef.current;
    if (root === null || editor === null) {
      return;
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(discoverGridScroller);
    resizeObserverRef.current = resizeObserver;
    resizeObserver?.observe(root);

    // Glide mounts the scroller after its resize detector has measured the
    // available space, so it may not exist during our first layout effect.
    const mutationObserver = new MutationObserver(discoverGridScroller);
    mutationObserver.observe(editor, { childList: true, subtree: true });
    discoverGridScroller();

    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      resizeObserverRef.current = null;
      gridScrollerRef.current = null;
    };
  }, [discoverGridScroller]);

  useLayoutEffect(() => {
    setShowExternalScrollbars(usesOverlayScrollbars());
  }, []);

  useLayoutEffect(() => {
    discoverGridScroller();
    const scroller = gridScrollerRef.current;
    if (scroller !== null) {
      syncScrollbarsFromGrid(scroller);
    }
  });

  const rootStyle = {
    "--grid-floating-scrollbar-size": `${FLOATING_SCROLLBAR_SIZE}px`,
  } as CSSProperties;
  const verticalStyle = {
    top: headerHeight,
    bottom: 0,
  };
  const horizontalStyle = {
    right: 0,
  };

  return (
    <div
      className={`grid-canvas${showExternalScrollbars ? " grid-canvas-overlay-scrollbars" : ""}`}
      ref={rootRef}
      style={rootStyle}
    >
      <div
        className="grid-editor-viewport"
        ref={editorRef}
        onScrollCapture={handleGridScroll}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className="grid-scrollbar grid-scrollbar-vertical"
        hidden={!showExternalScrollbars || !metrics.hasVertical}
        onFocus={(event) => event.currentTarget.blur()}
        onScroll={handleVerticalScroll}
        ref={verticalRef}
        style={verticalStyle}
        tabIndex={-1}
      >
        <ScrollSpacer axis="vertical" extent={metrics.verticalExtent} />
      </div>
      <div
        aria-hidden="true"
        className="grid-scrollbar grid-scrollbar-horizontal"
        hidden={!showExternalScrollbars || !metrics.hasHorizontal}
        onFocus={(event) => event.currentTarget.blur()}
        onScroll={handleHorizontalScroll}
        ref={horizontalRef}
        style={horizontalStyle}
        tabIndex={-1}
      >
        <ScrollSpacer axis="horizontal" extent={metrics.horizontalExtent} />
      </div>
    </div>
  );
}
