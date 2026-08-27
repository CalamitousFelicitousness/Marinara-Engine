// ──────────────────────────────────────────────
// TTS Endpoint and Header Helpers
// ──────────────────────────────────────────────
// Shared by the providers and by the voice/model listing code that still lives
// in tts.routes.ts.

import { TTS_SOURCE_DEFINITIONS, type TTSConfig } from "@marinara-engine/shared";

export function configuredBaseUrl(cfg: TTSConfig): string {
  const fallbackBase = TTS_SOURCE_DEFINITIONS[cfg.source].defaultBaseUrl;
  return (cfg.baseUrl || fallbackBase).replace(/\/+$/, "");
}

export function elevenLabsApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v\d+$/, "");
}

/**
 * NanoGPT is a base URL, not a source: it hosts several backends behind one
 * OpenAI-shaped speech API. Detection therefore wins over cfg.source in the
 * registry, which is the behaviour that already shipped.
 */
export function isNanoGptBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "nano-gpt.com" || hostname.endsWith(".nano-gpt.com");
  } catch {
    return baseUrl.toLowerCase().includes("nano-gpt.com");
  }
}

export function nanoGptApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v\d+$/, "");
}

export function nanoGptV1BaseUrl(baseUrl: string): string {
  const root = nanoGptApiRoot(baseUrl);
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

export function pocketTtsV1BaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

export function elevenLabsHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["xi-api-key"] = apiKey;
  return headers;
}

export function openAiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export function nanoGptHeaders(apiKey: string): Record<string, string> {
  const headers = openAiHeaders(apiKey);
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

export function optionalBearerHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

/** Speech steering is a per-model capability, which is why it is not in the source table. */
export function openAiModelSupportsSpeechInstructions(model: string): boolean {
  return /^gpt-4o/i.test(model.trim());
}

function articleForWord(value: string): string {
  return /^[aeiou]/i.test(value.trim()) ? "an" : "a";
}

export function buildSpeechInstructions(input: {
  speaker?: string;
  tone?: string;
  includeSpeaker?: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (input.includeSpeaker !== false && input.speaker?.trim()) {
    parts.push(`Voice the line as ${input.speaker.trim()}.`);
  }
  const tone = input.tone?.trim();
  if (tone) {
    parts.push(`Use ${articleForWord(tone)} ${tone} tone.`);
  }
  if (parts.length === 0) return undefined;
  parts.push("Do not read speaker names, brackets, markup, or stage directions aloud.");
  return parts.join(" ");
}

/** ElevenLabs steers emotion from a bracketed cue at the head of the text. */
export function buildElevenLabsTextInput(text: string, tone?: string): string {
  const normalizedTone = tone?.replace(/[[\]\r\n]/g, "").trim();
  if (!normalizedTone || text.trimStart().startsWith(`[${normalizedTone}]`)) return text;
  return `[${normalizedTone}] ${text}`;
}

export function buildOfficialPocketTtsForm(text: string, voice: string): FormData {
  const form = new FormData();
  form.append("text", text);
  if (voice) form.append("voice_url", voice);
  return form;
}

export const ELEVENLABS_NON_TTS_MODELS = new Set(["eleven_ttv_v3", "eleven_multilingual_ttv_v2"]);

const ELEVENLABS_TTS_MODEL_ALIASES: Record<string, string> = {
  tts_v3: "eleven_v3",
  elevenlabs_v3: "eleven_v3",
  elevenlabs_tts_v3: "eleven_v3",
};

const NANOGPT_TTS_MODEL_ALIASES: Record<string, string> = {
  eleven_v3: "Elevenlabs-V3",
  "elevenlabs-v3": "Elevenlabs-V3",
  elevenlabs_v3: "Elevenlabs-V3",
  elevenlabs_tts_v3: "Elevenlabs-V3",
  eleven_turbo_v2_5: "Elevenlabs-Turbo-V2.5",
  eleven_flash_v2_5: "Elevenlabs-Turbo-V2.5",
};

export function normalizeElevenLabsTtsModelId(model: string): string {
  const trimmed = model.trim();
  return ELEVENLABS_TTS_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeNanoGptTtsModelId(model: string): string {
  const trimmed = model.trim();
  return NANOGPT_TTS_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function isNanoGptElevenLabsModel(model: string): boolean {
  return /^elevenlabs[-_]/i.test(model.trim());
}

export function elevenLabsModelSupportsSpeed(model: string): boolean {
  return model.trim().toLowerCase() !== "eleven_v3";
}

export function clampElevenLabsSpeed(speed: number): number {
  return Math.min(1.2, Math.max(0.7, Number.isFinite(speed) ? speed : 1));
}

export function clampXaiSpeed(speed: number): number {
  return Math.min(1.5, Math.max(0.7, Number.isFinite(speed) ? speed : 1));
}
