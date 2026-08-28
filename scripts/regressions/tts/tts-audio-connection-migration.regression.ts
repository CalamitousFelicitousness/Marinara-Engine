// Every engine a user had configured has to survive the move to connections.
//
// The TTS settings blob keeps one saved profile per source, so somebody running
// ElevenLabs in the cloud and a local engine on the side had both in there and
// switched with a dropdown. Lifting only the active source would have left the
// others reachable by nothing at all.
//
// The failure modes worth pinning are the quiet ones: creating presets out of
// schema defaults nobody chose, handing a voice to an install whose owner had
// switched speech off, and re-running over settings the user has since edited
// on the connection itself.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTS_SETTINGS_KEY, ttsConfigSchema } from "../../../packages/shared/src/types/tts.js";

const storageRoot = await mkdtemp(join(tmpdir(), "marinara-audio-connection-migration-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;

try {
  process.env.DATA_DIR = storageRoot;
  process.env.FILE_STORAGE_DIR = join(storageRoot, "storage");

  const [dbModule, appSettingsModule, connectionsModule, migrationModule, cryptoModule] = await Promise.all([
    import("../../../packages/server/src/db/connection.js"),
    import("../../../packages/server/src/services/storage/app-settings.storage.js"),
    import("../../../packages/server/src/services/storage/connections.storage.js"),
    import("../../../packages/server/src/services/connections/tts-audio-connection-migration-v2.js"),
    import("../../../packages/server/src/utils/crypto.js"),
  ]);

  const db = await dbModule.getDB();
  const settings = appSettingsModule.createAppSettingsStorage(db);
  const connections = connectionsModule.createConnectionsStorage(db);
  const migrate = () => migrationModule.migrateTtsSourceProfilesToAudioConnections(db);

  const MARKER = "ttsAudioConnectionsMigratedV2";
  const rerun = async () => {
    await settings.remove(MARKER);
    await migrate();
  };
  const audioRows = async () => (await connections.list()).filter((row) => row.provider === "audio");
  const writeSettings = (config: Record<string, unknown>) =>
    settings.set(TTS_SETTINGS_KEY, JSON.stringify(ttsConfigSchema.parse(config)));
  const clearAudio = async () => {
    for (const row of await audioRows()) await connections.remove(String(row.id));
  };

  // ── A fresh install has nothing to carry over ──
  {
    await migrate();
    assert.equal((await audioRows()).length, 0, "no settings means no presets invented");
    assert.equal(await settings.get(MARKER), "true", "and it does not keep looking every boot");
  }

  // ── Each configured source becomes its own preset ──
  await writeSettings({
    enabled: true,
    source: "elevenlabs",
    apiKey: cryptoModule.encryptApiKey("eleven-key"),
    baseUrl: "https://api.elevenlabs.io",
    voice: "eleven-voice",
    model: "eleven_multilingual_v2",
    speed: 1.3,
    timeoutMs: 120_000,
    sourceProfiles: {
      // A local engine on a non-default port: configured, with no key to prove it.
      pockettts: {
        baseUrl: "http://127.0.0.1:9001",
        voice: "alba",
        model: "pocket-tts",
        speed: 0.8,
        chunkCharLimit: 300,
      },
      // Never set up: schema defaults and no key. Migrating this would invent a
      // preset the user never made.
      openai: {},
    },
  });
  await rerun();
  {
    const rows = await audioRows();
    assert.equal(rows.length, 2, "one preset per configured source, and none for the untouched one");

    const eleven = rows.find((row) => row.audioSource === "elevenlabs");
    assert.ok(eleven, "the source that was speaking became a preset");
    assert.equal(eleven?.name, "ElevenLabs", "named after the engine");
    assert.equal(eleven?.defaultForAgents, "true", "and it is the one that keeps speaking");
    assert.equal(eleven?.audioVoice, "eleven-voice", "its voice came across");
    const elevenSettings = JSON.parse(String(eleven?.audioSettings));
    assert.equal(elevenSettings.speed, 1.3, "its tuning came across");
    assert.equal(elevenSettings.timeoutMs, 120_000, "its tuning came across");

    const pocket = rows.find((row) => row.audioSource === "pockettts");
    assert.ok(pocket, "a source configured but not active is still a preset");
    assert.match(String(pocket?.name), /migrated/u, "and is marked as carried over");
    assert.equal(pocket?.defaultForAgents, "false", "without stealing the default");
    assert.equal(pocket?.baseUrl, "http://127.0.0.1:9001", "its address came across");
    const pocketSettings = JSON.parse(String(pocket?.audioSettings));
    assert.equal(pocketSettings.speed, 0.8, "each preset keeps its own tuning");
    assert.equal(pocketSettings.chunkCharLimit, 300, "each preset keeps its own tuning");
  }

  // ── Running again changes nothing ──
  {
    await migrate();
    assert.equal((await audioRows()).length, 2, "the marker stops a second pass");
    await rerun();
    assert.equal(
      (await audioRows()).length,
      2,
      "and even without the marker, existing presets are matched not doubled",
    );
  }

  // ── Settings edited on the connection are never overwritten ──
  {
    const eleven = (await audioRows()).find((row) => row.audioSource === "elevenlabs");
    await connections.update(String(eleven?.id), { audioSettings: { speed: 2.0 } } as never);
    await rerun();
    const after = (await audioRows()).find((row) => row.audioSource === "elevenlabs");
    assert.equal(
      JSON.parse(String(after?.audioSettings)).speed,
      2.0,
      "a re-run must not undo tuning the user has since changed",
    );
  }

  // ── Speech switched off migrates presets but no default ──
  await clearAudio();
  await writeSettings({
    enabled: false,
    source: "elevenlabs",
    apiKey: cryptoModule.encryptApiKey("eleven-key"),
    voice: "eleven-voice",
  });
  await rerun();
  {
    const rows = await audioRows();
    assert.equal(rows.length, 1, "a configured engine is still worth keeping");
    assert.equal(
      rows[0]?.defaultForAgents,
      "false",
      "but nothing becomes the default, so an install with speech off gains no voice",
    );
  }

  console.info("TTS audio connection migration regression passed.");
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  await rm(storageRoot, { recursive: true, force: true });
}
