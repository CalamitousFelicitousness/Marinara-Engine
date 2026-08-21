// Multiswipe: candidates 2..N of a regenerate request.
//
// Candidate 1 comes from the main generate path and stays the active swipe.
// Every candidate produced here is appended as a silent swipe, so the active
// index and the message row never move while the tail generates.
//
// Post-processing and parallel agents are deferred to finalize
// (POST /api/generate/multi-swipe/finalize then /api/generate/retry-agents),
// so nothing in this module executes commands, mutates world or spatial state,
// posts outward, or writes chat-level caches. Candidate text is sanitized for
// display only; unexecutable constructs are stripped and counted, never run.

import {
  extractLeadingThinkingBlocks,
  MULTI_SWIPE_EXTRA_KEY,
  normalizeMultiSwipeCandidateCount,
  type MultiSwipePendingMarker,
} from "@marinara-engine/shared";
import type { FastifyReply } from "fastify";
import { logger } from "../../lib/logger.js";
import {
  parseCharacterCommands,
  parseDirectMessageCommands,
  type CharacterCommand,
} from "../../services/conversation/character-commands.js";
import { stripConversationResponseEnvelope } from "../../services/conversation/transcript-sanitize.js";
import {
  getVisibleCompletionTokens,
  stripSpacesBeforeLineBreaks,
  trimIncompleteModelEnding,
} from "../../services/generation/generation-text-utils.js";
import {
  withLlmRequestTimeout,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../../services/llm/base-provider.js";
import { extractAssistantSpatialDirective } from "../../services/spatial-context/state-resolution.js";
import { isAbortLikeError } from "./agent-result-capabilities.js";
import { sendSseEvent } from "./sse.js";

/** SSE `multi_swipe_progress` payload. `current` is the candidate ordinal (2..total). */
export interface MultiSwipeProgressEvent {
  messageId: string;
  current: number;
  total: number;
  status: "generating" | "saved" | "failed";
}

/** SSE `swipe_appended` payload. Silent swipes never move activeSwipeIndex, so the client needs the count explicitly. */
export interface SwipeAppendedEvent {
  messageId: string;
  index: number;
  swipeCount: number;
}

/** Request shape that decides whether multiswipe applies at all. */
export interface MultiSwipeCountInput {
  requested: number | undefined;
  regenerateMessageId: string | null;
  continueMessageId: string | null;
  impersonate: boolean;
  turnGameBots: boolean;
  chatMode: string;
  isGroupChat: boolean;
  groupChatMode: string;
}

/**
 * Candidates to generate for this request, after clamping and gating.
 * Returns 1 (stock behavior) for every path multiswipe does not support:
 * - non-regenerate turns, which have no message to append swipes to
 * - continue, which extends a message in place rather than adding a swipe
 * - impersonate, which saves a user row
 * - turn-game bot turns, which drive seats rather than a chat reply
 * - game mode, whose save-time map parsing and per-swipe snapshots do not replay at finalize
 * - group individual mode, whose per-speaker name pruning is out of this module's scope
 */
export function resolveMultiSwipeCount(input: MultiSwipeCountInput): number {
  const requested = normalizeMultiSwipeCandidateCount(input.requested);
  if (requested <= 1) return 1;
  if (!input.regenerateMessageId) return 1;
  if (input.continueMessageId) return 1;
  if (input.impersonate || input.turnGameBots) return 1;
  if (input.chatMode === "game") return 1;
  if (input.isGroupChat && input.groupChatMode === "individual") return 1;
  return requested;
}

/** Everything the candidate sanitizer needs, resolved once by the caller. */
export interface MultiSwipeSanitizeContext {
  chatMode: "roleplay" | "conversation";
  /** Chat-configured custom thinking tag pairs, passed through to the shared extractor. */
  customThinkingTags?: unknown;
  /** Prefill text only when it was actually injected, so a doubled echo can be collapsed. */
  assistantPrefill?: string | null;
  conversationCommandsEnabled: boolean;
  /** Narrows parsed commands to the ones enabled for this chat. Absent means treat all as enabled. */
  filterEnabledCommands?: (commands: CharacterCommand[]) => CharacterCommand[];
  roleplayDmCommandsEnabled: boolean;
  /** Roleplay chat is linked to a conversation, so <ooc> blocks are extracted rather than displayed. */
  stripOocForConnectedChat: boolean;
  conversationEnvelope: {
    speakerName: string | null;
    speakerNames: string[];
    preserveSpeakerPrefix: boolean;
  } | null;
  trimIncompleteModelOutput: boolean;
  stripSpatialDirectives: boolean;
}

export interface MultiSwipeSanitizedCandidate {
  /** Display content. Empty means the candidate produced nothing usable. */
  content: string;
  /** Inline reasoning lifted out of the content, merged with provider-native thinking by the caller. */
  inlineThinking: string | null;
  /** Pre-strip text retained so a chosen candidate keeps commands in model-visible history. */
  conversationCommandContent: string | null;
  /** Conversation commands that were enabled for this chat and would have run for candidate 1. */
  droppedCommandCount: number;
  droppedDmCommandCount: number;
  droppedOocCount: number;
  droppedSpatialDirective: boolean;
}

const OOC_RE = /<ooc>([\s\S]*?)<\/ooc>/gi;

/**
 * Display-only subset of the candidate-1 post-stream pipeline in generate.routes.ts.
 *
 * Deliberately omitted, because multiswipe never reaches those paths: game speaker
 * canonicalization and group individual name pruning (both modes force count 1),
 * thinking-only promotion (an empty candidate is simply dropped), and the repeated
 * Conversation response check (regenerations skip it upstream).
 */
export function sanitizeMultiSwipeCandidate(raw: string, ctx: MultiSwipeSanitizeContext): MultiSwipeSanitizedCandidate {
  let content = raw;
  let inlineThinking: string | null = null;
  let conversationCommandContent: string | null = null;
  let droppedCommandCount = 0;
  let droppedDmCommandCount = 0;
  let droppedOocCount = 0;
  let droppedSpatialDirective = false;

  const thinking = extractLeadingThinkingBlocks(content, ctx.customThinkingTags);
  if (thinking.stripped) {
    if (thinking.thinking) inlineThinking = thinking.thinking;
    content = thinking.content;
  }

  // Some providers echo an injected prefill twice; keep exactly one copy.
  const prefill = ctx.assistantPrefill;
  if (prefill && content.startsWith(prefill)) {
    const afterPrefill = content.slice(prefill.length);
    if (afterPrefill.startsWith(prefill)) content = prefill + afterPrefill.slice(prefill.length);
  }

  if (ctx.conversationCommandsEnabled && ctx.chatMode === "conversation") {
    const beforeCommandParsing = content;
    const parsed = parseCharacterCommands(content);
    if (parsed.commands.length > 0) {
      const enabled = ctx.filterEnabledCommands ? ctx.filterEnabledCommands(parsed.commands) : parsed.commands;
      droppedCommandCount = enabled.length;
      if (enabled.length > 0) conversationCommandContent = beforeCommandParsing.trim();
      content = parsed.cleanContent;
    }
  }

  // DM commands are not executed for a candidate, so strip every one of them.
  if (ctx.roleplayDmCommandsEnabled && ctx.chatMode === "roleplay") {
    const parsed = parseDirectMessageCommands(content);
    if (parsed.commands.length > 0) {
      droppedDmCommandCount = parsed.commands.length;
      content = parsed.cleanContent.replace(/\n{3,}/g, "\n\n").trim();
    }
  }

  if (ctx.stripOocForConnectedChat && ctx.chatMode === "roleplay") {
    const matches = [...content.matchAll(OOC_RE)].filter((match) => (match[1] ?? "").trim().length > 0);
    if (matches.length > 0) {
      droppedOocCount = matches.length;
      content = content
        .replace(OOC_RE, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  }

  if (ctx.conversationEnvelope && ctx.chatMode === "conversation") {
    content = stripConversationResponseEnvelope(content, {
      speakerName: ctx.conversationEnvelope.speakerName,
      speakerNames: ctx.conversationEnvelope.speakerNames,
      preserveSpeakerPrefix: ctx.conversationEnvelope.preserveSpeakerPrefix,
    });
  }

  if (ctx.trimIncompleteModelOutput) content = trimIncompleteModelEnding(content);

  if (ctx.chatMode === "roleplay") content = stripSpacesBeforeLineBreaks(content).trim();

  if (ctx.stripSpatialDirectives) {
    const parsedSpatial = extractAssistantSpatialDirective(content);
    if (parsedSpatial.matched) {
      droppedSpatialDirective = true;
      content = parsedSpatial.cleanContent;
    }
  }

  return {
    content: content.trim(),
    inlineThinking,
    conversationCommandContent,
    droppedCommandCount,
    droppedDmCommandCount,
    droppedOocCount,
    droppedSpatialDirective,
  };
}

/** Storage surface used by the loop. Structural so a regression can inject the real storage or a stub. */
export interface MultiSwipeChatsStorage {
  addSwipe(messageId: string, content: string, silent?: boolean): Promise<{ id: string; index: number }>;
  /** Resolves null when the target swipe row does not exist, in which case nothing was written. */
  updateMessageExtraForSwipe(messageId: string, swipeIndex: number, partial: Record<string, unknown>): Promise<unknown>;
}

/** Provider surface used by the loop. Structural so a regression can inject a fake generator. */
export interface MultiSwipeProvider {
  chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown>;
}

export interface MultiSwipeCandidateRunSummary {
  /** Swipes appended by this run, in generation order. */
  appended: Array<{ index: number; contentLength: number }>;
  /** Candidate ordinals (2..total) that produced nothing usable. */
  failed: number[];
  /** True when the run stopped early because the request was aborted. */
  aborted: boolean;
}

export interface RunMultiSwipeCandidatesArgs {
  reply: FastifyReply;
  chats: MultiSwipeChatsStorage;
  chatId: string;
  messageId: string;
  /** Candidate 1's swipe index. The marker is written here before any tail work starts. */
  activeSwipeIndex: number;
  /** Total candidates for the run, including candidate 1. */
  totalCandidates: number;
  provider: MultiSwipeProvider;
  /** The exact prompt candidate 1 was generated from. */
  providerMessages: ChatMessage[];
  /** The exact options candidate 1 was generated with. Per-candidate callbacks are overridden below. */
  chatOptions: ChatOptions;
  abortSignal: AbortSignal;
  chatGenerationTimeoutMs: number;
  debugMode: boolean;
  sanitize: MultiSwipeSanitizeContext;
  /** Request-invariant half of generationInfo. Model, provider, tokens, and timing are per candidate. */
  generationInfoStatic: Record<string, unknown>;
  /** Swipe extra shared by every candidate of this run (prompt cache, injections, lorebook scan). */
  sharedSwipeExtra: Record<string, unknown>;
  pendingMarker: MultiSwipePendingMarker;
  /** Read after each candidate so a mid-run connection fallback is visible in generationInfo. */
  getProviderOrigin: () => { model: string; provider: string };
}

/**
 * Generate candidates 2..N sequentially and append each as a silent swipe.
 *
 * Sequential rather than a provider-side `n`: Anthropic, the Claude/Grok
 * subscription providers, and the local sidecar have no multi-candidate
 * parameter, and a single streamed generator cannot be demultiplexed per
 * candidate. Repeating one prompt is also the ideal prompt-cache case.
 *
 * Never throws for candidate failures: candidate 1 is already saved and active,
 * so a failed tail degrades to fewer swipes rather than a failed generation.
 */
export async function runMultiSwipeCandidates(
  args: RunMultiSwipeCandidatesArgs,
): Promise<MultiSwipeCandidateRunSummary> {
  const {
    reply,
    chats,
    chatId,
    messageId,
    activeSwipeIndex,
    totalCandidates,
    provider,
    providerMessages,
    chatOptions,
    abortSignal,
    chatGenerationTimeoutMs,
    debugMode,
    sanitize,
    generationInfoStatic,
    sharedSwipeExtra,
    pendingMarker,
    getProviderOrigin,
  } = args;

  const summary: MultiSwipeCandidateRunSummary = { appended: [], failed: [], aborted: false };

  // Written before any tail work, including when the request is already aborted:
  // agents were deferred the moment this path was taken, so the finalize trail
  // must exist even if no further candidate is produced.
  try {
    const marked = await chats.updateMessageExtraForSwipe(messageId, activeSwipeIndex, {
      [MULTI_SWIPE_EXTRA_KEY]: pendingMarker,
    });
    // A missing swipe row writes nothing, which would strand the deferred agents
    // with no way for the user to run them. Fail the tail rather than hide that.
    if (!marked) {
      logger.error(
        "[multi-swipe] Swipe %d of message %s is missing, so deferred agents cannot be recorded for chat %s",
        activeSwipeIndex,
        messageId,
        chatId,
      );
      return summary;
    }
  } catch (err) {
    logger.error(err, "[multi-swipe] Failed to mark deferred agents on chat %s message %s", chatId, messageId);
    return summary;
  }

  const originAtStart = getProviderOrigin();

  for (let candidate = 2; candidate <= totalCandidates; candidate++) {
    if (abortSignal.aborted) {
      summary.aborted = true;
      break;
    }

    sendSseEvent(reply, {
      type: "multi_swipe_progress",
      data: { messageId, current: candidate, total: totalCandidates, status: "generating" } as MultiSwipeProgressEvent,
    });

    const startedAt = Date.now();
    let raw = "";
    let providerThinking = "";
    let usage: LLMUsage | undefined;
    let finishReason: string | null = null;
    let geminiParts: unknown[] | null = null;
    let chatCompletionsReasoning: Record<string, unknown> | null = null;
    let encryptedReasoning: unknown[] | null = null;

    try {
      const gen = provider.chat(providerMessages, {
        ...chatOptions,
        onThinking: (chunk) => {
          providerThinking += chunk;
        },
        onResponseParts: (parts) => {
          geminiParts = parts;
        },
        onChatCompletionsReasoning: (metadata) => {
          chatCompletionsReasoning = metadata;
        },
        // Captured per candidate but never written to the chat-level reasoning
        // cache: candidate 1 stays active, so it remains authoritative there.
        // Storing the items on this swipe keeps continuity correct if the user
        // picks this candidate (generate.routes.ts reseeds the cache from extra).
        onEncryptedReasoning: (items) => {
          encryptedReasoning = items;
        },
      });

      try {
        let result = await withLlmRequestTimeout(chatGenerationTimeoutMs, () => gen.next());
        while (!result.done) {
          if (abortSignal.aborted) break;
          raw += result.value;
          result = await withLlmRequestTimeout(chatGenerationTimeoutMs, () => gen.next());
        }
        if (result.done && result.value) {
          usage = result.value;
          finishReason = usage.finishReason ?? null;
        }
      } finally {
        // Mirrors the main loop: without forwarding a return, the admission
        // wrapper's finally never runs and the connection stays foreground-active.
        await gen.return(undefined).catch((closeError: unknown) => {
          logger.warn(closeError, "[multi-swipe] Failed to close the candidate stream");
        });
      }
    } catch (err) {
      if (abortSignal.aborted || isAbortLikeError(err)) {
        summary.aborted = true;
        break;
      }
      summary.failed.push(candidate);
      logger.warn(err, "[multi-swipe] Candidate %d/%d failed for chat %s", candidate, totalCandidates, chatId);
      sendSseEvent(reply, {
        type: "multi_swipe_progress",
        data: { messageId, current: candidate, total: totalCandidates, status: "failed" } as MultiSwipeProgressEvent,
      });
      continue;
    }

    if (abortSignal.aborted) {
      summary.aborted = true;
      break;
    }

    const durationMs = Date.now() - startedAt;
    const origin = getProviderOrigin();
    if (origin.model !== originAtStart.model || origin.provider !== originAtStart.provider) {
      logger.warn(
        "[multi-swipe] Candidate %d for chat %s came from %s/%s instead of %s/%s (connection fallback)",
        candidate,
        chatId,
        origin.provider,
        origin.model,
        originAtStart.provider,
        originAtStart.model,
      );
    }

    if (debugMode) {
      logger.debug(
        "[multi-swipe] Candidate %d/%d raw response for chat %s (%d chars):\n%s",
        candidate,
        totalCandidates,
        chatId,
        raw.length,
        raw,
      );
    }

    const sanitized = sanitizeMultiSwipeCandidate(raw, sanitize);
    if (!sanitized.content) {
      summary.failed.push(candidate);
      logger.warn(
        "[multi-swipe] Candidate %d/%d produced no usable content for chat %s",
        candidate,
        totalCandidates,
        chatId,
      );
      sendSseEvent(reply, {
        type: "multi_swipe_progress",
        data: { messageId, current: candidate, total: totalCandidates, status: "failed" } as MultiSwipeProgressEvent,
      });
      continue;
    }

    if (
      sanitized.droppedDmCommandCount > 0 ||
      sanitized.droppedOocCount > 0 ||
      sanitized.droppedSpatialDirective ||
      sanitized.droppedCommandCount > 0
    ) {
      // Candidates never execute side effects; finalize replays agents, not commands.
      logger.warn(
        "[multi-swipe] Candidate %d for chat %s dropped %d command(s), %d DM command(s), %d OOC block(s), spatial directive: %s",
        candidate,
        chatId,
        sanitized.droppedCommandCount,
        sanitized.droppedDmCommandCount,
        sanitized.droppedOocCount,
        sanitized.droppedSpatialDirective,
      );
    }

    const thinking = [providerThinking.trim(), sanitized.inlineThinking?.trim()].filter(Boolean).join("\n\n");

    let appendedIndex: number;
    try {
      const created = await chats.addSwipe(messageId, sanitized.content, true);
      appendedIndex = created.index;
      await chats.updateMessageExtraForSwipe(messageId, created.index, {
        ...sharedSwipeExtra,
        generationInfo: {
          ...generationInfoStatic,
          model: origin.model,
          provider: origin.provider,
          tokensPrompt: usage?.promptTokens ?? null,
          tokensCompletion: usage?.completionTokens ?? null,
          tokensVisibleCompletion: getVisibleCompletionTokens(usage) ?? null,
          tokensReasoning: usage?.completionReasoningTokens ?? null,
          tokensCompletionAudio: usage?.completionAudioTokens ?? null,
          tokensRejectedPrediction: usage?.rejectedPredictionTokens ?? null,
          tokensCachedPrompt: usage?.cachedPromptTokens ?? null,
          tokensCacheWritePrompt: usage?.cacheWritePromptTokens ?? null,
          durationMs,
          finishReason,
        },
        thinking: thinking || null,
        geminiParts: geminiParts ?? null,
        chatCompletionsReasoning: chatCompletionsReasoning ?? null,
        encryptedReasoning: encryptedReasoning ?? null,
        conversationCommandContent: sanitized.conversationCommandContent,
        [MULTI_SWIPE_EXTRA_KEY]: pendingMarker,
      });
    } catch (err) {
      logger.error(
        err,
        "[multi-swipe] Failed to persist candidate %d/%d for chat %s",
        candidate,
        totalCandidates,
        chatId,
      );
      summary.failed.push(candidate);
      break;
    }

    summary.appended.push({ index: appendedIndex, contentLength: sanitized.content.length });
    sendSseEvent(reply, {
      type: "swipe_appended",
      data: { messageId, index: appendedIndex, swipeCount: appendedIndex + 1 } as SwipeAppendedEvent,
    });
    sendSseEvent(reply, {
      type: "multi_swipe_progress",
      data: { messageId, current: candidate, total: totalCandidates, status: "saved" } as MultiSwipeProgressEvent,
    });
  }

  return summary;
}
