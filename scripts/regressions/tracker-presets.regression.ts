// Tracker presets against a real Fastify app and real storage.
//
// Pins the contract the whole feature rests on: a preset is a base layer that
// card and chat values always win over, so applying one is additive and
// idempotent, and re-applying never resets a value the tracker already holds.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

import { mergeTrackerNamedEntries } from "../../packages/shared/dist/index.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { trackerPresetsRoutes } from "../../packages/server/src/routes/tracker-presets.routes.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createCharactersStorage } from "../../packages/server/src/services/storage/characters.storage.js";
import { createGameStateStorage } from "../../packages/server/src/services/storage/game-state.storage.js";
import { createTrackerPresetsStorage } from "../../packages/server/src/services/storage/tracker-presets.storage.js";
import { applyTrackerPresetToChat } from "../../packages/server/src/services/tracker/tracker-preset.service.js";

// ── Pure merge semantics ──
// Preset order defines the layout; a colliding card entry keeps the preset's
// slot but its own value; card-only entries append after.
{
  const preset = [{ name: "HP" }, { name: "Stamina" }, { name: "Focus" }];
  const card = [{ name: "hp ", extra: "card" }, { name: "Rage" }] as Array<{ name: string; extra?: string }>;
  const merged = mergeTrackerNamedEntries(preset, card);
  assert.deepEqual(
    merged.map((entry) => entry.name),
    ["hp ", "Stamina", "Focus", "Rage"],
    "card entry keeps the preset slot; card-only entries append",
  );
  assert.equal(merged[0]!.extra, "card", "card value wins the collision");
}

// Case, whitespace and Unicode width all collapse to one field.
assert.equal(mergeTrackerNamedEntries([{ name: "Outfit" }], [{ name: "  outfit  " }]).length, 1);
assert.equal(mergeTrackerNamedEntries([{ name: "HP" }], [{ name: "ＨＰ" }]).length, 1);

// An empty preset is a pass-through, and blank names never become fields.
assert.deepEqual(mergeTrackerNamedEntries([], [{ name: "Solo" }]).map((e) => e.name), ["Solo"]);
assert.deepEqual(mergeTrackerNamedEntries([{ name: "  " }], []), []);

const storageDir = mkdtempSync(join(tmpdir(), "marinara-tracker-presets-"));
process.env.FILE_STORAGE_DIR = storageDir;
const db = await createFileNativeDB();
const chats = createChatsStorage(db);
const characters = createCharactersStorage(db);
const gameStates = createGameStateStorage(db);
const presets = createTrackerPresetsStorage(db);

const app = Fastify();
app.decorate("db", db);
await app.register(trackerPresetsRoutes, { prefix: "/api/tracker-presets" });

const latestCharacters = async (chatId: string) => {
  const snapshot = await gameStates.getLatest(chatId);
  const raw = snapshot?.presentCharacters;
  return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? [])) as Array<{
    characterId: string;
    customFields: Record<string, string>;
    stats: Array<{ name: string; value: number; max: number }>;
  }>;
};

try {
  // ── CRUD through the route ──
  const created = await app.inject({
    method: "POST",
    url: "/api/tracker-presets",
    payload: {
      name: "Slice of Life",
      characterFields: [
        { name: "Outfit", value: "casual" },
        { name: "Injuries", value: "none" },
      ],
      characterStats: [{ name: "Stamina", value: 80, max: 100, color: "#22c55e" }],
      personaFields: [{ name: "Chore", value: "" }],
      personaStats: [{ name: "Satiety", value: 90, max: 100, color: "#f59e0b" }],
    },
  });
  assert.equal(created.statusCode, 200);
  const preset = created.json() as { id: string; name: string; characterFields: Array<{ name: string }> };
  assert.equal(preset.name, "Slice of Life");
  assert.equal(preset.characterFields.length, 2, "JSON payload columns round-trip through storage");

  // A name with no value is still a field; the schema defaults it to "".
  assert.equal((preset as unknown as { personaFields: Array<{ value: string }> }).personaFields[0]!.value, "");

  // ── Activation ──
  assert.equal((await app.inject({ method: "GET", url: "/api/tracker-presets/active" })).json().presetId, null);

  const unknownActive = await app.inject({
    method: "PUT",
    url: "/api/tracker-presets/active",
    payload: { presetId: "does-not-exist" },
  });
  assert.equal(unknownActive.statusCode, 404, "activating a missing preset is rejected, not silently stored");

  await app.inject({ method: "PUT", url: "/api/tracker-presets/active", payload: { presetId: preset.id } });
  assert.equal(await presets.getActiveId(), preset.id);

  // "/active" must not be swallowed by the "/:id" route.
  assert.equal((await app.inject({ method: "GET", url: "/api/tracker-presets/active" })).json().presetId, preset.id);

  // ── Seeding a chat whose card already configures one of the preset's fields ──
  const card = await characters.create({
    name: "Amy",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
    creator: "",
    character_version: "1.0",
    alternate_greetings: [],
    character_book: null,
    extensions: {
      talkativeness: 0.5,
      fav: false,
      world: "",
      depth_prompt: { prompt: "", depth: 4 },
      backstory: "",
      appearance: "",
      trackerCustomFieldDefaults: [{ name: "Outfit", value: "school uniform" }],
    },
  } as never);
  assert.ok(card);
  // Guard the fixture itself: create() takes CharacterData, and a { name, data }
  // wrapper silently nests extensions one level too deep, leaving the card with
  // no tracker defaults and every card-layer assertion below vacuously green.
  assert.equal(
    (JSON.parse(String(card.data)) as { extensions?: { trackerCustomFieldDefaults?: unknown[] } }).extensions
      ?.trackerCustomFieldDefaults?.length,
    1,
    "fixture card must actually carry its tracker field default",
  );

  const chat = await chats.create({
    name: "Preset chat",
    mode: "roleplay",
    characterIds: [card.id],
    groupId: null,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  assert.ok(chat);

  const first = await applyTrackerPresetToChat(app as never, {
    chatId: chat.id,
    mode: "roleplay",
    characterIds: [card.id],
  });
  assert.equal(first.applied, true);
  assert.equal(first.presetName, "Slice of Life");
  assert.equal(first.characters, 1, "a card absent from the tracker is created, not skipped");

  const seeded = await latestCharacters(chat.id);
  assert.equal(seeded.length, 1);
  assert.deepEqual(
    Object.keys(seeded[0]!.customFields),
    ["Outfit", "Injuries"],
    "preset order defines the layout even when a card supplies one of the fields",
  );
  assert.equal(
    seeded[0]!.customFields.Outfit,
    "school uniform",
    "the card layer beats the preset's starting value, without card seeding having run",
  );
  assert.equal(seeded[0]!.customFields.Injuries, "none", "a preset-only row keeps the preset's starting value");
  assert.deepEqual(
    seeded[0]!.stats.map((stat) => stat.name),
    ["Stamina"],
    "the card has RPG Stats disabled, so it contributes no bars",
  );

  // ── Live values survive re-application ──
  // Stands in for the card-owned seeding pass that runs first in
  // chats.routes.ts#seedNewRoleplayChatTrackerDefaults: whatever is already in
  // the tracker, whether written by that pass or by the agent mid-chat, wins.
  const live = await latestCharacters(chat.id);
  live[0]!.customFields.Outfit = "soaked raincoat";
  live[0]!.stats[0]!.value = 12;
  await gameStates.updateLatest(chat.id, { presentCharacters: live as never });

  const second = await applyTrackerPresetToChat(app as never, {
    chatId: chat.id,
    mode: "roleplay",
    characterIds: [card.id],
  });
  assert.equal(second.applied, true);

  const reapplied = await latestCharacters(chat.id);
  assert.equal(reapplied[0]!.customFields.Outfit, "soaked raincoat", "re-applying never resets a tracked value");
  assert.equal(reapplied[0]!.stats[0]!.value, 12, "re-applying never resets a tracked stat");

  // A preset edited to add a row reaches an already-seeded chat on re-apply.
  await presets.update(preset.id, {
    characterFields: [
      { name: "Outfit", value: "" },
      { name: "Injuries", value: "" },
      { name: "Scent", value: "" },
    ],
  });
  await applyTrackerPresetToChat(app as never, { chatId: chat.id, mode: "roleplay", characterIds: [card.id] });
  assert.deepEqual(Object.keys((await latestCharacters(chat.id))[0]!.customFields), [
    "Outfit",
    "Injuries",
    "Scent",
  ]);

  // ── A card edited after the chat exists is picked up by Apply ──
  // The card-owned seeding pass in chats.routes.ts runs only at chat creation
  // and character-add, so without the card layer read here these edits would
  // never reach an existing chat.
  await characters.update(card.id, {
    extensions: {
      trackerCustomFieldDefaults: [
        { name: "Outfit", value: "school uniform" },
        { name: "Familiar", value: "black cat" },
      ],
      rpgStats: {
        enabled: true,
        attributes: [],
        hp: { value: 70, max: 70 },
        pools: [{ name: "Resolve", value: 70, max: 70, color: "#8b5cf6" }],
      },
    },
  } as never);

  await applyTrackerPresetToChat(app as never, { chatId: chat.id, mode: "roleplay", characterIds: [card.id] });
  const afterCardEdit = await latestCharacters(chat.id);
  assert.deepEqual(
    Object.keys(afterCardEdit[0]!.customFields),
    ["Outfit", "Injuries", "Scent", "Familiar"],
    "a field added to the card after the chat existed is appended after the preset's rows",
  );
  assert.equal(afterCardEdit[0]!.customFields.Familiar, "black cat");
  assert.equal(
    afterCardEdit[0]!.customFields.Outfit,
    "soaked raincoat",
    "the live tracker value still beats the card, so the card layer cannot reset play state",
  );
  assert.deepEqual(
    afterCardEdit[0]!.stats.map((stat) => stat.name),
    ["Stamina", "Resolve"],
    "enabling RPG Stats on the card contributes its pools behind the preset's",
  );

  // ── Chat override beats the global selection; null opts out entirely ──
  const optedOut = await applyTrackerPresetToChat(app as never, {
    chatId: chat.id,
    mode: "roleplay",
    characterIds: [card.id],
    chatPresetId: null,
  });
  assert.equal(optedOut.applied, false, "a chat override of null disables the preset, not just the chat's own");

  const other = await presets.create({ name: "Dark Fantasy", characterFields: [{ name: "Corruption", value: "" }] });
  assert.ok(other);
  const overridden = await applyTrackerPresetToChat(app as never, {
    chatId: chat.id,
    mode: "roleplay",
    characterIds: [card.id],
    chatPresetId: other.id,
  });
  assert.equal(overridden.presetName, "Dark Fantasy");

  // An override pointing at a deleted preset falls back to the global one
  // rather than silently turning the tracker preset off.
  const stale = await presets.resolveForChat("deleted-preset-id");
  assert.equal(stale.preset?.id, preset.id);
  assert.equal(stale.source, "global");

  // ── Persona: bars merge, and text fields exist at card level for the first time ──
  // The card's own rows ride inside the personaStats JSON blob; every normalizer
  // and Zod boundary on that column passes unknown keys through, which is why no
  // personas column was added.
  const persona = await characters.createPersona("Traveller", "", undefined, {
    personaStats: JSON.stringify({
      enabled: true,
      bars: [{ name: "Energy", value: 55, max: 100, color: "#22c55e" }],
      fields: [{ name: "Mood", value: "wary" }],
    }),
  });
  assert.ok(persona);

  const personaChat = await chats.create({
    name: "Persona preset chat",
    mode: "roleplay",
    characterIds: [],
    groupId: null,
    personaId: persona.id,
    promptPresetId: null,
    connectionId: null,
  });
  assert.ok(personaChat);

  const personaApply = await applyTrackerPresetToChat(app as never, {
    chatId: personaChat.id,
    mode: "roleplay",
    characterIds: [],
    personaId: persona.id,
    preset: (await presets.getById(preset.id))!,
  });
  assert.equal(personaApply.persona, true);

  const personaSnapshot = await gameStates.getLatest(personaChat.id);
  const seededBars = JSON.parse(String(personaSnapshot?.personaStats ?? "[]")) as Array<{
    name: string;
    value: number;
  }>;
  assert.deepEqual(
    seededBars.map((bar) => bar.name),
    ["Satiety", "Energy"],
    "preset bars lead; a card bar the preset does not name is appended",
  );
  assert.equal(seededBars[1]!.value, 55, "the card's own starting value survives");

  const seededPlayer = JSON.parse(String(personaSnapshot?.playerStats ?? "{}")) as {
    customTrackerFields?: Array<{ name: string; value: string }>;
  };
  assert.deepEqual(
    (seededPlayer.customTrackerFields ?? []).map((field) => field.name),
    ["Chore", "Mood"],
    "persona text fields reach PlayerStats.customTrackerFields",
  );
  assert.equal(seededPlayer.customTrackerFields![1]!.value, "wary");

  // ── Non-roleplay modes are untouched ──
  const convo = await chats.create({
    name: "Convo",
    mode: "conversation",
    characterIds: [card.id],
    groupId: null,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  assert.ok(convo);
  const skipped = await applyTrackerPresetToChat(app as never, {
    chatId: convo.id,
    mode: "conversation",
    characterIds: [card.id],
  });
  assert.equal(skipped.applied, false);
  assert.equal(await gameStates.getLatest(convo.id), null, "no snapshot is created for a non-roleplay chat");

  // ── Deleting the active preset clears the global pointer ──
  const removed = await app.inject({ method: "DELETE", url: `/api/tracker-presets/${preset.id}` });
  assert.equal(removed.statusCode, 204);
  assert.equal(await presets.getActiveId(), null, "a deleted preset does not stay selected");
  assert.equal((await presets.resolveForChat(undefined)).source, "none");

  console.log("tracker-presets regression passed.");
} finally {
  await app.close();
  rmSync(storageDir, { recursive: true, force: true });
}
