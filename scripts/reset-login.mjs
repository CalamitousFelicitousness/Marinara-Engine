// Removes the remote login saved in the app (DATA_DIR/.remote-login.json) and
// signs every browser out (DATA_DIR/.remote-sessions.json). A running server
// notices within a few seconds. A login set with BASIC_AUTH_USER and
// BASIC_AUTH_PASS in .env is not touched. In Docker, run instead:
//   docker exec <container> rm -f /app/data/.remote-login.json /app/data/.remote-sessions.json
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLauncherEnvValue } from "./read-launcher-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = join(root, "packages", "server");
// Same .env the server reads: MARINARA_ENV_FILE (relative to the repo root) or the root .env.
const envPath = resolve(root, process.env.MARINARA_ENV_FILE?.trim() || ".env");
const configured =
  process.env.DATA_DIR?.trim() ||
  (existsSync(envPath) ? readLauncherEnvValue(readFileSync(envPath, "utf8"), "DATA_DIR")?.trim() : null);
const dataDir = configured ? resolve(serverRoot, configured) : join(serverRoot, "data");
const loginFile = join(dataDir, ".remote-login.json");

if (existsSync(loginFile)) {
  rmSync(loginFile);
  console.log(
    `Removed the app login (${loginFile}). Remote devices need a new login; this computer still opens Marinara without one.`,
  );
} else {
  console.log(`No app login found at ${loginFile}.`);
}
rmSync(join(dataDir, ".remote-sessions.json"), { force: true });
