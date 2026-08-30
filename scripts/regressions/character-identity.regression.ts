import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChatUserIdentity } from "../../packages/server/src/services/chat-user-identity.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const characterStorage = {
  getById: async (id: string) =>
    id === "identity-character"
      ? {
          id,
          avatarPath: "/characters/identity-character/avatar.png",
          data: JSON.stringify({
            name: "Identity Character",
            description: "Character description",
            personality: "Character personality",
            scenario: "Character scenario",
            first_mes: "Hello",
            mes_example: "",
            creator_notes: "",
            system_prompt: "",
            post_history_instructions: "",
            alternate_greetings: [],
            tags: ["identity"],
            extensions: {
              phoneticName: "Eye-den-ti-tee",
              backstory: "Character backstory",
              appearance: "Character appearance",
              characterSheetImageId: "sheet-1",
              useCharacterSheetAsReference: true,
            },
          }),
        }
      : null,
  listPersonas: async () => [],
};

const characterIdentity = await resolveChatUserIdentity(characterStorage as never, {
  personaId: "must-not-win",
  personaCharacterId: "identity-character",
  mode: "roleplay",
});
assert.deepEqual(
  characterIdentity && {
    source: characterIdentity.source,
    id: characterIdentity.id,
    phoneticName: characterIdentity.phoneticName,
    characterSheetImageId: characterIdentity.characterSheetImageId,
    useCharacterSheetAsReference: characterIdentity.useCharacterSheetAsReference,
  },
  {
    source: "character",
    id: "identity-character",
    phoneticName: "Eye-den-ti-tee",
    characterSheetImageId: "sheet-1",
    useCharacterSheetAsReference: true,
  },
  "Character-backed identities must retain their source and reference metadata without consulting Persona storage",
);

const generateSource = readFileSync(join(repositoryRoot, "packages/server/src/routes/generate.routes.ts"), "utf8");
const dryRunSource = readFileSync(
  join(repositoryRoot, "packages/server/src/routes/generate/dry-run-route.ts"),
  "utf8",
);
const retrySource = readFileSync(
  join(repositoryRoot, "packages/server/src/routes/generate/retry-agents-route.ts"),
  "utf8",
);
const assemblerSource = readFileSync(
  join(repositoryRoot, "packages/server/src/services/prompt/assembler.ts"),
  "utf8",
);
const extensionSource = readFileSync(
  join(repositoryRoot, "packages/server/src/routes/personal-extensions.routes.ts"),
  "utf8",
);
const chatAreaSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/chat/ChatArea.tsx"),
  "utf8",
);
const chatsRouteSource = readFileSync(join(repositoryRoot, "packages/server/src/routes/chats.routes.ts"), "utf8");

assert.match(
  generateSource,
  /personaId = identity\.source === "persona" \? identity\.id : null;[\s\S]*?withIdentityLorebookScope/u,
  "Live generation must not route a character row ID through Persona scope",
);
assert.match(
  dryRunSource,
  /personaId = identity\.source === "persona" \? identity\.id : null;[\s\S]*?withIdentityLorebookScope/u,
  "Prompt dry runs must mirror live identity scope",
);
assert.match(
  assemblerSource,
  /characterIds: input\.lorebookCharacterIds \?\? input\.characterIds/u,
  "Preset assembly must use the dedicated character-backed identity scope for lorebooks",
);
assert.match(
  retrySource,
  /_userIdentityId = personaContext\.identityId;[\s\S]*?_userIdentitySource = personaContext\.identitySource/u,
  "Agent retries must retain both the active identity ID and its source",
);
assert.match(
  retrySource,
  /retryCharacterIdentity[\s\S]*?retryIdentitySource === "character"[\s\S]*?chatCharacters/u,
  "Illustrator retries must resolve character-backed identity references through character scope",
);
assert.match(
  extensionSource,
  /normalizePersonaContext[\s\S]*?value\?\.source === "character" \|\| value\?\.source === "persona"/u,
  "Personal-extension context normalization must preserve the validated identity source",
);
assert.match(
  chatAreaSource,
  /typeof data\?\.name === "string" && data\.name\.trim\(\) \? data\.name : "Unknown"/u,
  "Malformed or blank imported character names must not enter display, macro, or TTS identity state",
);
assert.match(
  chatsRouteSource,
  /personaDescription && !alreadyInPrompt\(personaDescription\)/u,
  "A preset that already contains only the identity description must still receive its other missing fields",
);

console.info("Character identity regressions passed.");
