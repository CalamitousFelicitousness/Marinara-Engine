import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-message-trash-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";

type TestApp = {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
const providerRequests: Array<Record<string, any>> = [];
const provider = createServer(async (request, response) => {
  if (request.url?.endsWith("/api/extra/abort")) {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  providerRequests.push(body);
  assert(request.url?.endsWith("/messages"), "the prompt proof uses the mock Anthropic endpoint");
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, value: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", {
    message: {
      id: "fixture",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Prompt proof response." } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  response.end();
});
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { chats, messageSwipes, messageTrash } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
  const { characterDataSchema, MAX_PINNED_CONTEXT_MESSAGES } = await import("../../packages/shared/src/index.ts");

  app = (await buildApp()) as TestApp;
  await app.ready();
  const db = await getDB();
  const storage = createChatsStorage(db);
  const timestamp = "2026-09-01T00:00:00.000Z";
  for (const [id, mode] of [
    ["chat-message-trash", "conversation"],
    ["game-message-trash", "game"],
    ["pin-restore-chat", "conversation"],
  ] as const) {
    await db.insert(chats).values({
      id,
      name: id,
      mode,
      characterIds: "[]",
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const message = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    characterId: null,
    content: "Restorable message",
    extra: { bookmark: { label: "Keep", createdAt: timestamp }, privateNote: "private" },
  } as never);
  assert.ok(message);
  const defaultOffDelete = await app.inject({
    method: "DELETE",
    url: `/api/chats/chat-message-trash/messages/${message.id}`,
  });
  assert.equal(defaultOffDelete.statusCode, 200, defaultOffDelete.body);
  assert.deepEqual(defaultOffDelete.json(), { trashed: false, trashedCount: 0 });
  assert.equal(await storage.getMessage(message.id), null, "trash is opt-in; default delete remains permanent");
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.chatId, "chat-message-trash"))).length,
    0,
    "default-off deletion does not create a trash entry",
  );

  const enabled = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { messageTrash: true },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);

  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerAddress = provider.address();
  assert(providerAddress && typeof providerAddress === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Message marks prompt proof",
    provider: "anthropic",
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    model: "claude-opus-5-5",
    apiKey: "fixture",
    maxContext: 8192,
    maxTokensOverride: 128,
  });
  assert(connection);
  const character = await createCharactersStorage(db).create(characterDataSchema.parse({ name: "Narrator" }));
  assert(character);
  const prompts = createPromptsStorage(db);
  const preset = await prompts.create({
    name: "Message marks prompt proof",
    parameters: { maxTokens: 128, maxContext: 8192 },
    wrapFormat: "xml",
  });
  assert(preset);
  await prompts.createSection({
    presetId: preset.id,
    identifier: "rules",
    name: "Rules",
    content: "Respond as {{char}}.",
  });
  await prompts.createSection({
    presetId: preset.id,
    identifier: "history",
    name: "Chat History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  const promptChat = await storage.create({
    name: "Private marks prompt proof",
    mode: "roleplay",
    characterIds: [character.id],
    connectionId: connection.id,
    promptPresetId: preset.id,
  });
  assert(promptChat);
  await storage.patchMetadata(promptChat.id, { enableAgents: false, enableMemoryRecall: false, contextMessageLimit: 1 });
  const oldPinnedMessage = await storage.createMessage({
    chatId: promptChat.id,
    role: "user",
    content: "PINNED_CONTEXT_SENTINEL_6698",
    extra: { pinnedToContext: true, privateNote: "PRIVATE_NOTE_MUST_NOT_REACH_PROMPT_6698" },
  } as never);
  assert(oldPinnedMessage);
  await storage.createMessage({ chatId: promptChat.id, role: "user", content: "LATEST_CONTEXT_SENTINEL_6698" } as never);
  const generated = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: promptChat.id, forCharacterId: character.id, streaming: true },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  assert.equal(providerRequests.length, 1, "the real generation route prepared a provider request");
  const preparedPrompt = JSON.stringify(providerRequests[0]);
  assert(preparedPrompt.includes("Pinned message from earlier in the chat"));
  assert(preparedPrompt.includes("PINNED_CONTEXT_SENTINEL_6698"));
  assert(preparedPrompt.includes("LATEST_CONTEXT_SENTINEL_6698"));
  assert(!preparedPrompt.includes("PRIVATE_NOTE_MUST_NOT_REACH_PROMPT_6698"));

  for (let index = 0; index < 9; index += 1) {
    await storage.createMessage({
      chatId: "chat-message-trash",
      role: "user",
      content: `Pinned ${index}`,
      extra: { pinnedToContext: true },
    } as never);
  }
  const concurrentPinTargets = await Promise.all(
    ["pin-race-a", "pin-race-b"].map((content) =>
      storage.createMessage({ chatId: "chat-message-trash", role: "user", content } as never),
    ),
  );
  const concurrentPinResults = await Promise.all(
    concurrentPinTargets.map((target) =>
      app!.inject({
        method: "PATCH",
        url: `/api/chats/chat-message-trash/messages/${target!.id}/extra`,
        payload: { pinnedToContext: true },
      }),
    ),
  );
  assert.deepEqual(
    concurrentPinResults.map((result) => result.statusCode).sort(),
    [200, 409],
    "the per-chat pin cap remains enforced under concurrent updates",
  );
  const restorable = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    characterId: null,
    content: "Restorable message",
    extra: { bookmark: { label: "Keep", createdAt: timestamp }, privateNote: "private" },
  } as never);
  assert.ok(restorable);
  await storage.addSwipe(restorable.id, "Alternate text");
  await storage.setActiveSwipe(restorable.id, 1);

  const deleted = await app.inject({ method: "DELETE", url: `/api/chats/chat-message-trash/messages/${restorable.id}` });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), { trashed: true, trashedCount: 1 });
  assert.equal(await storage.getMessage(restorable.id), null, "the active transcript no longer contains the trashed message");
  const listed = await app.inject({ method: "GET", url: "/api/chats/chat-message-trash/trash" });
  assert.equal(listed.statusCode, 200);
  const [entry] = listed.json();
  assert.equal(entry.messageId, restorable.id);
  assert.equal(entry.swipeCount, 2);

  const trashSnapshot = (
    await db.select().from(messageTrash).where(eq(messageTrash.id, entry.id))
  )[0]!;
  const firstSwipeId = (JSON.parse(trashSnapshot.snapshot) as { swipes: Array<{ id: string }> }).swipes[0]!.id;
  await db.insert(messageSwipes).values({
    id: firstSwipeId,
    messageId: "orphaned-swipe-collision",
    index: 0,
    content: "Collision row",
    extra: "{}",
    createdAt: timestamp,
  });
  const conflictedRestore = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [entry.id] },
  });
  assert.ok(conflictedRestore.statusCode >= 400, "a swipe ID collision fails the restore unit");
  assert.equal(await storage.getMessage(restorable.id), null, "failed restore rolls back the message insert");
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.id, entry.id))).length, 1);
  await db.delete(messageSwipes).where(eq(messageSwipes.id, firstSwipeId));

  const restored = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [entry.id] },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().restoredMessageIds, [restorable.id]);
  const restoredMessage = await storage.getMessage(restorable.id);
  assert.equal(restoredMessage?.content, "Alternate text");
  assert.equal(JSON.parse(restoredMessage!.extra).privateNote, "private");
  assert.equal((await storage.getSwipes(restorable.id)).length, 2, "restore brings back the alternate swipes");

  const wrongChatTarget = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "user",
    content: "Must survive a mismatched chat route",
  } as never);
  assert.ok(wrongChatTarget);
  const wrongChatDelete = await app.inject({
    method: "DELETE",
    url: `/api/chats/game-message-trash/messages/${wrongChatTarget.id}`,
  });
  assert.equal(wrongChatDelete.statusCode, 404);
  const preservedWrongChatMessage = await storage.getMessage(wrongChatTarget.id);
  assert.equal(preservedWrongChatMessage?.chatId, "chat-message-trash");

  const skipTrashMessage = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    characterId: null,
    content: "Explicitly permanent deletion",
  } as never);
  assert.ok(skipTrashMessage);
  const skippedTrash = await app.inject({
    method: "DELETE",
    url: `/api/chats/chat-message-trash/messages/${skipTrashMessage.id}?trash=false`,
  });
  assert.equal(skippedTrash.statusCode, 200, skippedTrash.body);
  assert.deepEqual(skippedTrash.json(), { trashed: false, trashedCount: 0 });

  const gameMessage = await storage.createMessage({
    chatId: "game-message-trash",
    role: "assistant",
    characterId: null,
    content: "Game turn",
  } as never);
  assert.ok(gameMessage);
  const gameDelete = await app.inject({ method: "DELETE", url: `/api/chats/game-message-trash/messages/${gameMessage.id}` });
  assert.equal(gameDelete.statusCode, 200, gameDelete.body);
  assert.deepEqual(gameDelete.json(), { trashed: false, trashedCount: 0 });
  assert.equal(await storage.getMessage(gameMessage.id), null, "Game mode retains its permanent delete behavior");
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.chatId, "game-message-trash"))).length, 0);

  const pinRestoreTargets = await Promise.all(
    Array.from({ length: MAX_PINNED_CONTEXT_MESSAGES }, (_, index) =>
      storage.createMessage({
        chatId: "pin-restore-chat",
        role: "user",
        content: `Pinned for restore ${index}`,
        extra: { pinnedToContext: true },
      } as never),
    ),
  );
  const pinnedMessageToRestore = pinRestoreTargets[0]!;
  const deletedPinnedMessage = await app.inject({
    method: "DELETE",
    url: `/api/chats/pin-restore-chat/messages/${pinnedMessageToRestore.id}`,
  });
  assert.deepEqual(deletedPinnedMessage.json(), { trashed: true, trashedCount: 1 });
  const replacementPin = await storage.createMessage({
    chatId: "pin-restore-chat",
    role: "user",
    content: "Replacement pin",
  } as never);
  assert.ok(replacementPin);
  const pinReplacement = await app.inject({
    method: "PATCH",
    url: `/api/chats/pin-restore-chat/messages/${replacementPin.id}/extra`,
    payload: { pinnedToContext: true },
  });
  assert.equal(pinReplacement.statusCode, 200, pinReplacement.body);
  const pinnedTrashResponse = await app.inject({ method: "GET", url: "/api/chats/pin-restore-chat/trash" });
  const [pinnedTrashEntry] = pinnedTrashResponse.json() as Array<{ id: string }>;
  assert.ok(pinnedTrashEntry);
  const overLimitRestore = await app.inject({
    method: "POST",
    url: "/api/chats/pin-restore-chat/trash/restore",
    payload: { entryIds: [pinnedTrashEntry.id] },
  });
  assert.equal(overLimitRestore.statusCode, 409, overLimitRestore.body);
  assert.match(overLimitRestore.json().error, /limit of 10 pinned messages/);
  assert.equal(await storage.getMessage(pinnedMessageToRestore.id), null, "a rejected pinned restore leaves the message trashed");
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, pinnedTrashEntry.id))).length,
    1,
    "a rejected pinned restore retains its trash entry",
  );

  const bulkTrashMessages = await Promise.all(
    ["Bulk one", "Bulk two"].map((content) =>
      storage.createMessage({ chatId: "chat-message-trash", role: "user", content } as never),
    ),
  );
  const bulkDelete = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/messages/bulk-delete",
    payload: { messageIds: [...bulkTrashMessages.map((row) => row!.id), "missing-message-id"] },
  });
  assert.equal(bulkDelete.statusCode, 200, bulkDelete.body);
  assert.deepEqual(bulkDelete.json(), { trashed: true, trashedCount: 2 });

  const expiring = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "user",
    content: "Expires",
  } as never);
  assert.ok(expiring);
  await app.inject({ method: "DELETE", url: `/api/chats/chat-message-trash/messages/${expiring.id}` });
  const trashRows = await db.select().from(messageTrash).where(eq(messageTrash.messageId, expiring.id));
  assert.equal(trashRows.length, 1);
  await db.update(messageTrash).set({ deletedAt: "2026-07-01T00:00:00.000Z" }).where(eq(messageTrash.id, trashRows[0]!.id));
  const restoreAfterExpiry = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [trashRows[0]!.id] },
  });
  assert.equal(restoreAfterExpiry.statusCode, 200, restoreAfterExpiry.body);
  assert.deepEqual(restoreAfterExpiry.json().restoredMessageIds, [], "expired trash cannot be restored directly");
  assert.equal(await storage.getMessage(expiring.id), null);
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.id, trashRows[0]!.id))).length, 0);
} finally {
  await app?.close();
  if (provider.listening) {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Message trash regression passed.\n");
