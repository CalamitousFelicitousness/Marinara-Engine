// Speech, sound effects, and music each resolve to their own engine.
//
// Speech resolves audio connections; sound effects and music resolve Music &
// Sound Effects connections, each lane's own default and fallback ahead of the
// shared pair. Three things are easy to break and quiet when broken:
//
//   The routes carry the lane. /tts/game-audio with no connection id has to
//   reach the engine its kind was pointed at, and /audio/config has to answer
//   for the lane asked about.
//
//   The master toggle stays a speech setting. Silencing narration is not a
//   reason to stop scoring a scene.
//
//   The pins. A game stores one pin per lane under names the dangling-reference
//   sweep matches, and the resolver reads the same names.
//
// Generation itself is never exercised: the outbound policy for generated audio
// is public HTTPS only, so there is no offline provider to point it at.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { TTS_API_KEY_MASK, TTS_SETTINGS_KEY, ttsConfigSchema } from "../../../packages/shared/src/types/tts.js";
import { effectiveGameAudioPin } from "../../../packages/shared/src/constants/audio-purposes.js";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const readSource = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

const dataDir = mkdtempSync(join(tmpdir(), "marinara-audio-purpose-routing-"));

type Injectable = {
  close(): Promise<void>;
  ready(): Promise<unknown>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; body: string; json(): any }>;
};

let app: Injectable | null = null;

try {
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = join(dataDir, "file-storage");
  process.env.MARINARA_FILE_STORAGE_DIR = join(dataDir, "file-storage");
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";

  const [dbModule, appSettingsModule, connectionsModule, resolutionModule, schemaModule, queryModule] =
    await Promise.all([
      import("../../../packages/server/src/db/connection.js"),
      import("../../../packages/server/src/services/storage/app-settings.storage.js"),
      import("../../../packages/server/src/services/storage/connections.storage.js"),
      import("../../../packages/server/src/services/tts/audio-config-resolution.js"),
      import("../../../packages/server/src/db/schema/index.js"),
      import("../../../packages/server/src/db/file-query.js"),
    ]);

  const db = await dbModule.getDB();
  const storage = appSettingsModule.createAppSettingsStorage(db);
  const connections = connectionsModule.createConnectionsStorage(db);
  const resolve = resolutionModule.resolveAudioConfig;
  const writeSettings = (config: Record<string, unknown>) =>
    storage.set(TTS_SETTINGS_KEY, JSON.stringify(ttsConfigSchema.parse(config)));

  await writeSettings({ enabled: true, source: "elevenlabs" });

  // ── Speech resolves the audio default ──
  const base = (await connections.create({
    name: "Base Engine",
    provider: "audio",
    apiKey: "base-key",
    baseUrl: "",
    model: "",
    audioSource: "elevenlabs",
    defaultForAgents: true,
  } as never))!;
  {
    const result = await resolve(storage, connections, undefined);
    assert.equal(result.resolvedConnectionId, base.id, "speech resolves the audio default");
    assert.equal(result.origin, "default", "and reports the pair that answered");
  }

  // ── Sound effects and music resolve generation connections, lane first ──
  const generation = (extra: Record<string, unknown>) =>
    connections.create({
      provider: "audio_generation",
      audioGenerationSource: "elevenlabs",
      apiKey: "generation-key",
      model: "",
      ...extra,
    } as never);
  const shared = (await generation({
    name: "Shared Engine",
    baseUrl: "http://127.0.0.1:9",
    audioMusic: true,
    audioSoundEffects: true,
    defaultForAgents: true,
  }))!;
  const sfxEngine = (await generation({
    name: "Sfx Engine",
    baseUrl: "",
    audioSoundEffects: false,
    defaultForSfx: true,
  }))!;

  // ── Where a game pin points, per purpose ──
  {
    const legacyOnly = { gameAudioConnectionId: "legacy-pin" };
    for (const purpose of ["speech", "sfx", "music"] as const) {
      assert.equal(
        effectiveGameAudioPin(legacyOnly, purpose),
        "legacy-pin",
        `the all-purpose pin still answers for ${purpose}`,
      );
    }
    const mixed = { gameAudioConnectionId: "legacy-pin", gameMusicConnectionId: "music-pin" };
    assert.equal(effectiveGameAudioPin(mixed, "music"), "music-pin", "a purpose pin wins for its own lane");
    assert.equal(effectiveGameAudioPin(mixed, "sfx"), "legacy-pin", "and leaves the other lanes on the game pin");
    assert.equal(effectiveGameAudioPin({}, "speech"), undefined, "an unpinned game resolves the category chain");
    assert.equal(effectiveGameAudioPin({ gameVoiceConnectionId: "" }, "speech"), undefined, "a blank pin is not a pin");
    assert.equal(
      effectiveGameAudioPin({ gameVoiceConnectionId: "voice-pin" }, "sfx"),
      undefined,
      "the voice pin answers only for speech",
    );
  }

  // ── Game setup writes the pins the resolver reads ──
  // Two halves that must agree on three key names: the route stores them and
  // effectiveGameAudioPin reads them. Nothing else connects the two, so a rename
  // on either side leaves a game pinned to an engine nobody consults.
  {
    const gameRoutes = readSource("packages/server/src/routes/game.routes.ts");
    for (const [purpose, setupField, metadataKey] of [
      ["speech", "voiceConnectionId", "gameVoiceConnectionId"],
      ["sfx", "sfxConnectionId", "gameSfxConnectionId"],
      ["music", "musicConnectionId", "gameMusicConnectionId"],
    ] as const) {
      assert.match(
        gameRoutes,
        new RegExp(String.raw`${metadataKey}: setupConfig\.${setupField}`, "u"),
        `game setup must store ${setupField} as ${metadataKey}`,
      );
      assert.equal(
        effectiveGameAudioPin({ [metadataKey]: "pinned" }, purpose),
        "pinned",
        `${metadataKey} must be the key the ${purpose} lane reads`,
      );
    }
  }

  // ── Deleting a pinned connection releases the pin ──
  // The dangling-reference sweep matches any metadata key ending in
  // ConnectionId, at any depth. That convention is the whole reason the purpose
  // pins need no cleanup code of their own, so a pin renamed off it would keep
  // pointing at an engine that no longer exists.
  {
    const doomed = (await connections.create({
      name: "Doomed Engine",
      provider: "audio",
      apiKey: "doomed-key",
      baseUrl: "",
      model: "",
      audioSource: "elevenlabs",
      audioMusic: true,
    } as never))!;
    const timestamp = new Date().toISOString();
    await db.insert(schemaModule.chats).values({
      id: "purpose-pin-cleanup",
      name: "Pinned game",
      mode: "game",
      metadata: JSON.stringify({
        gameMusicConnectionId: doomed.id,
        gameSfxConnectionId: doomed.id,
        gameAudioSoundEffectsEnabled: true,
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await connections.remove(doomed.id);

    const rows = await db
      .select()
      .from(schemaModule.chats)
      .where(queryModule.eq(schemaModule.chats.id, "purpose-pin-cleanup"));
    const metadata = JSON.parse(String(rows[0]!.metadata)) as Record<string, unknown>;
    assert.equal(metadata.gameMusicConnectionId, null, "a deleted engine stops being the music pin");
    assert.equal(metadata.gameSfxConnectionId, null, "and stops being the sound effect pin");
    assert.equal(metadata.gameAudioSoundEffectsEnabled, true, "while the game's other settings are left alone");
  }

  // ── The routes carry the lane ──
  const { buildApp } = await import("../../../packages/server/src/app.js");
  app = (await buildApp()) as unknown as Injectable;
  await app.ready();

  {
    const speech = await app.inject({ method: "GET", url: "/api/tts/effective-config" });
    assert.equal(speech.statusCode, 200, "effective config answers");
    const speechBody = speech.json();
    assert.equal(speechBody.resolvedConnectionId, base.id, "resolving the speech default");
    assert.equal(speechBody.config.apiKey, TTS_API_KEY_MASK, "keys are masked in transport as they always were");

    const sfx = (await app.inject({ method: "GET", url: "/api/audio/config?kind=sfx" })).json();
    assert.equal(sfx.connectionId, sfxEngine.id, "the sound effect lane answers with its own default");
    assert.equal(sfx.soundEffects, false, "which never switched sound effects on");
    const music = (await app.inject({ method: "GET", url: "/api/audio/config?kind=music" })).json();
    assert.equal(music.connectionId, shared.id, "a lane with no default of its own uses the shared pair");
    assert.equal(music.music, true);

    await writeSettings({ enabled: false, source: "elevenlabs" });
    const silenced = (await app.inject({ method: "GET", url: "/api/audio/config?kind=music" })).json();
    assert.equal(silenced.music, true, "silencing narration does not stop a scene being scored");
    await writeSettings({ enabled: true, source: "elevenlabs" });
  }

  {
    const noContext = await app.inject({
      method: "POST",
      url: "/api/tts/game-audio",
      payload: { kind: "music", prompt: "a quiet market" },
    });
    assert.equal(noContext.statusCode, 400, "music still requires a context key");
  }

  // ── The route routes by kind, with no connection id to help it ──
  // The two lanes are given opposite outcomes so the status distinguishes them.
  // Music reaches the shared engine at an address the outbound policy refuses,
  // which fails at the request without any egress. Sound effects reach their
  // lane default, which never switched them on, so the gate refuses outright.
  {
    const sfx = await app.inject({
      method: "POST",
      url: "/api/tts/game-audio",
      payload: { kind: "sfx", prompt: "a door closing" },
    });
    assert.equal(sfx.statusCode, 400, "the sound effect lane's own default is refused at the gate");
    assert.match(sfx.json().error, /sfx generation is not enabled/u, "about the engine that answered for that lane");

    const music = await app.inject({
      method: "POST",
      url: "/api/tts/game-audio",
      payload: { kind: "music", prompt: "a quiet market", context: { axis: "area", key: "market" } },
    });
    assert.equal(
      music.statusCode,
      502,
      "music reached its own engine and failed at the request, not at the sound effect lane's gate",
    );
  }

  // ── The preview shows the request without sending it ──
  // Free-form parameters make "did mine land, in the shape this engine wants" a
  // question the app has to answer, and it can only answer it because providers
  // do no I/O. The key must never ride along: this endpoint exists to be looked
  // at, and a screenshot of it should be safe to share.
  {
    const parameterized = (await connections.create({
      name: "Parameterized Engine",
      provider: "audio",
      apiKey: "preview-key",
      baseUrl: "",
      model: "",
      audioSource: "elevenlabs",
      audioVoice: "Rachel",
      audioSettings: {
        audioParameters: {
          speech: { voice_settings: { style: 0.4 }, seed: 17 },
        },
      },
    } as never))!;

    const speech = await app.inject({
      method: "GET",
      url: `/api/tts/effective-request?connectionId=${parameterized.id}`,
    });
    assert.equal(speech.statusCode, 200, "a speech preview answers");
    const speechBody = speech.json();
    assert.equal(speechBody.resolvedConnectionId, parameterized.id, "the preview names the connection that answered");
    assert.match(speechBody.url, /\/v1\/text-to-speech\//u, "the URL is the one a real request would use");
    assert.equal(speechBody.body.seed, 17, "a parameter appears in the previewed body");
    assert.equal(speechBody.body.voice_settings.style, 0.4, "including a nested one");
    assert.ok(
      typeof speechBody.body.voice_settings.stability === "number",
      "beside the value the engine itself set, which is the merge the preview is there to show",
    );

    for (const [name, value] of Object.entries(speechBody.headers as Record<string, string>)) {
      assert.ok(!value.includes("preview-key"), `${name}: the API key must never reach a preview`);
    }
    assert.equal(speechBody.headers["xi-api-key"], TTS_API_KEY_MASK, "the header is masked, not removed");
    assert.ok(!speech.body.includes("preview-key"), "and the key appears nowhere else in the response");

    // No backend puts the key in its URL today, so this is the only way to hold
    // the guard honest. A gateway that takes it as a query parameter is a
    // configuration a user can already write into baseUrl.
    const { buildTTSRequestPreview } = await import("../../../packages/server/src/services/tts/request-preview.js");
    const inUrl = buildTTSRequestPreview(
      {
        url: "https://gateway.test/v1/speech?token=secret-in-url",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Sample line." }),
        decodeCompressedResponse: false,
      },
      "secret-in-url",
    );
    assert.ok(!inUrl.url.includes("secret-in-url"), "a key in the URL is redacted like one in a header");
    assert.match(inUrl.url, /token=/u, "and only the key is removed, not the parameter around it");

    // A multipart backend has no JSON body to show, so its fields are listed.
    const form = new FormData();
    form.append("text", "Sample line.");
    form.append("exaggeration", "0.7");
    const multipart = buildTTSRequestPreview(
      { url: "http://localhost:8000/tts", headers: {}, body: form, decodeCompressedResponse: false },
      "",
    );
    assert.equal(multipart.multipart, true, "the reader is told why the body is flat");
    assert.deepEqual(multipart.body, { text: "Sample line.", exaggeration: "0.7" }, "form fields are shown as sent");
  }

  console.info("TTS audio purpose routing regression passed.");
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}
