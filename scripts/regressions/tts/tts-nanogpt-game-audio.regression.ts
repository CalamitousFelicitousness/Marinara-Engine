// NanoGPT generates sound effects and music through a job, not a response body.
//
// The shapes below are the ones the live API actually returned on 2026-08-29,
// not the ones its docs describe. Three of them are why this lane exists: run
// ids are a UUID for one model and 32 bare hex for another, the audio host
// differs per run, and a sound-effect status carries audioUrls[] beside
// audioUrl. Pinning any of those would have shipped a parser that works for
// music and fails for sound effects.
//
// The builder does no I/O and the resolver takes its `send`, so none of this
// needs a server.

import assert from "node:assert/strict";
import {
  buildNanoGptGameAudioRequest,
  NANOGPT_CONTEXT_MUSIC_DURATION_S,
} from "../../../packages/server/src/services/tts/nanogpt-game-audio.ts";
import { buildGameAudioRequest } from "../../../packages/server/src/services/tts/game-audio-request.ts";
import {
  isJobResponse,
  resolveTTSJobAudio,
  TTSJobError,
} from "../../../packages/server/src/services/tts/job-resolution.ts";
import { TTSConfigurationError, type TTSProviderRequest } from "../../../packages/server/src/services/tts/tts-types.ts";
import { ttsConfigSchema, type TTSConfig } from "../../../packages/shared/src/types/tts.js";

const config = (overrides: Partial<TTSConfig> = {}): TTSConfig =>
  ttsConfigSchema.parse({
    enabled: true,
    source: "nanogpt",
    apiKey: "secret-key",
    baseUrl: "https://nano-gpt.com/api/v1",
    ...overrides,
  });

const withModel = (purpose: "music" | "sfx", model: string, extra: Record<string, unknown> = {}) =>
  config({ audioParameters: { [purpose]: { model, ...extra } } });

const bodyOf = (request: TTSProviderRequest) => JSON.parse(String(request.body)) as Record<string, unknown>;

// ── The submission ──
{
  const request = buildNanoGptGameAudioRequest(withModel("music", "ACE-Step-v1.5-Base"), {
    kind: "music",
    prompt: "a slow lament",
  });
  assert.equal(request.url, "https://nano-gpt.com/api/v1/audio/speech", "music submits to the speech endpoint");
  assert.equal(request.headers.Authorization, "Bearer secret-key", "the submission authenticates with a bearer key");
  const body = bodyOf(request);
  assert.equal(body.model, "ACE-Step-v1.5-Base", "the model comes from the lane's parameters");
  assert.equal(body.input, "a slow lament", "the prompt is the content key `input`, not ElevenLabs' `prompt`");
  assert.equal(
    body.duration,
    NANOGPT_CONTEXT_MUSIC_DURATION_S,
    "an unlengthed track takes the context default, in seconds",
  );
  assert.ok(request.job, "a music submission may answer with a job");

  const scened = bodyOf(
    buildNanoGptGameAudioRequest(withModel("music", "m"), { kind: "music", prompt: "p", lengthMs: 45_000 }),
  );
  assert.equal(scened.duration, 45, "the scene's milliseconds become NanoGPT's seconds");
}

// ── Sound effects are a model, not a route ──
{
  const request = buildNanoGptGameAudioRequest(withModel("sfx", "mirelo-ai/sfx1.6/text-to-audio"), {
    kind: "sfx",
    prompt: "a door creak",
  });
  assert.equal(request.url, "https://nano-gpt.com/api/v1/audio/speech", "sfx submits to the same endpoint as music");
  const body = bodyOf(request);
  assert.equal(body.model, "mirelo-ai/sfx1.6/text-to-audio", "the sfx lane names its own model");
  assert.equal(body.duration, undefined, "a sound effect takes no scene length");
}

// ── The lane cannot run without a model ──
{
  assert.throws(
    () => buildNanoGptGameAudioRequest(config(), { kind: "music", prompt: "p" }),
    (error: unknown) => error instanceof TTSConfigurationError && /no music model set/iu.test((error as Error).message),
    "an unset model is a configuration error, never a guessed vendor id",
  );
}

// ── A parameter may not replace the prompt ──
{
  const request = buildNanoGptGameAudioRequest(withModel("music", "m", { input: "hijacked", duration: 12 }), {
    kind: "music",
    prompt: "the real prompt",
  });
  const body = bodyOf(request);
  assert.equal(body.input, "the real prompt", "the content key survives a parameter of the same name");
  assert.equal(body.duration, 12, "but a pinned duration still overrides the scene");
}

// ── Dispatch agrees with the capability table ──
{
  const nano = buildGameAudioRequest(withModel("sfx", "m"), { kind: "sfx", prompt: "p" });
  assert.ok(String(nano.url).includes("nano-gpt.com"), "a nanogpt config builds the nanogpt request");
  assert.throws(
    () => buildGameAudioRequest(config({ source: "openai" }), { kind: "music", prompt: "p" }),
    (error: unknown) => error instanceof TTSConfigurationError,
    "a source with no generator is refused rather than sent somewhere wrong",
  );
}

// ── Telling a job from audio ──
{
  const json = new Response("{}", { headers: { "content-type": "application/json" } });
  const audio = new Response("x", { headers: { "content-type": "audio/mpeg" } });
  assert.equal(isJobResponse(json), true, "JSON means a job");
  assert.equal(isJobResponse(audio), false, "audio bytes are never parsed as a job");
}

// ── Resolving a job, on both shapes the API really returned ──
{
  const jsonResponse = (payload: unknown) =>
    new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });

  const run = async (submitted: unknown, polls: unknown[]) => {
    const sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    let index = 0;
    const send = async (request: TTSProviderRequest, method: "GET" | "POST") => {
      sent.push({ url: request.url, method, headers: request.headers });
      if (request.url.includes("/api/tts/status")) return jsonResponse(polls[index++]);
      return new Response("audio-bytes", { headers: { "content-type": "audio/mpeg" } });
    };
    const request = buildNanoGptGameAudioRequest(withModel("music", "ACE-Step-v1.5-Base"), {
      kind: "music",
      prompt: "p",
    });
    const final = await resolveTTSJobAudio(jsonResponse(submitted), request.job!, send, {
      signal: AbortSignal.timeout(10_000),
      label: "nanogpt",
      sleep: async () => {},
    });
    return { final, sent };
  };

  // Music: a dashed UUID and a bare audioUrl on a runware host.
  const music = await run({ status: "pending", runId: "d8e4449d-c3bb-4e91-9a0f-95bc10c5a752" }, [
    { status: "completed", audioUrl: "https://am.runware.ai/audio/os/x.mp3", contentType: "audio/mpeg" },
  ]);
  assert.equal(await music.final.text(), "audio-bytes", "the finished audio is what comes back");
  const poll = music.sent.find((entry) => entry.url.includes("/api/tts/status"));
  assert.ok(poll, "the job is polled");
  assert.equal(poll?.method, "GET", "the status check is a GET");
  assert.equal(poll?.headers["x-api-key"], "secret-key", "the status endpoint authenticates differently");
  assert.ok(
    poll?.url.includes("runId=d8e4449d-c3bb-4e91-9a0f-95bc10c5a752") && poll.url.includes("model=ACE-Step-v1.5-Base"),
    "the poll carries both the run id and the model",
  );
  assert.ok(
    music.sent.some((entry) => entry.url === "https://am.runware.ai/audio/os/x.mp3"),
    "the audio is fetched from the host the job named, which is not the API host",
  );

  // Sound effects: 32 bare hex, a CloudFront host, and audioUrls[] alongside.
  const sfx = await run({ status: "pending", runId: "34c7245230074d968b925f52579892d2" }, [
    {
      status: "completed",
      audioUrl: "https://d2h7xmz5gqybh9.cloudfront.net/predictions/34c7/1.mp3",
      audioUrls: ["https://d2h7xmz5gqybh9.cloudfront.net/predictions/34c7/1.mp3"],
    },
  ]);
  assert.equal(await sfx.final.text(), "audio-bytes", "an undashed run id resolves the same way");

  // audioUrls[] alone must still resolve: only one of the two shapes carried both.
  const arrayOnly = await run({ runId: "abc" }, [
    { status: "completed", audioUrls: ["https://cdn.example.com/only.mp3"] },
  ]);
  assert.equal(await arrayOnly.final.text(), "audio-bytes", "audioUrls alone is enough");

  // Three storage hosts have been observed across three models, and a completed
  // body may carry fields the resolver does not read. Neither may matter.
  const thirdHost = await run({ runId: "abc" }, [
    { status: "completed", audioUrl: "https://v3b.fal.media/files/b/x.mp3", terminal: true },
  ]);
  assert.ok(
    thirdHost.sent.some((entry) => entry.url === "https://v3b.fal.media/files/b/x.mp3"),
    "a host never seen before still serves the audio, and an unknown field is ignored",
  );

  // Pending polls repeat rather than failing.
  const waited = await run({ runId: "abc" }, [
    { status: "pending", queuePosition: 3 },
    { status: "pending", queuePosition: 1 },
    { status: "completed", audioUrl: "https://cdn.example.com/late.mp3" },
  ]);
  assert.equal(
    waited.sent.filter((entry) => entry.url.includes("/api/tts/status")).length,
    3,
    "a queued job is polled until it finishes",
  );
}

// ── A failed job stops rather than polling forever ──
{
  const send = async (request: TTSProviderRequest) =>
    new Response(JSON.stringify({ status: "failed", error: "model unavailable" }), {
      headers: { "content-type": "application/json" },
    });
  const request = buildNanoGptGameAudioRequest(withModel("music", "m"), { kind: "music", prompt: "p" });
  await assert.rejects(
    () =>
      resolveTTSJobAudio(
        new Response(JSON.stringify({ runId: "abc" }), { headers: { "content-type": "application/json" } }),
        request.job!,
        send,
        { signal: AbortSignal.timeout(10_000), label: "nanogpt", sleep: async () => {} },
      ),
    (error: unknown) => error instanceof TTSJobError && /model unavailable/u.test((error as Error).message),
    "a failed job surfaces the provider's own reason",
  );
}

console.info("NanoGPT game audio regression passed.");
