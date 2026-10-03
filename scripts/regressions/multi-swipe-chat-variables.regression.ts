// Multiswipe candidates share one prompt, so a {{setvar}} that prompt ran belongs
// to every candidate. Browsing from candidate 1 to another must not undo it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-multi-swipe-chat-variables-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.js");

let completions = 0;
const provider = createServer(async (request, response) => {
  for await (const _chunk of request) void _chunk;
  completions += 1;
  const content = `Candidate ${completions}.`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
app.decorate("activeGenerations", new Map());
await app.register(generateRoutes, { prefix: "/api/generate" });
try {
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Local fixture",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "fixture",
    maxContext: 32768,
  });
  assert.ok(connection);
  const character = await createCharactersStorage(db).create(characterDataSchema.parse({ name: "Mira" }));
  assert.ok(character);
  const lorebooks = createLorebooksStorage(db);
  const book = await lorebooks.create({ name: "Marker" });
  assert.ok(book);
  await lorebooks.createEntry({
    lorebookId: book.id,
    name: "Marker",
    content: "Met: {{setvar::met::yes}}{{getvar::met}}",
    constant: true,
  } as never);
  const chat = (await chats.create({
    name: "Multiswipe variables",
    mode: "roleplay",
    characterIds: [character.id],
    connectionId: connection.id,
    promptPresetId: null,
  }))!;
  await chats.patchMetadata(chat.id, { enableAgents: false, enableTools: false, activeLorebookIds: [book.id] });
  const met = async () => {
    const metadata = (await chats.getById(chat.id))!.metadata;
    return (typeof metadata === "string" ? JSON.parse(metadata) : metadata).macroVariables?.met;
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: chat.id, userMessage: "Hello.", candidateCount: 3 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(!response.body.includes('"type":"error"'), response.body);
  assert.equal(completions, 3, "three candidates were generated");
  assert.equal(await met(), "yes", "the turn's prompt set the variable");

  const reply = (await chats.listMessages(chat.id)).at(-1)!;
  assert.equal(reply.role, "assistant");
  assert.equal((await chats.getSwipes(reply.id)).length, 3);
  for (const index of [1, 2, 0]) {
    await chats.setActiveSwipe(reply.id, index);
    assert.equal(await met(), "yes", `browsing to candidate ${index + 1} keeps the turn's variables`);
  }
} finally {
  await app.close();
  await new Promise<void>((done) => provider.close(() => done()));
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}

console.log("multi-swipe-chat-variables regression passed.");
