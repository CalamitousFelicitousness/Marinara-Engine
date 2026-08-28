// ──────────────────────────────────────────────
// TTS Source Metadata
// ──────────────────────────────────────────────
// Single definition of the TTS backends and their per-source defaults.
// Consumers that each carried a private copy of the id list, the default
// baseUrl/model/voice triple, or both:
//   ttsSourceSchema                 packages/shared/src/types/tts.ts
//   audioGenerationSourceSchema     packages/shared/src/schemas/connection.schema.ts
//   AUDIO_GENERATION_SOURCES        packages/shared/src/types/connection.ts
//   TTS_SOURCE_DEFAULTS/TTS_SOURCES packages/server/src/routes/tts.routes.ts
//   TTS_SOURCE_DEFAULTS             packages/client .../settings/TTSConfigCard.tsx
//   AUDIO_SOURCE_OPTIONS            packages/client .../connections/ConnectionEditor.tsx
//
// PROVIDERS.audio (constants/providers.ts) describes the audio *connection row*;
// this table describes the sub-source that connection targets. Different axes,
// do not merge.
//
// Per-model behavior (ElevenLabs speed support, OpenAI speech instructions,
// forced response formats, auth header shape, gzip decoding) is deliberately
// absent: it varies by model, not by source, and lives in the server providers.

/**
 * NanoGPT speech models, shown before the live /audio-models listing arrives
 * and whenever it cannot be reached. Their catalog moves, so the model field
 * accepts anything: this is a starting set, not a whitelist.
 */
export const NANOGPT_TTS_MODEL_IDS = [
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
  "Kokoro-82m",
  "Elevenlabs-Turbo-V2.5",
  "Elevenlabs-V3",
] as const;

export const TTS_SOURCE_IDS = ["openai", "elevenlabs", "nanogpt", "pockettts", "xai"] as const;
export type TTSSourceId = (typeof TTS_SOURCE_IDS)[number];

/**
 * Sources that publish a model list; the rest take a free-text model id.
 *
 * Read by both the card, to decide between a dropdown and a text field, and the
 * models query, to decide whether to fetch at all. Those two lived apart, and a
 * source in one but not the other renders a dropdown that is never filled.
 */
export const TTS_SOURCES_WITH_MODEL_LISTING: readonly TTSSourceId[] = ["elevenlabs", "nanogpt"];

export interface TTSSourceDefinition {
  id: TTSSourceId;
  /** Backend name. Product noun, not UI copy; surfaces unlocalized as it always has. */
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** Empty where the source has no usable built-in default: ElevenLabs voice ids are account-scoped. */
  defaultVoice: string;
  /** Ceiling for one synthesis request. speakSchema caps every source at 4096; a source may sit lower. */
  maxInputChars: number;
  /** Default client chunk size. Local engines want far less; the setting overrides per source profile. */
  recommendedChunkChars: number;
  /**
   * Whether the endpoint is worth putting on screen. A "fixed" source publishes one
   * address, so the editor keeps the field behind a disclosure instead of asking for
   * it. Presentation only: a stored baseUrl is always honored, and outbound URL
   * policy is source-blind.
   */
  baseUrlMode: "fixed" | "editable";
}

export const TTS_SOURCE_DEFINITIONS: Record<TTSSourceId, TTSSourceDefinition> = {
  openai: {
    id: "openai",
    name: "OpenAI-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "tts-1",
    defaultVoice: "alloy",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
    // Doubles as the lane for every OpenAI-compatible engine, local ones included,
    // so the address is the setting that matters here.
    baseUrlMode: "editable",
  },
  elevenlabs: {
    id: "elevenlabs",
    name: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io",
    defaultModel: "eleven_multilingual_v2",
    defaultVoice: "",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
    baseUrlMode: "fixed",
  },
  nanogpt: {
    id: "nanogpt",
    name: "NanoGPT",
    // The OpenAI-compatible surface. NanoGPT's native /api/tts is richer but
    // answers 202 for the ElevenLabs models and returns a storage URL to fetch,
    // which this path does not need.
    defaultBaseUrl: "https://nano-gpt.com/api/v1",
    // Cheapest per character of the models that stream audio back directly, and
    // it takes instructions, so speaker and tone steering work.
    defaultModel: "gpt-4o-mini-tts",
    defaultVoice: "alloy",
    // Kokoro and ElevenLabs accept 10k, OpenAI models 4096. The lower bound is
    // the safe one: speakSchema caps every source at 4096 anyway.
    maxInputChars: 4096,
    recommendedChunkChars: 900,
    baseUrlMode: "fixed",
  },
  pockettts: {
    id: "pockettts",
    name: "PocketTTS",
    defaultBaseUrl: "http://localhost:8000",
    defaultModel: "pocket-tts",
    defaultVoice: "alba",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
    // Self-hosted: the port varies per install.
    baseUrlMode: "editable",
  },
  xai: {
    id: "xai",
    name: "xAI Voice",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-tts",
    defaultVoice: "eve",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
    baseUrlMode: "fixed",
  },
};

/** Chunk ceiling for a source, never above what the server accepts. */
export function ttsSourceMaxInputChars(source: TTSSourceId): number {
  return TTS_SOURCE_DEFINITIONS[source].maxInputChars;
}
