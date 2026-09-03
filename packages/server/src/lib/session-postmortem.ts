// ──────────────────────────────────────────────
// Session postmortem (#5506 diagnostics)
// ──────────────────────────────────────────────
// When Android kills a Termux server (phantom process killer, battery
// management, low-memory killer) the process gets SIGKILL: no handler runs,
// nothing is logged, and the launcher log simply stops - support threads
// cannot tell an external kill from a reboot from a crash. This module turns
// the NEXT startup into the witness: a silent file-only heartbeat records
// "alive at T with this much memory" every tick, a graceful shutdown stamps
// the file clean, and startup reads the previous file - a beat without the
// clean stamp is positive evidence of an unclean death, with a time of
// death (last beat), uptime, memory at death, and whether the device
// rebooted in between (boot id change). Deliberately QUIET: the heartbeat
// itself never writes to the console; the postmortem is one startup log
// line, and the full record rides /api/health into Support Diagnostics so
// pasted reports carry it automatically.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { getDataDir } from "../config/runtime-config.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
const UNCLEAN_EXIT_HISTORY_LIMIT = 10;

export type SessionHeartbeat = {
  pid: number;
  bootId: string | null;
  startedAt: string;
  lastBeatAt: string;
  rssMiB: number;
  heapUsedMiB: number;
  cleanExit?: boolean;
};

export type UncleanExitRecord = {
  /** When the previous session started. */
  startedAt: string;
  /** The last heartbeat before death - time of death to one interval. */
  lastSeenAt: string;
  /** Uptime at the last heartbeat, in milliseconds. */
  uptimeMs: number;
  /** Memory at the last heartbeat - distinguishes pressure kills from idle kills. */
  rssMiB: number;
  heapUsedMiB: number;
  pid: number;
  /** True when the boot id changed between death and this startup; null when unknowable. */
  rebootedSince: boolean | null;
  /** When this record was written (the startup that noticed the death). */
  detectedAt: string;
};

export function heartbeatMemorySnapshot(): { rssMiB: number; heapUsedMiB: number } {
  const usage = process.memoryUsage();
  return {
    rssMiB: Math.round((usage.rss / 1024 / 1024) * 10) / 10,
    heapUsedMiB: Math.round((usage.heapUsed / 1024 / 1024) * 10) / 10,
  };
}

/** Linux/Android boot identity; null elsewhere or when unreadable. */
export function readBootId(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Pure classifier so the regression lane can pin the semantics without a
 * filesystem: a previous heartbeat WITHOUT the clean stamp is an unclean
 * death; reboot detection needs both boot ids.
 */
export function buildUncleanExitRecord(
  previous: SessionHeartbeat,
  currentBootId: string | null,
  detectedAt: string,
): UncleanExitRecord | null {
  if (previous.cleanExit === true) return null;
  const startedMs = Date.parse(previous.startedAt);
  const lastMs = Date.parse(previous.lastBeatAt);
  return {
    startedAt: previous.startedAt,
    lastSeenAt: previous.lastBeatAt,
    uptimeMs: Number.isFinite(startedMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - startedMs) : 0,
    rssMiB: previous.rssMiB,
    heapUsedMiB: previous.heapUsedMiB,
    pid: previous.pid,
    rebootedSince: previous.bootId !== null && currentBootId !== null ? previous.bootId !== currentBootId : null,
    detectedAt,
  };
}

function diagnosticsDir(): string {
  return resolve(getDataDir(), "diagnostics");
}

function heartbeatPath(): string {
  return resolve(diagnosticsDir(), "session-heartbeat.json");
}

function historyPath(): string {
  return resolve(diagnosticsDir(), "unclean-exits.json");
}

/** Atomic write: a kill mid-write must never corrupt the previous beat. */
function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

let lastUncleanExit: UncleanExitRecord | null = null;
let uncleanExitHistory: UncleanExitRecord[] = [];
let heartbeatTimer: NodeJS.Timeout | null = null;
let sessionStartedAt = "";
let sessionBootId: string | null = null;

function writeBeat(cleanExit?: boolean) {
  const memory = heartbeatMemorySnapshot();
  const beat: SessionHeartbeat = {
    pid: process.pid,
    bootId: sessionBootId,
    startedAt: sessionStartedAt,
    lastBeatAt: new Date().toISOString(),
    ...memory,
    ...(cleanExit ? { cleanExit: true } : {}),
  };
  writeJsonAtomic(heartbeatPath(), beat);
}

/**
 * Reads the previous session's fate, then starts this session's silent
 * heartbeat. Returns the previous session's unclean-exit record when there
 * was one. Never throws - diagnostics must not take the server down.
 */
export function startSessionPostmortem(): UncleanExitRecord | null {
  try {
    mkdirSync(diagnosticsDir(), { recursive: true });
    sessionStartedAt = new Date().toISOString();
    sessionBootId = readBootId();

    const previous = readJson<SessionHeartbeat>(heartbeatPath());
    if (previous && typeof previous.lastBeatAt === "string" && typeof previous.startedAt === "string") {
      const record = buildUncleanExitRecord(previous, sessionBootId, sessionStartedAt);
      if (record) {
        lastUncleanExit = record;
        uncleanExitHistory = [record, ...(readJson<UncleanExitRecord[]>(historyPath()) ?? [])].slice(
          0,
          UNCLEAN_EXIT_HISTORY_LIMIT,
        );
        writeJsonAtomic(historyPath(), uncleanExitHistory);
        // The single console surface of this module: one startup line in the
        // launcher preamble. Runtime stays silent by design - users read the
        // console for other things (maintainer call on #5506 diagnostics).
        logger.warn(
          "Previous session (pid %d) ended WITHOUT a clean shutdown: last alive %s after %d min, RSS %d MiB%s. The process was killed externally (Android phantom process killer / battery manager / reboot) - see Support Diagnostics for the record.",
          record.pid,
          record.lastSeenAt,
          Math.round(record.uptimeMs / 60_000),
          record.rssMiB,
          record.rebootedSince === null
            ? ""
            : record.rebootedSince
              ? "; the device rebooted before this launch"
              : "; no reboot in between",
        );
      }
    } else {
      uncleanExitHistory = readJson<UncleanExitRecord[]>(historyPath()) ?? [];
    }

    writeBeat();
    heartbeatTimer = setInterval(() => {
      try {
        writeBeat();
      } catch {
        // A failing beat must never surface at runtime; the next startup
        // simply gets a coarser time of death.
      }
    }, HEARTBEAT_INTERVAL_MS);
    // The heartbeat must never keep the process alive on its own.
    heartbeatTimer.unref();
    return lastUncleanExit;
  } catch (err) {
    logger.warn(err, "[postmortem] session heartbeat unavailable");
    return null;
  }
}

/** Stamp the heartbeat clean on graceful shutdown (sync - shutdown path). */
export function markCleanSessionExit() {
  try {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (sessionStartedAt) writeBeat(true);
  } catch {
    // Best effort: a failed clean stamp reads as an unclean exit next boot,
    // which errs toward over-reporting, never under-reporting.
  }
}

/** The previous session's unclean exit, for /api/health and diagnostics. */
export function getLastUncleanExit(): UncleanExitRecord | null {
  return lastUncleanExit;
}

/** Recent unclean exits (newest first), for /api/health and diagnostics. */
export function getUncleanExitHistory(): UncleanExitRecord[] {
  return uncleanExitHistory;
}
