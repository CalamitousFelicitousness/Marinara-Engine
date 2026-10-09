// The Character Editor's Voice section edits the cast of the connection that speaks. A connection's
// audioSettings override the app-level TTS settings field by field, so a voice saved to the app-level
// settings while a default audio connection exists would show as saved and never be spoken.
//
// Project imports are dynamic, after the env assignments, so nothing opens a real data folder.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-tts-voice-assignment-connection-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.MARINARA_ENV_FILE = join(dataDir, ".env");

const requireServer = createRequire(new URL("../../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { TTS_SETTINGS_KEY } = await import("../../../packages/shared/src/types/tts.js");
const { parseAudioConnectionSettings } =
  await import("../../../packages/shared/src/types/audio-connection-settings.js");
const { createFileNativeDB } = await import("../../../packages/server/src/db/file-backed-store.js");
const { createAppSettingsStorage } =
  await import("../../../packages/server/src/services/storage/app-settings.storage.js");
const { createConnectionsStorage } =
  await import("../../../packages/server/src/services/storage/connections.storage.js");
const { errorHandler } = await import("../../../packages/server/src/middleware/error-handler.js");
const { ttsRoutes } = await import("../../../packages/server/src/routes/tts.routes.js");

const db = await createFileNativeDB();
const settings = createAppSettingsStorage(db);
const connections = createConnectionsStorage(db);
const app = Fastify();
app.decorate("db", db);
app.setErrorHandler(errorHandler);
await app.register(ttsRoutes, { prefix: "/api/tts" });

const putConfig = (config: unknown) => app.inject({ method: "PUT", url: "/api/tts/config", payload: config as object });
const putVoice = (body: unknown) =>
  app.inject({ method: "PUT", url: "/api/tts/config/voice-assignment", payload: body as object });
const putVoiceMode = (body: unknown) =>
  app.inject({ method: "PUT", url: "/api/tts/config/voice-mode", payload: body as object });
const castOf = async (id: string) => parseAudioConnectionSettings((await connections.getById(id))?.audioSettings);
const effective = async () =>
  (await app.inject({ method: "GET", url: "/api/tts/effective-config" })).json<{
    config: { voiceMode: string; voiceAssignments: Array<{ characterId: string; voice: string }> };
    resolvedConnectionId: string | null;
  }>();

try {
  // App-level settings carry their own cast, as an install that predates audio connections does.
  assert.equal(
    (
      await putConfig({
        enabled: true,
        source: "openai",
        voiceMode: "per-character",
        voiceAssignments: [{ characterId: "dottore", characterName: "Dottore", voice: "onyx" }],
      })
    ).statusCode,
    204,
  );
  const appLevelBefore = await settings.get(TTS_SETTINGS_KEY);

  // The default audio connection owns its cast, so it is what speaks.
  const speaking = await connections.create({
    name: "Local speech",
    provider: "audio",
    apiKey: "",
    baseUrl: "http://127.0.0.1:8880/v1",
    model: "",
    audioSource: "openai",
    audioVoice: "alloy",
    defaultForAgents: true,
    audioSettings: {
      voiceMode: "per-character",
      voiceAssignments: [{ characterId: "alice", characterName: "Alice", voice: "nova" }],
    },
  } as never);
  assert.equal((await effective()).resolvedConnectionId, speaking.id);

  assert.equal((await putVoice({ characterId: "bob", characterName: "Bob", voice: "echo" })).statusCode, 204);
  assert.deepEqual(
    (await castOf(speaking.id)).voiceAssignments,
    [
      { characterId: "alice", characterName: "Alice", voice: "nova" },
      { characterId: "bob", characterName: "Bob", voice: "echo" },
    ],
    "the row is added to the speaking connection's cast",
  );
  assert.equal(await settings.get(TTS_SETTINGS_KEY), appLevelBefore, "the app-level settings are not touched");
  assert.ok(
    (await effective()).config.voiceAssignments.some((row) => row.characterId === "bob" && row.voice === "echo"),
    "what speaks now has the saved voice",
  );

  assert.equal((await putVoiceMode({ voiceMode: "single" })).statusCode, 204);
  assert.equal((await castOf(speaking.id)).voiceMode, "single");
  assert.equal((await effective()).config.voiceMode, "single");
  assert.equal(await settings.get(TTS_SETTINGS_KEY), appLevelBefore);

  // A connection that inherits its cast gets the cast it speaks with, plus the new row.
  const inheriting = await connections.create({
    name: "Inheriting speech",
    provider: "audio",
    apiKey: "",
    baseUrl: "http://127.0.0.1:8881/v1",
    model: "",
    audioSource: "openai",
    audioVoice: "alloy",
    defaultForAgents: true,
  } as never);
  assert.equal((await effective()).resolvedConnectionId, inheriting.id);
  assert.equal((await putVoice({ characterId: "carol", characterName: "Carol", voice: "fable" })).statusCode, 204);
  assert.deepEqual((await castOf(inheriting.id)).voiceAssignments, [
    { characterId: "dottore", characterName: "Dottore", voice: "onyx" },
    { characterId: "carol", characterName: "Carol", voice: "fable" },
  ]);
  assert.equal(await settings.get(TTS_SETTINGS_KEY), appLevelBefore);
} finally {
  await app.close();
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.info("TTS voice assignment connection regression passed.");
