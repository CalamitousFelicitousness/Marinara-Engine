// ──────────────────────────────────────────────
// Desktop Tracker Panel window
//
// The panel on a computer is a floating window like Chat Settings: moved by its
// title bar, resized from any edge, and pinned so a press in the chat leaves it
// open. Its bubble is TrackerPanelBubble. The window's width is the panel's
// width setting, which picks the size profile its sections lay out by.
// ──────────────────────────────────────────────
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FloatingWindow } from "../../../components/ui/FloatingWindow";
import { TrackerPanelIcon } from "../../../components/ui/TrackerPanelIcon";
import { readChatWindowArea } from "../../../components/chat/chat-settings-window";
import { WINDOW_MARGIN_PX, type WindowBounds, type WindowLayout } from "../../../lib/floating-window-layout";
import { clampTrackerPanelWidth, TRACKER_PANEL_WIDTH_MIN } from "../../../lib/tracker-panel-size";
import { closeTrackerPanel } from "../../../lib/tracker-panel-surface";
import { TRACKER_PANEL_BUBBLE_ID, useFloatingWindowStore } from "../../../stores/floating-window.store";
import { useUIStore } from "../../../stores/ui.store";

// How far below the chat's top a bubble still counts as part of its top row.
const TOP_ROW_DEPTH_PX = 80;

/** Full height on the panel's side, below the chat's top controls and the bubbles beside them. */
export function getTrackerPanelDefaultLayout(bounds: WindowBounds): WindowLayout {
  const { trackerPanelSide, trackerPanelWidth } = useUIStore.getState();
  const area = readChatWindowArea(bounds);
  const bubblesBottom = Math.max(
    0,
    ...Array.from(document.querySelectorAll<HTMLElement>(".mari-window-bubble"))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 1 && rect.height > 1 && rect.top < bounds.top + TOP_ROW_DEPTH_PX)
      .map((rect) => rect.bottom + WINDOW_MARGIN_PX),
  );
  const top = Math.max(area.top, bubblesBottom);
  const width = Math.min(trackerPanelWidth, area.right - area.left);
  return {
    x: trackerPanelSide === "left" ? area.left : area.right - width,
    y: top,
    width,
    height: Math.max(0, area.bottom - top),
    pinned: true,
    locked: false,
  };
}

/** Portalled tracker popovers and dialogs are not presses outside the window. */
function ignoreTrackerPanelOutsidePointer(target: Element) {
  return !!target.closest("[data-chat-floating-panel], [data-macro-modal]");
}

/**
 * Keeps the window's width and the width setting together. A resized window writes the setting; a
 * preset (Settings, or the header's size button) resizes a window the user has already placed.
 */
function useTrackerPanelWidthSync() {
  const savedWidth = useFloatingWindowStore((state) => state.layouts[TRACKER_PANEL_BUBBLE_ID]?.width);
  const width = useUIStore((state) => state.trackerPanelWidth);
  const previousWidthRef = useRef(width);
  const mirroredWidthRef = useRef<number | null>(null);

  useEffect(() => {
    if (savedWidth === undefined) return;
    const mirrored = clampTrackerPanelWidth(savedWidth);
    mirroredWidthRef.current = mirrored;
    if (useUIStore.getState().trackerPanelWidth !== mirrored) useUIStore.getState().setTrackerPanelWidth(mirrored);
  }, [savedWidth]);

  useEffect(() => {
    if (previousWidthRef.current === width) return;
    previousWidthRef.current = width;
    // The setting changed because the window did: nothing to push back.
    if (mirroredWidthRef.current === width) return;
    const windows = useFloatingWindowStore.getState();
    const layout = windows.layouts[TRACKER_PANEL_BUBBLE_ID];
    if (layout) windows.saveLayout(TRACKER_PANEL_BUBBLE_ID, { ...layout, width });
  }, [width]);
}

export function TrackerPanelWindow({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const side = useUIStore((state) => state.trackerPanelSide);
  const width = useUIStore((state) => state.trackerPanelWidth);
  useTrackerPanelWidthSync();

  return (
    <FloatingWindow
      id={TRACKER_PANEL_BUBBLE_ID}
      title={t("chat.trackerWindow.title")}
      titleIcon={<TrackerPanelIcon size="0.8125rem" className="shrink-0 text-[var(--muted-foreground)]" />}
      closeLabel={t("chat.trackerWindow.close")}
      getDefaultLayout={getTrackerPanelDefaultLayout}
      // An unplaced window follows the side and width settings.
      defaultLayoutKey={`${side}:${width}`}
      minWidth={TRACKER_PANEL_WIDTH_MIN}
      minHeight={160}
      autoFocus={false}
      // The panel's accent ring, which follows the app's accent animation, as on the phone sheet.
      className="marinara-chat-popover mari-tracker-panel shadow-2xl ring-1 ring-[var(--marinara-app-accent-solid)]"
      headerClassName="marinara-chat-popover__header"
      titleClassName="marinara-chat-popover__title text-xs font-semibold leading-tight"
      // The side is where an unplaced window opens; specs find the panel by it.
      rootAttributes={{ "data-component": `TrackerDataSidebarDesktop.${side}` }}
      ignoreOutsidePointer={ignoreTrackerPanelOutsidePointer}
      onRequestClose={() => closeTrackerPanel()}
    >
      {children}
    </FloatingWindow>
  );
}
