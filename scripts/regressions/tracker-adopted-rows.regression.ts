// Auto-adopt learns tracker rows from manual edits, not from tracker state.
//
// Pins the property the feature rests on: rows a chat was seeded with, or that
// the tracker agent carries forward, never feed back into the list. Only a
// manual edit through PATCH /api/chats/:id/game-state that adds or deletes a
// row name changes what new chats start with, and a deletion sticks.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marinara-tracker-adopted-rows-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { trackerPresetsRoutes } = await import("../../packages/server/src/routes/tracker-presets.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { applyTrackerPresetToChat, foldManualTrackerEdit } =
  await import("../../packages/server/src/services/tracker/tracker-preset.service.js");

type Rows = {
  characterFields: Array<{ name: string; value: string }>;
  characterStats: Array<{ name: string; value: number; max: number; color: string }>;
  personaFields: Array<{ name: string; value: string }>;
  personaStats: Array<{ name: string; value: number; max: number; color: string }>;
};
const empty = (): Rows => ({ characterFields: [], characterStats: [], personaFields: [], personaStats: [] });
const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);

const amy = (customFields: Record<string, string>, stats: Array<Record<string, unknown>> = []) => ({
  characterId: "card-amy",
  name: "Amy",
  customFields,
  stats,
});

// ── Pure fold semantics ──
{
  const added = foldManualTrackerEdit(
    empty(),
    { presentCharacters: JSON.stringify([amy({ Mood: "calm" })]) },
    {
      presentCharacters: [
        amy({ Mood: "calm", Hunger: "peckish" }, [{ name: "Energy", value: 3, max: 50, color: "var(--primary)" }]),
      ],
    },
  );
  assert.ok(added);
  assert.deepEqual(added.characterFields, [{ name: "Hunger", value: "" }], "a field is learned by name, value blank");
  assert.deepEqual(
    added.characterStats,
    [{ name: "Energy", value: 50, max: 50, color: "#a78bfa" }],
    "a stat starts full, keeps its max, and a non-hex color falls back",
  );

  const before = { presentCharacters: [amy({ Mood: "", Hunger: "" })] };
  assert.equal(
    foldManualTrackerEdit(added, before, { presentCharacters: [amy({ Mood: "furious", Hunger: "starving" })] }),
    null,
    "a value edit changes no row names, so nothing is learned",
  );

  const removed = foldManualTrackerEdit(added, before, { presentCharacters: [amy({ Mood: "" })] });
  assert.deepEqual(names(removed!.characterFields), [], "deleting a row forgets it");

  const renamed = foldManualTrackerEdit(added, before, { presentCharacters: [amy({ Mood: "", Appetite: "" })] });
  assert.deepEqual(names(renamed!.characterFields), ["Appetite"], "a rename moves the learned row");

  const cleared = foldManualTrackerEdit(added, before, { presentCharacters: [] });
  assert.equal(cleared, null, "removing every character, as Clear does, forgets nothing");

  const newcomer = foldManualTrackerEdit(added, before, {
    presentCharacters: [
      amy({ Mood: "", Hunger: "" }),
      { characterId: "card-bea", name: "Bea", customFields: { Wings: "" } },
    ],
  });
  assert.equal(newcomer, null, "rows on a character the edit adds are not learned");

  const twoCharacters = foldManualTrackerEdit(
    empty(),
    { presentCharacters: [amy({}), { name: "Guard", customFields: {} }] },
    { presentCharacters: [amy({ Scar: "" }), { name: "guard ", customFields: { scar: "" } }] },
  );
  assert.deepEqual(
    names(twoCharacters!.characterFields),
    ["Scar"],
    "the same name added on two characters is learned once; an id-less character matches by name",
  );

  const persona = foldManualTrackerEdit(
    empty(),
    {
      personaStats: JSON.stringify([{ name: "Energy", value: 10, max: 100, color: "#22c55e" }]),
      playerStats: JSON.stringify({ customTrackerFields: [{ name: "Mood", value: "ok" }] }),
    },
    {
      personaStats: [
        { name: "Energy", value: 10, max: 100, color: "#22c55e" },
        { name: "Satiety", value: 40, max: 80, color: "#f59e0b" },
      ],
      playerStats: {
        customTrackerFields: [
          { name: "Mood", value: "ok" },
          { name: "Chore", value: "dishes" },
        ],
      },
    },
  );
  assert.deepEqual(persona!.personaStats, [{ name: "Satiety", value: 80, max: 80, color: "#f59e0b" }]);
  assert.deepEqual(persona!.personaFields, [{ name: "Chore", value: "" }]);

  assert.equal(
    foldManualTrackerEdit(
      persona!,
      { playerStats: JSON.stringify({ customTrackerFields: [{ name: "Chore", value: "" }] }) },
      { playerStats: { inventory: [] } },
    ),
    null,
    "a playerStats write without custom fields is not read as deleting them",
  );
}

// ── Through the real PATCH route ──
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const app = require("fastify")();
const db = await getDB();
const chats = createChatsStorage(db);
const gameStates = createGameStateStorage(db);
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(trackerPresetsRoutes, { prefix: "/api/tracker-presets" });

const adopted = async () =>
  (await app.inject({ method: "GET", url: "/api/tracker-presets/adopted-rows" })).json() as Rows;
const patch = async (chatId: string, payload: Record<string, unknown>) => {
  const response = await app.inject({ method: "PATCH", url: `/api/chats/${chatId}/game-state`, payload });
  assert.equal(response.statusCode, 200, response.body);
};
const newChat = async (name: string) => {
  const chat = await chats.create({ name, mode: "roleplay", characterIds: [] });
  assert.ok(chat);
  return chat;
};
const seedSnapshot = (
  chatId: string,
  presentCharacters: unknown[],
  { messageId = "", personaStats = null }: { messageId?: string; personaStats?: unknown[] | null } = {},
) =>
  gameStates.create({
    chatId,
    messageId,
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: presentCharacters as never,
    recentEvents: [],
    playerStats: null,
    personaStats: personaStats as never,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: false,
  });
const latestNames = async (chatId: string) => {
  const raw = (await gameStates.getLatest(chatId))?.presentCharacters;
  const characters = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? [])) as Array<{
    customFields?: Record<string, string>;
    stats?: Array<{ name: string }>;
  }>;
  return {
    fields: Object.keys(characters[0]?.customFields ?? {}),
    stats: names(characters[0]?.stats ?? []),
  };
};

const HP = { name: "HP", value: 100, max: 100, color: "#ef4444" };
const ENERGY = { name: "Energy", value: 0, max: 100, color: "var(--primary)" };
const SATIETY = { name: "Satiety", value: 10, max: 100, color: "#f59e0b" };

try {
  // A chat seeded with a row the user never chose, like the HP/MP a scan of recent snapshots spread.
  const seeded = await newChat("Seeded");
  await seedSnapshot(seeded.id, [amy({ Mood: "" }, [HP])]);

  await patch(seeded.id, { manual: true, presentCharacters: [amy({ Mood: "", Hunger: "" }, [HP])] });
  assert.deepEqual(await adopted(), empty(), "nothing is learned while auto-adopt is off");

  await app.inject({ method: "PUT", url: "/api/tracker-presets/auto-adopt", payload: { enabled: true } });

  await patch(seeded.id, { manual: true, presentCharacters: [amy({ Mood: "", Hunger: "" }, [HP, ENERGY])] });
  let rows = await adopted();
  assert.deepEqual(names(rows.characterStats), ["Energy"], "only the stat this edit added is learned, not seeded HP");
  assert.deepEqual(names(rows.characterFields), [], "Hunger was already there before this edit");

  await patch(seeded.id, { presentCharacters: [amy({ Mood: "", Hunger: "", Agent: "" }, [HP, ENERGY])] });
  assert.deepEqual(names((await adopted()).characterFields), [], "a write without manual: true is never learned");

  // ── Persona rows ──
  await patch(seeded.id, {
    manual: true,
    personaStats: [SATIETY],
    playerStats: { customTrackerFields: [{ name: "Chore", value: "dishes" }] },
  });
  rows = await adopted();
  assert.deepEqual(names(rows.personaStats), ["Satiety"]);
  assert.deepEqual(names(rows.personaFields), ["Chore"]);

  // ── Clear sends empty arrays; read as deletions it would forget Satiety ──
  const cleared = await newChat("Cleared");
  await seedSnapshot(cleared.id, [amy({}, [ENERGY])], { personaStats: [SATIETY] });
  await patch(cleared.id, { manual: true, clearOverrides: true, presentCharacters: [], personaStats: [] });
  rows = await adopted();
  assert.deepEqual(names(rows.personaStats), ["Satiety"], "Clear does not empty the list");
  assert.deepEqual(names(rows.characterStats), ["Energy"]);

  // ── Explicit message target: the baseline is that swipe's snapshot, not the newest one ──
  const targeted = await newChat("Targeted");
  const first = await chats.createMessage({
    chatId: targeted.id,
    role: "assistant",
    characterId: null,
    content: "one",
  });
  const second = await chats.createMessage({
    chatId: targeted.id,
    role: "assistant",
    characterId: null,
    content: "two",
  });
  assert.ok(first && second);
  await seedSnapshot(targeted.id, [amy({ Mood: "" })], { messageId: first.id });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await seedSnapshot(targeted.id, [amy({ Mood: "", Scar: "" })], { messageId: second.id });
  await patch(targeted.id, {
    manual: true,
    messageId: first.id,
    swipeIndex: 0,
    presentCharacters: [amy({ Mood: "", Scar: "" })],
  });
  assert.deepEqual(
    names((await adopted()).characterFields),
    ["Scar"],
    "Scar is new relative to the targeted swipe even though the newest snapshot already had it",
  );

  // ── The loop that kept rows alive: seeding must not feed the list ──
  const next = await newChat("Seeded from the list");
  await seedSnapshot(next.id, [amy({})]);
  const beforeSeeding = await adopted();
  await applyTrackerPresetToChat(app as never, { chatId: next.id, mode: "roleplay", characterIds: [] });
  assert.deepEqual(
    await latestNames(next.id),
    { fields: ["Scar"], stats: ["Energy"] },
    "a new chat gets the learned rows",
  );
  assert.deepEqual(await adopted(), beforeSeeding, "seeding wrote tracker state but learned nothing");

  // Deleting a learned row anywhere stops it spreading, although other chats still hold it.
  await patch(next.id, { manual: true, presentCharacters: [amy({ Scar: "" }, [])] });
  assert.deepEqual(names((await adopted()).characterStats), [], "deleting Energy in one chat forgets it");
  assert.ok((await latestNames(seeded.id)).stats.includes("Energy"), "the chat it came from still tracks it");

  const after = await newChat("After deleting");
  await seedSnapshot(after.id, [amy({})]);
  await applyTrackerPresetToChat(app as never, { chatId: after.id, mode: "roleplay", characterIds: [] });
  assert.deepEqual(
    (await latestNames(after.id)).stats,
    [],
    "other chats still holding Energy do not bring it back, which a scan of recent snapshots did",
  );

  // ── The list is editable directly ──
  const put = await app.inject({
    method: "PUT",
    url: "/api/tracker-presets/adopted-rows",
    payload: { ...rows, characterFields: [{ name: "Mood swing", value: "" }] },
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(names((await adopted()).characterFields), ["Mood swing"]);
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/tracker-presets/adopted-rows",
    payload: { characterStats: [{ name: "", value: 1, max: 1, color: "#000000" }] },
  });
  assert.ok(rejected.statusCode >= 400, "a nameless row is rejected rather than stored");

  console.log("tracker-adopted-rows regression passed.");
} finally {
  await app.close();
  await closeDB();
  rmSync(directory, { recursive: true, force: true });
}
