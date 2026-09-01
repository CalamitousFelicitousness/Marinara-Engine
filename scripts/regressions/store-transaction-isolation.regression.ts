// #5651 + #5652: two residual transaction-isolation gaps behind the #5631 gate.
//
// #5651 - reads never take the write gate: a CONCURRENT request's read can
//   lazily load a cold unit into memory mid-transaction. The load runs outside
//   the transaction's AsyncLocalStorage context, so the snapshot mirror in
//   mergeLoadedRows never saw it - the loaded rows landed in the live table
//   AFTER the transaction's first-mutation snapshot, and a rollback restored
//   the snapshot, erasing persisted rows while loadedUnits still said the unit
//   was resident. The rows stayed invisible until restart. The fix mirrors
//   load effects into the ACTIVE transaction's context regardless of the
//   loader's own context (the queue admits at most one transaction).
//
// #5652 - transaction()'s opening flush wait was check-once. Two flushes can
//   park on the same activeFlush with the second subscribed first: when it
//   resolves, that flush's recursion re-enters, sees no active transaction,
//   captures the dirty set, and installs a NEW activeFlush - and the
//   transaction's continuation then sailed past its consumed check, running
//   its callback concurrently with the fresh flush's I/O. saveFileSnapshots
//   reads live tables, so uncommitted rows could be persisted with no dirty
//   mark left after rollback. The fix loops the wait.
//
// Project imports are DYNAMIC, after the env assignments (see tx-gate-window).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  // The lazy-load half of the pin has no meaning under eager storage.
  console.log("Store transaction-isolation regression skipped: MARINARA_EAGER_STORAGE is set.");
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "marinara-tx-isolation-"));
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
  createdAt: `2026-08-30T10:00:00.000Z`,
});

const writeShard = (table: string, key: string, rows: unknown[]) => {
  mkdirSync(join(storeDir, "tables", table), { recursive: true });
  writeFileSync(join(storeDir, "tables", table, `${encodeShardKey(key)}.json`), JSON.stringify(rows));
};

// cold stays NON-resident until the mid-transaction read; warm is loaded early.
writeShard("chats", "cold", [chatRow("cold")]);
writeShard("messages", "cold", [messageRow("m-cold", "cold", "persisted before the transaction")]);
writeShard("chats", "warm", [chatRow("warm")]);
writeShard("messages", "warm", [messageRow("m-warm", "warm", "pre-transaction text")]);

// One-shot flush hold, armed per flush: the first table write of the armed
// flush parks until released. Later writes of the same flush pass through.
let pendingFlushHold: Promise<void> | null = null;
let flushHoldsTaken = 0;
const db = await createFileNativeDB({
  beforeTableWrite: async () => {
    const hold = pendingFlushHold;
    pendingFlushHold = null;
    if (hold) {
      flushHoldsTaken += 1;
      await hold;
    }
  },
});
const storage = createChatsStorage(db);
const store = db._fileStore;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // ══ Part 1 (#5651): a rollback must not erase concurrently loaded rows ══
  await storage.getMessage("m-warm"); // warm unit resident before the race

  let releaseTx!: () => void;
  const txGate = new Promise<void>((resolve) => {
    releaseTx = resolve;
  });
  const forced = new Error("forced rollback (#5651)");
  const tx = db
    .transaction(async () => {
      // First-mutation snapshot of "messages" is taken here, BEFORE the
      // concurrent load below splices the cold unit into the live table.
      await db.update(messages).set({ content: "uncommitted tx edit" }).where(eq(messages.id, "m-warm"));
      await txGate;
      throw forced;
    })
    .catch((error: unknown) => error);
  await settle(30);

  // The concurrent request: a plain read that lazy-loads the cold unit. It
  // runs OUTSIDE the transaction's ALS context - exactly the #5651 shape.
  const loadedDuringTx = await storage.getMessage("m-cold");
  assert.equal(
    loadedDuringTx?.content,
    "persisted before the transaction",
    "the mid-transaction lazy load itself returns the persisted row",
  );

  releaseTx();
  assert.equal(await tx, forced, "the transaction rejects with its forced error");

  const survivor = await storage.getMessage("m-cold");
  assert.equal(
    survivor?.content,
    "persisted before the transaction",
    "rollback must not erase rows a concurrent read lazily loaded mid-transaction (#5651)",
  );
  const rolledBack = await storage.getMessage("m-warm");
  assert.equal(rolledBack?.content, "pre-transaction text", "the transaction's own mutation rolled back");

  // ══ Part 2 (#5652): a transaction may not run concurrently with a flush ══
  // Stage the double-flush ordering from the issue.
  await db.insert(messages).values(messageRow("m-f1", "warm", "dirties for flush 1"));

  let releaseHold1!: () => void;
  const hold1 = new Promise<void>((resolve) => {
    releaseHold1 = resolve;
  });
  let releaseHold2!: () => void;
  const hold2 = new Promise<void>((resolve) => {
    releaseHold2 = resolve;
  });

  pendingFlushHold = hold1;
  const flush1 = store.flush(); // captures, then parks mid-write on hold1
  await settle(30);

  await db.insert(messages).values(messageRow("m-f2", "warm", "dirties for flush 2"));
  const flush2 = store.flush(); // parks on flush1's activeFlush, subscribed FIRST
  await settle(10);

  let txEntered = false;
  let releaseTx2!: () => void;
  const tx2Gate = new Promise<void>((resolve) => {
    releaseTx2 = resolve;
  });
  const tx2 = db.transaction(async () => {
    txEntered = true;
    await db.update(messages).set({ content: "tx2 edit" }).where(eq(messages.id, "m-f2"));
    await tx2Gate;
  }); // parks on the same activeFlush, subscribed SECOND
  await settle(10);

  // Arm the hold for flush 2's recursion BEFORE waking flush 1: when flush 1
  // settles, flush 2 re-enters first, captures the new dirty set, installs a
  // new activeFlush, and parks mid-write on hold2 - with the transaction's
  // continuation scheduled right behind it.
  pendingFlushHold = hold2;
  releaseHold1();
  await settle(60);

  assert.equal(
    txEntered,
    false,
    "the transaction callback must not run concurrently with the second flush's I/O (#5652)",
  );

  releaseHold2();
  await settle(30);
  releaseTx2();
  await tx2;
  await flush1;
  await flush2;
  assert.equal(txEntered, true, "the transaction proceeds normally once the flush chain settles");
  assert.equal((await storage.getMessage("m-f2"))?.content, "tx2 edit", "the post-flush transaction committed");

  // Anti-vacuity: both staged holds must actually have engaged, or the pin
  // proved nothing about the flush/transaction interleaving.
  assert.equal(flushHoldsTaken, 2, "both flushes took their staged mid-write holds");
} finally {
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Store transaction-isolation regression passed.");
