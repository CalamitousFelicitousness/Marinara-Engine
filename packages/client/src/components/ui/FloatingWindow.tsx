// ──────────────────────────────────────────────
// Shared floating window: move, resize, pin, lock, close
//
// Every chat window (Chat Settings now; popped-out drawers and tracker windows
// later) renders through this component so they behave and theme alike. Custom
// themes style the stable `mari-window…` classes, the data attributes and the
// `--mari-window-*` variables documented in globals.css.
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
import { Lock, Pin, Unlock, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
  RESIZE_EDGES,
  WINDOW_KEYBOARD_LARGE_STEP_PX,
  WINDOW_KEYBOARD_STEP_PX,
  WINDOW_MARGIN_PX,
  clampWindowGeometry,
  moveWindowGeometry,
  resizeWindowGeometry,
  type FloatingWindowId,
  type ResizeEdge,
  type WindowBounds,
  type WindowGeometry,
  type WindowLayout,
} from "../../lib/floating-window-layout";
import { isModalOverlayOpen } from "../../lib/modal-overlay-registry";
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
  /** May resolve to `false` when a guard keeps the window open; focus then stays where it is. */
  onRequestClose: (reason: FloatingWindowCloseReason) => void | Promise<boolean>;
  children: ReactNode;
}

const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 240;
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

  const limits = useMemo(() => ({ minWidth, minHeight }), [minHeight, minWidth]);
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

  const requestClose = useCallback((reason: FloatingWindowCloseReason) => {
    restoreFocusOnUnmountRef.current = reason !== "outside-pointer";
    const result = onRequestCloseRef.current(reason);
    void result?.then((closed) => {
      // A guard kept the window open, so a later unmount must not move focus.
      if (!closed) restoreFocusOnUnmountRef.current = false;
    });
  }, []);

  // Focus moves into the window when it opens and back to its opener when it closes. A remount (a
  // chat switch, or the loading placeholder giving way) only takes focus if nothing else has it.
  useEffect(() => {
    const requested = takeFloatingWindowFocusRequest(id);
    const focusIsFree = !document.activeElement || document.activeElement === document.body;
    if (!sheet && (requested || focusIsFree)) rootRef.current?.focus({ preventScroll: true });
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
  }, [id]);

  // An unpinned window closes when the user presses anywhere else.
  useEffect(() => {
    if (pinned) return;
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
  }, [id, pinned, requestClose]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

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
    event.preventDefault();
    requestClose("escape");
  };

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
        {children}
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
