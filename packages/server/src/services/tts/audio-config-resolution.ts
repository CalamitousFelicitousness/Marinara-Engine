// ──────────────────────────────────────────────
// Audio Config Resolution
// ──────────────────────────────────────────────
// One place decides which engine speaks and with which settings.
//
// An audio connection supplies identity: source, key, base URL, voice, model,
// and the two game-audio capability flags. Its audioSettings then supply the
// knobs it owns, field by field, over the app-level TTS settings blob. What the
// blob keeps is app-level playback policy: the master toggle, autoplay,
// progressive playback, dialogue handling, and the speaker extractor.
//
// With no audio connection at all the blob answers alone, so an install that
// predates connections keeps working untouched.

import {
  applyAudioConnectionSettings,
  parseAudioConnectionSettings,
  ttsConfigSchema,
  ttsSourceProfileFromConfig,
  TTS_SETTINGS_KEY,
  TTS_SOURCE_DEFINITIONS,
  type TTSConfig,
  type TTSResolutionOrigin,
  type TTSSource,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { decryptApiKey } from "../../utils/crypto.js";
import type { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import type { createConnectionsStorage } from "../storage/connections.storage.js";

/** Callers pass this sentinel to force the app-level settings blob even when audio connections exist. */
export const LEGACY_TTS_CONFIG_SENTINEL = "";

export interface AudioConfigResolution {
  /** Merged config carrying a plain-text key. Mask before returning it to a client. */
  cfg: TTSConfig;
  resolvedConnectionId: string | null;
  resolvedConnectionName: string | null;
  resolvedSource: TTSSource;
  origin: TTSResolutionOrigin;
  /** Whether speech may be synthesized. The single gate; cfg.enabled mirrors it. */
  speechEnabled: boolean;
}

export function parseStoredConfig(raw: string | null) {
  if (!raw) return ttsConfigSchema.parse({});
  try {
    return ttsConfigSchema.parse(JSON.parse(raw));
  } catch {
    return ttsConfigSchema.parse({});
  }
}

export function withActiveSourceProfile(config: TTSConfig): TTSConfig {
  return {
    ...config,
    sourceProfiles: {
      ...config.sourceProfiles,
      [config.source]: ttsSourceProfileFromConfig(config),
    },
  };
}

/**
 * Resolve the stored config and decrypt the API key.
 * Returns config with the plain-text key (never sent to client).
 */
export async function loadConfig(storage: ReturnType<typeof createAppSettingsStorage>) {
  const raw = await storage.get(TTS_SETTINGS_KEY);
  const cfg = parseStoredConfig(raw);
  cfg.apiKey = decryptApiKey(cfg.apiKey);
  return cfg;
}

export async function resolveAudioConfig(
  storage: ReturnType<typeof createAppSettingsStorage>,
  connections: ReturnType<typeof createConnectionsStorage>,
  requestedConnectionId?: string | null,
): Promise<AudioConfigResolution> {
  const raw = await storage.get(TTS_SETTINGS_KEY);
  // Distinguishes "never configured" from "configured and switched off", which
  // is what lets a connection-first install speak while still honoring an
  // explicit no. Unparseable text counts as configured: re-enabling speech
  // somebody turned off is the worse way to be wrong.
  const hasStoredSettings = Boolean(raw);
  const cfg = parseStoredConfig(raw);
  cfg.apiKey = decryptApiKey(cfg.apiKey);

  const appLevelOnly = (): AudioConfigResolution => ({
    cfg,
    resolvedConnectionId: null,
    resolvedConnectionName: null,
    resolvedSource: cfg.source,
    origin: "legacy",
    speechEnabled: cfg.enabled,
  });

  // The settings card tests the blob it edits, so the sentinel must reach it
  // even when a default audio connection exists.
  if (requestedConnectionId === LEGACY_TTS_CONFIG_SENTINEL) return appLevelOnly();

  let row = null;
  let origin: TTSResolutionOrigin = "legacy";
  if (requestedConnectionId) {
    const candidate = await connections.getWithKey(requestedConnectionId);
    if (candidate?.provider === "audio") {
      row = candidate;
      origin = "explicit";
    } else {
      logger.warn("Requested audio connection %s missing or not audio; using the default", requestedConnectionId);
    }
  }
  if (!row) {
    row = await connections.getDefaultForAudio();
    if (row) origin = "default";
  }
  if (!row) {
    row = await connections.getFallbackForAudio();
    if (row) origin = "fallback";
  }
  if (!row) return appLevelOnly();

  const source = (row.audioSource ?? "elevenlabs") as TTSSource;
  // Blank row fields fall back per the ROW's source. The blob's top-level fields
  // belong to its own active source, and inheriting them across sources would
  // leak values such as the schema-default voice "alloy" into an ElevenLabs row,
  // defeating the missing-voice guard downstream.
  const profile = source === cfg.source ? cfg : withActiveSourceProfile(cfg).sourceProfiles[source];
  const definition = TTS_SOURCE_DEFINITIONS[source];

  // An explicit request is a direct expression of intent. Otherwise the master
  // toggle still rules, so an upgrade cannot re-enable speech a user switched
  // off. With no settings ever stored there is no such decision to honor, and
  // having configured a connection is the intent.
  const speechEnabled = origin === "explicit" || (hasStoredSettings ? cfg.enabled : true);

  const withIdentity: TTSConfig = {
    ...cfg,
    enabled: speechEnabled,
    source,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl || profile?.baseUrl || definition.defaultBaseUrl,
    voice: row.audioVoice || profile?.voice || "",
    model: row.model || profile?.model || definition.defaultModel,
    elevenLabsGameSoundEffects: row.audioSoundEffects === "true",
    elevenLabsGameMusic: row.audioMusic === "true",
  };

  return {
    cfg: applyAudioConnectionSettings(withIdentity, parseAudioConnectionSettings(row.audioSettings)),
    resolvedConnectionId: String(row.id),
    resolvedConnectionName: row.name ? String(row.name) : null,
    resolvedSource: source,
    origin,
    speechEnabled,
  };
}
