// ──────────────────────────────────────────────
// Audio Config Resolution
// ──────────────────────────────────────────────
// One place decides which engine answers for a purpose, and with which settings.
//
// Each purpose resolves down its own chain: an explicitly requested connection,
// then the purpose's own default and fallback, then the base audio default and
// fallback, then the app-level settings. Speech has no pair of its own, so it
// starts at the base pair, and a game purpose with no pair set lands there too.
// That is what keeps an install nobody has re-pointed routing every lane to one
// engine.
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
  isGameAudioPurpose,
  parseAudioConnectionSettings,
  ttsConfigSchema,
  ttsSourceProfileFromConfig,
  ttsSourceSupportsGameAudio,
  TTS_SETTINGS_KEY,
  TTS_SOURCE_DEFINITIONS,
  type AudioPurpose,
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
  /**
   * Whether speech may be synthesized. The single gate for /speak; cfg.enabled
   * mirrors it. Game audio has never consulted it and must not start: silencing
   * narration is not a reason to stop scoring a scene.
   */
  speechEnabled: boolean;
  /** Lane this resolution answered for. */
  purpose: AudioPurpose;
  /** See TTSEffectiveConfigResponse.gameAudioEnabled. null for speech. */
  gameAudioEnabled: boolean | null;
}

/**
 * Whether the resolved engine may generate for a game purpose. Two terms, and
 * both are needed: the source has to be able to do it at all, and this
 * connection has to have opted in. A missing API key is deliberately absent,
 * because that is a configuration error with its own message rather than a
 * statement about what the engine can do.
 */
function gameAudioEnabledFor(cfg: TTSConfig, purpose: AudioPurpose): boolean | null {
  if (!isGameAudioPurpose(purpose)) return null;
  if (!ttsSourceSupportsGameAudio(cfg.source, purpose)) return false;
  return purpose === "sfx" ? cfg.elevenLabsGameSoundEffects === true : cfg.elevenLabsGameMusic === true;
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
  purpose: AudioPurpose = "speech",
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
    purpose,
    gameAudioEnabled: gameAudioEnabledFor(cfg, purpose),
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
  // A purpose pair answers before the base pair, so pointing music at a second
  // engine does not disturb what speaks.
  if (!row && isGameAudioPurpose(purpose)) {
    row = await connections.getDefaultForAudioPurpose(purpose);
    if (row) origin = "purpose_default";
    if (!row) {
      row = await connections.getFallbackForAudioPurpose(purpose);
      if (row) origin = "purpose_fallback";
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

  const merged = applyAudioConnectionSettings(withIdentity, parseAudioConnectionSettings(row.audioSettings));

  return {
    cfg: merged,
    resolvedConnectionId: String(row.id),
    resolvedConnectionName: row.name ? String(row.name) : null,
    resolvedSource: source,
    origin,
    speechEnabled,
    purpose,
    gameAudioEnabled: gameAudioEnabledFor(merged, purpose),
  };
}
