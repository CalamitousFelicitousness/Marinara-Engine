/**
 * 3D Avatars (VRM):
 *   - the importer reads only the GLB header and JSON chunk, checks every length against the real bytes, and
 *     names the same expressions three-vrm registers (VRM 1.0 presets and customs, VRM 0.x preset groups under
 *     their VRM 1.0 names);
 *   - expressions bind to the six emotions, five visemes and blink through presets, then clear names, then
 *     emotion word stems, and the result fits avatar.json;
 *   - meta is kept as plain bounded text with only http(s) license links;
 *   - compressed models, plain glTF models, broken skeletons and dishonest files are refused in plain words;
 *   - a `.vrma` attaches to an existing model, and a new model keeps the idle animation;
 *   - the renderer's motion maths (expression smoothing, blink timer, framing, VRM 0.x mirroring) behaves.
 * Models are synthetic: no VRM file is committed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { avatarConfigSchema, createAvatarConfig } = await import("../../packages/shared/src/index.js");
const { vrmImporter, buildVrmImport, VRM_IDLE_ANIMATION_FILE, VRM_MODEL_FILE } =
  await import("../../packages/server/src/services/avatars/formats/vrm.js");
const { findAvatarImporter } = await import("../../packages/server/src/services/avatars/formats/registry.js");

const owner = { ownerType: "character", ownerId: "char_1" } as const;
const REQUIRED_BONES = [
  "hips",
  "spine",
  "head",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
];
const nodes = Array.from({ length: REQUIRED_BONES.length }, (_, index) => ({ name: `node${index}` }));

function padded(bytes: Uint8Array, fill: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
  out.set(bytes);
  return out;
}

function glb(
  json: unknown,
  options: { bin?: Uint8Array; declaredLength?: (real: number) => number; rawJson?: Uint8Array } = {},
): Uint8Array {
  const jsonBytes = padded(options.rawJson ?? new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binBytes = options.bin ? padded(options.bin, 0) : null;
  const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, options.declaredLength?.(total) ?? total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  if (binBytes) {
    const at = 20 + jsonBytes.length;
    view.setUint32(at, binBytes.length, true);
    view.setUint32(at + 4, 0x004e4942, true);
    bytes.set(binBytes, at + 8);
  }
  return bytes;
}

function vrm1(overrides: Record<string, unknown> = {}, vrmOverrides: Record<string, unknown> = {}) {
  return {
    asset: { version: "2.0", generator: "regression" },
    nodes,
    extensionsUsed: ["VRMC_vrm"],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name: "  Test\u0000Model  ",
          version: "1.2",
          authors: ["Mari", 42, "x".repeat(300)],
          avatarPermission: "everyone",
          commercialUsage: "personalNonProfit",
          modification: "prohibited",
          licenseUrl: "https://vrm.dev/licenses/1.0/",
        },
        humanoid: { humanBones: Object.fromEntries(REQUIRED_BONES.map((bone, node) => [bone, { node }])) },
        expressions: {
          preset: {
            neutral: {},
            happy: {},
            angry: {},
            sad: {},
            relaxed: {},
            aa: {},
            ih: {},
            ou: {},
            ee: {},
            oh: {},
            blink: {},
            notAPreset: {},
          },
          // JSON.parse keeps "__proto__" as an own key, as a hostile file would.
          custom: JSON.parse('{"Surprised":{},"happy":{},"__proto__":{"polluted":true},"Wink":{}}'),
        },
        ...vrmOverrides,
      },
    },
    ...overrides,
  };
}

function vrm0(groups: unknown[], metaOverrides: Record<string, unknown> = {}) {
  return {
    asset: { version: "2.0" },
    nodes,
    extensionsUsed: ["VRM"],
    extensions: {
      VRM: {
        specVersion: "0.0",
        meta: {
          title: "Old model",
          author: "Someone",
          allowedUserName: "Everyone",
          commercialUssageName: "Allow",
          licenseName: "CC_BY",
          otherLicenseUrl: "javascript:alert(1)",
          ...metaOverrides,
        },
        humanoid: { humanBones: REQUIRED_BONES.map((bone, node) => ({ bone, node })) },
        blendShapeMaster: { blendShapeGroups: groups },
      },
    },
  };
}

/** The server loads the shared package's build, so its AvatarImportError is not this file's class. */
function isImportError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === "AvatarImportError" && "code" in error;
}

const input = (bytes: Uint8Array, filename = "model.vrm") => ({ owner, filename, bytes });

async function refused(bytes: Uint8Array, code: string, message: RegExp, label: string) {
  await assert.rejects(
    vrmImporter.validate(input(bytes)),
    (error: unknown) => isImportError(error) && error.code === code && message.test(error.message),
    label,
  );
}

// ── detect: a GLB 2.0 header, nothing else ──
const header = glb(vrm1()).subarray(0, 12);
assert.equal(vrmImporter.detect({ filename: "model.vrm", head: header }), true);
assert.equal(vrmImporter.detect({ filename: "anything.bin", head: header }), true, "content decides, not the name");
assert.equal(vrmImporter.detect({ filename: "model.vrm", head: new TextEncoder().encode("glTF") }), false);
const v1Header = header.slice();
new DataView(v1Header.buffer).setUint32(4, 1, true);
assert.equal(vrmImporter.detect({ filename: "model.vrm", head: v1Header }), false, "glTF 1.0 is not claimed");
assert.equal(
  vrmImporter.detect({ filename: "model.vrm", head: new TextEncoder().encode("PK\u0003\u0004........") }),
  false,
);
assert.equal(findAvatarImporter({ filename: "model.vrm", head: header }), vrmImporter, "the registry finds it");
assert.equal(findAvatarImporter({ filename: "model.vrm", head: header }, "pngtuber"), null);

// ── VRM 1.0 ──
const modern = await vrmImporter.validate(input(glb(vrm1(), { bin: new Uint8Array([1, 2, 3]) })));
assert.equal(modern.type, "model");
assert.ok(modern.type === "model");
assert.equal(modern.specVersion, "1.0");
assert.deepEqual(
  modern.expressionNames,
  [
    "neutral",
    "happy",
    "angry",
    "sad",
    "relaxed",
    "aa",
    "ih",
    "ou",
    "ee",
    "oh",
    "blink",
    "Surprised",
    "__proto__",
    "Wink",
  ],
  "known presets, then customs that are not preset names (three-vrm drops unknown presets and colliding customs)",
);
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.deepEqual(modern.meta, {
  title: "Test Model",
  authors: ["Mari", "x".repeat(256)],
  version: "1.2",
  avatarPermission: "everyone",
  commercialUsage: "personalNonProfit",
  modification: "prohibited",
  licenseName: null,
  licenseUrl: "https://vrm.dev/licenses/1.0/",
});
const modernImport = buildVrmImport(modern, input(new Uint8Array([9])), null);
assert.equal(modernImport.kind, "vrm");
assert.deepEqual(
  modernImport.files.map((file) => file.path),
  [VRM_MODEL_FILE],
);
assert.deepEqual(modernImport.data.expressionMap.happy, { target: "happy", source: "preset", confidence: 1 });
assert.deepEqual(
  modernImport.data.expressionMap.surprised,
  { target: "Surprised", source: "name-match", confidence: 0.9 },
  "a custom name that clearly means the slot",
);
assert.deepEqual(modernImport.data.expressionMap.blink, { target: "blink", source: "preset", confidence: 1 });
assert.equal(modernImport.data.idleAnimation, null);
assert.deepEqual(modernImport.warnings, [], "nothing missing, nothing to warn about");
const config = createAvatarConfig(owner, "2026-10-13T12:00:00.000Z");
const stored = { ...config, activeKind: "vrm", kinds: { vrm: modernImport.data } };
assert.ok(avatarConfigSchema.safeParse(stored).success, "an imported VRM 1.0 fits avatar.json");
assert.equal(
  avatarConfigSchema.safeParse({
    ...stored,
    kinds: { vrm: { ...modernImport.data, meta: { ...modernImport.data.meta, licenseUrl: "javascript:alert(1)" } } },
  }).success,
  false,
  "avatar.json refuses a license link that is not http(s)",
);

// ── VRM 0.x ──
const legacy = await vrmImporter.validate(
  input(
    glb(
      vrm0([
        { name: "Joy", presetName: "joy" },
        { name: "A", presetName: "a" },
        { name: "Blink", presetName: "blink" },
        { name: "Surprised", presetName: "unknown" },
        { name: "Smile_Big", presetName: "unknown" },
        { name: "Joy again", presetName: "joy" },
        { name: "Fun", presetName: "fun" },
        { name: "", presetName: "unknown" },
        { name: "y".repeat(129), presetName: "unknown" },
      ]),
    ),
  ),
);
assert.ok(legacy.type === "model");
assert.equal(legacy.specVersion, "0.x");
assert.deepEqual(
  legacy.expressionNames,
  ["happy", "aa", "blink", "Surprised", "Smile_Big", "relaxed"],
  "preset groups take their VRM 1.0 names, duplicates and empty names are dropped",
);
assert.deepEqual(legacy.meta, {
  title: "Old model",
  authors: ["Someone"],
  version: null,
  avatarPermission: "Everyone",
  commercialUsage: "Allow",
  modification: null,
  licenseName: "CC_BY",
  licenseUrl: null,
});
assert.ok(
  legacy.warnings.some((warning) => /too long/u.test(warning)),
  "a name too long to bind is reported",
);
const legacyImport = buildVrmImport(legacy, input(new Uint8Array([1])), {
  file: VRM_MODEL_FILE,
  specVersion: "1.0",
  expressionMap: {},
  idleAnimation: VRM_IDLE_ANIMATION_FILE,
});
assert.equal(legacyImport.data.idleAnimation, VRM_IDLE_ANIMATION_FILE, "a new model keeps the idle animation");
assert.deepEqual(legacyImport.data.expressionMap.happy, { target: "happy", source: "preset", confidence: 1 });
assert.deepEqual(legacyImport.data.expressionMap.relaxed, { target: "relaxed", source: "preset", confidence: 1 });
assert.equal(legacyImport.data.expressionMap.surprised?.target, "Surprised");
assert.deepEqual(legacyImport.data.expressionMap.angry, { target: null, source: "missing", confidence: 0 });
assert.deepEqual(legacyImport.data.expressionMap.ih, { target: null, source: "missing", confidence: 0 });
assert.ok(
  legacyImport.warnings.some((warning) => /pick them in setup/u.test(warning)),
  "missing faces are pointed out",
);
assert.ok(
  avatarConfigSchema.safeParse({ ...config, activeKind: "vrm", kinds: { vrm: legacyImport.data } }).success,
  "an imported VRM 0.x fits avatar.json",
);

// Custom names and word stems bind when the model has no preset.
const customs = await vrmImporter.validate(
  input(
    glb(
      vrm0([
        { name: "Smile", presetName: "unknown" },
        { name: "Grumpy_Glare", presetName: "unknown" },
        { name: "びっくり", presetName: "unknown" },
        { name: "vrc.v_aa", presetName: "unknown" },
        { name: "まばたき", presetName: "unknown" },
      ]),
    ),
  ),
);
assert.ok(customs.type === "model");
const customMap = buildVrmImport(customs, input(new Uint8Array([1])), null).data.expressionMap;
assert.deepEqual(customMap.happy, { target: "Smile", source: "name-match", confidence: 0.9 });
assert.equal(customMap.angry?.target, "Grumpy_Glare", "an emotion word stem binds with lower confidence");
assert.ok((customMap.angry?.confidence ?? 1) < 0.9);
assert.equal(customMap.surprised?.target, "びっくり", "Japanese names bind too");
assert.equal(customMap.aa?.target, "vrc.v_aa");
assert.equal(customMap.blink?.target, "まばたき");

// Many expressions: capped at what avatar.json stores, with a warning.
const many = await vrmImporter.validate(
  input(glb(vrm0(Array.from({ length: 300 }, (_, index) => ({ name: `Custom${index}`, presetName: "unknown" }))))),
);
assert.ok(many.type === "model");
assert.equal(many.expressionNames.length, 256);
assert.ok(many.warnings.some((warning) => /more than 256/u.test(warning)));
assert.ok(
  avatarConfigSchema.safeParse({
    ...config,
    activeKind: "vrm",
    kinds: { vrm: buildVrmImport(many, input(new Uint8Array([1])), null).data },
  }).success,
);

// ── .vrma idle animations ──
const animationJson = {
  asset: { version: "2.0" },
  nodes: [{ name: "hips" }],
  extensionsUsed: ["VRMC_vrm_animation"],
  extensions: { VRMC_vrm_animation: { specVersion: "1.0", humanoid: { humanBones: { hips: { node: 0 } } } } },
  animations: [{ channels: [], samplers: [] }],
};
const animation = await vrmImporter.validate(input(glb(animationJson), "idle.vrma"));
assert.deepEqual(animation, { type: "animation" });
assert.throws(
  () => buildVrmImport(animation, input(new Uint8Array([1]), "idle.vrma"), null),
  (error: unknown) => isImportError(error) && /model before/u.test(error.message),
  "an animation needs a model first",
);
const attached = buildVrmImport(animation, input(new Uint8Array([1]), "idle.vrma"), legacyImport.data);
assert.deepEqual(
  attached.files.map((file) => file.path),
  [VRM_IDLE_ANIMATION_FILE],
);
assert.deepEqual(attached.data, { ...legacyImport.data, idleAnimation: VRM_IDLE_ANIMATION_FILE });
await refused(
  glb({ ...animationJson, animations: [] }),
  "invalid-file",
  /isn't a VRM animation/u,
  "an animation without animations",
);
await refused(
  glb({
    ...animationJson,
    extensions: { VRMC_vrm_animation: { specVersion: "1.0", humanoid: { humanBones: { hips: { node: 5 } } } } },
  }),
  "invalid-file",
  /isn't a VRM animation/u,
  "an animation whose hips point nowhere",
);

// ── Refusals ──
await refused(glb(vrm1(), { declaredLength: (real) => real + 4 }), "invalid-file", /damaged/u, "header length lies");
const truncated = glb(vrm1(), { bin: new Uint8Array(64) }).slice(0, -16);
new DataView(truncated.buffer).setUint32(8, truncated.length, true);
await refused(truncated, "invalid-file", /damaged/u, "a chunk longer than the file");
await refused(glb(null, { rawJson: new Uint8Array([0xff, 0xfe, 0x7b]) }), "invalid-file", /damaged/u, "bad UTF-8");
await refused(glb([1, 2]), "invalid-file", /damaged/u, "a JSON root that is not an object");
await refused(glb({ ...vrm1(), asset: { version: "1.0" } }), "invalid-file", /damaged/u, "glTF 1.0 JSON");
const binFirst = glb(vrm1());
new DataView(binFirst.buffer).setUint32(16, 0x004e4942, true);
await refused(binFirst, "invalid-file", /damaged/u, "the first chunk must be JSON");
const notGlb = new TextEncoder().encode('{"asset":{"version":"2.0"}}      ');
await refused(notGlb, "unsupported-format", /isn't a VRM file/u, "a JSON glTF is not a VRM");
await refused(
  glb({ ...vrm1(), extensionsUsed: ["VRMC_vrm", "KHR_draco_mesh_compression"] }),
  "unsupported-format",
  /compression avatars can't load \(Draco\)/u,
  "Draco is refused even when optional (three throws without a decoder)",
);
await refused(
  glb({ ...vrm1(), extensionsRequired: ["EXT_meshopt_compression", "KHR_texture_basisu"] }),
  "unsupported-format",
  /\(meshopt, KTX2 textures\)/u,
  "required meshopt and KTX2 are refused",
);
assert.equal(
  (await vrmImporter.validate(input(glb({ ...vrm1(), extensionsUsed: ["VRMC_vrm", "EXT_meshopt_compression"] })))).type,
  "model",
  "optional meshopt has plain fallback data and loads",
);
await refused(
  glb({ ...vrm1(), images: [{ uri: "https://example.com/tracker.png" }] }),
  "unsupported-format",
  /points to files outside itself/u,
  "an image the browser would fetch from elsewhere",
);
await refused(
  glb({ ...vrm1(), buffers: [{ byteLength: 4, uri: "../../secret.bin" }] }),
  "unsupported-format",
  /points to files outside itself/u,
  "a buffer outside the file",
);
assert.equal(
  (
    await vrmImporter.validate(
      input(glb({ ...vrm1(), buffers: [{ byteLength: 4 }], images: [{ uri: "data:image/png;base64,AA==" }] })),
    )
  ).type,
  "model",
  "the GLB's own buffer and data: images load",
);
await refused(
  glb({ asset: { version: "2.0" }, nodes }),
  "unsupported-format",
  /plain 3D model, not a VRM/u,
  "a plain glTF model",
);
await refused(
  glb(vrm1({}, { specVersion: "2.0" })),
  "unsupported-format",
  /version isn't supported/u,
  "an unknown VRM version",
);
await refused(
  glb({ ...vrm1(), extensionsUsed: [] }),
  "invalid-file",
  /damaged/u,
  "a VRM 1.0 extension the file does not list as used",
);
await refused(glb(vrm1({}, { humanoid: undefined })), "invalid-file", /no humanoid skeleton/u, "no humanoid");
await refused(
  glb(
    vrm1(
      {},
      {
        humanoid: {
          humanBones: Object.fromEntries(
            REQUIRED_BONES.filter((bone) => bone !== "head").map((bone, node) => [bone, { node }]),
          ),
        },
      },
    ),
  ),
  "invalid-file",
  /missing parts VRM needs: head\./u,
  "a missing required bone is named",
);
await refused(
  glb(
    vrm1(
      {},
      { humanoid: { humanBones: Object.fromEntries(REQUIRED_BONES.map((bone, node) => [bone, { node: node + 1 }])) } },
    ),
  ),
  "invalid-file",
  /missing parts VRM needs: rightHand\./u,
  "a bone pointing past the last node counts as missing",
);
await refused(glb(vrm1({}, { meta: undefined })), "invalid-file", /model details/u, "VRM 1.0 without meta");
const noMeta = vrm0([]);
await refused(
  glb({ ...noMeta, extensions: { VRM: { ...noMeta.extensions.VRM, meta: null } } }),
  "invalid-file",
  /model details/u,
  "VRM 0.x without meta",
);
await refused(
  glb(vrm1({}, { expressions: { custom: { Broken: null } } })),
  "invalid-file",
  /damaged/u,
  "a custom expression three-vrm cannot read",
);

// ── Renderer motion maths ──
const motion = await import("../../packages/client/src/features/avatars/renderers/vrm/vrm-motion.js");
{
  const weights = motion.createExpressionWeights();
  const map = modernImport.data.expressionMap;
  const frame = { emotion: "happy", emotionWeight: 1, viseme: "oh", mouthOpen: 0.8, state: "talking" } as const;
  for (let step = 0; step < 30; step += 1) motion.stepExpressionWeights(weights, map, frame, { lipSync: true }, 1 / 30);
  assert.ok((weights.get("happy") ?? 0) > 0.95, "the emotion eases in within a second");
  assert.ok((weights.get("oh") ?? 0) > 0.75, "the mouth follows the viseme quickly");
  assert.equal(weights.get("aa") ?? 0, 0);
  motion.stepExpressionWeights(weights, map, { ...frame, emotion: "sad", mouthOpen: 0 }, { lipSync: true }, 1 / 30);
  assert.ok((weights.get("happy") ?? 0) > 0.5, "one frame later the old face is still fading, not snapped off");
  for (let step = 0; step < 30; step += 1) {
    motion.stepExpressionWeights(weights, map, { ...frame, mouthOpen: 1 }, { lipSync: false }, 1 / 30);
  }
  assert.ok((weights.get("oh") ?? 1) < 0.01, "lip sync off keeps the mouth closed");
  const fallback = motion.createExpressionWeights();
  motion.stepExpressionWeights(fallback, map, { ...frame, viseme: null, mouthOpen: 1 }, { lipSync: true }, 1);
  assert.ok((fallback.get("aa") ?? 0) > 0.9, "an open mouth without a viseme uses aa");
  const unbound = motion.createExpressionWeights();
  motion.stepExpressionWeights(
    unbound,
    legacyImport.data.expressionMap,
    { ...frame, viseme: "ih" },
    { lipSync: true },
    1,
  );
  assert.ok((unbound.get("aa") ?? 0) > 0.7, "a viseme the model lacks falls back to aa");
}
{
  const blink = motion.createBlinkTimer(() => 0.5);
  let closedAt = -1;
  for (let ms = 0; ms < 8000; ms += 33) {
    if (motion.stepBlink(blink, 0.033, { enabled: true }) > 0.9 && closedAt < 0) closedAt = ms;
  }
  assert.ok(closedAt > 1000 && closedAt < 7000, `the eyes blink on their own (closed at ${closedAt} ms)`);
  const off = motion.createBlinkTimer(() => 0.5);
  let max = 0;
  for (let ms = 0; ms < 8000; ms += 33) max = Math.max(max, motion.stepBlink(off, 0.033, { enabled: false }));
  assert.equal(max, 0, "blink off never closes the eyes");
}
{
  const body = { headY: 1.45, hipsY: 0.95, footY: 0.05 };
  const bust = motion.frameCamera(body, 1, 25);
  const full = motion.frameCamera(body, 0.5, 25);
  assert.equal(bust.placement, "bust");
  assert.equal(full.placement, "full-body");
  assert.ok(bust.targetY > body.headY - 0.3 && bust.targetY < body.headY + 0.2, "a bust centres on the head");
  assert.ok(full.targetY > 0.6 && full.targetY < 1, "a full body centres on the middle of the body");
  assert.ok(full.distance > bust.distance, "the full body sits further away");
  assert.ok(motion.frameCamera(body, 4, 25).distance <= bust.distance * 1.01, "a wide canvas never zooms out the bust");
}
assert.equal(motion.vrm0Mirror("0"), -1, "VRM 0.x normalised bones mirror x and z rotations");
assert.equal(motion.vrm0Mirror("1"), 1);

// ── The renderer runs no loop of its own and loads bytes through api.raw ──
const rendererSource = readFileSync(
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../packages/client/src/features/avatars/renderers/vrm/vrm-renderer.ts",
  ),
  "utf8",
);
assert.equal(/requestAnimationFrame|setInterval/u.test(rendererSource), false, "the stage drives every frame");
assert.ok(/api\.raw\(avatarModelFilePath\(/u.test(rendererSource), "model bytes load through api.raw");
assert.equal(/\bfetch\(/u.test(rendererSource), false);
assert.ok(/VRMUtils\.deepDispose/u.test(rendererSource), "dispose releases the model's GPU resources");

console.log("avatar VRM regression passed");
