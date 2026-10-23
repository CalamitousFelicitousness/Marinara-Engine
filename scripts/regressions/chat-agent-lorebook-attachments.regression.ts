import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marinara-agent-lorebooks-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createAgentsStorage } = await import("../../packages/server/src/services/storage/agents.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { resolvePackageAgentLorebookEntries } =
  await import("../../packages/server/src/services/capability-packages/capability-agent-lorebook.service.js");
const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
const { replaceBuiltInAgentDefinitions } = await import("../../packages/shared/dist/index.js");
const { applyAgentLorebookChatSettings } =
  await import("../../packages/server/src/services/generation/agent-lorebook-triggers.js");

const manifests = ["writer", "tracker"].map((category) => ({
  id: `reference-${category}`,
  name: `Reference ${category}`,
  description: "Isolated lorebook regression",
  category: category as "writer" | "tracker",
  phase: "post_processing" as const,
  enabledByDefault: false,
  defaultPromptTemplate: `REFERENCE_${category.toUpperCase()}_TASK`,
}));
replaceBuiltInAgentDefinitions(manifests);
const prompts: string[] = [];
OpenAIProvider.prototype.chat = async function* (messages) {
  prompts.push(messages.map((message) => String(message.content)).join("\n"));
  yield "The crystal remains quiet.";
  return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
};
OpenAIProvider.prototype.chatComplete = async (messages) => {
  const text = messages.map((message) => String(message.content)).join("\n");
  prompts.push(text);
  const ids = [...text.matchAll(/<agent_task id="([^"]+)"/gu)].map((match) => match[1]!);
  return {
    content: ids.length
      ? JSON.stringify(Object.fromEntries(ids.map((id) => [id, { text: "Reference checked." }])))
      : JSON.stringify({ text: "Reference checked." }),
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
};
const db = await getDB();
const chats = createChatsStorage(db);
const agents = createAgentsStorage(db);
const books = createLorebooksStorage(db);
const app = require("fastify")();
app.decorate("db", db);
app.decorate("activeGenerations", new Map());
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(generateRoutes, { prefix: "/api/generate" });
try {
  const connection = await createConnectionsStorage(db).create({
    name: "Reference fixture",
    provider: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture-model",
    apiKey: "fixture",
  });
  const configs = await Promise.all(
    [...manifests.map((item) => item.id), "custom-reference"].map((type) =>
      agents.create({
        type,
        name: type,
        phase: "post_processing",
        connectionId: connection.id,
        promptTemplate: `REFERENCE_TASK_${type}`,
        settings: { resultType: "context_injection", batchWithOtherAgents: false, contextSize: 5 },
      }),
    ),
  );
  assert(configs.every(Boolean));
  const firstBook = await books.create({ name: "Writer reference" });
  const secondBook = await books.create({ name: "Tracker reference" });
  assert(firstBook && secondBook);
  await books.createEntry({
    lorebookId: firstBook.id,
    name: "Writer fact",
    keys: ["crystal"],
    content: "WRITER_BOOK_SECRET",
    generationTriggerFilterMode: "include",
    generationTriggerFilters: ["chat"],
  });
  await books.createEntry({
    lorebookId: secondBook.id,
    name: "Tracker fact",
    keys: ["crystal"],
    content: "TRACKER_BOOK_SECRET",
  });
  await books.createEntry({
    lorebookId: firstBook.id,
    name: "Unmatched",
    keys: ["unspoken-key"],
    content: "UNMATCHED_SECRET",
  });
  const chat = await chats.create({
    name: "Agent references",
    mode: "roleplay",
    characterIds: [],
    connectionId: connection.id,
  });
  const otherChat = await chats.create({
    name: "Other chat",
    mode: "roleplay",
    characterIds: [],
    connectionId: connection.id,
  });
  assert(chat && otherChat);
  const types = configs.map((config) => config!.type);
  await chats.patchMetadata(chat.id, { enableAgents: true, activeAgentIds: types, enableTools: false });
  const patch = (id: string, attachments: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/api/chats/${id}/metadata`,
      payload: { agentLorebookAttachments: attachments },
    });
  const patches = await Promise.all([
    patch(chat.id, { [types[0]!]: { enabled: true, lorebookId: firstBook.id } }),
    patch(chat.id, { [types[1]!]: { enabled: true, lorebookId: secondBook.id } }),
  ]);
  assert(patches.every((response) => response.statusCode === 200));
  const loaded = (await app.inject({ method: "GET", url: `/api/chats/${chat.id}` })).json();
  assert.equal(
    Object.keys(loaded.metadata.agentLorebookAttachments).length,
    2,
    "concurrent per-agent patches preserve both selections",
  );
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/chats/${otherChat.id}` })).json().metadata.agentLorebookAttachments,
    undefined,
  );
  for (const invalid of [
    [],
    { broken: { enabled: "yes", lorebookId: firstBook.id } },
    { broken: { enabled: true, lorebookId: "" } },
  ]) {
    assert.equal((await patch(chat.id, invalid)).statusCode, 400);
  }
  await chats.createMessage({ chatId: chat.id, role: "user", content: "Inspect the crystal." });
  const firstReply = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "The crystal waits." });
  assert(firstReply);
  const retry = async (agentTypes = types, options: Record<string, unknown> = {}) => {
    prompts.length = 0;
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/retry-agents",
      payload: { chatId: chat.id, agentTypes, ...options },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert(!response.body.includes('"type":"error"'), response.body);
  };
  await retry();
  const writer = prompts.find((prompt) => prompt.includes(`REFERENCE_TASK_${types[0]}`));
  const tracker = prompts.find((prompt) => prompt.includes(`REFERENCE_TASK_${types[1]}`));
  const custom = prompts.find((prompt) => prompt.includes("REFERENCE_TASK_custom-reference"));
  assert(writer && tracker && custom);
  assert.match(writer, /WRITER_BOOK_SECRET/u);
  assert.doesNotMatch(writer, /TRACKER_BOOK_SECRET|UNMATCHED_SECRET/u);
  assert.match(tracker, /TRACKER_BOOK_SECRET/u);
  assert.doesNotMatch(tracker, /WRITER_BOOK_SECRET|UNMATCHED_SECRET/u);
  assert.doesNotMatch(custom, /WRITER_BOOK_SECRET|TRACKER_BOOK_SECRET/u);
  await patch(chat.id, { [types[2]!]: { enabled: true, lorebookId: firstBook.id } });
  await retry([types[2]!]);
  assert(
    prompts.some((prompt) => prompt.includes("WRITER_BOOK_SECRET")),
    "custom agents use the same attachment path",
  );
  await agents.update(configs[2]!.id, { phase: "pre_generation" });
  await retry([types[2]!], { forMessageId: firstReply.id });
  assert(
    prompts.some((prompt) => prompt.includes("WRITER_BOOK_SECRET")),
    "historical pre-generation retry retains the target turn's chat trigger",
  );
  await agents.update(configs[2]!.id, { phase: "post_processing" });
  await patch(chat.id, { [types[0]!]: { enabled: false, lorebookId: firstBook.id } });
  await retry([types[0]!]);
  assert(prompts.every((prompt) => !prompt.includes("WRITER_BOOK_SECRET")));
  await patch(chat.id, { [types[0]!]: { enabled: true, lorebookId: "missing-book" } });
  await retry([types[0]!]);
  assert(
    prompts.every((prompt) => !prompt.includes("WRITER_BOOK_SECRET")),
    "unavailable books never fall back to chat-wide sources",
  );
  await patch(chat.id, { [types[0]!]: { enabled: true, lorebookId: firstBook.id } });
  await Promise.all(
    [configs[0], configs[2]].map((config) =>
      agents.update(config!.id, {
        settings: { resultType: "context_injection", batchWithOtherAgents: true, contextSize: 5 },
      }),
    ),
  );
  // Roleplay deliberately separates tracker contexts; a writer and custom agent can share a batch.
  await patch(chat.id, { [types[2]!]: { enabled: true, lorebookId: secondBook.id } });
  await retry([types[0]!, types[2]!]);
  assert.equal(prompts.length, 1, "grouped agents share one model call");
  assert.match(prompts[0]!, /WRITER_BOOK_SECRET/u);
  assert.match(prompts[0]!, /TRACKER_BOOK_SECRET/u);
  assert.doesNotMatch(prompts[0]!, /UNMATCHED_SECRET/u);
  prompts.length = 0;
  const generated = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: chat.id, userMessage: "Inspect the crystal again." },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  assert(!generated.body.includes('"type":"error"'), generated.body);
  const mainCalls = prompts.filter((prompt) => !prompt.includes("REFERENCE_TASK_"));
  assert(mainCalls.length > 0, "normal generation calls the main responder");
  assert(mainCalls.every((prompt) => !/WRITER_BOOK_SECRET|TRACKER_BOOK_SECRET/u.test(prompt)));
  assert(prompts.some((prompt) => /REFERENCE_TASK_/u.test(prompt) && prompt.includes("WRITER_BOOK_SECRET")));
  assert(prompts.some((prompt) => /REFERENCE_TASK_/u.test(prompt) && prompt.includes("TRACKER_BOOK_SECRET")));
  const attached = await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id });
  assert(attached.some((entry) => entry.content === "WRITER_BOOK_SECRET"));
  assert(
    attached.every((entry) => !entry.content.includes("TRACKER_BOOK_SECRET")),
    "package feature calls cannot select another agent's attachment",
  );
  assert.deepEqual(await resolvePackageAgentLorebookEntries(db, "other-package", { chatId: chat.id }), []);
  assert.deepEqual(await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: otherChat.id }), []);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id, signal: aborted.signal }), {
    name: "AbortError",
  });
  await patch(chat.id, { [types[0]!]: { enabled: false, lorebookId: firstBook.id } });
  assert.deepEqual(await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id }), []);
  await patch(chat.id, { [types[0]!]: { enabled: true, lorebookId: "missing" } });
  assert.deepEqual(await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id }), []);
  await patch(chat.id, { [types[0]!]: { enabled: true, lorebookId: firstBook.id } });
  await books.update(firstBook.id, { enabled: false });
  assert.deepEqual(await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id }), []);
  await books.update(firstBook.id, { enabled: true });
  await books.createEntry({
    lorebookId: firstBook.id,
    name: "Macro reference",
    keys: ["crystal"],
    content: "The {{user}} keeps {{getvar::reference}}.",
  });
  await chats.patchMetadata(chat.id, { macroVariables: { reference: "a map" } });
  assert(
    (await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id })).some(
      (entry) => entry.content === "The User keeps a map.",
    ),
    "package reference content uses chat macros",
  );
  await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "A silent room.",
    extra: { isConversationStart: true },
  });
  await chats.createMessage({ chatId: chat.id, role: "user", content: "crystal", extra: { hiddenFromAI: true } });
  assert.deepEqual(
    await resolvePackageAgentLorebookEntries(db, types[0]!, { chatId: chat.id }),
    [],
    "past-start and hidden messages cannot trigger package references",
  );
  await chats.patchMetadata(otherChat.id, {
    enableAgents: true,
    activeAgentIds: [types[0]!],
    agentLorebookAttachments: { [types[0]!]: { enabled: true, lorebookId: firstBook.id } },
  });
  await chats.createMessage({ chatId: otherChat.id, role: "assistant", content: "The crystal continues." });
  await retry([types[0]!], { chatId: otherChat.id });
  assert(
    prompts.every((prompt) => !prompt.includes("WRITER_BOOK_SECRET")),
    "an assistant-only continuation does not activate chat-only entries",
  );
  for (const config of configs)
    assert(
      !JSON.parse((await agents.getById(config!.id))!.settings as string).chatLorebookAttachmentEnabled,
      "chat overrides never modify global definitions",
    );
  const settings = { contextSize: 8 };
  assert.equal(applyAgentLorebookChatSettings(types[0]!, settings, {}), settings);
  console.info(
    "PASS: chat-scoped lorebook persistence, validation, triggering, isolation, custom agents, disabling, missing books and grouped retries",
  );
} finally {
  await app.close();
  await closeDB();
  rmSync(directory, { recursive: true, force: true });
}
