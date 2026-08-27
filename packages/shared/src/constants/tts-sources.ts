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

export const TTS_SOURCE_IDS = ["openai", "elevenlabs", "pockettts", "xai"] as const;
export type TTSSourceId = (typeof TTS_SOURCE_IDS)[number];

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
  },
  elevenlabs: {
    id: "elevenlabs",
    name: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io",
    defaultModel: "eleven_multilingual_v2",
    defaultVoice: "",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
  },
  pockettts: {
    id: "pockettts",
    name: "PocketTTS",
    defaultBaseUrl: "http://localhost:8000",
    defaultModel: "pocket-tts",
    defaultVoice: "alba",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
  },
  xai: {
    id: "xai",
    name: "xAI Voice",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-tts",
    defaultVoice: "eve",
    maxInputChars: 4096,
    recommendedChunkChars: 900,
  },
};

/** Chunk ceiling for a source, never above what the server accepts. */
export function ttsSourceMaxInputChars(source: TTSSourceId): number {
  return TTS_SOURCE_DEFINITIONS[source].maxInputChars;
}
