// #5406 regression: one per-chat monotonic write ordinal shared by the experience-state
// rows and the queued chat-metadata patch path.
//
// A game-surface Experience keeps its save in two stores: the per-anchor game_engine_state
// row (#5102, the authority, rewinds with the story) and a chat-metadata key it maintains
// as a boot cache (chat-global, never rewinds). When a session degrades to metadata-only
// writes the two disagree at the next boot, and nothing let the client tell "metadata is
// ahead because the last session was degraded" from "the row is behind because the player
// swiped back". A single server-assigned counter that BOTH paths draw from makes the boot
// comparison total: whichever store carries the higher ordinal is the later write.
//
// Pinned behaviors:
//   1. Consecutive PUTs return strictly increasing writeOrdinal values; GET returns the
//      stored row's ordinal, and a chat with no save reads writeOrdinal: null.
//   2. A queued metadata patch that changes a top-level key draws from the SAME counter and
//      stamps metadata.metadataWriteOrdinals[key]; the mirror never stamps itself.
//   3. Interleaved PUT/PATCH storms allocate strictly increasing values with no reuse across
//      the two lock domains (experience write lock vs metadata patch queue).
//   4. The mirror is engine-owned: a patch supplying metadataWriteOrdinals cannot forge it.
//   5. A patch that changes nothing burns no ordinal and leaves the mirror alone (so a
//      spread-`current` updater cannot falsely advance an untouched package's key).
//   6. Deleting a key drops its mirror entry but still advances the counter.
//   7. Pre-#5406 rows (written without an ordinal) read back writeOrdinal: null.
//   8. Checkpoint restore re-allocates rather than cloning the captured ordinal, so the
//      restored world is the newest experience-store write and never reuses a value.
//   9. Branch copy inherits the source counter as a floor, so the branch's first allocation
//      is strictly greater than every ordinal its copied metadata mirror carries.
import assert from "node:assert/strict";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { gameRoutes } from "../../packages/server/src/routes/game.routes.js";
import { createCheckpointService } from "../../packages/server/src/services/game/checkpoint.service.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createGameEngineStateStorage } from "../../packages/server/src/services/storage/game-engine-state.storage.js";
import { createGameStateStorage } from "../../packages/server/src/services/storage/game-state.storage.js";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const db = await getDB();
const chats = createChatsStorage(db);
const engineStore = createGameEngineStateStorage(db);
const stateStore = createGameStateStorage(db);
const checkpointSvc = createCheckpointService(db);
const createdChatIds: string[] = [];

const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });

const EXPERIENCE_ID = "experience-ordinal-test";
const PACKAGE_KEY = "pixelforgeSaveCache";

async function createExperienceChat(name: string) {
  const chat = await chats.create({ name, mode: "game", characterIds: [] });
  assert.ok(chat);
  createdChatIds.push(chat.id);
  await chats.patchMetadata(chat.id, () => ({ gameExperienceId: EXPERIENCE_ID }));
  return chat;
}

const putState = (chatId: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/game/${chatId}/experience-state`, payload: payload as object });
const getState = (chatId: string) => app.inject({ method: "GET", url: `/api/game/${chatId}/experience-state` });

const addAssistantMessage = async (chatId: string, content: string) => {
  const message = await chats.createMessage({
    chatId,
    role: "assistant",
    characterId: null,
    content,
  } as Parameters<typeof chats.createMessage>[0]);
  assert.ok(message);
  return message;
};

async function readMetadata(chatId: string): Promise<Record<string, unknown>> {
  const chat = await chats.getById(chatId);
  assert.ok(chat, "chat should still exist");
  const raw = (chat as { metadata?: unknown }).metadata;
  if (typeof raw !== "string") return (raw as Record<string, unknown>) ?? {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readMirror(chatId: string): Promise<Record<string, number>> {
  const meta = await readMetadata(chatId);
  const mirror = meta.metadataWriteOrdinals;
  return mirror && typeof mirror === "object" ? (mirror as Record<string, number>) : {};
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

try {
  // ── 1. PUT returns increasing ordinals; GET returns the row's ordinal ──
  {
    const chat = await createExperienceChat("ordinal round trip");
    const empty = await getState(chat.id);
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().writeOrdinal, null, "a chat with no save reports writeOrdinal: null");

    await addAssistantMessage(chat.id, "turn 1");
    const first = await putState(chat.id, { state: { step: 1 } });
    assert.equal(first.statusCode, 200, first.body);
    const firstOrdinal = first.json().writeOrdinal;
    assert.ok(isPositiveInt(firstOrdinal), `PUT returns a positive integer ordinal, got ${firstOrdinal}`);

    const second = await putState(chat.id, { state: { step: 2 } });
    const secondOrdinal = second.json().writeOrdinal;
    assert.ok(
      isPositiveInt(secondOrdinal) && secondOrdinal > firstOrdinal,
      `a later PUT allocates a strictly higher ordinal (${firstOrdinal} -> ${secondOrdinal})`,
    );

    const get = await getState(chat.id);
    assert.equal(get.json().writeOrdinal, secondOrdinal, "GET returns the stored row's ordinal");
    assert.deepEqual(get.json().state, { step: 2 }, "GET still returns the state alongside the ordinal");

    // A save on a NEW anchor keeps its own ordinal — swiping back must surface the ordinal
    // of the row the reader is looking at, not the chat's high-water mark.
    const m2 = await addAssistantMessage(chat.id, "turn 2");
    const third = await putState(chat.id, { state: { step: 3 } });
    const thirdOrdinal = third.json().writeOrdinal;
    assert.ok(thirdOrdinal > secondOrdinal, "a new-anchor save still advances the counter");
    const row = await engineStore.getByChatAndMessage(chat.id, m2.id, 0, `experience:${EXPERIENCE_ID}`);
    assert.ok(row);
    assert.equal(row.writeOrdinal, thirdOrdinal, "the stored row carries the ordinal the PUT returned");
  }

  // ── 2. A metadata patch draws from the same counter and stamps the mirror ──
  {
    const chat = await createExperienceChat("ordinal metadata stamp");
    await addAssistantMessage(chat.id, "turn 1");

    const put = await putState(chat.id, { state: { world: "A" } });
    const rowOrdinal = put.json().writeOrdinal;

    await chats.patchMetadata(chat.id, () => ({ [PACKAGE_KEY]: { world: "A" } }));
    const mirror = await readMirror(chat.id);
    assert.ok(isPositiveInt(mirror[PACKAGE_KEY]), "the patched key is stamped in the mirror");
    assert.ok(
      mirror[PACKAGE_KEY] > rowOrdinal,
      `the metadata patch draws from the SAME counter as the row (${rowOrdinal} -> ${mirror[PACKAGE_KEY]})`,
    );
    assert.equal(mirror.metadataWriteOrdinals, undefined, "the engine-owned mirror never stamps an ordinal for itself");

    // And back the other way: the next row write must exceed the metadata stamp.
    const after = await putState(chat.id, { state: { world: "B" } });
    assert.ok(
      after.json().writeOrdinal > mirror[PACKAGE_KEY],
      "a row write after a metadata patch exceeds the metadata stamp",
    );
  }

  // ── 3. Interleaved PUT/PATCH: strictly increasing, no reuse ──
  {
    const chat = await createExperienceChat("ordinal interleave");
    await addAssistantMessage(chat.id, "turn 1");

    const ROUNDS = 8;
    const puts: Array<Promise<number>> = [];
    const patchKeys: string[] = [];
    for (let index = 0; index < ROUNDS; index += 1) {
      puts.push(putState(chat.id, { state: { tick: index } }).then((res) => res.json().writeOrdinal as number));
      const key = `interleaveKey${index}`;
      patchKeys.push(key);
      // Distinct keys so every patch's ordinal stays independently observable in the mirror.
      puts.push(chats.patchMetadata(chat.id, () => ({ [key]: index })).then(() => -1));
    }
    const settled = await Promise.all(puts);
    const putOrdinals = settled.filter((value) => value !== -1);
    const mirror = await readMirror(chat.id);
    const patchOrdinals = patchKeys.map((key) => mirror[key]);

    for (const ordinal of [...putOrdinals, ...patchOrdinals]) {
      assert.ok(isPositiveInt(ordinal), `every allocated ordinal is a positive integer, got ${ordinal}`);
    }
    const all = [...putOrdinals, ...patchOrdinals];
    assert.equal(
      new Set(all).size,
      all.length,
      `no ordinal is ever reused across the two lock domains (saw ${JSON.stringify(all.slice().sort((a, b) => a - b))})`,
    );
    // Each store's own writes are ordered by issue order even though they raced the other store.
    for (let index = 1; index < putOrdinals.length; index += 1) {
      assert.ok(
        putOrdinals[index] > putOrdinals[index - 1],
        "serialized PUTs stay strictly increasing while metadata patches interleave",
      );
    }
    const counterChat = await chats.getById(chat.id);
    assert.ok(counterChat);
    assert.ok(
      (counterChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter! >= Math.max(...all),
      "the persisted counter is at least the highest value it handed out",
    );
  }

  // ── 4. The mirror is engine-owned: a patch cannot forge it ──
  {
    const chat = await createExperienceChat("ordinal forgery");
    await chats.patchMetadata(chat.id, () => ({ [PACKAGE_KEY]: { world: "real" } }));
    const honest = (await readMirror(chat.id))[PACKAGE_KEY];
    assert.ok(isPositiveInt(honest));

    await chats.patchMetadata(chat.id, () => ({
      metadataWriteOrdinals: { [PACKAGE_KEY]: 9_000_000 },
      unrelatedKey: 1,
    }));
    const mirror = await readMirror(chat.id);
    assert.notEqual(mirror[PACKAGE_KEY], 9_000_000, "a caller-supplied mirror is discarded, not merged");
    assert.equal(mirror[PACKAGE_KEY], honest, "the untouched key keeps its real ordinal");
    assert.ok(isPositiveInt(mirror.unrelatedKey), "the real key in the same patch is still stamped");
  }

  // ── 5. A no-op patch burns no ordinal and leaves other keys alone ──
  {
    const chat = await createExperienceChat("ordinal no-op");
    await chats.patchMetadata(chat.id, () => ({ [PACKAGE_KEY]: { world: "keep" }, other: 1 }));
    const before = await readMirror(chat.id);
    const beforeChat = await chats.getById(chat.id);
    const beforeCounter = (beforeChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter;

    // The `{ ...current, changedKey }` shape used across the storage layer: every key is
    // present in the patch, but only one value actually differs.
    await chats.patchMetadata(chat.id, (current) => ({ ...current, other: 2 }));
    const after = await readMirror(chat.id);
    assert.equal(
      after[PACKAGE_KEY],
      before[PACKAGE_KEY],
      "a spread-`current` patch does not falsely advance an untouched key's ordinal",
    );
    assert.ok(after.other > before.other, "the key whose value changed IS re-stamped");

    // A patch where nothing changes at all must not allocate.
    const stableChat = await chats.getById(chat.id);
    const stableCounter = (stableChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter;
    await chats.patchMetadata(chat.id, (current) => ({ ...current }));
    const idleChat = await chats.getById(chat.id);
    assert.equal(
      (idleChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter,
      stableCounter,
      "a patch that changes nothing burns no ordinal",
    );
    assert.ok(
      typeof beforeCounter === "number" && stableCounter! > beforeCounter,
      "the real change did advance the counter",
    );
  }

  // ── 6. Deleting a key drops its mirror entry but still advances the counter ──
  {
    const chat = await createExperienceChat("ordinal delete");
    await chats.patchMetadata(chat.id, () => ({ doomed: { a: 1 } }));
    assert.ok(isPositiveInt((await readMirror(chat.id)).doomed));
    const beforeChat = await chats.getById(chat.id);
    const beforeCounter = (beforeChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter!;

    await chats.patchMetadata(chat.id, () => ({ doomed: undefined }));
    assert.equal((await readMirror(chat.id)).doomed, undefined, "a deleted key's mirror entry is pruned");
    const afterChat = await chats.getById(chat.id);
    assert.ok(
      (afterChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter! > beforeCounter,
      "the delete still advances the counter so later writes sort after it",
    );
  }

  // ── 7. Pre-#5406 rows read back as null ──
  {
    const chat = await createExperienceChat("ordinal legacy row");
    const m1 = await addAssistantMessage(chat.id, "turn 1");
    // Written the way every pre-#5406 caller wrote: no ordinal supplied.
    await engineStore.create({
      chatId: chat.id,
      messageId: m1.id,
      swipeIndex: 0,
      gameType: `experience:${EXPERIENCE_ID}`,
      schemaVersion: 1,
      state: JSON.stringify({ legacy: true }),
      committed: true,
    });
    const get = await getState(chat.id);
    assert.equal(get.statusCode, 200, get.body);
    assert.equal(get.json().writeOrdinal, null, "a row written without an ordinal reads back as null, not undefined");
    assert.ok("writeOrdinal" in get.json(), "writeOrdinal is always present in the GET shape");
  }

  // ── 8. Checkpoint restore re-allocates instead of cloning the captured ordinal ──
  {
    const chat = await createExperienceChat("ordinal checkpoint restore");
    const m1 = await addAssistantMessage(chat.id, "turn 1");
    const captured = await putState(chat.id, { state: { world: "at-checkpoint" } });
    const capturedOrdinal = captured.json().writeOrdinal as number;

    await stateStore.create({
      chatId: chat.id,
      messageId: m1.id,
      swipeIndex: 0,
      location: "",
      gameState: "exploration",
      committed: true,
    } as Parameters<typeof stateStore.create>[0]);
    const snapshot = await stateStore.getLatest(chat.id);
    assert.ok(snapshot);
    const cpId = await checkpointSvc.create({
      chatId: chat.id,
      snapshotId: snapshot.id,
      spatialSnapshotId: null,
      messageId: m1.id,
      label: "ordinal cp",
      triggerType: "manual",
    });

    // Metadata races ahead while the row sits at its checkpoint value — the degraded-session
    // shape the discriminator exists for.
    await chats.patchMetadata(chat.id, () => ({ [PACKAGE_KEY]: { world: "metadata-ahead" } }));
    const metadataOrdinal = (await readMirror(chat.id))[PACKAGE_KEY];
    assert.ok(metadataOrdinal > capturedOrdinal);

    const res = await app.inject({
      method: "POST",
      url: "/api/game/checkpoint/load",
      payload: { chatId: chat.id, checkpointId: cpId },
    });
    assert.equal(res.statusCode, 200, `checkpoint load should succeed: ${res.statusCode} ${res.body}`);

    const restored = await getState(chat.id);
    assert.deepEqual(restored.json().state, { world: "at-checkpoint" }, "restore recovers the captured world");
    const restoredOrdinal = restored.json().writeOrdinal;
    assert.ok(
      isPositiveInt(restoredOrdinal) && restoredOrdinal > metadataOrdinal,
      `the restored row is the newest experience-store write (${metadataOrdinal} -> ${restoredOrdinal}), so the boot` +
        " comparison keeps the restore instead of adopting the stale metadata copy",
    );
    assert.notEqual(restoredOrdinal, capturedOrdinal, "the restore allocates a fresh ordinal, never reusing one");
  }

  // ── 9. Branch copy inherits the source counter as a floor ──
  {
    const source = await createExperienceChat("ordinal branch source");
    await addAssistantMessage(source.id, "turn 1");
    await putState(source.id, { state: { world: "source" } });
    await chats.patchMetadata(source.id, () => ({ [PACKAGE_KEY]: { world: "source" } }));
    const sourceChat = await chats.getById(source.id);
    const sourceCounter = (sourceChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter!;
    const inheritedMirrorMax = Math.max(...Object.values(await readMirror(source.id)));

    // What the branch route does after copying the source metadata verbatim.
    const branch = await createExperienceChat("ordinal branch target");
    const copiedMetadata = await readMetadata(source.id);
    await chats.patchMetadata(branch.id, () => ({ ...copiedMetadata }));
    await chats.raiseWriteOrdinalFloor(branch.id, sourceCounter);

    const branchChat = await chats.getById(branch.id);
    assert.ok(
      (branchChat as { writeOrdinalCounter?: number | null }).writeOrdinalCounter! >= sourceCounter,
      "the branch inherits the source counter as a floor",
    );
    await addAssistantMessage(branch.id, "branch turn 1");
    const branchPut = await putState(branch.id, { state: { world: "branch" } });
    assert.ok(
      branchPut.json().writeOrdinal > inheritedMirrorMax,
      "the branch's first allocation exceeds every ordinal its inherited mirror carries",
    );

    // The floor never lowers a counter that is already ahead.
    await chats.raiseWriteOrdinalFloor(branch.id, 1);
    const unchanged = await chats.getById(branch.id);
    assert.ok(
      (unchanged as { writeOrdinalCounter?: number | null }).writeOrdinalCounter! >= sourceCounter,
      "raiseWriteOrdinalFloor never lowers an already-higher counter",
    );
  }

  console.log("experience-state-ordinal regression passed");
} finally {
  for (const chatId of createdChatIds) {
    await engineStore.deleteForChat(chatId).catch(() => undefined);
    await chats.remove(chatId).catch(() => undefined);
  }
  await app.close();
  await closeDB();
}
