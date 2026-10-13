// ──────────────────────────────────────────────
// Avatar agents: streaming emotion classifier (lane: director)
// ──────────────────────────────────────────────
// Roleplay's expression source while a reply streams. Two tiers (AVATAR_CLASSIFIER_TIERS):
//   - keywords: the shared expression keyword list (classifyExpressionKeywords), instant and always there;
//   - local-model: a small multilingual emotion model run with the server's own @huggingface/transformers and
//     onnxruntime-node, like services/local-embedder.ts. It downloads into DATA_DIR/models on first use, loads in
//     the background (callers get keywords until it is ready), and unloads after ten idle minutes. It is off on
//     MARINARA_LITE and wherever onnxruntime-node has no native binding (Termux), which keeps those on keywords.
// When a keyword names an emotion, the model's scores are averaged with it: the model reads dialogue well but
// calls most narrated prose neutral, and explicit words ("tears", "laughs") are the strongest evidence there is.
// Never an LLM, never LLM-written tags, never a Decision model: those run after generation and cannot follow the
// stream. Game mode uses the Game Master's per-line expressions and does not call this.
// User text is logged at debug level only; debug mode and DEBUG_AGENTS show counts, tiers and timings.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AVATAR_EMOTIONS,
  classifyExpressionKeywords,
  type AvatarClassification,
  type AvatarClassifierTier,
  type AvatarClassifyRequest,
  type AvatarClassifyResponse,
  type AvatarEmotion,
} from "@marinara-engine/shared";
import { isDebugAgentsEnabled } from "../../config/runtime-config.js";
import { logDebugOverride, logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { resolveOnnxRuntimeBindingPath } from "../local-embedder.js";

/** Horizon-Labs/multilingual-emotions-small (Apache-2.0): mmBERT-small trained on GoEmotions and its
 *  35-language translation, with GoEmotions' 28 labels. Pinned to one commit and downloaded from Horizon. */
export const AVATAR_EMOTION_MODEL_ID = "Horizon-Labs/multilingual-emotions-small";
export const AVATAR_EMOTION_MODEL_REVISION = "1bc9627f189e5aa08b00cf525c3c86052067b81e";

const MODELS_DIR = join(DATA_DIR, "models");
const IDLE_UNLOAD_MS = 10 * 60_000;
const LOAD_RETRY_MS = 10 * 60_000;
const CACHE_LIMIT = 512;

/** label → [emotion, how much of it the label carries, the model's own decision threshold]. Thresholds come
 *  from thresholds.json at the pinned revision; a score at twice its threshold counts in full, so labels the
 *  model rarely fires are not drowned by `neutral`. The emotions follow SPRITE_EXPRESSION_AVATAR_EMOTIONS. */
const GO_EMOTION_LABELS: Readonly<Record<string, readonly [AvatarEmotion, number, number]>> = {
  admiration: ["happy", 0.6, 0.4],
  amusement: ["happy", 1, 0.2],
  anger: ["angry", 1, 0.28],
  annoyance: ["angry", 0.6, 0.16],
  approval: ["relaxed", 0.4, 0.16],
  caring: ["relaxed", 0.8, 0.28],
  confusion: ["surprised", 0.4, 0.16],
  curiosity: ["neutral", 1, 0.26],
  desire: ["happy", 0.5, 0.3],
  disappointment: ["sad", 0.7, 0.16],
  disapproval: ["angry", 0.5, 0.2],
  disgust: ["angry", 0.6, 0.32],
  embarrassment: ["happy", 0.4, 0.2],
  excitement: ["happy", 0.9, 0.18],
  fear: ["surprised", 0.8, 0.2],
  gratitude: ["happy", 0.7, 0.6],
  grief: ["sad", 1, 0.1],
  joy: ["happy", 1, 0.26],
  love: ["relaxed", 1, 0.5],
  nervousness: ["sad", 0.5, 0.62],
  optimism: ["happy", 0.6, 0.4],
  pride: ["happy", 0.6, 0.28],
  realization: ["surprised", 0.5, 0.18],
  relief: ["relaxed", 0.8, 0.32],
  remorse: ["sad", 0.7, 0.14],
  sadness: ["sad", 1, 0.34],
  surprise: ["surprised", 1, 0.2],
  neutral: ["neutral", 1, 0.36],
};

/** The loaded model: label scores (0..1 each, multi-label) for one text. */
export interface AvatarEmotionModel {
  classify(text: string): Promise<Record<string, number>>;
  dispose(): Promise<void>;
}

export interface AvatarClassifierOptions {
  signal?: AbortSignal;
}

type ModelState =
  | { status: "idle" }
  | { status: "loading"; promise: Promise<AvatarEmotionModel | null> }
  | { status: "ready"; model: AvatarEmotionModel }
  | { status: "failed"; retryAt: number };

let modelState: ModelState = { status: "idle" };
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let loadModel: () => Promise<AvatarEmotionModel> = loadHorizonModel;
let testLoaderInstalled = false;
const cache = new Map<string, AvatarClassification>();

function isLite(): boolean {
  return process.env.MARINARA_LITE === "true" || process.env.MARINARA_LITE === "1";
}

/** Whether this server can run the local model at all (it may still be downloading or loading). */
export function isAvatarEmotionModelSupported(): boolean {
  if (isLite()) return false;
  if (testLoaderInstalled) return true;
  const bindingPath = resolveOnnxRuntimeBindingPath();
  return bindingPath !== null && existsSync(bindingPath);
}

async function loadHorizonModel(): Promise<AvatarEmotionModel> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = MODELS_DIR;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  const classify = (await pipeline("text-classification", AVATAR_EMOTION_MODEL_ID, {
    dtype: "q8",
    revision: AVATAR_EMOTION_MODEL_REVISION,
  })) as unknown as ((text: string, options: { top_k: null }) => Promise<Array<{ label: string; score: number }>>) & {
    dispose(): Promise<void>;
  };
  return {
    async classify(text) {
      const output = await classify(text, { top_k: null });
      return Object.fromEntries(output.map(({ label, score }) => [label, score]));
    },
    dispose: () => classify.dispose(),
  };
}

function scheduleIdleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (modelState.status !== "ready") return;
    const { model } = modelState;
    modelState = { status: "idle" };
    logger.info("[avatar-classify] Unloaded the local emotion model after %d idle minutes", IDLE_UNLOAD_MS / 60_000);
    void model.dispose().catch((err) => logger.warn(err, "[avatar-classify] Failed to unload the local emotion model"));
  }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

/** Starts loading the local model when this server supports it and resolves once it is ready (or failed). */
export function prepareAvatarEmotionModel(): Promise<AvatarEmotionModel | null> {
  if (!isAvatarEmotionModelSupported()) return Promise.resolve(null);
  if (modelState.status === "ready") return Promise.resolve(modelState.model);
  if (modelState.status === "loading") return modelState.promise;
  if (modelState.status === "failed" && Date.now() < modelState.retryAt) return Promise.resolve(null);
  const startedAt = Date.now();
  logger.info("[avatar-classify] Loading the local emotion model %s", AVATAR_EMOTION_MODEL_ID);
  // A load that was reset meanwhile (setAvatarEmotionModelLoaderForTests) must not overwrite the newer state.
  const current = () => modelState.status === "loading" && modelState.promise === promise;
  const promise: Promise<AvatarEmotionModel | null> = loadModel().then(
    (model) => {
      if (!current()) {
        void model.dispose().catch(() => {});
        return null;
      }
      modelState = { status: "ready", model };
      scheduleIdleUnload();
      logger.info("[avatar-classify] Local emotion model ready in %dms", Date.now() - startedAt);
      return model;
    },
    (err: unknown) => {
      if (!current()) return null;
      modelState = { status: "failed", retryAt: Date.now() + LOAD_RETRY_MS };
      logger.warn(err, "[avatar-classify] Local emotion model unavailable; avatars use keywords for now");
      return null;
    },
  );
  modelState = { status: "loading", promise };
  return promise;
}

function pickBest(scores: Record<AvatarEmotion, number>): AvatarClassification {
  let best: AvatarEmotion = "neutral";
  for (const emotion of AVATAR_EMOTIONS) if (scores[emotion] > scores[best]) best = emotion;
  return { emotion: best, weight: scores[best], scores };
}

/** Folds the model's 28 label scores into the six avatar emotions (summing to 1). Exported for the regression. */
export function avatarEmotionScoresFromModel(labelScores: Record<string, number>): Record<AvatarEmotion, number> {
  const scores = Object.fromEntries(AVATAR_EMOTIONS.map((emotion) => [emotion, 0])) as Record<AvatarEmotion, number>;
  for (const [label, score] of Object.entries(labelScores)) {
    const mapping = GO_EMOTION_LABELS[label];
    if (!mapping || !Number.isFinite(score)) continue;
    const [emotion, weight, threshold] = mapping;
    scores[emotion] += Math.min(1, Math.max(0, score) / threshold / 2) * weight;
  }
  const total = AVATAR_EMOTIONS.reduce((sum, emotion) => sum + scores[emotion], 0);
  if (total <= 0) return { ...scores, neutral: 1 };
  for (const emotion of AVATAR_EMOTIONS) scores[emotion] /= total;
  return scores;
}

/** The local-model answer for one text: the model's emotions, averaged with the keyword tier when a keyword
 *  names an emotion. */
export function blendAvatarEmotion(
  modelScores: Record<AvatarEmotion, number>,
  keywords: AvatarClassification,
): AvatarClassification {
  if (keywords.emotion === "neutral") return pickBest({ ...modelScores });
  const blended = Object.fromEntries(
    AVATAR_EMOTIONS.map((emotion) => [emotion, (modelScores[emotion] + keywords.scores[emotion]) / 2]),
  ) as Record<AvatarEmotion, number>;
  return pickBest(blended);
}

function cacheKey(tier: AvatarClassifierTier, text: string): string {
  return `${tier}:${createHash("sha1").update(text).digest("base64url")}`;
}

function remember(key: string, result: AvatarClassification) {
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function recall(key: string): AvatarClassification | undefined {
  const hit = cache.get(key);
  if (hit) remember(key, hit);
  return hit;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Classification aborted");
}

export async function classifyAvatarEmotions(
  request: AvatarClassifyRequest,
  options: AvatarClassifierOptions = {},
): Promise<AvatarClassifyResponse> {
  const startedAt = performance.now();
  const debug = request.debugMode === true || isDebugAgentsEnabled();
  let model: AvatarEmotionModel | null = null;
  if (request.tier !== "keywords") {
    if (modelState.status === "ready") {
      model = modelState.model;
      scheduleIdleUnload();
    } else {
      void prepareAvatarEmotionModel();
    }
  }
  const tier: AvatarClassifierTier = model ? "local-model" : "keywords";
  const results: AvatarClassification[] = [];
  let cached = 0;
  for (const text of request.texts) {
    throwIfAborted(options.signal);
    const key = cacheKey(tier, text);
    const hit = recall(key);
    if (hit) {
      cached += 1;
      results.push(hit);
      continue;
    }
    const keywords = classifyExpressionKeywords(text);
    let result = keywords;
    if (model) {
      try {
        result = blendAvatarEmotion(avatarEmotionScoresFromModel(await model.classify(text)), keywords);
      } catch (err) {
        logger.warn(err, "[avatar-classify] The local emotion model failed on a text; using keywords for it");
      }
    }
    remember(key, result);
    results.push(result);
  }
  if (model) scheduleIdleUnload();
  const latencyMs = Math.round(performance.now() - startedAt);
  logDebugOverride(
    debug,
    "[avatar-classify] %d text(s), %d cached, tier %s in %dms: %s",
    results.length,
    cached,
    tier,
    latencyMs,
    results.map((result) => `${result.emotion}:${result.weight.toFixed(2)}`).join(" "),
  );
  logger.debug({ texts: request.texts }, "[avatar-classify] Classified texts");
  return { results, tier, model: model ? AVATAR_EMOTION_MODEL_ID : null, latencyMs };
}

/** Regression hook: swaps the model loader (null restores the real one) and forgets the loaded model and cache. */
export async function setAvatarEmotionModelLoaderForTests(loader: (() => Promise<AvatarEmotionModel>) | null) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (modelState.status === "ready") await modelState.model.dispose();
  modelState = { status: "idle" };
  cache.clear();
  loadModel = loader ?? loadHorizonModel;
  testLoaderInstalled = loader !== null;
}
