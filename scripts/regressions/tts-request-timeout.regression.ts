import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
import { TTS_SETTINGS_KEY, TTS_TIMEOUT_MS_DEFAULT } from "../../packages/shared/src/types/tts.js";
import { ttsRoutes } from "../../packages/server/src/routes/tts.routes.js";

// #7711: a slow voice server needs a speech request limit above undici's own 300 s reply cap.

// Real timers, 200 times faster: 60 s waits 300 ms and 300 s waits 1.5 s. The voice server answers after 800 ms,
// so it is too slow for the default and in time for 300 s. Every limit asked for is recorded as given.
const requestedTimeouts: number[] = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  requestedTimeouts.push(ms);
  return realTimeout(ms / 200);
};
// undici stops waiting for a reply after its own 300 s unless the request says otherwise, so a limit above
// that was cut off and reported as an unreachable server. Here that cap is 500 ms, shorter than the voice server.
const { Agent, getGlobalDispatcher, setGlobalDispatcher } = requireServer("undici");
const previousDispatcher = getGlobalDispatcher();
const shortTransport = new Agent({ headersTimeout: 500, bodyTimeout: 500 });
setGlobalDispatcher(shortTransport);

process.env.TTS_LOCAL_URLS_ENABLED = "true";
const provider = createServer(async (request, response) => {
  for await (const _chunk of request);
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "audio/mpeg" });
  response.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
});
provider.on("clientError", () => {});
let app: ReturnType<typeof Fastify> | undefined;
try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const isolatedData = mkdtempSync(join(tmpdir(), "marinara-tts-timeout-"));
  process.env.DATA_DIR = isolatedData;
  process.env.FILE_STORAGE_DIR = join(isolatedData, "storage");
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createAppSettingsStorage } =
    await import("../../packages/server/src/services/storage/app-settings.storage.js");
  const db = await createFileNativeDB();
  const settings = createAppSettingsStorage(db);
  const saveSettings = (extra: Record<string, unknown> = {}) =>
    settings.set(
      TTS_SETTINGS_KEY,
      JSON.stringify({
        enabled: true,
        source: "openai",
        apiKey: "",
        baseUrl,
        model: "tts-1",
        voice: "alloy",
        ...extra,
      }),
    );

  app = Fastify();
  app.decorate("db", db);
  await app.register(ttsRoutes, { prefix: "/api/tts" });
  const speak = async () => {
    requestedTimeouts.length = 0;
    const response = await app!.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { text: "A long line", audioConnectionId: "" },
    });
    return { response, requested: [...requestedTimeouts] };
  };

  await saveSettings();
  let { response, requested } = await speak();
  assert.deepEqual(requested, [TTS_TIMEOUT_MS_DEFAULT], "settings without a limit keep the default");
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().code, "timeout", "the default limit expires before the slow server answers");

  await saveSettings({ timeoutMs: 300_000 });
  ({ response, requested } = await speak());
  assert.deepEqual(requested, [300_000], "the speech request uses the saved limit");
  assert.equal(response.statusCode, 200, "a limit above the transport's own cap is waited out");
} finally {
  AbortSignal.timeout = realTimeout;
  setGlobalDispatcher(previousDispatcher);
  await shortTransport.close();
  try {
    await app?.close();
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}

console.info("TTS request timeout regression passed");
