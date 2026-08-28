// ──────────────────────────────────────────────
// Audio Connection Settings
// ──────────────────────────────────────────────
// Synthesis settings owned by one audio connection: how an engine speaks, as
// opposed to which engine it is.
//
// Identity (baseUrl, apiKey, voice, model) and the two game-audio capability
// flags have their own api_connections columns, so they are omitted here.
// Every other TTS source-profile field is a knob and belongs to the connection.
//
// Derived from ttsSourceProfileSchema rather than hand-listed: the bounds then
// cannot drift from the app-level schema, and a knob added there is per
// connection immediately.
//
// Every field is optional with no default. Absent means "inherit the app-level
// TTS settings value", so a connection with no stored settings resolves exactly
// as it did before this schema existed. A field that grows a default would make
// that inheritance unreachable.

import { z } from "zod";
import { ttsSourceProfileSchema, type TTSConfig, type TTSSourceProfile } from "./tts.js";

/** Profile fields naming which engine to call, not how it speaks. Kept in dedicated columns. */
export const AUDIO_CONNECTION_IDENTITY_FIELDS = [
  "baseUrl",
  "apiKey",
  "voice",
  "model",
  "elevenLabsGameSoundEffects",
  "elevenLabsGameMusic",
] as const;

export const audioConnectionSettingsSchema = ttsSourceProfileSchema
  .omit({
    baseUrl: true,
    apiKey: true,
    voice: true,
    model: true,
    elevenLabsGameSoundEffects: true,
    elevenLabsGameMusic: true,
  })
  .partial();

export type AudioConnectionSettings = z.infer<typeof audioConnectionSettingsSchema>;

/**
 * Reads the stored column: JSON text, an already-parsed object, or null.
 * Unreadable input inherits everything rather than failing, and a single
 * out-of-range field is dropped on its own instead of discarding the rest.
 */
export function parseAudioConnectionSettings(raw: unknown): AudioConnectionSettings {
  if (raw === null || raw === undefined) return {};

  let candidate: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {};

  const whole = audioConnectionSettingsSchema.safeParse(candidate);
  if (whole.success) return whole.data;

  const salvaged: Record<string, unknown> = {};
  const source = candidate as Record<string, unknown>;
  for (const [field, validator] of Object.entries(audioConnectionSettingsSchema.shape)) {
    if (source[field] === undefined) continue;
    const parsed = (validator as z.ZodTypeAny).safeParse(source[field]);
    if (parsed.success && parsed.data !== undefined) salvaged[field] = parsed.data;
  }
  return salvaged as AudioConnectionSettings;
}

/**
 * Overlays a connection's settings onto an app-level config.
 * Iterates the stored keys instead of naming them, so the field list has exactly
 * one definition: a knob that reaches the schema reaches the merge.
 */
export function applyAudioConnectionSettings(config: TTSConfig, settings: AudioConnectionSettings): TTSConfig {
  const merged: Record<string, unknown> = { ...config };
  for (const [field, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    merged[field] = value;
  }
  return merged as TTSConfig;
}

/** Full knob snapshot of a source profile, for seeding a connection from app-level settings. */
export function audioSettingsFromProfile(profile: TTSSourceProfile): AudioConnectionSettings {
  return audioConnectionSettingsSchema.parse(profile);
}
