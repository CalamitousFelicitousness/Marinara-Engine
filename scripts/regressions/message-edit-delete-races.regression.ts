// #5599/#5600: message edit/delete concurrency.
//   - #5599: removeMessage/removeMessages were the only per-message mutations
//     NOT serialized on the per-message patch queue, so a delete could land
//     inside an in-flight edit's await gaps and silently drop the edit into a
//     404. Pinned here by holding the queue and proving a delete now waits.
//   - #5600: the edit wrote the messages row and its active-swipe mirror with
//     awaited gaps between them and no transaction, so a flush (or crash) in
//     the window persisted the edit on the message while the swipe kept the
//     pre-edit text — surfacing in exports and branches. Pinned here by
//     flushing mid-edit and reading the shard files: the store defers flushes
//     while a transaction is active, so the flush must now produce a
//     consistent pair on disk.
//
// Project imports are DYNAMIC, after the env assignments (see the gallery
// suites for why).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  // The queue and transaction semantics under test are storage-mode
  // independent, but the shard-file assertions below read the lazy layout.
  console.log("Message edit/delete race regressions skipped: MARINARA_EAGER_STORAGE is set.");
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "marinara-edit-delete-races-"));
const storeDir = join(dataDir, "storage");
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = storeDir;

const { createFileNativeDB, encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage, withMessageExtraPatchQueue } = await import(
  "../../packages/server/src/services/storage/chats.storage.js"
);

const chatRow = (id: string) => ({ id, name: id, mode: "conversation" });
const messageRow = (id: string, chatId: string, content: string) => ({
  id,
  chatId,
  role: "assistant",
  content,
  activeSwipeIndex: 0,
  createdAt: `2026-08-28T10:00:00.000Z`,
});
const swipeRow = (id: string, messageId: string, content: string) => ({ id, messageId, index: 0, content });

const shardPath = (table: string, key: string) => join(storeDir, "tables", table, `${encodeShardKey(key)}.json`);
const writeShard = (table: string, key: string, rows: unknown[]) => {
  mkdirSync(join(storeDir, "tables", table), { recursive: true });
  writeFileSync(shardPath(table, key), JSON.stringify(rows));
};

writeShard("chats", "c1", [chatRow("c1")]);
writeShard("messages", "c1", [
  messageRow("m-hold", "c1", "hold me"),
  messageRow("m-bulk", "c1", "bulk me"),
  messageRow("m-race", "c1", "race me"),
  messageRow("m-tear", "c1", "old text"),
]);
writeShard("message_swipes", "c1", [
  swipeRow("s-race", "m-race", "race me"),
  swipeRow("s-tear", "m-tear", "old text"),
]);

const db = await createFileNativeDB();
const storage = createChatsStorage(db);
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // ── #5599: a delete waits for the per-message queue ──
  {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withMessageExtraPatchQueue("m-hold", () => hold);
    const deletion = storage.removeMessage("m-hold");
    await settle(150);
    assert.notEqual(
      await storage.getMessage("m-hold"),
      null,
      "removeMessage waits for the message's patch queue instead of racing past an in-flight mutation",
    );
    release();
    await held;
    await deletion;
    assert.equal(await storage.getMessage("m-hold"), null, "the queued delete completes once the queue frees");
  }

  // ── #5599: the bulk delete waits for every affected message's queue ──
  {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withMessageExtraPatchQueue("m-bulk", () => hold);
    const deletion = storage.removeMessages(["m-bulk"], "c1");
    await settle(150);
    assert.notEqual(
      await storage.getMessage("m-bulk"),
      null,
      "removeMessages waits for each affected message's patch queue",
    );
    release();
    await held;
    await deletion;
    assert.equal(await storage.getMessage("m-bulk"), null, "the queued bulk delete completes once the queue frees");
  }

  // ── #5599: edit-then-delete resolves in queue order — the edit wins ──
  {
    const edit = storage.updateMessageContent("m-race", "edited before deletion");
    const deletion = storage.removeMessage("m-race");
    const edited = await edit;
    await deletion;
    assert.equal(
      edited?.content,
      "edited before deletion",
      "an edit enqueued before a delete completes with its result instead of a silent null",
    );
    assert.equal(await storage.getMessage("m-race"), null, "the delete still lands afterward");
  }

  // ── #5600: a flush initiated mid-edit cannot persist a torn pair ──
  {
    const gen0 = db._fileStore.getTableWriteGeneration("messages");
    const edit = storage.updateMessageContent("m-tear", "EDITED TEXT");
    // Wait for the edit's FIRST write (the messages row) to be marked, then
    // flush. Pre-fix the flush wrote the messages shard while the swipe
    // mirror was still unwritten — the exact crash-persisted state. With the
    // edit inside a transaction, the flush blocks until commit and writes a
    // consistent pair.
    let waited = 0;
    while (db._fileStore.getTableWriteGeneration("messages") === gen0 && waited < 4000) {
      await new Promise((resolve) => setImmediate(resolve));
      waited += 1;
    }
    assert.notEqual(waited, 4000, "the edit's first write was observed");
    await db._fileStore.flush();
    const messagesShard = readFileSync(shardPath("messages", "c1"), "utf8");
    const swipesShard = readFileSync(shardPath("message_swipes", "c1"), "utf8");
    const messageEdited = messagesShard.includes("EDITED TEXT");
    const swipeEdited = swipesShard.includes("EDITED TEXT");
    assert.equal(
      messageEdited,
      swipeEdited,
      `the on-disk pair must be consistent after a mid-edit flush (message edited: ${messageEdited}, swipe edited: ${swipeEdited})`,
    );
    const edited = await edit;
    assert.equal(edited?.content, "EDITED TEXT", "the edit completes normally");
    await db._fileStore.flush();
    assert.equal(
      readFileSync(shardPath("message_swipes", "c1"), "utf8").includes("EDITED TEXT"),
      true,
      "the swipe mirror carries the edit after the final flush",
    );
  }
} finally {
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Message edit/delete race regressions passed.");
