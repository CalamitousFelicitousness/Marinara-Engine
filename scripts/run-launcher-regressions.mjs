#!/usr/bin/env node
// Runs the launcher regressions one after another, each under its own time limit (#8601). A check that hangs
// (for example on a child process that never exits) then fails within minutes and is named in the log,
// instead of silently using up the whole CI job.
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Each one takes about 10 s or less on the slowest CI runner (macOS Intel).
const TIMEOUT_MS = 120_000;
const SCRIPTS = [
  "scripts/regressions/pnpm-runner.regression.mjs",
  "scripts/regressions/launcher/env.regression.mjs",
  "scripts/regressions/launcher/existing-server.regression.mjs",
  "scripts/regressions/launcher/update.regression.mjs",
  "scripts/regressions/dev-launcher-process.regression.mjs",
  "scripts/regressions/launcher/format-guard.regression.mjs",
  "scripts/regressions/launcher/server-build.regression.mjs",
  "scripts/check-windows-installer-layout.mjs",
];

let current = null;

// The script gets its own process group, so a stop or a timeout reaches everything it started.
function stopCurrent(signal) {
  if (!current?.pid || current.exitCode !== null || current.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(current.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-current.pid, signal);
  } catch (err) {
    if (err?.code !== "ESRCH") throw err;
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopCurrent("SIGKILL");
    process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
  });
}

function run(script) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    console.log(`[launcher regressions] START ${script}`);
    current = spawn(process.execPath, [script], {
      cwd: repositoryRoot,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[launcher regressions] TIMEOUT after ${TIMEOUT_MS / 1000}s: ${script}; stopping it.`);
      stopCurrent("SIGKILL");
    }, TIMEOUT_MS);
    current.once("error", (error) => {
      clearTimeout(timer);
      console.error(`[launcher regressions] Could not start ${script}: ${error.message}`);
      resolveRun(false);
    });
    // "exit", not "close": a leftover grandchild sharing this output must not keep the run waiting.
    current.once("exit", (code, signal) => {
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0 && !timedOut) {
        console.log(`[launcher regressions] PASS ${script} (${seconds}s)`);
        resolveRun(true);
        return;
      }
      const reason = timedOut ? "timed out" : `exited with ${signal ?? code}`;
      console.error(`[launcher regressions] FAIL ${script} ${reason} (${seconds}s)`);
      resolveRun(false);
    });
  });
}

for (const script of SCRIPTS) {
  if (!(await run(script))) {
    process.exitCode = 1;
    break;
  }
}
current = null;
