// ──────────────────────────────────────────────
// Migration: legacy TTS settings blob → first-class audio connection (#5146)
// ──────────────────────────────────────────────
// Runs unconditionally on every boot (app.ts chain) and is idempotent: it does
// nothing once any audio connection exists or once the completion marker is
// set on the blob. The blob itself is NEVER deleted — it remains the knob
// store (speed, stability, extractor settings) and the resolution fallback
// for anything that predates connections, so an upgrade changes no behavior:
// the synthesized connection reproduces exactly what the blob configured.
import { ttsConfigSchema, TTS_SETTINGS_KEY } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { decryptApiKey } from "../../utils/crypto.js";
import { logger } from "../../lib/logger.js";

const MIGRATION_MARKER = "audioConnectionMigrated";

export async function migrateTtsSettingsToAudioConnection(db: DB) {
  const settings = createAppSettingsStorage(db);
  const connections = createConnectionsStorage(db);

  const raw = await settings.get(TTS_SETTINGS_KEY);
  if (!raw) return; // fresh install: nothing to migrate
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn("[migration] TTS settings blob is unreadable; skipping audio-connection migration");
    return;
  }
  if (stored[MIGRATION_MARKER] === true) return;

  const existingAudio = (await connections.list()).some((connection) => connection.provider === "audio");
  if (existingAudio) {
    await settings.set(TTS_SETTINGS_KEY, JSON.stringify({ ...stored, [MIGRATION_MARKER]: true }));
    return;
  }

  const parsed = ttsConfigSchema.safeParse(stored);
  if (!parsed.success) {
    logger.warn("[migration] TTS settings blob failed validation; skipping audio-connection migration");
    return;
  }
  const cfg = parsed.data;
  const apiKey = decryptApiKey(cfg.apiKey ?? "");
  // Only a configuration that could actually speak becomes a connection: a
  // remote source needs its key; the local source needs only to be selected.
  const configured = cfg.source === "pockettts" ? Boolean(cfg.enabled) : Boolean(apiKey);
  if (!configured) {
    await settings.set(TTS_SETTINGS_KEY, JSON.stringify({ ...stored, [MIGRATION_MARKER]: true }));
    return;
  }

  const sourceNames: Record<string, string> = {
    openai: "OpenAI Audio",
    elevenlabs: "ElevenLabs",
    pockettts: "PocketTTS (local)",
    xai: "xAI Audio",
  };
  await connections.create({
    name: sourceNames[cfg.source] ?? "Audio",
    provider: "audio",
    baseUrl: cfg.baseUrl ?? "",
    apiKey,
    model: cfg.model ?? "",
    audioSource: cfg.source,
    audioVoice: cfg.voice || null,
    audioSoundEffects: cfg.elevenLabsGameSoundEffects === true,
    audioMusic: cfg.elevenLabsGameMusic === true,
    // The migrated connection becomes the category default so resolution
    // keeps producing exactly the pre-upgrade behavior.
    defaultForAgents: true,
  } as Parameters<typeof connections.create>[0]);
  await settings.set(TTS_SETTINGS_KEY, JSON.stringify({ ...stored, [MIGRATION_MARKER]: true }));
  logger.info("[migration] Created an audio connection from the legacy TTS settings (%s)", cfg.source);
}
