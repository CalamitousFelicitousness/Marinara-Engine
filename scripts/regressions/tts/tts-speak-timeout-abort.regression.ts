// Four properties of /speak, each cheap to break and none visible in a type:
//
// - The provider budget is cfg.timeoutMs, not a literal. A CPU engine needing
//   longer must be accommodated by a setting.
// - A hung engine ends as 502 with code:"timeout". The client branches on the
//   code, so English prose in `error` is not a substitute.
// - A departing listener aborts the provider request rather than leaving it
//   rendering to completion.
// - A local engine is reachable with no opt-in, and TTS_LOCAL_URLS_ENABLED
//   =false still denies private and LAN addresses for every source.
//
// Boots the real app against a stub engine, and drives a real socket for the
// disconnect case: app.inject has none, and the abort binding is only correct
// on one of req.raw/reply.raw, which are indistinguishable without one.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ttsConfigSchema } from "../../../packages/shared/src/types/tts.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-tts-timeout-"));

type Injectable = {
  close(): Promise<void>;
  ready(): Promise<unknown>;
  listen(options: { port: number; host: string }): Promise<string>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; body: string; json(): any }>;
};

let app: Injectable | null = null;
let provider: ReturnType<typeof createServer> | null = null;

// A stub engine: /hang never answers, /audio/speech answers immediately.
let hangRequests = 0;
let abortedRequests = 0;
const openResponses = new Set<ServerResponse>();

function handleProviderRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.includes("/hang")) {
    hangRequests += 1;
    openResponses.add(res);
    req.once("aborted", () => {
      abortedRequests += 1;
    });
    res.once("close", () => openResponses.delete(res));
    return; // never respond
  }
  // Minimal valid MP3 frame: the route sniffs magic bytes before trusting the
  // declared content type, so a JSON error body cannot masquerade as audio.
  const body = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(body.length) });
  res.end(body);
}

try {
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = join(dataDir, "file-storage");
  process.env.MARINARA_FILE_STORAGE_DIR = join(dataDir, "file-storage");
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";
  // Deliberately NOT set: loopback must work without it.
  delete process.env.TTS_LOCAL_URLS_ENABLED;

  provider = createServer(handleProviderRequest);
  await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as { port: number }).port;
  const providerBase = `http://127.0.0.1:${providerPort}`;

  const { buildApp } = await import("../../../packages/server/src/app.js");
  app = (await buildApp()) as unknown as Injectable;
  await app.ready();

  const saveConfig = async (overrides: Record<string, unknown>) => {
    const payload = ttsConfigSchema.parse({
      enabled: true,
      source: "openai",
      baseUrl: providerBase,
      apiKey: "test-key",
      voice: "alloy",
      model: "tts-1",
      ...overrides,
    });
    const response = await app!.inject({ method: "PUT", url: "/api/tts/config", payload });
    assert.equal(response.statusCode, 204, "saving TTS config");
  };

  // ── Loopback works with no flag ──
  // The whole point of the local-engine story: a localhost engine must not need
  // an opt-in that no LLM provider has ever needed.
  await saveConfig({});
  const spoke = await app.inject({ method: "POST", url: "/api/tts/speak", payload: { text: "Hello." } });
  assert.equal(
    spoke.statusCode,
    200,
    `loopback engine must be reachable without TTS_LOCAL_URLS_ENABLED: ${spoke.body}`,
  );

  // ── The local-URL flag: default-on, and its opt-out covers every source ──
  // Asserted against the policy rather than /speak because a policy refusal and
  // a real connection refusal both surface as code:"unreachable" on the route.
  // A literal private IP is rejected at the hostname check (security.ts), so
  // none of this touches DNS or the network.
  {
    const { ttsUrlPolicy } = await import("../../../packages/server/src/services/tts/url-policy.js");
    const { validateOutboundUrl } = await import("../../../packages/server/src/utils/security.js");
    const lan = "http://192.168.0.1:8000/v1/audio/speech";
    const loopback = "http://127.0.0.1:8000/v1/audio/speech";

    // The flag is read per call, so flipping it mid-run is the real behaviour.
    delete process.env.TTS_LOCAL_URLS_ENABLED;
    await validateOutboundUrl(lan, ttsUrlPolicy());

    process.env.TTS_LOCAL_URLS_ENABLED = "false";
    await assert.rejects(
      () => validateOutboundUrl(lan, ttsUrlPolicy()),
      /private, loopback, metadata, or reserved IP range|local or reserved/u,
      "TTS_LOCAL_URLS_ENABLED=false must restore deny-by-default",
    );
    // The policy takes no source, so the opt-out reaches all of them. A
    // per-source exemption would leave LAN reach open on a hardened install.
    assert.equal(ttsUrlPolicy().allowLocal, false, "the opt-out cannot be partial: no source overrides it");
    // Loopback is unconditional, so hardening never breaks a localhost engine.
    await validateOutboundUrl(loopback, ttsUrlPolicy());

    delete process.env.TTS_LOCAL_URLS_ENABLED;
  }

  // ── The configured budget is the budget ──
  await saveConfig({ baseUrl: `${providerBase}/hang`, timeoutMs: 5_000 });
  const startedAt = Date.now();
  const timedOut = await app.inject({ method: "POST", url: "/api/tts/speak", payload: { text: "Hello." } });
  const elapsed = Date.now() - startedAt;
  assert.equal(timedOut.statusCode, 502, "a hung engine ends as a gateway failure");
  const timeoutBody = timedOut.json();
  assert.equal(timeoutBody.code, "timeout", "the client is told why in a field it can branch on");
  assert.match(timeoutBody.error, /timed out after 5s/u, "the message names the budget that expired");
  assert.ok(elapsed < 20_000, `must give up on the configured 5s, not the old 60s literal (waited ${elapsed}ms)`);
  assert.ok(hangRequests > 0, "the stub engine actually received the request");

  // ── An unreachable engine is distinguishable from a slow one ──
  // Bind and release a port so the refusal is real rather than undici's
  // bad-port rejection, which never opens a connection at all.
  const closedProbe = createServer();
  await new Promise<void>((resolve) => closedProbe.listen(0, "127.0.0.1", resolve));
  const closedPort = (closedProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => closedProbe.close(() => resolve()));
  await saveConfig({ baseUrl: `http://127.0.0.1:${closedPort}` });
  const unreachable = await app.inject({ method: "POST", url: "/api/tts/speak", payload: { text: "Hello." } });
  assert.equal(unreachable.statusCode, 502);
  assert.equal(unreachable.json().code, "unreachable", "connection refused is not a timeout");

  // ── A provider error carries its own code ──
  await saveConfig({ baseUrl: providerBase, source: "elevenlabs", apiKey: "" });
  const missingKey = await app.inject({ method: "POST", url: "/api/tts/speak", payload: { text: "Hello." } });
  assert.equal(missingKey.statusCode, 400, "a missing ElevenLabs key is the caller's problem, not the gateway's");

  // ── Route contract ──
  await saveConfig({});
  const oversized = await app.inject({
    method: "POST",
    url: "/api/tts/speak",
    payload: { text: "x".repeat(4097) },
  });
  assert.equal(oversized.statusCode, 400, "text above the 4096 cap is rejected");

  const badQuery = await app.inject({ method: "GET", url: "/api/tts/voices?connectionId=" + "y".repeat(200) });
  assert.equal(badQuery.statusCode, 400, "voices query is parsed, not cast");
  const badModelsQuery = await app.inject({ method: "GET", url: "/api/tts/models?connectionId=" + "y".repeat(200) });
  assert.equal(badModelsQuery.statusCode, 400, "models query is parsed, not cast");

  // ── Leaving mid-render stops the engine ──
  // inject() has no socket, so this needs a real listener and a real hang-up.
  await saveConfig({ baseUrl: `${providerBase}/hang`, timeoutMs: 600_000 });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const beforeAborts = abortedRequests;
  const listener = new AbortController();
  const inFlight = fetch(`${address}/api/tts/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello." }),
    signal: listener.signal,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 400));
  listener.abort();
  await inFlight;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(
    abortedRequests > beforeAborts,
    "hanging up must abort the provider request instead of leaving it rendering to completion",
  );
} finally {
  for (const response of openResponses) response.destroy();
  if (app) await app.close();
  if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}

console.info("TTS speak timeout and abort regression passed.");
