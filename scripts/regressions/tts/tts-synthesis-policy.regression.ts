// One synthesis request retries what is worth retrying, gives up on a deadline,
// and never retries a request the engine already refused on its merits.
//
// The chat path had no retries: a single transient 502 ended the whole
// sequence, while the game path had shipped two attempts with backoff for
// months. It also had no deadline of its own, so a socket that accepted the
// connection and never answered left the UI in "loading" until the server gave
// up. Failures were classified by matching English prose.
//
// Defaults stay inert: with no policy passed, the engine behaves exactly as it
// did, which is what keeps the upstream tts-source-persistence assertions true.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PASSTHROUGH_TTS_SYNTHESIS_POLICY,
  TTSSynthesisError,
  TTS_CLIENT_TIMEOUT_GRACE_MS,
  TTS_RETRY_BASE_DELAY_MS,
  isRetryableTTSFailure,
  resolveTTSSynthesisPolicy,
  runWithTTSSynthesisPolicy,
  ttsFailureKindFromResponse,
} from "../../../packages/client/src/lib/tts-synthesis-policy.ts";
import { ttsService } from "../../../packages/client/src/lib/tts-service.ts";
import { buildTTSVoiceRequests, cleanTTSInputText } from "../../../packages/client/src/lib/tts-dialogue.ts";
import {
  TTS_CHUNK_CHARS_MAX,
  TTS_TIMEOUT_MS_DEFAULT,
  ttsConfigSchema,
} from "../../../packages/shared/src/types/tts.js";

// ── Classification comes from the server's code, not its prose ──
assert.equal(ttsFailureKindFromResponse("timeout"), "timeout");
assert.equal(ttsFailureKindFromResponse("unreachable"), "unreachable");
assert.equal(ttsFailureKindFromResponse("provider_error"), "provider");
assert.equal(ttsFailureKindFromResponse(undefined), "provider", "an unlabelled failure is still a provider failure");

// An aborted synthesis has to keep answering to the engine's AbortError checks,
// which are what tell a user stop apart from a real failure.
assert.equal(new TTSSynthesisError("stopped", "aborted").name, "AbortError");
assert.equal(new TTSSynthesisError("boom", "timeout").name, "TTSSynthesisError");

// ── What is worth another attempt ──
assert.equal(isRetryableTTSFailure(new TTSSynthesisError("slow", "timeout")), true);
assert.equal(isRetryableTTSFailure(new TTSSynthesisError("down", "unreachable")), true);
assert.equal(isRetryableTTSFailure(new TTSSynthesisError("busy", "provider", 503)), true);
assert.equal(
  isRetryableTTSFailure(new TTSSynthesisError("bad key", "provider", 401)),
  false,
  "a rejected request repeats identically; retrying only multiplies the wait before the user is told",
);
assert.equal(isRetryableTTSFailure(new TTSSynthesisError("stopped", "aborted")), false);
assert.equal(isRetryableTTSFailure(new TypeError("network down")), true, "a bare network error is worth one more try");

// ── The client waits the server's budget plus grace, never less ──
const derived = resolveTTSSynthesisPolicy({ timeoutMs: 300_000, maxRetries: 2 });
assert.equal(
  derived.requestTimeoutMs,
  300_000 + TTS_CLIENT_TIMEOUT_GRACE_MS,
  "the server owns the deadline; the client only backstops a socket that never answers",
);
assert.equal(derived.maxRetries, 2);
assert.equal(resolveTTSSynthesisPolicy(null).requestTimeoutMs, 0, "no config means no client deadline");
assert.equal(resolveTTSSynthesisPolicy(null).maxRetries, 0);
assert.equal(PASSTHROUGH_TTS_SYNTHESIS_POLICY.maxRetries, 0, "the engine default must not change behaviour");
assert.ok(
  resolveTTSSynthesisPolicy({}).requestTimeoutMs > TTS_TIMEOUT_MS_DEFAULT,
  "an absent timeout takes the default",
);

// ── Retry behaviour ──
let attempts = 0;
const recovered = await runWithTTSSynthesisPolicy(
  async () => {
    attempts += 1;
    if (attempts < 3) throw new TTSSynthesisError("flaky", "unreachable");
    return "audio";
  },
  { requestTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 },
);
assert.equal(recovered, "audio", "a transient failure recovers within the retry budget");
assert.equal(attempts, 3, "exactly maxRetries extra attempts");

attempts = 0;
await assert.rejects(
  runWithTTSSynthesisPolicy(
    async () => {
      attempts += 1;
      throw new TTSSynthesisError("bad key", "provider", 401);
    },
    { requestTimeoutMs: 0, maxRetries: 3, retryBaseDelayMs: 1 },
  ),
  /bad key/u,
);
assert.equal(attempts, 1, "a 4xx is not retried at all");

// Backoff grows with the attempt, matching the game path's existing curve.
attempts = 0;
const backoffStart = Date.now();
await assert.rejects(
  runWithTTSSynthesisPolicy(
    async () => {
      attempts += 1;
      throw new TTSSynthesisError("still down", "unreachable");
    },
    { requestTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 20 },
  ),
  /still down/u,
);
assert.equal(attempts, 3);
assert.ok(Date.now() - backoffStart >= 20 + 40 - 5, "waits base*1 then base*2 between attempts");
assert.equal(TTS_RETRY_BASE_DELAY_MS, 350, "the shared curve is the one the game path already used");

// ── The deadline fires and is reported as a timeout ──
const timeoutStart = Date.now();
await assert.rejects(
  runWithTTSSynthesisPolicy(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    { requestTimeoutMs: 60, maxRetries: 0, retryBaseDelayMs: 1 },
  ),
  (error: unknown) => {
    assert.ok(error instanceof TTSSynthesisError, "a deadline produces a classified failure");
    assert.equal(error.kind, "timeout", "not an opaque abort");
    return true;
  },
);
assert.ok(Date.now() - timeoutStart < 3_000, "the deadline is the deadline");

// ── A caller abort wins over the deadline and is never retried ──
const outer = new AbortController();
let abortAttempts = 0;
setTimeout(() => outer.abort(), 30);
await assert.rejects(
  runWithTTSSynthesisPolicy(
    async (signal) => {
      abortAttempts += 1;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
    { requestTimeoutMs: 5_000, maxRetries: 3, retryBaseDelayMs: 5 },
    outer.signal,
  ),
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
assert.equal(abortAttempts, 1, "stopping playback must not kick off further attempts");

// With no deadline the caller's own signal is handed through untouched, so the
// engine's abort bookkeeping keeps working exactly as it did.
const passthrough = new AbortController();
let sawSignal: AbortSignal | null = null;
void runWithTTSSynthesisPolicy(
  async (signal) => {
    sawSignal = signal;
    return "ok";
  },
  PASSTHROUGH_TTS_SYNTHESIS_POLICY,
  passthrough.signal,
).catch(() => null);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(sawSignal, passthrough.signal, "no deadline means no extra signal wrapping");

// ── Text preparation ──
// Chunk size is a setting now, not a module constant, and it is clamped to what
// /speak will actually accept so a legal setting cannot become a 400.
{
  const paragraph = `${"Sentence one is here. ".repeat(40)}`;
  const wide = ttsConfigSchema.parse({ chunkCharLimit: 900 });
  const narrow = ttsConfigSchema.parse({ chunkCharLimit: 200 });
  const wideChunks = buildTTSVoiceRequests(paragraph, wide);
  const narrowChunks = buildTTSVoiceRequests(paragraph, narrow);
  assert.ok(narrowChunks.length > wideChunks.length, "a smaller chunk setting must produce more, smaller requests");
  for (const request of narrowChunks) {
    assert.ok(request.text.length <= 200, `chunk of ${request.text.length} exceeded the configured 200`);
  }
  for (const request of wideChunks) {
    assert.ok(request.text.length <= TTS_CHUNK_CHARS_MAX, "no chunk may exceed what /speak accepts");
  }
  // Words survive the split; a chunker that cuts mid-word makes the engine
  // pronounce fragments.
  assert.ok(
    narrowChunks.every((request) => !/\s$/u.test(request.text) && request.text.trim() === request.text),
    "chunks are trimmed rather than cut on whitespace",
  );

  // Emoji are stripped, but a keycap's base character is spoken text.
  assert.equal(cleanTTSInputText("Hello 👋🏽 there 👨‍👩‍👧 friend 🇯🇵"), "Hello there friend");
  assert.equal(cleanTTSInputText("Press 1️⃣ then #️⃣"), "Press 1 then #");
  assert.equal(cleanTTSInputText("No emoji here."), "No emoji here.", "ordinary text is untouched");
  assert.equal(
    buildTTSVoiceRequests("😀😀😀", ttsConfigSchema.parse({})).length,
    0,
    "an emoji-only message produces no requests, which disables the speak button rather than sending junk",
  );

  // The opening chunk is split small so playback starts while the rest renders,
  // and only when clips are played as they arrive.
  const longOpener = `${"Opening line is short. "}${"Then a much longer continuation follows. ".repeat(30)}`;
  const config = ttsConfigSchema.parse({});
  const plain = buildTTSVoiceRequests(longOpener, config);
  const fast = buildTTSVoiceRequests(longOpener, config, undefined, undefined, undefined, { fastFirstChunk: true });
  assert.ok(fast[0]!.text.length < plain[0]!.text.length, "the fast opener is shorter than the normal first chunk");
  assert.ok(fast[0]!.text.length <= 220, "the opener stays inside the fast-start window");
  assert.equal(plain.length + 1, fast.length, "the split adds exactly one request and drops no text");
  assert.equal(
    fast.map((request) => request.text).join(" "),
    plain.map((request) => request.text).join(" "),
    "splitting the opener must not lose or reorder a single word",
  );

  // Pause placement keys on the last chunk of an utterance, so the opener split
  // has to happen before it, not after.
  const paused = ttsConfigSchema.parse({ dialogueOnly: true, dialoguePauseMs: 2000 });
  const dialogue = buildTTSVoiceRequests(
    `"${"First speaker says a fairly long opening line here. ".repeat(6)}"\n"And the second speaker answers."`,
    paused,
    undefined,
    undefined,
    undefined,
    { fastFirstChunk: true },
  );
  const pauseIndexes = dialogue.map((request, index) => (request.pauseAfterMs ? index : -1)).filter((i) => i >= 0);
  for (const index of pauseIndexes) {
    assert.ok(index < dialogue.length - 1, "a pause never lands on the very last request");
  }
}

// ── The engine keeps its lookahead inside the configured bound ──
const originalFetch = globalThis.fetch;
const originalAudioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Audio");

class RegressionAudio {
  volume = 1;
  muted = false;
  paused = false;
  ended = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {}
  play(): Promise<void> {
    setTimeout(() => this.onended?.(), 0);
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

let live = 0;
let peak = 0;
function countingFetch() {
  return async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 15));
    live -= 1;
    return new Response(new Blob(["audio"]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
}

try {
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: RegressionAudio });
  const chunks = [{ text: "One." }, { text: "Two." }, { text: "Three." }, { text: "Four." }];

  globalThis.fetch = countingFetch();
  await ttsService.speakSequence(chunks, "tts-lookahead-serial", { progressive: true });
  assert.equal(peak, 1, "the default lookahead must keep a single-worker engine serial");

  live = 0;
  peak = 0;
  globalThis.fetch = countingFetch();
  await ttsService.speakSequence(chunks, "tts-lookahead-parallel", { progressive: true, concurrency: 3 });
  assert.ok(peak > 1, "a raised lookahead must actually overlap requests");
  assert.ok(peak <= 3, `the lookahead is a ceiling, not a suggestion (saw ${peak})`);

  // ── Retries reach real synthesis, and a 4xx still stops the sequence ──
  let speakAttempts = 0;
  globalThis.fetch = async () => {
    speakAttempts += 1;
    if (speakAttempts === 1) {
      return new Response(JSON.stringify({ error: "engine busy", code: "provider_error" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(new Blob(["audio"]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  await ttsService.speakSequence([{ text: "Recovers." }], "tts-retry-success", {
    progressive: true,
    policy: { requestTimeoutMs: 0, maxRetries: 1, retryBaseDelayMs: 1 },
  });
  assert.equal(speakAttempts, 2, "a transient 503 is retried rather than ending the sequence");
  assert.equal(ttsService.getState(), "idle", "the sequence completes after the retry");

  speakAttempts = 0;
  globalThis.fetch = async () => {
    speakAttempts += 1;
    return new Response(JSON.stringify({ error: "bad key", code: "provider_error" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
  await ttsService.speakSequence([{ text: "Refused." }], "tts-retry-refused", {
    progressive: true,
    policy: { requestTimeoutMs: 0, maxRetries: 3, retryBaseDelayMs: 1 },
  });
  assert.equal(speakAttempts, 1, "a refused request is not retried");
  assert.equal(ttsService.getState(), "error");
  assert.ok((ttsService.getConsecutiveFailureCount() ?? 0) > 0, "a failed sequence is counted for the breaker");

  // A clip that actually plays proves the engine is alive again.
  globalThis.fetch = countingFetch();
  await ttsService.speakSequence([{ text: "Alive." }], "tts-breaker-reset", { progressive: true });
  assert.equal(ttsService.getConsecutiveFailureCount(), 0, "successful playback clears the breaker");
} finally {
  ttsService.stop();
  globalThis.fetch = originalFetch;
  if (originalAudioDescriptor) Object.defineProperty(globalThis, "Audio", originalAudioDescriptor);
  else Reflect.deleteProperty(globalThis, "Audio");
}

// ── Every surface synthesizes through the one engine ──
// Game narration and combat each carried their own cache lookup, retry loop,
// and abort wrapper. Narration's had the retry curve and the #2647 fixes; chat
// had neither, because a fix applied to one copy reached none of the others.
{
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const read = (relative: string) => readFileSync(join(repositoryRoot, relative), "utf8");

  for (const relative of [
    "packages/client/src/components/game/GameNarration.tsx",
    "packages/client/src/components/game/GameCombatUI.tsx",
  ]) {
    const source = read(relative);
    const file = relative.split("/").pop();
    assert.match(source, /ttsService\.synthesize\(/u, `${file} must synthesize through the shared engine`);
    assert.doesNotMatch(
      source,
      /getOrCreateCachedTTSAudioBlob\(/u,
      `${file} must not reach past the engine into the blob cache`,
    );
    assert.doesNotMatch(source, /ttsService\.generateAudio\(/u, `${file} must not call the raw generator`);
  }

  // The private retry and abort helpers are gone rather than merely unused.
  const narration = read("packages/client/src/components/game/GameNarration.tsx");
  for (const helper of ["waitForGameTTSBlob", "waitForGameTTSRetry", "GAME_TTS_CHUNK_ATTEMPTS"]) {
    assert.doesNotMatch(narration, new RegExp(helper, "u"), `${helper} is superseded by the shared policy`);
  }
}

console.info("TTS synthesis policy regression passed.");
