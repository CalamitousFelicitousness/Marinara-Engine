// #5110 regression: game checkpoints must not accumulate captured snapshot blobs without bound.
//
// Auto-checkpoints fire at session start/end and on every combat start/end; only manual deletion
// removed one, so a long campaign multiplied every captured blob into permanent heap and an
// O(n^2) shard rewrite per new checkpoint. `create` now caps the auto-checkpoints to the newest
// MAX_AUTO_CHECKPOINTS_PER_TRIGGER per trigger type (manual checkpoints exempt), and `listForChat`
// projects the list columns instead of copying the blobs out just to strip them.
//
// Pinned here:
//   1) pruneAutoCheckpoints keeps exactly the newest N per trigger type, leaves an under-cap
//      trigger and every manual checkpoint alone, and never reaches across chats.
//   2) listForChat no longer exposes the captured blob columns.
//   3) End-to-end: create() enforces the cap, exempts manual, and never prunes the row it just
//      returned (the protectId guard) even under rapid same-instant creates.
import assert from "node:assert/strict";
import { gameCheckpoints } from "../../packages/server/src/db/schema/index.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createGameStateStorage } from "../../packages/server/src/services/storage/game-state.storage.js";
import {
  createCheckpointService,
  pruneAutoCheckpoints,
  MAX_AUTO_CHECKPOINTS_PER_TRIGGER,
  type CheckpointTrigger,
} from "../../packages/server/src/services/game/checkpoint.service.js";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const db = await getDB();
const chats = createChatsStorage(db);
const stateStore = createGameStateStorage(db);
const checkpointSvc = createCheckpointService(db);
const createdChatIds: string[] = [];

const N = MAX_AUTO_CHECKPOINTS_PER_TRIGGER;

// A deterministic, lexically-sortable ISO timestamp (matches now()'s toISOString shape).
const ts = (n: number) => `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z`;

async function seedCheckpoint(chatId: string, triggerType: CheckpointTrigger, order: number, id: string) {
  await db.insert(gameCheckpoints).values({
    id,
    chatId,
    snapshotId: `snap-${id}`,
    spatialSnapshotId: null,
    snapshotData: JSON.stringify({ blob: "x".repeat(64) }),
    spatialSnapshotData: null,
    messageId: `m-${id}`,
    label: `${triggerType} ${order}`,
    triggerType,
    location: null,
    gameState: null,
    weather: null,
    timeOfDay: null,
    turnNumber: null,
    createdAt: ts(order),
  });
}

try {
  // ── Part 1: pruneAutoCheckpoints caps per trigger, exempts manual, isolates chats ──
  {
    const chatA = await chats.create({ name: "retention A", mode: "game", characterIds: [] });
    const chatB = await chats.create({ name: "retention B", mode: "game", characterIds: [] });
    assert.ok(chatA && chatB);
    createdChatIds.push(chatA.id, chatB.id);

    const overflow = N + 3;
    for (let i = 1; i <= overflow; i++) await seedCheckpoint(chatA.id, "combat_start", i, `A-cs-${i}`);
    // An under-cap trigger and manual saves that must all survive.
    await seedCheckpoint(chatA.id, "session_start", 1, "A-ss-1");
    await seedCheckpoint(chatA.id, "session_start", 2, "A-ss-2");
    for (let i = 1; i <= N + 4; i++) await seedCheckpoint(chatA.id, "manual", i, `A-man-${i}`);
    // A second chat with its own overflow that pruning chatA must never touch.
    for (let i = 1; i <= N + 2; i++) await seedCheckpoint(chatB.id, "combat_start", i, `B-cs-${i}`);

    await pruneAutoCheckpoints(db, chatA.id);

    const aList = await checkpointSvc.listForChat(chatA.id);
    const aCombat = aList.filter((r) => r.triggerType === "combat_start").map((r) => r.id);
    assert.equal(aCombat.length, N, `combat_start capped to ${N}`);
    const expectedNewest = new Set(Array.from({ length: N }, (_, k) => `A-cs-${overflow - k}`));
    assert.deepEqual(new Set(aCombat), expectedNewest, "exactly the newest N combat_start rows survive");
    assert.equal(
      aList.filter((r) => r.triggerType === "session_start").length,
      2,
      "an under-cap trigger type is left untouched",
    );
    assert.equal(
      aList.filter((r) => r.triggerType === "manual").length,
      N + 4,
      "manual checkpoints are exempt from the cap",
    );

    const bCombat = (await checkpointSvc.listForChat(chatB.id)).filter((r) => r.triggerType === "combat_start");
    assert.equal(bCombat.length, N + 2, "pruning one chat never touches another chat's checkpoints");

    // Part 2: listForChat must not carry the captured blob columns, and must stay newest-first
    // even though it now projects the list columns (the store sorts full rows before projecting).
    assert.ok(aList.length > 0);
    assert.ok(!("snapshotData" in aList[0]!), "listForChat must not expose snapshotData");
    assert.ok(!("spatialSnapshotData" in aList[0]!), "listForChat must not expose spatialSnapshotData");
    const listedCreatedAts = aList.map((r) => r.createdAt);
    assert.deepEqual(
      listedCreatedAts,
      [...listedCreatedAts].sort().reverse(),
      "listForChat returns checkpoints newest-first",
    );
  }

  // ── Part 3: end-to-end create() enforces the cap, exempts manual, protects the new row ──
  {
    const chat = await chats.create({ name: "retention integration", mode: "game", characterIds: [] });
    assert.ok(chat);
    createdChatIds.push(chat.id);

    const m1 = await chats.createMessage({
      chatId: chat.id,
      role: "assistant",
      characterId: null,
      content: "turn 1",
    } as Parameters<typeof chats.createMessage>[0]);
    assert.ok(m1);
    await stateStore.create({
      chatId: chat.id,
      messageId: m1.id,
      swipeIndex: 0,
      date: "",
      time: "",
      location: "",
      weather: "",
      temperature: "",
      worldCustomFields: [],
      presentCharacters: [],
      recentEvents: [],
      playerStats: null,
      personaStats: null,
      fieldLocks: {},
      hiddenTrackerFields: [],
      committed: true,
    } as Parameters<typeof stateStore.create>[0]);
    const snapshot = await stateStore.getLatest(chat.id);
    assert.ok(snapshot);

    const mk = (triggerType: "combat_end" | "manual") =>
      checkpointSvc.create({
        chatId: chat.id,
        snapshotId: snapshot.id,
        spatialSnapshotId: null,
        messageId: snapshot.messageId,
        label: triggerType,
        triggerType,
        location: null,
        gameState: null,
        weather: null,
        timeOfDay: null,
        turnNumber: null,
      });

    // Rapid successive auto creates (same wall-clock instant is possible) plus manual saves.
    for (let i = 0; i < N + 2; i++) await mk("combat_end");
    await mk("manual");
    await mk("manual");

    const list = await checkpointSvc.listForChat(chat.id);
    assert.equal(
      list.filter((r) => r.triggerType === "combat_end").length,
      N,
      "create() enforces the per-trigger cap end-to-end",
    );
    assert.equal(
      list.filter((r) => r.triggerType === "manual").length,
      2,
      "manual checkpoints survive create()-driven pruning",
    );

    // The row create() just returned must always exist, even if it collided on createdAt.
    const lastId = await mk("combat_end");
    const after = await checkpointSvc.listForChat(chat.id);
    assert.ok(after.some((r) => r.id === lastId), "the just-created checkpoint is never pruned (protectId guard)");
    assert.equal(
      after.filter((r) => r.triggerType === "combat_end").length,
      N,
      "the cap still holds after the next create()",
    );
  }

  console.log("checkpoint retention regression passed");
} finally {
  for (const id of createdChatIds) await chats.remove(id).catch(() => {});
  await closeDB();
}
