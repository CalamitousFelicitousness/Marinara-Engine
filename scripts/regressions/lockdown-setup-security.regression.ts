// Lockdown page (#7912): a refused remote device can set the first login with the one-time
// setup code from the server log, wrong codes count toward the wrong-password lockout, and the
// page never names a flag that turns the lockdown off.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
const priorError = logger.error;
logger.error = (() => {}) as typeof logger.error;

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
// What a browser sends for a form on this page over HTTPS; plain HTTP has no Sec-Fetch-Site.
const SAME_ORIGIN = { origin: "http://chat.example.com", "sec-fetch-site": "same-origin" };
const page = (remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/", remoteAddress, headers: { ...HOST, ...HTML, ...headers } });
const setup = (
  remoteAddress: string,
  fields: Record<string, string>,
  browser: Record<string, string> = SAME_ORIGIN,
  url = "/login/setup",
) =>
  app.inject({
    method: "POST",
    url,
    remoteAddress,
    headers: { ...HOST, ...HTML, ...browser, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
const lastCode = () =>
  String(warnings.filter((args) => String(args[0]).includes("one-time setup code")).at(-1)?.[1] ?? "");

try {
  await app.ready();
  credential.enableLoginSetupCode();
  const code = lastCode();
  assert.match(code, /^[0-9a-f]{24}$/, "with no login, the setup code is in the server log");

  // ── The page a refused device sees ──
  const direct = await page("203.0.113.10");
  assert.equal(direct.statusCode, 403);
  assert.ok(direct.body.includes('action="/login/setup"'), "a direct remote device gets the setup form");
  assert.ok(
    direct.body.includes('<meta name="referrer" content="same-origin" />'),
    "the form posts its real Origin, not null",
  );
  assert.ok(direct.body.includes("docker logs"), "the page says where the code is");
  assert.ok(!direct.body.includes(code), "the page never shows the code");
  const FORWARDED = { "x-forwarded-for": "198.51.100.7" };
  const proxied = await page("127.0.0.1", FORWARDED);
  assert.equal(proxied.statusCode, 403);
  assert.ok(!proxied.body.includes("/login/setup"), "a proxy on loopback may have no code, so no form");
  const api = await app.inject({ method: "GET", url: "/api/chats", remoteAddress: "203.0.113.10", headers: HOST });
  assert.equal(api.statusCode, 403);
  const proxiedApi = await app.inject({
    method: "GET",
    url: "/api/chats",
    remoteAddress: "127.0.0.1",
    headers: { ...HOST, ...FORWARDED },
  });
  assert.equal(proxiedApi.statusCode, 403);

  // ── Only this page's own form gets through the CSRF check ──
  const owner = { setupCode: code, user: "owner", password: "first-password" };
  const crossSite = await setup("203.0.113.10", owner, {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(crossSite.statusCode, 403, "another site cannot post the form");
  assert.match(crossSite.body, /CSRF_/);
  const nullOrigin = await setup("203.0.113.10", owner, { origin: "null" });
  assert.equal(nullOrigin.statusCode, 403, "Origin null over plain HTTP is refused, so the page must not send it");
  assert.match(nullOrigin.body, /CSRF_/);
  assert.equal(credential.getLoginConfig(), null, "a refused post does not use the code");
  const plainHttp = await setup(
    "203.0.113.10",
    { ...owner, setupCode: "1".repeat(24) },
    {
      origin: "http://chat.example.com",
    },
  );
  assert.equal(plainHttp.statusCode, 403, "plain HTTP with this server's Origin reaches the code check");
  assert.ok(plainHttp.body.includes('role="alert"'));

  // ── Bodies stay small on the public forms ──
  const big = { ...owner, user: "x".repeat(9 * 1024) };
  assert.equal((await setup("203.0.113.30", big)).statusCode, 413, "the setup form refuses a large body");

  // ── Wrong input does not set a login ──
  const short = await setup("203.0.113.10", { ...owner, password: "too-short" });
  assert.equal(short.statusCode, 400);
  assert.equal((await setup("203.0.113.10", { ...owner, user: "a:b" })).statusCode, 400);
  const wrong = await setup("203.0.113.10", { ...owner, setupCode: "0".repeat(24) });
  assert.equal(wrong.statusCode, 403, "a wrong code fails");
  assert.ok(wrong.body.includes('role="alert"'), "the form says why");

  // Wrong codes use the wrong-password lockout; even the right code waits it out.
  for (let i = 0; i < BASIC_AUTH_FAILURE_LIMIT; i++) {
    await setup("203.0.113.66", { ...owner, setupCode: `${i}`.padStart(24, "f") });
  }
  const locked = await setup("203.0.113.66", owner);
  assert.equal(locked.statusCode, 429, "too many wrong codes lock the address out");
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal(credential.getLoginConfig(), null);

  for (const reply of [direct, proxied, api, proxiedApi, short, wrong, locked]) {
    assert.doesNotMatch(reply.body, BYPASS_NAMES, "the lockdown never names a flag that turns it off");
  }

  // ── A failed save prints a new code instead of losing the only one ──
  let current = code;
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(ownDataDir, 0o500);
    const failed = await setup("203.0.113.10", owner);
    chmodSync(ownDataDir, 0o700);
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(credential.getLoginConfig(), null);
    current = lastCode();
    assert.match(current, /^[0-9a-f]{24}$/);
    assert.notEqual(current, code, "the server log has a new code");
    assert.equal((await setup("203.0.113.10", owner)).statusCode, 403, "the used code stays used");
  }

  // ── The right code sets the login and signs this browser in ──
  const done = await setup("203.0.113.10", { ...owner, setupCode: current });
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

  const bigSignIn = await setup("203.0.113.30", big, SAME_ORIGIN, "/login");
  assert.equal(bigSignIn.statusCode, 413, "sign-in refuses a large body too");

  // ── The code works once ──
  const again = await setup("203.0.113.20", {
    ...owner,
    setupCode: current,
    user: "intruder",
    password: "intruder-password",
  });
  assert.notEqual(again.statusCode, 303);
  assert.equal(credential.getLoginConfig()?.user, "owner", "a used code cannot replace the login");

  console.info("Lockdown setup regressions passed.");
} finally {
  logger.warn = priorWarn;
  logger.error = priorError;
  await app.close();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ownDataDir, { recursive: true, force: true });
}
