// ──────────────────────────────────────────────
// Migration: every configured TTS source becomes an audio connection
// ──────────────────────────────────────────────
// The first pass (#5146) lifted the ACTIVE source out of the TTS settings blob.
// That blob also carries a saved profile per source, which is where anyone who
// had set up two or three engines kept the other ones, reachable only by
// switching a dropdown in the settings card. Migrating just the active source
// would strand them there.
//
// This pass gives each configured profile its own named connection, seeded with
// the knobs that profile held, so the engines a user already had become the
// presets they can pick between. The blob is not deleted: it still holds
// app-level playback policy and still answers on installs with no connections.
//
// Runs after the first pass so the connection that one creates is seeded here
// in the same boot. Its marker key is its own, never inside the blob, which
// PUT /api/tts/config rebuilds through a strip-unknown schema on every save.

import {
  audioSettingsFromProfile,
  ttsConfigSchema,
  ttsSourceProfileFromConfig,
  TTS_SETTINGS_KEY,
  TTS_SOURCE_DEFINITIONS,
  TTS_SOURCE_IDS,
  type TTSSourceId,
  type TTSSourceProfile,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { decryptApiKey } from "../../utils/crypto.js";
import { logger } from "../../lib/logger.js";

const MIGRATION_MARKER_KEY = "ttsAudioConnectionsMigratedV2";

export async function migrateTtsSourceProfilesToAudioConnections(db: DB) {
  const settings = createAppSettingsStorage(db);
  const connections = createConnectionsStorage(db);

  if ((await settings.get(MIGRATION_MARKER_KEY)) === "true") return;

  const raw = await settings.get(TTS_SETTINGS_KEY);
  if (!raw) {
    // Fresh install: connections are the only way settings arrive from here on.
    await settings.set(MIGRATION_MARKER_KEY, "true");
    return;
  }

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  const parsed = ttsConfigSchema.safeParse(stored);
  if (!parsed.success) {
    // No marker: a blob that becomes readable again still migrates later.
    logger.warn("[migration] TTS settings are unreadable; deferring audio-connection presets");
    return;
  }
  const cfg = parsed.data;

  // A stored entry is what the user last had on that source. The active source
  // is described by the live top-level fields instead, which is where the card
  // writes before any switch has happened.
  const profiles = new Map<TTSSourceId, TTSSourceProfile>();
  for (const source of TTS_SOURCE_IDS) {
    const profile = cfg.sourceProfiles[source];
    if (profile) profiles.set(source, profile);
  }
  profiles.set(cfg.source, ttsSourceProfileFromConfig(cfg));

  const keys = new Map<TTSSourceId, string>();
  for (const [source, profile] of profiles) {
    const key = decryptApiKey(profile.apiKey ?? "");
    if (profile.apiKey && !key) {
      // A rotated or missing encryption key is transient. Skip WITHOUT the
      // marker so a later boot with working crypto migrates the whole set at
      // once, and skip entirely so it is never migrated half way.
      logger.warn("[migration] A stored TTS key could not be decrypted; deferring audio-connection presets");
      return;
    }
    keys.set(source, key);
  }

  const audioRows = (await connections.list()).filter((row) => row.provider === "audio");
  let hasDefault = audioRows.some((row) => row.defaultForAgents === "true");

  // Active source first, so it claims the default slot ahead of the others.
  const ordered: TTSSourceId[] = [cfg.source, ...TTS_SOURCE_IDS.filter((source) => source !== cfg.source)];
  let created = 0;
  let seeded = 0;

  for (const source of ordered) {
    const profile = profiles.get(source);
    if (!profile) continue;

    const key = keys.get(source) ?? "";
    const definition = TTS_SOURCE_DEFINITIONS[source];
    const isActive = source === cfg.source;
    const hasCustomEndpoint = Boolean(profile.baseUrl) && profile.baseUrl !== definition.defaultBaseUrl;
    // Evidence the user set this source up rather than passed through it. A
    // local engine needs neither a key nor a custom address, so having a profile
    // at all is its evidence; for the rest, an untouched profile is schema
    // defaults nobody chose.
    const configured = Boolean(key) || hasCustomEndpoint || source === "pockettts" || (isActive && cfg.enabled);
    if (!configured) continue;

    const audioSettings = audioSettingsFromProfile(profile);
    const match =
      audioRows.find((row) => (row.audioSource ?? "elevenlabs") === source && row.defaultForAgents === "true") ??
      audioRows.find((row) => (row.audioSource ?? "elevenlabs") === source);

    if (match) {
      // Seed only what was never set. Overwriting would discard tuning the user
      // has since edited on the connection itself, and this runs every boot
      // until the marker sticks.
      if (match.audioSettings == null) {
        await connections.update(String(match.id), {
          audioSettings,
        } as Parameters<typeof connections.update>[1]);
        seeded += 1;
      }
      continue;
    }

    // Only the source that was actually speaking becomes the default, and only
    // when nothing already claims it. Presets for the others stay inert until
    // the user picks one, so a disabled install gains no voice it did not have.
    const becomesDefault = isActive && cfg.enabled && !hasDefault;
    await connections.create({
      name: isActive ? definition.name : `${definition.name} (migrated)`,
      provider: "audio",
      baseUrl: profile.baseUrl ?? "",
      apiKey: key,
      model: profile.model ?? "",
      audioSource: source,
      audioVoice: profile.voice || null,
      audioSoundEffects: profile.elevenLabsGameSoundEffects === true,
      audioMusic: profile.elevenLabsGameMusic === true,
      defaultForAgents: becomesDefault,
      audioSettings,
    } as Parameters<typeof connections.create>[0]);
    if (becomesDefault) hasDefault = true;
    created += 1;
  }

  await settings.set(MIGRATION_MARKER_KEY, "true");
  if (created || seeded) {
    logger.info("[migration] Audio connections: created %d, seeded settings on %d", created, seeded);
  }
}
