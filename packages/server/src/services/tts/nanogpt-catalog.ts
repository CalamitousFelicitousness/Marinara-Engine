// ──────────────────────────────────────────────
// NanoGPT TTS Catalog
// ──────────────────────────────────────────────
// NanoGPT fronts several speech backends behind one OpenAI-shaped endpoint, and
// the voice vocabulary is per backend, not per account: Kokoro wants af_bella,
// the OpenAI models want alloy, ElevenLabs wants a name, Gemini wants Zephyr.
//
// /audio-models publishes each model's own voices in supported_parameters.voices
// and answers without a key, so that listing is the source of truth. There is no
// /v1/voices endpoint; the one the OpenAI-shaped docs mention returns 404 here.
//
// The tables below are the offline fallback for a listing that cannot be
// reached. They are approximations: the published lists disagree with them on
// counts for every family, so they must never outrank a listing that answered.
//
// Docs: https://docs.nano-gpt.com/api-reference/text-to-speech

import type { AudioModelLane, AudioModelPricing } from "@marinara-engine/shared";
import { readAudioModelPricing } from "./audio-model-pricing.js";

export type NanoGptModelFamily = "openai" | "kokoro" | "elevenlabs" | "other";

export function nanoGptModelFamily(model: string): NanoGptModelFamily {
  const id = model.trim().toLowerCase();
  if (!id) return "other";
  if (id.startsWith("elevenlabs-") || id.startsWith("elevenlabs_")) return "elevenlabs";
  if (id.startsWith("kokoro")) return "kokoro";
  if (id === "tts-1" || id === "tts-1-hd" || id.startsWith("gpt-4o")) return "openai";
  return "other";
}

/** Voices the OpenAI-family models accept. Superset of the direct OpenAI list. */
export const NANOGPT_OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

/**
 * Kokoro voice ids encode language and gender in the prefix (af = American
 * female, bm = British male, jf = Japanese female, and so on), which is why the
 * category is worth carrying: the raw id is opaque in a dropdown.
 */
export const NANOGPT_KOKORO_VOICES: ReadonlyArray<{ id: string; category: string }> = [
  { id: "af_alloy", category: "American female" },
  { id: "af_aoede", category: "American female" },
  { id: "af_bella", category: "American female" },
  { id: "af_jessica", category: "American female" },
  { id: "af_nova", category: "American female" },
  { id: "am_adam", category: "American male" },
  { id: "am_echo", category: "American male" },
  { id: "am_eric", category: "American male" },
  { id: "am_liam", category: "American male" },
  { id: "am_onyx", category: "American male" },
  { id: "bf_alice", category: "British female" },
  { id: "bf_emma", category: "British female" },
  { id: "bf_isabella", category: "British female" },
  { id: "bf_lily", category: "British female" },
  { id: "bm_daniel", category: "British male" },
  { id: "bm_fable", category: "British male" },
  { id: "bm_george", category: "British male" },
  { id: "bm_lewis", category: "British male" },
  { id: "jf_alpha", category: "Japanese female" },
  { id: "jf_gongitsune", category: "Japanese female" },
  { id: "jf_nezumi", category: "Japanese female" },
  { id: "jf_tebukuro", category: "Japanese female" },
  { id: "zf_xiaobei", category: "Mandarin female" },
  { id: "zf_xiaoni", category: "Mandarin female" },
  { id: "zf_xiaoxiao", category: "Mandarin female" },
  { id: "zf_xiaoyi", category: "Mandarin female" },
  { id: "ff_siwis", category: "French female" },
  { id: "im_nicola", category: "Italian male" },
  { id: "hf_alpha", category: "Hindi female" },
  { id: "hf_beta", category: "Hindi female" },
];

/** Shown when /audio-models cannot be reached. Shared so the card can seed its dropdown too. */
export { NANOGPT_TTS_MODEL_IDS as NANOGPT_FALLBACK_TTS_MODELS } from "@marinara-engine/shared";

interface NanoGptAudioModelRow {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  capabilities?: { text_to_speech?: unknown } | null;
  supported_parameters?: { voices?: unknown } | null;
  pricing?: unknown;
}

export interface NanoGptTtsModel {
  id: string;
  name: string;
  /** Which catalog lane the row serves, from its category. */
  lane: AudioModelLane;
  /** Voices this model accepts, as published. Empty when the row omits them. */
  voices: string[];
  /** The published rate, absent when the row carries none this reader understands. */
  pricing?: AudioModelPricing;
}

/**
 * Which lane a row serves.
 *
 * A claim to speak is taken at its word. Absence of that claim is not a denial,
 * though: 37 of the 63 rows `type=tts` returns omit `text_to_speech` entirely,
 * so a flag check alone keeps every music and voice-clone row in the voice
 * picker. Category is what separates those. Sound effects and music share one
 * category and are told apart by model id.
 */
function nanoGptAudioLane(row: NanoGptAudioModelRow): AudioModelLane {
  if (row.capabilities?.text_to_speech === true) return "speech";
  if (row.category === "audio_tts") return "speech";
  if (row.category === "audio_music") return "music";
  return "other";
}

/**
 * Reads GET /v1/audio-models. `type=tts` returns every generator except
 * transcription, so the rows are classified rather than trusted as speech.
 */
export function parseNanoGptModelOptions(payload: unknown): NanoGptTtsModel[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];

  const options: NanoGptTtsModel[] = [];
  const seen = new Set<string>();
  for (const row of rows as NanoGptAudioModelRow[]) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    if (row.capabilities && row.capabilities.text_to_speech === false) continue;
    seen.add(id);
    const published = row.supported_parameters?.voices;
    const voices = Array.isArray(published)
      ? published
          .filter((voice): voice is string => typeof voice === "string" && voice.trim().length > 0)
          .map((v) => v.trim())
      : [];
    const pricing = readAudioModelPricing(row.pricing);
    options.push({
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
      lane: nanoGptAudioLane(row),
      voices: [...new Set(voices)],
      ...(pricing ? { pricing } : {}),
    });
  }
  return options;
}

/**
 * Voices the listing publishes for one model.
 * Empty means the listing answered but does not describe this model, which is
 * the case for a hand-typed id. Guessing a family's voices from the id is how
 * Gemini models ended up offering OpenAI's, so absence stays absence.
 */
export function nanoGptVoicesForModel(models: readonly NanoGptTtsModel[], model: string): string[] {
  const wanted = model.trim().toLowerCase();
  if (!wanted) return [];
  return models.find((entry) => entry.id.trim().toLowerCase() === wanted)?.voices ?? [];
}
