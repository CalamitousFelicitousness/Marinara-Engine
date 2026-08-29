// ──────────────────────────────────────────────
// Gallery Recovery — re-create DB records for orphaned image files
// ──────────────────────────────────────────────
// Scans data/gallery/ on startup. For every image file on disk that
// has no matching chat_images row (but whose parent chat still exists),
// a new DB record is inserted so the gallery UI shows the image again.
//
// #5612: the scan must not defeat lazy chat-unit residency. Querying
// chat_images per chat looks harmless — every query is chatId-scoped —
// but any row read pulls that chat's ENTIRE storage unit (all lazy
// tables' shards) into memory, so on installs where most chats have
// images this walk quietly reproduced the eager boot #5592 removed.
// For chats whose unit is not resident we therefore peek the chat's
// chat_images shard file straight off disk instead: a non-resident unit
// can hold no unflushed writes (writes force residency first, and
// eviction only runs after a successful flush), so the file IS the
// current state. Anything unreadable falls back to the real loader so
// the full recovery ladder (.bak fallback, quarantine) stays in charge
// of corruption — and only that one chat's unit loads.
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { logger } from "../../lib/logger.js";
import { join, extname } from "path";
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { encodeShardKey, isLazyUnitTable, type FileNativeStoreController } from "../../db/file-backed-store.js";
import { chatImages, chats } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import { getDataDir } from "../../utils/data-dir.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

/**
 * The filePaths recorded in one chat's chat_images shard file, read without
 * loading the unit. Returns null when the peek cannot be trusted — an
 * unreadable file, a non-array root, or a lone .bak from an interrupted
 * flush — so the caller falls back to the real loader.
 */
function peekChatImageFilePaths(storageRootDir: string, chatId: string): Set<string> | null {
  const shardPath = join(storageRootDir, "tables", "chat_images", `${encodeShardKey(chatId)}.json`);
  if (!existsSync(shardPath)) {
    // No shard and no backup means the chat truly has no rows. A lone .bak is
    // an interrupted flush — let the loader's recovery ladder arbitrate.
    return existsSync(`${shardPath}.bak`) ? null : new Set();
  }
  try {
    const parsed = JSON.parse(readFileSync(shardPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return null;
    const paths = new Set<string>();
    for (const row of parsed) {
      // Skip what a real load would also drop or not attribute to this chat:
      // malformed rows heal away at first touch, and a misfiled stray row
      // belongs to another chat's gallery.
      if (!row || typeof row !== "object") continue;
      const candidate = row as { chatId?: unknown; filePath?: unknown };
      if (candidate.chatId !== chatId) continue;
      if (typeof candidate.filePath === "string") paths.add(candidate.filePath);
    }
    return paths;
  } catch {
    return null;
  }
}

async function knownFilePathsFor(
  db: DB,
  store: FileNativeStoreController,
  chatId: string,
  chatImagesIsLazy: boolean,
): Promise<Set<string>> {
  if (chatImagesIsLazy && !store.getResidentChatUnits().has(chatId)) {
    const peeked = peekChatImageFilePaths(store.rootDir, chatId);
    if (peeked) return peeked;
    logger.warn(
      "[gallery-recovery] chat_images shard for chat %s is not directly readable; loading the unit to recover it",
      chatId,
    );
  }
  // Resident unit, eager mode, or an unreadable shard: the store answers, from
  // memory in the first two cases and via a single unit load in the third.
  const rows = await db.select({ filePath: chatImages.filePath }).from(chatImages).where(eq(chatImages.chatId, chatId));
  return new Set(rows.map((r) => r.filePath));
}

export async function recoverGalleryImages(db: DB) {
  const galleryDir = join(getDataDir(), "gallery");
  if (!existsSync(galleryDir)) return;

  const chatDirs = readdirSync(galleryDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  let recovered = 0;
  const store = db._fileStore;
  const chatImagesIsLazy = isLazyUnitTable("chat_images");

  for (const dir of chatDirs) {
    try {
      const chatId = dir.name;

      // Only recover for chats that still exist (chats is an eager table, so
      // this lookup never loads a chat unit).
      const chatRow = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1);
      if (chatRow.length === 0) continue;

      // Scan image files on disk before touching chat_images at all: a
      // directory with nothing recoverable costs no storage access.
      const chatGalleryDir = join(galleryDir, chatId);
      const files = readdirSync(chatGalleryDir).filter((f) => {
        const ext = extname(f).toLowerCase();
        return IMAGE_EXTS.has(ext) && statSync(join(chatGalleryDir, f)).isFile();
      });
      if (files.length === 0) continue;

      const knownPaths = await knownFilePathsFor(db, store, chatId, chatImagesIsLazy);

      for (const file of files) {
        const relativePath = `${chatId}/${file}`;
        if (knownPaths.has(relativePath)) continue;

        // Orphaned file — recreate the DB record. The insert loads this one
        // chat's unit through the normal path (heal ladder included).
        await db.insert(chatImages).values({
          id: newId(),
          chatId,
          filePath: relativePath,
          prompt: "",
          provider: "",
          model: "",
          width: null,
          height: null,
          createdAt: now(),
        });
        recovered++;
      }
    } catch (err) {
      logger.warn(err, "[gallery-recovery] Failed to process directory %s", dir.name);
    }
  }

  if (recovered > 0) {
    logger.info("[gallery-recovery] Recovered %d orphaned gallery image(s)", recovered);
  }
}
