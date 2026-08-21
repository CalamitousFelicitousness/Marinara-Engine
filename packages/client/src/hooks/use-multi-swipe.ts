// Multiswipe finalize: commit the swipe the user is on and replay the agents
// that were deferred when it was generated.
//
// Markers are per swipe, so committing one candidate leaves the others pending.
// Pending state is derived from persisted swipe extra rather than client state,
// so a reload mid-decision still finalizes correctly.
import { type Message } from "@marinara-engine/shared";
import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "../lib/api-client";
import {
  findPendingMultiSwipeMessage,
  shouldFinalizeBeforeAction,
  type MultiSwipeFinalizeTrigger,
} from "../lib/multi-swipe-policy";
import { translate } from "../localization/i18n";
import { chatKeys } from "./use-chats";

export type { MultiSwipeFinalizeTrigger, PendingMultiSwipe } from "../lib/multi-swipe-policy";

interface MultiSwipeFinalizeResponse {
  pendingAgents: string[];
  activeSwipeIndex: number;
  cleared: boolean;
}

export type MultiSwipeRetryAgentsFn = (
  chatId: string,
  agentTypes: string[],
  options?: { forMessageId?: string },
) => Promise<boolean>;

function cachedMessages(qc: QueryClient, chatId: string): Message[] {
  return qc.getQueryData<InfiniteData<Message[]>>(chatKeys.messages(chatId))?.pages.flat() ?? [];
}

/**
 * Commit the active swipe of one message: clear its deferred-agent marker, then
 * replay those agents against it. The marker clears at commit time, not on agent
 * success; a failed agent surfaces as agent_error and stays re-runnable.
 */
export async function finalizeMultiSwipeMessage(
  qc: QueryClient,
  chatId: string,
  messageId: string,
  retryAgents: MultiSwipeRetryAgentsFn,
): Promise<boolean> {
  let result: MultiSwipeFinalizeResponse;
  try {
    result = await api.post<MultiSwipeFinalizeResponse>("/generate/multi-swipe/finalize", { chatId, messageId });
  } catch (error) {
    console.error("[MultiSwipe] Finalize failed", error);
    toast.error(translate("ui.chat.multiswipe.finalizeFailed"));
    return false;
  }

  qc.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
  qc.invalidateQueries({ queryKey: [...chatKeys.all, "swipes", messageId] });

  // Nothing was deferred, or another caller already committed this message.
  if (result.pendingAgents.length === 0) return true;

  toast.info(translate("ui.chat.multiswipe.runningDeferredAgents"));
  try {
    return await retryAgents(chatId, result.pendingAgents, { forMessageId: messageId });
  } catch (error) {
    // The marker is already cleared, so the send that triggered this must proceed
    // regardless. Agents stay re-runnable through the ordinary manual retry paths.
    console.error("[MultiSwipe] Deferred agents failed", error);
    toast.error(translate("ui.chat.multiswipe.finalizeFailed"));
    return false;
  }
}

/**
 * Commit the chat's pending swipe when the trigger calls for it.
 * Safe to call unconditionally: a chat with nothing pending does no work.
 */
export async function finalizePendingMultiSwipe(
  qc: QueryClient,
  chatId: string,
  input: {
    trigger: MultiSwipeFinalizeTrigger;
    targetMessageId?: string | null;
    retryAgents: MultiSwipeRetryAgentsFn;
    messages?: Message[];
  },
): Promise<boolean> {
  const pending = findPendingMultiSwipeMessage(input.messages ?? cachedMessages(qc, chatId));
  if (!pending) return true;
  const shouldFinalize = shouldFinalizeBeforeAction({
    trigger: input.trigger,
    pendingMessageId: pending.messageId,
    targetMessageId: input.targetMessageId ?? null,
  });
  if (!shouldFinalize) return true;
  return finalizeMultiSwipeMessage(qc, chatId, pending.messageId, input.retryAgents);
}

/** React wrapper for the explicit "run agents for this version" menu action. */
export function useMultiSwipeFinalize(retryAgents: MultiSwipeRetryAgentsFn) {
  const qc = useQueryClient();

  const finalizeMessage = useCallback(
    (chatId: string, messageId: string) => finalizeMultiSwipeMessage(qc, chatId, messageId, retryAgents),
    [qc, retryAgents],
  );

  return { finalizeMessage };
}
