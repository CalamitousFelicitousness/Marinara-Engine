// Remote login (#7912): a login saved in the app protects remote access like the
// .env pair, browsers sign in on /login instead of the Basic Auth dialog, scripts
// keep sending Basic Authorization, and the first login can be set from the
// Docker host with a one-time setup code from the server log.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
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
  "TRUSTED_HOSTS",
  "TRUSTED_PRIVATE_NETWORKS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
// The runner gives each file its own DATA_DIR; a direct run must not touch real data.
const ownDataDir = process.env.DATA_DIR ? null : mkdtempSync(join(tmpdir(), "marinara-remote-login-"));
for (const key of ENV_KEYS) if (key !== "DATA_DIR") delete process.env[key];
if (ownDataDir) process.env.DATA_DIR = ownDataDir;
process.env.TRUSTED_HOSTS = "chat.example.com";
process.env.ENCRYPTION_KEY = "ab".repeat(32);

// Imported after the env is set: DATA_DIR is read once at import.
const credential = await import("../../packages/server/src/config/login-credential.js");
const { BASIC_AUTH_FAILURE_LIMIT, basicAuthHook, loginRoutes } = await import(
  "../../packages/server/src/middleware/basic-auth.js"
);
const { csrfProtectionHook } = await import("../../packages/server/src/middleware/csrf-protection.js");
const { hostValidationHook } = await import("../../packages/server/src/middleware/host-validation.js");
const { ipAllowlistHook } = await import("../../packages/server/src/middleware/ip-allowlist.js");
const { rateLimitHook } = await import("../../packages/server/src/middleware/rate-limit.js");
const { accessStatusRoutes } = await import("../../packages/server/src/routes/access-status.routes.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");
const { DATA_DIR } = await import("../../packages/server/src/utils/data-dir.js");

const warnings: unknown[][] = [];
const priorWarn = logger.warn;
logger.warn = ((...args: unknown[]) => warnings.push(args)) as typeof logger.warn;
const realNow = Date.now;

// The same onRequest order as app.ts.
const app = Fastify();
app.addHook("onRequest", hostValidationHook);
app.addHook("onRequest", ipAllowlistHook);
app.addHook("onRequest", rateLimitHook);
app.addHook("onRequest", basicAuthHook);
app.addHook("onRequest", csrfProtectionHook);
app.get("/", async (_request, reply) => reply.type("text/html").send("<!doctype html><title>Marinara</title>"));
app.get("/api/chats", async () => [{ id: "private-chat" }]);
await app.register(loginRoutes);
await app.register(accessStatusRoutes, { prefix: "/api/access" });

const REMOTE = "203.0.113.10";
const HOST = { host: "chat.example.com" };
const LOCAL = { host: "127.0.0.1:7860" };
const LOGIN_FILE = join(DATA_DIR, ".remote-login.json");

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
const get = (url: string, remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, remoteAddress, headers: { ...HOST, ...headers } });
const putLogin = (remoteAddress: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "PUT",
    url: "/api/access/login",
    remoteAddress,
    headers: { ...(remoteAddress === "127.0.0.1" ? LOCAL : HOST), "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
const deleteLogin = () =>
  app.inject({ method: "DELETE", url: "/api/access/login", remoteAddress: "127.0.0.1", headers: LOCAL });
const signIn = (remoteAddress: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/login",
    remoteAddress,
    headers: { ...HOST, "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(fields).toString(),
  });
const cookieOf = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
const loginSource = async () =>
  (await app.inject({ method: "GET", url: "/api/access/status", remoteAddress: "127.0.0.1", headers: LOCAL })).json()
    .loginSource;

try {
  await app.ready();

  // ── First login from the Docker host, with the one-time setup code ──
  assert.equal(credential.getLoginConfig(), null);
  credential.announceLoginSetupCode();
  const announced = warnings.find((args) => String(args[0]).includes("one-time setup code"));
  assert.ok(announced, "with no login, the setup code is in the server log");
  const code = String(announced[1]);
  assert.match(code, /^[0-9a-f]{24}$/);

  // The host browser arrives as a remote peer that may open the app but has no ADMIN_SECRET.
  process.env.ALLOW_UNAUTHENTICATED_REMOTE = "true";
  const first = { user: "owner", password: "first-password" };
  assert.equal((await putLogin(REMOTE, first)).statusCode, 403, "a remote caller needs ADMIN_SECRET or the code");
  assert.equal((await putLogin(REMOTE, { ...first, setupCode: "0".repeat(24) })).statusCode, 403, "a wrong code fails");
  assert.equal((await putLogin(REMOTE, { ...first, password: "too-short", setupCode: code })).statusCode, 400);
  assert.equal((await putLogin(REMOTE, { ...first, user: "a:b", setupCode: code })).statusCode, 400);
  const setFirst = await putLogin(REMOTE, { ...first, setupCode: code });
  assert.equal(setFirst.statusCode, 200, "the setup code stands in for ADMIN_SECRET for the first login");
  assert.deepEqual(setFirst.json(), { loginSource: "app" });
  const setupSession = cookieOf(setFirst);
  assert.match(setupSession, /^marinara_signed_in=[\w-]+$/, "the browser that set the login stays signed in");
  assert.equal((await get("/api/chats", REMOTE, { cookie: setupSession })).statusCode, 200);

  // ── The saved login: hashed, 0600, read back ──
  const saved = readFileSync(LOGIN_FILE, "utf8");
  assert.ok(!saved.includes("first-password"), "only a hash is saved");
  if (process.platform !== "win32") assert.equal(statSync(LOGIN_FILE).mode & 0o777, 0o600, "the file is owner-only");
  const stored = credential.getLoginConfig();
  assert.equal(stored?.source, "app");
  if (stored?.source !== "app") throw new Error("unreachable");
  assert.equal(await credential.verifyStoredPassword(stored, "owner", "first-password"), true);
  assert.equal(await credential.verifyStoredPassword(stored, "owner", "wrong-password"), false);
  assert.equal(await credential.verifyStoredPassword(stored, "someone", "first-password"), false);
  assert.equal(await loginSource(), "app");

  // With a login set, the code is gone and the open remote opt-in no longer applies.
  const right = basic("owner", "first-password");
  const again = await putLogin(REMOTE, { user: "intruder", password: "intruder-password", setupCode: code }, {
    authorization: right,
  });
  assert.equal(again.statusCode, 403, "the code no longer works once a login exists");
  assert.equal((await get("/api/chats", "203.0.113.11")).statusCode, 401, "a login closes the open remote opt-in");
  delete process.env.ALLOW_UNAUTHENTICATED_REMOTE;

  // ── Browsers get the login page; scripts keep Basic ──
  const page = await get("/chats/1?tab=a", REMOTE, { accept: "text/html" });
  assert.equal(page.statusCode, 302, "a browser page load is sent to /login");
  assert.equal(page.headers.location, `/login?next=${encodeURIComponent("/chats/1?tab=a")}`);
  const api = await get("/api/chats", REMOTE, { accept: "text/html" });
  assert.equal(api.statusCode, 401, "API calls keep the 401 challenge");
  assert.match(String(api.headers["www-authenticate"]), /^Basic realm=/);
  const form = await get("/login?next=%2Fchats", REMOTE, { accept: "text/html" });
  assert.equal(form.statusCode, 200);
  assert.match(form.body, /<form[^>]+method="post" action="\/login"/);
  assert.match(form.body, /name="next" value="\/chats"/);
  assert.equal((await get("/api/chats", "203.0.113.11", { authorization: right })).statusCode, 200, "Basic works");
  assert.equal((await get("/api/chats", "203.0.113.11", { authorization: right })).statusCode, 200, "and again");

  // ── Sign in on the page ──
  const wrong = await signIn("203.0.113.20", { user: "owner", password: "not-the-password", next: "/chats" });
  assert.equal(wrong.statusCode, 401);
  assert.match(wrong.body, /Wrong username or password/);
  assert.equal(wrong.headers["set-cookie"], undefined);
  const crossSite = await signIn(
    "203.0.113.20",
    { user: "owner", password: "first-password" },
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  );
  assert.equal(crossSite.statusCode, 403, "another site cannot post the form");
  const signedIn = await signIn(
    "203.0.113.20",
    { user: "owner", password: "first-password", next: "/chats" },
    { origin: "https://chat.example.com", "sec-fetch-site": "same-origin" },
  );
  assert.equal(signedIn.statusCode, 303, "the form works on a named host without CSRF_TRUSTED_ORIGINS");
  assert.equal(signedIn.headers.location, "/chats");
  const setCookie = String(signedIn.headers["set-cookie"]);
  assert.match(setCookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000$/, "a long-lived HttpOnly session");
  const session = cookieOf(signedIn);
  assert.equal((await get("/api/chats", "203.0.113.21", { cookie: session })).statusCode, 200, "the cookie signs in");
  assert.equal((await get("/api/chats", "203.0.113.21", { cookie: "marinara_signed_in=made-up" })).statusCode, 401);

  // `next` never leaves this server.
  for (const next of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)"]) {
    const response = await signIn("203.0.113.20", { user: "owner", password: "first-password", next });
    assert.equal(response.headers.location, "/", `POST next=${next} stays here`);
    const redirect = await get(`/login?next=${encodeURIComponent(next)}`, "203.0.113.21", { cookie: session });
    assert.equal(redirect.headers.location, "/", `GET next=${next} stays here`);
  }

  // ── A new password ends old sessions and the old Basic header ──
  assert.equal((await putLogin("127.0.0.1", { user: "owner", password: "second-password" })).statusCode, 200);
  assert.equal((await get("/api/chats", "203.0.113.21", { cookie: session })).statusCode, 401, "old sessions end");
  assert.equal((await get("/api/chats", "203.0.113.11", { authorization: right })).statusCode, 401, "old password");
  const second = basic("owner", "second-password");
  assert.equal((await get("/api/chats", "203.0.113.11", { authorization: second })).statusCode, 200);

  // ── Wrong passwords on the page count toward the lockout ──
  const guesser = "203.0.113.30";
  for (let index = 0; index < BASIC_AUTH_FAILURE_LIMIT; index += 1) {
    const response = await signIn(guesser, { user: "owner", password: `guess-${index}-password` });
    assert.equal(response.statusCode, 401, `guess ${index + 1} is still answered`);
  }
  const locked = await signIn(guesser, { user: "owner", password: "second-password" });
  assert.equal(locked.statusCode, 429, "after the limit even the right password is refused");
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal((await get("/api/chats", guesser, { authorization: second })).statusCode, 429, "the lock covers Basic");

  // ── Slow password checks are capped instead of queued ──
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      get("/api/chats", `203.0.113.${100 + index}`, { authorization: basic("owner", `burst-${index}-password`) }),
    ),
  );
  assert.ok(
    burst.some((response) => response.statusCode === 429),
    "checks over the cap get 429",
  );
  assert.ok(burst.some((response) => response.statusCode === 401));

  // ── Remove, and reset by deleting the file ──
  assert.equal((await deleteLogin()).statusCode, 204);
  assert.equal(existsSync(LOGIN_FILE), false);
  assert.equal(await loginSource(), null);
  await credential.setStoredLogin("owner", "third-password");
  assert.equal(credential.getLoginConfig()?.source, "app");
  unlinkSync(LOGIN_FILE);
  Date.now = () => realNow() + 2_001;
  assert.equal(credential.getLoginConfig(), null, "deleting the file removes the login within 2 s");
  assert.equal((await get("/api/chats", "203.0.113.40")).statusCode, 403, "with no login, remote is locked down again");
  Date.now = realNow;

  // A used code does not come back when the login is gone.
  process.env.ALLOW_UNAUTHENTICATED_REMOTE = "true";
  assert.equal((await putLogin(REMOTE, { ...first, setupCode: code })).statusCode, 403, "the code works once");
  delete process.env.ALLOW_UNAUTHENTICATED_REMOTE;

  // ── .env wins and the app login is read-only meanwhile ──
  await credential.setStoredLogin("owner", "fourth-password");
  process.env.BASIC_AUTH_USER = "envuser";
  process.env.BASIC_AUTH_PASS = "env-password";
  assert.equal(credential.getLoginConfig()?.source, "env");
  assert.equal(await loginSource(), "env");
  assert.equal((await putLogin("127.0.0.1", { user: "owner", password: "fifth-password" })).statusCode, 409);
  assert.equal((await deleteLogin()).statusCode, 409);
  assert.ok(existsSync(LOGIN_FILE), "a refused delete keeps the file");
  assert.equal((await get("/api/chats", "203.0.113.50", { authorization: basic("envuser", "env-password") })).statusCode, 200);
  const ignored = await get("/api/chats", "203.0.113.50", { authorization: basic("owner", "fourth-password") });
  assert.equal(ignored.statusCode, 401, "the app login is ignored while .env sets one");

  console.info("Remote login regressions passed.");
} finally {
  Date.now = realNow;
  logger.warn = priorWarn;
  await app.close();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (ownDataDir) rmSync(ownDataDir, { recursive: true, force: true });
}
