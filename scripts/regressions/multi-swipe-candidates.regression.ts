// Multiswipe candidate loop against real file-backed storage.
// Pins: silent appends never move the active swipe, every candidate carries the
// deferred-agent marker and its own generationInfo, abort keeps earlier
// candidates, and provider failures degrade instead of throwing.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyReply } from "fastify";

import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  runMultiSwipeCandidates,
  type MultiSwipeProvider,
  type MultiSwipeSanitizeContext,
} from "../../packages/server/src/routes/generate/multi-swipe-candidates.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import type { ChatMessage, ChatOptions, LLMUsage } from "../../packages/server/src/services/llm/base-provider.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-multi-swipe-"));
process.env.FILE_STORAGE_DIR = storageDir;
const db = await createFileNativeDB();

interface CapturedEvent {
  type: string;
  data: Record<string, unknown>;
}

function createReplyStub(): { reply: FastifyReply; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const raw = {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    write(chunk: string) {
      const payload = chunk.startsWith("data: ") ? chunk.slice(6).trim() : "";
      if (payload) events.push(JSON.parse(payload) as CapturedEvent);
      return true;
    },
  };
  return { reply: { raw } as unknown as FastifyReply, events };
}

/** Scripted provider: one entry per candidate call. A string yields text, an Error is thrown. */
function createProvider(script: Array<string | Error>): MultiSwipeProvider & { calls: ChatOptions[] } {
  let call = 0;
  const calls: ChatOptions[] = [];
  return {
    calls,
    async *chat(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
      calls.push(options);
      const scripted = script[call++];
      if (scripted instanceof Error) throw scripted;
      yield scripted ?? "";
      return { promptTokens: 11, completionTokens: 22, totalTokens: 33, finishReason: "stop" };
    },
  };
}

const roleplaySanitize: MultiSwipeSanitizeContext = {
  chatMode: "roleplay",
  conversationCommandsEnabled: false,
  roleplayDmCommandsEnabled: false,
  stripOocForConnectedChat: false,
  conversationEnvelope: null,
  trimIncompleteModelOutput: false,
  stripSpatialDirectives: false,
};

const pendingMarker = { pendingAgents: ["world-state", "expression-engine"], candidateCount: 3, createdAt: 1_770_000_000 };

const chats = createChatsStorage(db);

async function seedRegeneratedMessage(name: string, candidateOne: string) {
  const chat = await chats.create({
    name,
    mode: "roleplay",
    characterIds: [],
    groupId: null,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  assert.ok(chat);
  const message = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: null,
    content: "Original response.",
  });
  assert.ok(message);
  // Candidate 1 of a multiswipe run is the ordinary regenerate swipe.
  const first = await chats.addSwipe(message.id, candidateOne);
  assert.equal(first.index, 1, "candidate 1 must land on the swipe after the original response");
  return { chatId: chat.id, messageId: message.id, activeSwipeIndex: first.index };
}

function parseExtra(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

try {
  // ── Happy path: two silent candidates appended behind an untouched active swipe ──
  {
    const seed = await seedRegeneratedMessage("Multiswipe happy path", "Candidate one text.");
    const { reply, events } = createReplyStub();
    const provider = createProvider(["Candidate two text.", "Candidate three text."]);

    const summary = await runMultiSwipeCandidates({
      reply,
      chats,
      chatId: seed.chatId,
      messageId: seed.messageId,
      activeSwipeIndex: seed.activeSwipeIndex,
      totalCandidates: 3,
      provider,
      providerMessages: [{ role: "user", content: "Prompt." }],
      chatOptions: { model: "test-model", temperature: 0.7 },
      abortSignal: new AbortController().signal,
      chatGenerationTimeoutMs: 5_000,
      debugMode: false,
      sanitize: roleplaySanitize,
      generationInfoStatic: { temperature: 0.7, maxTokens: 512 },
      sharedSwipeExtra: { contextInjections: null, cachedPrompt: [{ role: "user", content: "Prompt." }] },
      pendingMarker,
      getProviderOrigin: () => ({ model: "test-model", provider: "openai" }),
    });

    assert.deepEqual(
      summary.appended.map((entry) => entry.index),
      [2, 3],
      "both candidates must append as swipes after candidate 1",
    );
    assert.deepEqual(summary.failed, [], "no candidate should fail on the happy path");
    assert.equal(summary.aborted, false);

    const message = await chats.getMessage(seed.messageId);
    assert.ok(message);
    assert.equal(message.activeSwipeIndex, 1, "silent candidates must not move the active swipe");
    assert.equal(message.content, "Candidate one text.", "the message row must still mirror candidate 1");

    const swipes = await chats.getSwipes(seed.messageId);
    assert.equal(swipes.length, 4, "original + three candidates");
    assert.equal(swipes.find((swipe) => swipe.index === 2)?.content, "Candidate two text.");
    assert.equal(swipes.find((swipe) => swipe.index === 3)?.content, "Candidate three text.");

    // Every candidate, including candidate 1, carries the deferred-agent marker.
    for (const index of [1, 2, 3]) {
      const extra = parseExtra(swipes.find((swipe) => swipe.index === index)?.extra);
      assert.deepEqual(
        extra.multiSwipe,
        pendingMarker,
        `swipe ${index} must carry the deferred-agent marker so finalize can replay agents`,
      );
    }

    const candidateTwoExtra = parseExtra(swipes.find((swipe) => swipe.index === 2)?.extra);
    const generationInfo = candidateTwoExtra.generationInfo as Record<string, unknown>;
    assert.equal(generationInfo.model, "test-model");
    assert.equal(generationInfo.provider, "openai");
    assert.equal(generationInfo.tokensPrompt, 11);
    assert.equal(generationInfo.tokensCompletion, 22);
    assert.equal(generationInfo.finishReason, "stop");
    assert.equal(generationInfo.maxTokens, 512, "static generationInfo fields must be carried through");
    assert.deepEqual(
      candidateTwoExtra.cachedPrompt,
      [{ role: "user", content: "Prompt." }],
      "candidates must reuse the prompt cached for the run",
    );

    // Message extra must stay candidate 1's, because index 2 was never active.
    const messageExtra = parseExtra(message.extra);
    assert.equal(
      (messageExtra.generationInfo as Record<string, unknown> | null)?.model,
      undefined,
      "a silent candidate must not overwrite the active swipe's generationInfo on the message row",
    );

    const appendedEvents = events.filter((event) => event.type === "swipe_appended");
    assert.deepEqual(
      appendedEvents.map((event) => event.data),
      [
        { messageId: seed.messageId, index: 2, swipeCount: 3 },
        { messageId: seed.messageId, index: 3, swipeCount: 4 },
      ],
      "swipe_appended must carry an explicit count, since silent swipes never move activeSwipeIndex",
    );
    const progress = events.filter((event) => event.type === "multi_swipe_progress").map((event) => event.data.status);
    assert.deepEqual(progress, ["generating", "saved", "generating", "saved"]);

    assert.equal(provider.calls.length, 2, "one provider call per tail candidate");
    assert.equal(provider.calls[0]?.model, "test-model", "candidates reuse candidate 1's chat options");
    assert.equal(typeof provider.calls[0]?.onThinking, "function", "per-candidate callbacks must be installed");
  }

  // ── Abort mid-loop keeps everything already persisted ──
  {
    const seed = await seedRegeneratedMessage("Multiswipe abort", "Candidate one text.");
    const controller = new AbortController();
    const { reply } = createReplyStub();
    // Aborts while candidate 2 is still streaming, the way a client disconnect does.
    const abortingProvider: MultiSwipeProvider = {
      async *chat(): AsyncGenerator<string, LLMUsage | void, unknown> {
        yield "Candidate two text.";
        controller.abort();
        return undefined;
      },
    };

    const summary = await runMultiSwipeCandidates({
      reply,
      chats,
      chatId: seed.chatId,
      messageId: seed.messageId,
      activeSwipeIndex: seed.activeSwipeIndex,
      totalCandidates: 4,
      provider: abortingProvider,
      providerMessages: [{ role: "user", content: "Prompt." }],
      chatOptions: { model: "test-model" },
      abortSignal: controller.signal,
      chatGenerationTimeoutMs: 5_000,
      debugMode: false,
      sanitize: roleplaySanitize,
      generationInfoStatic: {},
      sharedSwipeExtra: {},
      pendingMarker,
      getProviderOrigin: () => ({ model: "test-model", provider: "openai" }),
    });

    assert.equal(summary.aborted, true, "aborting mid-run must be reported");
    assert.deepEqual(summary.appended, [], "a candidate aborted before persistence must not be saved");

    const swipes = await chats.getSwipes(seed.messageId);
    assert.equal(swipes.length, 2, "abort must leave the original and candidate 1 untouched");
    const candidateOneExtra = parseExtra(swipes.find((swipe) => swipe.index === 1)?.extra);
    assert.deepEqual(
      candidateOneExtra.multiSwipe,
      pendingMarker,
      "the marker must be written before the tail runs, so an aborted run still finalizes",
    );
    const message = await chats.getMessage(seed.messageId);
    assert.equal(message?.activeSwipeIndex, 1);
  }

  // ── A failing candidate is skipped; later candidates still run ──
  {
    const seed = await seedRegeneratedMessage("Multiswipe partial failure", "Candidate one text.");
    const { reply, events } = createReplyStub();
    const provider = createProvider([new Error("provider exploded"), "Candidate three text."]);

    const summary = await runMultiSwipeCandidates({
      reply,
      chats,
      chatId: seed.chatId,
      messageId: seed.messageId,
      activeSwipeIndex: seed.activeSwipeIndex,
      totalCandidates: 3,
      provider,
      providerMessages: [{ role: "user", content: "Prompt." }],
      chatOptions: { model: "test-model" },
      abortSignal: new AbortController().signal,
      chatGenerationTimeoutMs: 5_000,
      debugMode: false,
      sanitize: roleplaySanitize,
      generationInfoStatic: {},
      sharedSwipeExtra: {},
      pendingMarker,
      getProviderOrigin: () => ({ model: "test-model", provider: "openai" }),
    });

    assert.deepEqual(summary.failed, [2], "the failing candidate must be reported");
    assert.deepEqual(
      summary.appended.map((entry) => entry.index),
      [2],
      "a later candidate must still take the next free swipe index",
    );
    assert.equal(summary.aborted, false);
    const swipes = await chats.getSwipes(seed.messageId);
    assert.equal(swipes.find((swipe) => swipe.index === 2)?.content, "Candidate three text.");
    assert.ok(
      events.some((event) => event.type === "multi_swipe_progress" && event.data.status === "failed"),
      "a failed candidate must be reported to the client",
    );
  }

  // ── A missing anchor swipe stops the run instead of stranding deferred agents ──
  {
    const seed = await seedRegeneratedMessage("Multiswipe missing anchor", "Candidate one text.");
    const { reply } = createReplyStub();
    const provider = createProvider(["Candidate two text."]);

    const summary = await runMultiSwipeCandidates({
      reply,
      chats,
      chatId: seed.chatId,
      messageId: seed.messageId,
      activeSwipeIndex: 99,
      totalCandidates: 3,
      provider,
      providerMessages: [{ role: "user", content: "Prompt." }],
      chatOptions: { model: "test-model" },
      abortSignal: new AbortController().signal,
      chatGenerationTimeoutMs: 5_000,
      debugMode: false,
      sanitize: roleplaySanitize,
      generationInfoStatic: {},
      sharedSwipeExtra: {},
      pendingMarker,
      getProviderOrigin: () => ({ model: "test-model", provider: "openai" }),
    });

    assert.deepEqual(summary.appended, [], "without a recorded marker the tail must not run");
    assert.equal(
      provider.calls.length,
      0,
      "candidates must not be billed when the user could never trigger their agents",
    );
    assert.equal((await chats.getSwipes(seed.messageId)).length, 2, "storage is left untouched");
  }

  // ── Every candidate failing is degradation, not an error ──
  {
    const seed = await seedRegeneratedMessage("Multiswipe total failure", "Candidate one text.");
    const { reply } = createReplyStub();
    const provider = createProvider([new Error("first"), "   "]);

    const summary = await runMultiSwipeCandidates({
      reply,
      chats,
      chatId: seed.chatId,
      messageId: seed.messageId,
      activeSwipeIndex: seed.activeSwipeIndex,
      totalCandidates: 3,
      provider,
      providerMessages: [{ role: "user", content: "Prompt." }],
      chatOptions: { model: "test-model" },
      abortSignal: new AbortController().signal,
      chatGenerationTimeoutMs: 5_000,
      debugMode: false,
      sanitize: roleplaySanitize,
      generationInfoStatic: {},
      sharedSwipeExtra: {},
      pendingMarker,
      getProviderOrigin: () => ({ model: "test-model", provider: "openai" }),
    });

    assert.deepEqual(summary.failed, [2, 3], "a blank candidate counts as failed, like a thrown one");
    assert.deepEqual(summary.appended, [], "nothing usable means nothing appended");
    const swipes = await chats.getSwipes(seed.messageId);
    assert.equal(swipes.length, 2, "candidate 1 must survive a fully failed tail");
  }
} finally {
  await db._fileStore.close();
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Multiswipe candidate loop regression passed.");
