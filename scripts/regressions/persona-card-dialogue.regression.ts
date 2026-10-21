import assert from "node:assert/strict";
import { characterDataSchema, resolveMacros } from "../../packages/shared/src/index.js";
const { buildApp } = await import("../../packages/server/src/app.js");
const { getDB } = await import("../../packages/server/src/db/connection.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { resolveChatUserIdentity } = await import("../../packages/server/src/services/chat-user-identity.js");
const { encodePersonaCreate } = await import("../../packages/server/src/services/personas/persona-projector.js");
const { expandMarker } = await import("../../packages/server/src/services/prompt/marker-expander.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
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
  const { injectIdentityFallbackMessages } =
    await import("../../packages/server/src/services/generation/character-prompt-context.js");
  const fallbackMessages = [{ role: "system" as const, content: "Custom instructions without a persona marker." }];
  injectIdentityFallbackMessages({
    messages: fallbackMessages,
    charInfo: [],
    promptTargetCharacterId: null,
    promptMacroContext: macroCtx,
    wrapFormat: "xml",
    personaName: identity!.name,
    personaDescription: identity!.description,
    personaFields: { example: identity!.mesExample },
    resolvePromptMacros: (value) => resolveMacros(value, macroCtx),
  });
  const fallbackContent = fallbackMessages.map((message) => message.content).join("\n");
  assert.equal(fallbackContent.match(/<example_dialogue>/g)?.length, 1);
  assert.equal(fallbackContent.match(/Observe Subject carefully/g)?.length, 1);
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
  await storage.updatePersona(saved.id, {
    summary: "SUMMARY_METADATA_ONLY",
    mes_example: '{{user}}: "PEEK_DIALOGUE {{char}}."\n{{char}}: "Acknowledged."',
  });
  const subject = await storage.create(characterDataSchema.parse({ name: "Subject", description: "A subject." }));
  assert.ok(subject);
  const presets = createPromptsStorage(await getDB());
  const chats = createChatsStorage(await getDB());
  for (const wrapFormat of ["xml", "markdown", "none"] as const) {
    for (const includePersona of [true, false]) {
      const preset = await presets.create({ name: "Persona dialogue preview", wrapFormat });
      assert.ok(preset);
      await presets.createSection({
        presetId: preset.id,
        name: "Identity",
        identifier: "identity",
        content: includePersona
          ? "PEEK_IDENTITY_SECTION {{persona}}"
          : "PEEK_IDENTITY_SECTION Respond as the character.",
        role: "system",
        enabled: true,
        isMarker: false,
        order: 0,
      });
      const chat = await chats.create({
        name: "Persona dialogue preview",
        mode: "roleplay",
        characterIds: [subject.id],
        personaId: saved.id,
        promptPresetId: preset.id,
      });
      assert.ok(chat);
      await chats.patchMetadata(chat.id, { enableAgents: false, enableTools: false, enableMemoryRecall: false });
      await chats.createMessage({ chatId: chat.id, role: "user", content: "Hello." });
      const peek = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/peek-prompt`, payload: {} });
      assert.equal(peek.statusCode, 200, peek.body);
      assert.equal(peek.json().source, "live_preview");
      const text = JSON.stringify(peek.json().messages);
      const context = `${wrapFormat}/${includePersona ? "persona macro" : "fallback"}/peek`;
      assert.match(text, /PEEK_IDENTITY_SECTION/u, `${context}: the preset section reaches the preview`);
      assert.equal(text.split("PEEK_DIALOGUE").length - 1, 1, `${context}: example appears exactly once`);
      assert.match(text, /Example Persona:.*PEEK_DIALOGUE Subject/u, `${context}: speakers resolve`);
      assert.doesNotMatch(text, /\{\{(?:user|char)\}\}|SUMMARY_METADATA_ONLY/u, context);
    }
  }
  console.info("Persona dialogue survives persistence, selected identity, macros, and the assembled persona marker.");
} finally {
  await app.close();
}
