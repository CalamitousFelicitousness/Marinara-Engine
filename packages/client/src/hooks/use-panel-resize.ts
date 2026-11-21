// ──────────────────────────────────────────────
// Drag-to-resize for edge-anchored panels
// ──────────────────────────────────────────────
// Pointer events rather than mouse events, so touch and stylus work: the Android
// WebView wrapper never fires mousemove. `onPreview` is coalesced to one call
// per frame.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const PANEL_RESIZE_STEP = 16;
export const PANEL_RESIZE_LARGE_STEP = 48;

/** Which viewport edge the panel is anchored to. Decides both the pointer maths and arrow-key direction. */
export type PanelResizeEdge = "left" | "right";

export function clampPanelWidth(width: number, min: number, max: number) {
  return Math.max(min, Math.min(max, width));
}

interface UsePanelResizeOptions {
  edge: PanelResizeEdge;
  /** Committed width, used as the keyboard base and the ARIA value. */
  width: number;
  min: number;
  max: number;
  /** Called once, when the drag ends or a key commits. */
  onCommit: (width: number) => void;
  /** Live width for callers that must re-render mid-drag; null on release. At most once per frame. */
  onPreview?: (width: number | null) => void;
  disabled?: boolean;
  label?: string;
}

export function usePanelResize({
  edge,
  width,
  min,
  max,
  onCommit,
  onPreview,
  disabled = false,
  label,
}: UsePanelResizeOptions) {
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const latestRef = useRef(width);

  const publish = useCallback((next: number | null) => onPreview?.(next), [onPreview]);

  // A drag that ends while unmounting must not leave a frame pending.
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();

      const handle = event.currentTarget;
      const host = handle.ownerDocument.defaultView ?? window;
      const root = handle.ownerDocument.documentElement;
      const body = handle.ownerDocument.body;
      const originalUserSelect = body.style.userSelect;
      // The drag leaves the thin handle; the page keeps the resize cursor until it ends (globals.css, #8621).
      root.dataset.marinaraResizing = "col";
      body.style.userSelect = "none";

      latestRef.current = width;
      setDragging(true);
      publish(width);
      handle.setPointerCapture(event.pointerId);

      const widthFor = (clientX: number) =>
        clampPanelWidth(edge === "left" ? clientX : host.innerWidth - clientX, min, max);

      const flush = () => {
        frameRef.current = null;
        const next = pendingRef.current;
        if (next === null) return;
        pendingRef.current = null;
        latestRef.current = next;
        publish(next);
      };

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        pendingRef.current = widthFor(moveEvent.clientX);
        if (frameRef.current === null) frameRef.current = host.requestAnimationFrame(flush);
      };

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (frameRef.current !== null) {
          host.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        const committed = pendingRef.current ?? latestRef.current;
        pendingRef.current = null;
        publish(null);
        setDragging(false);
        delete root.dataset.marinaraResizing;
        body.style.userSelect = originalUserSelect;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        handle.removeEventListener("lostpointercapture", finish);
        host.removeEventListener("blur", finish);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        onCommit(committed);
      };

      // Pointer capture routes the stream to the handle itself, so these stay
      // element-local rather than leaking window listeners.
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      host.addEventListener("blur", finish);
    },
    [disabled, edge, max, min, onCommit, publish, width],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      const step = event.shiftKey ? PANEL_RESIZE_LARGE_STEP : PANEL_RESIZE_STEP;
      // Arrow keys mean "grow" and "shrink" relative to where the panel is
      // anchored, not a fixed screen direction.
      const grow = edge === "left" ? "ArrowRight" : "ArrowLeft";
      const shrink = edge === "left" ? "ArrowLeft" : "ArrowRight";

      let next: number;
      if (event.key === grow) next = width + step;
      else if (event.key === shrink) next = width - step;
      else if (event.key === "Home") next = min;
      else if (event.key === "End") next = max;
      else return;

      event.preventDefault();
      onCommit(clampPanelWidth(next, min, max));
    },
    [disabled, edge, max, min, onCommit, width],
  );

  return {
    dragging,
    separatorProps: {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-label": label,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": Math.round(width),
      tabIndex: disabled ? -1 : 0,
      onPointerDown,
      onKeyDown,
      // Without this a touch drag scrolls the page instead of resizing.
      style: { touchAction: "none" as const },
    },
  };
}
