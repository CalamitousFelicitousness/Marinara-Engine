/**
 * Character ID macros for characters already in the chat (#6924): `{{<card ID>}}`
 * resolves to the character's name, without adding a second copy of their card.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-active-reference-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { assemblePrompt } = await import("../../packages/server/src/services/prompt/assembler.js");
const { buildReferencedCharacterContext } = await import("../../packages/server/src/services/prompt/macro-context.js");
const { characterDataSchema, createLorebookEntrySchema, createLorebookSchema } =
  await import("../../packages/shared/src/index.js");

const db = await getDB();
try {
  const characters = createCharactersStorage(db);
  const mira = await characters.create(characterDataSchema.parse({ name: "Mira", description: "MIRA_CARD_TEXT" }));
  const kaelen = await characters.create(characterDataSchema.parse({ name: "Kaelen", description: "KAELEN_CARD" }));
  const susie = await characters.create(
    characterDataSchema.parse({ name: "Susie", description: `SUSIE_CARD_TEXT, a friend of {{${mira.id}}}.` }),
  );
  const lorebooks = createLorebooksStorage(db);
  const book = await lorebooks.create(createLorebookSchema.parse({ name: "Cafe lore", isGlobal: true }));
  await lorebooks.createEntry(
    createLorebookEntrySchema.parse({
      lorebookId: book.id,
      name: "Corner table",
      content: `The corner table belongs to {{${kaelen.id}}}.`,
      keys: ["cafe"],
    }),
  );

  const macroCtx = { user: "Ada", char: "Mira", characters: ["Mira", "Kaelen"], variables: {} };
  const onlyActive = await buildReferencedCharacterContext({
    db,
    activeCharacterIds: [mira.id, kaelen.id],
    sources: [`{{${mira.id}}} waves.`],
    chatMessages: [],
    macroCtx,
    wrapFormat: "xml",
    chatId: "active-only",
  });
  assert.deepEqual(onlyActive.references, { [mira.id]: "Mira" }, "a mentioned chat character resolves to its name");
  assert.equal(onlyActive.content, "", "and adds no referenced card");

  const mixed = await buildReferencedCharacterContext({
    db,
    activeCharacterIds: [mira.id, kaelen.id],
    sources: [],
    chatMessages: [{ role: "user", content: `{{${mira.id}}} meets {{${susie.id}}}.` }],
    macroCtx,
    wrapFormat: "xml",
    chatId: "mixed",
    includeLorebooks: false,
  });
  assert.deepEqual(mixed.references, { [mira.id]: "Mira", [susie.id]: "Susie" });
  assert.match(mixed.content, /SUSIE_CARD_TEXT, a friend of Mira\./u, "a referenced card names chat characters too");
  assert.doesNotMatch(mixed.content, /MIRA_CARD_TEXT/u, "a chat character's card is not added a second time");

  const section = (id: string, content: string, markerConfig?: Record<string, string>) => ({
    id,
    presetId: "active-reference",
    identifier: id,
    name: id,
    content,
    role: "system",
    enabled: "true",
    isMarker: markerConfig ? "true" : "false",
    groupId: null,
    markerConfig: markerConfig ? JSON.stringify(markerConfig) : null,
    injectionPosition: "ordered",
    injectionDepth: 0,
    injectionOrder: 0,
    forbidOverrides: "false",
  });
  const assembled = await assemblePrompt({
    db,
    preset: {
      id: "active-reference",
      name: "Active reference",
      sectionOrder: JSON.stringify(["card", "lorebook", "history"]),
      groupOrder: "[]",
      wrapFormat: "xml",
      parameters: "{}",
      variableGroups: "[]",
      variableValues: "{}",
    },
    sections: [
      section("card", `{{description}} {{${mira.id}}} sits with {{${susie.id}}}.`),
      section("lorebook", "", { type: "lorebook" }),
      section("history", "", { type: "chat_history" }),
    ],
    groups: [],
    choiceBlocks: [],
    chatChoices: {},
    chatId: "active-reference",
    characterIds: [mira.id],
    groupCharacterIds: [mira.id, kaelen.id],
    personaName: "Ada",
    personaDescription: "",
    chatMessages: [{ role: "user", content: `I meet {{${kaelen.id}}} at the cafe.` }],
  } as never);
  const prompt = assembled.messages.map((message: { content: string }) => message.content).join("\n");
  assert.match(prompt, /Mira sits with Susie\./u, "prompt sections name a chat character");
  assert.match(prompt, /I meet Kaelen at the cafe\./u, "so do chat messages");
  assert.match(prompt, /The corner table belongs to Kaelen\./u, "and lorebook entries");
  assert.doesNotMatch(prompt, /\{\{[A-Za-z0-9_-]{21}\}\}/u, "no character ID macro is left");
  assert.equal(prompt.match(/MIRA_CARD_TEXT/gu)?.length, 1, "the chat character's card appears once");
  assert.match(prompt, /SUSIE_CARD_TEXT/u, "a character outside the chat is still pulled in");
  console.log("active-character-reference regression passed");
} finally {
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
