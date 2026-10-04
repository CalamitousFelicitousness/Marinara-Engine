// ──────────────────────────────────────────────
// Shared floating window: move, resize, minimize, pin, lock, close
//
// Every chat window (Chat Settings, popped-out drawers, the Trackers window, the
// chat's control windows) renders through this component so they behave and theme
// alike. A minimizable window shrinks to a small button (its bubble) the user can
// place anywhere. Custom themes style the stable `mari-window…` classes, the data
// attributes and the `--mari-window-*` variables documented in globals.css.
// ──────────────────────────────────────────────
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Lock, Minus, Pin, Unlock, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
  RESIZE_EDGES,
  WINDOW_KEYBOARD_LARGE_STEP_PX,
  WINDOW_KEYBOARD_STEP_PX,
  WINDOW_BUBBLE_SIZE_PX,
  WINDOW_MARGIN_PX,
  clampWindowBubble,
  clampWindowGeometry,
  moveWindowGeometry,
  placeWindowBesideBubble,
  resizeWindowGeometry,
  type FloatingWindowId,
  type WindowPoint,
  type ResizeEdge,
  type WindowBounds,
  type WindowGeometry,
  type WindowLayout,
} from "../../lib/floating-window-layout";
import { isModalOverlayOpen } from "../../lib/modal-overlay-registry";
import { snapBubble, type SnapGuide } from "../../lib/window-bubble-snap";
import { DrawerHostContext, type DrawerHost } from "./drawer-host";
import {
  FLOATING_WINDOW_Z_BASE,
  takeFloatingWindowFocusRequest,
  takeFloatingWindowOpener,
  useFloatingWindowStore,
} from "../../stores/floating-window.store";

export type FloatingWindowCloseReason = "close-button" | "escape" | "outside-pointer";

export interface FloatingWindowProps {
  id: FloatingWindowId;
  title: ReactNode;
  titleIcon?: ReactNode;
  /** Rendered after the title, outside the heading (a help button, for example). */
  titleAccessory?: ReactNode;
  closeLabel: string;
  /** Where the window opens before the user moves it, and where Reset View puts it back. */
  getDefaultLayout: (bounds: WindowBounds) => WindowLayout;
  /** Changing this re-reads the default once the page has updated (a panel the default avoids opened, say). */
  defaultLayoutKey?: string;
  minWidth?: number;
  minHeight?: number;
  /** "sheet" is today's phone panel: no move, resize, pin or lock, and it closes on an outside press. */
  presentation?: "window" | "sheet";
  /** False: the window takes focus only when the user opens it, never just because focus is free. */
  autoFocus?: boolean;
  /**
   * Keeps a closed window mounted but out of sight, so drawers popped out of it (rendered from inside
   * it) stay open. Showing it again counts as opening it.
   */
  hidden?: boolean;
  /**
   * Drawers inside can pop out into their own windows, which copy this window's look. `title` names
   * this window on their close buttons; `scrollClassName` styles their scrolling body.
   */
  drawerHost?: { title: string; scrollClassName?: string };
  /**
   * The window can shrink to a small button you place anywhere (its bubble), showing `icon`; `label`
   * names it. Closing it, Escape and, while unpinned, a press elsewhere shrink it back too.
   * `getDefaultLayout` says whether it starts minimized and where its bubble starts.
   */
  minimizable?: { icon: ReactNode; label: string };
  className?: string;
  sheetClassName?: string;
  sheetStyle?: CSSProperties;
  headerClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
  rootAttributes?: Record<`data-${string}`, string | boolean | undefined>;
  /** Presses on these targets do not count as "outside" (portalled menus, related dialogs…). */
  ignoreOutsidePointer?: (target: Element) => boolean;
  /**
   * May resolve to `false` when a guard keeps the window open; focus then stays where it is. A
   * minimizable window minimizes instead and does not call it.
   */
  onRequestClose?: (reason: FloatingWindowCloseReason) => void | Promise<boolean>;
  /** Follows the pointer while the title bar is dragged; returning true at "end" keeps the window where it was. */
  onDragMove?: (point: { x: number; y: number }, phase: "move" | "end") => boolean | void;
  children: ReactNode;
}

const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 240;
/** A press on a bubble that moves less than this (px) opens its window instead of dragging it. */
const BUBBLE_DRAG_START_PX = 4;
const NO_DRAG_SELECTOR = "button, a, input, select, textarea, [contenteditable='true'], [data-window-no-drag]";
// Escape in a text field belongs to the field (many cancel an edit with it); anywhere else in the
// window it closes an unpinned window. Controls that use Escape themselves call preventDefault.
const KEEPS_ESCAPE_SELECTOR =
  "textarea, [contenteditable='true'], input:not([type='checkbox'], [type='radio'], [type='range'], [type='button'], [type='submit'], [type='reset'], [type='color'], [type='file'])";

const CENTER_CONTENT_SELECTOR = '[data-component="CenterContent"]';

/**
 * The chat area below the topbar, inside the viewport, minus the window margin. Windows stay over
 * the chat: they never cover their own topbar toggle or a docked sidebar, and follow the chat area
 * when a sidebar opens or the browser resizes.
 */
export function readFloatingWindowBounds(): WindowBounds {
  if (typeof window === "undefined") return { left: 0, top: 0, right: 1024, bottom: 768 };
  const topbar = document.querySelector<HTMLElement>('[data-component="TopBar"]');
  const area = document.querySelector<HTMLElement>(CENTER_CONTENT_SELECTOR)?.getBoundingClientRect();
  return {
    left: Math.max(0, area?.left ?? 0) + WINDOW_MARGIN_PX,
    top: Math.max(0, topbar?.getBoundingClientRect().bottom ?? 0, area?.top ?? 0) + WINDOW_MARGIN_PX,
    right: Math.min(window.innerWidth, area?.right ?? window.innerWidth) - WINDOW_MARGIN_PX,
    bottom: Math.min(window.innerHeight, area?.bottom ?? window.innerHeight) - WINDOW_MARGIN_PX,
  };
}

function sameGeometry(left: WindowGeometry, right: WindowGeometry) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

type BubbleDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  start: WindowPoint;
  moved: boolean;
  /** The other bubbles on screen, measured once when the drag starts. */
  others: { x: number; y: number; width: number; height: number }[];
};

type PointerSession = {
  pointerId: number;
  startX: number;
  startY: number;
  start: WindowGeometry;
  edge: ResizeEdge | null;
};

export function FloatingWindow({
  id,
  title,
  titleIcon,
  titleAccessory,
  closeLabel,
  getDefaultLayout,
  defaultLayoutKey,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  presentation = "window",
  autoFocus = true,
  hidden = false,
  drawerHost,
  minimizable,
  className,
  sheetClassName,
  sheetStyle,
  headerClassName,
  titleClassName,
  bodyClassName,
  bodyRef,
  rootAttributes,
  ignoreOutsidePointer,
  onRequestClose,
  onDragMove,
  children,
}: FloatingWindowProps) {
  const { t } = useTranslation();
  const titleId = `mari-window-title-${useId().replace(/:/gu, "")}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sheet = presentation === "sheet";
  const savedLayout = useFloatingWindowStore((state) => state.layouts[id]);
  const resetRevision = useFloatingWindowStore((state) => state.resetRevision);
  const stackIndex = useFloatingWindowStore((state) => state.stack.indexOf(id));
  const saveLayout = useFloatingWindowStore((state) => state.saveLayout);
  const bringToFront = useFloatingWindowStore((state) => state.bringToFront);
  const [bounds, setBounds] = useState(readFloatingWindowBounds);
  const [liveGeometry, setLiveGeometry] = useState<WindowGeometry | null>(null);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const frameRef = useRef(0);
  const restoreFocusOnUnmountRef = useRef(false);
  const getDefaultLayoutRef = useRef(getDefaultLayout);
  getDefaultLayoutRef.current = getDefaultLayout;
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;
  const ignoreOutsidePointerRef = useRef(ignoreOutsidePointer);
  ignoreOutsidePointerRef.current = ignoreOutsidePointer;
  const onDragMoveRef = useRef(onDragMove);
  onDragMoveRef.current = onDragMove;
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  const bubbleDragRef = useRef<BubbleDrag | null>(null);
  const bubbleFrameRef = useRef(0);
  const suppressBubbleClickRef = useRef(false);
  const focusBubbleRef = useRef(false);
  const [liveBubble, setLiveBubble] = useState<{ point: WindowPoint; guides: SnapGuide[] } | null>(null);

  const limits = useMemo(() => ({ minWidth, minHeight }), [minHeight, minWidth]);
  // Phones show every drawer in place, so a sheet hosts none.
  const hostTitle = sheet ? undefined : drawerHost?.title;
  const hostScrollClassName = drawerHost?.scrollClassName;
  const drawerHostValue = useMemo<DrawerHost | null>(
    () =>
      hostTitle === undefined
        ? null
        : {
            id,
            title: hostTitle,
            windowClassName: className,
            headerClassName,
            titleClassName,
            scrollClassName: hostScrollClassName,
            rootAttributes,
            ignoreOutsidePointer,
          },
    [
      className,
      headerClassName,
      hostScrollClassName,
      hostTitle,
      id,
      ignoreOutsidePointer,
      rootAttributes,
      titleClassName,
    ],
  );
  // Bumped after a defaultLayoutKey change has rendered, so the default reads the updated page.
  const [defaultRevision, setDefaultRevision] = useState(0);
  const defaultLayoutKeyRef = useRef(defaultLayoutKey);
  useEffect(() => {
    if (defaultLayoutKeyRef.current === defaultLayoutKey) return;
    defaultLayoutKeyRef.current = defaultLayoutKey;
    setDefaultRevision((revision) => revision + 1);
  }, [defaultLayoutKey]);
  // The default follows the viewport and Reset View until the user changes the window.
  const defaultLayout = useMemo(
    () => getDefaultLayoutRef.current(bounds),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the revisions recompute the default on purpose
    [bounds, resetRevision, defaultRevision],
  );
  const layout = savedLayout ?? defaultLayout;
  const pinned = !sheet && layout.pinned;
  const locked = !sheet && layout.locked;
  const geometry = clampWindowGeometry(liveGeometry ?? layout, bounds, limits);
  const canMinimize = !!minimizable && !sheet;
  const minimized = canMinimize && layout.minimized === true;
  const bubblePoint = clampWindowBubble(
    liveBubble?.point ??
      layout.bubble ??
      defaultLayout.bubble ?? { x: bounds.right - WINDOW_BUBBLE_SIZE_PX, y: bounds.top },
    bounds,
  );

  // Re-clamp whenever the viewport or the chat area changes, so a window can never be lost off-screen.
  useEffect(() => {
    if (sheet) return;
    const update = () =>
      setBounds((current) => {
        const next = readFloatingWindowBounds();
        return current.left === next.left &&
          current.top === next.top &&
          current.right === next.right &&
          current.bottom === next.bottom
          ? current
          : next;
      });
    update();
    window.addEventListener("resize", update);
    const area = document.querySelector(CENTER_CONTENT_SELECTOR);
    const observer = area && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (area) observer?.observe(area);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [sheet]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const minimizeRef = useRef<(focusBubble: boolean) => void>(() => {});
  minimizeRef.current = (focusBubble) => {
    restoreFocusOnUnmountRef.current = false;
    focusBubbleRef.current = focusBubble;
    saveLayout(id, { ...layoutRef.current, minimized: true });
    useFloatingWindowStore.getState().closeWindow(id);
  };

  const requestClose = useCallback(
    (reason: FloatingWindowCloseReason) => {
      // A minimizable window goes back to its bubble; focus follows it unless the user pressed elsewhere.
      if (canMinimize) {
        minimizeRef.current(reason !== "outside-pointer");
        return;
      }
      restoreFocusOnUnmountRef.current = reason !== "outside-pointer";
      const result = onRequestCloseRef.current?.(reason);
      void result?.then((closed) => {
        // A guard kept the window open, so a later unmount must not move focus.
        if (!closed) restoreFocusOnUnmountRef.current = false;
      });
    },
    [canMinimize],
  );

  // An unpinned window opens next to its bubble; a pinned or locked one where it was left.
  const restoreFromBubble = () => {
    const current = layoutRef.current;
    const placed =
      current.pinned || current.locked ? current : placeWindowBesideBubble(current, bubblePoint, bounds, limits);
    saveLayout(id, { ...current, ...placed, minimized: false });
    useFloatingWindowStore.getState().openWindow(id, bubbleRef.current);
  };

  // Focus moves into the window when it opens and back to its opener when it closes. A remount (a
  // chat switch, or the loading placeholder giving way) only takes focus if nothing else has it.
  // Hiding and showing a kept-mounted window count as closing and opening it.
  useEffect(() => {
    if (hidden || minimized) return;
    restoreFocusOnUnmountRef.current = false;
    const requested = takeFloatingWindowFocusRequest(id);
    const focusIsFree = !document.activeElement || document.activeElement === document.body;
    if (!sheet && (requested || (autoFocus && focusIsFree))) rootRef.current?.focus({ preventScroll: true });
    return () => {
      // A placeholder swapped for the real window unmounts without a close request and keeps the opener.
      if (!restoreFocusOnUnmountRef.current) return;
      const fallback = document.querySelector<HTMLElement>(`[data-window-opener="${id}"]`);
      const target =
        takeFloatingWindowOpener(id) ?? (fallback && fallback.getClientRects().length > 0 ? fallback : null);
      target?.focus({ preventScroll: true });
    };
    // Mount and unmount only; switching presentation keeps focus where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hidden, minimized]);

  // A restored minimizable window stacks with the others; a minimized one hands focus to its bubble.
  useEffect(() => {
    if (!canMinimize || hidden) return;
    if (!minimized) {
      if (!useFloatingWindowStore.getState().stack.includes(id)) {
        useFloatingWindowStore.getState().openWindow(id, null, { focus: false });
      }
      return;
    }
    if (!focusBubbleRef.current) return;
    focusBubbleRef.current = false;
    bubbleRef.current?.focus({ preventScroll: true });
  }, [canMinimize, hidden, id, minimized]);

  // An unpinned window closes when the user presses anywhere else.
  useEffect(() => {
    if (pinned || hidden || minimized) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target)) return;
      // The window's own toggle closes it on click; closing here too would let that click reopen it.
      if (target.closest(`[data-window-opener="${id}"]`)) return;
      if (target.closest(".mari-window, [data-chat-help-overlay], [role='dialog'][aria-modal='true']")) return;
      if (ignoreOutsidePointerRef.current?.(target)) return;
      requestClose("outside-pointer");
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [id, pinned, hidden, minimized, requestClose]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      cancelAnimationFrame(bubbleFrameRef.current);
    },
    [],
  );

  // Drag and keyboard pass geometry that is already clamped. Pin and lock keep the saved geometry, so a
  // window squeezed by a small viewport still returns to its place when the viewport grows again.
  const commitLayout = useCallback(
    (patch: Partial<WindowLayout>) => saveLayout(id, { ...layout, ...patch }),
    [id, layout, saveLayout],
  );

  const beginPointerSession = (event: ReactPointerEvent<HTMLElement>, edge: ResizeEdge | null) => {
    if (sheet || locked || event.button !== 0 || pointerSessionRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: geometry,
      edge,
    };
  };

  const updatePointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const next = session.edge
      ? resizeWindowGeometry(session.start, session.edge, dx, dy, bounds, limits)
      : moveWindowGeometry(session.start, dx, dy, bounds, limits);
    if (!session.edge) onDragMoveRef.current?.({ x: event.clientX, y: event.clientY }, "move");
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => setLiveGeometry(next));
  };

  const endPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    pointerSessionRef.current = null;
    cancelAnimationFrame(frameRef.current);
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const next = session.edge
      ? resizeWindowGeometry(session.start, session.edge, dx, dy, bounds, limits)
      : moveWindowGeometry(session.start, dx, dy, bounds, limits);
    setLiveGeometry(null);
    if (!session.edge && onDragMoveRef.current?.({ x: event.clientX, y: event.clientY }, "end") === true) return;
    if (!sameGeometry(next, session.start)) commitLayout(next);
  };

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(NO_DRAG_SELECTOR)) return;
    beginPointerSession(event, null);
  };

  const readArrowDelta = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? WINDOW_KEYBOARD_LARGE_STEP_PX : WINDOW_KEYBOARD_STEP_PX;
    if (event.key === "ArrowLeft") return { dx: -step, dy: 0 };
    if (event.key === "ArrowRight") return { dx: step, dy: 0 };
    if (event.key === "ArrowUp") return { dx: 0, dy: -step };
    if (event.key === "ArrowDown") return { dx: 0, dy: step };
    return null;
  };

  const handleHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || locked || sheet) return;
    const delta = readArrowDelta(event);
    if (!delta) return;
    // Handled keys stop here, so chat-wide arrow shortcuts (swipes, history) skip them.
    event.preventDefault();
    commitLayout(moveWindowGeometry(geometry, delta.dx, delta.dy, bounds, limits));
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (locked || sheet) return;
    const delta = readArrowDelta(event);
    if (!delta) return;
    event.preventDefault();
    commitLayout(resizeWindowGeometry(geometry, "se", delta.dx, delta.dy, bounds, limits));
  };

  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target;
    // Portalled dialogs bubble through this component in React; only presses inside the window count.
    if (!(target instanceof Element) || !rootRef.current?.contains(target)) return;
    if (pinned || target.closest(KEEPS_ESCAPE_SELECTOR) || isModalOverlayOpen()) return;
    // Menus inside the window close on Escape through document listeners, which run after this one.
    // Wait until the press has reached them all, and close only if none of them claimed it.
    const pressed = event.nativeEvent;
    window.setTimeout(() => {
      if (!pressed.defaultPrevented) requestClose("escape");
    }, 0);
  };

  // ── Bubble: a minimized window's button, dragged anywhere and snapped into line with the others ──
  const commitBubble = (point: WindowPoint) => saveLayout(id, { ...layoutRef.current, bubble: point });

  const handleBubblePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || bubbleDragRef.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const others = Array.from(document.querySelectorAll<HTMLElement>(".mari-window-bubble"))
      .filter((element) => element !== event.currentTarget && element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      });
    bubbleDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: bubblePoint,
      moved: false,
      others,
    };
  };

  /** Where the bubble lands for this pointer position; Alt places it freely, without snapping. */
  const readBubbleDrop = (drag: BubbleDrag, event: ReactPointerEvent<HTMLButtonElement>) => {
    const raw = clampWindowBubble(
      { x: drag.start.x + event.clientX - drag.startX, y: drag.start.y + event.clientY - drag.startY },
      bounds,
    );
    if (event.altKey) return { point: raw, guides: [] };
    const size = bubbleRef.current?.getBoundingClientRect();
    const snapped = snapBubble(
      { ...raw, width: size?.width ?? WINDOW_BUBBLE_SIZE_PX, height: size?.height ?? WINDOW_BUBBLE_SIZE_PX },
      drag.others,
    );
    return { point: clampWindowBubble(snapped, bounds), guides: snapped.guides };
  };

  const handleBubblePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.moved && distance < BUBBLE_DRAG_START_PX) return;
    drag.moved = true;
    const next = readBubbleDrop(drag, event);
    cancelAnimationFrame(bubbleFrameRef.current);
    bubbleFrameRef.current = requestAnimationFrame(() => setLiveBubble(next));
  };

  const handleBubblePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    bubbleDragRef.current = null;
    cancelAnimationFrame(bubbleFrameRef.current);
    setLiveBubble(null);
    if (!drag.moved || event.type === "pointercancel") return;
    // The click that ends a drag must not open the window too.
    suppressBubbleClickRef.current = true;
    commitBubble(readBubbleDrop(drag, event).point);
  };

  const handleBubbleClick = () => {
    if (suppressBubbleClickRef.current) {
      suppressBubbleClickRef.current = false;
      return;
    }
    restoreFromBubble();
  };

  // Arrow keys move the bubble like the window's title bar (no snapping); Enter and Space open it.
  const handleBubbleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = readArrowDelta(event);
    if (!delta) return;
    event.preventDefault();
    commitBubble(clampWindowBubble({ x: bubblePoint.x + delta.dx, y: bubblePoint.y + delta.dy }, bounds));
  };

  if (minimized && minimizable && !hidden) {
    return (
      <>
        <button
          ref={bubbleRef}
          type="button"
          data-window={id}
          data-minimized="true"
          data-dragging={liveBubble ? "true" : undefined}
          {...rootAttributes}
          className="mari-window-bubble fixed"
          style={{ left: bubblePoint.x, top: bubblePoint.y, zIndex: FLOATING_WINDOW_Z_BASE }}
          aria-label={t("window.bubble.label", { title: minimizable.label })}
          title={t("window.bubble.hint", { title: minimizable.label })}
          onPointerDown={handleBubblePointerDown}
          onPointerMove={handleBubblePointerMove}
          onPointerUp={handleBubblePointerUp}
          onPointerCancel={handleBubblePointerUp}
          onClick={handleBubbleClick}
          onKeyDown={handleBubbleKeyDown}
        >
          {minimizable.icon}
        </button>
        {liveBubble?.guides.map((guide) => (
          <div
            key={`${guide.axis}:${guide.at}`}
            aria-hidden="true"
            data-axis={guide.axis}
            className="mari-window-snap-guide"
            style={
              guide.axis === "x"
                ? {
                    left: guide.at,
                    top: guide.from,
                    width: 1,
                    height: guide.to - guide.from,
                    zIndex: FLOATING_WINDOW_Z_BASE,
                  }
                : {
                    left: guide.from,
                    top: guide.at,
                    width: guide.to - guide.from,
                    height: 1,
                    zIndex: FLOATING_WINDOW_Z_BASE,
                  }
            }
          />
        ))}
      </>
    );
  }

  const rootStyle: CSSProperties | undefined = sheet
    ? sheetStyle
    : {
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: FLOATING_WINDOW_Z_BASE + Math.max(0, stackIndex),
      };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      hidden={hidden}
      data-window={id}
      data-pinned={pinned ? "true" : "false"}
      data-locked={locked ? "true" : "false"}
      data-detached="false"
      data-presentation={presentation}
      data-no-intuitive-swipe
      {...rootAttributes}
      className={cn("mari-window flex min-h-0 flex-col outline-none", className, sheet ? sheetClassName : "fixed")}
      style={rootStyle}
      onPointerDownCapture={() => bringToFront(id)}
      onFocusCapture={() => bringToFront(id)}
      onKeyDown={handleRootKeyDown}
    >
      <div
        className={cn(
          "mari-window__header flex shrink-0 items-center justify-between gap-2",
          !sheet && !locked && "cursor-grab touch-none select-none active:cursor-grabbing",
          headerClassName,
        )}
        role={sheet || locked ? undefined : "group"}
        tabIndex={sheet || locked ? undefined : 0}
        aria-label={sheet || locked ? undefined : t("window.controls.move")}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={updatePointerSession}
        onPointerUp={endPointerSession}
        onPointerCancel={endPointerSession}
        onKeyDown={handleHeaderKeyDown}
      >
        <span className="mari-window__title-row flex min-w-0 items-center gap-1.5">
          {titleIcon}
          <h2 id={titleId} className={cn("mari-window__title truncate", titleClassName)}>
            {title}
          </h2>
          {titleAccessory}
        </span>
        <div className="mari-window__controls flex shrink-0 items-center">
          {canMinimize && (
            <button
              type="button"
              data-window-control="minimize"
              aria-label={t("window.controls.minimize")}
              title={t("window.controls.minimizeHint")}
              className="mari-window__control"
              onClick={() => minimizeRef.current(true)}
            >
              <Minus size="0.875rem" />
            </button>
          )}
          {!sheet && (
            <>
              <button
                type="button"
                data-window-control="pin"
                aria-pressed={pinned}
                aria-label={t("window.controls.pin")}
                title={t(pinned ? "window.controls.unpinHint" : "window.controls.pinHint")}
                className="mari-window__control"
                onClick={() => commitLayout({ pinned: !pinned })}
              >
                <Pin size="0.875rem" fill={pinned ? "currentColor" : "none"} />
              </button>
              <button
                type="button"
                data-window-control="lock"
                aria-pressed={locked}
                aria-label={t("window.controls.lock")}
                title={t(locked ? "window.controls.unlockHint" : "window.controls.lockHint")}
                className="mari-window__control"
                onClick={() => commitLayout({ locked: !locked })}
              >
                {locked ? <Lock size="0.875rem" /> : <Unlock size="0.875rem" />}
              </button>
            </>
          )}
          <button
            type="button"
            data-window-control="close"
            aria-label={closeLabel}
            title={closeLabel}
            className="mari-window__control"
            onClick={() => requestClose("close-button")}
          >
            <X size="1rem" />
          </button>
        </div>
      </div>
      <div ref={bodyRef} className={cn("mari-window__body flex min-h-0 flex-1 flex-col", bodyClassName)}>
        {drawerHost ? (
          <DrawerHostContext.Provider value={drawerHostValue}>{children}</DrawerHostContext.Provider>
        ) : (
          children
        )}
      </div>
      {!sheet &&
        !locked &&
        RESIZE_EDGES.map((edge) =>
          edge === "se" ? (
            <button
              key={edge}
              type="button"
              data-edge={edge}
              aria-label={t("window.controls.resize")}
              className="mari-window__resize-handle"
              onPointerDown={(event) => beginPointerSession(event, edge)}
              onPointerMove={updatePointerSession}
              onPointerUp={endPointerSession}
              onPointerCancel={endPointerSession}
              onKeyDown={handleResizeKeyDown}
            />
          ) : (
            <div
              key={edge}
              data-edge={edge}
              aria-hidden="true"
              className="mari-window__resize-handle"
              onPointerDown={(event) => beginPointerSession(event, edge)}
              onPointerMove={updatePointerSession}
              onPointerUp={endPointerSession}
              onPointerCancel={endPointerSession}
            />
          ),
        )}
    </div>
  );
}
