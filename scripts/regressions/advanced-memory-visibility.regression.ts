// Advanced Memory decides who sees each new message in individual group chats (#7192).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-auto-visibility-"));
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
const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");
const { DEFAULT_ADVANCED_MEMORY_SETTINGS, characterDataSchema } = await import("../../packages/shared/dist/index.js");

type Call = { kind: "main" | "visibility" | "scene" | "scene+visibility" | "other"; prompt: string };
const calls: Call[] = [];
const decisionRequests: Array<{ state: Record<string, any>; questions: Record<string, { instructions: string }> }> = [];
const ids = { maukie: "", pantalone: "", narrator: "" };
let failVisibility = false;
let dropPresence = false;
let mainReplies: string[] = [];

/** The fake helper keeps Maukie (by first name only) and leaves Pantalone out of every scene. */
function presence(task: { decide: Array<{ messageNumber: number; candidates: string[] }> }) {
  return task.decide.map(({ messageNumber, candidates }) => ({
    messageNumber,
    present: Object.fromEntries(
      candidates.map((name) => [name.split(" ")[0]!.toUpperCase(), !name.startsWith("Pantalone")]),
    ),
  }));
}

const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
  if (req.url?.endsWith("/systemone")) {
    decisionRequests.push(body);
    res.end(
      JSON.stringify({
        answers: Object.fromEntries(
          Object.keys(body.questions)
            .filter((id) => !dropPresence || !id.startsWith("presence:"))
            .map((id) => [
              id,
              { type: "noul", noul: id.startsWith("presence:") && !id.endsWith(ids.pantalone) ? 0.99 : 0.01 },
            ]),
        ),
      }),
    );
    return;
  }
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  const scene = system.includes("Identify scene transitions");
  const visibility = system.includes("Decide which characters can perceive");
  const kind: Call["kind"] =
    scene && visibility ? "scene+visibility" : scene ? "scene" : visibility ? "visibility" : "main";
  calls.push({ kind, prompt: JSON.stringify(messages) });
  const user = messages.at(-1)?.content ?? "";
  let content: string;
  if (kind === "main") content = mainReplies.shift() ?? "A quiet reply.";
  else if (kind === "visibility") content = JSON.stringify({ visibility: presence(JSON.parse(user)) });
  else if (kind === "scene+visibility")
    content = JSON.stringify({ ends: [], visibility: presence(JSON.parse(user.split("Presence task:\n")[1]!)) });
  else content = system.includes('"ends"') ? '{"ends":[]}' : '{"starts":[]}';
  if (body.stream) {
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  res.end(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: failVisibility && kind === "visibility" ? "length" : "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    }),
  );
});

const db = await getDB();
const chats = createChatsStorage(db);
const memory = createAdvancedMemoryService(db);
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
await app.register(chatsRoutes, { prefix: "/api/chats" });
try {
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const connections = createConnectionsStorage(db);
  const connection = await connections.create({
    name: "Visibility fixture",
    provider: "custom",
    model: "fixture",
    apiKey: "fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxContext: 16_384,
    maxTokensOverride: 1024,
  });
  const decisionConnection = await connections.create({
    name: "Visibility Jev",
    provider: "decision",
    decisionSource: "custom",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "jev-fixture",
    apiKey: "",
  });
  const characters = createCharactersStorage(db);
  for (const [key, name] of [
    ["maukie", "Maukie Whiskers"],
    ["pantalone", "Pantalone"],
    ["narrator", "Narrator"],
  ] as const) {
    const created = await characters.create(characterDataSchema.parse({ name }));
    assert(created);
    ids[key] = created.id;
  }

  const createChat = async (settings: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => {
    const chat = await chats.create({
      name: "Visibility",
      mode: "roleplay",
      characterIds: [ids.maukie, ids.pantalone, ids.narrator],
      connectionId: connection.id,
    });
    assert(chat);
    await chats.patchMetadata(chat.id, {
      enableAgents: false,
      groupChatMode: "individual",
      advancedMemory: {
        ...DEFAULT_ADVANCED_MEMORY_SETTINGS,
        enabled: true,
        maxContextTokens: 16_384,
        helperConnectionId: connection.id,
        narratorCharacterId: ids.narrator,
        autoMessageVisibility: true,
        sceneCheckInterval: 50,
        knowledgeStarts: { [ids.maukie]: null, [ids.pantalone]: null, [ids.narrator]: null },
        knowledgeConfirmed: true,
        ...settings,
      },
      ...metadata,
    });
    return chat.id;
  };
  const say = (
    chatId: string,
    role: "user" | "assistant",
    content: string,
    characterId: string | null = null,
    extra = {},
  ) =>
    chats.createMessage({
      chatId,
      role,
      characterId,
      content,
      extra: role === "user" ? { personaSnapshot: { personaId: "p", name: "P" }, ...extra } : extra,
    });
  const extraOf = async (messageId: string) => {
    const message = await chats.getMessage(messageId);
    return (typeof message!.extra === "string" ? JSON.parse(message!.extra) : message!.extra) as Record<string, any>;
  };

  // Helper path: each new message is hidden from the absent Pantalone only.
  const helperChat = await createChat();
  const greeting = await say(helperChat, "user", "P waves at Maukie across the tavern.");
  const maukieReply = await say(helperChat, "assistant", "Maukie purrs back.", ids.maukie);
  const pantaloneLine = await say(helperChat, "assistant", "Pantalone counts coins far away.", ids.pantalone);
  calls.length = 0;
  await memory.settleMessageVisibility(helperChat);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["visibility"],
    "one helper call decides every undecided recent message",
  );
  const task = JSON.parse(JSON.parse(calls[0]!.prompt)[1].content);
  assert.deepEqual(task.recentlyActive, ["Maukie Whiskers", "Pantalone"], "speakers since the scene began are a hint");
  assert(
    task.decide.every((entry: { candidates: string[] }) => !entry.candidates.includes("Narrator")),
    "the narrator is never a candidate",
  );
  assert.deepEqual((await extraOf(greeting.id)).hiddenFromAICharacterIds, [ids.pantalone]);
  assert.deepEqual(
    (await extraOf(maukieReply.id)).hiddenFromAICharacterIds,
    [ids.pantalone],
    "first-name, upper-case answers still map to the right characters",
  );
  const ownLine = await extraOf(pantaloneLine.id);
  assert.equal(ownLine.hiddenFromAICharacterIds, undefined, "the author always sees their own message");
  assert.deepEqual(ownLine.autoVisibility.hiddenCharacterIds, [], "a message everyone sees is still decided once");
  for (const swipe of await chats.getSwipes(maukieReply.id))
    assert.deepEqual(
      (typeof swipe.extra === "string" ? JSON.parse(swipe.extra) : swipe.extra).hiddenFromAICharacterIds,
      [ids.pantalone],
      "swipes stay in sync",
    );
  calls.length = 0;
  await memory.settleMessageVisibility(helperChat);
  assert.equal(calls.length, 0, "decided messages are never asked about again");

  // A manual change wins, before or after automation.
  const unhidden = await app.inject({
    method: "PATCH",
    url: `/api/chats/${helperChat}/messages/${maukieReply.id}/extra`,
    payload: { hiddenFromAI: false, hiddenFromAICharacterIds: [] },
  });
  assert.equal(unhidden.statusCode, 200, unhidden.body);
  const manualBefore = await say(helperChat, "assistant", "Maukie stretches.", ids.maukie);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/chats/${helperChat}/messages/${manualBefore.id}/extra`,
        payload: { hiddenFromAICharacterIds: [] },
      })
    ).statusCode,
    200,
  );
  const presetHide = await say(helperChat, "assistant", "Maukie whispers.", ids.maukie, {
    hiddenFromAICharacterIds: [ids.narrator],
  });
  const later = await say(helperChat, "user", "P orders a drink.");
  calls.length = 0;
  await memory.settleMessageVisibility(helperChat);
  const laterTask = JSON.parse(JSON.parse(calls[0]!.prompt)[1].content);
  const numbers = new Map((await chats.listMessages(helperChat)).map((message, index) => [message.id, index + 1]));
  assert.deepEqual(
    laterTask.decide.map((entry: { messageNumber: number }) => entry.messageNumber),
    [numbers.get(later.id)],
    "manual and pre-existing visibility choices are not asked about",
  );
  assert.deepEqual((await extraOf(maukieReply.id)).hiddenFromAICharacterIds, [], "a later run keeps the user's unhide");
  assert.equal((await extraOf(maukieReply.id)).visibilityManual, true);
  assert.deepEqual((await extraOf(manualBefore.id)).hiddenFromAICharacterIds, []);
  assert.equal((await extraOf(manualBefore.id)).autoVisibility, undefined);
  assert.deepEqual((await extraOf(presetHide.id)).hiddenFromAICharacterIds, [ids.narrator]);
  assert.deepEqual((await extraOf(later.id)).hiddenFromAICharacterIds, [ids.pantalone]);

  // A failed decision hides nothing.
  failVisibility = true;
  const failed = await say(helperChat, "user", "P sings loudly.");
  await memory.settleMessageVisibility(helperChat);
  failVisibility = false;
  assert.equal((await extraOf(failed.id)).hiddenFromAICharacterIds, undefined);
  assert.deepEqual((await extraOf(failed.id)).autoVisibility.hiddenCharacterIds, []);

  // A whisper's recipient keeps the message that carries the whisper.
  const whisper = { type: "whisper", character: "Pantalone", text: "Meet me at dawn." };
  const whispered = await say(helperChat, "user", "P glances at the window.", null, {
    roleplayCommandActivity: [
      { raw: JSON.stringify(whisper), command: whisper, whisperRecipient: { id: ids.pantalone, kind: "character" } },
    ],
  });
  calls.length = 0;
  await memory.settleMessageVisibility(helperChat);
  assert.deepEqual(JSON.parse(JSON.parse(calls[0]!.prompt)[1].content).decide[0].candidates, ["Maukie Whiskers"]);
  assert.equal((await extraOf(whispered.id)).hiddenFromAICharacterIds, undefined);

  // Off, merged mode and one-character chats make no extra call.
  const offChat = await createChat({ autoMessageVisibility: false });
  const mergedChat = await createChat({}, { groupChatMode: "merged" });
  const soloChat = await chats.create({
    name: "Solo",
    mode: "roleplay",
    characterIds: [ids.maukie],
    connectionId: connection.id,
  });
  assert(soloChat);
  await chats.patchMetadata(soloChat.id, {
    groupChatMode: "individual",
    advancedMemory: { ...DEFAULT_ADVANCED_MEMORY_SETTINGS, enabled: true, autoMessageVisibility: true },
  });
  calls.length = 0;
  for (const chatId of [offChat, mergedChat, soloChat.id]) {
    const message = await say(chatId, "user", "P waves.");
    await memory.settleMessageVisibility(chatId);
    await memory.checkScenesAfterGeneration(chatId);
    const extra = await extraOf(message.id);
    assert.equal(extra.autoVisibility, undefined);
    assert.equal(extra.hiddenFromAICharacterIds, undefined);
  }
  assert(!calls.some((call) => call.kind.includes("visibility")), "no visibility call without the toggle");

  // Without a Decision model, a due helper scene check also answers presence in the same call.
  const sharedHelperChat = await createChat({ sceneCheckInterval: 1 });
  const sharedHelperMessage = await say(sharedHelperChat, "user", "P sits beside Maukie.");
  calls.length = 0;
  await memory.checkScenesAfterGeneration(sharedHelperChat);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["scene+visibility"],
  );
  assert.deepEqual((await extraOf(sharedHelperMessage.id)).hiddenFromAICharacterIds, [ids.pantalone]);
  const sharedState = JSON.parse((await chats.getById(sharedHelperChat))!.metadata).advancedMemoryState;
  assert.equal(sharedState.sceneCheckMessageId, sharedHelperMessage.id, "the shared scene check still commits");

  // Decision model: presence questions ride along with the scene-end check, or go alone when it is not due.
  const jevChat = await createChat({
    decisionEnabled: true,
    decisionConnectionId: decisionConnection.id,
    sceneCheckInterval: 1,
  });
  const jevMessage = await say(jevChat, "user", "P pours tea for Maukie.");
  decisionRequests.length = 0;
  calls.length = 0;
  await memory.checkScenesAfterGeneration(jevChat);
  assert.equal(decisionRequests.length, 1, "one Decision request answers the scene end and presence");
  const questionIds = Object.keys(decisionRequests[0]!.questions);
  assert(questionIds.includes(jevMessage.id), "the scene-end question is asked");
  assert.deepEqual(
    questionIds.filter((id) => id.startsWith("presence:")).sort(),
    [`presence:${jevMessage.id}:${ids.maukie}`, `presence:${jevMessage.id}:${ids.pantalone}`].sort(),
  );
  assert(decisionRequests[0]!.state.transcript && decisionRequests[0]!.state.presence.transcript);
  assert.equal(calls.length, 0, "the Decision model, not the helper, decides presence");
  assert.deepEqual((await extraOf(jevMessage.id)).hiddenFromAICharacterIds, [ids.pantalone]);
  dropPresence = true;
  const unanswered = await say(jevChat, "user", "P hums.");
  decisionRequests.length = 0;
  await memory.checkScenesAfterGeneration(jevChat);
  dropPresence = false;
  assert.equal(decisionRequests.length, 2, "an unusable presence answer retries the scene check alone");
  assert(Object.keys(decisionRequests[1]!.questions).every((id) => !id.startsWith("presence:")));
  assert.equal(calls.length, 0, "the scene check does not fall back to the helper");
  assert.equal(
    JSON.parse((await chats.getById(jevChat))!.metadata).advancedMemoryState.sceneCheckMessageId,
    unanswered.id,
  );
  assert.equal((await extraOf(unanswered.id)).hiddenFromAICharacterIds, undefined, "no presence answer hides nothing");
  await memory.updateSettings(jevChat, { sceneCheckInterval: 50 });
  const jevAlone = await say(jevChat, "assistant", "Maukie sips.", ids.maukie);
  decisionRequests.length = 0;
  await memory.checkScenesAfterGeneration(jevChat);
  assert.equal(decisionRequests.length, 1);
  assert(Object.keys(decisionRequests[0]!.questions).every((id) => id.startsWith("presence:")));
  assert.deepEqual((await extraOf(jevAlone.id)).hiddenFromAICharacterIds, [ids.pantalone]);

  // The generation guard decides earlier messages before each character's context is built.
  const routeChat = await createChat();
  await memory.initialize(routeChat);
  const undecided = await say(routeChat, "user", "UNDECIDED_PERSONA_LINE");
  calls.length = 0;
  mainReplies = ["MAUKIE_REPLY", "PANTALONE_REPLY", "NARRATOR_REPLY"];
  const generated = await app.inject({ method: "POST", url: "/api/generate/", payload: { chatId: routeChat } });
  assert.equal(generated.statusCode, 200, generated.body);
  assert(!generated.body.includes('"type":"error"'), generated.body);
  const kinds = calls.map((call) => call.kind);
  assert.deepEqual(
    kinds.slice(0, 5),
    ["visibility", "main", "visibility", "main", "visibility"],
    "visibility settles before every character replies",
  );
  const mains = calls.filter((call) => call.kind === "main");
  assert.equal(mains.length, 3);
  assert.deepEqual((await extraOf(undecided.id)).hiddenFromAICharacterIds, [ids.pantalone]);
  assert(mains[0]!.prompt.includes("UNDECIDED_PERSONA_LINE"), "Maukie is present");
  assert(!mains[1]!.prompt.includes("UNDECIDED_PERSONA_LINE"), "Pantalone never receives the earlier line");
  assert(!mains[1]!.prompt.includes("MAUKIE_REPLY"), "nor Maukie's reply from the same turn");
  assert(mains[2]!.prompt.includes("UNDECIDED_PERSONA_LINE") && mains[2]!.prompt.includes("MAUKIE_REPLY"));
  const routeMessages = await chats.listMessages(routeChat);
  for (const message of routeMessages)
    assert(
      !(await extraOf(message.id)).hiddenFromAICharacterIds?.includes(ids.narrator),
      "the narrator is never hidden from",
    );
  const narratorReply = routeMessages.find((message) => message.content.includes("NARRATOR_REPLY"))!;
  assert.deepEqual(
    (await extraOf(narratorReply.id)).hiddenFromAICharacterIds,
    [ids.pantalone],
    "the post-reply check decides the turn's last reply",
  );
} finally {
  await app.close();
  provider.close();
  closeDB();
  rmSync(dir, { recursive: true, force: true });
}
