// ──────────────────────────────────────────────
// Config: remote login
// ──────────────────────────────────────────────
// One answer to "which login protects remote access", shared by the Basic Auth
// gate, the access policy and the access status. BASIC_AUTH_USER and
// BASIC_AUTH_PASS in .env win when both are set; otherwise the login saved in
// the app at DATA_DIR/.remote-login.json applies. Deleting that file removes
// the login within RECHECK_MS, like an .env edit.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import { DATA_DIR } from "../utils/data-dir.js";
import { getBasicAuthConfig } from "./runtime-config.js";

export type StoredLogin = { user: string; salt: string; hash: string; N: number; r: number; p: number };
export type LoginConfig = { source: "env"; user: string; pass: string } | ({ source: "app" } & StoredLogin);

export const MIN_LOGIN_PASSWORD_LENGTH = 10;
const LOGIN_FILE = join(DATA_DIR, ".remote-login.json");
/** Matches the .env watcher, so a reset takes effect as fast as an .env edit. */
const RECHECK_MS = 2_000;
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1 };
const HASH_BYTES = 32;

let envLogin: Extract<LoginConfig, { source: "env" }> | null = null;
let fileState: { checkedAt: number; stamp: string; login: LoginConfig | null } | null = null;
let setupCode: string | null = null;

export function getLoginConfig(): LoginConfig | null {
  const { user, pass } = getBasicAuthConfig();
  if (user && pass) {
    if (envLogin?.user !== user || envLogin.pass !== pass) envLogin = { source: "env", user, pass };
    return envLogin;
  }
  const now = Date.now();
  if (fileState && now - fileState.checkedAt < RECHECK_MS) return fileState.login;
  let stamp = "";
  try {
    const stats = statSync(LOGIN_FILE);
    stamp = `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    // No file means no app login.
  }
  if (fileState?.stamp === stamp) fileState.checkedAt = now;
  else fileState = { checkedAt: now, stamp, login: stamp ? readLoginFile() : null };
  return fileState.login;
}

function isStoredLogin(value: unknown): value is StoredLogin {
  const v = value as Partial<StoredLogin> | null;
  return (
    typeof v?.user === "string" &&
    v.user.length > 0 &&
    typeof v.salt === "string" &&
    typeof v.hash === "string" &&
    Buffer.from(v.hash, "base64").length >= 16 &&
    Number.isInteger(v.N) &&
    v.N! >= 2 ** 10 &&
    v.N! <= 2 ** 20 &&
    (v.N! & (v.N! - 1)) === 0 &&
    Number.isInteger(v.r) &&
    v.r! >= 1 &&
    v.r! <= 32 &&
    Number.isInteger(v.p) &&
    v.p! >= 1 &&
    v.p! <= 16
  );
}

function readLoginFile(): LoginConfig | null {
  try {
    const { user, salt, hash, N, r, p } = JSON.parse(readFileSync(LOGIN_FILE, "utf8")) as StoredLogin;
    const login = { user, salt, hash, N, r, p };
    if (isStoredLogin(login)) return { source: "app", ...login };
  } catch {
    // Reported below.
  }
  logger.warn("[login] %s is damaged, so no app login applies. Set the login again or delete the file.", LOGIN_FILE);
  return null;
}

/** Constant-time text compare; hashing first hides the length. */
function sameText(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

function deriveHash(password: string, salt: Buffer, params: Pick<StoredLogin, "N" | "r" | "p">, bytes = HASH_BYTES) {
  const { N, r, p } = params;
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, bytes, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function verifyStoredPassword(login: StoredLogin, user: string, password: string): Promise<boolean> {
  const expected = Buffer.from(login.hash, "base64");
  const actual = await deriveHash(password, Buffer.from(login.salt, "base64"), login, expected.length);
  return timingSafeEqual(actual, expected) && sameText(user, login.user);
}

/** Saves the app login (mode 0600, atomic) and ends the setup code. */
export async function setStoredLogin(user: string, password: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await deriveHash(password, salt, SCRYPT_PARAMS);
  const record: StoredLogin = { user, salt: salt.toString("base64"), hash: hash.toString("base64"), ...SCRYPT_PARAMS };
  mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${LOGIN_FILE}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, LOGIN_FILE);
  fileState = null;
  setupCode = null;
}

export function clearStoredLogin(): void {
  try {
    unlinkSync(LOGIN_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fileState = null;
}

/**
 * A browser on the Docker host reaches the server through the Docker gateway, not
 * loopback, so it cannot set the first login without ADMIN_SECRET. This code, shown
 * only in the server log, stands in for ADMIN_SECRET for that first login. New on
 * every start, used once, and gone as soon as any login exists.
 */
export function announceLoginSetupCode(): void {
  if (getLoginConfig()) return;
  setupCode = randomBytes(12).toString("hex");
  logger.warn(
    "[login] No remote login is set. To set one from a device that is not this computer, use this one-time setup code: %s",
    setupCode,
  );
}

export function isLoginSetupCode(value: unknown): boolean {
  if (setupCode && getLoginConfig()) setupCode = null;
  return setupCode !== null && typeof value === "string" && sameText(value, setupCode);
}

/** Call after isLoginSetupCode passed and before any await, so a code works once. */
export function consumeLoginSetupCode(): void {
  setupCode = null;
}
