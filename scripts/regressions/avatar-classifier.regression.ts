/**
 * The avatar emotion classifier and the shared expression keyword list:
 *   - one keyword list serves the Roleplay sprite fallback, the Expression Engine's fallback pick and the
 *     classifier's instant tier; it matches whole words across accents and scripts without the old prefix
 *     false positives;
 *   - the classifier answers with keywords until the local model is ready, then averages the model with the
 *     keywords, caches per text, falls back per text, and stays on keywords in Lite mode;
 *   - the route validates the request, sits in its own rate-limit bucket, and never logs user text above debug.
 * The local model is a stub here: no download, no ONNX.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const {
  AVATAR_EMOTIONS,
  EXPRESSION_KEYWORD_NEUTRAL_CANDIDATES,
  classifyExpressionKeywords,
  detectExpressionKeyword,
  inferExpressionCandidates,
} = await import("../../packages/shared/src/index.js");

// ── One keyword list, whole words, any accent ──
const cases: Array<[string, string]> = [
  ["She smiles warmly.", "happy"],
  ["He grinned at her.", "happy"],
  ["She laughs at the joke.", "happy"],
  ["Haha, nice one.", "laughing"],
  ["Tears roll down her cheeks.", "sad"],
  ["She is crying.", "sad"],
  ["He yells at the guard.", "angry"],
  ["Her eyes narrow into a glare.", "angry"],
  ["Her eyes widened.", "surprised"],
  ["She blushes.", "embarrassed"],
  ["I love you.", "love"],
  ["He winks.", "smirk"],
  ["She winces in pain.", "hurt"],
  ["Hmm, let me think.", "thinking"],
  ["The door opens.", "neutral"],
  // Prefix matches the old regexes made: a colour, a compliment, a tomb, a building, a mood word inside a word.
  ["The yellow flower.", "neutral"],
  ["What a terrific idea.", "neutral"],
  ["They entered the crypt.", "neutral"],
  ["The museum opens at nine.", "neutral"],
  ["He is unhappy.", "sad"],
  ["She looks sadder than ever.", "sad"],
  // Accents fold; letters without a decomposition (Polish ł) stay themselves.
  ["Er ist WÜTEND.", "angry"],
  ["Er ist wutend.", "angry"],
  ["Łzy spływają jej po policzkach.", "sad"],
  ["Uśmiecha się szeroko.", "happy"],
  ["Ella sonríe.", "happy"],
  ["Elle pleure.", "sad"],
  ["Она улыбнулась.", "happy"],
  // Chinese, Japanese and Korean match inside words; Japanese voicing marks are kept.
  ["彼女は泣いた。", "sad"],
  ["びっくりした！", "surprised"],
  ["テーブルをひっくり返した。", "neutral"],
  ["她哭了。", "sad"],
  ["그녀는 눈물을 흘렸다.", "sad"],
];
for (const [text, expected] of cases) {
  assert.equal(detectExpressionKeyword(text), expected, `${JSON.stringify(text)} reads as ${expected}`);
}

const blushCandidates = inferExpressionCandidates("She blushes and looks away.");
assert.deepEqual(blushCandidates.slice(0, 2), ["embarrassed", "blush"], "a group's label comes before its aliases");
assert.deepEqual(
  blushCandidates.slice(-EXPRESSION_KEYWORD_NEUTRAL_CANDIDATES.length),
  [...EXPRESSION_KEYWORD_NEUTRAL_CANDIDATES],
  "calm faces always end the list",
);
assert.deepEqual(inferExpressionCandidates(""), [...EXPRESSION_KEYWORD_NEUTRAL_CANDIDATES]);
assert.ok(
  inferExpressionCandidates("He is nervous.").includes("scared"),
  "nervous still reaches a scared sprite when there is no worried one",
);

// The Expression Engine's fill-in for a character the model skipped picks from the same list.
const { completeRequiredSpriteExpressionEntries } =
  await import("../../packages/server/src/routes/generate/expression-agent-utils.js");
const fillIn = (expressions: string[], text: string) =>
  completeRequiredSpriteExpressionEntries([], [{ characterId: "c1", characterName: "Mia", expressions }], ["c1"], {
    defaultSourceText: text,
  }).expressions[0]?.expression;
assert.equal(fillIn(["blush", "neutral"], "She blushes and looks away."), "blush", "an alias fills a missing label");
assert.equal(
  fillIn(["happy", "blush", "neutral"], "She blushes and smiles."),
  "happy",
  "a general mood comes before a blush",
);
assert.equal(fillIn(["scared", "neutral"], "He is nervous."), "scared", "nervous reaches a scared sprite");
assert.equal(fillIn(["sad", "neutral"], "Łzy spływają jej po policzkach."), "sad", "other languages fill in too");
assert.equal(fillIn(["angry", "neutral"], "The yellow lantern sways."), "neutral", "no mood word, a calm face");

const sumOf = (scores: Record<string, number>) => Object.values(scores).reduce((sum, value) => sum + value, 0);
const strong = classifyExpressionKeywords("She smiles.");
assert.equal(strong.emotion, "happy");
assert.equal(strong.weight, 1, "one strong word is confident");
const mild = classifyExpressionKeywords("She smirks.");
assert.equal(mild.emotion, "neutral", "one mild word stays below neutral");
assert.ok(Math.abs(mild.scores.happy - 0.4) < 1e-9);
const mixed = classifyExpressionKeywords("She smiles through her tears.");
assert.deepEqual([mixed.scores.happy, mixed.scores.sad], [0.5, 0.5], "two emotions share the score");
for (const result of [strong, mild, mixed, classifyExpressionKeywords("The door opens.")]) {
  assert.ok(Math.abs(sumOf(result.scores) - 1) < 1e-9, "scores sum to 1");
  assert.deepEqual(Object.keys(result.scores).sort(), [...AVATAR_EMOTIONS].sort());
}

// ── Lite mode keeps the keyword tier ──
process.env.MARINARA_LITE = "true";
const classifier = await import("../../packages/server/src/services/avatars/emotion-classifier.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");
assert.equal(classifier.isAvatarEmotionModelSupported(), false, "Lite mode never loads the local model");
const lite = await classifier.classifyAvatarEmotions({ texts: ["She laughs."], tier: "local-model" });
assert.equal(lite.tier, "keywords");
assert.equal(lite.model, null);
assert.equal(lite.results[0]?.emotion, "happy");
delete process.env.MARINARA_LITE;

// ── The local model, stubbed ──
const modelCalls: string[] = [];
let failNext = false;
const fakeModel = {
  async classify(text: string) {
    modelCalls.push(text);
    if (failNext) {
      failNext = false;
      throw new Error("model crashed");
    }
    if (text.includes("prince")) return { surprise: 0.9, curiosity: 0.3, neutral: 0.2 };
    if (text.includes("miss him")) return { sadness: 0.7, grief: 0.2, neutral: 0.3 };
    return { neutral: 0.95, joy: 0.05 };
  },
  async dispose() {},
};
await classifier.setAvatarEmotionModelLoaderForTests(async () => fakeModel);
assert.equal(classifier.isAvatarEmotionModelSupported(), true);

const first = await classifier.classifyAvatarEmotions({ texts: ["Wait, you're the prince?"], tier: "local-model" });
assert.equal(first.tier, "keywords", "callers get keywords while the model loads in the background");
assert.equal(await classifier.prepareAvatarEmotionModel(), fakeModel);

const texts = ["Wait, you're the prince?", "She laughs.", "He opens the door.", "I miss him so much."];
const ready = await classifier.classifyAvatarEmotions({ texts, tier: "local-model" });
assert.equal(ready.tier, "local-model");
assert.equal(ready.model, classifier.AVATAR_EMOTION_MODEL_ID);
assert.deepEqual(
  ready.results.map((result) => result.emotion),
  ["surprised", "happy", "neutral", "sad"],
  "results stay in request order; a keyword lifts narration the model calls neutral",
);
assert.ok(ready.results[1]!.weight >= 0.45, "the averaged keyword emotion is strong enough to change a face");
for (const result of ready.results) assert.ok(Math.abs(sumOf(result.scores) - 1) < 1e-9);

const callsBefore = modelCalls.length;
const again = await classifier.classifyAvatarEmotions({ texts: [texts[0]!], tier: "local-model" });
assert.equal(modelCalls.length, callsBefore, "a classified text is answered from the cache");
assert.deepEqual(again.results[0], ready.results[0]);

const keywordsOnly = await classifier.classifyAvatarEmotions({ texts: ["Something new."], tier: "keywords" });
assert.equal(keywordsOnly.tier, "keywords", "a caller can ask for the instant tier only");
assert.equal(modelCalls.length, callsBefore);

failNext = true;
const fallback = await classifier.classifyAvatarEmotions({ texts: ["Tears fall. A brand new line."] });
assert.equal(fallback.tier, "local-model");
assert.equal(fallback.results[0]?.emotion, "sad", "a model failure on one text falls back to its keywords");

assert.deepEqual(
  classifier.avatarEmotionScoresFromModel({}),
  { neutral: 1, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 },
  "no label scores read as neutral",
);
const folded = classifier.avatarEmotionScoresFromModel({ love: 0.9, caring: 0.4, neutral: 0.1 });
assert.ok(folded.relaxed > 0.8, "love and caring fold into relaxed");

await classifier.setAvatarEmotionModelLoaderForTests(async () => {
  throw new Error("offline");
});
await classifier.classifyAvatarEmotions({ texts: ["Load attempt."] });
assert.equal(await classifier.prepareAvatarEmotionModel(), null, "a failed download waits before retrying");
const offline = await classifier.classifyAvatarEmotions({ texts: ["She smiles."] });
assert.equal(offline.tier, "keywords");
assert.equal(offline.results[0]?.emotion, "happy");

// A load still running when the state is reset never becomes the model.
let finishSlowLoad: () => void = () => {};
let slowDisposed = false;
const slowModel = { ...fakeModel, dispose: async () => void (slowDisposed = true) };
await classifier.setAvatarEmotionModelLoaderForTests(
  () => new Promise((resolve) => (finishSlowLoad = () => resolve(slowModel))),
);
const slowLoad = classifier.prepareAvatarEmotionModel();
await classifier.setAvatarEmotionModelLoaderForTests(async () => fakeModel);
finishSlowLoad();
assert.equal(await slowLoad, null, "the stale load reports nothing");
assert.ok(slowDisposed, "and frees its model");

// ── The route ──
assert.equal(await classifier.prepareAvatarEmotionModel(), fakeModel, "the current loader's model is used");
const serverRequire = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const fastify = serverRequire("fastify") as typeof import("fastify").default;
const { avatarClassifyRoutes } = await import("../../packages/server/src/routes/avatar-classify.routes.js");
const { rateLimitHook, resetRateLimitBucketsForTests } =
  await import("../../packages/server/src/middleware/rate-limit.js");
resetRateLimitBucketsForTests();
const app = fastify({ logger: false });
app.addHook("onRequest", rateLimitHook);
await app.register(avatarClassifyRoutes, { prefix: "/api/avatar-classify" });
await app.ready();

const secret = "Zanzibar-7319 whispers she is so happy";
const logged: string[] = [];
const levels = ["fatal", "error", "warn", "info"] as const;
const originals = levels.map((level) => logger[level]);
for (const level of levels) {
  (logger as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
    logged.push(JSON.stringify(args));
  };
}
const ok = await app.inject({
  method: "POST",
  url: "/api/avatar-classify",
  payload: { texts: [secret, "Wait, you're the prince?"], tier: "local-model", debugMode: true },
});
levels.forEach((level, index) => {
  (logger as unknown as Record<string, unknown>)[level] = originals[index];
});
assert.equal(ok.statusCode, 200);
const body = ok.json() as { results: Array<{ emotion: string }>; tier: string };
assert.deepEqual(
  body.results.map((result) => result.emotion),
  ["happy", "surprised"],
);
assert.equal(body.tier, "local-model");
assert.equal(ok.headers["ratelimit-limit"], "120", "the classifier has its own rate-limit bucket");
if (!logger.isLevelEnabled("debug")) assert.ok(logged.length > 0, "debug mode reports the classification");
assert.ok(
  logged.every((line) => !line.includes("Zanzibar-7319")),
  "user text is never logged above debug level, even in debug mode",
);

for (const payload of [
  { texts: [] },
  { texts: Array.from({ length: 17 }, () => "a") },
  { texts: ["x".repeat(2001)] },
  { texts: ["ok"], tier: "llm" },
  { texts: ["ok"], extra: true },
]) {
  const refused = await app.inject({ method: "POST", url: "/api/avatar-classify", payload });
  assert.equal(refused.statusCode, 400, `refuses ${JSON.stringify(payload).slice(0, 60)}`);
}
await app.close();
await classifier.setAvatarEmotionModelLoaderForTests(null);

console.log("avatar classifier regression passed");
