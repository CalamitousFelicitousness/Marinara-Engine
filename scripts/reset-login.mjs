// Removes the remote login saved in the app (DATA_DIR/.remote-login.json). A
// running server notices within a few seconds. A login set with BASIC_AUTH_USER
// and BASIC_AUTH_PASS in .env is not touched. In Docker, run instead:
//   docker exec <container> rm /app/data/.remote-login.json
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLauncherEnvValue } from "./read-launcher-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = join(root, "packages", "server");
const envPath = join(root, ".env");
const configured =
  process.env.DATA_DIR?.trim() ||
  (existsSync(envPath) ? readLauncherEnvValue(readFileSync(envPath, "utf8"), "DATA_DIR")?.trim() : null);
const file = join(configured ? resolve(serverRoot, configured) : join(serverRoot, "data"), ".remote-login.json");

if (existsSync(file)) {
  rmSync(file);
  console.log(
    `Removed the app login (${file}). Remote devices need a new login; this computer still opens Marinara without one.`,
  );
} else {
  console.log(`No app login found at ${file}.`);
}
