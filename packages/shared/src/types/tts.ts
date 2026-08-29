// ──────────────────────────────────────────────
// TTS Types
// ──────────────────────────────────────────────
import { z } from "zod";
import { AUDIO_PURPOSES, type AudioPurpose } from "../constants/audio-purposes.js";
import { TTS_SOURCE_IDS, type TTSSourceId } from "../constants/tts-sources.js";

export const ttsSourceSchema = z.enum(TTS_SOURCE_IDS);
export type TTSSource = z.infer<typeof ttsSourceSchema>;

export const ttsAudioFormatSchema = z.enum(["mp3", "wav"]);
export type TTSAudioFormat = z.infer<typeof ttsAudioFormatSchema>;

export const ttsVoiceModeSchema = z.enum(["single", "per-character"]);
export type TTSVoiceMode = z.infer<typeof ttsVoiceModeSchema>;

export const TTS_DIALOGUE_PAUSE_MIN_SECONDS = 1;
export const TTS_DIALOGUE_PAUSE_MAX_SECONDS = 60;
export const TTS_DIALOGUE_PAUSE_DEFAULT_SECONDS = 1;

// Synthesis tuning bounds. Shared by the Zod schema, the settings sliders, and
// the server-side clamp so the three cannot drift.
export const TTS_TIMEOUT_MS_MIN = 5_000;
export const TTS_TIMEOUT_MS_MAX = 600_000;
export const TTS_TIMEOUT_MS_DEFAULT = 60_000;
/** Must equal speakSchema's text cap in tts.routes.ts. */
export const TTS_CHUNK_CHARS_MAX = 4096;
export const TTS_CHUNK_CHARS_MIN = 200;
export const TTS_CHUNK_CHARS_DEFAULT = 900;
export const TTS_MAX_RETRIES_MIN = 0;
export const TTS_MAX_RETRIES_MAX = 3;
export const TTS_MAX_RETRIES_DEFAULT = 1;
export const TTS_CONCURRENCY_MIN = 1;
export const TTS_CONCURRENCY_MAX = 4;
export const TTS_CONCURRENCY_DEFAULT = 1;

/** Serialized ceiling for one lane's parameters. Every request carries them. */
export const AUDIO_PARAMETERS_MAX_BYTES = 8_192;

/**
 * Extra provider parameters for one routing lane, merged into the outbound
 * request body. Values are unconstrained because no backend's schema is knowable
 * here: a wrong key is the provider's error to report, not this app's to guess.
 * Nested objects are kept, since ElevenLabs takes its knobs inside voice_settings.
 */
const audioParameterRecordSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  if (JSON.stringify(value).length > AUDIO_PARAMETERS_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Parameters must serialize to at most ${AUDIO_PARAMETERS_MAX_BYTES} characters`,
    });
  }
});
export type AudioParameterRecord = z.infer<typeof audioParameterRecordSchema>;

// Keyed off AUDIO_PURPOSES so a new lane cannot be parameterized in one place
// and silently unparameterizable in another.
export const audioParametersSchema = z
  .object(
    Object.fromEntries(AUDIO_PURPOSES.map((purpose) => [purpose, audioParameterRecordSchema.optional()])) as {
      [K in AudioPurpose]: z.ZodOptional<typeof audioParameterRecordSchema>;
    },
  )
  .default({});
export type AudioParameterMap = z.infer<typeof audioParametersSchema>;

function normalizeDialoguePauseMs(value: number): number {
  const wholeSeconds = Math.round(value / 1000);
  return Math.min(TTS_DIALOGUE_PAUSE_MAX_SECONDS, Math.max(TTS_DIALOGUE_PAUSE_MIN_SECONDS, wholeSeconds)) * 1000;
}

export const ttsConversationCallAudioInputModeSchema = z.enum(["system", "auto", "transcribe", "local_whisper"]);
export type TTSConversationCallAudioInputMode = z.infer<typeof ttsConversationCallAudioInputModeSchema>;

export const ttsVoiceAssignmentSchema = z.object({
  characterId: z.string().default(""),
  characterName: z.string().default(""),
  voice: z.string().default(""),
});
export type TTSVoiceAssignment = z.infer<typeof ttsVoiceAssignmentSchema>;

export const ELEVENLABS_TTS_LANGUAGE_OPTIONS = [
  { code: "", label: "Auto detect" },
  { code: "af", label: "Afrikaans" },
  { code: "ar", label: "Arabic" },
  { code: "hy", label: "Armenian" },
  { code: "as", label: "Assamese" },
  { code: "az", label: "Azerbaijani" },
  { code: "be", label: "Belarusian" },
  { code: "bn", label: "Bengali" },
  { code: "bs", label: "Bosnian" },
  { code: "bg", label: "Bulgarian" },
  { code: "ca", label: "Catalan" },
  { code: "ceb", label: "Cebuano" },
  { code: "ny", label: "Chichewa" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "et", label: "Estonian" },
  { code: "fil", label: "Filipino" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "gl", label: "Galician" },
  { code: "ka", label: "Georgian" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "gu", label: "Gujarati" },
  { code: "ha", label: "Hausa" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "is", label: "Icelandic" },
  { code: "id", label: "Indonesian" },
  { code: "ga", label: "Irish" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "jv", label: "Javanese" },
  { code: "kn", label: "Kannada" },
  { code: "kk", label: "Kazakh" },
  { code: "ky", label: "Kirghiz" },
  { code: "ko", label: "Korean" },
  { code: "lv", label: "Latvian" },
  { code: "ln", label: "Lingala" },
  { code: "lt", label: "Lithuanian" },
  { code: "lb", label: "Luxembourgish" },
  { code: "mk", label: "Macedonian" },
  { code: "ms", label: "Malay" },
  { code: "ml", label: "Malayalam" },
  { code: "zh", label: "Mandarin Chinese" },
  { code: "mr", label: "Marathi" },
  { code: "ne", label: "Nepali" },
  { code: "no", label: "Norwegian" },
  { code: "ps", label: "Pashto" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "pa", label: "Punjabi" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sr", label: "Serbian" },
  { code: "sd", label: "Sindhi" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "so", label: "Somali" },
  { code: "es", label: "Spanish" },
  { code: "sw", label: "Swahili" },
  { code: "sv", label: "Swedish" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "vi", label: "Vietnamese" },
  { code: "cy", label: "Welsh" },
] as const;

const ttsConfigBaseSchema = z.object({
  enabled: z.boolean().default(false),
  source: ttsSourceSchema.default("openai"),
  baseUrl: z.string().default("https://api.openai.com/v1"),
  /** Plain text on write; masked "••••••" on read when a key is saved */
  apiKey: z.string().default(""),
  voice: z.string().default("alloy"),
  model: z.string().default("tts-1"),
  /** 0.25 – 4.0 */
  speed: z.number().min(0.25).max(4.0).default(1.0),
  /** ElevenLabs only: 0.0 = more expressive/creative, 1.0 = more stable/robust */
  elevenLabsStability: z.number().min(0).max(1).default(0.5),
  /** ElevenLabs only: optional language_code. Empty means automatic language detection. */
  elevenLabsLanguageCode: z.string().max(8).default(""),
  /** ElevenLabs only: generate scene-specific Game Mode sound effects. */
  elevenLabsGameSoundEffects: z.boolean().default(false),
  /** ElevenLabs only: generate scene-specific Game Mode music. */
  elevenLabsGameMusic: z.boolean().default(false),
  voiceMode: ttsVoiceModeSchema.default("single"),
  voiceAssignments: z.array(ttsVoiceAssignmentSchema).default([]),
  narratorVoiceEnabled: z.boolean().default(false),
  narratorVoice: z.string().default(""),
  npcDefaultVoicesEnabled: z.boolean().default(false),
  npcDefaultMaleVoices: z.array(z.string()).default([]),
  npcDefaultFemaleVoices: z.array(z.string()).default([]),
  autoplayRP: z.boolean().default(false),
  autoplayConvo: z.boolean().default(false),
  autoplayGame: z.boolean().default(false),
  /** Play each chunk as it finishes instead of synthesizing the whole message first.
   *  The true default only reaches installs without a parseable saved blob; a saved
   *  config carries its own explicit value. */
  progressivePlayback: z.boolean().default(true),
  /** Provider request budget. Authoritative server-side; the client adds grace on top. */
  timeoutMs: z.number().int().min(TTS_TIMEOUT_MS_MIN).max(TTS_TIMEOUT_MS_MAX).default(TTS_TIMEOUT_MS_DEFAULT),
  /** Client chunker cap, clamped again to the source's maxInputChars. */
  chunkCharLimit: z.number().int().min(TTS_CHUNK_CHARS_MIN).max(TTS_CHUNK_CHARS_MAX).default(TTS_CHUNK_CHARS_DEFAULT),
  /** Per-chunk retries for 5xx, network, and timeout failures. Never 4xx, never caller aborts. */
  maxRetries: z.number().int().min(TTS_MAX_RETRIES_MIN).max(TTS_MAX_RETRIES_MAX).default(TTS_MAX_RETRIES_DEFAULT),
  /** Synthesis requests in flight ahead of playback. 1 keeps single-worker local engines serial. */
  generationConcurrency: z
    .number()
    .int()
    .min(TTS_CONCURRENCY_MIN)
    .max(TTS_CONCURRENCY_MAX)
    .default(TTS_CONCURRENCY_DEFAULT),
  /** Per-lane extra parameters merged into the outbound provider request. */
  audioParameters: audioParametersSchema,
  dialogueOnly: z.boolean().default(false),
  /** Use a short auxiliary LLM call to separate Roleplay dialogue by speaker before autoplay. */
  roleplaySpeakerExtractorEnabled: z.boolean().default(false),
  /** Empty uses the connection marked as the default for agents. */
  roleplaySpeakerExtractorConnectionId: z.string().default(""),
  /** Ask the extractor to annotate dialogue with provider-supported emotion cues. */
  roleplaySpeakerExtractorEmotionsEnabled: z.boolean().default(false),
  /** Stored in milliseconds for backward compatibility; the setting is configured in whole seconds. */
  dialoguePauseMs: z
    .number()
    .min(0)
    .max(TTS_DIALOGUE_PAUSE_MAX_SECONDS * 1000)
    .default(TTS_DIALOGUE_PAUSE_DEFAULT_SECONDS * 1000)
    .transform(normalizeDialoguePauseMs),
  audioFormat: ttsAudioFormatSchema.default("mp3"),
  /** Global gate for Conversation-mode calls. Individual chats opt in separately. */
  callAudioEnabled: z.boolean().default(false),
  /** Deprecated: call transcription now uses the active conversation connection. */
  callSttConnectionId: z.string().default(""),
  /** Deprecated: call transcription now follows the selected call audio input mode. */
  callSttModel: z.string().default(""),
  /** Conversation call mic path: local Whisper, browser speech, manual OS dictation, or provider-native media. */
  callAudioInputMode: ttsConversationCallAudioInputModeSchema.default("local_whisper"),
  /** UI gate for camera/screen controls. Provider-native video input remains capability-gated by the call pipeline. */
  callVideoInputEnabled: z.boolean().default(false),
  /** Generate and play cached character presence videos during Conversation Calls. */
  callCharacterVideoEnabled: z.boolean().default(false),
  /** Automatically generate the minimum idle/talking call-presence clips for call participants. */
  callAutomaticVideoClipsEnabled: z.boolean().default(false),
  /** Let characters sparsely generate custom call-presence clips on explicit user request. */
  callCustomVideoClipsEnabled: z.boolean().default(false),
  /** Deprecated: soundboard is always available during calls. */
  callSoundboardEnabled: z.boolean().default(true),
});

export const ttsSourceProfileSchema = ttsConfigBaseSchema.pick({
  baseUrl: true,
  apiKey: true,
  voice: true,
  model: true,
  speed: true,
  elevenLabsStability: true,
  elevenLabsLanguageCode: true,
  elevenLabsGameSoundEffects: true,
  elevenLabsGameMusic: true,
  voiceMode: true,
  voiceAssignments: true,
  narratorVoiceEnabled: true,
  narratorVoice: true,
  npcDefaultVoicesEnabled: true,
  npcDefaultMaleVoices: true,
  npcDefaultFemaleVoices: true,
  audioFormat: true,
  timeoutMs: true,
  chunkCharLimit: true,
  maxRetries: true,
  generationConcurrency: true,
  audioParameters: true,
});
export type TTSSourceProfile = z.infer<typeof ttsSourceProfileSchema>;

// Keyed off TTS_SOURCE_IDS rather than hand-listed: a source missing here still
// compiles everywhere except the indexed reads, and the symptom is a source
// whose saved settings silently fail to persist across a switch.
export const ttsSourceProfilesSchema = z
  .object(
    Object.fromEntries(TTS_SOURCE_IDS.map((id) => [id, ttsSourceProfileSchema.optional()])) as {
      [K in TTSSourceId]: z.ZodOptional<typeof ttsSourceProfileSchema>;
    },
  )
  .default({});
export type TTSSourceProfiles = z.infer<typeof ttsSourceProfilesSchema>;

export const ttsConfigSchema = ttsConfigBaseSchema.extend({
  /** Encrypted-at-rest provider fields retained independently for each TTS source. */
  sourceProfiles: ttsSourceProfilesSchema,
});

export type TTSConfig = z.infer<typeof ttsConfigSchema>;

/**
 * Projects a config onto the per-source profile fields.
 * Derived from the schema rather than hand-listed: the field list existed twice
 * and a field added to one side silently vanished from saved profiles.
 * Safe because TTSConfig is already parsed and the profile is a pick of its schema.
 */
export function ttsSourceProfileFromConfig(config: TTSConfig): TTSSourceProfile {
  return ttsSourceProfileSchema.parse(config);
}

export const TTS_SETTINGS_KEY = "tts";
export const TTS_API_KEY_MASK = "••••••";

export const ttsRoleplaySpeakerSegmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("narration"),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({
    kind: z.literal("dialogue"),
    speaker: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(100_000),
    tone: z.string().trim().min(1).max(80).optional(),
  }),
]);
export type TTSRoleplaySpeakerSegment = z.infer<typeof ttsRoleplaySpeakerSegmentSchema>;

export const ttsRoleplaySpeakerExtractorResponseSchema = z.object({
  // Up to 500 dialogue lines can produce one narration segment before, between,
  // and after them: 500 dialogue + 501 narration segments.
  segments: z.array(ttsRoleplaySpeakerSegmentSchema).max(1001),
});
export type TTSRoleplaySpeakerExtractorResponse = z.infer<typeof ttsRoleplaySpeakerExtractorResponseSchema>;

/** Returned by GET /api/tts/voices */
export interface TTSVoicesResponse {
  voices: string[];
  voiceOptions?: Array<{
    id: string;
    name: string;
    description?: string | null;
    previewUrl?: string | null;
    category?: string | null;
    labels?: Record<string, string | number | boolean | null> | null;
  }>;
  /** True when the list came from the provider; false = local fallback or no provider voices */
  fromProvider: boolean;
  source: TTSSource;
}

/** Returned by GET /api/tts/models */
export interface TTSModelsResponse {
  models: Array<{
    id: string;
    name: string;
  }>;
  /** True when the list came from the provider; false = built-in fallback choices */
  fromProvider: boolean;
  source: TTSSource;
}

/**
 * Which rule picked the engine behind an effective config. The purpose values
 * mean a sound effect or music pair answered; a game purpose falling through to
 * the base audio pair reports "default" or "fallback" like speech does.
 */
export type TTSResolutionOrigin =
  | "explicit"
  | "purpose_default"
  | "purpose_fallback"
  | "default"
  | "fallback"
  | "legacy";

/** Returned by GET /api/tts/effective-config */
export interface TTSEffectiveConfigResponse {
  /** App-level settings merged with the resolved connection, masked for transport. */
  config: TTSConfig;
  resolvedConnectionId: string | null;
  resolvedConnectionName: string | null;
  resolvedSource: TTSSource;
  origin: TTSResolutionOrigin;
  /** Whether /speak will synthesize. Clients gate on this, never on config.enabled. */
  speechEnabled: boolean;
  /** Routing lane this answer is for; "speech" when the request named none. */
  purpose: AudioPurpose;
  /**
   * sfx and music: whether the resolved engine may generate for this purpose,
   * meaning its source supports it and the connection opted in. null for speech.
   * A missing API key is a separate failure and is not folded in here.
   */
  gameAudioEnabled: boolean | null;
}
