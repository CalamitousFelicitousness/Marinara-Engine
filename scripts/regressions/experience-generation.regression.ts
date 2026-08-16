// #5135 regression: POST /api/game/:chatId/experience-generation — the host-run
// one-shot structured generation call for game-surface Experiences.
//
// Pinned behaviors:
//   1. Gates: missing chat → 404; a stamped conversation-mode chat and an
//      unstamped game chat → 409; a malformed body → 400. None of them reach
//      the provider.
//   2. Happy path: parsed JSON comes back as {ok, data}; the provider request
//      carries the package's schema as response_format json_schema and a
//      max_tokens floor of at least 2048.
//   3. Repair round-trip: a prose first reply triggers exactly one corrective
//      re-ask (bad output as an assistant turn + a corrective user turn) that
//      converges to 200.
//   4. Truncation (finish_reason "length" + cut JSON) → 422 truncated:true.
//   5. Garbage on both attempts → 422 truncated:false with the raw text so the
//      package can degrade to its own defaults.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { errorHandler } from "../../packages/server/src/middleware/error-handler.js";
import { gameRoutes } from "../../packages/server/src/routes/game.routes.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createConnectionsStorage } from "../../packages/server/src/services/storage/connections.storage.js";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const db = await getDB();
const chats = createChatsStorage(db);
const connections = createConnectionsStorage(db);
const createdChatIds: string[] = [];
let createdConnectionId: string | null = null;

// ── Mock OpenAI-compatible provider ──────────────────────────────────────────
type Scenario = "happy" | "repair" | "truncated" | "garbage";
let scenario: Scenario = "happy";
let upstreamBodies: Array<Record<string, unknown>> = [];

const VALID_BRIEF = JSON.stringify({ version: 1, theme: "sci-fi-colony", settlementName: "Meridian Base" });

const mockProvider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  upstreamBodies.push(body);
  const attempt = upstreamBodies.length;
  const respond = (content: string, finishReason = "stop") => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }));
  };
  if (scenario === "happy") return respond(VALID_BRIEF);
  if (scenario === "repair") return attempt === 1 ? respond("Sure! Here is your world, in prose.") : respond(VALID_BRIEF);
  if (scenario === "truncated") return respond('{"version":1,"theme":"sci-fi', "length");
  return respond("no json here, ever");
});
await new Promise<void>((resolve) => mockProvider.listen(0, "127.0.0.1", resolve));
const mockAddress = mockProvider.address();
assert.ok(mockAddress && typeof mockAddress === "object");
const mockBaseUrl = `http://127.0.0.1:${mockAddress.port}/v1`;

const app = Fastify();
app.decorate("db", db);
// The production ZodError → 400 mapping, so the malformed-body case pins the
// status a real client sees rather than a bare-harness 500.
app.setErrorHandler(errorHandler);
await app.register(gameRoutes, { prefix: "/api/game" });

const EXPERIENCE_ID = "experience-generation-test";
const post = (chatId: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/game/${chatId}/experience-generation`, payload: payload as object });

const BASE_BODY = {
  instructions: "You produce a world brief. Reply with ONLY a JSON object.",
  userContent: "Theme: sci-fi colony. Settlement of 30 people, one mayor.",
  schema: { type: "object", properties: { version: { type: "number" } }, required: ["version"] },
};

async function createExperienceChat(name: string, mode = "game", stamp = true) {
  const chat = await chats.create({ name, mode, characterIds: [] } as Parameters<typeof chats.create>[0]);
  assert.ok(chat);
  createdChatIds.push(chat.id);
  if (stamp) await chats.patchMetadata(chat.id, () => ({ gameExperienceId: EXPERIENCE_ID }));
  if (createdConnectionId) await chats.update(chat.id, { connectionId: createdConnectionId });
  return chat;
}

try {
  const conn = await connections.create({
    name: "experience-generation mock",
    provider: "custom",
    baseUrl: mockBaseUrl,
    apiKey: "test",
    model: "mock-model",
  } as Parameters<typeof connections.create>[0]);
  createdConnectionId = conn.id;

  // ── 1. Gates, none of which may reach the provider ──
  {
    upstreamBodies = [];
    assert.equal((await post("no-such-chat-5135", BASE_BODY)).statusCode, 404, "missing chat is a clean 404");

    const conversation = await createExperienceChat("stamped conversation", "conversation", true);
    assert.equal((await post(conversation.id, BASE_BODY)).statusCode, 409, "stamped conversation chat refused");

    const unstamped = await createExperienceChat("unstamped game", "game", false);
    assert.equal((await post(unstamped.id, BASE_BODY)).statusCode, 409, "unstamped game chat refused");

    const stamped = await createExperienceChat("gate bad body");
    assert.equal((await post(stamped.id, { userContent: "no instructions" })).statusCode, 400, "malformed body is 400");
    assert.equal(upstreamBodies.length, 0, "no gate case reached the provider");
  }

  // ── 2. Happy path with schema passthrough ──
  {
    scenario = "happy";
    upstreamBodies = [];
    const chat = await createExperienceChat("happy path");
    const res = await post(chat.id, BASE_BODY);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.theme, "sci-fi-colony", "parsed JSON comes back as data");
    assert.equal(upstreamBodies.length, 1, "one provider call");
    const responseFormat = upstreamBodies[0]?.response_format as Record<string, unknown> | undefined;
    assert.equal(responseFormat?.type, "json_schema", "package schema forwarded as provider structured output");
    const maxTokens = upstreamBodies[0]?.max_tokens ?? upstreamBodies[0]?.max_completion_tokens;
    assert.ok(typeof maxTokens === "number" && maxTokens >= 2_048, `max tokens floored (got ${String(maxTokens)})`);
  }

  // ── 3. Repair round-trip ──
  {
    scenario = "repair";
    upstreamBodies = [];
    const chat = await createExperienceChat("repair round trip");
    const res = await post(chat.id, BASE_BODY);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.settlementName, "Meridian Base");
    assert.equal(upstreamBodies.length, 2, "exactly one corrective re-ask");
    const retryMessages = upstreamBodies[1]?.messages as Array<{ role: string; content: string }>;
    assert.ok(
      retryMessages.some((m) => m.role === "assistant" && m.content.includes("in prose")),
      "the retry shows the model its own bad output",
    );
    assert.ok(
      retryMessages.some((m) => m.role === "user" && m.content.includes("corrected JSON")),
      "the retry carries the corrective instruction",
    );
  }

  // ── 4. Truncation is diagnosed, not retried into a wall ──
  {
    scenario = "truncated";
    upstreamBodies = [];
    const chat = await createExperienceChat("truncated");
    const res = await post(chat.id, BASE_BODY);
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json();
    assert.equal(body.truncated, true, "truncation flagged");
    assert.ok(String(body.error).includes("max output tokens"), "actionable truncation message");
    assert.equal(upstreamBodies.length, 1, "no futile retry after truncation");
  }

  // ── 5. Garbage both times degrades with the raw text ──
  {
    scenario = "garbage";
    upstreamBodies = [];
    const chat = await createExperienceChat("garbage twice");
    const res = await post(chat.id, BASE_BODY);
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json();
    assert.equal(body.truncated, false);
    assert.ok(String(body.raw).includes("no json here"), "raw text returned for package-side degradation");
    assert.equal(upstreamBodies.length, 2, "one repair attempt, then give up");
  }

  console.log("experience-generation regression passed");
} finally {
  for (const chatId of createdChatIds) await chats.remove(chatId).catch(() => undefined);
  if (createdConnectionId) await connections.remove(createdConnectionId).catch(() => undefined);
  await app.close();
  await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
  await closeDB();
}
