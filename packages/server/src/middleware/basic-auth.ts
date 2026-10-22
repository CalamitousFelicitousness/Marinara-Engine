// ──────────────────────────────────────────────
// Middleware: HTTP Basic Auth + safe-by-default remote lockdown
// ──────────────────────────────────────────────
// Set BASIC_AUTH_USER and BASIC_AUTH_PASS to enable HTTP Basic Authentication
// on every request from non-loopback, non-allowlisted IPs.
//
// When credentials are NOT configured, this middleware refuses connections
// from every non-loopback IP (returns 401/403) unless the operator explicitly
// opts into unauthenticated private/public access. This protects LAN, Docker,
// Tailscale, and internet-exposed installs by default.
//
// Note: the private-network exemption applies ONLY when no Basic Auth is
// configured. If you set BASIC_AUTH_USER/PASS, the password is required
// from every IP except loopback and explicit IP_ALLOWLIST matches —
// because if you went out of your way to set a password, you mean it.
//
// To opt back into the legacy "LAN/private networks can connect without auth"
// behaviour, set ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK=true. To allow
// unauthenticated public IPs too, set ALLOW_UNAUTHENTICATED_REMOTE=true.
//
// Optional:
//   BASIC_AUTH_REALM            — string shown in the browser password prompt
//                                 (default: "Marinara Engine")
//   ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK — set to "true" to allow LAN/Docker/
//                                           Tailscale clients without auth
//                                           (NOT recommended on shared networks)
//   ALLOW_UNAUTHENTICATED_REMOTE          — set to "true" to allow public IPs
//                                           without auth (NOT recommended)
//
// Notes:
//   • The `/api/health` endpoint is exempt so external uptime checks /
//     load balancers can probe the server without needing credentials. It
//     only adds the local model and GPU details for callers that pass
//     isBasicAuthSatisfied.
//   • Loopback (127.0.0.1, ::1) is exempt — if you're already on the box,
//     you don't need a password. A reverse proxy or tunnel on this machine
//     also connects from loopback; its requests carry forwarding headers and
//     must authenticate like any remote client. Set
//     REQUIRE_AUTH_FOR_LOOPBACK_PROXY=false only when that proxy itself
//     requires a login from every client.
//   • Any IP that matches IP_ALLOWLIST is also exempt — if you've already
//     vouched for a network, requiring a second factor would be noise.
//   • Direct Tailscale and Docker traffic is detected from the request's local
//     socket or the container's actual networks. Set the matching BYPASS_AUTH_*
//     flag to true for the legacy broad-CIDR bypass, or false to require auth.
//     Docker traffic carrying proxy-forwarding headers requires normal auth
//     by default. Set REQUIRE_AUTH_FOR_DOCKER_PROXY=false only when every
//     forwarded client is trusted.
//   • Use a strong, random password — Basic Auth sends credentials on
//     every request, only base64-encoded. Always pair with HTTPS in
//     production (see SSL_CERT / SSL_KEY).
//   • Wrong passwords are counted per client address (an IPv6 /64 counts as
//     one) on every path, health included. After BASIC_AUTH_FAILURE_LIMIT
//     different wrong passwords within the window, that address gets 429
//     until the window ends. A correct password clears the count, except from
//     visitors a local proxy relays, who share one count. A signed-in browser
//     carries its own session cookie, so other visitors' wrong passwords cannot
//     lock it out.
//   • A login can also be saved in the app (config/login-credential.ts); the
//     .env pair wins. Browser page loads go to /login, which sets the session
//     cookie; scripts and API clients keep sending Basic Authorization.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  createSession,
  deleteOtherSessions,
  deleteSession,
  findSession,
  getLoginConfig,
  listSessions,
  SESSION_MAX_AGE_SECONDS,
  verifyStoredPassword,
  type LoginConfig,
  type RemoteSession,
} from "../config/login-credential.js";
import { getBasicAuthConfig } from "../config/runtime-config.js";
import { logger } from "../lib/logger.js";
import { deriveServerKey } from "../utils/crypto.js";
import { cookieValue } from "./android-local-auth.js";
import { getRequestAccess, isForwardedLoopbackRequest } from "./ip-allowlist.js";
import { recordRefusal } from "./refused-devices.js";
// Same grouping as the multiplayer peer server: an IPv4 address, or an IPv6 /64.
import { multiplayerPeerSocketKey as clientAddressKey } from "../services/multiplayer/peer-server.js";

interface CachedConfig {
  login: LoginConfig;
  realm: string;
  /** Changes with the login, so a new password signs out every browser. */
  fingerprint: Buffer;
  /** Built on first use; null when the server key cannot be read. */
  sessionKey?: string | null;
  /** MAC of the last Basic header that passed the slow password check. */
  verifiedHeader?: Buffer;
  announced: boolean;
}

let cached: {
  login: LoginConfig | null;
  user: string | null;
  pass: string | null;
  realm: string;
  resolved: CachedConfig | null;
} | null = null;

function buildExpectedHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

/** An .env login keeps its old fingerprint, so browsers that signed in before stay signed in. */
function loginFingerprint(login: LoginConfig): Buffer {
  const id =
    login.source === "env"
      ? buildExpectedHeader(login.user, login.pass)
      : `app:${login.user}:${login.salt}:${login.hash}`;
  return Buffer.from(id, "utf8");
}

function loadConfig(): CachedConfig | null {
  const raw = getBasicAuthConfig();
  const login = getLoginConfig();
  if (
    !cached ||
    cached.login !== login ||
    cached.user !== raw.user ||
    cached.pass !== raw.pass ||
    cached.realm !== raw.realm
  ) {
    const resolved = login ? { login, realm: raw.realm, fingerprint: loginFingerprint(login), announced: false } : null;
    cached = { login, user: raw.user, pass: raw.pass, realm: raw.realm, resolved };
    if (!raw.user !== !raw.pass) {
      logger.warn(
        "[basic-auth] %s is empty, so the .env login stays off. Set both BASIC_AUTH_USER and BASIC_AUTH_PASS.",
        raw.user ? "BASIC_AUTH_PASS" : "BASIC_AUTH_USER",
      );
    }
  }

  const resolved = cached.resolved;
  if (resolved && !resolved.announced) {
    logger.info(
      `[basic-auth] Remote login enabled from ${resolved.login.source === "env" ? ".env" : "the app"} (realm="${resolved.realm}", user="${resolved.login.user}")`,
    );
    resolved.announced = true;
  }

  return resolved;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Wrong-password throttle ──
// Kept apart from the /api rate limits, which skip the page and static files.

/** Different wrong passwords one client address may try in a window before it gets 429. */
export const BASIC_AUTH_FAILURE_LIMIT = 10;
export const BASIC_AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED_CLIENTS = 4096;

type FailureRecord = { guesses: Set<string>; resetAt: number };
const failures = new Map<string, FailureRecord>();

// A reverse proxy or tunnel on this computer relays every visitor from loopback,
// so the address alone cannot tell them apart. There a browser that opened
// /login is counted by its own random pre-auth cookie; visitors without one share
// the address count. All visitors through that address also share a larger cap,
// so new cookies cannot buy unlimited guesses.
// ponytail: the shared cap can still lock new devices behind a busy proxy. A
// TRUSTED_AUTH_PROXY skips this login, so only proxies without their own login
// reach it; count by a forwarded client address if those need more.
const PRE_AUTH_COOKIE = "marinara_login_client";
const SHARED_FAILURE_LIMIT = BASIC_AUTH_FAILURE_LIMIT * 5;

type FailureBucket = { key: string; limit: number; shared: boolean };

function failureBuckets(request: FastifyRequest): FailureBucket[] {
  const address = clientAddressKey(request.ip);
  if (!isForwardedLoopbackRequest(request)) return [{ key: address, limit: BASIC_AUTH_FAILURE_LIMIT, shared: false }];
  const browser = cookieValue(request, PRE_AUTH_COOKIE);
  const own = browser && /^[\w-]{22}$/.test(browser) ? `${address}|${browser}` : null;
  return [
    { key: own ?? address, limit: BASIC_AUTH_FAILURE_LIMIT, shared: !own },
    { key: `${address}|all`, limit: SHARED_FAILURE_LIMIT, shared: true },
  ];
}

// The session cookie of a browser that signed in on /login. The server keeps only
// a hash of it (config/login-credential.ts), so logout and the owner can end one
// session and a new login ends all. Other visitors' wrong passwords cannot lock it out.
const SESSION_COOKIE = "marinara_session";

/** Names the current login in the sessions file without revealing it; null when the server key cannot be read. */
function sessionLoginKey(config: CachedConfig): string | null {
  if (config.sessionKey === undefined) {
    try {
      const key = deriveServerKey("remote login sessions");
      config.sessionKey = createHmac("sha256", key).update(config.fingerprint).digest("base64url");
    } catch (err) {
      config.sessionKey = null;
      logger.warn(err, "[basic-auth] Could not read the server key; browsers cannot stay signed in");
    }
  }
  return config.sessionKey;
}

function requestSession(request: FastifyRequest, config: CachedConfig): RemoteSession | null {
  const token = cookieValue(request, SESSION_COOKIE);
  const key = sessionLoginKey(config);
  return token && key ? findSession(key, token) : null;
}

/** Direct HTTPS, or HTTPS as reported by a local proxy. Only ever adds Secure, so a wrong report cannot widen access. */
function isHttpsRequest(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  if (!isForwardedLoopbackRequest(request)) return false;
  const proto = request.headers["x-forwarded-proto"];
  const value = Array.isArray(proto) ? proto[0] : proto;
  return value?.split(",")[0]?.trim().toLowerCase() === "https";
}

function startBrowserSession(request: FastifyRequest, reply: FastifyReply, config: CachedConfig): boolean {
  const key = sessionLoginKey(config);
  if (!key) return false;
  const token = createSession(key, request.headers["user-agent"]);
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
  );
  return true;
}

/** Per-process key: verified headers are only kept in memory. */
const HEADER_MAC_KEY = randomBytes(32);
/** Slow password checks that may run at once; more get 429 instead of queueing. */
const MAX_PASSWORD_CHECKS = 4;
let passwordChecks = 0;

function headerMac(header: string): Buffer {
  return createHmac("sha256", HEADER_MAC_KEY).update(header, "utf8").digest();
}

function headerMatches(header: unknown, config: CachedConfig): boolean {
  if (typeof header !== "string") return false;
  if (config.login.source === "env") return safeEqual(Buffer.from(header, "utf8"), config.fingerprint);
  return config.verifiedHeader !== undefined && safeEqual(headerMac(header), config.verifiedHeader);
}

function hasCorrectPassword(request: FastifyRequest, config: CachedConfig): boolean {
  return headerMatches(request.headers.authorization, config);
}

/** True or false for the password, or null when too many slow checks already run. */
async function verifyHeader(header: string, config: CachedConfig): Promise<boolean | null> {
  const login = config.login;
  if (headerMatches(header, config)) return true;
  if (login.source === "env") return false;
  const match = /^Basic\s+(\S+)$/i.exec(header);
  const decoded = match ? Buffer.from(match[1]!, "base64").toString("utf8") : "";
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  if (passwordChecks >= MAX_PASSWORD_CHECKS) return null;
  passwordChecks += 1;
  try {
    if (!(await verifyStoredPassword(login, decoded.slice(0, colon), decoded.slice(colon + 1)))) return false;
  } finally {
    passwordChecks -= 1;
  }
  config.verifiedHeader = headerMac(header);
  return true;
}

function activeRecord(key: string, now: number): FailureRecord | undefined {
  const record = failures.get(key);
  if (record && record.resetAt <= now) {
    failures.delete(key);
    return undefined;
  }
  return record;
}

/** Seconds this client must wait before trying a password again; 0 when it may try now. */
function lockoutSeconds(request: FastifyRequest): number {
  const now = Date.now();
  let seconds = 0;
  for (const bucket of failureBuckets(request)) {
    const record = activeRecord(bucket.key, now);
    if (record && record.guesses.size >= bucket.limit) {
      seconds = Math.max(seconds, Math.ceil((record.resetAt - now) / 1000), 1);
    }
  }
  return seconds;
}

/** Names a guess for the current login only, so a password change does not keep refusing it. */
function guessId(header: string, config: CachedConfig): string {
  return createHmac("sha256", HEADER_MAC_KEY)
    .update(config.fingerprint)
    .update("\0")
    .update(header)
    .digest("base64url")
    .slice(0, 16);
}

/** Counts a guess for this client before it is checked; a browser resending one saved password counts once. */
function countGuess(request: FastifyRequest, guess: string) {
  const now = Date.now();
  for (const bucket of failureBuckets(request)) {
    let record = activeRecord(bucket.key, now);
    if (!record) {
      if (failures.size >= MAX_TRACKED_CLIENTS) {
        for (const [entryKey, entry] of failures) if (entry.resetAt <= now) failures.delete(entryKey);
        if (failures.size >= MAX_TRACKED_CLIENTS) failures.delete(failures.keys().next().value!);
      }
      record = { guesses: new Set(), resetAt: now + BASIC_AUTH_FAILURE_WINDOW_MS };
      failures.set(bucket.key, record);
    }
    record.guesses.add(guess);
  }
}

function logWrongPassword(request: FastifyRequest) {
  for (const [index, bucket] of failureBuckets(request).entries()) {
    const size = failures.get(bucket.key)?.guesses.size ?? 0;
    if (index === 0 && size === 1) logger.warn("[basic-auth] Wrong password from %s", request.ip);
    if (size === bucket.limit) {
      logger.warn(
        index === 0
          ? "[basic-auth] %d wrong passwords from %s; refusing its sign-ins for %d minutes"
          : "[basic-auth] %d wrong passwords through %s; refusing every new sign-in from there for %d minutes",
        size,
        request.ip,
        Math.ceil(BASIC_AUTH_FAILURE_WINDOW_MS / 60_000),
      );
    }
  }
}

const checksInFlight = new Map<string, Promise<boolean | null>>();

/** Checks a Basic Authorization header and updates this client's wrong-password count; null when it must wait. */
async function checkCredentials(
  request: FastifyRequest,
  config: CachedConfig,
  header: string,
): Promise<boolean | null> {
  if (!headerMatches(header, config)) {
    const guess = guessId(header, config);
    const running = checksInFlight.get(guess);
    if (running) return running;
    const now = Date.now();
    // A password this client already got wrong is wrong again, so it skips the slow check.
    if (failureBuckets(request).some((bucket) => activeRecord(bucket.key, now)?.guesses.has(guess))) return false;
    // Counted before the slow check, in the same step as the caller's lockout check, so parallel
    // guesses see each other and cannot pass the limit.
    countGuess(request, guess);
    const check = verifyHeader(header, config);
    checksInFlight.set(guess, check);
    let verdict: boolean | null;
    try {
      verdict = await check;
    } finally {
      checksInFlight.delete(guess);
    }
    if (verdict === false) {
      logWrongPassword(request);
      return false;
    }
    for (const bucket of failureBuckets(request)) failures.get(bucket.key)?.guesses.delete(guess);
    if (verdict === null) return null;
  }
  // Shared counts belong to other visitors too, so signing in clears only this browser's own count.
  if (lockoutSeconds(request) === 0) {
    for (const bucket of failureBuckets(request)) if (!bucket.shared) failures.delete(bucket.key);
  }
  return true;
}

function sendTooManyFailures(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.status(429).send({ error: "Too many wrong passwords. Try again later." });
}

function sendBusy(reply: FastifyReply) {
  reply.header("Retry-After", "1");
  reply.status(429).send({ error: "Too many sign-ins at once. Try again in a moment." });
}

function sendChallenge(reply: FastifyReply, realm: string) {
  // Quote the realm and escape any embedded quotes / backslashes so the
  // header stays well-formed even if the user picks an exotic realm string.
  const safeRealm = realm.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  reply.header("WWW-Authenticate", `Basic realm="${safeRealm}", charset="UTF-8"`);
  reply.status(401).send({ error: "Authentication required" });
}

let lockdownAnnounced = false;

const REMOTE_ACCESS_DOCS_URL = "https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/REMOTE_ACCESS.md";

const LOCKDOWN_JSON_MESSAGE =
  "Non-loopback access requires authentication because no Basic Auth credentials are configured. " +
  "Set BASIC_AUTH_USER and BASIC_AUTH_PASS, or add this IP to IP_ALLOWLIST. " +
  `Other options: ${REMOTE_ACCESS_DOCS_URL}`;

const PROXIED_LOCKDOWN_JSON_MESSAGE =
  "This request came through a reverse proxy or tunnel on this computer, so it counts as remote. " +
  "Set BASIC_AUTH_USER and BASIC_AUTH_PASS. " +
  `Other options: ${REMOTE_ACCESS_DOCS_URL}`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wantsHtml(request: FastifyRequest): boolean {
  if (request.url.startsWith("/api/")) return false;
  const accept = request.headers.accept;
  const value = Array.isArray(accept) ? accept[0] : accept;
  return typeof value === "string" && value.toLowerCase().includes("text/html");
}

const PAGE_STYLE = `
  :root {
    color-scheme: dark;
    --bg: #0e1320;
    --panel: #161c2c;
    --panel-2: #1d2438;
    --border: #2a3350;
    --text: #e8ecf6;
    --muted: #9aa3bd;
    --accent: #f4a35d;
    --accent-soft: rgba(244, 163, 93, 0.12);
    --code-bg: #0a0f1c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: radial-gradient(1200px 800px at 80% -10%, #1a223a 0%, var(--bg) 60%) fixed;
    color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px 64px;
  }
  main {
    width: 100%;
    max-width: 720px;
  }
  header { margin-bottom: 24px; }
  .badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  h1 {
    font-size: 26px;
    line-height: 1.25;
    margin: 12px 0 8px;
    font-weight: 600;
  }
  p.lede { color: var(--muted); margin: 0; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 22px;
    margin-top: 16px;
  }
  .panel h2 {
    font-size: 17px;
    margin: 0 0 6px;
    font-weight: 600;
  }
  .panel .hint { color: var(--muted); font-size: 14px; margin: 0 0 12px; }
  .panel .detail { display: inline-block; margin-top: 12px; font-size: 13px; }
  ol { margin: 0; padding-left: 20px; }
  ol li { margin: 6px 0; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
  code {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 6px;
  }
  pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
    margin: 8px 0 0;
  }
  .ip-pill {
    display: inline-block;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 6px;
    padding: 1px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
  footer {
    margin-top: 20px;
    padding: 16px 22px;
    background: var(--panel-2);
    border: 1px dashed var(--border);
    border-radius: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  footer strong { color: var(--text); }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px dotted rgba(244,163,93,0.4); }
  a:hover { border-bottom-color: var(--accent); }
  .links {
    margin-top: 18px;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    font-size: 14px;
  }
`;

function renderLockdownPage(clientIp: string, proxied: boolean): string {
  const safeIp = escapeHtml(clientIp);
  const lede = proxied
    ? `This request reached Marinara through a reverse proxy or tunnel on this computer, so it counts as remote. To protect your data, the server refuses proxied traffic until you set a login. Follow the steps below, save <code>.env</code>, wait a couple of seconds, then refresh this page.`
    : `You're connecting from <span class="ip-pill">${safeIp}</span>, which isn't loopback. To protect your data, the server refuses non-local traffic until you choose how this device should authenticate. Pick one of the options below, save <code>.env</code>, wait a couple of seconds, then refresh this page.`;
  // The IP allowlist only helps direct devices. A proxied visitor shows the proxy's address.
  const secondOption = proxied
    ? ""
    : `<section class="panel">
      <h2>Option 2 — IP allowlist</h2>
      <p class="hint">Best when you only need a few known devices to connect — e.g. your phone on a home network, or specific Tailscale peers.</p>
      <ol>
        <li>Open your <code>.env</code> file in the Marinara Engine folder.</li>
        <li>Add this line. Your current IP is already filled in — add more entries (comma-separated, CIDR allowed) for other devices:
          <pre>IP_ALLOWLIST=${safeIp}</pre>
        </li>
        <li>Save <code>.env</code>, wait a couple of seconds, then refresh this page.</li>
      </ol>
      <a class="detail" href="https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/REMOTE_ACCESS.md#option-2-ip-allowlist" target="_blank" rel="noopener noreferrer">Detailed walkthrough →</a>
    </section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Marinara Engine — Set up access</title>
    <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <header>
      <span class="badge">Access blocked</span>
      <h1>This Marinara Engine install needs access control before remote devices can connect.</h1>
      <p class="lede">${lede}</p>
    </header>

    <section class="panel">
      <h2>Option 1 — Basic Auth (recommended)</h2>
      <p class="hint">Best for shared networks, Tailscale, or any device you don't fully control. The browser will prompt for the username and password once, then remember it.</p>
      <ol>
        <li>Open your <code>.env</code> file in the Marinara Engine folder.</li>
        <li>Add (or edit) these two lines, picking your own values:
          <pre>BASIC_AUTH_USER=yourname
BASIC_AUTH_PASS=a-long-random-password</pre>
        </li>
        <li>Save <code>.env</code>, wait a couple of seconds, then refresh this page and enter the credentials.</li>
      </ol>
      <a class="detail" href="https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/REMOTE_ACCESS.md#option-1-basic-auth-recommended" target="_blank" rel="noopener noreferrer">Detailed walkthrough →</a>
    </section>

    ${secondOption}

    <footer>
      <div class="links">
        <a href="${REMOTE_ACCESS_DOCS_URL}" target="_blank" rel="noopener noreferrer">Other options</a>
        <a href="https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/REMOTE_ACCESS.md" target="_blank" rel="noopener noreferrer">Full Remote Access walkthrough</a>
        <a href="https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/FAQ.md#how-do-i-access-marinara-engine-from-my-phone-or-another-device" target="_blank" rel="noopener noreferrer">FAQ: Access from another device</a>
        <a href="https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/TROUBLESHOOTING.md#app-not-loading-on-mobile--another-device" target="_blank" rel="noopener noreferrer">Troubleshooting</a>
      </div>
    </footer>
  </main>
</body>
</html>`;
}

function sendLockdown(request: FastifyRequest, reply: FastifyReply, proxied: boolean) {
  recordRefusal(request, "noLogin");
  if (wantsHtml(request)) {
    reply.status(403).header("Content-Type", "text/html; charset=utf-8").send(renderLockdownPage(request.ip, proxied));
    return;
  }
  reply
    .status(403)
    .send({ error: "Forbidden", message: proxied ? PROXIED_LOCKDOWN_JSON_MESSAGE : LOCKDOWN_JSON_MESSAGE });
}

/** Loopback, IP_ALLOWLIST and trusted Tailscale/Docker peers skip the password; a local proxy's visitors do not. */
function isTrustedPeer(request: FastifyRequest): boolean {
  return getRequestAccess(request).trustedPeer;
}

export function hasBasicAuthConfigured(): boolean {
  return loadConfig() !== null;
}

export function isBasicAuthSatisfied(request: FastifyRequest): boolean {
  const policy = getRequestAccess(request);
  if (policy.trustedPeer) return true;

  const config = loadConfig();
  if (!config) return !policy.lockedDown;

  if (requestSession(request, config)) return true;
  if (lockoutSeconds(request) > 0) return false;
  return hasCorrectPassword(request, config);
}

/** A same-origin path to return to after sign-in; anything else becomes "/". */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  try {
    const url = new URL(value, "http://marinara.invalid");
    const path = `${url.pathname}${url.search}${url.hash}`;
    // After normalising, a path starting with // or /\ would name another host.
    return url.origin === "http://marinara.invalid" && !/^\/[/\\]/.test(path) ? path : "/";
  } catch {
    return "/";
  }
}

function isLoginPath(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0];
  if (path === "/logout") return request.method === "POST";
  return path === "/login" && ["GET", "HEAD", "POST"].includes(request.method);
}

/** Browser page loads get the login page; scripts and API calls keep the Basic challenge. */
function wantsLoginPage(request: FastifyRequest): boolean {
  return (request.method === "GET" || request.method === "HEAD") && wantsHtml(request);
}

function redirectToLogin(request: FastifyRequest, reply: FastifyReply) {
  reply.redirect(`/login?next=${encodeURIComponent(safeNextPath(request.url))}`, 302);
}

// ── Fastify onRequest hook ──

export async function basicAuthHook(request: FastifyRequest, reply: FastifyReply) {
  // Exempt the health endpoint so external probes still work. Its reply adds
  // details for signed-in callers, so a password sent here counts like anywhere else.
  if (request.url === "/api/health" || request.url.startsWith("/api/health?")) {
    const header = request.headers.authorization;
    if (typeof header === "string" && !isTrustedPeer(request)) {
      const config = loadConfig();
      if (config && !requestSession(request, config) && lockoutSeconds(request) === 0) {
        await checkCredentials(request, config, header);
      }
    }
    return;
  }

  // Exempt loopback, IPs already vouched for by IP_ALLOWLIST, and traffic
  // arriving from a trusted Tailscale / Docker interface (when its bypass
  // flag is on).
  const ip = request.ip;
  const policy = getRequestAccess(request);
  if (policy.trustedPeer) return;

  const config = loadConfig();

  // No credentials configured → fail closed for every non-loopback IP unless
  // the operator has explicitly opted back into private/public unauthenticated access.
  if (!config) {
    if (!policy.lockedDown) return;
    const proxied = policy.forwardedLoopback;
    if (!lockdownAnnounced) {
      if (proxied) {
        logger.warn(
          "[basic-auth] Refused a connection forwarded by a reverse proxy or tunnel on this computer. No auth configured; set BASIC_AUTH_USER/BASIC_AUTH_PASS. Other options: %s",
          REMOTE_ACCESS_DOCS_URL,
        );
      } else {
        logger.warn(
          "[basic-auth] Refused non-loopback connection from %s. No auth configured; set BASIC_AUTH_USER/BASIC_AUTH_PASS or add the IP to IP_ALLOWLIST. Other options: %s",
          ip,
          REMOTE_ACCESS_DOCS_URL,
        );
      }
      lockdownAnnounced = true;
    }
    sendLockdown(request, reply, proxied);
    return reply;
  }

  if (isLoginPath(request) || requestSession(request, config)) return;

  const header = request.headers.authorization;
  if (typeof header !== "string" && wantsLoginPage(request)) {
    redirectToLogin(request, reply);
    return reply;
  }

  const retryAfter = lockoutSeconds(request);
  if (retryAfter > 0) {
    sendTooManyFailures(reply, retryAfter);
    return reply;
  }

  const verdict = typeof header === "string" ? await checkCredentials(request, config, header) : false;
  if (verdict === null) {
    sendBusy(reply);
    return reply;
  }
  if (!verdict) {
    if (wantsLoginPage(request)) redirectToLogin(request, reply);
    else sendChallenge(reply, config.realm);
    return reply;
  }
}

/** Signs the current browser in, e.g. after it set the login, so it is not sent to /login next. */
export function rememberLoginInBrowser(request: FastifyRequest, reply: FastifyReply) {
  const config = loadConfig();
  if (config) startBrowserSession(request, reply, config);
}

/** The owner's list of signed-in browsers; never the token or its hash. */
export function describeSessions(request: FastifyRequest) {
  const config = loadConfig();
  const key = config && sessionLoginKey(config);
  if (!config || !key) return [];
  const current = requestSession(request, config)?.id;
  return listSessions(key).map(({ id, label, createdAt, lastSeenAt }) => ({
    id,
    label,
    createdAt,
    lastSeenAt,
    current: id === current,
  }));
}

export function endSession(id: string): boolean {
  const config = loadConfig();
  const key = config && sessionLoginKey(config);
  return key ? deleteSession(key, id) : false;
}

/** Signs out every browser except the caller's own. */
export function endOtherSessions(request: FastifyRequest): void {
  const config = loadConfig();
  const key = config && sessionLoginKey(config);
  if (key) deleteOtherSessions(key, requestSession(request, config)?.id);
}

/** True when the caller is a browser that signed in on /login. */
export function hasBrowserSession(request: FastifyRequest): boolean {
  const config = loadConfig();
  return config !== null && requestSession(request, config) !== null;
}

// ── Pairing codes ──

/** No 0/O or 1/I/L: the code is read off one screen and typed on another. */
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
const MAX_PAIRING_CODES = 10;

/** Keyed hashes in memory only, so a restart ends every code. */
let pairingCodes: { hash: Buffer; loginKey: string; expiresAt: number }[] = [];

/** Ignores case and the spaces or dash people type between the halves. */
function pairingHash(value: string): Buffer {
  return createHmac("sha256", HEADER_MAC_KEY)
    .update("pairing\0")
    .update(value.toUpperCase().replace(/[\s-]/g, ""))
    .digest();
}

/** A code that signs one more browser in to the current login, once, for a few minutes. */
export function createPairingCode(): { code: string; expiresAt: number } | null {
  const config = loadConfig();
  const loginKey = config && sessionLoginKey(config);
  if (!loginKey) return null;
  const now = Date.now();
  const code = Array.from(
    { length: PAIRING_CODE_LENGTH },
    () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)],
  ).join("");
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  pairingCodes = [
    ...pairingCodes.filter((entry) => entry.expiresAt > now),
    { hash: pairingHash(code), loginKey, expiresAt },
  ];
  pairingCodes = pairingCodes.slice(-MAX_PAIRING_CODES);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

/** Uses up a live code of the login `loginKey`; every stored hash is compared in constant time. */
function redeemPairingCode(hash: Buffer, loginKey: string): boolean {
  const now = Date.now();
  const match = pairingCodes.filter((entry) => safeEqual(entry.hash, hash)).at(0);
  if (!match || match.expiresAt <= now || match.loginKey !== loginKey) return false;
  pairingCodes = pairingCodes.filter((entry) => entry !== match);
  return true;
}

// ── Login page ──

function renderLoginPage(next: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <!-- Overrides no-referrer here, so the form posts its real Origin, not "null". -->
    <meta name="referrer" content="same-origin" />
    <title>Marinara Engine — Sign in</title>
    <style>${PAGE_STYLE}
      main { max-width: 400px; }
      label { display: block; margin: 14px 0 6px; font-size: 14px; color: var(--muted); }
      input { width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; }
      input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button { margin-top: 20px; width: 100%; padding: 10px 12px; font: inherit; font-weight: 600; color: var(--bg); background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
      .error { margin: 0 0 4px; color: #f8a5a5; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="badge">Sign in</span>
        <h1>Marinara Engine</h1>
      </header>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form class="panel" method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label for="user">Username</label>
        <input id="user" name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>
      <form class="panel" method="post" action="/login">
        <h2>Sign in with a code</h2>
        <p class="hint">On a device that is signed in, or on the computer that runs Marinara, open Settings &rarr; Advanced &rarr; Access and choose Add a device.</p>
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label for="code">Pairing code</label>
        <input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="16" required />
        <button type="submit">Sign in with code</button>
      </form>
    </main>
  </body>
</html>`;
}

function sendLoginPage(reply: FastifyReply, status: number, next: string, error?: string) {
  return reply.status(status).header("Content-Type", "text/html; charset=utf-8").send(renderLoginPage(next, error));
}

export async function loginRoutes(app: FastifyInstance) {
  // The login form posts urlencoded fields; this parser stays inside these routes.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  app.get<{ Querystring: { next?: string } }>("/login", async (request, reply) => {
    const next = safeNextPath(request.query.next);
    if (!loadConfig() || isBasicAuthSatisfied(request)) return reply.redirect(next, 302);
    if (!cookieValue(request, PRE_AUTH_COOKIE)) {
      const secure = isHttpsRequest(request) ? "; Secure" : "";
      reply.header(
        "Set-Cookie",
        `${PRE_AUTH_COOKIE}=${randomBytes(16).toString("base64url")}; Path=/login; HttpOnly; SameSite=Lax${secure}`,
      );
    }
    return sendLoginPage(reply, 200, next);
  });

  app.post<{ Body: { user?: unknown; password?: unknown; code?: unknown; next?: unknown } | undefined }>(
    "/login",
    async (request, reply) => {
      const body = request.body ?? {};
      const next = safeNextPath(body.next);
      const config = loadConfig();
      if (!config) return reply.redirect(next, 303);

      const retryAfter = lockoutSeconds(request);
      if (retryAfter > 0) {
        reply.header("Retry-After", String(retryAfter));
        return sendLoginPage(reply, 429, next, "Too many wrong passwords. Try again later.");
      }
      if (typeof body.code === "string") {
        const hash = pairingHash(body.code);
        const key = sessionLoginKey(config);
        if (!key || !redeemPairingCode(hash, key)) {
          // Wrong codes count like wrong passwords, so guessing one locks the address out the same way.
          countGuess(request, `code:${hash.toString("base64url").slice(0, 16)}`);
          logWrongPassword(request);
          return sendLoginPage(reply, 401, next, "This code does not work. Ask for a new one.");
        }
        if (!startBrowserSession(request, reply, config)) {
          return sendLoginPage(reply, 500, next, "This browser cannot stay signed in. See the server log.");
        }
        logger.info("[login] A device signed in with a pairing code");
        return reply.redirect(next, 303);
      }
      const user = typeof body.user === "string" ? body.user : "";
      const password = typeof body.password === "string" ? body.password : "";
      const verdict = await checkCredentials(request, config, buildExpectedHeader(user, password));
      if (verdict === null) return sendLoginPage(reply, 429, next, "Too many sign-ins at once. Try again in a moment.");
      if (!verdict) return sendLoginPage(reply, 401, next, "Wrong username or password.");

      if (!startBrowserSession(request, reply, config)) {
        return sendLoginPage(reply, 500, next, "This browser cannot stay signed in. See the server log.");
      }
      return reply.redirect(next, 303);
    },
  );

  app.post("/logout", async (request, reply) => {
    const config = loadConfig();
    const session = config && requestSession(request, config);
    if (session) endSession(session.id);
    const secure = isHttpsRequest(request) ? "; Secure" : "";
    reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    return reply.redirect("/login", 303);
  });
}
