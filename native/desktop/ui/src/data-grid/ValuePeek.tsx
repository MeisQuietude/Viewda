import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Rectangle } from "./grid-model";
import { ValueTree, type ValueTreeHandle } from "./ValueTree";
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

export function ValuePeek({
  value,
  label,
  anchor,
  onClose,
  onReturnFocus,
  onCopy,
}: {
  value: TypedValue;
  label: string;
  anchor: Rectangle;
  onClose: () => void;
  onReturnFocus: () => void;
  onCopy: (text: string) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<ValueTreeHandle>(null);
  const [size, setSize] = useState(readRememberedSize);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [viewport, setViewport] = useState(readViewportSize);
  const placement = placePeek(anchor, size, viewport.width, viewport.height);
  const placementRef = useRef(placement);
  placementRef.current = placement;

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

  useEffect(() => {
    const updateViewport = () => setViewport(readViewportSize());
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (popover === null || globalThis.ResizeObserver === undefined) return;
    const observer = new ResizeObserver(() => {
      const width = popover.offsetWidth;
      const height = popover.offsetHeight;
      if (width === 0 || height === 0) return;
      const imposed = placementRef.current;
      const widthChanged = Math.abs(width - imposed.width) > 1;
      const heightChanged = Math.abs(height - imposed.height) > 1;
      if (!widthChanged && !heightChanged) return;
      const current = sizeRef.current;
      const next = {
        width: widthChanged ? Math.max(MIN_SIZE.width, width) : current.width,
        height: heightChanged
          ? Math.max(MIN_SIZE.height, height)
          : current.height,
      };
      if (current.width === next.width && current.height === next.height)
        return;
      sizeRef.current = next;
      setSize(next);
      rememberSize(next);
    });
    observer.observe(popover);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={popoverRef}
      className="value-peek"
      role="dialog"
      aria-label={`Peek ${label}`}
      style={placement}
      onKeyDownCapture={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          onReturnFocus();
        }
      }}
    >
      <header className="value-peek-header">
        <strong title={label}>{label}</strong>
        <div className="value-peek-actions">
          <button
            type="button"
            onClick={() => {
              treeRef.current?.copyJson();
              treeRef.current?.focus();
            }}
          >
            Copy JSON
          </button>
          <button
            type="button"
            onClick={() => {
              treeRef.current?.copyPath();
              treeRef.current?.focus();
            }}
          >
            Copy path
          </button>
        </div>
      </header>
      <div
        className="value-peek-content"
        onPointerDown={(event) => {
          if (!(event.target instanceof HTMLButtonElement)) {
            treeRef.current?.focus();
          }
        }}
      >
        <ValueTree ref={treeRef} value={value} label={label} onCopy={onCopy} />
      </div>
      <span className="value-peek-resize-hint" aria-hidden="true" />
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
  const useRight = rightSpace >= requested.width || rightSpace >= leftSpace;
  const viewportInnerWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const sideWidth = Math.max(0, useRight ? rightSpace : leftSpace);
  const width = Math.min(
    requested.width,
    sideWidth > 0 ? sideWidth : viewportInnerWidth,
    viewportInnerWidth,
  );
  const proposedLeft = useRight
    ? anchor.x + anchor.width + ANCHOR_GAP
    : anchor.x - ANCHOR_GAP - width;
  const left = Math.max(
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
