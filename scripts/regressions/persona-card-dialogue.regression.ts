import assert from "node:assert/strict";
import { resolveMacros } from "../../packages/shared/src/index.js";
const { buildApp } = await import("../../packages/server/src/app.js");
const { getDB } = await import("../../packages/server/src/db/connection.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { resolveChatUserIdentity } = await import("../../packages/server/src/services/chat-user-identity.js");
const { encodePersonaCreate } = await import("../../packages/server/src/services/personas/persona-projector.js");
const { expandMarker } = await import("../../packages/server/src/services/prompt/marker-expander.js");
const app = await buildApp();
await app.ready();
try {
  const storage = createCharactersStorage(await getDB());
  const encoded = encodePersonaCreate({
    name: "Example Persona",
    description: "PERSONA DESCRIPTION",
    mes_example: 'Example Persona: "Observe {{char}} carefully."',
  });
  const saved = await storage.createPersona(encoded.name, encoded.description, undefined, encoded.extra);
  assert.ok(saved);
  const identity = await resolveChatUserIdentity(storage, { personaId: saved.id });
  assert.equal(identity?.mesExample, 'Example Persona: "Observe {{char}} carefully."');
  const macroCtx = {
    user: "Example Persona",
    char: "Subject",
    characters: ["Subject"],
    variables: {},
    personaFields: { description: identity!.description, example: identity!.mesExample },
  };
  assert.match(resolveMacros("{{persona}}", macroCtx), /Observe Subject carefully/);
  const marker = await expandMarker(
    { type: "persona" },
    {
      db: await getDB(),
      chatId: "dialogue-proof",
      characterIds: [],
      personaName: identity!.name,
      personaDescription: identity!.description,
      personaFields: { example: identity!.mesExample },
      chatMessages: [],
      chatSummary: null,
      wrapFormat: "xml",
      enableAgents: false,
      activeAgentIds: [],
      activeLorebookIds: [],
      macroCtx,
    },
  );
  assert.match(marker.content, /<example_dialogue>/);
  assert.match(marker.content, /Observe Subject carefully/);
  const { injectGameGmPromptRuntime } =
    await import("../../packages/server/src/services/generation/game-gm-prompt-runtime.js");
  const game = await injectGameGmPromptRuntime({
    messages: [],
    chatId: "dialogue-game",
    chat: { personaId: saved.id },
    chatMetadata: {},
    world: null,
    characterIds: [],
    chars: storage,
    chats: { getById: async () => null, updateMetadata: async () => {} },
    selectedGameStateSnapshotPromise: Promise.resolve(null),
    mappedMessages: [],
    personaName: identity!.name,
    resolvePromptMacros: (value) => value,
  });
  assert.match(game.gmCtx.playerCard ?? "", /Example dialogue: Example Persona/);
  assert.match(game.gmCtx.playerCard ?? "", /Observe/);
  console.info("Persona dialogue survives persistence, selected identity, macros, and the assembled persona marker.");
} finally {
  await app.close();
}
