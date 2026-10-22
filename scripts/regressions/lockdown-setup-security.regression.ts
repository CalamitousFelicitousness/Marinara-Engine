// Lockdown page (#7912): a refused remote device can set the first login with the one-time
// setup code from the server log, wrong codes count toward the wrong-password lockout, and the
// page never names a flag that turns the lockdown off.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

const ENV_KEYS = [
  "ADMIN_SECRET",
  "ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK",
  "ALLOW_UNAUTHENTICATED_REMOTE",
  "BASIC_AUTH_PASS",
  "BASIC_AUTH_USER",
  "BYPASS_AUTH_DOCKER",
  "BYPASS_AUTH_TAILSCALE",
  "DATA_DIR",
  "ENCRYPTION_KEY",
  "IP_ALLOWLIST",
  "MARINARA_DOCKER",
  "REQUIRE_AUTH_FOR_LOOPBACK_PROXY",
  "TRUSTED_AUTH_PROXY",
  "TRUSTED_HOSTS",
  "TRUSTED_PRIVATE_NETWORKS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
// Always a fresh DATA_DIR: this test saves a login and a session there.
const ownDataDir = mkdtempSync(join(tmpdir(), "marinara-lockdown-setup-"));
for (const key of ENV_KEYS) delete process.env[key];
process.env.DATA_DIR = ownDataDir;
process.env.TRUSTED_HOSTS = "chat.example.com";
process.env.ENCRYPTION_KEY = "ab".repeat(32);

const credential = await import("../../packages/server/src/config/login-credential.js");
const { BASIC_AUTH_FAILURE_LIMIT, basicAuthHook, loginRoutes } =
  await import("../../packages/server/src/middleware/basic-auth.js");
const { csrfProtectionHook } = await import("../../packages/server/src/middleware/csrf-protection.js");
const { hostValidationHook } = await import("../../packages/server/src/middleware/host-validation.js");
const { ipAllowlistHook } = await import("../../packages/server/src/middleware/ip-allowlist.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");

const BYPASS_NAMES =
  /ALLOW_UNAUTHENTICATED_|BYPASS_AUTH_|IP_ALLOWLIST|TRUSTED_PRIVATE_NETWORKS|REQUIRE_AUTH_FOR_|TRUSTED_AUTH_PROXY/;

const warnings: unknown[][] = [];
const priorWarn = logger.warn;
logger.warn = ((...args: unknown[]) => warnings.push(args)) as typeof logger.warn;

const app = Fastify();
app.addHook("onRequest", hostValidationHook);
app.addHook("onRequest", ipAllowlistHook);
app.addHook("onRequest", basicAuthHook);
app.addHook("onRequest", csrfProtectionHook);
app.get("/", async (_request, reply) => reply.type("text/html").send("<!doctype html><title>Marinara</title>"));
app.get("/api/chats", async () => [{ id: "private-chat" }]);
await app.register(loginRoutes);

const HOST = { host: "chat.example.com" };
const HTML = { accept: "text/html" };
const page = (remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/", remoteAddress, headers: { ...HOST, ...HTML, ...headers } });
const setup = (remoteAddress: string, fields: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: "/login/setup",
    remoteAddress,
    headers: { ...HOST, ...HTML, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });

try {
  await app.ready();
  credential.enableLoginSetupCode();
  const code = String(warnings.find((args) => String(args[0]).includes("one-time setup code"))?.[1] ?? "");
  assert.match(code, /^[0-9a-f]{24}$/, "with no login, the setup code is in the server log");

  // ── The page a refused device sees ──
  const direct = await page("203.0.113.10");
  assert.equal(direct.statusCode, 403);
  assert.ok(direct.body.includes('action="/login/setup"'), "a direct remote device gets the setup form");
  assert.ok(direct.body.includes("docker logs"), "the page says where the code is");
  assert.ok(!direct.body.includes(code), "the page never shows the code");
  const proxied = await page("127.0.0.1", { "x-forwarded-for": "198.51.100.7" });
  assert.equal(proxied.statusCode, 403);
  assert.ok(!proxied.body.includes("/login/setup"), "a proxy on loopback may have no code, so no form");
  const api = await app.inject({ method: "GET", url: "/api/chats", remoteAddress: "203.0.113.10", headers: HOST });
  assert.equal(api.statusCode, 403);
  for (const body of [direct.body, proxied.body, api.body]) {
    assert.doesNotMatch(body, BYPASS_NAMES, "the lockdown never names a flag that turns it off");
  }

  // ── Wrong input does not set a login ──
  const owner = { setupCode: code, user: "owner", password: "first-password" };
  assert.equal((await setup("203.0.113.10", { ...owner, password: "too-short" })).statusCode, 400);
  assert.equal((await setup("203.0.113.10", { ...owner, user: "a:b" })).statusCode, 400);
  const wrong = await setup("203.0.113.10", { ...owner, setupCode: "0".repeat(24) });
  assert.equal(wrong.statusCode, 403, "a wrong code fails");
  assert.ok(wrong.body.includes('role="alert"'), "the form says why");
  assert.doesNotMatch(wrong.body, BYPASS_NAMES);

  // Wrong codes use the wrong-password lockout; even the right code waits it out.
  for (let i = 0; i < BASIC_AUTH_FAILURE_LIMIT; i++) {
    await setup("203.0.113.66", { ...owner, setupCode: `${i}`.padStart(24, "f") });
  }
  const locked = await setup("203.0.113.66", owner);
  assert.equal(locked.statusCode, 429, "too many wrong codes lock the address out");
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal(credential.getLoginConfig(), null);

  // ── The right code sets the login and signs this browser in ──
  const done = await setup("203.0.113.10", owner);
  assert.equal(done.statusCode, 303, done.body);
  assert.equal(done.headers.location, "/");
  const cookie = String(done.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  assert.match(cookie, /^marinara_session=[\w-]{43}$/, "the device that set the login stays signed in");
  const chats = await app.inject({
    method: "GET",
    url: "/api/chats",
    remoteAddress: "203.0.113.10",
    headers: { ...HOST, cookie },
  });
  assert.equal(chats.statusCode, 200);
  const stored = credential.getLoginConfig();
  assert.ok(stored?.source === "app" && stored.user === "owner");
  assert.equal(await credential.verifyStoredPassword(stored, "owner", "first-password"), true);

  // ── The code works once ──
  const again = await setup("203.0.113.20", { ...owner, user: "intruder", password: "intruder-password" });
  assert.notEqual(again.statusCode, 303);
  assert.equal(credential.getLoginConfig()?.user, "owner", "a used code cannot replace the login");

  console.info("Lockdown setup regressions passed.");
} finally {
  logger.warn = priorWarn;
  await app.close();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ownDataDir, { recursive: true, force: true });
}
