// Extra provider parameters reach every outbound audio request, and nothing
// else about the request changes.
//
// The merge is the one place a stored value can alter what an engine was asked
// to do, so its limits are pinned here rather than left to each provider: the
// content key survives, a nested knob lands beside its siblings instead of
// replacing them, prototype keys never arrive, and a lane's parameters stay in
// that lane. An empty record has to leave a body byte-identical, which is what
// keeps an install nobody has parameterized on exactly the wire it had before.
//
// Providers and the game-audio builder do no I/O, so these are plain calls.

import assert from "node:assert/strict";
import { logger } from "../../../packages/server/src/lib/logger.ts";
import { applyAudioParameters } from "../../../packages/server/src/services/tts/audio-parameter-merge.ts";
import { createTTSProvider } from "../../../packages/server/src/services/tts/provider-registry.ts";
import {
  buildElevenLabsGameAudioRequest,
  ELEVENLABS_CONTEXT_MUSIC_LENGTH_MS,
} from "../../../packages/server/src/services/tts/elevenlabs.provider.ts";
import { ttsConfigSchema, type TTSConfig } from "../../../packages/shared/src/types/tts.js";

const config = (overrides: Partial<TTSConfig> = {}): TTSConfig =>
  ttsConfigSchema.parse({ enabled: true, apiKey: "secret-key", ...overrides });

const jsonBody = (body: string | FormData): Record<string, unknown> => {
  assert.equal(typeof body, "string", "expected a JSON body");
  return JSON.parse(body as string) as Record<string, unknown>;
};

const formBody = (body: string | FormData): FormData => {
  assert.ok(body instanceof FormData, "expected a multipart body");
  return body;
};

/** Runs work with logger.warn captured, so "never silent" can be asserted. */
function withCapturedWarnings<T>(work: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = logger.warn.bind(logger);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (logger as any).warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { result: work(), warnings };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any).warn = original;
  }
}

const speech = (parameters: Record<string, unknown>) => ({ audioParameters: { speech: parameters } });

// ── Nobody parameterized anything, so nothing changes ──
// This is the assertion that lets every pre-existing body pin in
// tts-provider-registry keep standing unedited.
{
  for (const source of ["openai", "elevenlabs", "nanogpt", "xai", "pockettts"] as const) {
    const plain = createTTSProvider(config({ source, voice: "alloy" })).buildSpeechRequest({
      text: "Hello.",
      voice: "alloy",
    });
    const parameterized = createTTSProvider(config({ source, voice: "alloy", audioParameters: {} })).buildSpeechRequest(
      { text: "Hello.", voice: "alloy" },
    );
    assert.deepEqual(parameterized.body, plain.body, `${source}: an empty parameter map must change nothing`);
  }
}

// ── A parameter reaches the body of every JSON backend ──
{
  const cases = [
    { source: "openai" as const, voice: "alloy" },
    { source: "nanogpt" as const, voice: "alloy" },
    { source: "elevenlabs" as const, voice: "Rachel" },
    { source: "xai" as const, voice: "eve" },
  ];
  for (const { source, voice } of cases) {
    const request = createTTSProvider(
      config({ source, voice, ...speech({ exaggeration: 0.7, language_id: "en" }) }),
    ).buildSpeechRequest({ text: "Hello.", voice });
    const body = jsonBody(request.body);
    assert.equal(body.exaggeration, 0.7, `${source}: a number parameter reaches the body`);
    assert.equal(body.language_id, "en", `${source}: a string parameter reaches the body`);
  }

  // PocketTTS behind the OpenAI-compatible wrapper is a JSON backend too.
  const wrapper = createTTSProvider(config({ source: "pockettts", ...speech({ exaggeration: 0.4 }) }), {
    pocketTtsMode: "openai",
  }).buildSpeechRequest({ text: "Hello.", voice: "alba" });
  assert.equal(jsonBody(wrapper.body).exaggeration, 0.4, "the PocketTTS wrapper takes parameters");
}

// ── A nested knob lands beside its siblings ──
// ElevenLabs keeps stability inside voice_settings. A spread would drop it, and
// the user would have silently lost a setting they configured elsewhere.
{
  const { result: request, warnings } = withCapturedWarnings(() =>
    createTTSProvider(
      config({
        source: "elevenlabs",
        voice: "Rachel",
        elevenLabsStability: 0.42,
        ...speech({ voice_settings: { style: 0.3, use_speaker_boost: false } }),
      }),
    ).buildSpeechRequest({ text: "Hello.", voice: "Rachel" }),
  );

  const settings = jsonBody(request.body).voice_settings as Record<string, unknown>;
  assert.equal(settings.stability, 0.42, "a nested merge must not erase the sibling the engine set");
  assert.equal(settings.style, 0.3, "the nested parameter arrives");
  assert.equal(settings.use_speaker_boost, false, "false is a value, not an absence");
  assert.deepEqual(
    warnings,
    [],
    "a merge loses nothing, so it must not warn: this fires on every request that sets a voice_settings knob",
  );
}

// ── The text to synthesize is the one key a parameter may not take ──
{
  const { result, warnings } = withCapturedWarnings(() =>
    createTTSProvider(
      config({ source: "openai", voice: "alloy", ...speech({ input: "not this", speed: 1.5 }) }),
    ).buildSpeechRequest({ text: "Say this.", voice: "alloy" }),
  );
  const body = jsonBody(result.body);
  assert.equal(body.input, "Say this.", "a parameter must never replace the text to speak");
  assert.equal(body.speed, 1.5, "the rest of the same record still applies");
  assert.ok(
    warnings.some((line) => line.includes("input")),
    "refusing the content key must say so rather than dropping it quietly",
  );

  // ElevenLabs and xAI call it text, so the guard has to follow the backend.
  const eleven = createTTSProvider(
    config({ source: "elevenlabs", voice: "Rachel", ...speech({ text: "not this" }) }),
  ).buildSpeechRequest({ text: "Say this.", voice: "Rachel" });
  assert.equal(jsonBody(eleven.body).text, "Say this.", "ElevenLabs names its content key text");
}

// ── Prototype keys never reach a request ──
// Called directly rather than through the schema, so this pins the guard itself
// instead of whatever Zod happens to do with an own "__proto__" key on the way
// past. JSON.parse is the shape a stored blob actually arrives in.
{
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 2, "kept": 3}');
  const body = applyAudioParameters({ input: "Hello." }, hostile, { protectedKey: "input", label: "speech" });

  assert.equal(body.kept, 3, "an ordinary key beside unsafe ones still arrives");
  for (const unsafe of ["__proto__", "constructor", "prototype"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(body, unsafe), `${unsafe} must be dropped`);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "the object prototype is untouched");
  assert.equal(Object.getPrototypeOf(body), Object.prototype, "the merged body keeps its own prototype");
}

// ── Overriding a value the engine computed is allowed and never silent ──
{
  const { result, warnings } = withCapturedWarnings(() =>
    createTTSProvider(
      config({ source: "openai", voice: "alloy", speed: 1, ...speech({ speed: 2 }) }),
    ).buildSpeechRequest({ text: "Hello.", voice: "alloy" }),
  );
  assert.equal(jsonBody(result.body).speed, 2, "the user typed it and means it");
  assert.ok(
    warnings.some((line) => line.includes("speed")),
    "replacing a value the engine set must be reported",
  );

  // A key the body did not already carry is ordinary, not an override.
  const { warnings: quiet } = withCapturedWarnings(() =>
    createTTSProvider(
      config({ source: "openai", voice: "alloy", ...speech({ exaggeration: 0.7 }) }),
    ).buildSpeechRequest({ text: "Hello.", voice: "alloy" }),
  );
  assert.deepEqual(quiet, [], "adding a new key is not worth a warning");
}

// ── The official PocketTTS form takes scalars only ──
{
  const { result, warnings } = withCapturedWarnings(() =>
    createTTSProvider(
      config({
        source: "pockettts",
        baseUrl: "http://localhost:8000",
        ...speech({ exaggeration: 0.7, enabled: true, nested: { no: 1 }, text: "not this" }),
      }),
      { pocketTtsMode: "official" },
    ).buildSpeechRequest({ text: "Say this.", voice: "voice-url" }),
  );

  const form = formBody(result.body);
  assert.equal(form.get("text"), "Say this.", "the content field survives");
  assert.equal(form.get("exaggeration"), "0.7", "a number is sent as its string form");
  assert.equal(form.get("enabled"), "true", "a boolean is sent as its string form");
  assert.equal(form.get("nested"), null, "multipart carries no nested value, so it is skipped");
  assert.ok(
    warnings.some((line) => line.includes("nested")),
    "a skipped parameter must be reported, not dropped in silence",
  );
  assert.ok(
    warnings.some((line) => line.includes("text")),
    "the content field is protected here too",
  );
}

// ── Lanes do not leak into each other ──
{
  const cfg = config({
    source: "elevenlabs",
    voice: "Rachel",
    audioParameters: {
      speech: { voice_settings: { style: 0.9 } },
      sfx: { prompt_influence: 0.8 },
      music: { force_instrumental: false },
    },
  });

  const spoken = jsonBody(createTTSProvider(cfg).buildSpeechRequest({ text: "Hello.", voice: "Rachel" }).body);
  assert.equal(spoken.prompt_influence, undefined, "a sound effect knob never reaches speech");
  assert.equal(spoken.force_instrumental, undefined, "a music knob never reaches speech");

  const effect = jsonBody(buildElevenLabsGameAudioRequest(cfg, { kind: "sfx", prompt: "a door" }).body);
  assert.equal(effect.prompt_influence, 0.8, "the sfx lane answers for a sound effect");
  assert.equal(effect.voice_settings, undefined, "a speech knob never reaches a sound effect");

  const track = jsonBody(buildElevenLabsGameAudioRequest(cfg, { kind: "music", prompt: "a market" }).body);
  assert.equal(track.force_instrumental, false, "the music lane answers for a track");
  assert.equal(track.prompt_influence, undefined, "the sfx lane does not answer for music");
}

// ── The game-audio builder keeps its endpoints and its defaults ──
{
  // Resolution always fills baseUrl from the row or the source definition, so a
  // config reaching the builder never carries another source's default.
  const plain = config({ source: "elevenlabs", baseUrl: "https://api.elevenlabs.io" });

  const effect = buildElevenLabsGameAudioRequest(plain, { kind: "sfx", prompt: "a door" });
  assert.equal(effect.url, "https://api.elevenlabs.io/v1/sound-generation", "sound effects have their own endpoint");
  assert.equal(effect.headers["xi-api-key"], "secret-key", "the key travels in the ElevenLabs header");
  assert.equal(effect.decodeCompressedResponse, true, "ElevenLabs answers gzipped");
  assert.deepEqual(jsonBody(effect.body), { text: "a door", prompt_influence: 0.3 });

  const track = buildElevenLabsGameAudioRequest(plain, { kind: "music", prompt: "a market" });
  assert.equal(track.url, "https://api.elevenlabs.io/v1/music", "music has its own endpoint");
  assert.deepEqual(jsonBody(track.body), {
    prompt: "a market",
    music_length_ms: ELEVENLABS_CONTEXT_MUSIC_LENGTH_MS,
    force_instrumental: true,
  });

  // A context track owns its length; the default only covers a scene that names none.
  const timed = buildElevenLabsGameAudioRequest(plain, { kind: "music", prompt: "a market", lengthMs: 45_000 });
  assert.equal(jsonBody(timed.body).music_length_ms, 45_000, "the scene's length reaches the request");

  // Overriding it is allowed, because a user who typed it means it, but the
  // scene computed that value so the override has to be visible.
  const { result: overridden, warnings } = withCapturedWarnings(() =>
    buildElevenLabsGameAudioRequest(
      config({ source: "elevenlabs", audioParameters: { music: { music_length_ms: 10_000 } } }),
      { kind: "music", prompt: "a market", lengthMs: 45_000 },
    ),
  );
  assert.equal(jsonBody(overridden.body).music_length_ms, 10_000, "a parameter outranks the computed length");
  assert.ok(
    warnings.some((line) => line.includes("music_length_ms")),
    "overriding the scene's own length must be reported",
  );

  // The prompt is the content here, so it is the protected key.
  const kept = buildElevenLabsGameAudioRequest(
    config({ source: "elevenlabs", audioParameters: { music: { prompt: "not this" } } }),
    { kind: "music", prompt: "a market" },
  );
  assert.equal(jsonBody(kept.body).prompt, "a market", "a parameter may not replace what to compose");

  // A proxied base URL still reaches the same paths.
  const proxied = buildElevenLabsGameAudioRequest(config({ source: "elevenlabs", baseUrl: "https://proxy.test/v1" }), {
    kind: "sfx",
    prompt: "a door",
  });
  assert.equal(proxied.url, "https://proxy.test/v1/sound-generation", "the configured endpoint is honoured");
}

console.info("TTS audio parameters regression passed.");
