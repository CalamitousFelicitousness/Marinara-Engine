/**
 * Character ID macros in Conversation and Game chats (#6956): `{{<card ID>}}` becomes
 * the character's name in the sent prompt and in both previews, as in Roleplay. Only
 * the name: a card from outside the chat is not pulled into these modes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-id-macro-modes-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { characterDataSchema } = await import("../../packages/shared/dist/index.js");

const sent: string[] = [];
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  sent.push(JSON.stringify(JSON.parse(raw).messages));
  const chunk = { choices: [{ index: 0, delta: { content: "Hello there." }, finish_reason: null }] };
  const stop = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`);
});
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
app.decorate("activeGenerations", new Map());
await app.register(generateRoutes, { prefix: "/api/generate" });
await app.register(chatsRoutes, { prefix: "/api/chats" });
try {
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  assert(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "ID macro fixture",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "fixture",
    maxContext: 32768,
  });
  assert(connection);
  const characters = createCharactersStorage(db);
  const susie = await characters.create(characterDataSchema.parse({ name: "Susie", description: "SUSIE_CARD_TEXT" }));
  const mira = await characters.create(
    characterDataSchema.parse({ name: "Mira", description: `MIRA_CARD: an old friend of {{${susie.id}}}.` }),
  );
  assert(susie && mira);
  const check = (label: string, prompt: string) => {
    assert.match(prompt, /PROMPT_MARKER: Susie may visit\./u, `${label}: the chat's own prompt names the character`);
    assert.match(prompt, /Mira, have you seen Susie\?/u, `${label}: so does chat history`);
    assert.doesNotMatch(prompt, /\{\{[A-Za-z0-9_-]{21}\}\}/u, `${label}: no character ID macro is left`);
    assert.doesNotMatch(prompt, /SUSIE_CARD_TEXT/u, `${label}: only the name; the outside card is not pulled in`);
  };

  for (const mode of ["conversation", "game"] as const) {
    const chat = await chats.create({
      name: `ID macros in ${mode}`,
      mode,
      characterIds: [mira.id],
      connectionId: connection.id,
      promptPresetId: null,
    });
    assert(chat);
    await chats.patchMetadata(chat.id, {
      enableAgents: false,
      enableTools: false,
      enableMemoryRecall: false,
      // The chat's own system prompt (Conversation) or GM prompt (Game).
      [mode === "game" ? "gameSystemPrompt" : "customSystemPrompt"]: `PROMPT_MARKER: {{${susie.id}}} may visit.`,
    });
    await chats.createMessage({
      chatId: chat.id,
      role: "user",
      content: `{{${mira.id}}}, have you seen {{${susie.id}}}?`,
    });

    // Previews, before anything was sent. Peek Prompt's live fallback resolves the
    // chat's prompt but shows history as written, so only its prompt is checked.
    const peek = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/peek-prompt`, payload: {} });
    assert.equal(peek.statusCode, 200, peek.body);
    assert.equal(peek.json().source, "live_preview");
    assert.match(JSON.stringify(peek.json().messages), /PROMPT_MARKER: Susie may visit\./u, `${mode} Peek Prompt`);
    const dryRun = await app.inject({
      method: "POST",
      url: "/api/generate/dryRun",
      payload: { chatId: chat.id, returnPrompt: true },
    });
    assert.equal(dryRun.statusCode, 200, dryRun.body);
    check(`${mode} dry run`, dryRun.body);

    const before = sent.length;
    const response = await app.inject({ method: "POST", url: "/api/generate/", payload: { chatId: chat.id } });
    assert.equal(response.statusCode, 200, response.body);
    assert(!response.body.includes('"type":"error"'), response.body);
    assert.equal(sent.length, before + 1, `${mode}: one model request`);
    check(`${mode} sent prompt`, sent.at(-1)!);
    assert.match(sent.at(-1)!, /MIRA_CARD: an old friend of Susie\./u, `${mode}: the chat member's card names her too`);
  }
  console.log("Character ID macros resolve to names in Conversation and Game chats.");
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((done) => provider.close(() => done()));
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
