// Each TTS backend builds its own request, and the registry picks the backend.
//
// Every wire format is pinned here: URL, headers, body, text preparation, and
// whether speed is sent. A provider talks to a service this repo cannot test
// against, so a wrong field is silent until a user hits it.
//
// Providers do no I/O, so these are plain function calls: no mock servers, no
// ports, no timers.

import assert from "node:assert/strict";
import { createTTSProvider } from "../../../packages/server/src/services/tts/provider-registry.ts";
import {
  NANOGPT_FALLBACK_TTS_MODELS,
  nanoGptModelFamily,
  nanoGptVoicesForModel,
  parseNanoGptModelOptions,
} from "../../../packages/server/src/services/tts/nanogpt-catalog.ts";
import { ttsConfigSchema, type TTSConfig } from "../../../packages/shared/src/types/tts.js";

const config = (overrides: Partial<TTSConfig> = {}): TTSConfig =>
  ttsConfigSchema.parse({ enabled: true, apiKey: "secret-key", ...overrides });

const jsonBody = (body: string | FormData): Record<string, unknown> => {
  assert.equal(typeof body, "string", "expected a JSON body");
  return JSON.parse(body as string) as Record<string, unknown>;
};

// ── OpenAI-compatible, which is also how local engines are reached ──
{
  const request = createTTSProvider(
    config({ source: "openai", baseUrl: "http://localhost:8000/v1", model: "tts-1", voice: "alloy" }),
  ).buildSpeechRequest({ text: "Hello.", voice: "alloy" });

  assert.equal(request.url, "http://localhost:8000/v1/audio/speech");
  assert.equal(request.headers["Authorization"], "Bearer secret-key");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.decodeCompressedResponse, false);
  assert.deepEqual(jsonBody(request.body), {
    model: "tts-1",
    input: "Hello.",
    voice: "alloy",
    speed: 1,
    response_format: "mp3",
  });

  // Speech steering is a per-model capability, not a per-source one.
  const steered = createTTSProvider(config({ source: "openai", model: "gpt-4o-mini-tts" })).buildSpeechRequest({
    text: "Hello.",
    voice: "alloy",
    speaker: "Amy",
    tone: "excited",
  });
  const steeredBody = jsonBody(steered.body);
  assert.match(String(steeredBody.instructions), /Voice the line as Amy\./u);
  assert.match(String(steeredBody.instructions), /an excited tone/u, "the article agrees with the tone word");
  assert.equal(jsonBody(request.body).instructions, undefined, "tts-1 takes no instructions");

  // An empty model falls back to the source default rather than sending "".
  const defaulted = createTTSProvider(config({ source: "openai", model: "" })).buildSpeechRequest({
    text: "Hi.",
    voice: "alloy",
  });
  assert.equal(jsonBody(defaulted.body).model, "tts-1");

  // WAV is honoured for sources that do not force a format.
  const wav = createTTSProvider(config({ source: "openai", audioFormat: "wav" })).buildSpeechRequest({
    text: "Hi.",
    voice: "alloy",
  });
  assert.equal(jsonBody(wav.body).response_format, "wav");
}

// ── NanoGPT is a base URL, not a source, and wins over the source ──
{
  // This is the behaviour that already shipped: an ElevenLabs source pointed at
  // nano-gpt.com sends NanoGPT-shaped requests. Dispatching on cfg.source alone
  // would have broken those setups silently.
  const request = createTTSProvider(
    config({ source: "elevenlabs", baseUrl: "https://nano-gpt.com/api/v1", model: "eleven_v3", voice: "Rachel" }),
  ).buildSpeechRequest({ text: "Hello.", voice: "Rachel", tone: "sad" });

  assert.match(
    request.url,
    /^https:\/\/nano-gpt\.com\/api\/v1\/audio\/speech$/u,
    "NanoGPT URL, not the ElevenLabs one",
  );
  assert.equal(request.headers["Authorization"], "Bearer secret-key");
  assert.equal(request.headers["x-api-key"], "secret-key", "NanoGPT wants both auth headers");

  const body = jsonBody(request.body);
  assert.equal(body.model, "Elevenlabs-V3", "the model id is aliased to NanoGPT's spelling");
  assert.equal(body.voice, "Rachel");
  assert.equal(body.speed, undefined, "ElevenLabs-branded models reject a speed parameter");
  assert.equal(body.input, "[sad] Hello.", "tone rides in the text as a bracketed cue");
  // Format forcing keys on the configured source, not the dispatched provider,
  // so a saved WAV preference must not leak into an ElevenLabs-source request.
  const forcedThroughNanoGpt = createTTSProvider(
    config({ source: "elevenlabs", baseUrl: "https://nano-gpt.com/api/v1", audioFormat: "wav" }),
  ).buildSpeechRequest({ text: "Hello.", voice: "Rachel" });
  assert.equal(
    jsonBody(forcedThroughNanoGpt.body).response_format,
    "mp3",
    "an ElevenLabs source is always mp3, even through NanoGPT and even with WAV saved",
  );
  assert.equal(body.response_format, "mp3", "an ElevenLabs source is always mp3, even through NanoGPT");

  // A plain OpenAI model through NanoGPT keeps speed and takes no cue.
  const plain = createTTSProvider(
    config({ source: "openai", baseUrl: "https://nano-gpt.com/api/v1", model: "tts-1" }),
  ).buildSpeechRequest({ text: "Hello.", voice: "alloy", tone: "sad" });
  const plainBody = jsonBody(plain.body);
  assert.equal(plainBody.speed, 1);
  assert.equal(plainBody.input, "Hello.", "a non-ElevenLabs model gets no bracketed cue");
  assert.equal(plainBody.voice, "alloy");

  const noVoice = createTTSProvider(
    config({ source: "openai", baseUrl: "https://nano-gpt.com/api/v1" }),
  ).buildSpeechRequest({ text: "Hello.", voice: "" });
  assert.equal(jsonBody(noVoice.body).voice, "alloy", "NanoGPT needs some voice; alloy is the historical default");
}

// ── NanoGPT as a source of its own ──
{
  // Selecting the source is enough; no nano-gpt.com base URL needed to get
  // NanoGPT-shaped requests.
  const request = createTTSProvider(
    config({ source: "nanogpt", baseUrl: "https://gateway.example.test/v1", model: "gpt-4o-mini-tts" }),
  ).buildSpeechRequest({ text: "Hello.", voice: "nova" });

  assert.equal(request.url, "https://gateway.example.test/v1/audio/speech");
  assert.equal(request.headers["x-api-key"], "secret-key", "NanoGPT wants both auth headers");
  assert.equal(jsonBody(request.body).voice, "nova");

  // Voice vocabulary is per backend, so an empty field cannot resolve to one
  // name: alloy is meaningless to Kokoro and af_bella is meaningless to OpenAI.
  const perFamilyDefaults = [
    ["gpt-4o-mini-tts", "alloy"],
    ["Kokoro-82m", "af_bella"],
    ["Elevenlabs-V3", "Rachel"],
  ] as const;
  for (const [model, expected] of perFamilyDefaults) {
    const blank = createTTSProvider(config({ source: "nanogpt", model })).buildSpeechRequest({
      text: "Hi.",
      voice: "",
    });
    assert.equal(jsonBody(blank.body).voice, expected, `${model}: empty voice falls back within its own family`);
  }

  // ElevenLabs-branded models answer mp3 whatever is asked, and reject speed.
  const elevenThroughNanoGpt = createTTSProvider(
    config({ source: "nanogpt", model: "Elevenlabs-Turbo-V2.5", audioFormat: "wav", speed: 1.5 }),
  ).buildSpeechRequest({ text: "Hello.", voice: "Rachel", tone: "sad" });
  const elevenBody = jsonBody(elevenThroughNanoGpt.body);
  assert.equal(elevenBody.response_format, "mp3", "a saved WAV preference must not reach an ElevenLabs model");
  assert.equal(elevenBody.speed, undefined, "ElevenLabs-branded models reject a speed parameter");
  assert.equal(elevenBody.input, "[sad] Hello.", "tone rides in the text as a bracketed cue");

  // Kokoro is not ElevenLabs-branded, so it keeps speed and the saved format.
  const kokoro = createTTSProvider(
    config({ source: "nanogpt", model: "Kokoro-82m", audioFormat: "wav", speed: 1.25 }),
  ).buildSpeechRequest({ text: "Hello.", voice: "af_bella" });
  const kokoroBody = jsonBody(kokoro.body);
  assert.equal(kokoroBody.speed, 1.25);
  assert.equal(kokoroBody.response_format, "wav");
  assert.equal(kokoroBody.input, "Hello.", "a non-ElevenLabs model gets no bracketed cue");
}

// ── ElevenLabs: voice in the path, gzipped response ──
{
  const request = createTTSProvider(
    config({
      source: "elevenlabs",
      baseUrl: "https://api.elevenlabs.io",
      model: "eleven_multilingual_v2",
      elevenLabsStability: 0.4,
      elevenLabsLanguageCode: "pl",
      speed: 1.1,
    }),
  ).buildSpeechRequest({ text: "Hello.", voice: "voice id/with slash" });

  assert.equal(
    request.url,
    "https://api.elevenlabs.io/v1/text-to-speech/voice%20id%2Fwith%20slash?output_format=mp3_44100_128",
    "the voice is path-encoded",
  );
  assert.equal(request.headers["xi-api-key"], "secret-key");
  assert.equal(request.headers["Authorization"], undefined, "ElevenLabs does not take a bearer token");
  assert.equal(request.decodeCompressedResponse, true, "ElevenLabs answers gzipped");

  const body = jsonBody(request.body);
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal(body.language_code, "pl");
  assert.deepEqual(body.voice_settings, { stability: 0.4, speed: 1.1 });

  // eleven_v3 rejects speed; the alias table also maps the old spelling onto it.
  const v3 = createTTSProvider(config({ source: "elevenlabs", model: "tts_v3" })).buildSpeechRequest({
    text: "Hello.",
    voice: "Rachel",
  });
  const v3Body = jsonBody(v3.body);
  assert.equal(v3Body.model_id, "eleven_v3", "legacy model spellings are aliased");
  assert.deepEqual(v3Body.voice_settings, { stability: 0.5 }, "eleven_v3 takes no speed");

  // Speed is clamped into the range ElevenLabs accepts.
  const fast = createTTSProvider(config({ source: "elevenlabs", speed: 4 })).buildSpeechRequest({
    text: "Hello.",
    voice: "Rachel",
  });
  assert.equal((jsonBody(fast.body).voice_settings as Record<string, number>).speed, 1.2);

  // The format control is ignored: ElevenLabs always returns mp3.
  const forced = createTTSProvider(config({ source: "elevenlabs", audioFormat: "wav" })).buildSpeechRequest({
    text: "Hello.",
    voice: "Rachel",
  });
  assert.match(forced.url, /output_format=mp3_44100_128/u);
}

// ── PocketTTS: two wire formats behind one source ──
{
  const official = createTTSProvider(config({ source: "pockettts", baseUrl: "http://localhost:8000" }), {
    pocketTtsMode: "official",
  }).buildSpeechRequest({ text: "Hello.", voice: "alba" });

  assert.equal(official.url, "http://localhost:8000/tts");
  assert.ok(official.body instanceof FormData, "the official server takes multipart form data");
  assert.deepEqual(Object.fromEntries((official.body as FormData).entries()), {
    text: "Hello.",
    voice_url: "alba",
  });
  assert.equal(official.headers["Content-Type"], undefined, "the boundary must be left to the runtime");

  const wrapper = createTTSProvider(config({ source: "pockettts", baseUrl: "http://localhost:8000" }), {
    pocketTtsMode: "openai",
  }).buildSpeechRequest({ text: "Hello.", voice: "" });

  assert.equal(wrapper.url, "http://localhost:8000/v1/audio/speech");
  assert.equal(jsonBody(wrapper.body).voice, "alba", "the wrapper needs a voice; alba is PocketTTS's default");
  // The schema's model default is "tts-1" for every source, so a saved config
  // carries whatever it carries; only a blank field falls back per source.
  const blankModel = createTTSProvider(config({ source: "pockettts", model: "" }), {
    pocketTtsMode: "openai",
  }).buildSpeechRequest({ text: "Hello.", voice: "alba" });
  assert.equal(jsonBody(blankModel.body).model, "pocket-tts", "a blank model takes the source default");

  // An unprobed config must not accidentally pick the multipart shape.
  const unprobed = createTTSProvider(config({ source: "pockettts" })).buildSpeechRequest({
    text: "Hello.",
    voice: "alba",
  });
  assert.equal(typeof unprobed.body, "string", "without a probe result the OpenAI-compatible shape is assumed");
}

// ── xAI: its own body shape ──
{
  const request = createTTSProvider(
    config({ source: "xai", baseUrl: "https://api.x.ai/v1", speed: 3 }),
  ).buildSpeechRequest({ text: "Hello.", voice: "" });

  assert.equal(request.url, "https://api.x.ai/v1/tts");
  const body = jsonBody(request.body);
  assert.equal(body.voice_id, "eve", "xAI needs a voice id; eve is the default");
  assert.equal(body.language, "auto");
  assert.deepEqual(body.output_format, { codec: "mp3", sample_rate: 44_100, bit_rate: 128_000 });
  assert.equal(body.speed, 1.5, "speed is clamped into xAI's range");
  assert.equal(body.text, "Hello.");

  // xAI always returns mp3, so a saved WAV preference must not reach it.
  const forcedWav = createTTSProvider(config({ source: "xai", audioFormat: "wav" })).buildSpeechRequest({
    text: "Hello.",
    voice: "eve",
  });
  assert.deepEqual(
    jsonBody(forcedWav.body).output_format,
    { codec: "mp3", sample_rate: 44_100, bit_rate: 128_000 },
    "xAI is always mp3 regardless of the saved audio format",
  );
}

// ── Trailing slashes never produce a double slash ──
for (const [source, expected] of [
  ["openai", "https://example.test/v1/audio/speech"],
  ["xai", "https://example.test/v1/tts"],
] as const) {
  const request = createTTSProvider(config({ source, baseUrl: "https://example.test/v1///" })).buildSpeechRequest({
    text: "Hello.",
    voice: "alloy",
  });
  assert.equal(request.url, expected, `${source}: a trailing slash must not survive into the URL`);
}

// ── The NanoGPT catalog: model family drives the voice list ──
{
  const families: Array<[string, string]> = [
    ["gpt-4o-mini-tts", "openai"],
    ["tts-1", "openai"],
    ["tts-1-hd", "openai"],
    ["Kokoro-82m", "kokoro"],
    ["Elevenlabs-Turbo-V2.5", "elevenlabs"],
    ["Elevenlabs-V3", "elevenlabs"],
    ["MiniMax-Speech-02", "other"],
    ["", "other"],
  ];
  for (const [model, expected] of families) {
    assert.equal(nanoGptModelFamily(model), expected, `${model || "(blank)"} belongs to the ${expected} family`);
  }

  // The listing is the only place a NanoGPT user can discover model ids, so a
  // parse that silently drops rows leaves the dropdown looking like the
  // account has no models.
  const parsed = parseNanoGptModelOptions({
    object: "list",
    data: [
      { id: "Kokoro-82m", name: "Kokoro 82M", capabilities: { text_to_speech: true } },
      { id: "tts-1" },
      { id: "whisper-1", capabilities: { text_to_speech: false, speech_to_text: true } },
      { id: "  " },
      { id: "tts-1" },
      "not-an-object",
    ],
  });
  assert.deepEqual(
    parsed,
    [
      // Claims to speak, so it is speech whatever else the row says.
      { id: "Kokoro-82m", name: "Kokoro 82M", lane: "speech", voices: [] },
      // Claims nothing at all, and an unclassified row is not offered as a voice.
      { id: "tts-1", name: "tts-1", lane: "other", voices: [] },
    ],
    "keeps TTS rows in order, names and classifies them, and drops STT/blank/duplicate/malformed rows",
  );
  assert.deepEqual(parseNanoGptModelOptions({}), [], "a listing with no data array yields no models, not a throw");
  assert.deepEqual(parseNanoGptModelOptions(null), [], "a null payload yields no models, not a throw");

  // Every fallback id must resolve to a family that has voices, or a user who
  // picks it from the seeded dropdown gets an empty voice list.
  for (const id of NANOGPT_FALLBACK_TTS_MODELS) {
    assert.notEqual(nanoGptModelFamily(id), "other", `${id}: a seeded model must map to a known voice family`);
  }
}

// ── A model's published voices outrank anything guessed from its id ──
// NanoGPT carries each model's vocabulary in supported_parameters.voices and
// answers /audio-models without a key. Guessing instead is how a Gemini model
// came to offer alloy and coral: it matches no known prefix, and the family
// fallback handed back OpenAI's list as though it were authoritative.
{
  const listing = {
    object: "list",
    data: [
      {
        id: "gemini-3.1-flash-tts-preview",
        name: "Gemini 3.1 Flash TTS Preview",
        capabilities: { text_to_speech: true },
        supported_parameters: { voices: ["Zephyr", "Puck", "Kore", "Zephyr", "  ", 7, null] },
      },
      { id: "tts-1", supported_parameters: { voices: ["alloy", "ash"] } },
      { id: "Kokoro-82m", supported_parameters: {} },
    ],
  };
  const models = parseNanoGptModelOptions(listing);

  assert.deepEqual(
    models[0]?.voices,
    ["Zephyr", "Puck", "Kore"],
    "published voices are read, deduped, and stripped of blank and non-string entries",
  );
  assert.deepEqual(models[2]?.voices, [], "a row that publishes none reports none rather than inventing them");

  assert.deepEqual(
    nanoGptVoicesForModel(models, "Gemini-3.1-Flash-TTS-Preview"),
    ["Zephyr", "Puck", "Kore"],
    "the lookup matches the id regardless of case, since the dropdown and the saved value can differ",
  );
  assert.deepEqual(
    nanoGptVoicesForModel(models, "some-model-typed-by-hand"),
    [],
    "a model the listing does not describe yields nothing, never another backend's voices",
  );

  // The regression that started this: the id belongs to no known family, so any
  // id-derived answer is a guess. It must not be OpenAI's list.
  assert.equal(nanoGptModelFamily("gemini-3.1-flash-tts-preview"), "other", "Gemini matches no known prefix");
  const guessed = nanoGptVoicesForModel(models, "gemini-3.1-flash-tts-preview");
  assert.ok(!guessed.includes("alloy") && !guessed.includes("coral"), "Gemini must never be offered OpenAI voices");
}

console.info("TTS provider registry regression passed.");
