// ──────────────────────────────────────────────
// NanoGPT TTS Catalog
// ──────────────────────────────────────────────
// NanoGPT fronts several speech backends behind one OpenAI-shaped endpoint, and
// the voice vocabulary is per backend, not per account: Kokoro wants af_bella,
// the OpenAI models want alloy, ElevenLabs wants a name. A single voice list
// would be wrong for two thirds of the models, so voices resolve from the
// selected model.
//
// The model list is fetched from /audio-models when a key is present; these are
// the fallback for an unkeyed card and for a listing that fails.
//
// Docs: https://docs.nano-gpt.com/api-reference/text-to-speech

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
  capabilities?: { text_to_speech?: unknown } | null;
}

/**
 * Reads GET /v1/audio-models. `type=tts` already filters server-side, but the
 * capability flag is re-checked because an unfiltered response would otherwise
 * offer transcription models as voices.
 */
export function parseNanoGptModelOptions(payload: unknown): Array<{ id: string; name: string }> {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];

  const options: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const row of rows as NanoGptAudioModelRow[]) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    if (row.capabilities && row.capabilities.text_to_speech === false) continue;
    seen.add(id);
    options.push({ id, name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id });
  }
  return options;
}
