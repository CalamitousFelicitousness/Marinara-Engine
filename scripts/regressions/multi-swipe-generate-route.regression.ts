// Multiswipe through the real POST /api/generate route against a mock provider.
// Pins the wiring the unit-level lanes cannot: that candidateCount actually
// reaches the candidate loop, that the tail lands as silent swipes on the
// message the turn produced, and that a count of 1 leaves stock behavior
// untouched. Covers both a regenerate and a new turn, which differ only in
// which swipe index candidate 1 occupies.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { generateRoutes } from "../../packages/server/src/routes/generate.routes.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createConnectionsStorage } from "../../packages/server/src/services/storage/connections.storage.js";
import { readMultiSwipePendingMarker } from "../../packages/shared/src/utils/multi-swipe.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-multi-swipe-route-"));
process.env.FILE_STORAGE_DIR = storageDir;
const db = await createFileNativeDB();
const chats = createChatsStorage(db);
const connections = createConnectionsStorage(db);

// ── Mock OpenAI-compatible provider: one distinct completion per call ──
let completionCount = 0;
const mockProvider = createServer(async (request, response) => {
  for await (const _chunk of request) void _chunk;
  completionCount += 1;
  const content = `Candidate body ${completionCount}.`;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
});
await new Promise<void>((resolve) => mockProvider.listen(0, "127.0.0.1", resolve));
const mockAddress = mockProvider.address();
assert.ok(mockAddress && typeof mockAddress === "object");
const mockBaseUrl = `http://127.0.0.1:${mockAddress.port}/v1`;

const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });

/** Collect the `type` of every SSE event the route wrote. */
function parseSseTypes(body: string): Array<{ type: string; data: unknown }> {
  const events: Array<{ type: string; data: unknown }> = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as { type: string; data: unknown });
    } catch {
      // Non-JSON keepalive lines are not events.
    }
  }
  return events;
}

try {
  const conn = await connections.create({
    name: "multiswipe mock",
    provider: "custom",
    baseUrl: mockBaseUrl,
    apiKey: "test",
    model: "mock-model",
  } as Parameters<typeof connections.create>[0]);

  async function seedChat(name: string) {
    const chat = await chats.create({
      name,
      mode: "roleplay",
      characterIds: [],
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: conn.id,
    });
    assert.ok(chat);
    await chats.createMessage({ chatId: chat.id, role: "user", characterId: null, content: "Tell me something." });
    const assistant = await chats.createMessage({
      chatId: chat.id,
      role: "assistant",
      characterId: null,
      content: "Original response.",
    });
    assert.ok(assistant);
    return { chatId: chat.id, messageId: assistant.id };
  }

  const generate = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/generate", payload });

  // ── candidateCount = 3 produces one active swipe plus two silent ones ──
  {
    const seed = await seedChat("Multiswipe route");
    completionCount = 0;
    const response = await generate({
      chatId: seed.chatId,
      regenerateMessageId: seed.messageId,
      candidateCount: 3,
      streaming: false,
    });
    assert.equal(response.statusCode, 200, "the generation must succeed");

    const events = parseSseTypes(response.body);
    const appended = events.filter((event) => event.type === "swipe_appended");
    assert.equal(appended.length, 2, "two tail candidates must announce themselves");
    assert.deepEqual(
      appended.map((event) => (event.data as { index: number }).index),
      [2, 3],
      "silent candidates take the swipe slots after the active one",
    );
    assert.ok(
      events.some((event) => event.type === "multi_swipe_progress"),
      "the client needs progress events to render 'generating N of M'",
    );
    assert.equal(completionCount, 3, "one provider call per candidate, sequentially");

    const message = await chats.getMessage(seed.messageId);
    assert.ok(message);
    assert.equal(message.activeSwipeIndex, 1, "the active swipe stays candidate 1");
    assert.equal(message.content, "Candidate body 1.", "the message row mirrors candidate 1");

    const swipes = await chats.getSwipes(seed.messageId);
    assert.equal(swipes.length, 4, "original plus three candidates");
    assert.equal(swipes.find((swipe) => swipe.index === 2)?.content, "Candidate body 2.");
    assert.equal(swipes.find((swipe) => swipe.index === 3)?.content, "Candidate body 3.");

    const marker = readMultiSwipePendingMarker(message.extra);
    assert.ok(marker, "the message must record that agents were deferred");
    assert.equal(marker.candidateCount, 3);
    for (const index of [1, 2, 3]) {
      assert.ok(
        readMultiSwipePendingMarker(swipes.find((swipe) => swipe.index === index)?.extra),
        `swipe ${index} must carry the marker so finalize survives swipe browsing`,
      );
    }
  }

  // ── candidateCount = 1 is exactly stock behavior ──
  {
    const seed = await seedChat("Single swipe route");
    completionCount = 0;
    const response = await generate({
      chatId: seed.chatId,
      regenerateMessageId: seed.messageId,
      candidateCount: 1,
      streaming: false,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(completionCount, 1, "a stock reroll still makes exactly one provider call");

    const events = parseSseTypes(response.body);
    assert.equal(
      events.filter((event) => event.type === "swipe_appended" || event.type === "multi_swipe_progress").length,
      0,
      "multiswipe events must not appear on a stock reroll",
    );

    const swipes = await chats.getSwipes(seed.messageId);
    assert.equal(swipes.length, 2, "original plus the single reroll");
    const message = await chats.getMessage(seed.messageId);
    assert.equal(message?.activeSwipeIndex, 1);
    assert.equal(
      readMultiSwipePendingMarker(message?.extra),
      null,
      "a stock reroll must never leave a deferred-agent marker",
    );
  }

  // ── A new turn fans out onto the message it just created ──
  // The send button's gesture produces exactly this request: no regenerate
  // target, so candidate 1 is a brand-new assistant message and the tail appends
  // to its swipe 0 rather than after a pre-existing original.
  {
    const seed = await seedChat("New turn route");
    completionCount = 0;
    const response = await generate({
      chatId: seed.chatId,
      userMessage: "Another prompt.",
      candidateCount: 4,
      streaming: false,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(completionCount, 4, "a new turn fans out without needing an assistant message to reroll");

    const events = parseSseTypes(response.body);
    assert.deepEqual(
      events.filter((event) => event.type === "swipe_appended").map((event) => (event.data as { index: number }).index),
      [1, 2, 3],
      "candidate 1 owns swipe 0 on a new message, so the tail starts at 1",
    );

    const all = await chats.listMessages(seed.chatId);
    const created = all.filter((message) => message.role === "assistant" && message.id !== seed.messageId);
    assert.equal(created.length, 1, "a fanned-out turn must still produce exactly one message");
    const target = created[0]!;
    assert.equal(target.activeSwipeIndex, 0, "candidate 1 stays active");
    assert.equal(target.content, "Candidate body 1.", "the message row mirrors candidate 1");

    const swipes = await chats.getSwipes(target.id);
    assert.equal(swipes.length, 4, "one swipe per candidate, with no pre-existing original");
    assert.deepEqual(
      swipes.sort((a, b) => a.index - b.index).map((swipe) => swipe.content),
      ["Candidate body 1.", "Candidate body 2.", "Candidate body 3.", "Candidate body 4."],
      "every candidate is retrievable by browsing swipes",
    );

    const marker = readMultiSwipePendingMarker(target.extra);
    assert.ok(marker, "a fanned-out new turn defers its agents like any other");
    assert.equal(marker.candidateCount, 4);
    for (const swipe of swipes) {
      assert.ok(
        readMultiSwipePendingMarker(swipe.extra),
        `swipe ${swipe.index} must carry the marker so finalize survives swipe browsing`,
      );
    }
  }

  // ── A new turn with no count asked for stays stock ──
  {
    const seed = await seedChat("New turn stock");
    completionCount = 0;
    const response = await generate({ chatId: seed.chatId, userMessage: "Another prompt.", streaming: false });
    assert.equal(response.statusCode, 200);
    assert.equal(completionCount, 1, "an ordinary send must not fan out");

    const all = await chats.listMessages(seed.chatId);
    const created = all.filter((message) => message.role === "assistant" && message.id !== seed.messageId);
    assert.equal(created.length, 1);
    assert.equal(
      readMultiSwipePendingMarker(created[0]!.extra),
      null,
      "an ordinary send must never leave a deferred-agent marker",
    );
  }
} finally {
  await app.close();
  await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
  await db._fileStore.close();
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Multiswipe generate-route regression passed.");
