// An audio connection decides which engine speaks and how it sounds. The
// app-level TTS settings decide whether speech happens at all.
//
// Three things here are easy to get wrong and silent when wrong:
//
//   The gate. Speech used to require the settings blob's master toggle even
//   when a perfectly good default audio connection existed, so anyone who
//   configured a connection and never opened the old card got a 400. Turning
//   the toggle into "unless the user explicitly said no" has to keep honoring
//   an explicit no, or an upgrade re-enables speech somebody switched off.
//
//   The overlay. A connection's stored knobs win over the app-level values,
//   but only where it actually stores one. A field it never set has to keep
//   following the app-level setting rather than snapping to a schema default.
//
//   Identity fallback across sources. Blank row fields fall back to the profile
//   for the ROW's source, never to the blob's top-level fields, which belong to
//   whichever source the blob itself last had.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTS_SETTINGS_KEY, ttsConfigSchema } from "../../../packages/shared/src/types/tts.js";
import { TTS_SOURCE_DEFINITIONS } from "../../../packages/shared/src/constants/tts-sources.js";

const storageRoot = await mkdtemp(join(tmpdir(), "marinara-audio-connection-resolution-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;

try {
  process.env.DATA_DIR = storageRoot;
  process.env.FILE_STORAGE_DIR = join(storageRoot, "storage");

  const [dbModule, appSettingsModule, connectionsModule, resolution] = await Promise.all([
    import("../../../packages/server/src/db/connection.js"),
    import("../../../packages/server/src/services/storage/app-settings.storage.js"),
    import("../../../packages/server/src/services/storage/connections.storage.js"),
    import("../../../packages/server/src/services/tts/audio-config-resolution.js"),
  ]);

  const db = await dbModule.getDB();
  const storage = appSettingsModule.createAppSettingsStorage(db);
  const connections = connectionsModule.createConnectionsStorage(db);
  const resolve = (connectionId?: string | null) => resolution.resolveAudioConfig(storage, connections, connectionId);
  const writeSettings = (config: Record<string, unknown>) =>
    storage.set(TTS_SETTINGS_KEY, JSON.stringify(ttsConfigSchema.parse(config)));

  // ── Nothing configured anywhere ──
  {
    const result = await resolve();
    assert.equal(result.origin, "legacy", "with no connection the app-level settings answer alone");
    assert.equal(result.resolvedConnectionId, null, "nothing resolved");
    assert.equal(result.speechEnabled, false, "an install with nothing configured stays silent");
  }

  // ── A connection with no settings ever saved ──
  // The install that could not speak before: a working connection, and a master
  // toggle the user never saw because the card that owned it is gone.
  const elevenLabs = await connections.create({
    name: "ElevenLabs",
    provider: "audio",
    apiKey: "eleven-key",
    baseUrl: "",
    model: "",
    audioSource: "elevenlabs",
    audioVoice: "row-voice",
    defaultForAgents: true,
  } as never);
  {
    const result = await resolve();
    assert.equal(result.origin, "default", "the category default resolves without being asked for");
    assert.equal(result.resolvedConnectionId, elevenLabs.id, "and reports which connection answered");
    assert.equal(result.resolvedConnectionName, "ElevenLabs", "by name, for the playback summary");
    assert.equal(result.speechEnabled, true, "configuring a connection is the intent to speak");
    assert.equal(result.cfg.enabled, true, "cfg.enabled mirrors the gate");
    // Callers that never name a purpose are asking about speech, and speech has
    // no generation capability to report.
    assert.equal(result.purpose, "speech", "an unnamed purpose is speech");
    assert.equal(result.gameAudioEnabled, null, "speech reports no game audio capability");
    assert.equal(result.resolvedSource, "elevenlabs", "the row picks the source");
    assert.equal(result.cfg.apiKey, "eleven-key", "the row supplies the key");
    assert.equal(result.cfg.voice, "row-voice", "the row supplies the voice");
    assert.equal(
      result.cfg.baseUrl,
      TTS_SOURCE_DEFINITIONS.elevenlabs.defaultBaseUrl,
      "a blank row URL falls back to the source default",
    );
    assert.equal(
      result.cfg.model,
      TTS_SOURCE_DEFINITIONS.elevenlabs.defaultModel,
      "a blank row model falls back to the source default",
    );
  }

  // ── An explicit no still means no ──
  await writeSettings({ enabled: false, source: "openai", voice: "alloy" });
  {
    const result = await resolve();
    assert.equal(result.origin, "default", "the connection still resolves");
    assert.equal(result.speechEnabled, false, "a stored master toggle set to off is honored");
    assert.equal(result.cfg.enabled, false, "cfg.enabled mirrors the gate");
  }

  // An explicit request is a direct expression of intent and overrides the
  // toggle. Game audio depends on this: a game pinned to a connection must not
  // fall silent because the app-level switch is off.
  {
    const result = await resolve(elevenLabs.id);
    assert.equal(result.origin, "explicit", "asking for a connection by id is explicit");
    assert.equal(result.speechEnabled, true, "an explicitly requested connection speaks");
  }

  // ── The sentinel still reaches the app-level settings ──
  {
    const result = await resolve(resolution.LEGACY_TTS_CONFIG_SENTINEL);
    assert.equal(result.origin, "legacy", "the empty-string sentinel bypasses connection resolution");
    assert.equal(result.resolvedConnectionId, null, "no connection answered");
    assert.equal(result.cfg.source, "openai", "the app-level source is used unchanged");
  }

  // An unknown or non-audio id warns and falls through rather than failing.
  {
    const result = await resolve("does-not-exist");
    assert.equal(result.origin, "default", "an unusable id falls through to the default");
    assert.equal(result.resolvedConnectionId, elevenLabs.id, "and still resolves something usable");
  }

  // ── Identity never leaks across sources ──
  // The blob's own voice belongs to its own source. Inheriting "alloy" onto an
  // ElevenLabs row would defeat the missing-voice guard downstream, which is
  // the only thing standing between the user and an opaque provider error.
  await connections.update(elevenLabs.id, { audioVoice: "" } as never);
  {
    const result = await resolve();
    assert.equal(result.cfg.voice, "", "a blank row voice does not inherit another source's voice");
  }
  await connections.update(elevenLabs.id, { audioVoice: "row-voice" } as never);

  // ── The connection's knobs win, field by field ──
  await writeSettings({ enabled: true, source: "openai", speed: 1.0, timeoutMs: 60_000, chunkCharLimit: 900 });
  {
    const before = await resolve();
    assert.equal(before.cfg.speed, 1.0, "with no stored knobs the app-level values apply");
    assert.equal(before.cfg.chunkCharLimit, 900, "with no stored knobs the app-level values apply");

    await connections.update(elevenLabs.id, {
      audioSettings: { speed: 1.75, timeoutMs: 300_000, narratorVoice: "narrator-row" },
    } as never);
    const after = await resolve();
    assert.equal(after.cfg.speed, 1.75, "a stored knob overrides the app-level value");
    assert.equal(after.cfg.timeoutMs, 300_000, "a stored knob overrides the app-level value");
    assert.equal(after.cfg.narratorVoice, "narrator-row", "voice casting travels with the connection");
    assert.equal(after.cfg.chunkCharLimit, 900, "a knob the connection never set keeps following the app level");

    // Playback policy is app level and a connection cannot capture it.
    assert.equal(after.cfg.progressivePlayback, true, "playback policy stays app level");
    assert.equal(after.cfg.autoplayRP, false, "autoplay stays app level");
  }

  // ── Two engines, each with its own settings ──
  const pocket = await connections.create({
    name: "Local PocketTTS",
    provider: "audio",
    apiKey: "",
    baseUrl: "http://127.0.0.1:8123",
    model: "",
    audioSource: "pockettts",
    audioVoice: "alba",
    audioSettings: { speed: 0.75, generationConcurrency: 1, chunkCharLimit: 300 },
  } as never);
  {
    const viaPocket = await resolve(pocket.id);
    assert.equal(viaPocket.resolvedSource, "pockettts", "the second engine resolves on its own terms");
    assert.equal(viaPocket.cfg.baseUrl, "http://127.0.0.1:8123", "a row URL wins over the source default");
    assert.equal(viaPocket.cfg.speed, 0.75, "each engine keeps its own tuning");
    assert.equal(viaPocket.cfg.chunkCharLimit, 300, "each engine keeps its own tuning");

    const viaEleven = await resolve(elevenLabs.id);
    assert.equal(viaEleven.cfg.speed, 1.75, "switching engines switches the whole settings set");
    assert.equal(viaEleven.cfg.chunkCharLimit, 900, "and unset knobs still follow the app level");
  }

  // ── The fallback connection is reached when no default exists ──
  await connections.update(elevenLabs.id, { defaultForAgents: false } as never);
  await connections.update(pocket.id, { fallbackForAgents: true } as never);
  {
    const result = await resolve();
    assert.equal(result.origin, "fallback", "with no default the fallback answers");
    assert.equal(result.resolvedConnectionId, pocket.id, "and it is the connection marked as fallback");
  }

  // ── The model catalog answers per source, or refuses ──
  // The generic connections handler cannot do this: PROVIDERS.audio has no
  // models endpoint, so it requested the bare base URL with an ElevenLabs
  // header no matter which engine the row pointed at.
  {
    const catalog = await import("../../../packages/server/src/services/tts/audio-connection-catalog.js");
    assert.deepEqual(
      await catalog.fetchModelsForAudioConnection(db, pocket.id),
      { models: [], fromProvider: false, source: "pockettts" },
      "a free-text-model source reports an empty catalog rather than a wrong one",
    );
    assert.equal(
      await catalog.fetchModelsForAudioConnection(db, "does-not-exist"),
      null,
      "an id naming no audio connection lists nothing, never the default connection's models",
    );
  }

  console.info("TTS audio connection resolution regression passed.");
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  await rm(storageRoot, { recursive: true, force: true });
}
