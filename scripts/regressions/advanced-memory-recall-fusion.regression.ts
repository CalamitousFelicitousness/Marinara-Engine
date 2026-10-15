import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionBackend } from "../../packages/server/src/services/decision/decision-default.js";

// #7699: the Decision shortlist ranks by words and meaning, adds the scene after a strong match, places each
// judged scene in the story, keeps the answers of requests that worked, gets time sized to its backend, and
// fills in vectors missing from Decision-mode archives after replies. Fake providers only: no network, no model.
const directory = mkdtempSync(join(tmpdir(), "marinara-recall-fusion-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

// The fake embedder counts concept words, so a paraphrase shares a direction with its scene but no word.
const CONCEPTS = [/\b(?:locket|pendant|chain)\b/giu, /\brope\b/giu];
const vector = (text: string) => [...CONCEPTS.map((concept) => (text.match(concept) ?? []).length), 0.1];
const embeddingInputs: string[][] = [];
const recallRequests: Array<Array<{ id: string; text: string }>> = [];
const decisionBodies: string[] = [];
let embeddingsDown = false;
let failFirstRecallBatch = false;
let accepted = /locket|TARGET_SCENE/u;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/systemone") {
    decisionBodies.push(JSON.stringify(body));
    const memories: Array<{ id: string; text: string }> | undefined = body.state.memories;
    if (memories) {
      recallRequests.push(memories);
      if (failFirstRecallBatch && recallRequests.length === 1) {
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
          ? accepted.test(memory.text)
            ? 0.95
            : 0.05
          : (value as { instructions: string }).instructions.includes("cut to a new scene") &&
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
    if (embeddingsDown) {
      response.statusCode = 500;
      response.end("{}");
      return;
    }
    embeddingInputs.push(body.input);
    response.end(
      JSON.stringify({ data: body.input.map((text: string, index: number) => ({ index, embedding: vector(text) })) }),
    );
    return;
  }
  const scene = /\[scene (\d+)\]/u.exec(body.messages[1].content)?.[1];
  const summary =
    scene === undefined
      ? body.messages[1].content.includes("TARGET_SCENE")
        ? "TARGET_SCENE: The old oath concerned Cobalt refuge."
        : "Lantern soup was served."
      : summaries[Number(scene)];
  response.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: JSON.stringify({ audience: "all", summary }) },
          finish_reason: "stop",
        },
      ],
    }),
  );
});

const LOCKET_SCENE = 5;
const LIGHTHOUSE_SCENE = 12;
// Every other scene shares the word "rope" with the questions, so word matching alone ranks these three last.
const chores = ["paint", "bread", "letters", "lamps", "boots", "tea", "nets", "a kettle", "soap"];
const summaries = Array.from({ length: 30 }, (_, index) =>
  index === LOCKET_SCENE
    ? "Kaito gave Mari a silver locket by the harbor."
    : index === LIGHTHOUSE_SCENE
      ? "Mari found a lighthouse key in the sand."
      : index === LIGHTHOUSE_SCENE + 1
        ? "They walked back at sunrise and slept until noon."
        : `Mari and Kaito bought rope${" and more rope".repeat(index % 3)} with ${chores[index % chores.length]} at the market.`,
);

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");
const { rankDecisionMemories, memoryDecisionClock } =
  await import("../../packages/server/src/services/advanced-memory-decisions.js");
const { recallTerms, scoreRecallTerms, fuseRecallRanks } =
  await import("../../packages/server/src/services/advanced-memory-ranking.js");
const { estimateChatSummaryTokens } = await import("../../packages/shared/dist/index.js");
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
  });
  const decisionSettings = {
    enabled: true,
    decisionEnabled: true,
    decisionConnectionId: decision.id,
    knowledgeStarts: { kaito: null },
    knowledgeConfirmed: true,
    retrieveMaxScenes: 3,
    retrieveMinMessages: 1,
    retrieveMaxMessages: 1,
  };
  const sceneMessages = (index: number) => [
    { role: "user" as const, content: `SCENE_CHANGE [scene ${index}] Mari and Kaito meet.` },
    { role: "assistant" as const, characterId: "kaito", content: "Kaito nods." },
    { role: "user" as const, content: "They talk for a while." },
  ];
  const liveMessages = [
    { role: "user" as const, content: "SCENE_CHANGE Mari comes home late.", extra: { isConversationStart: true } },
    { role: "assistant" as const, characterId: "kaito", content: "Kaito waves from the kitchen." },
    { role: "user" as const, content: "Hello." },
  ];

  const chat = await chats.create({
    name: "Locket",
    mode: "roleplay",
    characterIds: ["kaito"],
    connectionId: helper.id,
  });
  assert(chat);
  await memory.updateSettings(chat.id, decisionSettings);
  await chats.createMessagesBatch(chat.id, [...summaries.flatMap((_, index) => sceneMessages(index)), ...liveMessages]);
  await memory.initialize(chat.id);
  const records = (await memory.status(chat.id)).records;
  const sceneRecord = (index: number) =>
    records.find((record) => record.kind === "scene" && record.content === summaries[index])!;
  assert(
    records.filter((record) => record.content).every((record) => record.embeddingStatus === "vectorized"),
    "Decision mode embeds what it archives",
  );
  const ask = async (question: string) => {
    const source = await chats.listMessages(chat.id);
    await chats.updateMessageContent(source.at(-1)!.id, question);
    recallRequests.length = 0;
    embeddingInputs.length = 0;
    return memory.prepare({
      chatId: chat.id,
      messages: await chats.listMessages(chat.id),
      audienceCharacterIds: ["kaito"],
      budgetTokens: 50000,
    });
  };

  // A paraphrase with no word of the scene reaches the shortlist by meaning, through rank fusion.
  const paraphrase = "Do you remember the pendant on its chain? We still need rope.";
  const fused = await ask(paraphrase);
  assert.deepEqual(embeddingInputs, [[paraphrase]], "the query embedding is the latest user message alone");
  const [scenePass] = recallRequests;
  assert(scenePass!.length <= 24);
  assert(
    scenePass!.some(({ id }) => id === sceneRecord(LOCKET_SCENE).id),
    "the locket scene reaches the Decision model through its vector",
  );
  assert.deepEqual(fused.receipt.recalledSceneIds, [sceneRecord(LOCKET_SCENE).sceneId]);
  // Each judged scene starts with one short line placing it in the story.
  for (const { text } of scenePass!) {
    const line = text.split("\n")[0]!;
    assert.match(line, /^Messages #\d+–#\d+; speakers: User, Character$/u);
    assert(estimateChatSummaryTokens(line) <= 25);
  }

  // "What happened after X": the scene after a strong match joins the shortlist, which keeps its size.
  await ask("What happened right after the lighthouse? We still need rope.");
  const [afterPass] = recallRequests;
  assert.equal(afterPass!.length, 24, "the shortlist keeps its size");
  assert(afterPass!.some(({ id }) => id === sceneRecord(LIGHTHOUSE_SCENE).id));
  assert(
    afterPass!.some(({ id }) => id === sceneRecord(LIGHTHOUSE_SCENE + 1).id),
    "the scene right after the lighthouse is judged too",
  );

  // A failed request costs only its own memories: the other request's answers still count. The first request
  // (the best 24) fails; the model accepts the sunrise scene in the second, and the locket scene falls back.
  await memory.updateSettings(chat.id, { retrieveMaxScenes: 30 });
  failFirstRecallBatch = true;
  accepted = /locket|sunrise/u;
  const partial = await ask(paraphrase);
  failFirstRecallBatch = false;
  accepted = /locket|TARGET_SCENE/u;
  await memory.updateSettings(chat.id, { retrieveMaxScenes: 3 });
  const [failed, answered] = recallRequests;
  assert.equal(failed!.length + answered!.length, 30, "30 scenes in two requests");
  assert(failed!.some(({ id }) => id === sceneRecord(LOCKET_SCENE).id));
  assert(answered!.some(({ id }) => id === sceneRecord(LIGHTHOUSE_SCENE + 1).id));
  assert(partial.receipt.reasons.includes("decision-recall"));
  assert(partial.receipt.reasons.includes("decision-recall-partial"), partial.receipt.reasons.join(", "));
  assert(!partial.receipt.reasons.includes("decision-recall-fallback"));
  assert.equal(
    partial.receipt.recalledSceneIds[0],
    sceneRecord(LIGHTHOUSE_SCENE + 1).sceneId,
    "the model's pick from the request that answered comes first",
  );
  assert(
    partial.receipt.recalledSceneIds.includes(sceneRecord(LOCKET_SCENE).sceneId),
    "ordinary recall still finds the locket among the unanswered scenes",
  );
  const failedScenes = new Set(failed!.map(({ id }) => records.find((record) => record.id === id)!.sceneId));
  assert(
    partial.receipt.recalledSceneIds.slice(1).every((sceneId) => failedScenes.has(sceneId)),
    "only unanswered scenes fall back, after the model's picks",
  );
  const rows = partial.receipt.decisionRecall!.results.filter((row) => row.kind === "scene");
  assert(rows.filter((row) => failed!.some(({ id }) => id === row.id)).every((row) => row.score === undefined));
  assert(rows.filter((row) => answered!.some(({ id }) => id === row.id)).every((row) => row.score !== undefined));
  assert.equal(partial.receipt.decisionRecall!.fallback, true);

  // Vectors missing from a Decision-mode archive are filled in after replies, a bounded few at a time:
  // summaries first, the newest scenes first.
  const backfill = await chats.create({
    name: "Backfill",
    mode: "roleplay",
    characterIds: ["kaito"],
    connectionId: helper.id,
  });
  assert(backfill);
  await memory.updateSettings(backfill.id, decisionSettings);
  await chats.createMessagesBatch(backfill.id, [
    ...summaries.flatMap((_, index) => sceneMessages(index)),
    ...liveMessages,
  ]);
  embeddingsDown = true;
  await memory.initialize(backfill.id);
  embeddingsDown = false;
  const vectorized = async () =>
    (await memory.status(backfill.id)).records.filter((record) => record.embeddingStatus === "vectorized");
  assert.equal((await vectorized()).length, 0, "the embedder was down while archiving");
  const archived = (await memory.status(backfill.id)).records.filter(
    (record) => record.content && record.status === "closed",
  );
  assert.equal(archived.length, 60, "30 summaries and 30 excerpts lack vectors");
  embeddingInputs.length = 0;
  await memory.checkScenesAfterGeneration(backfill.id);
  const filled = await vectorized();
  assert.equal(filled.length, 32, "one reply fills a bounded number of records");
  assert.equal(embeddingInputs.length, 1, "in one embedding request");
  assert.equal(filled.filter((record) => record.kind === "scene").length, 30, "summaries first");
  const newestExcerpts = archived
    .filter((record) => record.kind === "excerpt")
    .sort((a, b) => b.startIndex - a.startIndex)
    .slice(0, 2)
    .map((record) => record.id)
    .sort();
  assert.deepEqual(
    filled
      .filter((record) => record.kind === "excerpt")
      .map((record) => record.id)
      .sort(),
    newestExcerpts,
    "then the newest scenes",
  );
  await memory.checkScenesAfterGeneration(backfill.id);
  assert.equal((await vectorized()).length, 60, "the next reply goes on");

  // The line placing a scene uses only what the reader saw: a message hidden from them gives no date.
  const group = await chats.create({
    name: "Dates",
    mode: "roleplay",
    characterIds: ["reader", "other"],
    connectionId: helper.id,
  });
  assert(group);
  await chats.patchMetadata(group.id, { groupChatMode: "individual" });
  await memory.updateSettings(group.id, {
    ...decisionSettings,
    knowledgeStarts: { reader: null, other: null },
  });
  const hidden = { hiddenFromAICharacterIds: ["reader"] };
  await chats.createMessagesBatch(group.id, [
    { role: "user", content: "SCENE_CHANGE\nDate: Spring 3\nTARGET_SCENE They make an oath." },
    { role: "assistant", characterId: "reader", content: "Cobalt refuge is our promise." },
    { role: "user", content: "Date: Autumn 1\nThey part ways.", extra: hidden },
    { role: "user", content: "SCENE_CHANGE\nDate: Winter 9\nPRIVATE_SECRET", extra: hidden },
    { role: "assistant", characterId: "other", content: "PRIVATE_SECRET kept.", extra: hidden },
    { role: "user", content: "SCENE_CHANGE They eat lantern soup." },
    { role: "assistant", characterId: "reader", content: "More soup." },
    { role: "user", content: "SCENE_CHANGE You remember the oath, don't you?", extra: { isConversationStart: true } },
  ]);
  await memory.initialize(group.id);
  recallRequests.length = 0;
  decisionBodies.length = 0;
  const dated = await memory.prepare({
    chatId: group.id,
    messages: await chats.listMessages(group.id),
    audienceCharacterIds: ["reader"],
    budgetTokens: 50000,
  });
  assert(dated.receipt.reasons.includes("decision-recall"), dated.receipt.reasons.join(", "));
  const oath = recallRequests[0]!.find(({ text }) => text.includes("TARGET_SCENE"))!;
  const oathLine = oath.text.split("\n")[0]!;
  assert.match(oathLine, /^Messages #1–#2; story time: Spring 3; speakers: User, Character$/u);
  assert(estimateChatSummaryTokens(oathLine) <= 25);
  assert.doesNotMatch(decisionBodies.join("\n"), /Autumn 1|Winter 9|PRIVATE_SECRET/u, "nothing the reader missed");

  // The pass is sized to its backend: the expected time with headroom, at least 10 s, at most its cap, and
  // a backend too slow for every statement judges fewer, the best ranked first.
  const asked: string[][] = [];
  const backend = {
    maxStateTokens: 30000,
    calibration: { defaultThreshold: 0.5, questionShape: "text" },
    requestMs: (statements: number) => statements * 350,
    askMixed: async (_state: unknown, questions: Array<{ id: string }>) => {
      asked.push(questions.map(({ id }) => id));
      return { answers: new Map(questions.map(({ id }) => [id, 0.9])), choices: new Map() };
    },
  } as unknown as DecisionBackend;
  const candidates = Array.from({ length: 36 }, (_, index) => ({ id: `memory-${index}`, text: "A past promise." }));
  const sized = (maxMs: number) => {
    const limits: number[] = [];
    return {
      limits,
      clock: { signal: new AbortController().signal, maxMs, limit: (ms: number) => limits.push(ms), stop() {} },
    };
  };
  let pass = sized(25_000);
  assert.equal(
    (await rankDecisionMemories(backend, "Remember?", [], candidates.slice(0, 24), undefined, undefined, pass.clock))
      ?.size,
    24,
  );
  assert.deepEqual(pass.limits, [24 * 350 * 1.5], "Open-Jev 2B gets 12.6 s for 24 statements");
  pass = sized(25_000);
  await rankDecisionMemories(backend, "Remember?", [], candidates.slice(0, 4), undefined, undefined, pass.clock);
  assert.deepEqual(pass.limits, [10_000], "never under 10 s");
  backend.requestMs = (statements) => statements * 800;
  asked.length = 0;
  pass = sized(25_000);
  const fewer = await rankDecisionMemories(backend, "Remember?", [], candidates, undefined, undefined, pass.clock);
  assert.deepEqual(
    [...fewer!.keys()],
    candidates.slice(0, 20).map(({ id }) => id),
    "9B judges the best 20 of 36",
  );
  assert.deepEqual(pass.limits, [20 * 800 * 1.5]);
  assert(pass.limits[0]! <= 25_000, "within the cap");
  // A System One connection answers a request's statements together; its per-statement limit is not its cost.
  backend.requestMs = () => 4000;
  pass = sized(15_000);
  assert.equal(
    (await rankDecisionMemories(backend, "Remember?", [], candidates, undefined, undefined, pass.clock))?.size,
    36,
  );
  assert.deepEqual(pass.limits, [12_000], "two requests of a connection");
  // The clock aborts at its limit, never past its cap.
  const capped = memoryDecisionClock(undefined, 40);
  capped.limit(60_000);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(capped.signal.aborted, "the cap holds");
  capped.stop();

  // One failed batch keeps the other's answers; a candidate too large for any request keeps its full text and
  // falls back alone.
  backend.requestMs = undefined;
  let calls = 0;
  backend.askMixed = async (_state: unknown, questions: Array<{ id: string }>) =>
    ++calls === 2
      ? { answers: new Map(), choices: new Map(), error: "down" }
      : { answers: new Map(questions.map(({ id }) => [id, 0.9])), choices: new Map() };
  const mixed = await rankDecisionMemories(
    backend,
    "Remember?",
    [],
    [...candidates.slice(0, 30), { id: "huge", text: "x ".repeat(40_000) }],
  );
  assert.deepEqual(
    [...mixed!].filter(([, score]) => score === 0.9).map(([id]) => id),
    candidates.slice(0, 24).map(({ id }) => id),
  );
  assert.deepEqual(
    [...mixed!]
      .filter(([, score]) => score === null)
      .map(([id]) => id)
      .sort(),
    [...candidates.slice(24, 30).map(({ id }) => id), "huge"].sort(),
  );

  // Fusion keeps the word order when no vector exists, and lets a strong vector match in.
  const words = new Map([
    ["a", 0.9],
    ["b", 0.5],
    ["c", 0],
    ["d", 0],
  ]);
  assert.deepEqual(fuseRecallRanks(words, new Map()), ["a", "b", "c", "d"]);
  assert.deepEqual(
    fuseRecallRanks(
      words,
      new Map([
        ["d", 0.4],
        ["a", 0.1],
        ["b", 0.1],
        ["c", 0.1],
      ]),
    ).slice(0, 2),
    ["a", "d"],
  );

  // Chinese and Japanese text is matched by overlapping character pairs, not as one sentence-long word.
  const japanese = recallTerms("祭りの夜にカイトがくれた月のロケットを覚えてる？");
  assert(japanese.has("ロケ") && japanese.has("ット") && japanese.has("祭り"));
  assert(!japanese.has("祭りの夜にカイトがくれた月のロケットを覚えてる"));
  const chinese = [recallTerms("凯托在节日那天晚上送我月亮吊坠"), recallTerms("我们去市场买绳子")];
  const [pendant, rope] = scoreRecallTerms(recallTerms("你还记得那个吊坠吗"), chinese);
  assert(pendant! > 0 && rope === 0, "a Chinese question finds the scene that shares its words");
  assert.deepEqual([...recallTerms("Shiro's bowl is still full")], ["shiro", "bowl", "still", "full"]);

  console.log("Advanced Memory recall fusion, neighbours, scene lines, partial passes, sizing and backfill passed.");
} finally {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await db._fileStore.close();
  rmSync(directory, { recursive: true, force: true });
}
