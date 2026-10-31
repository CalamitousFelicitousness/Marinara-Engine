// Sound-effect and music lanes on Music & Sound Effects connections: each lane's own default
// outranks the shared pair, NanoGPT submits and polls a job, and the split carries a legacy
// row's lane flags and NanoGPT lane models. No provider call leaves the process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "marinara-generative-audio-lanes-"));
Object.assign(process.env, {
  DATA_DIR: data,
  FILE_STORAGE_DIR: join(data, "storage"),
  MARINARA_ENV_FILE: join(data, ".env"),
  LOG_LEVEL: "silent",
});
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { migrateGenerativeAudioConnections } =
  await import("../../packages/server/src/services/connections/generative-audio-connection-migration.js");
const { resolveGenerativeAudioConfig } =
  await import("../../packages/server/src/services/audio/generative-audio.service.js");
const { generateAudioBytes } = await import("../../packages/server/src/services/audio/generative-audio-providers.js");
const { createConnectionSchema } = await import("../../packages/shared/dist/index.js");
const { apiConnections } = await import("../../packages/server/src/db/schema/index.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");

const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0, 1]);
const apiBase = "https://8.8.8.8";
const download = "https://1.1.1.1/run/track.mp3";
const key = "fixture-nanogpt-key";
type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };
const calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response(null, { status: 500 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const audio = () => new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return respond(call);
  };
  const nanogpt = {
    source: "nanogpt" as const,
    baseUrl: `${apiBase}/api/v1`,
    apiKey: key,
    model: "ACE-Step-v1.5-Base",
    soundEffectsModel: "mirelo-ai/sfx1.6/text-to-audio",
  };

  // A model that answers inline returns its audio from the submission.
  calls.length = 0;
  respond = () => audio();
  assert.deepEqual(await generateAudioBytes(nanogpt, "music", "Rain on a tin roof", { lengthMs: 90_000 }), mp3);
  assert.equal(calls[0]!.url, `${apiBase}/api/v1/audio/speech`);
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${key}`);
  assert.deepEqual(calls[0]!.body, { model: "ACE-Step-v1.5-Base", input: "Rain on a tin roof", duration: 90 });

  // A job: submit, poll while pending, then download from the run's own host without credentials.
  calls.length = 0;
  let polls = 0;
  respond = (call) => {
    if (call.url.endsWith("/audio/speech")) return json({ status: "pending", runId: "3f2a9c" }, 202);
    if (call.url.includes("/tts/status")) {
      polls++;
      return polls === 1 ? json({ status: "pending" }) : json({ status: "completed", audioUrls: [download] });
    }
    return call.url === download ? audio() : new Response(null, { status: 404 });
  };
  assert.deepEqual(await generateAudioBytes(nanogpt, "sfx", "A door creaks"), mp3);
  assert.deepEqual(calls[0]!.body, { model: "mirelo-ai/sfx1.6/text-to-audio", input: "A door creaks" });
  assert.equal(
    calls[1]!.url,
    `${apiBase}/api/tts/status?runId=3f2a9c&model=${encodeURIComponent("mirelo-ai/sfx1.6/text-to-audio")}`,
  );
  assert.equal(calls[1]!.headers.get("x-api-key"), key, "the status endpoint authenticates with x-api-key");
  assert.equal(polls, 2, "a pending status is polled again");
  const fetched = calls.at(-1)!;
  assert.equal(fetched.url, download);
  assert.equal(fetched.headers.get("authorization"), null, "the download never receives the key");
  assert.equal(fetched.headers.get("x-api-key"), null, "the download never receives the key");

  // A dashed UUID, a single audioUrl on another host, and a field the parser does not read.
  calls.length = 0;
  const fal = "https://9.9.9.9/files/b/x.mp3";
  respond = (call) => {
    if (call.url.endsWith("/audio/speech")) return json({ runId: "6f0c2a7e-1b2d-4c3e-9f80-0123456789ab" }, 202);
    if (call.url.includes("/tts/status")) return json({ status: "completed", audioUrl: fal, terminal: true });
    return call.url === fal ? audio() : new Response(null, { status: 404 });
  };
  assert.deepEqual(await generateAudioBytes(nanogpt, "music", "A slow waltz"), mp3);
  assert.equal(calls.at(-1)!.url, fal, "a single audioUrl is downloaded from its own host");

  calls.length = 0;
  respond = (call) =>
    call.url.endsWith("/audio/speech") ? json({ runId: "dead" }, 202) : json({ status: "failed", error: "quota" });
  await assert.rejects(generateAudioBytes(nanogpt, "sfx", "Thunder"), /NanoGPT audio task failed/);

  calls.length = 0;
  await assert.rejects(
    generateAudioBytes({ ...nanogpt, soundEffectsModel: "" }, "sfx", "Thunder"),
    /Set a NanoGPT sound-effects model/,
  );
  assert.equal(calls.length, 0, "an unset lane model never reaches the provider");
} finally {
  globalThis.fetch = originalFetch;
}

const db = await createFileNativeDB();
try {
  const connections = createConnectionsStorage(db);
  const generation = (name: string, extra: Record<string, unknown> = {}) =>
    connections.create(
      createConnectionSchema.parse({
        name,
        provider: "audio_generation",
        audioGenerationSource: "elevenlabs",
        apiKey: "fixture-eleven-key",
        audioMusic: true,
        audioSoundEffects: true,
        ...extra,
      }),
    );
  const shared = await generation("Shared", { defaultForAgents: true });
  const effects = await generation("Effects", { defaultForSfx: true });
  assert.equal(
    (await resolveGenerativeAudioConfig(db, null, "sfx")).id,
    effects!.id,
    "a lane default outranks the pair",
  );
  assert.equal((await resolveGenerativeAudioConfig(db, null, "music")).id, shared!.id, "an unset lane uses the pair");
  assert.equal((await resolveGenerativeAudioConfig(db, null)).id, shared!.id, "no lane means the pair");

  const replacement = await generation("Replacement", { defaultForSfx: true });
  assert.equal((await connections.getById(effects!.id))?.defaultForSfx, "false", "a lane default is exclusive");
  assert.equal((await resolveGenerativeAudioConfig(db, null, "sfx")).id, replacement!.id);
  const speech = await connections.create(
    createConnectionSchema.parse({ name: "Speech", provider: "audio", audioSource: "openai", defaultForMusic: true }),
  );
  assert.equal(speech?.defaultForMusic, "false", "a speech connection cannot hold a lane flag");

  // A pre-split NanoGPT row: lane models in its parameters, the music lane pointed at it.
  const legacy = await connections.create(
    createConnectionSchema.parse({
      name: "NanoGPT",
      provider: "audio",
      audioSource: "nanogpt",
      model: "google/gemini-3.8-flash-tts",
      apiKey: key,
      audioMusic: true,
      audioSoundEffects: true,
      audioSettings: {
        audioParameters: { music: { model: "ACE-Step-v1.5-Base" }, sfx: { model: "mirelo-ai/sfx1.6/text-to-audio" } },
      },
    }),
  );
  await db
    .update(apiConnections)
    .set({ defaultForMusic: "true", defaultForSfx: "true" })
    .where(eq(apiConnections.id, legacy!.id));
  await migrateGenerativeAudioConnections(db);
  const split = await connections.getAudioGenerationForLegacyConnection(legacy!.id);
  assert.ok(split, "a NanoGPT row with lane models is split");
  assert.equal(split.audioGenerationSource, "nanogpt");
  assert.equal(split.model, "ACE-Step-v1.5-Base", "the music model comes from the music parameters");
  assert.equal(split.audioSoundEffectsModel, "mirelo-ai/sfx1.6/text-to-audio");
  assert.equal(split.apiKey, key);
  assert.equal(split.defaultForMusic, "true", "the music lane moves with its engine");
  assert.equal(split.defaultForSfx, "false", "a lane already held by a generation row stays there");
  const retired = await connections.getById(legacy!.id);
  assert.equal(retired?.audioMusic, "false");
  assert.equal(retired?.defaultForMusic, "false", "the speech row releases its lane flags");
  assert.equal(retired?.model, "google/gemini-3.8-flash-tts", "the speech model is untouched");
  assert.equal((await resolveGenerativeAudioConfig(db, null, "music")).id, split.id);
  assert.equal(
    (await resolveGenerativeAudioConfig(db, legacy!.id, "music")).id,
    split.id,
    "a pin to the old row follows",
  );

  const unconfigured = await connections.create(
    createConnectionSchema.parse({
      name: "NanoGPT speech only",
      provider: "audio",
      audioSource: "nanogpt",
      apiKey: key,
      audioMusic: true,
    }),
  );
  await migrateGenerativeAudioConnections(db);
  assert.equal(
    await connections.getAudioGenerationForLegacyConnection(unconfigured!.id),
    null,
    "a NanoGPT row without a lane model has nothing to split",
  );
} finally {
  await db._fileStore.close();
  rmSync(data, { recursive: true, force: true });
}
console.info("Generative audio lanes regression passed.");
