import type { Dirent } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DB } from "../../db/connection.js";
import { inArray } from "../../db/file-query.js";
import { encodeShardKey, isLazyUnitTable, isShardDataFileName } from "../../db/file-backed-store.js";
import {
  characterCardVersions,
  characterGroups,
  characters,
  personaCardVersions,
  personas,
} from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { assertInsideDir } from "../../utils/security.js";

const LOCAL_AVATAR_PREFIX = "/api/avatars/file/";
const STORED_AVATAR_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
export const ABANDONED_AVATAR_MIN_AGE_MS = 10 * 60 * 1_000;
let avatarLifecycleQueue = Promise.resolve();

export interface AbandonedAvatarFileSummary {
  files: number;
  bytes: number;
}

type AbandonedAvatarFile = {
  filePath: string;
  bytes: number;
};

/** Serialize avatar-reference mutations with final-reference file cleanup. */
export async function withAvatarFileLifecycleLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = avatarLifecycleQueue;
  let release!: () => void;
  avatarLifecycleQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Resolve a stored app avatar URL without permitting nested paths or root escape. */
export function resolveStoredAvatarFile(
  avatarPath: string | null | undefined,
  avatarRoot = join(DATA_DIR, "avatars"),
): string | null {
  if (!avatarPath?.startsWith(LOCAL_AVATAR_PREFIX)) return null;

  const encodedFilename = avatarPath.slice(LOCAL_AVATAR_PREFIX.length).split(/[?#]/u, 1)[0];
  if (!encodedFilename) return null;

  try {
    const filename = decodeURIComponent(encodedFilename);
    if (
      !filename ||
      filename.includes("/") ||
      filename.includes("\\") ||
      filename.includes("\0") ||
      filename === "." ||
      filename === ".."
    ) {
      return null;
    }
    return assertInsideDir(avatarRoot, join(avatarRoot, filename));
  } catch {
    return null;
  }
}

/** Remove an avatar file created before its database reference could be saved. */
export async function removeUnattachedAvatarFile(
  target: { filePath: string } | { avatarPath: string | null | undefined },
): Promise<void> {
  const filePath = "filePath" in target ? target.filePath : resolveStoredAvatarFile(target.avatarPath);
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(error, "Could not remove unattached avatar file %s", filePath);
    }
  }
}

function avatarPaths(rows: Array<{ avatarPath: string | null }>) {
  return rows.flatMap((row) => (row.avatarPath ? [row.avatarPath] : []));
}

/** Capture every current and historical avatar owned by the selected characters. */
export async function collectCharacterAvatarPaths(db: DB, characterIds: readonly string[]): Promise<string[]> {
  const ids = Array.from(new Set(characterIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const [current, versions] = await Promise.all([
    db.select({ avatarPath: characters.avatarPath }).from(characters).where(inArray(characters.id, ids)),
    db
      .select({ avatarPath: characterCardVersions.avatarPath })
      .from(characterCardVersions)
      .where(inArray(characterCardVersions.characterId, ids)),
  ]);
  return Array.from(new Set([...avatarPaths(current), ...avatarPaths(versions)]));
}

/** Capture every current and historical avatar owned by the selected personas. */
export async function collectPersonaAvatarPaths(db: DB, personaIds: readonly string[]): Promise<string[]> {
  const ids = Array.from(new Set(personaIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const [current, versions] = await Promise.all([
    db.select({ avatarPath: personas.avatarPath }).from(personas).where(inArray(personas.id, ids)),
    db
      .select({ avatarPath: personaCardVersions.avatarPath })
      .from(personaCardVersions)
      .where(inArray(personaCardVersions.personaId, ids)),
  ]);
  return Array.from(new Set([...avatarPaths(current), ...avatarPaths(versions)]));
}

async function referencedAvatarFiles(db: DB, avatarRoot: string): Promise<Set<string>> {
  const [characterRows, characterVersionRows, personaRows, personaVersionRows, groupRows] = await Promise.all([
    db.select({ avatarPath: characters.avatarPath }).from(characters),
    db.select({ avatarPath: characterCardVersions.avatarPath }).from(characterCardVersions),
    db.select({ avatarPath: personas.avatarPath }).from(personas),
    db.select({ avatarPath: personaCardVersions.avatarPath }).from(personaCardVersions),
    db.select({ avatarPath: characterGroups.avatarPath }).from(characterGroups),
  ]);

  const referenced = new Set<string>();
  for (const avatarPath of avatarPaths([
    ...characterRows,
    ...characterVersionRows,
    ...personaRows,
    ...personaVersionRows,
    ...groupRows,
  ])) {
    const filePath = resolveStoredAvatarFile(avatarPath, avatarRoot);
    if (filePath) referenced.add(filePath);
  }
  return referenced;
}

/**
 * Read cold identity history without leasing lazy chat tables. Resident rows are authoritative,
 * including unflushed inserts/deletes; cold units cannot have unflushed writes. Call only
 * inside a DB transaction: its write gate preserves this view across asynchronous file I/O
 * and prevents another request's temporary deletion from hiding a reference before rollback.
 * An unreadable shard/metadata makes cleanup inconclusive, so retain every candidate file.
 */
async function frozenIdentityAvatarFiles(db: DB, avatarRoot: string): Promise<Set<string> | null> {
  const files = new Set<string>();
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid identity metadata");
    return value as Record<string, unknown>;
  };
  const readExtra = (value: unknown) => {
    const extra = record(typeof value === "string" ? JSON.parse(value) : (value ?? {}));
    if (extra.personaSnapshot == null) return;
    const avatarUrl = record(extra.personaSnapshot).avatarUrl;
    if (avatarUrl == null) return;
    if (typeof avatarUrl !== "string") throw new Error("Invalid frozen avatar URL");
    const filePath = resolveStoredAvatarFile(avatarUrl, avatarRoot);
    if (filePath) files.add(filePath);
  };
  const readRow = (table: string, value: unknown) => {
    const row = record(value);
    if (table !== "message_trash") {
      readExtra(row.extra);
      return;
    }
    const snapshot = record(typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot);
    readExtra(record(snapshot.message).extra);
    if (snapshot.swipes != null && !Array.isArray(snapshot.swipes)) throw new Error("Invalid trashed swipes");
    for (const swipe of (snapshot.swipes ?? []) as unknown[]) readExtra(record(swipe).extra);
  };

  try {
    const store = db._fileStore;
    const residentNames = new Set([...store.getResidentChatUnits()].map((key) => `${encodeShardKey(key)}.json`));
    const fullyResident = store.getFullyResidentLazyTables();
    for (const table of ["messages", "message_swipes", "message_trash"]) {
      if (isLazyUnitTable(table) && !fullyResident.has(table)) {
        const shardDir = join(store.rootDir, "tables", table);
        let entries: string[];
        try {
          entries = await readdir(shardDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          entries = [];
        }
        // Include lone backups after interrupted flushes; a valid primary is canonical.
        const names = new Set(entries.filter(isShardDataFileName));
        for (const entry of entries) {
          if (entry.endsWith(".json.bak") && isShardDataFileName(entry.slice(0, -4))) names.add(entry.slice(0, -4));
        }
        for (const name of names) {
          if (residentNames.has(name)) continue;
          const path = join(shardDir, name);
          const rows = JSON.parse(await readFile(entries.includes(name) ? path : `${path}.bak`, "utf8")) as unknown;
          if (!Array.isArray(rows)) throw new Error("Invalid identity history shard");
          for (const row of rows) readRow(table, row);
        }
      }
      for (const row of store.getResidentLazyRows(table)) readRow(table, row);
    }
    return files;
  } catch (error) {
    logger.warn(error, "Could not inspect frozen identity history; retaining avatar files");
    return null;
  }
}

async function excludeFrozenAvatarFiles(
  db: DB,
  avatarRoot: string,
  files: AbandonedAvatarFile[],
): Promise<AbandonedAvatarFile[]> {
  if (files.length === 0) return files;
  const frozen = await frozenIdentityAvatarFiles(db, avatarRoot);
  return frozen === null ? [] : files.filter((file) => !frozen.has(file.filePath));
}

async function abandonedAvatarFilesUnlocked(input: {
  db: DB;
  avatarRoot: string;
  minimumAgeMs: number;
  nowMs: number;
}): Promise<AbandonedAvatarFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(input.avatarRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const referenced = await referencedAvatarFiles(input.db, input.avatarRoot);
  const abandoned: AbandonedAvatarFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !STORED_AVATAR_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const filePath = assertInsideDir(input.avatarRoot, join(input.avatarRoot, entry.name));
    if (referenced.has(filePath)) continue;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || input.nowMs - fileStat.mtimeMs < input.minimumAgeMs) continue;
      abandoned.push({ filePath, bytes: fileStat.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(error, "Could not inspect possible abandoned avatar file %s", filePath);
      }
    }
  }
  return abandoned;
}

function summarizeAbandonedAvatarFiles(files: readonly AbandonedAvatarFile[]): AbandonedAvatarFileSummary {
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

/** Find old, direct avatar image files that have no current or historical database reference. */
export async function scanAbandonedAvatarFiles(input: {
  db: DB;
  /** Test-only filesystem override. */
  avatarRoot?: string;
  /** Test-only clock override. */
  nowMs?: number;
  /** Test-only age override. */
  minimumAgeMs?: number;
}): Promise<AbandonedAvatarFileSummary> {
  return withAvatarFileLifecycleLock(() =>
    input.db.transaction(async () => {
      const avatarRoot = input.avatarRoot ?? join(DATA_DIR, "avatars");
      const abandoned = await abandonedAvatarFilesUnlocked({
        db: input.db,
        avatarRoot,
        minimumAgeMs: input.minimumAgeMs ?? ABANDONED_AVATAR_MIN_AGE_MS,
        nowMs: input.nowMs ?? Date.now(),
      });
      return summarizeAbandonedAvatarFiles(await excludeFrozenAvatarFiles(input.db, avatarRoot, abandoned));
    }),
  );
}

/** Re-scan and delete old, direct avatar image files that remain unreferenced. */
export async function deleteAbandonedAvatarFiles(input: {
  db: DB;
  /** Test-only filesystem override. */
  avatarRoot?: string;
  /** Test-only clock override. */
  nowMs?: number;
  /** Test-only age override. */
  minimumAgeMs?: number;
}): Promise<AbandonedAvatarFileSummary> {
  return withAvatarFileLifecycleLock(() =>
    input.db.transaction(async () => {
      const avatarRoot = input.avatarRoot ?? join(DATA_DIR, "avatars");
      const abandoned = await abandonedAvatarFilesUnlocked({
        db: input.db,
        avatarRoot,
        minimumAgeMs: input.minimumAgeMs ?? ABANDONED_AVATAR_MIN_AGE_MS,
        nowMs: input.nowMs ?? Date.now(),
      });
      const deleted: AbandonedAvatarFile[] = [];
      for (const file of await excludeFrozenAvatarFiles(input.db, avatarRoot, abandoned)) {
        try {
          await unlink(file.filePath);
          deleted.push(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(error, "Could not remove abandoned avatar file %s", file.filePath);
          }
        }
      }
      return summarizeAbandonedAvatarFiles(deleted);
    }),
  );
}

/** Remove local avatar files after their final database reference has been deleted. */
async function unlinkAvatarFilesIfUnreferencedUnlocked(input: {
  db: DB;
  avatarPaths: readonly string[];
  avatarRoot: string;
}): Promise<number> {
  // Do not collect against another request's uncommitted deletion that may roll back.
  return input.db.transaction(async () => {
    const avatarRoot = input.avatarRoot;
    const referenced = await referencedAvatarFiles(input.db, avatarRoot);
    const candidates = new Set<string>();
    for (const avatarPath of input.avatarPaths) {
      const filePath = resolveStoredAvatarFile(avatarPath, avatarRoot);
      if (filePath && !referenced.has(filePath)) candidates.add(filePath);
    }

    if (candidates.size === 0) return 0;
    const frozen = await frozenIdentityAvatarFiles(input.db, avatarRoot);
    if (frozen === null) return 0;
    let deleted = 0;
    for (const filePath of candidates) {
      if (frozen.has(filePath)) continue;
      try {
        await unlink(filePath);
        deleted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn(error, "Could not remove unreferenced avatar file %s", filePath);
        }
      }
    }
    return deleted;
  });
}

/** Remove local avatar files after their final database reference has been deleted. */
export async function unlinkAvatarFilesIfUnreferenced(input: {
  db: DB;
  avatarPaths: readonly string[];
  /** Test-only filesystem override. */
  avatarRoot?: string;
}): Promise<number> {
  return withAvatarFileLifecycleLock(() =>
    unlinkAvatarFilesIfUnreferencedUnlocked({
      ...input,
      avatarRoot: input.avatarRoot ?? join(DATA_DIR, "avatars"),
    }),
  );
}

/** Hold the lifecycle lock from reference capture through mutation and cleanup. */
export async function mutateAvatarReferencesAndCleanup<T>(input: {
  db: DB;
  collectAvatarPaths: () => Promise<string[]>;
  mutateReferences: () => Promise<T>;
  cleanupFiles?: boolean;
  /** Test-only filesystem override. */
  avatarRoot?: string;
}): Promise<{ result: T; filesDeleted: number }> {
  return withAvatarFileLifecycleLock(async () => {
    const shouldCleanup = input.cleanupFiles !== false;
    const avatarPaths = shouldCleanup ? await input.collectAvatarPaths() : [];
    const result = await input.mutateReferences();
    const filesDeleted = shouldCleanup
      ? await unlinkAvatarFilesIfUnreferencedUnlocked({
          db: input.db,
          avatarPaths,
          avatarRoot: input.avatarRoot ?? join(DATA_DIR, "avatars"),
        })
      : 0;
    return { result, filesDeleted };
  });
}
