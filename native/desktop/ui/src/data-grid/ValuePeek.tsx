import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { Rectangle } from "./grid-model";
import type { FieldPath } from "../desktop";
import {
  ValueTree,
  type ValueCopyHandlers,
  type ValueTreeHandle,
} from "./ValueTree";
import type { TypedValue } from "./value-format";

const DEFAULT_SIZE = { width: 360, height: 480 };
const MIN_SIZE = { width: 280, height: 220 };
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const SIZE_STORAGE_KEY = "viewda.value-peek.size";

export interface PeekPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ResizeGesture {
  pointerId: number;
  originX: number;
  originY: number;
  origin: PeekPlacement;
  current: PeekPlacement;
  changedWidth: boolean;
  changedHeight: boolean;
  handle: HTMLElement;
}

export function ValuePeek({
  value,
  label,
  fieldPath = [label],
  anchor,
  focusRequest = 0,
  loading = false,
  showCopyPath = true,
  onClose,
  onReturnFocus,
  onPromoteField,
  onCopy,
  onCopyIntent,
}: {
  value: TypedValue;
  label: string;
  fieldPath?: FieldPath;
  anchor: Rectangle;
  focusRequest?: number;
  loading?: boolean;
  showCopyPath?: boolean;
  onClose: () => void;
  onReturnFocus: () => void;
  onPromoteField?: (fieldPath: FieldPath) => void;
} & ValueCopyHandlers) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<ValueTreeHandle>(null);
  const [initialSize] = useState(readRememberedSize);
  const requestedSizeRef = useRef(initialSize);
  const [viewport, setViewport] = useState(readViewportSize);
  const viewportRef = useRef(viewport);
  const [placement, setPlacement] = useState(() =>
    placePeek(anchor, initialSize, viewport.width, viewport.height),
  );
  const resizeGestureRef = useRef<ResizeGesture | null>(null);
  const placementPendingRef = useRef(false);
  const anchorRef = useRef(anchor);
  const previousAnchorRef = useRef(anchor);
  const previousViewportRef = useRef(viewport);
  const [resizing, setResizing] = useState(false);

  useLayoutEffect(() => {
    viewportRef.current = viewport;
    anchorRef.current = anchor;
  }, [anchor, viewport]);

  useEffect(() => {
    if (focusRequest > 0 && !loading) treeRef.current?.focus();
  }, [focusRequest, loading]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        onReturnFocus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, onReturnFocus]);

  useLayoutEffect(() => {
    if (resizeGestureRef.current !== null) {
      placementPendingRef.current = true;
      return;
    }
    placementPendingRef.current = false;
    const previousAnchor = previousAnchorRef.current;
    const previousViewport = previousViewportRef.current;
    previousAnchorRef.current = anchor;
    previousViewportRef.current = viewport;
    setPlacement((current) => {
      const anchorMoved = !sameRectangle(previousAnchor, anchor);
      const viewportChanged =
        previousViewport.width !== viewport.width ||
        previousViewport.height !== viewport.height;
      if (
        anchorMoved &&
        !viewportChanged &&
        placementFitsViewport(current, viewport.width, viewport.height) &&
        !rectanglesIntersect(current, anchor)
      ) {
        return current;
      }
      const next =
        anchorMoved && !viewportChanged
          ? placeFollowingPeek(
              anchor,
              previousAnchor,
              current,
              requestedSizeRef.current,
              viewport.width,
              viewport.height,
            )
          : placePeek(
              anchor,
              requestedSizeRef.current,
              viewport.width,
              viewport.height,
            );
      return samePlacement(current, next) ? current : next;
    });
  }, [
    anchor.height,
    anchor.width,
    anchor.x,
    anchor.y,
    viewport.height,
    viewport.width,
  ]);

  const finishResize = useCallback((pointerId: number, commit: boolean) => {
    const gesture = resizeGestureRef.current;
    if (gesture === null || gesture.pointerId !== pointerId) return;
    resizeGestureRef.current = null;
    setResizing(false);
    if (gesture.handle.hasPointerCapture?.(pointerId)) {
      gesture.handle.releasePointerCapture(pointerId);
    }
    const requested = requestedSizeRef.current;
    const nextRequested =
      commit && (gesture.changedWidth || gesture.changedHeight)
        ? {
            width: gesture.changedWidth
              ? gesture.current.width
              : requested.width,
            height: gesture.changedHeight
              ? gesture.current.height
              : requested.height,
          }
        : requested;
    if (nextRequested !== requested) {
      requestedSizeRef.current = nextRequested;
      rememberSize(nextRequested);
    }
    if (commit || placementPendingRef.current) {
      placementPendingRef.current = false;
      const currentViewport = viewportRef.current;
      setPlacement(
        placePeek(
          anchorRef.current,
          nextRequested,
          currentViewport.width,
          currentViewport.height,
        ),
      );
    } else if (!commit) {
      setPlacement(gesture.origin);
    }
  }, []);

  useEffect(() => {
    const updateViewport = () => {
      const next = readViewportSize();
      viewportRef.current = next;
      setViewport(next);
      const gesture = resizeGestureRef.current;
      if (gesture !== null) {
        placementPendingRef.current = true;
        finishResize(gesture.pointerId, false);
      }
    };
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [finishResize]);

  const resize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const gesture = resizeGestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const currentViewport = viewportRef.current;
    const maxWidth = Math.max(
      0,
      currentViewport.width - VIEWPORT_MARGIN - gesture.origin.left,
    );
    const maxHeight = Math.max(
      0,
      currentViewport.height - VIEWPORT_MARGIN - gesture.origin.top,
    );
    const width = clamp(
      gesture.origin.width + event.clientX - gesture.originX,
      Math.min(MIN_SIZE.width, maxWidth),
      maxWidth,
    );
    const height = clamp(
      gesture.origin.height + event.clientY - gesture.originY,
      Math.min(MIN_SIZE.height, maxHeight),
      maxHeight,
    );
    const next = { ...gesture.origin, width, height };
    gesture.current = next;
    gesture.changedWidth ||= width !== gesture.origin.width;
    gesture.changedHeight ||= height !== gesture.origin.height;
    setPlacement(next);
  };

  return (
    <div
      ref={popoverRef}
      className={`value-peek${resizing ? " is-resizing" : ""}`}
      role="dialog"
      aria-label={`Peek ${label}`}
      style={placement}
      onKeyDownCapture={(event) => {
        if (event.key !== "Tab") return;
        if (
          !event.shiftKey &&
          (event.target as HTMLElement).closest('[role="tree"]') !== null
        ) {
          event.preventDefault();
          onReturnFocus();
          return;
        }
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex="0"]',
          ),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) return;
        if (
          event.shiftKey &&
          (event.target as HTMLElement).closest('[role="tree"]') !== null
        ) {
          const previous = focusable.at(-2);
          if (previous !== undefined) {
            event.preventDefault();
            previous.focus();
          }
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="value-peek-header">
        <strong title={label}>{label}</strong>
        <button
          className="value-peek-close"
          type="button"
          aria-label="Close Peek"
          onClick={() => {
            onClose();
            onReturnFocus();
          }}
        >
          ×
        </button>
      </header>
      <div
        className="value-peek-content"
        onPointerDown={(event) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.closest("button, input") === null
          ) {
            treeRef.current?.focus();
          }
        }}
      >
        {loading ? (
          <div className="value-tree-status" role="status">
            Loading next cell…
          </div>
        ) : (
          <ValueTree
            ref={treeRef}
            value={value}
            label={label}
            fieldPath={showCopyPath ? fieldPath : undefined}
            onPromoteField={onPromoteField}
            {...(onCopyIntent === undefined
              ? { onCopy: onCopy! }
              : { onCopyIntent })}
          />
        )}
      </div>
      <span
        className="value-peek-resize-hint"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          resizeGestureRef.current = {
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            origin: placement,
            current: placement,
            changedWidth: false,
            changedHeight: false,
            handle: event.currentTarget,
          };
          setResizing(true);
        }}
        onPointerMove={resize}
        onPointerUp={(event) => finishResize(event.pointerId, true)}
        onPointerCancel={(event) => finishResize(event.pointerId, false)}
        onLostPointerCapture={(event) => finishResize(event.pointerId, false)}
      />
    </div>
  );
}

export function placePeek(
  anchor: Rectangle,
  requested: { width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): PeekPlacement {
  const rightSpace =
    viewportWidth - anchor.x - anchor.width - ANCHOR_GAP - VIEWPORT_MARGIN;
  const leftSpace = anchor.x - ANCHOR_GAP - VIEWPORT_MARGIN;
  const viewportInnerWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const useViewportWidth =
    rightSpace < MIN_SIZE.width && leftSpace < MIN_SIZE.width;
  const useRight = rightSpace >= requested.width || rightSpace >= leftSpace;
  const sideWidth = Math.max(0, useRight ? rightSpace : leftSpace);
  const width = useViewportWidth
    ? viewportInnerWidth
    : Math.min(
        requested.width,
        sideWidth > 0 ? sideWidth : viewportInnerWidth,
        viewportInnerWidth,
      );
  const proposedLeft = useViewportWidth
    ? VIEWPORT_MARGIN
    : useRight
      ? anchor.x + anchor.width + ANCHOR_GAP
      : anchor.x - ANCHOR_GAP - width;
  const left = useViewportWidth
    ? VIEWPORT_MARGIN
    : Math.max(
        VIEWPORT_MARGIN,
        Math.min(proposedLeft, viewportWidth - VIEWPORT_MARGIN - width),
      );

  const belowSpace =
    viewportHeight - anchor.y - anchor.height - ANCHOR_GAP - VIEWPORT_MARGIN;
  const aboveSpace = anchor.y - ANCHOR_GAP - VIEWPORT_MARGIN;
  const useBelow = belowSpace >= requested.height || belowSpace >= aboveSpace;
  const viewportInnerHeight = Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2);
  const sideHeight = Math.max(0, useBelow ? belowSpace : aboveSpace);
  const height = Math.min(
    requested.height,
    sideHeight > 0 ? sideHeight : viewportInnerHeight,
    viewportInnerHeight,
  );
  const proposedTop = useBelow
    ? anchor.y + anchor.height + ANCHOR_GAP
    : anchor.y - ANCHOR_GAP - height;
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(proposedTop, viewportHeight - VIEWPORT_MARGIN - height),
  );

  return { left, top, width, height };
}

function placeFollowingPeek(
  anchor: Rectangle,
  previousAnchor: Rectangle,
  current: PeekPlacement,
  requested: { width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): PeekPlacement {
  const rightSpace =
    viewportWidth - anchor.x - anchor.width - ANCHOR_GAP - VIEWPORT_MARGIN;
  const leftSpace = anchor.x - ANCHOR_GAP - VIEWPORT_MARGIN;
  const belowSpace =
    viewportHeight - anchor.y - anchor.height - ANCHOR_GAP - VIEWPORT_MARGIN;
  const aboveSpace = anchor.y - ANCHOR_GAP - VIEWPORT_MARGIN;
  const previousHorizontal = sideOfAnchor(
    current.left,
    current.width,
    previousAnchor.x,
    previousAnchor.width,
  );
  const previousVertical = sideOfAnchor(
    current.top,
    current.height,
    previousAnchor.y,
    previousAnchor.height,
  );
  const viewportInnerWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const viewportInnerHeight = Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2);
  const desiredWidth = Math.min(requested.width, viewportInnerWidth);
  const desiredHeight = Math.min(requested.height, viewportInnerHeight);
  const useViewportWidth =
    rightSpace < MIN_SIZE.width && leftSpace < MIN_SIZE.width;
  const useRight = chooseFollowingSide(
    previousHorizontal,
    leftSpace,
    rightSpace,
    desiredWidth,
  );
  const useBelow = chooseFollowingSide(
    previousVertical,
    aboveSpace,
    belowSpace,
    desiredHeight,
  );
  const width = useViewportWidth
    ? viewportInnerWidth
    : Math.min(desiredWidth, Math.max(0, useRight ? rightSpace : leftSpace));
  const height = Math.min(
    desiredHeight,
    Math.max(0, useBelow ? belowSpace : aboveSpace),
  );
  const proposedLeft = useViewportWidth
    ? VIEWPORT_MARGIN
    : useRight
      ? anchor.x + anchor.width + ANCHOR_GAP
      : anchor.x - ANCHOR_GAP - width;
  const proposedTop = useBelow
    ? anchor.y + anchor.height + ANCHOR_GAP
    : anchor.y - ANCHOR_GAP - height;
  return {
    left: clamp(
      proposedLeft,
      VIEWPORT_MARGIN,
      viewportWidth - VIEWPORT_MARGIN - width,
    ),
    top: clamp(
      proposedTop,
      VIEWPORT_MARGIN,
      viewportHeight - VIEWPORT_MARGIN - height,
    ),
    width,
    height,
  };
}

function sideOfAnchor(
  position: number,
  size: number,
  anchorPosition: number,
  anchorSize: number,
): "before" | "after" | undefined {
  if (position >= anchorPosition + anchorSize) return "after";
  if (position + size <= anchorPosition) return "before";
  return undefined;
}

function chooseFollowingSide(
  previous: "before" | "after" | undefined,
  beforeSpace: number,
  afterSpace: number,
  size: number,
): boolean {
  if (previous === "after" && afterSpace >= size) return true;
  if (previous === "before" && beforeSpace >= size) return false;
  if (previous === "after" && beforeSpace >= size) return false;
  if (previous === "before" && afterSpace >= size) return true;
  return afterSpace >= beforeSpace;
}

function readRememberedSize(): { width: number; height: number } {
  try {
    const stored = localStorage.getItem(SIZE_STORAGE_KEY);
    if (stored === null) return DEFAULT_SIZE;
    const parsed = JSON.parse(stored) as { width?: unknown; height?: unknown };
    return typeof parsed.width === "number" && typeof parsed.height === "number"
      ? {
          width: Math.max(MIN_SIZE.width, parsed.width),
          height: Math.max(MIN_SIZE.height, parsed.height),
        }
      : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

function rememberSize(size: { width: number; height: number }): void {
  try {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // Resizing remains available when storage is disabled.
  }
}

function readViewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function samePlacement(left: PeekPlacement, right: PeekPlacement): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function placementFitsViewport(
  placement: PeekPlacement,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return (
    placement.left >= VIEWPORT_MARGIN &&
    placement.top >= VIEWPORT_MARGIN &&
    placement.left + placement.width <= viewportWidth - VIEWPORT_MARGIN &&
    placement.top + placement.height <= viewportHeight - VIEWPORT_MARGIN
  );
}

function rectanglesIntersect(left: PeekPlacement, right: Rectangle): boolean {
  return (
    left.left < right.x + right.width &&
    left.left + left.width > right.x &&
    left.top < right.y + right.height &&
    left.top + left.height > right.y
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
