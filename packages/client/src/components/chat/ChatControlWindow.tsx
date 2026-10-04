// ──────────────────────────────────────────────
// Chat control windows: the chat's top controls as minimizable windows
//
// Game's Session, Volume, Assets and Game controls, the connected chat, package
// toolbars and Beholder each open in a small window that minimizes to a button (its
// bubble). They start minimized: on a computer the bubbles sit in a row at the chat's
// top right where the buttons used to be; on a phone in a column at the right edge,
// where its menu was, and each opens as a sheet.
// ──────────────────────────────────────────────
import type { ReactNode } from "react";
import { ArrowRightLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FloatingWindow, PHONE_FULL_SHEET_CLASS, PHONE_SHEET_CLASS } from "../ui/FloatingWindow";
import { NEUTRAL_PANEL_SCROLL_AREA, NEUTRAL_SURFACE_VARIABLES } from "../ui/neutral-surface-styles";
import { useMatchMedia } from "../../hooks/use-match-media";
import {
  WINDOW_BUBBLE_SIZE_PX,
  getPhoneBubbleSlot,
  placeWindowBesideBubble,
  type WindowBounds,
  type WindowLayout,
} from "../../lib/floating-window-layout";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui.store";
import { readChatWindowArea, readCssPixels } from "./chat-settings-window";

/** Room between bubbles in their default row, like the old toolbar's button gap. */
const BUBBLE_ROW_GAP_PX = 4;
const TRACKER_CLEARANCE_VARIABLE = "--tracker-panel-overlay-clearance";

/** Each control window's id; Game's ids are only used in Game chats. */
export const CHAT_CONTROL_WINDOW_IDS = {
  connectedChat: "control:connected-chat",
  beholder: (packageId: string) => `control:beholder:${packageId}`,
  gameControls: "control:game",
  session: "control:session",
  volume: "control:volume",
  assets: "control:assets",
  package: (packageId: string) => `control:package:${packageId}`,
} as const;

/**
 * Bubbles start in a row at the chat's top right, where its buttons were: `slot` 0 is the rightmost.
 * Their windows open below them. Both start minimized, unpinned and unlocked.
 */
export function getChatControlDefaultLayout(
  bounds: WindowBounds,
  slot: number,
  size: { width: number; height: number },
): WindowLayout {
  const area = readChatWindowArea(bounds);
  // A right-side Tracker Panel floats over the chat; keep the bubbles clear of it.
  const trackerClearance =
    area.chatRoot && useUIStore.getState().trackerPanelSide === "right"
      ? readCssPixels(area.chatRoot, TRACKER_CLEARANCE_VARIABLE)
      : 0;
  const right = Math.min(bounds.right - trackerClearance, area.right);
  const bubble = {
    x: right - WINDOW_BUBBLE_SIZE_PX - slot * (WINDOW_BUBBLE_SIZE_PX + BUBBLE_ROW_GAP_PX),
    y: bounds.top,
  };
  const geometry = placeWindowBesideBubble(size, bubble, bounds, { minWidth: 1, minHeight: 1 });
  return { ...geometry, pinned: false, locked: false, minimized: true, bubble };
}

/** Presses on popovers and dialogs the window's content opens (they render in portals) stay inside. */
function ignoreControlWindowOutsidePointer(target: Element) {
  return !!target.closest("[data-chat-floating-panel], [data-macro-modal]");
}

export interface ChatControlWindowProps {
  id: string;
  title: string;
  icon: ReactNode;
  /** Its bubble's place in the default row, counted from the right. */
  slot: number;
  /** Its bubble's place in the phone column, counted from the top (`slot` otherwise). */
  phoneSlot?: number;
  /** The window's size when it first opens. */
  width: number;
  height: number;
  /** The Help layout target its bubble (and window) stand for. */
  helpTarget?: string;
  /** Wraps the content in a scroll area; off for content that scrolls itself (it then fills a phone's screen). */
  scroll?: boolean;
  /** Drawn on the bubble (a status dot, say). */
  bubbleBadge?: ReactNode;
  children: ReactNode;
}

/** A chat control as a minimizable window (a bubble and a sheet on phones). */
export function ChatControlWindow({
  id,
  title,
  icon,
  slot,
  phoneSlot = slot,
  width,
  height,
  helpTarget,
  scroll = true,
  bubbleBadge,
  children,
}: ChatControlWindowProps) {
  const { t } = useTranslation();
  const phoneLayout = useMatchMedia("(max-width: 767px)");
  return (
    <FloatingWindow
      id={id}
      title={title}
      titleIcon={
        <span className="flex shrink-0 text-[var(--muted-foreground)] [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
      }
      closeLabel={t("window.controls.close")}
      presentation={phoneLayout ? "sheet" : "window"}
      sheetClassName={cn(PHONE_SHEET_CLASS, !scroll && PHONE_FULL_SHEET_CLASS)}
      minimizable={{
        icon,
        label: title,
        getPhoneBubble: (bounds) => getPhoneBubbleSlot(bounds, phoneSlot),
        bubbleBadge,
      }}
      getDefaultLayout={(bounds) => getChatControlDefaultLayout(bounds, slot, { width, height })}
      minWidth={200}
      minHeight={96}
      autoFocus={false}
      className={cn("marinara-chat-popover", NEUTRAL_SURFACE_VARIABLES)}
      headerClassName="marinara-chat-popover__header"
      titleClassName="marinara-chat-popover__title text-xs font-semibold leading-tight"
      rootAttributes={{ "data-chat-help": helpTarget, "data-chat-control-window": id }}
      ignoreOutsidePointer={ignoreControlWindowOutsidePointer}
    >
      {scroll ? (
        <div className={cn(NEUTRAL_PANEL_SCROLL_AREA, "@container min-h-0 flex-1 overflow-y-auto overscroll-contain")}>
          {children}
        </div>
      ) : (
        children
      )}
    </FloatingWindow>
  );
}

/** The connected chat control (every mode): its window offers the switch to the other chat. */
export function ChatConnectedChatWindow({
  name,
  onSwitch,
  phoneSlot,
}: {
  name?: string | null;
  onSwitch: () => void;
  phoneSlot?: number;
}) {
  const { t } = useTranslation();
  const label = name ? t("chat.toolbar.switchTo", { name }) : t("chat.toolbar.switchToConnected");
  return (
    <ChatControlWindow
      id={CHAT_CONTROL_WINDOW_IDS.connectedChat}
      title={t("chat.toolbar.connectedChat")}
      icon={<ArrowRightLeft size={14} />}
      slot={0}
      phoneSlot={phoneSlot}
      width={260}
      height={120}
      helpTarget="connected-chat"
    >
      <div className="p-2">
        <button
          type="button"
          onClick={onSwitch}
          className="mari-chrome-control flex w-full min-w-0 items-center gap-2 px-3 py-2 text-xs"
        >
          <ArrowRightLeft size="0.8125rem" className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </div>
    </ChatControlWindow>
  );
}
