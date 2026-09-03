// ──────────────────────────────────────────────
// Session postmortem (#5506 diagnostics)
// ──────────────────────────────────────────────
// When Android kills a Termux server (phantom process killer, battery
// management, low-memory killer) the process gets SIGKILL: no handler runs,
// nothing is logged, and the launcher log simply stops - support threads
// cannot tell an external kill from a reboot from a crash. This module turns
// the NEXT startup into the witness: a silent file-only heartbeat records
// "alive at T with this much memory" every tick, and any DELIBERATE ending
// stamps how it ended.
//
// The stamp rides process.on("exit") rather than individual shutdown paths:
// every deliberate ending (signal shutdown, in-app update, Advanced Settings
// restart, an app-level crash exiting non-zero) fires that event and our
// writes are synchronous, while SIGKILL - the thing we are here to detect -
// by definition fires nothing. A per-path stamp would silently rot the first
// time someone adds a fifth exit path (an adversarial review caught exactly
// that: the update and restart paths were classified as Android kills).
//
// Honesty rules, in priority order:
//   1. Never claim a clean shutdown nobody observed. Missing, corrupt, or
//      unclassifiable records report "unknown", never "clean".
//   2. A crash is named a crash, not an external kill - the server logged it.
//   3. If the previous pid is still running, another instance owns this data
//      directory; report "unknown" rather than declaring a live session dead.
//
// Deliberately QUIET: the heartbeat never writes to the console; the
// postmortem is one startup line, and the record rides /api/health into
// Support Diagnostics so pasted reports carry it automatically.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { getDataDir } from "../config/runtime-config.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
const UNCLEAN_EXIT_HISTORY_LIMIT = 10;

/** How a session ended, when the ending was observed from inside. */
export type SessionExitKind = "clean" | "crash" | "restart";

export type SessionHeartbeat = {
  pid: number;
  bootId: string | null;
  startedAt: string;
  lastBeatAt: string;
  rssMiB: number;
  heapUsedMiB: number;
  /** Absent while running and after an external kill; set on deliberate exits. */
  exitKind?: SessionExitKind;
  exitedAt?: string;
  exitCode?: number;
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

/**
 * The previous session's fate. "unknown" is a first-class outcome: it covers
 * a first run, an unreadable record, and a still-live sibling instance, none
 * of which may be reported as a clean shutdown.
 */
export type PreviousSessionStatus =
  | { status: "unknown"; reason: string }
  | { status: "ended"; exitKind: SessionExitKind; exitedAt: string | null; exitCode: number | null }
  | { status: "unclean"; record: UncleanExitRecord };

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

/** True when a process with this pid currently exists (signal 0 probes only). */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user - still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pure classifier so the regression lane can pin the semantics without a
 * filesystem or live processes. `isAlive` is injected for the same reason.
 */
export function classifyPreviousSession(
  previous: SessionHeartbeat | null,
  currentBootId: string | null,
  detectedAt: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): PreviousSessionStatus {
  if (!previous || typeof previous.lastBeatAt !== "string" || typeof previous.startedAt !== "string") {
    return { status: "unknown", reason: "no readable record of a previous session" };
  }
  if (previous.exitKind) {
    return {
      status: "ended",
      exitKind: previous.exitKind,
      exitedAt: typeof previous.exitedAt === "string" ? previous.exitedAt : null,
      exitCode: typeof previous.exitCode === "number" ? previous.exitCode : null,
    };
  }
  // A live owner means this record belongs to a running sibling (a restart's
  // detached child races its parent's exit; two servers can share DATA_DIR).
  // Reporting it dead would be a fabricated death.
  if (isAlive(previous.pid)) {
    return { status: "unknown", reason: "another server instance is using this data directory" };
  }
  const startedMs = Date.parse(previous.startedAt);
  const lastMs = Date.parse(previous.lastBeatAt);
  return {
    status: "unclean",
    record: {
      startedAt: previous.startedAt,
      lastSeenAt: previous.lastBeatAt,
      uptimeMs: Number.isFinite(startedMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - startedMs) : 0,
      rssMiB: previous.rssMiB,
      heapUsedMiB: previous.heapUsedMiB,
      pid: previous.pid,
      rebootedSince: previous.bootId !== null && currentBootId !== null ? previous.bootId !== currentBootId : null,
      detectedAt,
    },
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

/**
 * Atomic write: a kill mid-write must never corrupt the previous beat. No
 * fsync - a per-beat flush would tax phone flash every 30s to protect only
 * against whole-device power loss, which the boot-id check already reports
 * separately; the cost of that trade is a coarser time of death in that one
 * case, never a wrong classification.
 */
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

let previousSession: PreviousSessionStatus = { status: "unknown", reason: "postmortem not started" };
let uncleanExitHistory: UncleanExitRecord[] = [];
let heartbeatTimer: NodeJS.Timeout | null = null;
let sessionStartedAt = "";
let sessionBootId: string | null = null;
let sessionExitKind: SessionExitKind | null = null;
let finalized = false;

function writeBeat(ending?: { exitKind: SessionExitKind; exitCode: number }) {
  const memory = heartbeatMemorySnapshot();
  const beat: SessionHeartbeat = {
    pid: process.pid,
    bootId: sessionBootId,
    startedAt: sessionStartedAt,
    lastBeatAt: new Date().toISOString(),
    ...memory,
    ...(ending ? { exitKind: ending.exitKind, exitedAt: new Date().toISOString(), exitCode: ending.exitCode } : {}),
  };
  writeJsonAtomic(heartbeatPath(), beat);
}

/**
 * Records that this session is ending deliberately, so the exit stamp can
 * name the ending. "restart" covers the in-app update and Advanced Settings
 * restart; "crash" covers the fatal uncaughtException/unhandledRejection
 * handlers - both are observed endings, never external kills.
 */
export function noteSessionExitKind(kind: SessionExitKind) {
  sessionExitKind = kind;
}

/**
 * Stamps the heartbeat with how this session ended. Registered on
 * process.on("exit") so EVERY deliberate ending is covered without each exit
 * path having to remember; synchronous by necessity (exit handlers cannot
 * await). An external kill never reaches this, which is exactly the signal.
 */
export function finalizeSessionExit(exitCode: number) {
  if (finalized || !sessionStartedAt) return;
  finalized = true;
  try {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    // An unflagged non-zero exit is still an observed ending, but calling it
    // "clean" would overclaim - treat it as the crash it most likely is.
    const kind: SessionExitKind = sessionExitKind ?? (exitCode === 0 ? "clean" : "crash");
    writeBeat({ exitKind: kind, exitCode });
  } catch {
    // Best effort: a failed stamp reads as an unclean exit next startup,
    // which over-reports rather than under-reports.
  }
}

/**
 * Reads the previous session's fate, then starts this session's silent
 * heartbeat. Never throws - diagnostics must not take the server down.
 */
export function startSessionPostmortem(): PreviousSessionStatus {
  try {
    mkdirSync(diagnosticsDir(), { recursive: true });
    sessionStartedAt = new Date().toISOString();
    sessionBootId = readBootId();
    finalized = false;
    sessionExitKind = null;

    uncleanExitHistory = readJson<UncleanExitRecord[]>(historyPath()) ?? [];
    previousSession = classifyPreviousSession(
      readJson<SessionHeartbeat>(heartbeatPath()),
      sessionBootId,
      sessionStartedAt,
    );
    if (previousSession.status === "unclean") {
      const record = previousSession.record;
      uncleanExitHistory = [record, ...uncleanExitHistory].slice(0, UNCLEAN_EXIT_HISTORY_LIMIT);
      writeJsonAtomic(historyPath(), uncleanExitHistory);
      // The single console surface of this module: one startup line. Runtime
      // stays silent by design - users read the console for other things
      // (maintainer call on #5506 diagnostics).
      logger.warn(
        "Previous session (pid %d) ended without shutting down: last alive %s after %d min, RSS %d MiB%s. Nothing was logged, so the process was ended from outside - on Android/Termux the usual causes are the phantom process killer or battery management; on desktop, a force-quit or power loss. See Support Diagnostics for the record.",
        record.pid,
        record.lastSeenAt,
        Math.round(record.uptimeMs / 60_000),
        record.rssMiB,
        record.rebootedSince === null
          ? ""
          : record.rebootedSince
            ? "; the device rebooted before this launch"
            : "; the device did not reboot in between",
      );
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
    return previousSession;
  } catch (err) {
    logger.warn(err, "[postmortem] session heartbeat unavailable");
    previousSession = { status: "unknown", reason: "the session heartbeat could not be written" };
    return previousSession;
  }
}

/** The previous session's fate, for /api/health and support diagnostics. */
export function getPreviousSessionStatus(): PreviousSessionStatus {
  return previousSession;
}

/** Recent unclean exits (newest first), for /api/health and diagnostics. */
export function getUncleanExitHistory(): UncleanExitRecord[] {
  return uncleanExitHistory;
}
