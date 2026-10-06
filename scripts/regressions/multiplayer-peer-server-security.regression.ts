import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { MultiplayerPeerResponse } from "../../packages/shared/src/schemas/multiplayer.schema.js";
import {
  startMultiplayerPeerServer,
  MULTIPLAYER_PEER_SERVER_LIMITS,
} from "../../packages/server/src/services/multiplayer/peer-server.js";

const directory = mkdtempSync(join(tmpdir(), "marinara-room-listener-"));
const listeners: Array<Awaited<ReturnType<typeof startMultiplayerPeerServer>>> = [];

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,IP:::1",
      "-keyout",
      "host.key",
      "-out",
      "host.pem",
    ],
    { cwd: directory, stdio: "ignore" },
  );
  const tls = { cert: readFileSync(join(directory, "host.pem")), key: readFileSync(join(directory, "host.key")) };
  const message = { version: 1, type: "preview", roomId: "room_123456", invite: "i".repeat(43) };
  const valid: MultiplayerPeerResponse = {
    version: 1,
    type: "preview",
    roomId: "room_123456",
    name: "Room",
    mode: "roleplay",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  async function post(
    port: number,
    input: unknown = message,
    extra: {
      path?: string;
      headers?: Record<string, string>;
      raw?: string;
      method?: string;
      hostname?: string;
      localAddress?: string;
    } = {},
  ) {
    const data = extra.raw ?? JSON.stringify(input);
    return new Promise<{ status: number; data: any; raw: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: extra.hostname ?? "127.0.0.1",
          localAddress: extra.localAddress,
          port,
          path: extra.path ?? "/room",
          method: extra.method ?? "POST",
          ca: tls.cert,
          agent: false,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...extra.headers },
          signal: AbortSignal.timeout(5_000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let data: unknown = null;
            try {
              data = JSON.parse(raw);
            } catch {
              /* Node rejects oversized headers before JSON handling. */
            }
            resolve({ status: res.statusCode ?? 0, data, raw });
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }
  await assert.rejects(
    startMultiplayerPeerServer({ tls, port: 0, host: "127.0.0.1", enabled: () => false, handle: async () => valid }),
    /disabled/u,
  );
  await assert.rejects(
    startMultiplayerPeerServer({
      tls: { cert: Buffer.alloc(0), key: Buffer.alloc(0) },
      port: 0,
      enabled: () => true,
      handle: async () => valid,
    }),
    /requires TLS/u,
  );
  let enabled = true;
  let calls = 0;
  let contextSession: string | null = null;
  let output: unknown = valid;
  const listener = await startMultiplayerPeerServer({
    tls,
    port: 0,
    host: "127.0.0.1",
    enabled: () => enabled,
    handle: async (_message, context) => {
      calls++;
      contextSession = context.session;
      assert.equal(context.address, "127.0.0.1");
      return output as MultiplayerPeerResponse;
    },
  });
  listeners.push(listener);
  assert.deepEqual((await post(listener.port)).data, valid);
  assert.equal(calls, 1);
  const session = "s".repeat(43);
  await post(listener.port, message, { headers: { authorization: `Bearer ${session}` } });
  assert.equal(contextSession, session);
  const beforeInvalid = calls;
  for (const path of ["/api/settings", "/api/admin", "/", "/room?path=/api/admin"]) {
    assert.equal((await post(listener.port, message, { path })).status, 404);
  }
  assert.equal((await post(listener.port, message, { method: "OPTIONS" })).status, 404);
  assert.equal((await post(listener.port, message, { headers: { origin: "null" } })).status, 403);
  assert.equal((await post(listener.port, message, { headers: { "sec-fetch-site": "same-origin" } })).status, 403);
  assert.equal((await post(listener.port, message, { headers: { authorization: "Basic host-secret" } })).status, 400);
  for (const input of [
    { ...message, version: 2 },
    { ...message, admin: true },
    { ...message, type: "download", path: "/api/secret" },
  ]) {
    assert.equal((await post(listener.port, input)).data.code, "invalid-message");
  }
  await post(listener.port, null, { raw: "x".repeat(20_000) }).then(
    (response) => assert.equal(response.data.code, "invalid-message"),
    (error: Error) => assert.match(error.message, /socket hang up|reset|aborted/iu),
  );
  assert.equal(calls, beforeInvalid, "Invalid requests must never reach room authority");
  assert.equal((await post(listener.port, message, { headers: { "x-large": "x".repeat(10_000) } })).status, 431);
  output = { ...valid, privateKey: "DO_NOT_DISCLOSE" };
  const unsafeResponse = await post(listener.port);
  assert.equal(unsafeResponse.data.code, "invalid-message");
  assert.doesNotMatch(unsafeResponse.raw, /DO_NOT_DISCLOSE|privateKey/u);
  output = {
    version: 1,
    type: "state",
    state: {
      phase: "connected",
      error: null,
      snapshot: {
        version: 1,
        roomId: "room_123456",
        selfId: "guest_123456",
        revision: 0,
        nextSequence: 0,
        name: "Room",
        mode: "roleplay",
        status: "active",
        generation: "idle",
        usage: { generations: 0, maxGenerations: 100, automaticReplies: true },
        players: [],
        characters: [],
        round: null,
        messages: Array.from({ length: 100 }, (_, index) => ({
          id: `message_${index.toString().padStart(8, "0")}`,
          actorId: null,
          actorName: "Host",
          kind: "assistant",
          text: "x".repeat(4_000),
          createdAt: "2026-09-29T10:00:00.000Z",
        })),
      },
    },
  };
  assert.equal(
    (await post(listener.port)).data.code,
    "snapshot-too-large",
    "A valid but oversized snapshot is withheld",
  );
  output = valid;
  enabled = false;
  const disabledCalls = calls;
  assert.equal((await post(listener.port)).data.code, "disabled");
  assert.equal(calls, disabledCalls);
  enabled = true;
  for (let count = 0; count < MULTIPLAYER_PEER_SERVER_LIMITS.requestsPerAddress; count++) await post(listener.port);
  assert.equal((await post(listener.port)).data.code, "rate-limited");

  // With no bind host the room listener accepts IPv4 and IPv6 guests. A second client address
  // (IPv6 loopback, or 127.0.0.2 where only IPv4 exists) proves one flooding address cannot
  // spend the shared budget that every other guest needs.
  const dualStack = await startMultiplayerPeerServer({ tls, port: 0, enabled: () => true, handle: async () => valid });
  listeners.push(dualStack);
  assert.deepEqual((await post(dualStack.port)).data, valid, "the default bind still accepts IPv4 guests");
  const ipv6 = Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => entry.internal && entry.family === "IPv6" && entry.address === "::1"),
  );
  const secondAddress = ipv6 ? { hostname: "::1" } : { localAddress: "127.0.0.2" };
  const reachable = await post(dualStack.port, message, secondAddress).then(
    (response) => response,
    (error: NodeJS.ErrnoException) => {
      if (!ipv6 && error.code === "EADDRNOTAVAIL") return null;
      throw error;
    },
  );
  if (!reachable) {
    process.stdout.write("multiplayer peer listener: no second loopback address here; two-address legs skipped\n");
  } else {
    assert.deepEqual(reachable.data, valid, ipv6 ? "an IPv6 room address is reachable" : "a second guest is served");
    for (let count = 0; count < MULTIPLAYER_PEER_SERVER_LIMITS.requestsGlobal; count++) await post(dualStack.port);
    assert.equal((await post(dualStack.port)).data.code, "rate-limited", "the flooding address is limited");
    assert.deepEqual(
      (await post(dualStack.port, message, secondAddress)).data,
      valid,
      "requests refused by one address's limit do not lock out other guests",
    );
  }

  let signal: AbortSignal | null = null;
  let started!: () => void;
  let filled!: () => void;
  let activeCalls = 0;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const atCapacity = new Promise<void>((resolve) => {
    filled = resolve;
  });
  const hanging = await startMultiplayerPeerServer({
    tls,
    port: 0,
    host: "127.0.0.1",
    enabled: () => true,
    handle: async (_input, context) => {
      signal = context.signal;
      started();
      if (++activeCalls === MULTIPLAYER_PEER_SERVER_LIMITS.inFlight) filled();
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return valid;
    },
  });
  listeners.push(hanging);
  const finalAnswer = () =>
    post(hanging.port).then(
      (response) => response.data?.code,
      () => "transport error",
    );
  const pending = finalAnswer();
  await entered;
  const pendingMore = Array.from({ length: MULTIPLAYER_PEER_SERVER_LIMITS.inFlight - 1 }, finalAnswer);
  await atCapacity;
  assert.equal((await post(hanging.port)).data.code, "busy");
  // Also hold a connection before TLS headers: Stop must not wait for a slow handshake.
  const slow = connect(hanging.port, "127.0.0.1");
  slow.on("error", () => undefined);
  await new Promise<void>((resolve) => slow.once("connect", resolve));
  const stopStarted = Date.now();
  await hanging.close();
  assert.ok(Date.now() - stopStarted < 1_000, "Stop must close immediately, including incomplete handshakes");
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  // Waiting polls and actions get a final answer, so a guest sees the room close instead of a dead socket.
  assert.equal(await pending, "disabled");
  assert.deepEqual(new Set(await Promise.all(pendingMore)), new Set(["disabled"]));
  slow.destroy();
  await hanging.close();
  process.stdout.write(
    "multiplayer peer listener: gates, route isolation, dual-stack bind, per-address rates and answered shutdown passed\n",
  );
} finally {
  for (const listener of listeners) await listener.close();
  rmSync(directory, { recursive: true, force: true });
}
