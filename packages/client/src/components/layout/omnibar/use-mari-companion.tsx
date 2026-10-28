import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMatchMedia } from "../../../hooks/use-match-media";
import {
  MARI_COMPANION_WIDTH_MAX_REM,
  MARI_COMPANION_WIDTH_MIN_REM,
  normalizeMariCompanionWidthRem,
  useUIStore,
} from "../../../stores/ui.store";

const GAP_PX = 12;
/** The editor's field column keeps at least this much room; the panel stops growing first. */
const MIN_COLUMN_REM = 28;

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
const halfRem = (value: number) => Math.floor(value * 2) / 2;

/**
 * Prof. Mari's desktop companion: while an editor that opts in (`useMariCompanionEditor`) is open
 * and its shell has room for her panel plus a sane field column, her window becomes a solid panel
 * fixed at the left, 12px below the editor header bar. Only the editor's field column moves right,
 * as far as needed: shift = max(0, panelRight + gap - columnLeft); when room runs out it narrows.
 * `available` shows the dock toggle; `active` is the companion layout itself.
 */
export function useMariCompanion(mariSurface: boolean, panelRef: RefObject<HTMLElement | null>) {
  const desktop = useMatchMedia("(min-width: 1024px)");
  const root = useUIStore((s) => s.mariCompanionRoot);
  const docked = useUIStore((s) => s.mariCompanionDocked);
  const savedRem = useUIStore((s) => s.mariCompanionWidthRem);
  // Largest panel width the shell can draw; below the minimum the companion does not fit.
  const [maxRem, setMaxRem] = useState(MARI_COMPANION_WIDTH_MAX_REM);
  const available = mariSurface && desktop && root !== null && maxRem >= MARI_COMPANION_WIDTH_MIN_REM;
  const active = available && docked;
  const drawnRem = Math.max(MARI_COMPANION_WIDTH_MIN_REM, Math.min(savedRem, maxRem));

  // A drag previews its width here and only saves on release.
  const widthRef = useRef(savedRem);
  const placeRef = useRef(() => {});
  useLayoutEffect(() => {
    widthRef.current = savedRem;
    placeRef.current();
  }, [savedRem]);

  useLayoutEffect(() => {
    if (!root || !mariSurface || !desktop) return;
    const shell = root.closest<HTMLElement>(".mari-editor-shell") ?? root;
    const header = shell.querySelector<HTMLElement>(".mari-editor-header");
    const column = root.querySelector<HTMLElement>(":scope > .mari-editor-content-inner");
    // Static per editor; read once before any inline override.
    const columnMax = column ? parseFloat(getComputedStyle(column).maxWidth) || Infinity : Infinity;
    const rootStyle = getComputedStyle(root);
    const padLeft = parseFloat(rootStyle.paddingLeft);
    const padRight = parseFloat(rootStyle.paddingRight);

    const clearColumn = () => {
      if (!column) return;
      column.style.marginInlineStart = "";
      column.style.maxWidth = "";
    };

    const place = () => {
      const rem = remPx();
      const s = shell.getBoundingClientRect();
      const fit = halfRem(Math.min(MARI_COMPANION_WIDTH_MAX_REM, (s.width - 3 * GAP_PX) / rem - MIN_COLUMN_REM));
      setMaxRem(fit);
      const panel = panelRef.current;
      if (!active || !panel || fit < MARI_COMPANION_WIDTH_MIN_REM) return;
      const width = Math.max(MARI_COMPANION_WIDTH_MIN_REM, Math.min(widthRef.current, fit)) * rem;
      const top = (header?.getBoundingClientRect().bottom ?? s.top) + GAP_PX;
      // The column is centered by margin-inline: auto, so its natural left follows from the root's content box.
      const box = root.getBoundingClientRect();
      const contentLeft = box.left + root.clientLeft + padLeft;
      const contentWidth = root.clientWidth - padLeft - padRight;
      const columnWidth = Math.min(columnMax, contentWidth);
      const naturalLeft = contentLeft + (contentWidth - columnWidth) / 2;
      const shift = Math.max(0, Math.round(s.left + GAP_PX + width + GAP_PX - naturalLeft));

      panel.style.setProperty("--mari-companion-top", `${top}px`);
      panel.style.setProperty("--mari-companion-left", `${s.left + GAP_PX}px`);
      panel.style.setProperty(
        "--mari-companion-bottom",
        `${Math.max(GAP_PX, window.innerHeight - s.bottom + GAP_PX)}px`,
      );
      panel.style.setProperty("--mari-companion-width", `${width}px`);
      if (!column) return;
      if (!shift) return clearColumn();
      const left = naturalLeft + shift;
      column.style.marginInlineStart = `${left - contentLeft}px`;
      column.style.maxWidth = `${Math.max(0, Math.min(columnWidth, contentLeft + contentWidth - left))}px`;
    };

    placeRef.current = place;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(shell);
    observer.observe(root);
    return () => {
      observer.disconnect();
      placeRef.current = () => {};
      clearColumn();
    };
  }, [root, mariSurface, desktop, active, panelRef]);

  const preview = (rem: number) => {
    widthRef.current = normalizeMariCompanionWidthRem(rem);
    placeRef.current();
  };

  return { available, active, drawnRem, maxRem, preview };
}

/** Width handle on the panel's right edge (drag or arrow keys). The panel is never dragged. */
export function MariCompanionResizeHandle({
  panelRef,
  drawnRem,
  maxRem,
  preview,
}: {
  panelRef: RefObject<HTMLElement | null>;
  drawnRem: number;
  maxRem: number;
  preview: (rem: number) => void;
}) {
  const { t } = useTranslation();
  const setWidth = useUIStore((s) => s.setMariCompanionWidthRem);
  const clamp = (rem: number) => Math.max(MARI_COMPANION_WIDTH_MIN_REM, Math.min(maxRem, rem));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";
    const left = panel.getBoundingClientRect().left;
    let width = drawnRem;
    const onMove = (move: globalThis.PointerEvent) => {
      width = clamp((move.clientX - left) / remPx());
      preview(width);
    };
    const onUp = () => {
      delete handle.dataset.dragging;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setWidth(width);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    setWidth(clamp(drawnRem + step));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("omnibar.companion.resize", "Resize Professor Mari")}
      aria-valuemin={MARI_COMPANION_WIDTH_MIN_REM}
      aria-valuemax={Math.max(MARI_COMPANION_WIDTH_MIN_REM, maxRem)}
      aria-valuenow={drawnRem}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="mari-companion-resize"
    />
  );
}
