// Pure multiswipe decisions, kept free of React, network, and Vite-only imports
// so they can be exercised directly by a regression script.
import { MAX_MULTI_SWIPE_CANDIDATES, readMultiSwipePendingMarker, type Message } from "@marinara-engine/shared";

/** Actions that commit the user to whichever swipe is currently active. */
export type MultiSwipeFinalizeTrigger = "send" | "continue" | "regenerate" | "explicit";

export interface PendingMultiSwipe {
  messageId: string;
  pendingAgents: string[];
}

/**
 * Newest assistant message whose active swipe still carries a deferred-agent
 * marker. Markers live per swipe and surface on the message because
 * setActiveSwipe mirrors the active swipe's extra onto it.
 *
 * Only the newest match is returned: implicit finalize commits the swipe the
 * next turn will build on, not every un-agented swipe in the chat's history.
 * Older pending swipes stay reachable through their own badge.
 */
export function findPendingMultiSwipeMessage(messages: Message[]): PendingMultiSwipe | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const marker = readMultiSwipePendingMarker(message.extra);
    if (marker) return { messageId: message.id, pendingAgents: marker.pendingAgents };
  }
  return null;
}

/**
 * Whether an action should commit the pending swipe before proceeding.
 * Regenerating the pending message itself replaces the swipe being committed,
 * so running its deferred agents first would be wasted work.
 */
export function shouldFinalizeBeforeAction(input: {
  trigger: MultiSwipeFinalizeTrigger;
  pendingMessageId: string | null;
  targetMessageId?: string | null;
}): boolean {
  if (!input.pendingMessageId) return false;
  if (input.trigger === "regenerate") return input.targetMessageId !== input.pendingMessageId;
  return true;
}

/**
 * Candidate counts a surface may offer, or an empty list when it should show no
 * gesture at all. Chat-level gating only. The server owns the request-level
 * matrix (continue, impersonate, turn-game bots, group individual) and re-clamps
 * whatever arrives, so this exists to avoid offering a menu that cannot fan out,
 * not to be authoritative.
 */
export function multiSwipeCountOptions(input: { multiSwipeMax: number; chatMode?: string | null }): number[] {
  // Game mode is the one exclusion visible from a chat alone: its save-time map
  // parsing and per-swipe snapshots do not replay at finalize.
  if (input.chatMode === "game") return [];
  const max = Math.min(Math.max(input.multiSwipeMax, 1), MAX_MULTI_SWIPE_CANDIDATES);
  const counts: number[] = [];
  for (let count = 2; count <= max; count++) counts.push(count);
  return counts;
}
