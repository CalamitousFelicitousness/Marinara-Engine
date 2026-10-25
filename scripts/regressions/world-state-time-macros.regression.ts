import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMacros, type AgentContext, type MacroContext } from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-clock-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
const { buildPromptMacroContext } = await import("../../packages/server/src/services/prompt/macro-context.js");
const { renderAgentPromptTemplate } = await import("../../packages/server/src/services/agents/agent-executor.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
app.decorate("activeGenerations", new Map());
await app.register(generateRoutes, { prefix: "/api/generate" });

const template = "{{date.world_state}}|{{time.world_state}}|{{weekday.world_state}}";
const base: MacroContext = { user: "Mari", char: "Doctor", characters: ["Doctor"], variables: {} };
const tracked = { date: "2026-10-24", time: "22:10" };

try {
  assert.equal(resolveMacros(template, { ...base, worldState: tracked }), "2026-10-24|22:10|Saturday");
  assert.equal(resolveMacros(template, base), "||");
  assert.equal(resolveMacros("{{DATE.WORLD_STATE}}", { ...base, worldState: tracked }), tracked.date);
  assert.equal(
    resolveMacros('{{#if weekday.world_state == "Saturday"}}weekend{{else}}weekday{{/if}}', {
      ...base,
      worldState: tracked,
    }),
    "weekend",
  );
  assert.equal(
    resolveMacros('{{#if time.world_state == "22:10"}}night{{/if}}', { ...base, worldState: tracked }),
    "night",
  );
  for (const date of ["2026-02-30", "Year 6, Moon 2", "", null]) {
    assert.equal(resolveMacros("{{weekday.world_state}}", { ...base, worldState: { date } }), "");
  }
  assert.equal(
    resolveMacros("{{weekday.world_state}}", { ...base, worldState: { date: "monday, the third of Frostfall" } }),
    "Monday",
  );
  for (const fields of [
    [{ name: "Day of Week", value: "Moonwake" }],
    JSON.stringify([{ name: "Weekday", value: "Moonwake" }]),
  ]) {
    assert.equal(
      resolveMacros(template, { ...base, worldState: { date: "Year 6", time: "Dusk", worldCustomFields: fields } }),
      "Year 6|Dusk|Moonwake",
    );
  }
  assert.match(resolveMacros("{{date}}", { ...base, worldState: { date: "Fictional" } }), /^\d{4}-\d{2}-\d{2}$/u);
  const injected = { ...base, variables: {}, worldState: { date: "{{setvar::injected::yes}}", time: "$&" } };
  assert.equal(resolveMacros("{{date.world_state}}|{{time.world_state}}", injected), "{{setvar::injected::yes}}|$&");
  assert.deepEqual(injected.variables, {}, "Tracked text cannot execute macro writes");

  const connection = await createConnectionsStorage(db).create({
    name: "Clock fixture",
    provider: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiKey: "fixture",
    maxContext: 8192,
    maxTokensOverride: 256,
  });
  const prompts = createPromptsStorage(db);
  const preset = await prompts.create({ name: "Clock fixture", parameters: { maxTokens: 256, maxContext: 8192 } });
  await prompts.createSection({ presetId: preset.id, identifier: "clock", name: "Clock", content: template });
  await prompts.createSection({
    presetId: preset.id,
    identifier: "history",
    name: "History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  const chats = createChatsStorage(db);
  const chat = await chats.create({
    name: "World clock",
    mode: "roleplay",
    characterIds: [],
    connectionId: connection.id,
    promptPresetId: preset.id,
    personaId: null,
    groupId: null,
  });
  await chats.createMessage({ chatId: chat.id, role: "user", content: "Continue." });
  const message = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "First timeline." });
  const states = createGameStateStorage(db);
  const snapshot = {
    chatId: chat.id,
    messageId: message.id,
    swipeIndex: 0,
    ...tracked,
    location: null,
    weather: null,
    temperature: null,
    presentCharacters: [],
    recentEvents: [],
    playerStats: null,
    personaStats: null,
    committed: true,
  };
  await states.create(snapshot);
  await chats.addSwipe(message.id, "Other timeline.");
  await states.create({ ...snapshot, swipeIndex: 1, date: "2026-10-25", time: "07:00", committed: false });
  const contextArgs = { db, characterIds: [], personaName: "Mari", chatId: chat.id };
  assert.equal(resolveMacros(template, await buildPromptMacroContext(contextArgs)), "2026-10-24|22:10|Saturday");
  assert.equal(resolveMacros(template, await buildPromptMacroContext({ ...contextArgs, worldState: null })), "||");

  const agentContext = {
    chatId: chat.id,
    chatMode: "roleplay",
    recentMessages: [],
    mainResponse: null,
    characters: [],
    persona: null,
    gameState: { id: "fixture", createdAt: "2026-01-01", ...snapshot },
    memory: {},
    writableLorebookIds: null,
    chatSummary: null,
  } satisfies AgentContext;
  assert.equal(renderAgentPromptTemplate(template, {}, agentContext), "2026-10-24|22:10|Saturday");
  assert.equal(
    renderAgentPromptTemplate(
      "{{time.world_state}}",
      {},
      {
        ...agentContext,
        gameState: { ...agentContext.gameState, time: "<dusk>&night" },
      },
      { escapeValues: true },
    ),
    "&lt;dusk&gt;&amp;night",
  );

  const dry = async (expected: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/dryRun",
      payload: { chatId: chat.id, returnPrompt: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    const text = response
      .json()
      .prompt.messages.map((entry: { content: string }) => entry.content)
      .join("\n");
    assert.ok(text.includes(expected), text);
    assert.ok(!text.includes(".world_state}}"), text);
  };
  await chats.setActiveSwipe(message.id, 1);
  await dry("2026-10-25|07:00|Sunday");
  await chats.setActiveSwipe(message.id, 0);
  await dry("2026-10-24|22:10|Saturday");
  console.log(
    "World-state clock macros: literal/conditional, agent, stored-state, and selected-swipe preview checks passed",
  );
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
