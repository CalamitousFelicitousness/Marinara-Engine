// ──────────────────────────────────────────────
// Fork Guard — dev-server port resolution
// ──────────────────────────────────────────────
//
// This fork patches two files so `pnpm dev` honours PORT from the repo-root
// .env, the same file the server reads via config/runtime-config.ts. Without
// those patches the readiness probe and the client's /api proxy both fall back
// to 7860 while the server binds whatever .env says, and `pnpm dev` dies after
// the full 120s timeout with "Server did not become ready ... fetch failed" and
// no hint that a port was involved.
//
// An upstream merge that touches either file can drop the patch silently, so
// this guard runs inside `pnpm check` rather than in the slow regression lane.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_RUNNER = resolve(ROOT, "scripts/dev.mjs");
const VITE_CONFIG = resolve(ROOT, "packages/client/vite.config.ts");

const failures = [];

function read(path) {
  if (!existsSync(path)) {
    failures.push(`Missing ${relative(ROOT, path)}.`);
    return null;
  }
  return readFileSync(path, "utf8");
}

function require_(condition, message) {
  if (!condition) failures.push(message);
}

const devRunner = read(DEV_RUNNER);
if (devRunner) {
  require_(
    devRunner.includes("process.loadEnvFile("),
    "scripts/dev.mjs no longer loads the repo-root .env, so its readiness probe will poll the default 7860 while the server binds the .env PORT. Restore the loadRepoEnvFile() call.",
  );
  require_(
    devRunner.includes("MARINARA_ENV_FILE"),
    "scripts/dev.mjs stopped honouring MARINARA_ENV_FILE, so it diverges from the server's env-file resolution in config/runtime-config.ts.",
  );
}

const viteConfig = read(VITE_CONFIG);
if (viteConfig) {
  const loadIndex = viteConfig.indexOf("process.loadEnvFile(");
  const portConstIndex = viteConfig.indexOf("const DEV_SERVER_PORT");

  require_(
    loadIndex !== -1,
    "packages/client/vite.config.ts no longer loads the repo-root .env, so a standalone `pnpm dev:client` proxies /api to the default 7860. Restore the loadEnvFile call.",
  );

  // Ordering is the subtle half of the fix: these constants are evaluated at
  // module load, so a load moved below them (or into the config factory) reads
  // the environment too late and silently reverts to 5173/7860 — and would also
  // stop .env from being able to switch the browser auto-open off.
  const openConstIndex = viteConfig.indexOf("const DEV_SERVER_OPEN");
  for (const [name, index] of [
    ["DEV_SERVER_PORT", portConstIndex],
    ["DEV_SERVER_OPEN", openConstIndex],
  ]) {
    if (loadIndex === -1 || index === -1) continue;
    require_(
      loadIndex < index,
      `packages/client/vite.config.ts loads the repo-root .env after ${name} is computed. These constants evaluate at module load, so the load must stay above them.`,
    );
  }

  require_(
    /target:\s*`http:\/\/127\.0\.0\.1:\$\{process\.env\.PORT/.test(viteConfig),
    "packages/client/vite.config.ts no longer derives its /api proxy target from process.env.PORT, so the client can proxy to a port the server is not listening on.",
  );
}

if (failures.length > 0) {
  process.stderr.write("[dev-ports] Fork patch for dev-server port resolution is missing or altered:\n");
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.stderr.write("[dev-ports] See FORK-CHANGES.md for why this fork carries the patch.\n");
  process.exit(1);
}

process.stdout.write("[dev-ports] dev.mjs and vite.config.ts resolve PORT from the repo .env.\n");
