import type { ChatMode } from "../types/chat.js";

export interface ChatWindowDefault {
  windowLayout: unknown | null;
  chatSettingsHintDismissed: boolean;
}

export function getChatWindowDefaultSettingsKey(mode: ChatMode): string {
  return `chat-window-default-${mode}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Read only reusable presentation settings; the client sanitizes individual window coordinates. */
export function parseChatWindowDefault(value: string | null): ChatWindowDefault | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPlainRecord(parsed) || typeof parsed.chatSettingsHintDismissed !== "boolean") return null;
    const layout = parsed.windowLayout;
    if (layout !== null) {
      if (!isPlainRecord(layout) || layout.version !== 1 || !isPlainRecord(layout.windows)) return null;
      if (
        "detached" in layout &&
        (!Array.isArray(layout.detached) || layout.detached.some((id) => typeof id !== "string"))
      ) {
        return null;
      }
      if ("bubbles" in layout && !isPlainRecord(layout.bubbles)) return null;
      if ("phoneBubbles" in layout && !isPlainRecord(layout.phoneBubbles)) return null;
    }
    return { windowLayout: layout, chatSettingsHintDismissed: parsed.chatSettingsHintDismissed };
  } catch {
    return null;
  }
}
