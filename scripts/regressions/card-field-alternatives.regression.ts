import assert from "node:assert/strict";
import {
  applyCharacterCardFieldAlternatives,
  cardEntityBelongsToChat,
  cardFieldAlternativesSchema,
} from "../../packages/shared/src/index.js";

const alternative = { id: "alt-1", field: "description" as const, value: "A CHAT DESCRIPTION", chatIds: ["chat-a"] };
assert.equal(cardFieldAlternativesSchema.safeParse([alternative]).success, true);
assert.equal(cardFieldAlternativesSchema.safeParse([alternative, { ...alternative, id: "alt-2" }]).success, false);
assert.equal(cardFieldAlternativesSchema.safeParse([{ ...alternative, field: "system_prompt" }]).success, false);
assert.equal(
  cardFieldAlternativesSchema.safeParse(
    Array.from({ length: 1200 }, (_, index) => ({ ...alternative, id: `alt-${index}`, chatIds: [] })),
  ).success,
  true,
);
const card = {
  name: "A",
  description: "BASE",
  backstory: "LEGACY",
  extensions: {
    backstory: "BASE BACKSTORY",
    cardFieldAlternatives: [alternative, { id: "empty", field: "backstory", value: "", chatIds: ["chat-a"] }],
  },
};
const before = JSON.stringify(card);
const projected = applyCharacterCardFieldAlternatives(card, "chat-a");
assert.equal(projected.description, "A CHAT DESCRIPTION");
assert.equal(projected.extensions.backstory, "");
assert.equal(projected.backstory, "");
assert.equal(JSON.stringify(card), before);
assert.equal(applyCharacterCardFieldAlternatives(card, "chat-b"), card);
assert.equal(cardEntityBelongsToChat({ personaId: "p", characterIds: ["c"] }, "persona", "p"), true);
assert.equal(cardEntityBelongsToChat({ personaId: "p", personaCharacterId: "c" }, "persona", "p"), false);
assert.equal(cardEntityBelongsToChat({ personaCharacterId: "c" }, "character", "c"), true);
assert.equal(
  cardEntityBelongsToChat(
    { mode: "game", metadata: { gameSetupConfig: { personaId: "p", gmCharacterId: "gm", partyCharacterIds: ["pc"] } } },
    "character",
    "gm",
  ),
  true,
);
assert.equal(
  cardEntityBelongsToChat({ mode: "game", metadata: { gameSetupConfig: { personaId: "p" } } }, "persona", "p"),
  true,
);

// API, persistence, and real prompt consumers are exercised below after the
// additive schema is registered. The runner supplies a disposable data root.
const { buildApp } = await import("../../packages/server/src/app.js");
const { getDB } = await import("../../packages/server/src/db/connection.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.js");
const app = await buildApp();
await app.ready();
try {
  async function request(method: "POST" | "PATCH" | "GET", url: string, payload?: unknown, expected = 200) {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
    return response.json();
  }
  const character = await request("POST", "/api/characters", {
    data: characterDataSchema.parse({ name: "Alternative Subject", description: "BASE DESCRIPTION" }),
  });
  const persona = await request("POST", "/api/characters/personas", {
    name: "Alternative Persona",
    description: "BASE PERSONA",
  });
  const firstChat = await request("POST", "/api/chats", {
    name: "Alternative Alpha",
    mode: "roleplay",
    characterIds: [character.id],
    personaId: persona.id,
  });
  const secondChat = await request("POST", "/api/chats", {
    name: "Alternative Beta",
    mode: "roleplay",
    characterIds: [character.id],
    personaId: persona.id,
  });
  const unrelated = await request("POST", "/api/chats", { name: "Unrelated", mode: "roleplay", characterIds: [] });
  const characterAlternatives = [
    { ...alternative, chatIds: [firstChat.id] },
    { id: "second", field: "appearance", value: "SECOND APPEARANCE", chatIds: [secondChat.id] },
  ];
  await request("PATCH", `/api/characters/${character.id}`, {
    data: { extensions: { cardFieldAlternatives: characterAlternatives } },
  });
  await request("PATCH", `/api/characters/personas/${persona.id}`, {
    cardFieldAlternatives: [
      { id: "persona-alt", field: "description", value: "CHAT PERSONA", chatIds: [firstChat.id] },
    ],
  });
  assert.deepEqual(
    (await request("GET", `/api/characters/${character.id}/card-field-chats`)).map((chat: { id: string }) => chat.id),
    [firstChat.id, secondChat.id],
  );
  assert.deepEqual(
    (await request("GET", `/api/characters/personas/${persona.id}/card-field-chats`)).map(
      (chat: { id: string }) => chat.id,
    ),
    [firstChat.id, secondChat.id],
  );
  await request(
    "PATCH",
    `/api/characters/${character.id}`,
    {
      data: {
        extensions: {
          cardFieldAlternatives: [characterAlternatives[0], { ...characterAlternatives[0], id: "conflict" }],
        },
      },
    },
    400,
  );
  const storage = createCharactersStorage(await getDB());
  assert.equal(JSON.parse((await storage.getById(character.id, firstChat.id))!.data).description, "A CHAT DESCRIPTION");
  assert.equal(JSON.parse((await storage.getById(character.id, secondChat.id))!.data).description, "BASE DESCRIPTION");
  assert.equal(JSON.parse((await storage.getById(character.id, unrelated.id))!.data).description, "BASE DESCRIPTION");
  assert.equal((await storage.getPersona(persona.id, firstChat.id))!.description, "CHAT PERSONA");
  assert.equal((await storage.getPersona(persona.id, secondChat.id))!.description, "BASE PERSONA");
  assert.equal((await storage.getPersona(persona.id))!.description, "BASE PERSONA");
  assert.equal(JSON.parse((await storage.getById(character.id))!.data).description, "BASE DESCRIPTION");
  const duplicated = await request("POST", `/api/characters/${character.id}/duplicate`);
  assert.equal(
    JSON.parse((await storage.getById(duplicated.id))!.data).extensions.cardFieldAlternatives.every(
      (entry: { chatIds: string[] }) => entry.chatIds.length === 0,
    ),
    true,
  );
  const duplicatePersona = await request("POST", `/api/characters/personas/${persona.id}/duplicate`);
  assert.equal(duplicatePersona.cardFieldAlternatives[0].chatIds.length, 0);
  await request("PATCH", `/api/chats/${firstChat.id}`, { characterIds: [], personaId: null });
  assert.equal(JSON.parse((await storage.getById(character.id, firstChat.id))!.data).description, "BASE DESCRIPTION");
  assert.equal((await storage.getPersona(persona.id, firstChat.id))!.description, "BASE PERSONA");
  await request("PATCH", `/api/characters/${character.id}`, { data: { extensions: { cardFieldAlternatives: [] } } });
  assert.deepEqual(JSON.parse((await storage.getById(character.id))!.data).extensions.cardFieldAlternatives, []);
  console.info("Card field alternatives API and immutable storage projection passed.");
} finally {
  await app.close();
}
