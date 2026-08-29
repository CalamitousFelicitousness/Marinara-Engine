// Speech, sound effects, and music each resolve to their own engine.
//
// The chain per purpose is: an explicitly requested connection, then that
// purpose's default and fallback, then the base audio default and fallback,
// then the app-level settings. Three things about it are easy to break and
// quiet when broken:
//
//   Order. A purpose pair has to outrank the base pair, or pointing music at a
//   second engine changes nothing and the setting looks broken. The base pair
//   has to still answer when no purpose pair is set, or every install that
//   never opened the new controls goes silent.
//
//   Origin honesty. A purpose lane that fell through to the base pair reports
//   "default", not "purpose_default". The surfaces use origin to explain what
//   is answering, so a lane that claims a pair it does not have describes a
//   setting the user never made.
//
//   The capability answer. Whether an engine may generate is the source's
//   capability AND the connection's opt-in. Reading only the connection flag
//   lets a backend with no generator claim the lane; reading only the source
//   ignores the switch in the editor.
//
// Generation itself is never exercised: the outbound policy for game audio is
// https-only, so there is no offline provider to point it at. The gate and the
// routing are the contract.

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

  // ── With no connections at all, the app-level settings answer every lane ──
  {
    await writeSettings({ enabled: true, source: "elevenlabs", elevenLabsGameSoundEffects: true });
    const sfx = await resolve(storage, connections, undefined, "sfx");
    assert.equal(sfx.origin, "legacy", "with nothing configured the settings blob answers");
    assert.equal(sfx.purpose, "sfx", "the answer names the lane it was asked about");
    assert.equal(sfx.gameAudioEnabled, true, "an ElevenLabs blob with the flag on may generate sound effects");

    const music = await resolve(storage, connections, undefined, "music");
    assert.equal(music.gameAudioEnabled, false, "the music flag is off, so that lane cannot generate");
  }
  {
    // Same flags, a source with no generator. Capability is two terms, and this
    // is the one a connection flag alone would get wrong.
    await writeSettings({
      enabled: true,
      source: "openai",
      elevenLabsGameSoundEffects: true,
      elevenLabsGameMusic: true,
    });
    const sfx = await resolve(storage, connections, undefined, "sfx");
    assert.equal(sfx.gameAudioEnabled, false, "a source that cannot generate says so even with the flag on");
  }

  await writeSettings({ enabled: true, source: "elevenlabs" });

  // ── The base pair answers every lane until a purpose pair exists ──
  const base = (await connections.create({
    name: "Base Engine",
    provider: "audio",
    apiKey: "base-key",
    baseUrl: "",
    model: "",
    audioSource: "elevenlabs",
    audioSoundEffects: true,
    audioMusic: true,
    defaultForAgents: true,
  } as never))!;
  {
    for (const purpose of ["speech", "sfx", "music"] as const) {
      const result = await resolve(storage, connections, undefined, purpose);
      assert.equal(result.resolvedConnectionId, base.id, `${purpose} falls through to the base audio default`);
      assert.equal(result.origin, "default", `${purpose} reports the pair that actually answered`);
    }
  }

  // ── Asking with three arguments still answers for speech ──
  {
    const result = await resolve(storage, connections, undefined);
    assert.equal(result.purpose, "speech", "an unnamed purpose is speech");
    assert.equal(result.gameAudioEnabled, null, "speech has no generation capability to report");
    assert.equal(result.resolvedConnectionId, base.id, "and resolves exactly as it did before purposes existed");
  }

  // ── A purpose default outranks the base default, for that lane only ──
  const sfxEngine = (await connections.create({
    name: "Sfx Engine",
    provider: "audio",
    apiKey: "sfx-key",
    baseUrl: "",
    model: "",
    audioSource: "elevenlabs",
    audioSoundEffects: true,
    defaultForSfx: true,
  } as never))!;
  {
    const sfx = await resolve(storage, connections, undefined, "sfx");
    assert.equal(sfx.resolvedConnectionId, sfxEngine.id, "the sound effect lane uses its own default");
    assert.equal(sfx.origin, "purpose_default", "and says the purpose pair answered");
    assert.equal(sfx.cfg.apiKey, "sfx-key", "identity comes from the row that answered");
    assert.equal(sfx.gameAudioEnabled, true, "which opted into sound effects");

    const speech = await resolve(storage, connections, undefined, "speech");
    assert.equal(speech.resolvedConnectionId, base.id, "speech is undisturbed by a sound effect default");
    const music = await resolve(storage, connections, undefined, "music");
    assert.equal(music.resolvedConnectionId, base.id, "and so is music");
    assert.equal(music.origin, "default", "a lane with no pair of its own reports the base pair");
  }

  // ── A purpose fallback answers when that purpose has no default ──
  const musicFallback = (await connections.create({
    name: "Music Fallback",
    provider: "audio",
    apiKey: "music-key",
    baseUrl: "",
    model: "",
    audioSource: "elevenlabs",
    audioMusic: true,
    fallbackForMusic: true,
  } as never))!;
  {
    const music = await resolve(storage, connections, undefined, "music");
    assert.equal(music.resolvedConnectionId, musicFallback.id, "the music fallback outranks the base default");
    assert.equal(music.origin, "purpose_fallback", "and says so");
  }

  // ── An explicit id wins, and reports capability honestly ──
  {
    const explicit = await resolve(storage, connections, sfxEngine.id, "music");
    assert.equal(explicit.origin, "explicit", "an explicit request is honored for any lane");
    assert.equal(explicit.resolvedConnectionId, sfxEngine.id, "and resolves what was asked for");
    assert.equal(
      explicit.gameAudioEnabled,
      false,
      "a connection that never opted into music cannot generate it, however it was reached",
    );
  }

  // ── The master toggle stays a speech setting ──
  {
    await writeSettings({ enabled: false, source: "elevenlabs" });
    const sfx = await resolve(storage, connections, undefined, "sfx");
    assert.equal(sfx.speechEnabled, false, "an explicit no is still honored for speech");
    assert.equal(sfx.gameAudioEnabled, true, "but silencing narration does not stop a scene being scored");
    await writeSettings({ enabled: true, source: "elevenlabs" });
  }

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

  // ── The routes carry the purpose ──
  const { buildApp } = await import("../../../packages/server/src/app.js");
  app = (await buildApp()) as unknown as Injectable;
  await app.ready();

  {
    const speech = await app.inject({ method: "GET", url: "/api/tts/effective-config" });
    assert.equal(speech.statusCode, 200, "effective config answers");
    const speechBody = speech.json();
    assert.equal(speechBody.purpose, "speech", "an unqualified request is about speech");
    assert.equal(speechBody.gameAudioEnabled, null, "and reports no generation capability");
    assert.equal(speechBody.resolvedConnectionId, base.id, "resolving the base default");

    const sfx = await app.inject({ method: "GET", url: "/api/tts/effective-config?purpose=sfx" });
    const sfxBody = sfx.json();
    assert.equal(sfxBody.purpose, "sfx", "the response names the lane asked about");
    assert.equal(sfxBody.origin, "purpose_default", "and how it was reached");
    assert.equal(sfxBody.resolvedConnectionId, sfxEngine.id, "and which engine answered");
    assert.equal(sfxBody.gameAudioEnabled, true, "and whether it may generate");
    assert.equal(sfxBody.config.apiKey, TTS_API_KEY_MASK, "keys are masked in transport as they always were");
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
  // Music gets a capable engine at an address the outbound policy refuses, which
  // reaches the generator and fails there without any egress. Sound effects get
  // a source with no generator, which the gate refuses outright. A route that
  // ignored kind would answer both the same way.
  {
    const musicEngine = (await connections.create({
      name: "Music Engine",
      provider: "audio",
      apiKey: "music-key",
      baseUrl: "http://127.0.0.1:9",
      model: "",
      audioSource: "elevenlabs",
      audioMusic: true,
      defaultForMusic: true,
    } as never))!;
    const openAiSfx = (await connections.create({
      name: "OpenAI Sfx",
      provider: "audio",
      apiKey: "openai-key",
      baseUrl: "",
      model: "",
      audioSource: "openai",
      audioSoundEffects: true,
      defaultForSfx: true,
    } as never))!;

    assert.equal(
      (await resolve(storage, connections, undefined, "music")).resolvedConnectionId,
      musicEngine.id,
      "precondition: the music lane resolves to the capable engine",
    );
    assert.equal(
      (await resolve(storage, connections, undefined, "sfx")).resolvedConnectionId,
      openAiSfx.id,
      "precondition: the sound effect lane resolves to the engine with no generator",
    );

    const sfx = await app.inject({
      method: "POST",
      url: "/api/tts/game-audio",
      payload: { kind: "sfx", prompt: "a door closing" },
    });
    assert.equal(sfx.statusCode, 400, "an opted-in connection whose source cannot generate is refused");
    assert.match(
      sfx.json().error,
      /not enabled for the resolved audio connection/u,
      "and the refusal is about the connection that answered for that lane",
    );

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
      audioSoundEffects: true,
      audioSettings: {
        audioParameters: {
          speech: { voice_settings: { style: 0.4 }, seed: 17 },
          sfx: { prompt_influence: 0.9 },
        },
      },
    } as never))!;

    const speech = await app.inject({
      method: "GET",
      url: `/api/tts/effective-request?connectionId=${parameterized.id}`,
    });
    assert.equal(speech.statusCode, 200, "a speech preview answers");
    const speechBody = speech.json();
    assert.equal(speechBody.purpose, "speech", "the preview names the lane it is for");
    assert.equal(speechBody.resolvedConnectionId, parameterized.id, "and the connection that answered");
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

    const sfx = await app.inject({
      method: "GET",
      url: `/api/tts/effective-request?connectionId=${parameterized.id}&purpose=sfx`,
    });
    assert.equal(sfx.statusCode, 200, "a sound effect preview answers");
    const sfxBody = sfx.json();
    assert.match(sfxBody.url, /\/v1\/sound-generation$/u, "the sound effect endpoint, not the speech one");
    assert.equal(sfxBody.body.prompt_influence, 0.9, "the sfx lane's own parameter, not the speech lane's");
    assert.equal(sfxBody.body.seed, undefined, "a speech parameter must not appear in a sound effect preview");

    // No generator means nothing honest to preview, so it says so rather than
    // showing a request that could never be sent.
    const openAi = (await connections.create({
      name: "Preview Without Generator",
      provider: "audio",
      apiKey: "openai-preview-key",
      baseUrl: "",
      model: "",
      audioSource: "openai",
      audioSoundEffects: true,
    } as never))!;
    const refused = await app.inject({
      method: "GET",
      url: `/api/tts/effective-request?connectionId=${openAi.id}&purpose=music`,
    });
    assert.equal(refused.statusCode, 400, "a source with no game-audio generator has no request to show");

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
