import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-message-attachments-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";

type TestApp = {
  activeGenerations: Map<string, unknown>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
let closeDatabase: (() => Promise<void>) | undefined;
const providerRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  providerRequests.push(body);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, value: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", {
    message: { id: "fixture", type: "message", role: "assistant", model: body.model, content: [], usage: {} },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Fixture reply." } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  send("message_stop", {});
  response.end();
});
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { closeDB, getDB } = await import("../../packages/server/src/db/connection.js");
  closeDatabase = closeDB;
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
  const { describeAttachmentsForNonUserTurn } =
    await import("../../packages/server/src/services/generation/prompt-attachments.js");
  const { characterDataSchema, messageAttachmentKey } = await import("../../packages/shared/src/index.ts");

  const photo = { type: "image/png", data: "data:image/png;base64,iVBORw0KGgo=", filename: "a.png", name: "a.png" };
  const notes = { type: "text/plain", data: "data:text/plain;base64,aGk=", filename: "n.txt", name: "n.txt" };
  const pdf = { type: "application/pdf", data: "data:application/pdf;base64,JVBERi0=", name: "doc.pdf" };
  const illustration = { type: "image", url: "/api/gallery/file/scene.png" };

  assert.equal(describeAttachmentsForNonUserTurn(undefined), "");
  assert.equal(describeAttachmentsForNonUserTurn([illustration, notes]), "", "illustrations and inlined text");
  assert.equal(describeAttachmentsForNonUserTurn([illustration, photo, notes, pdf]), "\n[Attached: a.png, doc.pdf]");

  app = (await buildApp()) as unknown as TestApp;
  await app.ready();
  const db = await getDB();
  const storage = createChatsStorage(db);
  const timestamp = "2026-10-01T00:00:00.000Z";
  for (const id of ["attach-chat", "other-chat"]) {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "roleplay",
      characterIds: "[]",
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const message = await storage.createMessage({
    chatId: "attach-chat",
    role: "assistant",
    characterId: null,
    content: "First take",
  } as never);
  assert(message);
  await storage.addSwipe(message.id, "Second take");
  await storage.appendSwipeAttachment(message.id, 1, illustration);
  await storage.appendMessageAttachmentForActiveSwipe(message.id, 1, illustration);

  const url = `/api/chats/attach-chat/messages/${message.id}/attachments`;
  const appended = await app.inject({ method: "POST", url, payload: { attachments: [photo, notes] } });
  assert.equal(appended.statusCode, 200, appended.body);
  assert.deepEqual(JSON.parse(appended.json().extra).attachments, [illustration, photo, notes]);

  const swipes = await storage.getSwipes(message.id);
  const swipeAttachments = (index: number) =>
    JSON.parse(swipes.find((swipe: { index: number }) => swipe.index === index)!.extra ?? "{}").attachments;
  assert.deepEqual(swipeAttachments(1), [illustration, photo, notes], "the active swipe keeps the files");
  assert.equal(swipeAttachments(0), undefined, "an inactive swipe is untouched");

  // An illustration landing at the same time as the upload survives, in either order.
  const lateIllustration = { type: "image", url: "/api/gallery/file/late.png" };
  await Promise.all([
    app.inject({ method: "POST", url, payload: { attachments: [pdf] } }),
    storage
      .appendSwipeAttachment(message.id, 1, lateIllustration)
      .then(() => storage.appendMessageAttachmentForActiveSwipe(message.id, 1, lateIllustration)),
  ]);
  const raced = JSON.parse((await storage.getMessage(message.id))!.extra).attachments;
  assert.equal(raced.length, 5);
  assert(raced.some((entry: { url?: string }) => entry.url === lateIllustration.url));
  assert(raced.some((entry: { name?: string }) => entry.name === pdf.name));

  for (const payload of [
    { attachments: [] },
    { attachments: [{ type: "image/png", data: "https://example.com/remote.png" }] },
    { attachments: [{ type: "", data: "data:text/plain;base64,aGk=" }] },
  ]) {
    const rejected = await app.inject({ method: "POST", url, payload });
    assert.equal(rejected.statusCode, 400, JSON.stringify(payload));
  }

  const wrongChat = await app.inject({
    method: "POST",
    url: `/api/chats/other-chat/messages/${message.id}/attachments`,
    payload: { attachments: [photo] },
  });
  assert.equal(wrongChat.statusCode, 404);

  app.activeGenerations.set("attach-chat", {});
  const duringGeneration = await app.inject({ method: "POST", url, payload: { attachments: [photo] } });
  app.activeGenerations.delete("attach-chat");
  assert.equal(duringGeneration.statusCode, 409);
  assert.equal(JSON.parse((await storage.getMessage(message.id))!.extra).attachments.length, 5);

  // Removal takes one attachment out of the active swipe by its key, wherever it sits.
  const removeUrl = (attachment: object, chatId = "attach-chat") =>
    `/api/chats/${chatId}/messages/${message.id}/attachments/${messageAttachmentKey(attachment)}`;
  const messageAttachments = async () => JSON.parse((await storage.getMessage(message.id))!.extra).attachments;
  const activeSwipeAttachments = async () =>
    JSON.parse(
      (await storage.getSwipes(message.id)).find((swipe: { index: number }) => swipe.index === 1)!.extra ?? "{}",
    ).attachments;
  const removed = await app.inject({ method: "DELETE", url: removeUrl(notes) });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(
    JSON.parse(removed.json().extra).attachments.map(
      (entry: { name?: string; url?: string }) => entry.name ?? entry.url,
    ),
    (await activeSwipeAttachments()).map((entry: { name?: string; url?: string }) => entry.name ?? entry.url),
  );
  assert.equal((await messageAttachments()).length, 4);
  assert(!(await messageAttachments()).some((entry: { name?: string }) => entry.name === notes.name));
  const inactiveSwipe = (await storage.getSwipes(message.id)).find((swipe: { index: number }) => swipe.index === 0)!;
  assert.equal(JSON.parse(inactiveSwipe.extra ?? "{}").attachments, undefined, "an inactive swipe is untouched");

  const repeated = await app.inject({ method: "DELETE", url: removeUrl(notes) });
  assert.equal(repeated.statusCode, 200);
  assert.equal((await messageAttachments()).length, 4, "a key with no match changes nothing");

  // An illustration saved after the client last read the message survives a removal the client sends.
  const unseenIllustration = { type: "image", url: "/api/gallery/file/unseen.png" };
  await storage.appendSwipeAttachment(message.id, 1, unseenIllustration);
  await storage.appendMessageAttachmentForActiveSwipe(message.id, 1, unseenIllustration);
  assert.equal((await app.inject({ method: "DELETE", url: removeUrl(photo) })).statusCode, 200);
  const afterUnseen = await messageAttachments();
  assert(afterUnseen.some((entry: { url?: string }) => entry.url === unseenIllustration.url));
  assert(!afterUnseen.some((entry: { name?: string }) => entry.name === photo.name));
  assert.deepEqual(await activeSwipeAttachments(), afterUnseen);

  // Identical attachments are interchangeable; one removal takes one of them.
  await app.inject({ method: "POST", url, payload: { attachments: [pdf] } });
  await app.inject({ method: "DELETE", url: removeUrl(pdf) });
  assert.equal((await messageAttachments()).filter((entry: { name?: string }) => entry.name === pdf.name).length, 1);

  const removeWrongChat = await app.inject({ method: "DELETE", url: removeUrl(pdf, "other-chat") });
  assert.equal(removeWrongChat.statusCode, 404);
  app.activeGenerations.set("attach-chat", {});
  const removeDuringGeneration = await app.inject({ method: "DELETE", url: removeUrl(pdf) });
  app.activeGenerations.delete("attach-chat");
  assert.equal(removeDuringGeneration.statusCode, 409);
  assert.equal((await messageAttachments()).filter((entry: { name?: string }) => entry.name === pdf.name).length, 1);

  // Native image and file parts reach the provider only on user turns, in generation and dry run alike.
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerAddress = provider.address();
  assert(providerAddress && typeof providerAddress === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Attachment prompt proof",
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
    name: "Attachment prompt proof",
    parameters: { maxTokens: 128, maxContext: 8192 },
    wrapFormat: "xml",
  });
  assert(preset);
  await prompts.createSection({ presetId: preset.id, identifier: "rules", name: "Rules", content: "Respond." });
  await prompts.createSection({
    presetId: preset.id,
    identifier: "history",
    name: "Chat History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  const promptChat = await storage.create({
    name: "Attachment prompt proof",
    mode: "roleplay",
    characterIds: [character.id],
    connectionId: connection.id,
    promptPresetId: preset.id,
  });
  assert(promptChat);
  await storage.patchMetadata(promptChat.id, { enableAgents: false, enableMemoryRecall: false });
  await storage.createMessage({
    chatId: promptChat.id,
    role: "user",
    content: "USER_TURN_SENTINEL",
    extra: { attachments: [photo] },
  } as never);
  await storage.createMessage({
    chatId: promptChat.id,
    role: "assistant",
    characterId: character.id,
    content: "ASSISTANT_TURN_SENTINEL",
    extra: { attachments: [illustration, photo, pdf] },
  } as never);
  await storage.createMessage({ chatId: promptChat.id, role: "user", content: "LATEST_TURN_SENTINEL" } as never);

  const turnContaining = (request: (typeof providerRequests)[number], sentinel: string) => {
    const turn = request.messages.find((entry) => JSON.stringify(entry.content).includes(sentinel));
    assert(turn, `${sentinel} reached the provider`);
    return { role: turn.role, content: JSON.stringify(turn.content) };
  };
  const generationPayload = { chatId: promptChat.id, forCharacterId: character.id, streaming: true };
  for (const route of ["/api/generate/dryRun", "/api/generate/"]) {
    const before = providerRequests.length;
    const response = await app.inject({ method: "POST", url: route, payload: generationPayload });
    assert.equal(response.statusCode, 200, `${route}: ${response.body}`);
    assert.equal(providerRequests.length, before + 1, `${route} sent one provider request`);
    const request = providerRequests.at(-1)!;
    const userTurn = turnContaining(request, "USER_TURN_SENTINEL");
    assert.equal(userTurn.role, "user");
    assert(userTurn.content.includes('"type":"image"'), `${route}: the user turn keeps its image`);
    const assistantTurn = turnContaining(request, "ASSISTANT_TURN_SENTINEL");
    assert.equal(assistantTurn.role, "assistant");
    assert(!assistantTurn.content.includes('"type":"image"'), `${route}: no image block on the assistant turn`);
    assert(!assistantTurn.content.includes('"type":"document"'), `${route}: no document block on the assistant turn`);
    assert(assistantTurn.content.includes("[Attached: a.png, doc.pdf]"), `${route}: ${assistantTurn.content}`);
  }
} finally {
  await app?.close();
  await closeDatabase?.();
  if (provider.listening) {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Message attachments regression passed.\n");
