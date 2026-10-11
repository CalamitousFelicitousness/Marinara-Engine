import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationRunner } from "../../packages/server/src/routes/generate.routes.js";

// #7430: every agent reads Roleplay whispers, marked as private, at their place in the story. Character
// responders keep receiving only their own, and hosted rooms keep whispers away from agents.
const dir = mkdtempSync(join(tmpdir(), "marinara-agent-whispers-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createGenerationEventSink } = await import("../../packages/server/src/routes/generate/sse.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
const { createAgentsStorage } = await import("../../packages/server/src/services/storage/agents.storage.js");
const { characterDataSchema, replaceBuiltInAgentDefinitions } = await import("../../packages/shared/dist/index.js");

const SENTINELS = ["PRE_AGENT_FIXTURE", "POST_AGENT_FIXTURE", "ROOM_TRACKER_FIXTURE"] as const;
const agentPrompts = new Map<string, string[]>(SENTINELS.map((sentinel) => [sentinel, []]));
const mainPrompts: string[] = [];
let outputs: string[] = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = JSON.stringify(body.messages);
  const sentinel = SENTINELS.find((candidate) => prompt.includes(candidate));
  if (sentinel) agentPrompts.get(sentinel)!.push(prompt);
  else mainPrompts.push(prompt);
  const content = sentinel === "ROOM_TRACKER_FIXTURE" ? "{}" : sentinel ? "Agent note." : outputs.shift();
  assert.notEqual(content, undefined, "unexpected provider request");
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }),
    );
  }
});
const latest = (sentinel: (typeof SENTINELS)[number]) => agentPrompts.get(sentinel)!.at(-1) ?? "";
const inOrder = (text: string, ...parts: string[]) =>
  parts.every(
    (part, index) => text.includes(part) && (index === 0 || text.indexOf(parts[index - 1]!) < text.indexOf(part)),
  );
const count = (text: string, part: string) => text.split(part).length - 1;

const db = await getDB();
const chats = createChatsStorage(db);
const characters = createCharactersStorage(db);
const agents = createAgentsStorage(db);
const app = Fastify();
app.decorate("db", db);
let runner: GenerationRunner | undefined;
await app.register(generateRoutes, { prefix: "/api/generate", onRunnerReady: (ready) => (runner = ready) });
try {
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  assert(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Agent whisper fixture",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "fixture",
    maxContext: 32768,
    maxTokensOverride: 512,
  });
  assert(connection);
  const [alice, bob] = await Promise.all(
    ["Alice", "Bob"].map((name) => characters.create(characterDataSchema.parse({ name }))),
  );
  assert(alice && bob);
  const persona = await characters.createPersona("Mari", "The player.");
  assert(persona);
  const presets = createPromptsStorage(db);
  const preset = await presets.create({
    name: "Agent whisper fixture",
    parameters: { maxTokens: 512, maxContext: 32768, strictRoleFormatting: true },
    wrapFormat: "xml",
  });
  assert(preset);
  await presets.createSection({
    presetId: preset.id,
    identifier: "rules",
    name: "Rules",
    content: "Respond as {{char}}.",
  });
  await presets.createSection({
    presetId: preset.id,
    identifier: "history",
    name: "Chat History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  // An Echo Chamber-like reader before the reply (with the main prompt preview) and a tracker-like one after it.
  const pre = await agents.create({
    type: "custom-whisper-pre",
    name: "Whisper reader before",
    phase: "pre_generation",
    connectionId: connection.id,
    promptTemplate: "PRE_AGENT_FIXTURE React to the latest message.",
    settings: { resultType: "context_injection", contextSize: 10, capabilities: { edit_main_prompt: true } },
  });
  const post = await agents.create({
    type: "custom-whisper-post",
    name: "Whisper reader after",
    phase: "post_processing",
    connectionId: connection.id,
    promptTemplate: "POST_AGENT_FIXTURE Note what happened.",
    settings: { resultType: "context_injection", contextSize: 10 },
  });
  assert(pre && post);
  const chat = await chats.create({
    name: "Agents see whispers",
    mode: "roleplay",
    characterIds: [alice.id, bob.id],
    personaId: persona.id,
    connectionId: connection.id,
    promptPresetId: preset.id,
  });
  assert(chat);
  await chats.patchMetadata(chat.id, {
    enableAgents: true,
    activeAgentIds: [pre.type, post.type],
    enableTools: false,
    enableMemoryRecall: false,
    roleplayCommandsEnabled: true,
    roleplayCommandToggles: { whisper: true },
    groupChatMode: "individual",
    groupResponseOrder: "manual",
  });
  await chats.createMessage({ chatId: chat.id, role: "user", content: "Opening line." });
  const generate = async (output: string, forCharacterId: string, options: Record<string, unknown> = {}) => {
    outputs = [output];
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, forCharacterId, ...options },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert(!response.body.includes('"type":"error"'), response.body);
    assert.equal(outputs.length, 0);
  };

  // The reply being generated: a post-generation agent reads its whispers in place, labeled with each recipient.
  await generate(
    'Before. [whisper: character="Bob" text="REPLY_SECRET"] After. [whisper: character="Mari" text="PERSONA_SECRET"]',
    alice.id,
  );
  const replyPost = latest("POST_AGENT_FIXTURE");
  assert(
    inOrder(
      replyPost,
      "Before.",
      "[Private whisper to Bob: REPLY_SECRET]",
      "After.",
      "[Private whisper to Mari: PERSONA_SECRET]",
    ),
    replyPost,
  );
  assert(!mainPrompts.at(-1)!.includes("REPLY_SECRET"), "the writer's own prompt never held the secret");

  // A whisper the user just typed, with no other text, reaches a pre-generation agent as the whisper itself,
  // and the earlier reply's whisper keeps its place in the agent's history and in the main prompt preview.
  await generate("Alice shrugs.", alice.id, { userMessage: '[whisper: character="Bob" text="USER_SECRET"]' });
  const echo = latest("PRE_AGENT_FIXTURE");
  assert(echo.includes("[Private whisper to Bob: USER_SECRET]"), echo);
  assert(!echo.includes("[Private whisper]"), "a whisper-only message reads as its whisper, not a placeholder");
  assert(inOrder(echo, "Before.", "[Private whisper to Bob: REPLY_SECRET]", "After."), echo);
  assert(echo.includes("<main_generation_prompt_preview>"), "the agent also reads the main prompt preview");
  assert.equal(
    count(echo, "[Private whisper to Bob: REPLY_SECRET]"),
    2,
    "once in the agent's history and once in the preview, never inserted twice",
  );
  // The responder in that same request is not a recipient and still gets none of them.
  const aliceView = mainPrompts.at(-1)!;
  for (const secret of ["USER_SECRET", "REPLY_SECRET", "PERSONA_SECRET"])
    assert(!aliceView.includes(secret), `${secret} stays out of a non-recipient's prompt`);
  await generate("Bob nods.", bob.id);
  const bobView = mainPrompts.at(-1)!;
  assert(bobView.includes("USER_SECRET") && bobView.includes("REPLY_SECRET"), "the recipient keeps its whispers");
  assert(!bobView.includes("PERSONA_SECRET") && !bobView.includes("[Private whisper to Bob:"));

  // Deleted and failed whispers are not live, so no agent reads them.
  const whisper = (text: string, extra: Record<string, unknown>) => ({
    command: { type: "whisper", character: "Bob", text },
    raw: `[whisper: character="Bob" text="${text}"]`,
    whisperRecipient: { id: bob.id, kind: "character" },
    contentOffset: 6,
    contentAnchor: "Plain.",
    ...extra,
  });
  await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: alice.id,
    content: "Plain.",
    extra: {
      roleplayCommandActivity: [
        whisper("DELETED_SECRET", { deleted: true }),
        whisper("FAILED_SECRET", { error: "roleplay.commands.errors.whisperRecipient" }),
        whisper("LIVE_SECRET", {}),
      ],
    },
  });
  await generate("Alice waits.", alice.id);
  const afterEdits = latest("PRE_AGENT_FIXTURE");
  assert(inOrder(afterEdits, "Plain.", "[Private whisper to Bob: LIVE_SECRET]"), afterEdits);
  assert(!afterEdits.includes("DELETED_SECRET") && !afterEdits.includes("FAILED_SECRET"));

  // Retried agents read them too.
  const retry = await app.inject({
    method: "POST",
    url: "/api/generate/retry-agents",
    payload: { chatId: chat.id, agentTypes: [post.type] },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  const retried = latest("POST_AGENT_FIXTURE");
  assert(retried.includes("[Private whisper to Bob: USER_SECRET]"), retried);
  assert(inOrder(retried, "Plain.", "[Private whisper to Bob: LIVE_SECRET]"), retried);

  // A hosted room shows agent output to every participant, so its agents get no whispers.
  replaceBuiltInAgentDefinitions([
    {
      id: "world-state",
      name: "World State",
      description: "Synthetic tracker",
      phase: "post_processing" as const,
      enabledByDefault: false,
      category: "tracker" as const,
      defaultTools: [],
      defaultPromptTemplate: "ROOM_TRACKER_FIXTURE Return JSON.",
    },
  ]);
  await agents.create({
    type: "world-state",
    name: "World State",
    phase: "post_processing",
    connectionId: connection.id,
    promptTemplate: "ROOM_TRACKER_FIXTURE Return JSON.",
  });
  const roomChat = await chats.create({
    name: "Hosted room",
    mode: "roleplay",
    characterIds: [alice.id, bob.id],
    connectionId: connection.id,
    promptPresetId: preset.id,
  });
  assert(roomChat);
  const authority = { roomId: "room_12345", epoch: "epoch_12345", operationId: "operation_12345" };
  const room = {
    version: 1,
    role: "host",
    roomId: authority.roomId,
    epoch: authority.epoch,
    generationOperationId: authority.operationId,
    status: "active",
    characters: [
      { id: alice.id, name: "Alice", role: "character" },
      { id: bob.id, name: "Bob", role: "character" },
    ],
    participants: [
      { id: "host_12345", displayName: "Mari", persona: { name: "Mari", description: "The host." }, isHost: true },
    ],
  };
  await chats.patchMetadata(roomChat.id, {
    enableAgents: true,
    activeAgentIds: ["world-state"],
    enableTools: false,
    enableMemoryRecall: false,
    roleplayCommandsEnabled: true,
    roleplayCommandToggles: { whisper: true },
    groupChatMode: "individual",
    groupResponseOrder: "manual",
  });
  await chats.createMessage({
    chatId: roomChat.id,
    role: "user",
    content: 'The door creaks. [whisper: character="Alice" text="ROOM_SECRET"]',
  });
  await chats.patchMetadata(roomChat.id, { multiplayer: room });
  let roomStatus = 0;
  const roomErrors: unknown[] = [];
  outputs = ["Bob looks up."];
  await runner!(
    { chatId: roomChat.id, forCharacterId: bob.id, streaming: false },
    createGenerationEventSink({
      onEvent: (event) => {
        if (event.type === "error") roomErrors.push(event);
      },
      onFinish: ({ statusCode }) => {
        roomStatus = statusCode;
      },
    }),
    authority,
  );
  assert.equal(roomStatus, 200);
  assert.deepEqual(roomErrors, []);
  const roomTracker = latest("ROOM_TRACKER_FIXTURE");
  assert(roomTracker.includes("The door creaks."), "the room's tracker ran on the room's history");
  assert(!roomTracker.includes("ROOM_SECRET"), "a room's agents never read a whisper");
  // The same chat as a private chat again: its agents read the whisper.
  await chats.patchMetadata(roomChat.id, { multiplayer: { ...room, status: "ended" } });
  outputs = ["Bob looks away."];
  const ended = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: roomChat.id, forCharacterId: bob.id },
  });
  assert.equal(ended.statusCode, 200, ended.body);
  assert(latest("ROOM_TRACKER_FIXTURE").includes("[Private whisper to Alice: ROOM_SECRET]"));
  assert(!mainPrompts.at(-1)!.includes("ROOM_SECRET"), "Bob is still not a recipient");
  console.log(
    "Agents see whispers passed: post-generation reply whispers, whisper-only user turns, history placement, preview without double insertion, responder privacy, dead whispers, retries and hosted rooms.",
  );
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((done) => provider.close(() => done()));
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
