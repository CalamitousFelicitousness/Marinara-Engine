// ──────────────────────────────────────────────
// Chat Settings window: shared look and default placement
//
// Used by the Chat Settings window and by its loading placeholder, so both open
// in the same place and the placeholder does not jump when the panel arrives.
// ──────────────────────────────────────────────
import type { CSSProperties } from "react";
import { WINDOW_MARGIN_PX, type WindowBounds, type WindowLayout } from "../../lib/floating-window-layout";
import { cn } from "../../lib/utils";
import { NEUTRAL_SURFACE_VARIABLES } from "../ui/neutral-surface-styles";
import type { ChatToolbarFloatingPanelAnchor } from "./ChatToolbarControls";

const CHAT_SETTINGS_WINDOW_WIDTH_REM = 34;
const CHAT_SETTINGS_WINDOW_GAP_PX = 12;

function readCssPixels(element: Element, property: string) {
  const value = Number.parseFloat(window.getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

/** Today's panel width beside the right edge of the chat, between its top controls and its message box. */
export function getChatSettingsDefaultLayout(bounds: WindowBounds): WindowLayout {
  const remPx = readCssPixels(document.documentElement, "font-size") || 16;
  const chatRoot = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-mode]")).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  });
  const rootRect = chatRoot?.getBoundingClientRect();
  const right = Math.min(
    bounds.right,
    (rootRect?.right ?? bounds.right + WINDOW_MARGIN_PX) -
      (chatRoot ? readCssPixels(chatRoot, "--tracker-panel-hud-clear-right") : 0) -
      CHAT_SETTINGS_WINDOW_GAP_PX,
  );
  const topControlsBottom = Math.max(
    0,
    ...Array.from(chatRoot?.querySelectorAll("[data-chat-help]") ?? [])
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 1 && rect.height > 1 && rect.top < (rootRect?.top ?? 0) + 80)
      .map((rect) => rect.bottom),
  );
  const composer = chatRoot?.querySelector("[data-chat-composer]");
  const composerTop = (composer?.closest("[data-chat-resource-drop-exclude]") ?? composer)?.getBoundingClientRect().top;
  const top = Math.max(bounds.top, topControlsBottom ? topControlsBottom + WINDOW_MARGIN_PX : bounds.top + 48);
  const bottom = Math.min(bounds.bottom, composerTop ? composerTop - CHAT_SETTINGS_WINDOW_GAP_PX : bounds.bottom - 132);
  const width = Math.min(CHAT_SETTINGS_WINDOW_WIDTH_REM * remPx, right - bounds.left);
  return { x: right - width, y: top, width, height: bottom - top, pinned: false, locked: false };
}

/** Props both the window and its loading placeholder pass to <FloatingWindow>. */
export function getChatSettingsWindowProps(anchor: ChatToolbarFloatingPanelAnchor | undefined) {
  // On phones the sheet opens beside the toolbar menu it came from, as it always has.
  const sheetStyle: CSSProperties | undefined =
    anchor && typeof window !== "undefined" && window.innerWidth < 768
      ? {
          bottom: "auto",
          left: "auto",
          maxHeight: `min(42rem, calc(100dvh - ${anchor.top}px - 0.75rem - var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom))))`,
          right: `${anchor.right}px`,
          top: `${anchor.top}px`,
          width: `min(34rem, calc(100vw - ${anchor.right}px - 0.75rem))`,
        }
      : undefined;
  return {
    getDefaultLayout: getChatSettingsDefaultLayout,
    className: cn(
      "marinara-chat-popover mari-chat-settings-popover mari-chat-settings-drawer animate-message-in",
      NEUTRAL_SURFACE_VARIABLES,
    ),
    sheetClassName: cn(
      "fixed bottom-3 z-[70] w-[min(34rem,calc(100vw-var(--mari-chat-ui-inset-left,0px)-var(--mari-chat-ui-inset-right,0px)-1.5rem))] overflow-hidden max-md:inset-x-2 max-md:bottom-[calc(0.75rem+var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom)))] max-md:top-[calc(3.5rem+env(safe-area-inset-top))] max-md:w-auto",
      anchor ? "" : "right-[calc(var(--mari-chat-ui-inset-right,0px)+0.75rem)] top-14",
    ),
    sheetStyle,
    headerClassName: "marinara-chat-popover__header",
    titleClassName: "marinara-chat-popover__title text-xs font-semibold leading-tight",
    rootAttributes: { "data-chat-floating-panel": true } as Record<`data-${string}`, boolean>,
  };
}
