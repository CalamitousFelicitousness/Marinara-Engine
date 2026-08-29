import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DB } from "../../db/connection.js";
import { and, eq } from "../../db/file-query.js";
import { decodeShardKey, encodeShardKey, isLazyUnitTable } from "../../db/file-backed-store.js";
import { characterImages, chatImages, globalImages, personaImages } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { assertInsideDir } from "../../utils/security.js";

export type StoredGalleryFile = {
  absolutePath: string;
  directory: string;
  filename: string;
};

const galleryLifecycleQueues = new Map<string, Promise<void>>();

function normalizedGalleryPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** Decode one URL path segment while rejecting separators and traversal names. */
export function decodeSafePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded &&
      !decoded.includes("/") &&
      !decoded.includes("\\") &&
      !decoded.includes("\0") &&
      decoded !== "." &&
      decoded !== ".."
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function galleryFileLifecycleKey(filePath: string, galleryRoot?: string): string {
  return `${resolve(galleryRoot ?? join(DATA_DIR, "gallery"))}\0${normalizedGalleryPath(filePath)}`;
}

/** Return the filename portion of a platform-neutral stored gallery path. */
export function storedGalleryFilename(filePath: string): string {
  return basename(normalizedGalleryPath(filePath));
}

/** Resolve a stored gallery-relative path without permitting root escape. */
export function resolveStoredGalleryFile(
  filePath: string,
  galleryRoot = join(DATA_DIR, "gallery"),
): StoredGalleryFile | null {
  if (!filePath || filePath.includes("\0")) return null;
  try {
    const absolutePath = assertInsideDir(galleryRoot, join(galleryRoot, normalizedGalleryPath(filePath)));
    return {
      absolutePath,
      directory: dirname(absolutePath),
      filename: basename(absolutePath),
    };
  } catch {
    return null;
  }
}

/**
 * Prefer an owner-local gallery file while supporting canonical shared files
 * referenced by owner-scoped URLs.
 */
export function resolveOwnedGalleryPath(galleryRoot: string, ownerRoot: string, filename: string): string {
  const ownedPath = assertInsideDir(ownerRoot, join(ownerRoot, filename));
  if (existsSync(ownedPath)) return ownedPath;
  const sharedRoot = assertInsideDir(galleryRoot, join(galleryRoot, "shared"));
  const sharedPath = assertInsideDir(sharedRoot, join(sharedRoot, filename));
  return existsSync(sharedPath) ? sharedPath : ownedPath;
}

/** Find the metadata row represented by an owner-scoped filename URL. */
export function findGalleryRowByFilename<T extends { filePath: string }>(
  rows: readonly T[],
  filename: string,
): T | null {
  return rows.find((row) => storedGalleryFilename(row.filePath) === filename) ?? null;
}

/**
 * Whether one chat_images shard file records a reference to filePath, read
 * without loading the unit. Returns null when the file cannot be ruled out —
 * unreadable, non-array root, or any row whose filePath cannot be read (the
 * serializer writes camelCase; the loader also accepts dbName form, so both
 * spellings are checked before giving up on a row).
 */
function shardFileReferencesPath(shardFilePath: string, filePath: string): boolean | null {
  try {
    const parsed = JSON.parse(readFileSync(shardFilePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const row of parsed) {
      if (!row || typeof row !== "object") return null;
      const candidate = row as { filePath?: unknown; file_path?: unknown };
      const rowPath =
        typeof candidate.filePath === "string"
          ? candidate.filePath
          : typeof candidate.file_path === "string"
            ? candidate.file_path
            : null;
      if (rowPath === null) return null;
      if (rowPath === filePath) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * The chat_images half of the reference check. The question is cross-chat by
 * design ("does ANY chat still reference this physical file?"), so the naive
 * filePath query cannot be scoped and permanently converted the whole table
 * to fully resident on the first image deletion (#5613). Instead: resident
 * units answer from memory (authoritative in both directions — an unflushed
 * new row must count, and an unflushed delete must not resurrect through its
 * stale shard file), and every other unit's shard file is read directly off
 * disk, which is sound because a non-resident unit can hold no unflushed
 * state (#5616's invariant). A shard the peek cannot interpret is handed to
 * the real loader by key when the filename decodes, and otherwise treated as
 * "assume referenced" — the safe direction, since a false positive only
 * keeps a file on disk while a false negative would delete a file another
 * chat still shows.
 */
async function chatImagesReferenceFile(db: DB, filePath: string): Promise<boolean> {
  const store = db._fileStore;
  if (!isLazyUnitTable("chat_images") || store.getFullyResidentLazyTables().has("chat_images")) {
    // Eager mode or an already-leased table: every row is in memory, so the
    // plain query is complete and leases nothing new.
    const rows = await db.select({ id: chatImages.id }).from(chatImages).where(eq(chatImages.filePath, filePath));
    return rows.length > 0;
  }

  // Disk pass first, so any loader handoff below happens before the memory
  // pass reads the final resident set (a handoff can pull misfiled stray
  // rows into their owning units, which the memory pass must then see).
  const startResident = store.getResidentChatUnits();
  const residentShardNames = new Set([...startResident].map((unitKey) => `${encodeShardKey(unitKey)}.json`));
  const handoffKeys = new Set<string>();
  const shardDir = join(store.rootDir, "tables", "chat_images");
  if (existsSync(shardDir)) {
    // Sorted so scan order — and therefore which unit a handoff touches first
    // — is deterministic across filesystems.
    for (const entry of readdirSync(shardDir).sort()) {
      let shardName = entry;
      if (entry.endsWith(".json.bak")) {
        // A lone .bak is an interrupted flush; only the loader can arbitrate
        // what the rows are. A .bak whose main file exists is ignorable —
        // the main file is canonical whenever it is readable.
        shardName = entry.slice(0, -".bak".length);
        if (existsSync(join(shardDir, shardName))) continue;
      } else if (!entry.endsWith(".json")) {
        continue;
      }
      if (residentShardNames.has(shardName)) continue; // the memory pass answers for these
      const verdict =
        shardName === entry ? shardFileReferencesPath(join(shardDir, entry), filePath) : /* lone .bak */ null;
      if (verdict === true) return true;
      if (verdict === false) continue;
      const unitKey = decodeShardKey(shardName.slice(0, -".json".length));
      if (unitKey === null) {
        // Undecodable hash-form shard the peek cannot read: assume referenced.
        // The worst case is an orphan file kept on disk until the shard heals.
        logger.warn(
          "[image-gallery] chat_images shard %s is not directly readable; treating %s as still referenced",
          entry,
          filePath,
        );
        return true;
      }
      handoffKeys.add(unitKey);
    }
  }

  // Loader handoffs: load exactly the untrusted units through the full
  // recovery ladder, one at a time, stopping at the first hit so one corrupt
  // shard does not drag every other untrusted shard into memory.
  for (const unitKey of handoffKeys) {
    const recovered = await db
      .select({ id: chatImages.id })
      .from(chatImages)
      .where(and(eq(chatImages.chatId, unitKey), eq(chatImages.filePath, filePath)))
      .limit(1);
    if (recovered.length > 0) return true;
  }

  // Memory pass: the union of everything resident now (start set, handoff
  // loads, stray-owner units pinned during those loads) plus the start set
  // again in case a flush evicted a unit mid-scan — its scoped query simply
  // reloads it. Every condition carries the chatId, so nothing leases.
  const memoryKeys = new Set<string>([...startResident, ...handoffKeys, ...store.getResidentChatUnits()]);
  if (memoryKeys.has("orphaned-rows")) {
    // Rows healed into the orphan unit carry an empty chatId, which the
    // unit-key loop below cannot express.
    memoryKeys.add("");
  }
  for (const unitKey of memoryKeys) {
    const scoped = await db
      .select({ id: chatImages.id })
      .from(chatImages)
      .where(and(eq(chatImages.chatId, unitKey), eq(chatImages.filePath, filePath)))
      .limit(1);
    if (scoped.length > 0) return true;
  }
  return false;
}

/** Check every gallery metadata table for a live reference to one file path. */
export async function galleryFileHasReferences(db: DB, filePath: string): Promise<boolean> {
  if (await chatImagesReferenceFile(db, filePath)) return true;

  const characterReference = await db
    .select({ id: characterImages.id })
    .from(characterImages)
    .where(eq(characterImages.filePath, filePath));
  if (characterReference.length > 0) return true;

  const personaReference = await db
    .select({ id: personaImages.id })
    .from(personaImages)
    .where(eq(personaImages.filePath, filePath));
  if (personaReference.length > 0) return true;

  const globalReference = await db
    .select({ id: globalImages.id })
    .from(globalImages)
    .where(eq(globalImages.filePath, filePath));
  return globalReference.length > 0;
}

/**
 * Serialize reference creation and final-release cleanup for one physical
 * gallery path. The optional root keeps isolated regression files independent.
 */
export async function withGalleryFileLifecycleLock<T>(
  filePath: string,
  operation: () => Promise<T> | T,
  galleryRoot?: string,
  signal?: AbortSignal,
): Promise<T> {
  return withGalleryLifecycleLock(`file\0${galleryFileLifecycleKey(filePath, galleryRoot)}`, operation, signal);
}

async function waitForGalleryLifecycleTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous.catch(() => undefined);
    return;
  }

  signal.throwIfAborted();
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    if (signal.aborted) rejectAbort();
    await Promise.race([previous.catch(() => undefined), aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}

async function withGalleryLifecycleLock<T>(
  key: string,
  operation: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  const previous = galleryLifecycleQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  galleryLifecycleQueues.set(key, tail);
  void tail.then(() => {
    if (galleryLifecycleQueues.get(key) === tail) galleryLifecycleQueues.delete(key);
  });

  try {
    await waitForGalleryLifecycleTurn(previous, signal);
    return await operation();
  } finally {
    releaseCurrent();
  }
}

/**
 * Serialize durable-reference creation and metadata deletion for Global Gallery
 * image ids. Sorting makes multi-image writes acquire locks deterministically.
 */
export async function withGlobalGalleryImageLifecycleLocks<T>(
  imageIds: readonly string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  const ids = Array.from(new Set(imageIds.filter((imageId) => imageId.length > 0))).sort();
  const acquire = (index: number): Promise<T> => {
    const imageId = ids[index];
    return imageId === undefined
      ? Promise.resolve(operation())
      : withGalleryLifecycleLock(`global-image\0${imageId}`, () => acquire(index + 1));
  };
  return acquire(0);
}

/**
 * Remove the physical file only after every gallery has released its metadata
 * reference. Invalid paths and cleanup failures leave at worst an orphan file,
 * never a broken live reference.
 */
export async function unlinkGalleryFileIfUnreferenced(input: {
  db: DB;
  filePath: string;
  /** Test-only filesystem override. */
  galleryRoot?: string;
}): Promise<boolean> {
  return withGalleryFileLifecycleLock(
    input.filePath,
    async () => {
      if (await galleryFileHasReferences(input.db, input.filePath)) return false;

      const storedFile = resolveStoredGalleryFile(input.filePath, input.galleryRoot);
      if (!storedFile) {
        logger.warn("[image-gallery] Skipped cleanup for unsafe gallery path %s", input.filePath);
        return false;
      }

      try {
        unlinkSync(storedFile.absolutePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        logger.warn(error, "[image-gallery] Could not remove unreferenced gallery file %s", input.filePath);
        return false;
      }
    },
    input.galleryRoot,
  );
}
