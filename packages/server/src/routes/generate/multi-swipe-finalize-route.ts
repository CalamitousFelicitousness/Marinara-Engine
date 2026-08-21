// ──────────────────────────────────────────────
// Routes: Multiswipe finalize
// ──────────────────────────────────────────────
// Commits the user to the currently active swipe: clears that swipe's
// deferred-agent marker and reports which agent types the caller should replay
// against it via POST /api/generate/retry-agents.
//
// Markers are per swipe. Unchosen candidates keep theirs, so browsing back to
// one later shows it still needs its agents; each swipe finalizes individually.
// Clearing happens at commit time, not on agent success. A failed agent
// surfaces as agent_error and stays re-runnable through the manual retry paths.

import { MULTI_SWIPE_EXTRA_KEY, readMultiSwipePendingMarker } from "@marinara-engine/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../../lib/logger.js";
import { createChatsStorage } from "../../services/storage/chats.storage.js";

const finalizeMultiSwipeSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
});

export interface MultiSwipeFinalizeResult {
  /** Agent types to replay against the chosen swipe. Empty means nothing to run. */
  pendingAgents: string[];
  /** Swipe the caller committed to, which is what retry-agents will anchor on. */
  activeSwipeIndex: number;
  /** False when the active swipe carried no marker, which makes repeat calls a no-op. */
  cleared: boolean;
}

export async function multiSwipeFinalizeRoutes(app: FastifyInstance) {
  const chats = createChatsStorage(app.db);

  app.post("/finalize", async (req, reply) => {
    const input = finalizeMultiSwipeSchema.parse(req.body);

    const message = await chats.getMessage(input.messageId);
    if (!message || message.chatId !== input.chatId) {
      return reply.status(404).send({ error: "Message not found" });
    }

    const activeSwipeIndex = typeof message.activeSwipeIndex === "number" ? message.activeSwipeIndex : 0;
    const swipes = await chats.getSwipes(input.messageId);
    const marker =
      readMultiSwipePendingMarker(message.extra) ??
      readMultiSwipePendingMarker(swipes.find((swipe) => swipe.index === activeSwipeIndex)?.extra);

    if (!marker) {
      const result: MultiSwipeFinalizeResult = { pendingAgents: [], activeSwipeIndex, cleared: false };
      return result;
    }

    // Clears the message extra and mirrors onto the active swipe row in one
    // queued call, which is exactly "commit this swipe". Sibling swipes are left
    // alone: each carries its own marker until it is committed in turn.
    await chats.updateMessageExtra(input.messageId, { [MULTI_SWIPE_EXTRA_KEY]: null });

    const remainingPending = swipes.filter(
      (swipe) => swipe.index !== activeSwipeIndex && readMultiSwipePendingMarker(swipe.extra) !== null,
    ).length;

    logger.info(
      "[multi-swipe] Finalized chat %s message %s on swipe %d, replaying %d agent type(s); %d sibling swipe(s) still pending",
      input.chatId,
      input.messageId,
      activeSwipeIndex,
      marker.pendingAgents.length,
      remainingPending,
    );

    const result: MultiSwipeFinalizeResult = {
      pendingAgents: marker.pendingAgents,
      activeSwipeIndex,
      cleared: true,
    };
    return result;
  });
}
