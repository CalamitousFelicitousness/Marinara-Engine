// ──────────────────────────────────────────────
// Regression: text and media take turns on a shared GPU host
// ──────────────────────────────────────────────
// With llama-swap swapping one GPU between a local LLM and ComfyUI, a media request queued while
// text was in flight and every new text request went past it; pictures waited for minutes and
// were lost. Pinned here: a waiting media request holds back new text, the running kind drains
// before the other starts, waiters of one kind start together, an abort while waiting lets the
// queue move on, nested calls run straight through, a stream holds its turn until it closes,
// throws release the turn, and unlisted hosts are untouched.
import assert from "node:assert/strict";

process.env.MARINARA_SHARED_GPU_HOSTS = "Phoenix:8081, localhost:9000";
const { runSharedGpuTurn, sharedGpuHostFor, withSharedGpuTurnProvider, inspectSharedGpuTurnsForTests } =
  await import("../../packages/server/src/services/generation/shared-gpu-turns.js");
const { BaseLLMProvider } = await import("../../packages/server/src/services/llm/base-provider.js");

const GPU = "http://phoenix:8081/upstream/comfyui_auto";
const LLM = "http://phoenix:8081/v1";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const idle = () => assert.deepEqual(inspectSharedGpuTurnsForTests(), {});

async function main() {
  // ── 1) Hosts match on host:port, case-insensitively; unlisted hosts run untouched ──
  assert.equal(sharedGpuHostFor(LLM), "phoenix:8081");
  assert.equal(sharedGpuHostFor("http://localhost:9000"), "localhost:9000");
  assert.equal(sharedGpuHostFor("http://phoenix:8082/v1"), null);
  assert.equal(sharedGpuHostFor("https://api.openai.com/v1"), null);
  assert.equal(await runSharedGpuTurn("media", "https://api.openai.com/v1", async () => "ran"), "ran");
  idle();

  // ── 2) A waiting media request holds back new text; the running text drains first ──
  const order: string[] = [];
  const text1 = deferred();
  const media = deferred();
  const t1 = runSharedGpuTurn("text", LLM, async () => {
    order.push("text1 start");
    await text1.promise;
    order.push("text1 end");
  });
  await tick();
  const m = runSharedGpuTurn("media", GPU, async () => {
    order.push("media start");
    await media.promise;
    order.push("media end");
  });
  await tick();
  const t2 = runSharedGpuTurn("text", LLM, async () => {
    order.push("text2 start");
  });
  await tick();
  assert.deepEqual(order, ["text1 start"], "media and the later text both wait while text1 runs");
  text1.resolve();
  await tick();
  assert.deepEqual(order, ["text1 start", "text1 end", "media start"], "media goes before the text that came after it");
  media.resolve();
  await Promise.all([t1, m, t2]);
  assert.deepEqual(order, ["text1 start", "text1 end", "media start", "media end", "text2 start"]);
  idle();

  // ── 3) Requests of one kind run together ──
  let running = 0;
  let peak = 0;
  const gate = deferred();
  const together = [1, 2, 3].map(() =>
    runSharedGpuTurn("media", GPU, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    }),
  );
  await tick();
  assert.equal(peak, 3);
  gate.resolve();
  await Promise.all(together);
  idle();

  // ── 4) Aborting a waiting media request lets text that queued behind it start ──
  const holdText = deferred();
  const firstText = runSharedGpuTurn("text", LLM, () => holdText.promise);
  await tick();
  const abort = new AbortController();
  const abortedMedia = runSharedGpuTurn(
    "media",
    GPU,
    async () => assert.fail("aborted media must not run"),
    abort.signal,
  );
  let lateTextRan = false;
  const lateText = runSharedGpuTurn("text", LLM, async () => {
    lateTextRan = true;
  });
  await tick();
  assert.equal(lateTextRan, false, "late text waits behind the waiting media");
  abort.abort(new Error("stop"));
  await assert.rejects(abortedMedia, /stop/);
  await lateText;
  assert.equal(lateTextRan, true, "late text joins once the media waiter is gone");
  holdText.resolve();
  await firstText;
  idle();

  // ── 5) A nested call inside a held turn runs straight through instead of waiting on itself ──
  const nested = await runSharedGpuTurn("media", GPU, () => runSharedGpuTurn("text", LLM, async () => "nested"));
  assert.equal(nested, "nested");
  idle();

  // ── 6) A throw releases the turn ──
  await assert.rejects(
    runSharedGpuTurn("media", GPU, async () => {
      throw new Error("render failed");
    }),
    /render failed/,
  );
  idle();

  // ── 7) The provider wrapper holds a stream's turn until the stream closes, even when cut short ──
  const streamGate = deferred();
  class FakeProvider extends BaseLLMProvider {
    async *chat() {
      yield "a";
      await streamGate.promise;
      yield "b";
    }
  }
  const unlisted = new FakeProvider("https://api.example.com/v1", "");
  assert.equal(
    withSharedGpuTurnProvider(unlisted, "https://api.example.com/v1"),
    unlisted,
    "unlisted hosts are not wrapped",
  );
  const provider = withSharedGpuTurnProvider(new FakeProvider(LLM, ""), LLM);
  const stream = provider.chat([], { model: "m" });
  assert.deepEqual(await stream.next(), { value: "a", done: false });
  let mediaRan = false;
  const waitingMedia = runSharedGpuTurn("media", GPU, async () => {
    mediaRan = true;
  });
  await tick();
  assert.equal(mediaRan, false, "media waits while the stream is open");
  await stream.return(undefined);
  await waitingMedia;
  assert.equal(mediaRan, true, "closing the stream early releases its turn");
  streamGate.resolve();
  const completion = await provider.chatComplete([], { model: "m" });
  assert.equal(completion.content, "ab");
  idle();

  // ── 8) A media request waits no longer than MARINARA_MEDIA_GENERATION_WAIT_TIMEOUT_MS, and text queued behind it
  // then goes ahead ──
  process.env.MARINARA_MEDIA_GENERATION_WAIT_TIMEOUT_MS = "300";
  const stalled = deferred();
  const stalledText = runSharedGpuTurn("text", LLM, () => stalled.promise);
  await tick();
  // Checked from the start, so a slow tick can only make the wait end sooner, never unobserved.
  const timedOut = assert.rejects(
    runSharedGpuTurn("media", GPU, async () => "never"),
    /Waited over 0 seconds for the shared GPU/u,
    "the media wait has a deadline",
  );
  await tick();
  let queuedTextRan = false;
  const queuedText = runSharedGpuTurn("text", LLM, async () => {
    queuedTextRan = true;
  });
  await tick();
  assert.equal(queuedTextRan, false, "new text waits behind the waiting media request");
  // AbortSignal.timeout doesn't keep the process alive (a server always is), so hold it open across the wait.
  const keepAlive = setTimeout(() => undefined, 5_000);
  await timedOut;
  clearTimeout(keepAlive);
  await queuedText;
  assert.equal(queuedTextRan, true, "text queued behind the timed-out media request goes ahead");
  stalled.resolve();
  await stalledText;
  delete process.env.MARINARA_MEDIA_GENERATION_WAIT_TIMEOUT_MS;
  idle();

  console.log("shared-gpu-turns regression passed");
}

await main();
