import type { ChatMode } from "@marinara-engine/shared";

export const HOME_CHAT_MODE_ACCENTS: Record<ChatMode, string> = {
  conversation: "var(--primary)",
  roleplay: "var(--primary)",
  game: "var(--marinara-mode-game-accent)",
};
