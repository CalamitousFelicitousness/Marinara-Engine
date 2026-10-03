// ──────────────────────────────────────────────
// Help Layout targets: what the chat Help overlay labels in each mode
//
// Each target names a control by selector; the overlay skips any that are not
// visible right now, so one list covers desktop, phones, and the Chat Settings
// window being open or closed. Add new chat controls here.
// ──────────────────────────────────────────────
import type { ChatMode } from "@marinara-engine/shared";
import { CHAT_SETTINGS_WINDOW_ID } from "../stores/floating-window.store";

export type ChatHelpTargetId =
  | "identity"
  | "agents"
  | "branches"
  | "call"
  | "agent-controls"
  | "summary"
  | "context"
  | "author-notes"
  | "gallery"
  | "connected-chat"
  | "search"
  | "settings"
  | "help"
  | "window-title"
  | "window-pin"
  | "window-lock"
  | "window-close"
  | "tracker-panel"
  | "reset-view"
  | "messages"
  | "composer"
  | "map"
  | "party"
  | "scene-media"
  | "retry"
  | "session"
  | "volume"
  | "assets"
  | "widgets"
  | "dialogue";

export interface ChatHelpTargetDefinition {
  id: ChatHelpTargetId;
  titleKey: string;
  bodyKey: string;
  selector?: string;
  mergeMatches?: boolean;
  virtual?: "messages" | "composer";
}

function chatHelpTarget(id: ChatHelpTargetId, key: string, selector = `[data-chat-help="${id}"]`) {
  return {
    id,
    selector,
    titleKey: `chat.help.targets.${key}.title`,
    bodyKey: `chat.help.targets.${key}.body`,
  } satisfies ChatHelpTargetDefinition;
}

const CHAT_SETTINGS_WINDOW = `[data-window="${CHAT_SETTINGS_WINDOW_ID}"]`;

const TARGETS = {
  identity: chatHelpTarget("identity", "identity"),
  agents: chatHelpTarget("agents", "agents"),
  branches: chatHelpTarget("branches", "branches"),
  call: chatHelpTarget("call", "call"),
  "agent-controls": chatHelpTarget("agent-controls", "agentControls"),
  summary: chatHelpTarget("summary", "summary"),
  context: chatHelpTarget("context", "context"),
  "author-notes": chatHelpTarget("author-notes", "authorNotes"),
  gallery: chatHelpTarget("gallery", "gallery"),
  "connected-chat": chatHelpTarget("connected-chat", "connectedChat"),
  search: chatHelpTarget("search", "search"),
  // The topbar button on desktop, the toolbar button on phones.
  settings: chatHelpTarget("settings", "settings"),
  // The ? beside the Chat Settings title on desktop, the toolbar button on phones.
  help: chatHelpTarget("help", "help"),
  "window-title": chatHelpTarget("window-title", "windowTitle", `${CHAT_SETTINGS_WINDOW} .mari-window__title`),
  "window-pin": chatHelpTarget("window-pin", "windowPin", `${CHAT_SETTINGS_WINDOW} [data-window-control="pin"]`),
  "window-lock": chatHelpTarget("window-lock", "windowLock", `${CHAT_SETTINGS_WINDOW} [data-window-control="lock"]`),
  "window-close": chatHelpTarget(
    "window-close",
    "windowClose",
    `${CHAT_SETTINGS_WINDOW} [data-window-control="close"]`,
  ),
  // The whole switch row, not just its ? button.
  "tracker-panel": chatHelpTarget("tracker-panel", "trackerPanel", '[data-tracker-panel-toggle="chat-settings"]'),
  "reset-view": chatHelpTarget("reset-view", "resetView"),
  map: chatHelpTarget("map", "map", '[data-tour="game-map"]'),
  party: chatHelpTarget("party", "party", '[data-tour="game-party"]'),
  "scene-media": chatHelpTarget("scene-media", "sceneMedia"),
  retry: chatHelpTarget("retry", "retry"),
  session: chatHelpTarget("session", "session"),
  volume: chatHelpTarget("volume", "volume"),
  assets: chatHelpTarget("assets", "assets"),
  widgets: { ...chatHelpTarget("widgets", "widgets", "[data-game-widget-rail]"), mergeMatches: true },
  dialogue: chatHelpTarget("dialogue", "dialogue", '[data-tour="game-dialogue"]'),
} satisfies Partial<Record<ChatHelpTargetId, ChatHelpTargetDefinition>>;

const CHAT_SETTINGS_TARGETS: ChatHelpTargetDefinition[] = [
  TARGETS.settings,
  TARGETS.help,
  TARGETS["window-title"],
  TARGETS["window-pin"],
  TARGETS["window-lock"],
  TARGETS["window-close"],
  TARGETS["tracker-panel"],
  TARGETS["reset-view"],
];

const COMPOSER_TARGET: ChatHelpTargetDefinition = {
  id: "composer",
  virtual: "composer",
  titleKey: "chat.help.targets.composer.title",
  bodyKey: "chat.help.targets.composer.body",
};

const TARGETS_BY_MODE: Record<ChatMode, ChatHelpTargetDefinition[]> = {
  conversation: [
    TARGETS.identity,
    TARGETS.branches,
    TARGETS["agent-controls"],
    TARGETS.context,
    TARGETS.gallery,
    TARGETS["connected-chat"],
    TARGETS.search,
    TARGETS.call,
    ...CHAT_SETTINGS_TARGETS,
    {
      id: "messages",
      virtual: "messages",
      titleKey: "chat.help.targets.conversationMessages.title",
      bodyKey: "chat.help.targets.conversationMessages.body",
    },
    COMPOSER_TARGET,
  ],
  roleplay: [
    TARGETS.agents,
    TARGETS.branches,
    TARGETS["agent-controls"],
    TARGETS.summary,
    TARGETS.context,
    TARGETS["author-notes"],
    TARGETS.gallery,
    TARGETS["connected-chat"],
    TARGETS.search,
    ...CHAT_SETTINGS_TARGETS,
    {
      id: "messages",
      virtual: "messages",
      titleKey: "chat.help.targets.roleplayMessages.title",
      bodyKey: "chat.help.targets.roleplayMessages.body",
    },
    COMPOSER_TARGET,
  ],
  game: [
    TARGETS.map,
    TARGETS.party,
    TARGETS["scene-media"],
    TARGETS.branches,
    TARGETS.retry,
    TARGETS.session,
    TARGETS.volume,
    TARGETS.assets,
    TARGETS.context,
    TARGETS.gallery,
    TARGETS["connected-chat"],
    ...CHAT_SETTINGS_TARGETS,
    TARGETS.widgets,
    TARGETS.dialogue,
  ],
};

export function getChatHelpTargets(mode: ChatMode): readonly ChatHelpTargetDefinition[] {
  return TARGETS_BY_MODE[mode];
}
