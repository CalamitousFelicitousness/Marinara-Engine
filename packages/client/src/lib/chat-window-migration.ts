import type { Chat } from "@marinara-engine/shared";
import { getDrawerWindowId, toWindowLayoutSnapshot, type WindowLayoutSnapshot } from "./floating-window-layout";

/** Keep an older chat's toolbar tools visible until its user chooses to put them in Chat Settings. */
export function getLegacyChatWindowLayout(
  mode: Chat["mode"],
  metadata: Record<string, unknown>,
): WindowLayoutSnapshot | null {
  // Null is an intentional default/reset. Any stored value, even a broken one, belongs to the user.
  if (Object.hasOwn(metadata, "windowLayout") || metadata.multiplayer || metadata.multiplayerSetup === true) {
    return null;
  }
  if (mode !== "conversation" && mode !== "roleplay" && mode !== "game") return null;

  const sections = ["chat-branches", "active-context", "gallery"];
  if (mode !== "game") sections.push("message-search");
  if (mode === "roleplay") {
    sections.push("chat-summary", "author-notes");
    const memory = metadata.advancedMemory;
    if (
      metadata.enableAgents === true ||
      (memory && typeof memory === "object" && "enabled" in memory && memory.enabled === true)
    ) {
      sections.push("agent-activity");
    }
  }
  // No screen coordinates are migrated: the drawer allocates its button on this device.
  return toWindowLayoutSnapshot(
    {},
    sections.map((section) => getDrawerWindowId("chat-settings", `${mode}-${section}`)),
  );
}
