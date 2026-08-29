// #5631: a transaction's opening gate must close atomically.
//   transaction() takes its queue slot, then AWAITS the previous transaction
//   and any in-flight flush before incrementing activeTransactionCount. A
//   plain write that passed waitForWritableTurn inside that window (count
//   still 0) could apply AFTER the transaction's first-mutation table
//   snapshot — and a rollback then restored the snapshot, silently erasing
//   the write its caller had already seen succeed. Worse, when the write
//   targeted a lazily-loaded unit, the load's rows were erased too while the
//   unit stayed marked loaded, making persisted rows invisible in memory.
//
//   Pinned here by staging the exact interleaving: transaction A occupies the
//   queue so transaction B parks in its opening awaits; a plain insert into a
//   NON-resident unit fires while B is parked (its unit load is the async gap
//   between gate and apply); B mutates the same table, then throws. With the
//   pending-count gate the insert waits out B entirely; without it, the
//   insert and the loaded unit vanish on B's rollback.
//
// Project imports are DYNAMIC, after the env assignments (see the gallery
// suites for why).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  // The staged interleaving relies on the lazy unit load as the async gap
  // between the write gate and the row apply.
  console.log("Transaction gate-window regression skipped: MARINARA_EAGER_STORAGE is set.");
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "marinara-tx-gate-window-"));
const storeDir = join(dataDir, "storage");
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = storeDir;

const { createFileNativeDB, encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { messages } = await import("../../packages/server/src/db/schema/index.js");

const chatRow = (id: string) => ({ id, name: id, mode: "conversation" });
const messageRow = (id: string, chatId: string, content: string) => ({
  id,
  chatId,
  role: "assistant",
  content,
  activeSwipeIndex: 0,
  createdAt: `2026-08-28T10:00:00.000Z`,
});

const shardPath = (table: string, key: string) => join(storeDir, "tables", table, `${encodeShardKey(key)}.json`);
const writeShard = (table: string, key: string, rows: unknown[]) => {
  mkdirSync(join(storeDir, "tables", table), { recursive: true });
  writeFileSync(shardPath(table, key), JSON.stringify(rows));
};

// c1 stays NON-resident (never touched before the race); c2 is warmed below.
writeShard("chats", "c1", [chatRow("c1")]);
writeShard("messages", "c1", [messageRow("m1", "c1", "persisted before the race")]);
writeShard("chats", "c2", [chatRow("c2")]);
writeShard("messages", "c2", [messageRow("m2", "c2", "pre-transaction text")]);

const db = await createFileNativeDB();
const storage = createChatsStorage(db);
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // Warm c2 only: B's in-transaction mutation must be synchronous (resident
  // unit) so its first-mutation snapshot lands before the raced insert can.
  await storage.getMessage("m2");

  let releaseA!: () => void;
  const aGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let releaseB!: () => void;
  const bGate = new Promise<void>((resolve) => {
    releaseB = resolve;
  });

  // A occupies the transaction queue so B parks in its opening awaits.
  const txA = db.transaction(async () => {
    await aGate;
  });
  await settle(30);

  const forced = new Error("forced rollback (#5631)");
  const txB = db
    .transaction(async () => {
      await db.update(messages).set({ content: "uncommitted tx edit" }).where(eq(messages.id, "m2"));
      await bGate;
      throw forced;
    })
    .catch((error: unknown) => error);
  await settle(30);

  // The raced plain write: insert into the non-resident c1 unit. Pre-fix its
  // gate check passes the moment A finishes (B not yet counted), and the unit
  // load defers the apply until after B's snapshot.
  let insertSettled = false;
  const pInsert = (async () => {
    await db.insert(messages).values(messageRow("p-new", "c1", "raced insert"));
  })();
  void pInsert.then(() => {
    insertSettled = true;
  });
  await settle(30);

  // A finishes: its finally wakes the gate waiters BEFORE releasing the
  // queue, so the raced insert's continuation runs ahead of B's.
  releaseA();
  await txA;

  // Give the interleaving time to develop, then let B throw. Pre-fix the
  // insert has applied mid-transaction (the race completes in milliseconds);
  // post-fix it is parked at the gate, so the timer path releases B.
  await Promise.race([pInsert, settle(300)]);
  const insertAppliedDuringTransaction = insertSettled;
  releaseB();

  const txBResult = await txB;
  assert.equal(txBResult, forced, "transaction B rejects with its forced error");
  await pInsert;

  assert.equal(
    insertAppliedDuringTransaction,
    false,
    "a plain write racing the transaction's opening gate must wait for the transaction instead of applying inside it",
  );

  const raced = await storage.getMessage("p-new");
  assert.equal(raced?.content, "raced insert", "the raced insert survives the rollback");

  const persisted = await storage.getMessage("m1");
  assert.equal(
    persisted?.content,
    "persisted before the race",
    "the lazily-loaded unit's persisted rows survive the rollback (marked-loaded rows must not be erased)",
  );

  const rolledBack = await storage.getMessage("m2");
  assert.equal(rolledBack?.content, "pre-transaction text", "the transaction's own mutation rolled back");
} finally {
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Transaction gate-window regression passed.");
