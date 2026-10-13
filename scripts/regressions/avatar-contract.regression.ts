/**
 * The shared contract of the 2D and 3D avatar agents:
 *   - every sprite label the Engine suggests maps to one of the six VRM emotions, and free-form labels
 *     (Game Master lines, custom sprite names) map through word stems or not at all;
 *   - sprite labels bind to emotions with a source and a confidence;
 *   - avatar.json and its stored paths stay inside the owner's folder;
 *   - the 2D agent's generation prompts merge like other built-in template collections;
 *   - the contract stubs are inert: no importer claims a file and no avatar route is registered;
 *   - three, @pixiv/three-vrm and mesh-avatar are imported only by the lazy renderer modules.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");

const {
  AVATAR_2D_AGENT_ID,
  AVATAR_EMOTIONS,
  AVATAR_PROMPT_TEMPLATE_IDS,
  AVATAR_PROMPT_TEMPLATE_SETTINGS_KEY,
  SPRITE_EXPRESSION_LABELS,
  avatarConfigSchema,
  avatarConfigUpdateSchema,
  avatarModelFileUrl,
  createAvatarConfig,
  detectSpriteEmotionBindings,
  isAvatarFilePath,
  mapSpriteExpressionToAvatarEmotion,
  mergeBuiltInAgentSettings,
  replaceBuiltInAgentDefinitions,
} = await import("../../packages/shared/src/index.js");
const { findAvatarImporter } = await import("../../packages/server/src/services/avatars/formats/registry.js");
const { avatarModelsRoutes } = await import("../../packages/server/src/routes/avatar-models.routes.js");
const { avatarClassifyRoutes } = await import("../../packages/server/src/routes/avatar-classify.routes.js");
const { avatarGenerationRoutes } = await import("../../packages/server/src/routes/avatar-generation.routes.js");

// ── Sprite labels → emotions ──
for (const label of SPRITE_EXPRESSION_LABELS) {
  const mapped = mapSpriteExpressionToAvatarEmotion(label);
  assert.ok(mapped, `the suggested sprite label ${label} maps to an emotion`);
  assert.ok(AVATAR_EMOTIONS.includes(mapped.emotion));
  assert.ok(mapped.weight > 0 && mapped.weight <= 1, `${label} carries a weight in (0, 1]`);
}
assert.deepEqual(mapSpriteExpressionToAvatarEmotion("full_Happy-2"), { emotion: "happy", weight: 1 });
assert.deepEqual(mapSpriteExpressionToAvatarEmotion("love"), { emotion: "relaxed", weight: 1 });
assert.deepEqual(mapSpriteExpressionToAvatarEmotion("sorrow"), { emotion: "sad", weight: 1 }, "VRM 0.x name");
assert.equal(mapSpriteExpressionToAvatarEmotion("unhappy")?.emotion, "sad", "a negated stem wins over the stem");
assert.equal(mapSpriteExpressionToAvatarEmotion("courageous")?.emotion, "happy", "courage is not rage");
assert.equal(mapSpriteExpressionToAvatarEmotion("terrified")?.emotion, "surprised");
assert.equal(mapSpriteExpressionToAvatarEmotion("furious glare")?.emotion, "angry");
assert.equal(mapSpriteExpressionToAvatarEmotion("xyzzy"), null, "an unknown label maps to nothing");
assert.equal(mapSpriteExpressionToAvatarEmotion(""), null);
assert.equal(mapSpriteExpressionToAvatarEmotion(undefined), null);

const bindings = detectSpriteEmotionBindings(["smirk", "happy", "crying", "worried"]);
assert.deepEqual(
  bindings.happy,
  { target: "happy", source: "sprite-label", confidence: 1 },
  "the strongest label wins",
);
assert.deepEqual(bindings.sad, { target: "crying", source: "sprite-label", confidence: 1 });
assert.deepEqual(bindings.angry, { target: null, source: "missing", confidence: 0 });
assert.deepEqual(Object.keys(bindings).sort(), [...AVATAR_EMOTIONS].sort(), "every emotion gets a binding");

// ── avatar.json ──
const owner = { ownerType: "character", ownerId: "V1StGXR8_Z5jdHi6B-myT" } as const;
const config = createAvatarConfig(owner, "2026-10-13T12:00:00.000Z");
assert.ok(avatarConfigSchema.safeParse(config).success, "a fresh config is valid");
const withVrm = {
  ...config,
  activeKind: "vrm",
  kinds: { vrm: { file: "vrm/model.vrm", specVersion: "1.0", expressionMap: bindings, idleAnimation: null } },
};
assert.ok(avatarConfigSchema.safeParse(withVrm).success, "a VRM setup is valid");
assert.equal(avatarConfigSchema.safeParse({ ...config, activeKind: "vrm" }).success, false, "active kind must exist");
assert.equal(
  avatarConfigSchema.safeParse({ ...withVrm, kinds: { vrm: { ...withVrm.kinds.vrm, file: "vrm/../../secret" } } })
    .success,
  false,
  "a stored path cannot leave the owner's folder",
);
assert.equal(
  avatarConfigSchema.safeParse({ ...withVrm, kinds: { vrm: { ...withVrm.kinds.vrm, file: "pngtuber/model.vrm" } } })
    .success,
  false,
  "a VRM file lives in vrm/",
);
assert.equal(
  avatarConfigSchema.safeParse({ ...config, owner: { ownerType: "character", ownerId: "../x" } }).success,
  false,
  "an owner id is one safe folder name",
);
assert.equal(avatarConfigSchema.safeParse({ ...config, extra: true }).success, false, "unknown keys are refused");
assert.equal(avatarConfigUpdateSchema.safeParse({ features: { lipSync: false } }).success, true);
for (const path of ["vrm/model.vrm", "pngtuber/happy_eyes-closed.png", "mesh-avatar/model.mavatar"]) {
  assert.ok(isAvatarFilePath(path), `${path} is a stored path`);
}
for (const path of [
  "/vrm/model.vrm",
  "vrm/../x",
  "vrm/a/b.vrm",
  "vrm/.hidden",
  "vrm/model.",
  "sprites/a.png",
  "vrm\\a",
]) {
  assert.equal(isAvatarFilePath(path), false, `${path} is refused`);
}
assert.equal(
  avatarModelFileUrl({ ownerType: "persona", ownerId: "abc" }, "pngtuber/a.png"),
  "/api/avatar-models/persona/abc/files/pngtuber/a.png",
);

// ── The 2D agent's generation prompts merge like other template collections ──
replaceBuiltInAgentDefinitions([
  {
    id: AVATAR_2D_AGENT_ID,
    name: "2D Avatars",
    description: "",
    phase: "post_processing",
    enabledByDefault: false,
    category: "misc",
    execution: "host",
    defaultSettings: {
      [AVATAR_PROMPT_TEMPLATE_SETTINGS_KEY]: [
        { id: AVATAR_PROMPT_TEMPLATE_IDS.pngtuberEyesClosed, name: "Eyes closed", promptTemplate: "default A" },
        { id: AVATAR_PROMPT_TEMPLATE_IDS.pngtuberMouthOpen, name: "Mouth open", promptTemplate: "default B" },
      ],
    },
  },
]);
const merged = mergeBuiltInAgentSettings(AVATAR_2D_AGENT_ID, {
  [AVATAR_PROMPT_TEMPLATE_SETTINGS_KEY]: [
    { id: AVATAR_PROMPT_TEMPLATE_IDS.pngtuberEyesClosed, name: "Eyes closed", promptTemplate: "edited A" },
  ],
});
assert.deepEqual(
  (merged[AVATAR_PROMPT_TEMPLATE_SETTINGS_KEY] as { id: string; promptTemplate: string }[]).map((entry) => [
    entry.id,
    entry.promptTemplate,
  ]),
  [
    [AVATAR_PROMPT_TEMPLATE_IDS.pngtuberEyesClosed, "edited A"],
    [AVATAR_PROMPT_TEMPLATE_IDS.pngtuberMouthOpen, "default B"],
  ],
  "a user edit is kept and a new default template still arrives",
);
replaceBuiltInAgentDefinitions([]);

// ── Stubs are inert ──
assert.equal(
  findAvatarImporter({ filename: "model.vrm", head: new TextEncoder().encode("glTF") }),
  null,
  "no importer claims a file until a lane fills it in",
);
const app = Fastify();
await app.register(avatarModelsRoutes, { prefix: "/api/avatar-models" });
await app.register(avatarClassifyRoutes, { prefix: "/api/avatar-classify" });
await app.register(avatarGenerationRoutes, { prefix: "/api/avatar-generation" });
await app.ready();
for (const url of ["/api/avatar-models", "/api/avatar-classify", "/api/avatar-generation/mesh-rig"]) {
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, `${url} is not served yet`);
}
await app.close();

// ── Renderer libraries only in the lazy renderer modules ──
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const clientSrc = join(repoRoot, "packages", "client", "src");
const rendererRoot = join(clientSrc, "features", "avatars", "renderers") + sep;
const heavyImport = /(?:from\s+|import\s*\(\s*)["'](?:three(?:\/[^"']*)?|@pixiv\/[^"']+|mesh-avatar)["']/u;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(?:ts|tsx)$/u.test(name) ? [path] : [];
  });
}
for (const file of walk(clientSrc)) {
  if (file.startsWith(rendererRoot)) continue;
  assert.equal(
    heavyImport.test(readFileSync(file, "utf8")),
    false,
    `${relative(repoRoot, file)} imports a renderer library outside features/avatars/renderers`,
  );
}
const contractSource = readFileSync(join(clientSrc, "features", "avatars", "contract.ts"), "utf8");
assert.equal(/^import[^;]*["']\.\/renderers\//mu.test(contractSource), false, "renderers load only by import()");

console.log("avatar contract regression passed");
