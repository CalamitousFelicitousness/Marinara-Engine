import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// #7182: a long chat must not hand the Decision model every scene and excerpt at once.
// Ordinary relevance shortlists scenes, the model picks scenes, then their messages.
const directory = mkdtempSync(join(tmpdir(), "marinara-recall-shortlist-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const PASS_DELAY_MS = 5500; // Two passes together exceed one 10 s recall limit; each alone fits.
const recallRequests: Array<Array<{ id: string; text: string }>> = [];
const calls: string[] = [];
const messageIds = new Set<string>();
let failRecall = false;
let slowRecall = false;
let rejectMessages = false;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/systemone") {
    const memories: Array<{ id: string; text: string }> | undefined = body.state.memories;
    if (memories) {
      recallRequests.push(memories);
      if (slowRecall) await delay(PASS_DELAY_MS);
      if (failRecall) {
        response.statusCode = 500;
        response.end("{}");
        return;
      }
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, value]) => {
        const memory = memories?.find((item) => item.id === id);
        const message = body.state.transcript?.find((item: { messageId: string }) => item.messageId === id);
        const probability = memory
          ? /Shiro/.test(memory.text) && !(rejectMessages && messageIds.has(id))
            ? 0.95
            : 0.05
          : (value as { instructions: string }).instructions.includes("clearly START") &&
              message?.content.startsWith("SCENE_CHANGE")
            ? 0.99
            : 0.01;
        return [id, { type: "noul", noul: probability }];
      }),
    );
    response.end(JSON.stringify({ answers }));
    return;
  }
  if (request.url === "/v1/embeddings") {
    calls.push("embedding");
    response.end(
      JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0] })) }),
    );
    return;
  }
  calls.push("summary");
  const scene = /\[scene (\d+)\]/u.exec(body.messages[1].content)?.[1];
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({ audience: "all", summary: summaries[Number(scene)] ?? "Kaito and Mari rested." }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
});

const SHIRO_SCENES = [7, 29, 51];
const CAT_INN_SCENE = 40;
const chores = [
  "repainted the hallway",
  "argued about the rent",
  "cooked curry for dinner",
  "fixed the window latch",
  "visited the riverside market",
  "planned a trip to the coast",
  "cleaned the balcony",
  "read old letters by the lamp",
];
const summaries: string[] = Array.from({ length: 64 }, (_, index) =>
  SHIRO_SCENES.includes(index)
    ? `Mari and Kaito looked after Shiro, the small white kitten Mari adopted; Shiro hid under the bed during scene ${index}.`
    : index === CAT_INN_SCENE
      ? "Mari and Kaito stayed at the Cat's Tail inn, where the resident cats slept by the fire and the cat bowl was full."
      : `Mari and Kaito ${chores[index % chores.length]} and talked about work. Kaito promised Mari to help again.`,
);

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");
const db = await createFileNativeDB();
const chats = createChatsStorage(db);
const connections = createConnectionsStorage(db);
const memory = createAdvancedMemoryService(db);

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const helper = await connections.create({
    name: "Summary helper",
    provider: "custom",
    baseUrl: `${base}/v1`,
    model: "summary",
    apiKey: "fixture",
    maxContext: 65000,
    embeddingModel: "fixture",
  });
  const decision = await connections.create({
    name: "Jev",
    provider: "decision",
    decisionSource: "custom",
    baseUrl: base,
    model: "jev-latest",
    apiKey: "",
    maxStateTokens: 30000,
    decisionTimeoutMs: 30000,
  });
  const chat = await chats.create({
    name: "Shiro",
    mode: "roleplay",
    characterIds: ["kaito"],
    connectionId: helper.id,
  });
  assert(chat);
  await memory.updateSettings(chat.id, {
    enabled: true,
    decisionEnabled: true,
    decisionConnectionId: decision.id,
    knowledgeStarts: { kaito: null },
    knowledgeConfirmed: true,
    retrieveMaxScenes: 3,
    retrieveMinMessages: 1,
    retrieveMaxMessages: 1,
  });
  await chats.createMessagesBatch(chat.id, [
    ...summaries.flatMap((_, index) => [
      { role: "user" as const, content: `SCENE_CHANGE [scene ${index}] Mari and Kaito meet at home.` },
      {
        role: "assistant" as const,
        characterId: "kaito",
        content: SHIRO_SCENES.includes(index)
          ? `Kaito kneels and holds out a sardine until Shiro creeps out from under the bed.`
          : index === CAT_INN_SCENE
            ? "Kaito scratches one of the inn's cats behind the ears."
            : `Kaito ${chores[index % chores.length]}.`,
      },
      { role: "user" as const, content: "Mari thanks Kaito, and they talk about work for a while." },
    ]),
    { role: "user", content: "SCENE_CHANGE Mari comes home late.", extra: { isConversationStart: true } },
    { role: "assistant", characterId: "kaito", content: "Kaito waves from the kitchen." },
    { role: "user", content: "Kaito, have you seen my cat? Shiro's bowl is still full." },
  ]);
  await memory.initialize(chat.id);
  const records = (await memory.status(chat.id)).records;
  const sceneRecords = records.filter((record) => record.kind === "scene" && record.content);
  assert.equal(sceneRecords.length, 64, "every past scene is closed and summarized");
  const sceneIdsOf = (pattern: RegExp) =>
    sceneRecords.filter((record) => pattern.test(record.content)).map((record) => record.sceneId);
  const shiroScenes = sceneIdsOf(/Shiro/u);
  const [catInnScene] = sceneIdsOf(/Cat's Tail/u);
  assert.equal(shiroScenes.length, 3);
  const summaryIds = new Set(sceneRecords.map((record) => record.id));
  const source = await chats.listMessages(chat.id);
  for (const message of source) messageIds.add(message.id);
  const shiroMessages = source.filter((message) => /Shiro creeps/u.test(message.content)).map(({ id }) => id);
  const messageScene = new Map(
    records
      .filter((record) => record.kind === "excerpt")
      .flatMap((record) => record.messageIds.map((id) => [id, record.sceneId] as const)),
  );
  const input = { chatId: chat.id, messages: source, audienceCharacterIds: ["kaito"], budgetTokens: 50000 };

  // Decision recall: one shortlist batch of scene summaries, then messages from the chosen scenes.
  const beforeCalls = calls.length;
  const prepared = await memory.prepare(input);
  assert.deepEqual(calls.slice(beforeCalls), [], "no archive vectors exist, so no query embedding is requested");
  assert.equal(recallRequests.length, 2, "one request picks scenes and one picks their messages");
  const [scenePass, messagePass] = recallRequests.splice(0);
  assert(scenePass!.length <= 24, "the scene pass judges at most one batch");
  assert(
    scenePass!.every(({ id }) => summaryIds.has(id)),
    "the scene pass judges scene summaries only, never excerpt chunks",
  );
  const judgedScenes = new Set(scenePass!.map(({ id }) => sceneRecords.find((record) => record.id === id)!.sceneId));
  assert(
    shiroScenes.every((sceneId) => judgedScenes.has(sceneId)),
    "the shortlist keeps every Shiro scene",
  );
  assert.deepEqual([...prepared.receipt.recalledSceneIds].sort(), [...shiroScenes].sort());
  assert(
    messagePass!.every(({ id }) => shiroScenes.includes(messageScene.get(id)!)),
    "the message pass judges only messages from the chosen scenes",
  );
  assert.deepEqual([...prepared.receipt.recalledMessageIds].sort(), [...shiroMessages].sort());
  assert.deepEqual(prepared.receipt.reasons, ["decision-recall"]);
  const diagnostics = prepared.receipt.decisionRecall!;
  assert.equal(diagnostics.fallback, false);
  assert.deepEqual(
    diagnostics.results
      .filter((row) => row.selected)
      .map((row) => row.kind)
      .sort(),
    ["message", "message", "message", "scene", "scene", "scene"],
  );
  assert(diagnostics.results.some((row) => row.kind === "scene" && !row.selected && row.score === 0.05));
  await memory.validatePrepared(chat.id, source, prepared.receipt);

  // A failed scene pass uses the shortlist's own ranking and skips the message pass.
  failRecall = true;
  const failed = await memory.prepare(input);
  failRecall = false;
  assert.equal(recallRequests.splice(0).length, 1, "a failed scene pass is not followed by a message pass");
  assert.deepEqual(failed.receipt.reasons, ["decision-recall-fallback"]);
  assert.equal(failed.receipt.decisionRecall?.fallback, true);
  assert.deepEqual([...failed.receipt.recalledSceneIds].sort(), [...shiroScenes].sort());
  assert(!failed.receipt.recalledSceneIds.includes(catInnScene!), "the name Shiro outranks the word cat");
  assert.deepEqual([...failed.receipt.recalledMessageIds].sort(), [...shiroMessages].sort());

  // When the model accepts a scene but none of its messages, text matching still centres the excerpt.
  rejectMessages = true;
  const textCentred = await memory.prepare(input);
  rejectMessages = false;
  assert.equal(recallRequests.splice(0).length, 2);
  assert.deepEqual(textCentred.receipt.reasons, ["decision-recall"], "a complete answer is not a fallback");
  assert.deepEqual([...textCentred.receipt.recalledSceneIds].sort(), [...shiroScenes].sort());
  assert.deepEqual([...textCentred.receipt.recalledMessageIds].sort(), [...shiroMessages].sort());

  // Each pass has its own time limit: two slow passes still finish together.
  slowRecall = true;
  const started = performance.now();
  const slow = await memory.prepare(input);
  slowRecall = false;
  assert(performance.now() - started >= 2 * PASS_DELAY_MS);
  assert.deepEqual(slow.receipt.reasons, ["decision-recall"]);
  assert.deepEqual([...slow.receipt.recalledMessageIds].sort(), [...shiroMessages].sort());
  recallRequests.splice(0);

  // Without the Decision model the same ordinary ranking decides, for a plain mention too.
  await memory.updateSettings(chat.id, { decisionEnabled: false });
  await chats.updateMessageContent(source.at(-1)!.id, "Where did Shiro go? The cat flap is open.");
  const plain = await memory.prepare({ ...input, messages: await chats.listMessages(chat.id) });
  assert.equal(recallRequests.length, 0);
  assert.deepEqual([...plain.receipt.recalledSceneIds].sort(), [...shiroScenes].sort());
  assert.deepEqual([...plain.receipt.recalledMessageIds].sort(), [...shiroMessages].sort());
  assert.equal(plain.receipt.decisionRecall, undefined);

  console.log("Advanced Memory recall shortlist, two Decision passes and the ordinary fallback passed.");
} finally {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await db._fileStore.close();
  rmSync(directory, { recursive: true, force: true });
}
