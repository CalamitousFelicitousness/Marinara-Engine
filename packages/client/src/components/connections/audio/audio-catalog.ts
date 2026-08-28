// ──────────────────────────────────────────────
// Audio catalog helpers
// ──────────────────────────────────────────────
// Per-source facts the editor needs that the shared source table does not carry
// because nothing on the server reads them.

import {
  NANOGPT_TTS_MODEL_IDS,
  TTS_SOURCES_WITH_MODEL_LISTING,
  type AudioGenerationSource,
  type TTSSourceId,
} from "@marinara-engine/shared";

/**
 * Order the source tiles are offered in.
 * Most-used first rather than the shared table's order, which exists to keep
 * the schema stable.
 */
export const AUDIO_SOURCE_DISPLAY_ORDER: readonly AudioGenerationSource[] = [
  "elevenlabs",
  "openai",
  "nanogpt",
  "pockettts",
  "xai",
];

/** Shown before the live listing arrives, and whenever it cannot be reached. */
export const ELEVENLABS_TTS_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
  "eleven_flash_v2",
];

/**
 * Speed range a source actually honors.
 * Outside it the provider clamps or refuses, so the slider stops where the
 * engine does rather than offering settings that silently do nothing.
 */
const SPEED_RANGES: Record<TTSSourceId, { min: number; max: number }> = {
  openai: { min: 0.25, max: 4.0 },
  elevenlabs: { min: 0.7, max: 1.2 },
  nanogpt: { min: 0.5, max: 2.0 },
  pockettts: { min: 0.25, max: 4.0 },
  xai: { min: 0.7, max: 1.5 },
};

export function audioSpeedRange(source: TTSSourceId) {
  return SPEED_RANGES[source];
}

/** Model ids to offer before the provider answers. Empty where the model is free text. */
export function fallbackModelIds(source: TTSSourceId): string[] {
  if (!TTS_SOURCES_WITH_MODEL_LISTING.includes(source)) return [];
  return source === "nanogpt" ? [...NANOGPT_TTS_MODEL_IDS] : ELEVENLABS_TTS_MODELS;
}

/** Sources whose provider forces one container regardless of the configured format. */
export function honorsAudioFormat(source: TTSSourceId): boolean {
  return source !== "elevenlabs" && source !== "xai";
}
