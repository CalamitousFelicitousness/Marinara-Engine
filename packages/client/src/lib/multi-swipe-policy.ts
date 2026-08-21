// Pure multiswipe decisions, kept free of React, network, and Vite-only imports
// so they can be exercised directly by a regression script.
import { readMultiSwipePendingMarker, type Message } from "@marinara-engine/shared";

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
