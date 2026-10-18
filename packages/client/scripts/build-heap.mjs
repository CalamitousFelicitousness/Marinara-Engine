/* global process, URL */
import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

// Measured Vite heap needs. Without PWA generation (low-memory) it runs out of memory at 1152 MiB
// and passes at 1280 MiB; with it (desktop) it runs out at 1280 MiB and passes at 1536 MiB.
// Each build gets its target when half the device's memory allows, and never less than its floor.
const LOW_MEMORY_HEAP = { targetMb: 1536, floorMb: 1280 };
const DESKTOP_HEAP = { targetMb: 2048, floorMb: 1536 };
// The flag as one of the options Node reads, however its name is spelled (Node reads - and _ alike),
// including the -percentage form (Node 24+).
const HEAP_OPTION = /^--max[-_]old[-_]space[-_]size(?:[-_]percentage)?(?:=|$)/u;

/**
 * NODE_OPTIONS split into options as Node reads it: whitespace separates them, double quotes group
 * one (spaces included), and a backslash inside quotes takes the next character as it is.
 */
export function splitNodeOptions(nodeOptions) {
  const options = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < nodeOptions.length; index += 1) {
    const char = nodeOptions[index];
    if (quoted && char === "\\" && index + 1 < nodeOptions.length) {
      current += nodeOptions[(index += 1)];
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/u.test(char)) {
      if (started) options.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) options.push(current);
  return options;
}

/**
 * The heap (MiB) the client build runs with, or null to keep the inherited limit. Node's default
 * limit scales with device memory and falls below the build's needs on smaller machines.
 * A heap the user set wins. Termux starts the server with its own smaller heap, so start-termux.sh
 * marks the user's with MARINARA_EXPLICIT_NODE_HEAP; desktop launchers set none, so any heap in
 * NODE_OPTIONS there is the user's. In a container, half of its memory limit, not of the machine's.
 */
export function resolveClientBuildHeapMb({
  lowMemory,
  env = process.env,
  totalMemoryBytes = totalmem(),
  constrainedMemoryBytes = process.constrainedMemory?.() ?? 0,
}) {
  const explicitHeap = lowMemory
    ? env.MARINARA_EXPLICIT_NODE_HEAP === "1"
    : splitNodeOptions(env.NODE_OPTIONS ?? "").some((option) => HEAP_OPTION.test(option));
  if (explicitHeap) return null;
  const { targetMb, floorMb } = lowMemory ? LOW_MEMORY_HEAP : DESKTOP_HEAP;
  // 0, or more than the machine's memory, when there is no container limit.
  const memoryBytes =
    constrainedMemoryBytes > 0 ? Math.min(totalMemoryBytes, constrainedMemoryBytes) : totalMemoryBytes;
  const deviceCapMb = Math.floor(memoryBytes / 1024 / 1024 / 2 / 128) * 128;
  return Math.min(targetMb, Math.max(floorMb, deviceCapMb));
}

/**
 * The v2.4.6 Termux launcher runs `vite build` directly under the server's heap, which this
 * client no longer fits in, and it keeps running after updating itself. When vite.config.ts is
 * loaded by such a build on Android, hand it to scripts/build.mjs, which sets the heap and also
 * builds the multiplayer guest bundle, and exit with its status.
 */
export function delegateDirectAndroidBuild({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "android" || env.MARINARA_CLIENT_BUILD_SCRIPT === "1") return;
  if (resolveClientBuildHeapMb({ lowMemory: true, env }) === null) return;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build.mjs", import.meta.url))], {
    env: { ...env, MARINARA_LOW_MEMORY_BUILD: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
