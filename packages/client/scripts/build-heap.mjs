/* global process, URL */
import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";

// The client build needs about 1.2 GiB of Node.js heap: it runs out of memory at 1024 and
// 1152 MiB and passes at 1280 MiB. Give it 1536 MiB when half the device's memory allows,
// and never less than the 1280 MiB it needs.
const BUILD_HEAP_TARGET_MB = 1536;
const BUILD_HEAP_FLOOR_MB = 1280;

/**
 * The heap (MiB) a low-memory (Termux) client build runs with, or null to keep the inherited
 * limit. Termux starts the server with a smaller heap that every child inherits, including the
 * in-app updater's build, so the build sets its own. A heap the user set in NODE_OPTIONS wins:
 * start-termux.sh marks it with MARINARA_EXPLICIT_NODE_HEAP. Older launchers do not.
 */
export function resolveClientBuildHeapMb({ lowMemory, env = process.env, totalMemoryBytes = totalmem() }) {
  if (!lowMemory || env.MARINARA_EXPLICIT_NODE_HEAP === "1") return null;
  const deviceCapMb = Math.floor(totalMemoryBytes / 1024 / 1024 / 2 / 128) * 128;
  return Math.min(BUILD_HEAP_TARGET_MB, Math.max(BUILD_HEAP_FLOOR_MB, deviceCapMb));
}

// A desktop build also type-checks the client first, which needs about 2.1 GiB of heap. Node's
// default heap scales with the machine's memory: about 4 GiB with 16 GiB or more, but only about
// 2 GiB on a 7 GiB machine (the macos-15 runners), where the type-check runs out of memory. Give it
// 3072 MiB when half the device's memory allows, and never less than Node would have given it.
const DESKTOP_BUILD_HEAP_TARGET_MB = 3072;

/**
 * The heap (MiB) a desktop client build runs with, or null to keep the inherited limit: when Node's
 * own default is already enough, or when NODE_OPTIONS already sets a heap (the user's, which wins).
 */
export function resolveDesktopClientBuildHeapMb({
  env = process.env,
  totalMemoryBytes = totalmem(),
  defaultHeapMb = Math.floor(getHeapStatistics().heap_size_limit / 1024 / 1024),
} = {}) {
  if (/--max-old-space-size/u.test(env.NODE_OPTIONS ?? "")) return null;
  const deviceCapMb = Math.floor(totalMemoryBytes / 1024 / 1024 / 2 / 128) * 128;
  const heapMb = Math.min(DESKTOP_BUILD_HEAP_TARGET_MB, deviceCapMb);
  return heapMb > defaultHeapMb ? heapMb : null;
}

/**
 * The v2.4.6 Termux launcher runs `vite build` directly under the server's heap, which this
 * client no longer fits in, and it keeps running after updating itself. When vite.config.ts is
 * loaded by such a build on Android, hand it to scripts/build.mjs, which sets the heap and also
 * builds the multiplayer guest bundle, and exit with its status.
 */
export function delegateDirectAndroidBuild({ platform = process.platform, env = process.env } = {}) {
  if (env.MARINARA_CLIENT_BUILD_SCRIPT === "1") return;
  if (resolveClientBuildHeapMb({ lowMemory: platform === "android", env }) === null) return;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build.mjs", import.meta.url))], {
    env: { ...env, MARINARA_LOW_MEMORY_BUILD: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
