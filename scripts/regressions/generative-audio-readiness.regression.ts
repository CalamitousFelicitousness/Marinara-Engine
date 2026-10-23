import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marinara-audio-readiness-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.MARINARA_ENV_FILE = join(directory, ".env");
process.env.LOG_LEVEL = "silent";
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createConnectionSchema } = await import("../../packages/shared/dist/index.js");
const { audioRoutes } = await import("../../packages/server/src/routes/audio.routes.js");
const db = await createFileNativeDB();
const connections = createConnectionsStorage(db);
const app = require("fastify")();
app.decorate("db", db);
await app.register(audioRoutes, { prefix: "/api/audio" });
const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  throw new Error("A readiness probe must never contact a provider");
};
try {
  const row = await connections.create(
    createConnectionSchema.parse({
      name: "Suno readiness",
      provider: "audio_generation",
      audioGenerationSource: "sunoapi",
      audioMusic: true,
      audioSoundEffects: true,
      apiKey: "fixture-key",
    }),
  );
  const probe = async (id = row.id) => {
    const response = await app.inject({ method: "GET", url: `/api/audio/config?audioConnectionId=${id}` });
    assert.equal(response.statusCode, 200, response.body);
    assert(!response.body.includes("fixture-key"));
    return response.json();
  };
  for (const callback of [null, "http://8.8.8.8/audio", "https://127.0.0.1/audio", "https://user:pass@8.8.8.8/audio"]) {
    await connections.update(row.id, { audioGenerationCallbackUrl: callback });
    assert.deepEqual(await probe(), {
      connectionId: row.id,
      configured: true,
      music: false,
      soundEffects: true,
      source: "sunoapi",
    }, `invalid music callback ${callback} leaves usable sound effects available`);
  }
  await connections.update(row.id, { audioGenerationCallbackUrl: "https://8.8.8.8/audio" });
  assert.equal((await probe()).music, true, "a public HTTPS callback satisfies the music prerequisite");
  await connections.update(row.id, { apiKey: "" });
  assert.deepEqual(await probe(), {
    connectionId: row.id,
    configured: false,
    music: false,
    soundEffects: false,
    source: "sunoapi",
  }, "a missing remote key makes both capabilities unavailable");

  const custom = await connections.create(
    createConnectionSchema.parse({
      name: "Custom readiness",
      provider: "audio_generation",
      audioGenerationSource: "custom",
      baseUrl: "https://8.8.8.8/v1",
      audioMusic: true,
      audioSoundEffects: true,
    }),
  );
  assert.equal((await probe(custom.id)).music, false, "a compatible source still requires its music endpoint");
  assert.equal((await probe(custom.id)).soundEffects, false, "a compatible source also requires its SFX endpoint");
  await connections.update(custom.id, { audioMusicEndpoint: "music" });
  assert.equal((await probe(custom.id)).music, true, "a compatible source may intentionally have no key");
  assert.equal((await probe(custom.id)).soundEffects, false, "enabling the music endpoint does not enable SFX");
  await connections.update(custom.id, { audioSoundEffectsEndpoint: "sfx" });
  assert.equal((await probe(custom.id)).soundEffects, true);
  assert.equal(fetches, 0, "checking prerequisites submits no request or paid composition");
  console.info("PASS: independent music/SFX readiness, shared Suno public-HTTPS callback validation, keys, compatible endpoints and no provider I/O");
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
  await db._fileStore.close();
  rmSync(directory, { recursive: true, force: true });
}
