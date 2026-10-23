// ──────────────────────────────────────────────
// Branch graph window: every branch of a chat as a lane, joined where it forked
//
// Opened from the Chat Branches header (inline or popped out). The Chat Branches list stays the
// quick switcher; this is the bigger picture, in its own resizable window.
// ──────────────────────────────────────────────
import { GitGraph } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { FloatingWindow, PHONE_FULL_SHEET_CLASS, PHONE_SHEET_CLASS } from "../ui/FloatingWindow";
import { NEUTRAL_PANEL_SCROLL_AREA, NEUTRAL_SURFACE_VARIABLES } from "../ui/neutral-surface-styles";
import { useMatchMedia } from "../../hooks/use-match-media";
import type { WindowBounds, WindowLayout } from "../../lib/floating-window-layout";
import { cn } from "../../lib/utils";
import { useFloatingWindowStore } from "../../stores/floating-window.store";
import { readChatWindowArea, readCssPixels } from "./chat-settings-window";

export const CHAT_BRANCH_GRAPH_WINDOW_ID = "chat-branch-graph";

const DEFAULT_WIDTH_REM = 52;
const DEFAULT_HEIGHT_REM = 26;

/** Centred over the chat, as wide as a long timeline wants and no wider than the chat. */
function getBranchGraphDefaultLayout(bounds: WindowBounds): WindowLayout {
  const remPx = readCssPixels(document.documentElement, "font-size") || 16;
  const area = readChatWindowArea(bounds);
  const width = Math.max(320, Math.min(DEFAULT_WIDTH_REM * remPx, area.right - area.left));
  const height = Math.max(240, Math.min(DEFAULT_HEIGHT_REM * remPx, area.bottom - area.top));
  return {
    x: area.left + Math.max(0, (area.right - area.left - width) / 2),
    y: area.top + Math.max(0, (area.bottom - area.top - height) / 2),
    width,
    height,
    pinned: false,
    locked: false,
  };
}

/** The tree button in the Chat Branches header; it opens (or closes) the graph window. */
export function ChatBranchGraphButton() {
  const { t: localizeUi } = useUiTranslation();
  const open = useFloatingWindowStore((state) => state.open[CHAT_BRANCH_GRAPH_WINDOW_ID] === true);
  const label = localizeUi("chat.settings.branchGraphOpen");
  return (
    <button
      type="button"
      data-chat-branch-graph-button
      aria-label={label}
      aria-pressed={open}
      title={label}
      className="mari-window__control"
      onClick={(event) =>
        useFloatingWindowStore.getState().toggleWindow(CHAT_BRANCH_GRAPH_WINDOW_ID, event.currentTarget)
      }
    >
      <GitGraph size="0.875rem" />
    </button>
  );
}

export function ChatBranchGraphWindow({ chatId }: { chatId: string }) {
  const { t: localizeUi } = useUiTranslation();
  const phoneLayout = useMatchMedia("(max-width: 767px)");
  const open = useFloatingWindowStore((state) => state.open[CHAT_BRANCH_GRAPH_WINDOW_ID] === true);
  if (!open) return null;

  return (
    <FloatingWindow
      id={CHAT_BRANCH_GRAPH_WINDOW_ID}
      title={localizeUi("chat.settings.branchGraph")}
      titleIcon={<GitGraph size="0.8125rem" className="mari-chrome-accent-icon shrink-0" />}
      closeLabel={localizeUi("window.controls.close")}
      presentation={phoneLayout ? "sheet" : "window"}
      sheetClassName={cn(PHONE_SHEET_CLASS, PHONE_FULL_SHEET_CLASS)}
      getDefaultLayout={getBranchGraphDefaultLayout}
      minWidth={320}
      minHeight={200}
      className={cn("marinara-chat-popover", NEUTRAL_SURFACE_VARIABLES)}
      headerClassName="marinara-chat-popover__header"
      titleClassName="marinara-chat-popover__title text-xs font-semibold leading-tight"
      rootAttributes={{ "data-chat-branch-graph": chatId }}
      onRequestClose={(reason) => {
        // Its own close button always closes it; Escape and outside presses leave a pinned window be.
        useFloatingWindowStore.getState().dismissWindow(CHAT_BRANCH_GRAPH_WINDOW_ID, {
          force: reason === "close-button",
        });
      }}
    >
      <div className={cn(NEUTRAL_PANEL_SCROLL_AREA, "min-h-0 flex-1 overflow-auto overscroll-contain")}>
        <div className="mari-chrome-text-muted flex min-h-32 items-center justify-center px-4 py-8 text-xs">
          {localizeUi("chat.settings.branchGraphEmpty")}
        </div>
      </div>
    </FloatingWindow>
  );
}
