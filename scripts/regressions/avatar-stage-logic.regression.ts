/**
 * The avatar stage and setup decisions (base lane, #7537):
 *   - a chat shows an owner's active kind when its agent is on, else falls back pngtuber → mesh-avatar → vrm;
 *   - phones show at most 2 avatars and desktops 4, with the budget's frame rates and pixel-ratio caps;
 *   - the owner's lip sync, blink and idle-motion switches (and reduced motion) shape every frame;
 *   - PNGTuber pictures resolve to stored files or the owner's sprites, expression sprites first;
 *   - "Use my sprites" builds a valid PNGTuber setup and keeps an existing setup's layers and choices;
 *   - the chat surfaces load the stage lazily, and only for avatar agents the chat turned on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AVATAR_NEUTRAL_FRAME,
  avatarConfigSchema,
  createAvatarConfig,
  type AvatarOwnerSummary,
} from "../../packages/shared/src/index.ts";
import {
  applyAvatarFeatures,
  avatarDevicePixelRatio,
  avatarTargetFps,
  chatAvatarAgentIds,
  chatAvatarParticipants,
  pickAvatarKind,
  resolveAvatarImage,
  selectStageAvatars,
} from "../../packages/client/src/features/avatars/stage/avatar-stage-logic.ts";
import {
  avatarAgentKinds,
  avatarBindingTargets,
  buildPngtuberFromSprites,
  withBindingOverride,
} from "../../packages/client/src/features/avatars/setup/avatar-setup-logic.ts";

// ── Which kind shows ──
assert.equal(pickAvatarKind({ activeKind: "vrm", kinds: ["pngtuber", "vrm"] }, ["2d-avatars", "3d-avatars"]), "vrm");
assert.equal(
  pickAvatarKind({ activeKind: "vrm", kinds: ["pngtuber", "vrm"] }, ["2d-avatars"]),
  "pngtuber",
  "the 3D agent is off, so the set-up 2D kind shows",
);
assert.equal(pickAvatarKind({ activeKind: "pngtuber", kinds: ["pngtuber", "vrm"] }, ["3d-avatars"]), "vrm");
assert.equal(
  pickAvatarKind({ activeKind: null, kinds: ["vrm", "mesh-avatar"] }, ["2d-avatars", "3d-avatars"]),
  "mesh-avatar",
);
assert.equal(pickAvatarKind({ activeKind: "vrm", kinds: ["vrm"] }, ["2d-avatars"]), null, "nothing can show");

// ── Who shows, within the budget ──
const summary = (ownerId: string, kinds: AvatarOwnerSummary["kinds"], enabled = true): AvatarOwnerSummary => ({
  owner: { ownerType: "character", ownerId },
  enabled,
  activeKind: kinds[0] ?? null,
  kinds,
  updatedAt: "2026-10-13T00:00:00.000Z",
});
const participants = ["a", "b", "c", "d", "e", "off"].map((ownerId) => ({
  owner: { ownerType: "character" as const, ownerId },
  name: ownerId.toUpperCase(),
}));
const summaries = [
  summary("a", ["pngtuber"]),
  summary("b", ["vrm"]),
  summary("c", ["mesh-avatar"]),
  summary("d", ["pngtuber"]),
  summary("e", ["pngtuber"]),
  summary("off", ["pngtuber"], false),
];
assert.deepEqual(
  selectStageAvatars(participants, summaries, ["2d-avatars", "3d-avatars"], 4).map((avatar) => [
    avatar.participant.owner.ownerId,
    avatar.kind,
    avatar.index,
  ]),
  [
    ["a", "pngtuber", 0],
    ["b", "vrm", 1],
    ["c", "mesh-avatar", 2],
    ["d", "pngtuber", 3],
  ],
  "desktop draws four",
);
assert.deepEqual(
  selectStageAvatars(participants, summaries, ["2d-avatars"], 2).map((avatar) => avatar.participant.owner.ownerId),
  ["a", "c"],
  "a phone draws two, skipping the VRM whose agent is off",
);
assert.deepEqual(selectStageAvatars(participants, summaries, [], 4), [], "no avatar agent, no avatars");
assert.deepEqual(
  selectStageAvatars([participants[0]!, participants[0]!], summaries, ["2d-avatars"], 4).length,
  1,
  "an owner shows once",
);

// ── Budget ──
assert.equal(avatarTargetFps({ talking: true, phone: true, underLoad: true }), 30);
assert.equal(avatarTargetFps({ talking: false, phone: false, underLoad: false }), 30);
assert.equal(avatarTargetFps({ talking: false, phone: true, underLoad: false }), 20);
assert.equal(avatarTargetFps({ talking: false, phone: true, underLoad: true }), 15);
assert.equal(avatarDevicePixelRatio(3, true), 1.5);
assert.equal(avatarDevicePixelRatio(3, false), 2);
assert.equal(avatarDevicePixelRatio(1, false), 1);
assert.equal(avatarDevicePixelRatio(Number.NaN, false), 1);

// ── Switches shape frames ──
const talking = { ...AVATAR_NEUTRAL_FRAME, viseme: "aa" as const, mouthOpen: 0.8, state: "talking" as const };
const allOn = { lipSync: true, blink: true, idleMotion: true };
assert.deepEqual(applyAvatarFeatures(talking, allOn, false), talking);
assert.deepEqual(applyAvatarFeatures(talking, { ...allOn, lipSync: false }, false), {
  ...talking,
  viseme: null,
  mouthOpen: 0,
});
assert.equal(applyAvatarFeatures(talking, { ...allOn, blink: false }, false).blink, 0, "eyes stay open");
const thinking = { ...AVATAR_NEUTRAL_FRAME, state: "thinking" as const };
assert.equal(applyAvatarFeatures(thinking, { ...allOn, idleMotion: false }, false).state, "idle");
assert.equal(applyAvatarFeatures(thinking, allOn, true).state, "idle", "reduced motion drops the poses");
assert.equal(applyAvatarFeatures(talking, allOn, true).state, "talking", "but still talks");

// ── PNGTuber pictures ──
const owner = { ownerType: "persona" as const, ownerId: "p1" };
const sprites = [
  { expression: "full_happy", url: "/api/sprites/p1/file/full_happy.png" },
  { expression: "Happy", url: "/api/sprites/p1/file/Happy.png" },
];
assert.equal(
  resolveAvatarImage(owner, { updatedAt: "2026-10-13T00:00:00.000Z" }, sprites, { source: "sprite", label: "happy" }),
  "/api/sprites/p1/file/Happy.png",
  "an expression sprite wins over a full-body one",
);
assert.equal(resolveAvatarImage(owner, { updatedAt: "x" }, sprites, { source: "sprite", label: "sad" }), null);
assert.equal(
  resolveAvatarImage(owner, { updatedAt: "2026-10-13T00:00:00.000Z" }, undefined, {
    source: "file",
    path: "pngtuber/a.png",
  }),
  "/api/avatar-models/persona/p1/files/pngtuber/a.png?v=2026-10-13T00%3A00%3A00.000Z",
);

// ── Use my sprites ──
assert.deepEqual(avatarAgentKinds("2d-avatars"), ["pngtuber", "mesh-avatar"]);
assert.deepEqual(avatarAgentKinds("3d-avatars"), ["vrm"]);
const built = buildPngtuberFromSprites(["neutral", "Happy", "full_happy", "crying", "smirk", "happy"]);
assert.ok(built);
assert.deepEqual(Object.keys(built.layers), ["neutral", "happy", "crying", "smirk"], "full-body sprites are left out");
assert.deepEqual(built.layers.happy, { base: { source: "sprite", label: "happy" } });
assert.equal(built.expressionMap.sad?.target, "crying");
assert.equal(built.expressionMap.angry?.source, "missing");
const config = {
  ...createAvatarConfig(owner, "2026-10-13T00:00:00.000Z"),
  activeKind: "pngtuber",
  kinds: { pngtuber: built },
};
assert.ok(avatarConfigSchema.safeParse(config).success, "the built setup is a valid avatar.json");
assert.equal(buildPngtuberFromSprites(["full_idle"]), null, "no expression sprites, nothing to build");

const edited = withBindingOverride<"pngtuber">(
  {
    ...built,
    layers: {
      ...built.layers,
      smirk: { ...built.layers.smirk!, mouthOpen: { source: "file", path: "pngtuber/s.png" } },
    },
  },
  "happy",
  "smirk",
);
assert.deepEqual(edited.expressionMap.happy, { target: "smirk", source: "user", confidence: 1 });
const rebuilt = buildPngtuberFromSprites(["neutral", "angry"], edited);
assert.ok(rebuilt);
assert.equal(rebuilt.expressionMap.happy?.target, "smirk", "the user's choice stays");
assert.equal(rebuilt.expressionMap.angry?.target, "angry", "a new sprite fills a missing feeling");
assert.deepEqual(rebuilt.layers.smirk?.mouthOpen, { source: "file", path: "pngtuber/s.png" }, "variants stay");
assert.deepEqual(avatarBindingTargets("pngtuber", rebuilt), ["angry", "crying", "happy", "neutral", "smirk"]);
assert.ok(
  avatarBindingTargets("vrm", {
    file: "vrm/m.vrm",
    specVersion: "0.x",
    expressionMap: { happy: { target: "Joy", source: "name-match", confidence: 0.9 } },
  }).includes("Joy") &&
    avatarBindingTargets("vrm", { file: "vrm/m.vrm", specVersion: "1.0", expressionMap: {} }).includes("happy"),
  "models offer their found names and the preset names",
);

// ── Chat surfaces ──
const characterMap = new Map([
  ["c1", { name: "Ava" }],
  ["c2", { name: "Bo" }],
]);
assert.deepEqual(
  chatAvatarParticipants(["c1", "missing", "c2"], characterMap, { id: "p1", name: "Mari" }).map((participant) => [
    participant.owner.ownerType,
    participant.owner.ownerId,
    participant.name,
  ]),
  [
    ["character", "c1", "Ava"],
    ["character", "c2", "Bo"],
    ["persona", "p1", "Mari"],
  ],
);
assert.equal(
  chatAvatarParticipants([], characterMap, { id: "c9", source: "character", name: "Card" })[0]?.owner.ownerType,
  "character",
  "playing as a character card uses that character's avatar",
);
assert.deepEqual(chatAvatarAgentIds({ enableAgents: true, activeAgentIds: ["expression", "3d-avatars"] }), [
  "3d-avatars",
]);
assert.deepEqual(chatAvatarAgentIds({ enableAgents: false, activeAgentIds: ["2d-avatars"] }), []);
assert.deepEqual(chatAvatarAgentIds({ enableAgents: "true", activeAgentIds: ["2d-avatars"] }), ["2d-avatars"]);

const client = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");
for (const surface of ["components/chat/ChatRoleplaySurface.tsx", "components/game/GameSurface.tsx"]) {
  const text = client(surface);
  assert.match(
    text,
    /lazy\(async \(\) => \{\n {2}const module = await import\("\.\.\/\.\.\/features\/avatars\/stage\/AvatarStage"\);/u,
  );
  assert.doesNotMatch(
    text,
    /^import[^;]*features\/avatars\/stage\/AvatarStage["']/mu,
    `${surface} loads the stage lazily`,
  );
  assert.match(
    text,
    /avatarAgentIds\.length > 0 && avatarParticipants\.length > 0/u,
    `${surface} mounts it only when on`,
  );
}
assert.match(
  client("components/agents/AgentEditor.tsx"),
  /const AvatarAgentSetup = lazy\(\(\) =>\n {2}import\("\.\.\/\.\.\/features\/avatars\/setup\/AvatarAgentSetup"\)/u,
  "the setup loads only on an avatar agent's page",
);

console.log("avatar stage logic regression passed");
