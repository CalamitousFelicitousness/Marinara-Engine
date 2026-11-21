// Where the sandbox instance lives and what it must stay clear of.
// Shared by make-sandbox-data.mjs (which builds the data) and run-sandbox.mjs (which starts on it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(repoRoot, "packages", "server");

/** Written by make-sandbox-data.mjs once its leak check passes. run-sandbox.mjs starts nothing without it. */
export const SANDBOX_MARKER = ".sandbox-data.json";
// Beside the checkout, never inside it: a clean or a branch switch must not touch them.
export const DEFAULT_SANDBOX_DATA_DIR = path.resolve(repoRoot, "..", "marinara-sandbox-data");
export const DEFAULT_SANDBOX_ENV_FILE = path.resolve(repoRoot, "..", "marinara-sandbox.env");
export const DEFAULT_SANDBOX_PORTS = { server: 7880, client: 7881 };

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** A path from an env file, resolved as packages/server/src/config/runtime-config.ts resolves it. */
export function resolveFromServerRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(serverRoot, value);
}

/** The folders and ports the repo .env gives the real install. FILE_STORAGE_DIR wins over DATA_DIR/storage. */
export function resolveRealInstall(envFile = path.join(repoRoot, ".env")) {
  const env = readEnvFile(envFile);
  const dataRaw = env.DATA_DIR?.trim();
  const storageRaw = (env.FILE_STORAGE_DIR ?? env.MARINARA_FILE_STORAGE_DIR)?.trim();
  const dataDir = dataRaw ? resolveFromServerRoot(dataRaw) : path.join(serverRoot, "data");
  return {
    envFile,
    dataDir,
    storageDir: storageRaw ? resolveFromServerRoot(storageRaw) : path.join(dataDir, "storage"),
    port: Number.parseInt(env.PORT ?? "", 10) || 7860,
    clientPort: Number.parseInt(env.VITE_PORT ?? "", 10) || 5173,
  };
}

function canonical(target) {
  let resolved = path.resolve(target);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Not there yet: compare the path as written.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(left, right) {
  return canonical(left) === canonical(right);
}

/** True when one folder is the other or lies inside it. */
export function foldersOverlap(left, right) {
  const inside = (child, parent) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const [a, b] = [canonical(left), canonical(right)];
  return inside(a, b) || inside(b, a);
}

export function isSandboxData(dir) {
  return fs.existsSync(path.join(dir, SANDBOX_MARKER));
}

/** Why the scrubber may not write its output to `to`. Replacing a folder deletes it first. */
export function findOutputProblems({ from, to, force, real = resolveRealInstall() }) {
  const problems = [];
  for (const [label, dir] of [
    ["the real install's data folder", real.dataDir],
    ["the real install's storage folder", real.storageDir],
    ["its own source", from],
  ]) {
    if (foldersOverlap(to, dir)) problems.push(`--to overlaps ${label} (${dir})`);
  }
  const occupied = fs.existsSync(to) && fs.readdirSync(to).length > 0;
  if (occupied && !force) problems.push("--to is not empty (pass --force to replace an earlier sandbox)");
  if (occupied && force && !isSandboxData(to)) {
    problems.push(`--to holds files but no ${SANDBOX_MARKER}, so --force will not delete it`);
  }
  return problems;
}
