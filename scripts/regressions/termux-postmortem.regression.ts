// #5506 diagnostics: the session heartbeat/postmortem. An externally killed
// Termux server leaves no in-process trace, so the NEXT startup is the
// witness: a silent file-only heartbeat plus a clean-exit stamp lets startup
// classify the previous session's fate and surface it in Support
// Diagnostics. HARD CONSTRAINT (maintainer call): the heartbeat must be
// console-silent at runtime - users read the console for other things.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");
const flatten = (source: string) => source.replace(/\s+/gu, " ");

// ── Functional: real module against a temp DATA_DIR ─────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "marinara-postmortem-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
try {
  const {
    buildUncleanExitRecord,
    getLastUncleanExit,
    getUncleanExitHistory,
    markCleanSessionExit,
    startSessionPostmortem,
  } = await import("../../packages/server/src/lib/session-postmortem.js");

  // Pure semantics: clean stamps report nothing; reboot detection needs both
  // boot ids; uptime is beat minus start.
  const previousBeat = {
    pid: 4242,
    bootId: "boot-a",
    startedAt: "2026-09-01T10:00:00.000Z",
    lastBeatAt: "2026-09-01T13:30:00.000Z",
    rssMiB: 119.3,
    heapUsedMiB: 83.4,
  };
  assert.equal(buildUncleanExitRecord({ ...previousBeat, cleanExit: true }, "boot-b", "now"), null);
  const rebooted = buildUncleanExitRecord(previousBeat, "boot-b", "2026-09-02T08:00:00.000Z");
  assert.ok(rebooted);
  assert.equal(rebooted.rebootedSince, true);
  assert.equal(rebooted.uptimeMs, 3.5 * 60 * 60 * 1000);
  assert.equal(rebooted.rssMiB, 119.3);
  assert.equal(buildUncleanExitRecord(previousBeat, "boot-a", "now")?.rebootedSince, false);
  assert.equal(buildUncleanExitRecord({ ...previousBeat, bootId: null }, "boot-a", "now")?.rebootedSince, null);

  // Round trip: a pre-existing heartbeat WITHOUT the clean stamp is reported
  // at startup and lands in the rolling history file.
  mkdirSync(join(dataDir, "diagnostics"), { recursive: true });
  writeFileSync(join(dataDir, "diagnostics", "session-heartbeat.json"), JSON.stringify(previousBeat));
  const record = startSessionPostmortem();
  assert.ok(record, "an uncleanly ended previous session must be reported");
  assert.equal(record.pid, 4242);
  assert.equal(getLastUncleanExit()?.pid, 4242);
  assert.equal(getUncleanExitHistory().length, 1);
  const historyOnDisk = JSON.parse(readFileSync(join(dataDir, "diagnostics", "unclean-exits.json"), "utf8"));
  assert.equal(historyOnDisk.length, 1);

  // The live heartbeat replaced the old file and is NOT clean-stamped.
  const liveBeat = JSON.parse(readFileSync(join(dataDir, "diagnostics", "session-heartbeat.json"), "utf8"));
  assert.equal(liveBeat.pid, process.pid);
  assert.equal(liveBeat.cleanExit, undefined);

  // A graceful shutdown stamps clean - the next startup reports nothing.
  markCleanSessionExit();
  const stamped = JSON.parse(readFileSync(join(dataDir, "diagnostics", "session-heartbeat.json"), "utf8"));
  assert.equal(stamped.cleanExit, true);
  assert.equal(buildUncleanExitRecord(stamped, "boot-x", "now"), null);
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
}

// ── Source pins ─────────────────────────────────────────────────────────────
const postmortemSource = readSource("packages/server/src/lib/session-postmortem.ts");
const postmortemFlat = flatten(postmortemSource);
// Console-silent at runtime: the interval body must never log - its only
// console surface is the single startup warn.
const intervalBody = postmortemFlat.match(/heartbeatTimer = setInterval\(\(\) => \{(.*?)\}, HEARTBEAT_INTERVAL_MS\);/u);
assert.ok(intervalBody, "the heartbeat interval must exist");
assert.doesNotMatch(intervalBody![1]!, /logger\./u, "the heartbeat must stay console-silent at runtime");
// The heartbeat never keeps the process alive, and beats are written
// atomically so a mid-write kill cannot corrupt the previous beat.
assert.match(postmortemFlat, /heartbeatTimer\.unref\(\);/u);
assert.match(postmortemFlat, /writeFileSync\(tmp, JSON\.stringify\(value\)\); renameSync\(tmp, path\);/u);

const indexSource = flatten(readSource("packages/server/src/index.ts"));
// Clean stamp BEFORE the async close: a kill during close still reads unclean.
assert.match(indexSource, /markCleanSessionExit\(\); await app\.close\(\);/u);
assert.match(indexSource, /startFreezeDetector\(\); startSessionPostmortem\(\);/u);

const appSource = flatten(readSource("packages/server/src/app.ts"));
assert.match(
  appSource,
  /lastUncleanExit: getLastUncleanExit\(\), uncleanExitCount: getUncleanExitHistory\(\)\.length,/u,
);

const clientFormat = flatten(readSource("packages/client/src/lib/support-diagnostics.ts"));
// The pasted report carries the previous session's fate, and a failed health
// fetch reads Unavailable - never a clean shutdown nobody observed.
assert.match(clientFormat, /Previous session: /u);
assert.match(clientFormat, /killed externally or lost power - last alive /u);
assert.match(clientFormat, /diagnostics\.lastUncleanExit === undefined \? "Unavailable"/u);

console.log("Termux postmortem regression passed.");
