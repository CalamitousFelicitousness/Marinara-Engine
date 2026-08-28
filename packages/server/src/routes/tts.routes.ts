// ──────────────────────────────────────────────
// Routes: Text-to-Speech
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import { access, mkdir, readdir, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import {
  ttsConfigSchema,
  ttsSourceProfileFromConfig,
  normalizeMusicEnemyTier,
  AUDIO_PURPOSES,
  GAME_AUDIO_PURPOSES,
  TTS_SETTINGS_KEY,
  TTS_API_KEY_MASK,
  ttsRoleplaySpeakerExtractorResponseSchema,
  TTS_SOURCE_DEFINITIONS,
  TTS_SOURCE_IDS,
  TTS_TIMEOUT_MS_DEFAULT,
  TTS_TIMEOUT_MS_MAX,
  TTS_TIMEOUT_MS_MIN,
  type TTSSource,
  type TTSConfig,
  type TTSEffectiveConfigResponse,
  type TTSRoleplaySpeakerExtractorResponse,
  type TTSSourceProfiles,
  type TTSModelsResponse,
  type TTSVoicesResponse,
} from "@marinara-engine/shared";
import { createAppSettingsStorage } from "../services/storage/app-settings.storage.js";
import { createConnectionsStorage } from "../services/storage/connections.storage.js";
import { encryptApiKey } from "../utils/crypto.js";
import { getChatGenerationTimeoutMs } from "../config/runtime-config.js";
import { safeFetch } from "../utils/security.js";
import { ttsUrlPolicy } from "../services/tts/url-policy.js";
import { createTTSProvider } from "../services/tts/provider-registry.js";
import {
  buildElevenLabsTextInput,
  buildOfficialPocketTtsForm,
  configuredBaseUrl,
  elevenLabsApiRoot,
  elevenLabsHeaders,
  ELEVENLABS_NON_TTS_MODELS,
  isNanoGptBaseUrl,
  nanoGptHeaders,
  nanoGptV1BaseUrl,
  normalizeNanoGptTtsModelId,
  openAiHeaders,
  optionalBearerHeaders,
  pocketTtsV1BaseUrl,
} from "../services/tts/tts-endpoints.js";
import {
  NANOGPT_FALLBACK_TTS_MODELS,
  NANOGPT_KOKORO_VOICES,
  NANOGPT_OPENAI_VOICES,
  nanoGptModelFamily,
  nanoGptVoicesForModel,
  parseNanoGptModelOptions,
  type NanoGptTtsModel,
} from "../services/tts/nanogpt-catalog.js";
import {
  LEGACY_TTS_CONFIG_SENTINEL,
  loadConfig,
  parseStoredConfig,
  resolveAudioConfig,
  withActiveSourceProfile,
} from "../services/tts/audio-config-resolution.js";

// Re-exported because scripts/regressions/tts-source-persistence.regression.ts
// imports them from this module. Keeping the names resolvable here is what lets
// the provider extraction land without editing an upstream-owned test.
export { buildElevenLabsTextInput, buildOfficialPocketTtsForm };
// Resolution moved to services/tts/audio-config-resolution.ts; the sentinel stays
// exported from here because it was part of this module's surface.
export { LEGACY_TTS_CONFIG_SENTINEL };
import { logger, logDebugOverride } from "../lib/logger.js";
import { buildAssetManifest, GAME_ASSETS_DIR } from "../services/game/asset-manifest.service.js";
import { createLLMProvider } from "../services/llm/provider-registry.js";
import { resolveBaseUrl } from "../services/generation/connection-base-url.js";
import { resolveStoredChatOptions, resolveStoredMaxTokens } from "../services/generation/generation-parameters.js";
import { clampGenerationMaxOutputTokens } from "../services/generation/output-token-limits.js";

// OpenAI built-in voices used as fallback when the provider has no /audio/voices endpoint
const OPENAI_FALLBACK_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const XAI_FALLBACK_VOICES = ["eve", "ara", "rex", "sal", "leo"];
const ELEVENLABS_DEFAULT_VOICES: VoiceOption[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "ElevenLabs default" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", category: "ElevenLabs default" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", category: "ElevenLabs default" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", category: "ElevenLabs default" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", category: "ElevenLabs default" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", category: "ElevenLabs default" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", category: "ElevenLabs default" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "ElevenLabs default" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", category: "ElevenLabs default" },
];
const ELEVENLABS_FALLBACK_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
  "eleven_flash_v2",
];

// Source ids and per-source defaults come from TTS_SOURCE_DEFINITIONS in
// packages/shared/src/constants/tts-sources.ts; both lived here as literals too.

const NANOGPT_ELEVENLABS_VOICES = [
  "Adam",
  "Alice",
  "Antoni",
  "Aria",
  "Arnold",
  "Bella",
  "Bill",
  "Brian",
  "Callum",
  "Charlie",
  "Charlotte",
  "Chris",
  "Daniel",
  "Domi",
  "Dorothy",
  "Drew",
  "Elli",
  "Emily",
  "Eric",
  "Ethan",
  "Fin",
  "Freya",
  "George",
  "Gigi",
  "Giovanni",
  "Grace",
  "James",
  "Jeremy",
  "Jessica",
  "Joseph",
  "Josh",
  "Laura",
  "Liam",
  "Lily",
  "Matilda",
  "Matthew",
  "Michael",
  "Nicole",
  "Rachel",
  "River",
  "Roger",
  "Ryan",
  "Sam",
  "Sarah",
  "Thomas",
  "Will",
];
const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_GAME_AUDIO_BYTES = 60 * 1024 * 1024;
const gameAudioGenerationLocks = new Map<string, Promise<{ tag: string; path: string; cached: boolean }>>();
let gameAssetManifestRebuildTimer: ReturnType<typeof setTimeout> | null = null;

const speakSchema = z.object({
  text: z.string().min(1).max(4096),
  speaker: z.string().max(120).optional(),
  tone: z.string().max(80).optional(),
  voice: z.string().max(200).optional(),
  /** Optional audio-connection override (#5146); absent = default/legacy resolution. */
  audioConnectionId: z.string().optional(),
});

const ttsQuerySchema = z.object({
  connectionId: z.string().max(120).optional(),
  /** Routing lane to answer for. Absent means speech. */
  purpose: z.enum(AUDIO_PURPOSES).optional(),
  /** Ask about this model instead of the saved one. Voices are per model where a source publishes them. */
  model: z.string().max(200).optional(),
});

const roleplaySpeakerExtractorSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  group: z.string().trim().max(500).default(""),
  user: z.string().trim().max(120).default("User"),
  characters: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  messageAuthor: z.string().trim().max(120).default(""),
  debugMode: z.boolean().default(false),
});

const extractedDialogueSchema = z.object({
  dialogue: z
    .array(
      z.object({
        speaker: z.string().trim().min(1).max(120),
        text: z.string().trim().min(1).max(100_000),
        speech: z.string().trim().min(1).max(100_000).optional(),
      }),
    )
    .max(500),
});

const gameAudioSchema = z.object({
  kind: z.enum(GAME_AUDIO_PURPOSES),
  prompt: z.string().trim().min(1).max(4_100),
  /** Optional audio-connection override (#5146); absent = default/legacy resolution. */
  audioConnectionId: z.string().optional(),
  /** Context-track request (#5161): a persistent composition generated ONCE
   *  per area slug or encounter tier into the scoreable music library
   *  (music/<axis>/<key>/), instead of a throwaway per-prompt clip. Music only. */
  context: z
    .object({
      axis: z.enum(["area", "tier"]),
      key: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9_-]*$/),
      /** Composition length; context tracks default to 120s. */
      lengthMs: z.number().int().min(10_000).max(300_000).optional(),
    })
    .optional(),
});

const AUDIO_FILE_PATTERN = /\.(mp3|wav|ogg|m4a|flac)$/i;

type VoiceOption = NonNullable<TTSVoicesResponse["voiceOptions"]>[number];
type ModelOption = TTSModelsResponse["models"][number];

function normalizeGameAudioPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ");
}

function scheduleGameAssetManifestRebuild(): void {
  if (gameAssetManifestRebuildTimer) clearTimeout(gameAssetManifestRebuildTimer);
  gameAssetManifestRebuildTimer = setTimeout(() => {
    gameAssetManifestRebuildTimer = null;
    try {
      buildAssetManifest();
    } catch (error) {
      logger.error(error, "Failed to rebuild the game asset manifest after generating audio");
    }
  }, 500);
  gameAssetManifestRebuildTimer.unref();
}

type GameAudioContext = { axis: "area" | "tier"; key: string; lengthMs?: number };

async function generateElevenLabsGameAudio(
  cfg: TTSConfig,
  kind: "sfx" | "music",
  prompt: string,
  context?: GameAudioContext,
): Promise<{ tag: string; path: string; cached: boolean }> {
  const normalizedPrompt = normalizeGameAudioPrompt(prompt);
  const hash = createHash("sha256").update(`${kind}\0${normalizedPrompt.toLowerCase()}`).digest("hex");
  let category: string;
  let fileName: string;
  let tag: string;
  if (context) {
    // Context tracks (#5161) land in the scoreable library keyed by area/tier
    // and generate ONCE per key: ANY existing audio file under the key —
    // generated earlier or dropped in by the user as a replacement — means
    // the key is covered, regardless of how today's prompt is worded.
    category = `music/${context.axis}/${context.key}`;
    const existing = (await readdir(join(GAME_ASSETS_DIR, "music", context.axis, context.key)).catch(() => [])).filter(
      // Dotfiles never enter the manifest; counting one as coverage would
      // permanently block generation for the key.
      (name) => !name.startsWith(".") && AUDIO_FILE_PATTERN.test(name),
    );
    const coveredBy = existing[0];
    if (coveredBy) {
      return {
        tag: `music:${context.axis}:${context.key}:${coveredBy.replace(/\.[^.]+$/, "")}`,
        path: `${category}/${coveredBy}`,
        cached: true,
      };
    }
    fileName = `generated-${hash.slice(0, 16)}.mp3`;
    tag = `music:${context.axis}:${context.key}:${fileName.replace(/\.mp3$/, "")}`;
  } else {
    category = kind === "sfx" ? "sfx" : "music";
    fileName = `${hash}.mp3`;
    tag = `${category}:generated:${hash}`;
    category = `${category}/generated`;
  }
  const relativePath = `${category}/${fileName}`;
  const targetDirectory = join(GAME_ASSETS_DIR, category);
  const targetPath = join(GAME_ASSETS_DIR, relativePath);

  try {
    await access(targetPath);
    return { tag, path: relativePath, cached: true };
  } catch {
    // Generate below.
  }

  const endpoint = kind === "sfx" ? "/v1/sound-generation" : "/v1/music";
  // Longer compositions take the provider longer to render; give context
  // tracks the headroom a 2-minute piece needs.
  const timeoutMs = context ? 300_000 : 180_000;
  const response = await safeFetch(`${elevenLabsApiRoot(configuredBaseUrl(cfg))}${endpoint}`, {
    method: "POST",
    headers: elevenLabsHeaders(cfg.apiKey),
    body: JSON.stringify(
      kind === "sfx"
        ? { text: normalizedPrompt, prompt_influence: 0.3 }
        : {
            prompt: normalizedPrompt,
            music_length_ms: context ? (context.lengthMs ?? 120_000) : 30_000,
            force_instrumental: true,
          },
    ),
    signal: AbortSignal.timeout(timeoutMs),
    policy: {
      allowLocal: false,
      allowedProtocols: ["https:"],
    },
    maxResponseBytes: MAX_GAME_AUDIO_BYTES,
    decodeCompressedResponse: true,
  });
  if (!response.ok) {
    const detail = readProviderErrorDetail(await response.text().catch(() => ""));
    throw new Error(detail || `ElevenLabs returned ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!resolveTTSAudioResponseContentType(response.headers.get("content-type"), bytes)) {
    throw new Error("ElevenLabs returned a non-audio response");
  }

  await mkdir(targetDirectory, { recursive: true });
  const temporaryPath = join(targetDirectory, `.${hash}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  scheduleGameAssetManifestRebuild();
  return { tag, path: relativePath, cached: false };
}

// ── Helpers ─────────────────────────────────────

export function buildRoleplaySpeakerExtractorPrompt(input: {
  group: string;
  user: string;
  characters: string[];
  messageAuthor?: string;
  includeEmotions: boolean;
}): string {
  const participants = input.characters.length > 0 ? input.characters.join(", ") : "the roleplay characters";
  const roleplayName = input.group || participants;
  const messageAuthorInstruction = input.messageAuthor
    ? `This response was generated for ${input.messageAuthor}. Use that exact name for dialogue not explicitly attributed to a different speaker.`
    : "";
  const emotionInstruction = input.includeEmotions
    ? 'In "speech", copy the exact dialogue and insert emotional indicators directly in [brackets] before the words they affect. You may use multiple bracketed emotional indicators within a dialogue line, including pauses, small sounds, sighs, and different intonations for different parts. Do not otherwise add, remove, reorder, or rewrite any dialogue.'
    : 'Do not add emotional indicators. Omit the "speech" field.';

  return `You are preparing a message for text-to-speech reading from a roleplay chat between ${roleplayName} and ${input.user}, but it is possible there are other characters involved and mentioned in the message itself.

Known chat characters: ${participants}
${messageAuthorInstruction}

Extract all dialogue lines. Copy every dialogue line exactly without changing any part of it, skip all narration beats, and assign who says it. ${emotionInstruction}

Return JSON only in this exact shape:
{"dialogue":[{"speaker":"Name","text":"Exact source dialogue line"${input.includeEmotions ? ',"speech":"Exact dialogue with only inserted [indicators]"' : ""}}]}

Example input:
Dottore sighs and stands up. "I've had enough of your shenanigans," he drawls. "You're wasting my time, subject. This is your last chance to change my mind before I send you to Lab Thirteen."
A pregnant pause settles in the room.
"Skill issue," Mari chuckles, crossing her arms.

Example output:
{"dialogue":[{"speaker":"Dottore","text":"\\\"I've had enough of your shenanigans,\\\""${input.includeEmotions ? ',"speech":"[irritated] \\\"I\'ve had enough of your shenanigans,\\\""' : ""}},{"speaker":"Dottore","text":"\\\"You're wasting my time, subject. This is your last chance to change my mind before I send you to Lab Thirteen.\\\""${input.includeEmotions ? ',"speech":"[irritated] \\\"You\'re wasting my time, subject. [sigh] This is your last chance to change my mind before I send you to Lab Thirteen.\\\""' : ""}},{"speaker":"Mari","text":"\\\"Skill issue,\\\""${input.includeEmotions ? ',"speech":"[chuckle] \\\"Skill issue,\\\""' : ""}}]}`;
}

export function buildRoleplaySpeakerExtractorUserPrompt(message: string): string {
  // Some Responses-compatible providers validate only input messages, not
  // system instructions, before allowing json_object response formatting.
  return `Return the extracted dialogue as a json object matching the requested schema.\n\nMessage to prepare:\n${message}`;
}

function extractJsonObject(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Speaker extractor returned no JSON object");
  return value.slice(start, end + 1);
}

function validateAnnotatedDialogue(source: string, speech: string): string {
  let sourceCursor = 0;
  let speechCursor = 0;
  while (speechCursor < speech.length) {
    if (speech[speechCursor] === "[") {
      let indicatorEnd = -1;
      for (let cursor = speechCursor + 1; cursor <= speechCursor + 81 && cursor < speech.length; cursor++) {
        if (speech[cursor] === "\r" || speech[cursor] === "\n") break;
        if (speech[cursor] === "]") {
          indicatorEnd = cursor;
          break;
        }
      }
      if (indicatorEnd > speechCursor + 1) {
        const bracketSpan = speech.slice(speechCursor, indicatorEnd + 1);
        if (source.startsWith(bracketSpan, sourceCursor)) {
          sourceCursor += bracketSpan.length;
          speechCursor += bracketSpan.length;
        } else {
          speechCursor = indicatorEnd + 1;
          if (speech[speechCursor] === " " && source[sourceCursor] !== " ") speechCursor += 1;
        }
        continue;
      }
    }

    if (sourceCursor >= source.length || speech[speechCursor] !== source[sourceCursor]) {
      throw new Error("Speaker extractor changed dialogue while adding emotion indicators");
    }
    sourceCursor += 1;
    speechCursor += 1;
  }
  if (sourceCursor === source.length) return speech;
  throw new Error("Speaker extractor changed dialogue while adding emotion indicators");
}

/** Build an exact, ordered queue by locating extracted dialogue inside the original message. */
export function parseRoleplaySpeakerExtractorOutput(
  raw: string,
  message: string,
  includeEmotions: boolean,
): TTSRoleplaySpeakerExtractorResponse {
  const extracted = extractedDialogueSchema.parse(JSON.parse(extractJsonObject(raw)));
  const segments: TTSRoleplaySpeakerExtractorResponse["segments"] = [];
  let cursor = 0;

  for (const line of extracted.dialogue) {
    const dialogueIndex = message.indexOf(line.text, cursor);
    if (dialogueIndex < 0) {
      throw new Error(`Speaker extractor changed or could not locate a dialogue line from ${line.speaker}`);
    }

    const narration = message.slice(cursor, dialogueIndex);
    if (narration.trim()) segments.push({ kind: "narration", text: narration });
    segments.push({
      kind: "dialogue",
      speaker: line.speaker,
      text:
        includeEmotions && line.speech
          ? validateAnnotatedDialogue(line.text, line.speech)
          : message.slice(dialogueIndex, dialogueIndex + line.text.length),
    });
    cursor = dialogueIndex + line.text.length;
  }

  const trailingNarration = message.slice(cursor);
  if (trailingNarration.trim()) segments.push({ kind: "narration", text: trailingNarration });
  return ttsRoleplaySpeakerExtractorResponseSchema.parse({ segments });
}

function withoutTemperatureCustomParameter(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => key.toLowerCase() !== "temperature"));
}

/** Mask every stored provider key before returning TTS configuration to the browser. */
export function maskTTSConfigForResponse(config: TTSConfig): TTSConfig {
  const configWithProfiles = withActiveSourceProfile(config);
  const sourceProfiles: TTSSourceProfiles = {};
  for (const source of TTS_SOURCE_IDS) {
    const profile = configWithProfiles.sourceProfiles[source];
    if (!profile) continue;
    sourceProfiles[source] = {
      ...profile,
      apiKey: profile.apiKey ? TTS_API_KEY_MASK : "",
    };
  }
  return {
    ...configWithProfiles,
    apiKey: configWithProfiles.apiKey ? TTS_API_KEY_MASK : "",
    sourceProfiles,
  };
}

/**
 * Preserve masked provider credentials, encrypt new keys, and keep the active
 * provider fields synchronized with its source profile.
 */
export function prepareTTSConfigForStorage(
  input: TTSConfig,
  existing: TTSConfig,
  encryptKey: (value: string) => string = encryptApiKey,
): TTSConfig {
  const existingProfiles = withActiveSourceProfile(existing).sourceProfiles;
  const sourceProfiles: TTSSourceProfiles = { ...existingProfiles };

  for (const source of TTS_SOURCE_IDS) {
    const incomingProfile = input.sourceProfiles[source];
    if (!incomingProfile) continue;
    sourceProfiles[source] = {
      ...incomingProfile,
      apiKey:
        incomingProfile.apiKey === TTS_API_KEY_MASK
          ? (existingProfiles[source]?.apiKey ?? "")
          : encryptKey(incomingProfile.apiKey),
    };
  }

  const apiKey =
    input.apiKey === TTS_API_KEY_MASK ? (existingProfiles[input.source]?.apiKey ?? "") : encryptKey(input.apiKey);
  const storedConfig: TTSConfig = {
    ...input,
    apiKey,
    sourceProfiles,
  };
  storedConfig.sourceProfiles[input.source] = ttsSourceProfileFromConfig(storedConfig);
  return storedConfig;
}

function responseFromVoiceOptions(
  source: TTSSource,
  voiceOptions: VoiceOption[],
  fromProvider: boolean,
): TTSVoicesResponse {
  return {
    voices: voiceOptions.map((v) => v.id),
    voiceOptions,
    fromProvider,
    source,
  };
}

function fallbackVoices(source: TTSSource): TTSVoicesResponse {
  if (source === "elevenlabs") {
    return responseFromVoiceOptions(source, ELEVENLABS_DEFAULT_VOICES, false);
  }

  if (source === "pockettts") {
    const voices = [
      "alba",
      "giovanni",
      "lola",
      "juergen",
      "rafael",
      "estelle",
      "anna",
      "azelma",
      "bill_boerst",
      "caro_davy",
      "charles",
      "cosette",
      "eponine",
      "eve",
      "fantine",
      "george",
      "jane",
      "jean",
      "javert",
      "marius",
      "mary",
      "michael",
      "paul",
      "peter_yearsley",
      "stuart_bell",
      "vera",
    ];
    return responseFromVoiceOptions(
      source,
      voices.map((voice) => ({ id: voice, name: voice, category: "PocketTTS built-in" })),
      false,
    );
  }

  if (source === "xai") {
    return responseFromVoiceOptions(
      source,
      XAI_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice, category: "xAI built-in" })),
      false,
    );
  }

  return responseFromVoiceOptions(
    source,
    OPENAI_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice })),
    false,
  );
}

/**
 * NanoGPT voices for the selected model. An empty model resolves to the source
 * default rather than an empty list, so a freshly switched card still offers
 * something to pick.
 */
function nanoGptVoiceOptions(model: string): VoiceOption[] {
  const resolved = normalizeNanoGptTtsModelId(model || TTS_SOURCE_DEFINITIONS.nanogpt.defaultModel);

  switch (nanoGptModelFamily(resolved)) {
    case "kokoro":
      return NANOGPT_KOKORO_VOICES.map((voice) => ({
        id: voice.id,
        name: voice.id,
        category: `Kokoro ${voice.category}`,
      }));
    case "elevenlabs":
      return NANOGPT_ELEVENLABS_VOICES.map((voice) => ({ id: voice, name: voice, category: "NanoGPT ElevenLabs" }));
    case "openai":
      return NANOGPT_OPENAI_VOICES.map((voice) => ({ id: voice, name: voice, category: "OpenAI built-in" }));
    default:
      // Gemini, Qwen, MiniMax and Inworld all land here. Offering the OpenAI
      // voices to them was worse than offering nothing: every id was rejected,
      // and the list looked authoritative while being wrong.
      return [];
  }
}

function resolveTtsTimeoutMs(cfg: TTSConfig): number {
  const configured = Number(cfg.timeoutMs);
  if (!Number.isFinite(configured)) return TTS_TIMEOUT_MS_DEFAULT;
  return Math.min(TTS_TIMEOUT_MS_MAX, Math.max(TTS_TIMEOUT_MS_MIN, Math.round(configured)));
}

type PocketTtsApiMode = "official" | "openai";
const pocketTtsApiModeCache = new Map<string, Promise<PocketTtsApiMode>>();

export function resolvePocketTtsApiMode(openApi: unknown): PocketTtsApiMode {
  const paths = asObject(asObject(openApi)?.["paths"]);
  return paths?.["/tts"] ? "official" : "openai";
}

async function detectPocketTtsApiMode(cfg: TTSConfig): Promise<PocketTtsApiMode> {
  const base = configuredBaseUrl(cfg);
  const cached = pocketTtsApiModeCache.get(base);
  if (cached) return cached;

  const pending = (async (): Promise<PocketTtsApiMode> => {
    try {
      const response = await safeFetch(`${base}/openapi.json`, {
        headers: optionalBearerHeaders(cfg.apiKey),
        signal: AbortSignal.timeout(5_000),
        policy: ttsUrlPolicy(),
        maxResponseBytes: 2 * 1024 * 1024,
      });
      if (!response.ok) {
        pocketTtsApiModeCache.delete(base);
        return "openai";
      }
      return resolvePocketTtsApiMode(await response.json());
    } catch {
      pocketTtsApiModeCache.delete(base);
      return "openai";
    }
  })();
  pocketTtsApiModeCache.set(base, pending);
  return pending;
}

function clearPocketTtsApiModeCache(cfg: TTSConfig): void {
  if (cfg.source !== "pockettts") return;
  pocketTtsApiModeCache.delete(configuredBaseUrl(cfg));
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readLabels(value: unknown): Record<string, string | number | boolean | null> | null {
  const obj = asObject(value);
  if (!obj) return null;

  const labels = Object.fromEntries(
    Object.entries(obj).filter((entry): entry is [string, string | number | boolean | null] => {
      const [, labelValue] = entry;
      return (
        labelValue === null ||
        typeof labelValue === "string" ||
        typeof labelValue === "number" ||
        typeof labelValue === "boolean"
      );
    }),
  );

  return Object.keys(labels).length > 0 ? labels : null;
}

function parseVoiceOption(value: unknown): VoiceOption | null {
  if (typeof value === "string") {
    return value.trim() ? { id: value, name: value } : null;
  }

  const obj = asObject(value);
  if (!obj) return null;

  const id =
    readString(obj["voice_id"]) ??
    readString(obj["voiceId"]) ??
    readString(obj["id"]) ??
    readString(obj["name"]) ??
    readString(obj["voice_url"]) ??
    readString(obj["voiceUrl"]) ??
    readString(obj["url"]) ??
    readString(obj["path"]);
  if (!id) return null;

  const name = readString(obj["name"]) ?? readString(obj["display_name"]) ?? readString(obj["displayName"]) ?? id;
  const providerType = readString(obj["type"]);
  return {
    id,
    name,
    description: readString(obj["description"]) ?? null,
    previewUrl: readString(obj["preview_url"]) ?? readString(obj["previewUrl"]) ?? null,
    category: readString(obj["category"]) ?? providerType ?? null,
    labels: readLabels(obj["labels"]),
  };
}

function parseVoiceOptions(data: unknown): VoiceOption[] {
  const list = Array.isArray(data)
    ? data
    : (() => {
        const obj = asObject(data);
        const voices = obj?.["voices"] ?? obj?.["data"];
        return Array.isArray(voices) ? voices : [];
      })();

  return list.map(parseVoiceOption).filter((voice): voice is VoiceOption => Boolean(voice));
}

/**
 * Cloned voices from a vLLM Omni style `uploaded_voices` array. Keyed on `name`
 * because that is what /v1/audio/speech accepts, and `speaker_description` is
 * the closest thing the payload has to a label a person would recognise.
 */
function parseUploadedVoiceOptions(data: unknown): VoiceOption[] {
  const uploaded = asObject(data)?.["uploaded_voices"];
  if (!Array.isArray(uploaded)) return [];

  return uploaded
    .map((entry): VoiceOption | null => {
      const obj = asObject(entry);
      const id = readString(obj?.["name"]);
      if (!id) return null;
      return {
        id,
        name: id,
        description: readString(obj?.["speaker_description"]) ?? readString(obj?.["ref_text"]) ?? null,
        previewUrl: null,
        category: "Uploaded",
        labels: readLabels(obj?.["labels"]),
      };
    })
    .filter((voice): voice is VoiceOption => Boolean(voice));
}

function mergeVoiceOptions(voiceOptions: VoiceOption[]): VoiceOption[] {
  const byId = new Map<string, VoiceOption>();
  for (const option of voiceOptions) {
    const existing = byId.get(option.id);
    if (!existing) {
      byId.set(option.id, option);
      continue;
    }

    byId.set(option.id, {
      ...existing,
      ...option,
      description: option.description ?? existing.description ?? null,
      previewUrl: option.previewUrl ?? existing.previewUrl ?? null,
      category: option.category ?? existing.category ?? null,
      labels: { ...(existing.labels ?? {}), ...(option.labels ?? {}) },
    });
  }
  return [...byId.values()];
}

function readProviderErrorDetail(body: string): string {
  if (!body.trim()) return "";

  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const directDetail = readString(data.detail);
    const error = asObject(data.error);
    const detail = asObject(data.detail);
    const errorMessage = readString(error?.message) ?? readString(error?.status);
    const detailMessage = readString(detail?.message) ?? readString(detail?.status);
    return (
      readString(data.message) ??
      readString(data.error) ??
      errorMessage ??
      directDetail ??
      detailMessage ??
      body.slice(0, 500)
    );
  } catch {
    return body.slice(0, 500);
  }
}

/** Returns true only for an explicit provider-declared audio media type. */
export function isAllowedTTSAudioContentType(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return normalized.startsWith("audio/");
}

/** Detects the supported encoded audio container from its leading bytes. */
export function detectTTSAudioMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return "audio/ogg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return "audio/flac";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm";
  }
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "audio/mp4";
  }
  return null;
}

/**
 * Resolves the safe response media type for provider audio.
 *
 * Generic or missing media types require a recognized encoded container so a
 * JSON/text error body cannot be relabeled as audio.
 */
export function resolveTTSAudioResponseContentType(contentType: string | null, bytes: Uint8Array): string | null {
  const declaredContentType = contentType?.trim() ?? "";
  if (isAllowedTTSAudioContentType(declaredContentType)) return declaredContentType;
  return detectTTSAudioMimeType(bytes);
}

export function resolveTTSRequestVoice(configuredVoice: string, requestedVoice?: string | null): string {
  const trimmedRequest = requestedVoice?.trim();
  return trimmedRequest || configuredVoice;
}

export async function fetchElevenLabsVoiceOptions(
  baseUrl: string,
  apiKey: string,
  query: Record<string, string> = {},
): Promise<VoiceOption[]> {
  const voiceOptions: VoiceOption[] = [];
  const seenPageTokens = new Set<string>();
  let nextPageToken: string | null = null;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${elevenLabsApiRoot(baseUrl)}/v2/voices`);
    url.searchParams.set("page_size", "100");
    url.searchParams.set("include_total_count", "false");
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    if (nextPageToken) {
      url.searchParams.set("next_page_token", nextPageToken);
    }

    const res = await safeFetch(url, {
      headers: elevenLabsHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
      policy: ttsUrlPolicy(),
      maxResponseBytes: 2 * 1024 * 1024,
      decodeCompressedResponse: true,
    });

    if (!res.ok) {
      const detail = readProviderErrorDetail(await res.text().catch(() => ""));
      throw new Error(`ElevenLabs voices request failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }

    const data = await res.json();
    voiceOptions.push(...parseVoiceOptions(data));

    const obj = asObject(data);
    const hasMore = obj?.has_more === true;
    nextPageToken = readString(obj?.next_page_token) ?? null;
    if (!hasMore || !nextPageToken) break;
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error("ElevenLabs voices pagination returned a repeated page token");
    }
    seenPageTokens.add(nextPageToken);
  }

  return voiceOptions;
}

export async function fetchAllElevenLabsVoiceOptions(baseUrl: string, apiKey: string): Promise<VoiceOption[]> {
  const results = await Promise.allSettled([
    fetchElevenLabsVoiceOptions(baseUrl, apiKey),
    fetchElevenLabsVoiceOptions(baseUrl, apiKey, { voice_type: "saved" }),
  ]);
  const successfulResults = results.filter(
    (result): result is PromiseFulfilledResult<VoiceOption[]> => result.status === "fulfilled",
  );
  if (successfulResults.length === 0) {
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    throw new Error(
      errors.length > 0
        ? `ElevenLabs voice discovery failed: ${errors.join("; ")}`
        : "ElevenLabs voice discovery failed",
    );
  }
  return mergeVoiceOptions(successfulResults.flatMap((result) => result.value));
}

export function parseElevenLabsModelOptions(data: unknown): ModelOption[] {
  if (!Array.isArray(data)) return [];

  return data.flatMap((value) => {
    const model = asObject(value);
    const id = readString(model?.model_id);
    if (!id || model?.can_do_text_to_speech !== true) return [];
    return [{ id, name: readString(model?.name) ?? id }];
  });
}

async function fetchElevenLabsModelOptions(baseUrl: string, apiKey: string): Promise<ModelOption[]> {
  const res = await safeFetch(`${elevenLabsApiRoot(baseUrl)}/v1/models`, {
    headers: elevenLabsHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
    policy: ttsUrlPolicy(),
    maxResponseBytes: 2 * 1024 * 1024,
    decodeCompressedResponse: true,
  });
  if (!res.ok) {
    const detail = readProviderErrorDetail(await res.text().catch(() => ""));
    throw new Error(`ElevenLabs models request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return parseElevenLabsModelOptions(await res.json());
}

/** GET /v1/audio-models, the only listing NanoGPT exposes. */
async function fetchNanoGptModelOptions(baseUrl: string, apiKey: string): Promise<NanoGptTtsModel[]> {
  const url = `${nanoGptV1BaseUrl(baseUrl)}/audio-models?type=tts&detailed=true`;
  const res = await safeFetch(url, {
    headers: nanoGptHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
    policy: ttsUrlPolicy(),
    maxResponseBytes: 2 * 1024 * 1024,
  });
  if (!res.ok) {
    const detail = readProviderErrorDetail(await res.text().catch(() => ""));
    throw new Error(`NanoGPT audio-models request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return parseNanoGptModelOptions(await res.json());
}

const nanoGptFallbackModels = (): ModelOption[] => NANOGPT_FALLBACK_TTS_MODELS.map((id) => ({ id, name: id }));

export async function fetchProviderModels(cfg: TTSConfig): Promise<TTSModelsResponse> {
  if (cfg.source === "nanogpt") {
    // The listing answers without a key, so the model dropdown is populated
    // before credentials are entered rather than sitting on stale fallbacks.
    const models = await fetchNanoGptModelOptions(configuredBaseUrl(cfg), cfg.apiKey);
    return {
      models: models.length > 0 ? models.map(({ id, name }) => ({ id, name })) : nanoGptFallbackModels(),
      fromProvider: models.length > 0,
      source: cfg.source,
    };
  }

  if (cfg.source !== "elevenlabs" || !cfg.apiKey || isNanoGptBaseUrl(configuredBaseUrl(cfg))) {
    return {
      models: ELEVENLABS_FALLBACK_MODELS.map((id) => ({ id, name: id })),
      fromProvider: false,
      source: cfg.source,
    };
  }

  const models = await fetchElevenLabsModelOptions(configuredBaseUrl(cfg), cfg.apiKey);
  return {
    models: models.length > 0 ? models : ELEVENLABS_FALLBACK_MODELS.map((id) => ({ id, name: id })),
    fromProvider: models.length > 0,
    source: cfg.source,
  };
}

export async function fetchProviderVoices(cfg: TTSConfig): Promise<TTSVoicesResponse> {
  const base = configuredBaseUrl(cfg);

  if (cfg.source === "pockettts") {
    if ((await detectPocketTtsApiMode(cfg)) === "official") return fallbackVoices(cfg.source);
    const res = await safeFetch(`${pocketTtsV1BaseUrl(base)}/voices`, {
      headers: optionalBearerHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(10_000),
      policy: ttsUrlPolicy(),
      maxResponseBytes: 2 * 1024 * 1024,
    });
    if (!res.ok) return fallbackVoices(cfg.source);
    const voices = mergeVoiceOptions(parseVoiceOptions(await res.json()));
    return voices.length > 0 ? responseFromVoiceOptions(cfg.source, voices, true) : fallbackVoices(cfg.source);
  }

  if (cfg.source === "elevenlabs") {
    if (!cfg.apiKey) return fallbackVoices(cfg.source);

    if (isNanoGptBaseUrl(base)) {
      return responseFromVoiceOptions(
        cfg.source,
        NANOGPT_ELEVENLABS_VOICES.map((voice) => ({ id: voice, name: voice, category: "NanoGPT ElevenLabs" })),
        true,
      );
    }

    const voices = await fetchAllElevenLabsVoiceOptions(base, cfg.apiKey);
    return voices.length > 0 ? responseFromVoiceOptions(cfg.source, voices, true) : fallbackVoices(cfg.source);
  }

  // The vocabulary belongs to whichever backend the selected model routes to,
  // and /audio-models publishes it per model, so the listing decides. The local
  // tables only answer when it cannot be reached.
  if (cfg.source === "nanogpt") {
    const model = normalizeNanoGptTtsModelId(cfg.model || TTS_SOURCE_DEFINITIONS.nanogpt.defaultModel);
    try {
      const published = nanoGptVoicesForModel(
        await fetchNanoGptModelOptions(configuredBaseUrl(cfg), cfg.apiKey),
        model,
      );
      if (published.length > 0) {
        return responseFromVoiceOptions(
          cfg.source,
          published.map((voice) => ({ id: voice, name: voice, category: `NanoGPT ${model}` })),
          true,
        );
      }
      // The listing answered and does not describe this model, which is what a
      // hand-typed id looks like. Say so instead of substituting another
      // backend's voices.
      return responseFromVoiceOptions(cfg.source, [], false);
    } catch (error) {
      logger.warn(error, "NanoGPT audio-models listing failed; falling back to the local voice tables");
      return responseFromVoiceOptions(cfg.source, nanoGptVoiceOptions(model), false);
    }
  }

  if (cfg.source === "xai") {
    if (!cfg.apiKey) return fallbackVoices(cfg.source);
    const res = await safeFetch(`${base}/tts/voices`, {
      headers: openAiHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(10_000),
      policy: ttsUrlPolicy(),
      maxResponseBytes: 2 * 1024 * 1024,
    });
    if (!res.ok) return fallbackVoices(cfg.source);
    const voices = parseVoiceOptions(await res.json());
    return voices.length > 0 ? responseFromVoiceOptions(cfg.source, voices, true) : fallbackVoices(cfg.source);
  }

  const res = await safeFetch(`${base}/audio/voices`, {
    headers: openAiHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(10_000),
    policy: ttsUrlPolicy(),
    maxResponseBytes: 2 * 1024 * 1024,
  });

  if (!res.ok) return fallbackVoices(cfg.source);

  const payload = await res.json();
  // vLLM Omni answers with `voices` plus an `uploaded_voices` array describing
  // cloned samples. Its example mirrors those names into `voices`, so merging is
  // usually a no-op that carries the description across; where a build does not
  // mirror them, it is the only way a cloned voice appears at all.
  const voices = mergeVoiceOptions([...parseVoiceOptions(payload), ...parseUploadedVoiceOptions(payload)]);
  return voices.length > 0 ? responseFromVoiceOptions(cfg.source, voices, true) : fallbackVoices(cfg.source);
}

// ── Routes ──────────────────────────────────────

export async function ttsRoutes(app: FastifyInstance) {
  const storage = createAppSettingsStorage(app.db);
  const connections = createConnectionsStorage(app.db);

  /**
   * GET /api/tts/config
   * Returns TTS config with the API key masked.
   */
  app.get("/config", async () => {
    const raw = await storage.get(TTS_SETTINGS_KEY);
    const cfg = parseStoredConfig(raw);
    return maskTTSConfigForResponse(cfg);
  });

  /**
   * PUT /api/tts/config
   * Saves TTS config. Encrypts the API key before storage.
   * If apiKey equals the mask, the existing key is kept unchanged.
   */
  app.put("/config", async (req, reply) => {
    const input = ttsConfigSchema.parse(req.body);
    const existing = parseStoredConfig(await storage.get(TTS_SETTINGS_KEY));
    const storedConfig = prepareTTSConfigForStorage(input, existing);
    clearPocketTtsApiModeCache(existing);
    clearPocketTtsApiModeCache(storedConfig);
    await storage.set(TTS_SETTINGS_KEY, JSON.stringify(storedConfig));
    return reply.status(204).send();
  });

  /**
   * GET /api/tts/effective-config
   * The configuration a speak request would actually use: app-level settings
   * merged with the resolved audio connection, keys masked.
   *
   * Clients read speechEnabled instead of re-deriving the gate, and
   * resolvedConnectionId so a cached clip is not replayed after the engine
   * behind it changed. Omitting connectionId resolves the category default,
   * which is what an unattended autoplay will reach.
   */
  app.get("/effective-config", async (req) => {
    const { connectionId, purpose } = ttsQuerySchema.parse(req.query ?? {});
    const resolution = await resolveAudioConfig(storage, connections, connectionId, purpose ?? "speech");
    return {
      config: maskTTSConfigForResponse(resolution.cfg),
      resolvedConnectionId: resolution.resolvedConnectionId,
      resolvedConnectionName: resolution.resolvedConnectionName,
      resolvedSource: resolution.resolvedSource,
      origin: resolution.origin,
      speechEnabled: resolution.speechEnabled,
      purpose: resolution.purpose,
      gameAudioEnabled: resolution.gameAudioEnabled,
    } satisfies TTSEffectiveConfigResponse;
  });

  /**
   * GET /api/tts/voices
   * Fetches available voices from the configured provider.
   */
  app.get("/voices", async (req, reply) => {
    const { connectionId, model } = ttsQuerySchema.parse(req.query ?? {});
    // Without an explicit connection this endpoint answers for the app-level
    // settings. Resolving the default audio connection here instead would
    // describe an engine the caller did not ask about.
    const resolved = connectionId
      ? (await resolveAudioConfig(storage, connections, connectionId)).cfg
      : await loadConfig(storage);
    // The editor asks about the model it is showing, which may not be saved yet.
    const cfg = model ? { ...resolved, model } : resolved;

    try {
      return await fetchProviderVoices(cfg);
    } catch (error) {
      logger.warn(error, "TTS voice discovery failed for source %s", cfg.source);
      if (cfg.source === "elevenlabs" && cfg.apiKey) {
        return reply.status(502).send({
          error: "Could not load ElevenLabs voices. Check the connection and try again.",
          detail: error instanceof Error ? error.message : "Unknown provider error",
        });
      }
      return fallbackVoices(cfg.source);
    }
  });

  /**
   * GET /api/tts/models
   * Fetches text-to-speech-capable models from ElevenLabs.
   */
  app.get("/models", async (req, reply) => {
    const { connectionId } = ttsQuerySchema.parse(req.query ?? {});
    const cfg = connectionId
      ? (await resolveAudioConfig(storage, connections, connectionId)).cfg
      : await loadConfig(storage);

    try {
      return await fetchProviderModels(cfg);
    } catch (error) {
      logger.warn(error, "TTS model discovery failed for source %s", cfg.source);
      return reply.status(502).send({
        error: "Could not load ElevenLabs models. Check the connection and try again.",
        detail: error instanceof Error ? error.message : "Unknown provider error",
      });
    }
  });

  /**
   * POST /api/tts/roleplay-speaker-extractor
   * Uses one isolated LLM call to classify the newest Roleplay message for ordered TTS playback.
   */
  app.post("/roleplay-speaker-extractor", async (req, reply) => {
    const input = roleplaySpeakerExtractorSchema.parse(req.body);
    const cfg = await loadConfig(storage);
    if (!cfg.roleplaySpeakerExtractorEnabled) {
      return reply.status(400).send({ error: "Roleplay speaker extractor is not enabled" });
    }

    const configuredConnectionId = cfg.roleplaySpeakerExtractorConnectionId.trim();
    const connection = configuredConnectionId
      ? await connections.getWithKey(configuredConnectionId)
      : await connections.getDefaultForAgents();
    if (!connection) {
      return reply.status(400).send({
        error: configuredConnectionId
          ? "The selected Roleplay speaker extractor connection is unavailable"
          : "No default agent connection is configured for Roleplay speaker extractor",
      });
    }
    if (
      connection.provider === "image_generation" ||
      connection.provider === "video_generation" ||
      connection.provider === "audio"
    ) {
      return reply.status(400).send({ error: "Roleplay speaker extractor requires a language-model connection" });
    }

    const baseUrl = resolveBaseUrl(connection);
    if (!baseUrl || !connection.model.trim()) {
      return reply.status(400).send({ error: "Roleplay speaker extractor connection has no usable model or Base URL" });
    }

    const includeEmotions = cfg.roleplaySpeakerExtractorEmotionsEnabled;
    const systemPrompt = buildRoleplaySpeakerExtractorPrompt({
      group: input.group,
      user: input.user || "User",
      characters: input.characters,
      messageAuthor: input.messageAuthor,
      includeEmotions,
    });
    const userPrompt = buildRoleplaySpeakerExtractorUserPrompt(input.message);
    logDebugOverride(input.debugMode, "[debug/tts/speaker-extractor] system prompt:\n%s", systemPrompt);
    logDebugOverride(input.debugMode, "[debug/tts/speaker-extractor] user prompt:\n%s", userPrompt);

    const storedOptions = resolveStoredChatOptions(connection.defaultParameters, connection.provider, connection.model);
    const maxTokens = clampGenerationMaxOutputTokens({
      provider: connection.provider,
      model: connection.model,
      maxTokens: resolveStoredMaxTokens(connection.defaultParameters, 8192),
      maxTokensOverride: connection.maxTokensOverride,
    });
    const provider = createLLMProvider(
      connection.provider,
      baseUrl,
      connection.apiKey,
      connection.maxContext,
      connection.openrouterProvider,
      connection.maxTokensOverride,
      connection.claudeFastMode === "true",
      connection.treatAsLocalEndpoint === "true",
      undefined,
      connection.id,
    );

    try {
      const {
        temperature: _storedTemperature,
        customParameters,
        enabledParameters,
        ...connectionOptions
      } = storedOptions;
      const result = await provider.chatComplete(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        {
          ...connectionOptions,
          model: connection.model,
          maxTokens,
          maxContext: connection.maxContext,
          customParameters: withoutTemperatureCustomParameter(customParameters),
          enabledParameters: {
            ...enabledParameters,
            temperature: false,
            maxTokens: true,
          },
          enableCaching: connection.enableCaching === "true",
          anthropicExtendedCacheTtl: connection.anthropicExtendedCacheTtl === "true",
          cachingAtDepth: Number(connection.cachingAtDepth) || 5,
          responseFormat: { type: "json_object" },
          debugMode: input.debugMode,
          signal: AbortSignal.timeout(getChatGenerationTimeoutMs()),
        },
      );
      const raw = result.content?.trim() ?? "";
      logDebugOverride(input.debugMode, "[debug/tts/speaker-extractor] raw response:\n%s", raw);
      if (!raw) throw new Error("Speaker extractor returned an empty response");
      return parseRoleplaySpeakerExtractorOutput(raw, input.message, includeEmotions);
    } catch (error) {
      logger.warn(error, "Roleplay speaker extractor failed with connection %s", connection.id);
      return reply.status(502).send({
        error: "Roleplay speaker extractor failed",
        detail: error instanceof Error ? error.message : "Unknown provider error",
      });
    }
  });

  /**
   * POST /api/tts/game-audio
   * Generates and caches scene-specific Game Mode music or sound effects.
   */
  app.post("/game-audio", async (req, reply) => {
    const { kind, prompt, audioConnectionId, context } = gameAudioSchema.parse(req.body);
    if (context && kind !== "music") {
      return reply.status(400).send({ error: "Context tracks are music only" });
    }
    if (kind === "music" && !context) {
      // The per-prompt 30-second music path is retired (#5161); leaving it
      // reachable would let stray callers keep filling music/generated/ with
      // clips nothing selects.
      return reply.status(400).send({ error: "Music generation requires a context key (area or tier)" });
    }
    if (context?.axis === "tier") {
      // Aliases (elite, legendary, …) are accepted but the STORED key must be
      // canonical — a music/tier/elite/ folder would be a paid composition the
      // scorer can never select.
      const canonicalTier = normalizeMusicEnemyTier(context.key);
      if (!canonicalTier) {
        return reply.status(400).send({ error: `Unknown encounter tier "${context.key}"` });
      }
      context.key = canonicalTier;
    }
    // kind names the lane, so a caller that sends no connection id still reaches
    // the engine this purpose was pointed at rather than the one that speaks.
    const { cfg, gameAudioEnabled } = await resolveAudioConfig(storage, connections, audioConnectionId, kind);
    if (gameAudioEnabled !== true) {
      return reply
        .status(400)
        .send({ error: `Game ${kind} generation is not enabled for the resolved audio connection` });
    }
    if (cfg.source !== "elevenlabs") {
      // TTS_SOURCE_DEFINITIONS decides which sources MAY generate; this dispatch
      // names the only generator that exists. A source turning its table flag on
      // needs a generator here before the flag can mean anything.
      return reply.status(400).send({ error: `No game ${kind} generator exists for source "${cfg.source}"` });
    }
    if (!cfg.apiKey) {
      return reply.status(400).send({ error: "ElevenLabs API key is not configured" });
    }

    const normalizedPrompt = normalizeGameAudioPrompt(prompt);
    // Context generations lock on their KEY: two turns racing the same area
    // must collapse into one composition even when their prompts differ.
    const lockKey = context ? `context\0${context.axis}\0${context.key}` : `${kind}\0${normalizedPrompt.toLowerCase()}`;
    let generation = gameAudioGenerationLocks.get(lockKey);
    if (!generation) {
      generation = generateElevenLabsGameAudio(cfg, kind, normalizedPrompt, context).finally(() => {
        gameAudioGenerationLocks.delete(lockKey);
      });
      gameAudioGenerationLocks.set(lockKey, generation);
    }
    try {
      return await generation;
    } catch (error) {
      logger.error(error, "ElevenLabs game %s generation failed", kind);
      return reply.status(502).send({
        error: `ElevenLabs game ${kind} generation failed`,
        detail: error instanceof Error ? error.message : "Unknown provider error",
      });
    }
  });

  /**
   * POST /api/tts/speak
   * Proxies a TTS request to the configured provider and streams the audio back.
   */
  app.post("/speak", async (req, reply) => {
    const { text, speaker, tone, voice, audioConnectionId } = speakSchema.parse(req.body);

    const { cfg, speechEnabled } = await resolveAudioConfig(storage, connections, audioConnectionId);

    if (!speechEnabled) {
      return reply.status(400).send({ error: "TTS is not enabled" });
    }

    if (cfg.source === "elevenlabs" && !cfg.apiKey) {
      return reply.status(400).send({ error: "ElevenLabs API key is not configured" });
    }

    if (cfg.source === "xai" && !cfg.apiKey) {
      return reply.status(400).send({ error: "xAI API key is not configured" });
    }

    const requestVoice = resolveTTSRequestVoice(cfg.voice, voice);

    if (cfg.source === "elevenlabs" && !requestVoice) {
      return reply.status(400).send({ error: "ElevenLabs voice is not selected" });
    }

    const pocketTtsApiMode = cfg.source === "pockettts" ? await detectPocketTtsApiMode(cfg) : undefined;
    const provider = createTTSProvider(cfg, { pocketTtsMode: pocketTtsApiMode ?? undefined });
    const model = provider.resolveModel();
    if (cfg.source === "elevenlabs" && ELEVENLABS_NON_TTS_MODELS.has(model.toLowerCase())) {
      return reply.status(400).send({
        error: `ElevenLabs model "${model}" cannot generate text-to-speech`,
        detail: `That model is for Text to Voice / voice design. Use "eleven_v3" for Eleven v3 speech, or "eleven_multilingual_v2", "eleven_flash_v2_5", or "eleven_turbo_v2_5" for regular TTS.`,
      });
    }

    const speechRequest = provider.buildSpeechRequest({ text, voice: requestVoice, speaker, tone });

    const timeoutMs = resolveTtsTimeoutMs(cfg);
    // Bound to reply.raw, not req.raw: on a plain POST the request message
    // completes as soon as the body is parsed, so req.raw "close" fires while
    // synthesis is still running and would abort every request. reply.raw
    // "close" fires only when the response finishes or the peer hangs up.
    const clientGone = new AbortController();
    reply.raw.once("close", () => clientGone.abort());

    let providerRes: Response;
    try {
      providerRes = await safeFetch(speechRequest.url, {
        method: "POST",
        headers: speechRequest.headers,
        body: speechRequest.body,
        signal: AbortSignal.any([clientGone.signal, AbortSignal.timeout(timeoutMs)]),
        policy: ttsUrlPolicy(),
        maxResponseBytes: MAX_TTS_AUDIO_BYTES,
        decodeCompressedResponse: speechRequest.decodeCompressedResponse,
      });
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      if (clientGone.signal.aborted && name !== "TimeoutError") {
        // The listener navigated away or stopped playback. Not a failure, and
        // nobody is left to read the reply.
        req.log.debug("TTS synthesis abandoned by the client");
        return reply.status(499).send({ error: "TTS request aborted", code: "aborted" });
      }
      const timedOut = name === "TimeoutError";
      req.log.error(err, "TTS provider request failed");
      return reply.status(502).send({
        error: timedOut ? `TTS request timed out after ${Math.round(timeoutMs / 1000)}s` : "TTS provider unreachable",
        code: timedOut ? "timeout" : "unreachable",
      });
    }

    if (!providerRes.ok) {
      const body = await providerRes.text().catch(() => "");
      return reply.status(502).send({
        error: `TTS provider returned ${providerRes.status}`,
        detail: readProviderErrorDetail(body),
        code: "provider_error",
      });
    }

    const contentType = providerRes.headers.get("content-type");
    let audioBuffer: ArrayBuffer;
    try {
      audioBuffer = await providerRes.arrayBuffer();
    } catch (error: unknown) {
      logger.error(error, "Failed to read TTS provider response body");
      return reply.status(502).send({ error: "TTS provider response could not be read", code: "provider_error" });
    }

    const responseContentType = resolveTTSAudioResponseContentType(contentType, new Uint8Array(audioBuffer));
    if (!responseContentType) {
      const body = new TextDecoder().decode(audioBuffer);
      return reply.status(502).send({
        error: "TTS provider returned a non-audio response",
        detail: readProviderErrorDetail(body) || `Content-Type: ${contentType || "missing"}`,
        code: "provider_error",
      });
    }

    reply.header("Content-Type", responseContentType);
    reply.header("Content-Length", String(audioBuffer.byteLength));
    return reply.send(Buffer.from(audioBuffer));
  });
}
