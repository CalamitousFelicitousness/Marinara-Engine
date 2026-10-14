/**
 * 3D Avatars: a VRM model from a sprite through Tripo (the user's own key):
 *   - glb-to-vrm names Mixamo joints as VRM humanoid bones, refuses a skeleton missing a required bone, a model
 *     not in a T-pose and one without legs (asking for a full-body sprite), turns a model facing +X (Tripo's way)
 *     or -X to face +Z, switches metal off, writes honest VRM 1.0 details, and copies the binary chunk byte for
 *     byte; the Engine's importer accepts the result as a body-only model, and the stage's own loader (three +
 *     three-vrm in Node) loads it facing +Z with no face expressions;
 *   - shrinkGlbTextures makes the normal and metal maps 1024 pixels, keeps the colour map, repacks the binary
 *     chunk without moving the mesh data, and leaves the file alone without image processing;
 *   - the Tripo client sends the key to the API only (never to download links, logs or messages), maps bad
 *     keys, missing credits, the content policy, busy answers and failed tasks to plain messages, waits as
 *     Tripo asks when busy, polls tasks, and stops at once on Cancel;
 *   - the whole run sends Tripo exactly the tested settings, reports each step with the credits used, checks
 *     the balance before spending, stops before the paid skeleton when Tripo can't rig the model, refuses an
 *     arms-down model before anything is saved, and the route streams progress and plain errors.
 * Tripo is mocked; the model is built here, so no Tripo file is committed and no credit is spent.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-avatar-vrm-generation-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
const { characterDataSchema, createConnectionSchema, TRIPO_VRM_MODEL_CREDITS } =
  await import("../../packages/shared/src/index.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { getSharp } = await import("../../packages/server/src/services/image/sharp-runtime.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");
const { vrmImporter, buildVrmImport, VRM_MODEL_FILE } =
  await import("../../packages/server/src/services/avatars/formats/vrm.js");
const { avatarOwnerDir } = await import("../../packages/server/src/services/avatars/storage.js");
const { VrmConversionError, convertRiggedGlbToVrm, parseGlb, shrinkGlbTextures, writeGlb } =
  await import("../../packages/server/src/services/avatars/generation/glb-to-vrm.js");
const { TripoError, createTripoClient } =
  await import("../../packages/server/src/services/avatars/generation/tripo-client.js");
const { generateVrmModel, TRIPO_REQUESTS } =
  await import("../../packages/server/src/services/avatars/generation/tripo-vrm.js");
const { AvatarGenerationError } =
  await import("../../packages/server/src/services/avatars/generation/generation-context.js");
const { avatarGenerationRoutes } = await import("../../packages/server/src/routes/avatar-generation.routes.js");

const sharp = await getSharp();
const KEY = "tsk_regression_key_7f3a9c";

// ── A Mixamo-rigged model like Tripo's, built here ──
type V3 = [number, number, number];
type Pose = "t-pose" | "arms-down";
const T_POSE: Record<string, V3> = {
  Hips: [0, 0.95, 0],
  Spine: [0, 1.05, 0],
  Spine1: [0, 1.17, 0],
  Spine2: [0, 1.29, 0],
  Neck: [0, 1.45, 0],
  Head: [0, 1.55, 0],
  LeftShoulder: [0.06, 1.4, 0],
  LeftArm: [0.16, 1.4, 0],
  LeftForeArm: [0.42, 1.4, 0],
  LeftHand: [0.66, 1.4, 0],
  LeftUpLeg: [0.1, 0.9, 0],
  LeftLeg: [0.1, 0.5, 0],
  LeftFoot: [0.1, 0.08, 0],
  LeftToeBase: [0.1, 0.02, 0.12],
};
for (const [name, [x, y, z]] of Object.entries({ ...T_POSE })) {
  if (name.startsWith("Left")) T_POSE[name.replace("Left", "Right")] = [-x, y, z];
}
const PARENTS: Record<string, string | null> = {
  Hips: null,
  Spine: "Hips",
  Spine1: "Spine",
  Spine2: "Spine1",
  Neck: "Spine2",
  Head: "Neck",
  LeftShoulder: "Spine2",
  LeftArm: "LeftShoulder",
  LeftForeArm: "LeftArm",
  LeftHand: "LeftForeArm",
  RightShoulder: "Spine2",
  RightArm: "RightShoulder",
  RightForeArm: "RightArm",
  RightHand: "RightForeArm",
  LeftUpLeg: "Hips",
  LeftLeg: "LeftUpLeg",
  LeftFoot: "LeftLeg",
  LeftToeBase: "LeftFoot",
  RightUpLeg: "Hips",
  RightLeg: "RightUpLeg",
  RightFoot: "RightLeg",
  RightToeBase: "RightFoot",
};

const textures = {
  color: await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#c86440" } })
    .jpeg()
    .toBuffer(),
  metal: await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#00c020" } })
    .jpeg()
    .toBuffer(),
  normal: await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#8080ff" } })
    .png()
    .toBuffer(),
};

function riggedGlb(
  options: {
    facing?: "+X" | "+Z" | "-X";
    pose?: Pose;
    legless?: boolean;
    drop?: string;
    skin?: boolean;
    extensionsUsed?: string[];
  } = {},
): Buffer {
  const facing = options.facing ?? "+X";
  const turn = ([x, y, z]: V3): V3 => (facing === "+X" ? [z, y, -x] : facing === "-X" ? [-z, y, x] : [x, y, z]);
  const pose: Record<string, V3> = { ...T_POSE };
  if (options.pose === "arms-down") {
    for (const side of [1, -1]) {
      const prefix = side === 1 ? "Left" : "Right";
      pose[`${prefix}ForeArm`] = [0.2 * side, 1.15, 0];
      pose[`${prefix}Hand`] = [0.22 * side, 0.92, 0];
    }
  }
  if (options.legless) {
    pose.Hips = [0, 0.3, 0];
    for (const side of [1, -1]) {
      const prefix = side === 1 ? "Left" : "Right";
      pose[`${prefix}UpLeg`] = [0.1 * side, 0.28, 0];
      pose[`${prefix}Leg`] = [0.1 * side, 0.2, 0];
      pose[`${prefix}Foot`] = [0.1 * side, 0.1, 0];
      pose[`${prefix}ToeBase`] = [0.1 * side, 0.05, 0.1];
    }
  }
  const names = Object.keys(PARENTS).filter((name) => name !== options.drop);
  // Node 0 is Tripo's unmapped "Root"; joints follow in PARENTS order; the mesh node is last.
  const world = (name: string) => turn(pose[name]!);
  const nodes: Array<Record<string, unknown>> = [{ name: "Root", children: [] as number[] }];
  const index = new Map<string, number>();
  for (const name of names) {
    index.set(name, nodes.length);
    nodes.push({ name: `mixamorig:${name}`, children: [] as number[] });
  }
  for (const name of names) {
    const parent = PARENTS[name];
    const parentIndex = parent && index.has(parent) ? index.get(parent)! : 0;
    (nodes[parentIndex]!.children as number[]).push(index.get(name)!);
    const at = world(name);
    const from = parent && index.has(parent) ? world(parent) : ([0, 0, 0] as V3);
    nodes[index.get(name)!]!.translation = [at[0] - from[0], at[1] - from[1], at[2] - from[2]];
  }
  const joints = [0, ...names.map((name) => index.get(name)!)];

  // Three vertices at each joint, all weight on it; the hair reaches 1.8 m and the soles touch the ground.
  const positions: number[] = [];
  const jointIds: number[] = [];
  const weights: number[] = [];
  const add = (p: V3, joint: number) => {
    for (const offset of [
      [0, 0, 0],
      [0.02, 0, 0],
      [0, 0.02, 0],
    ] as V3[]) {
      positions.push(p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]);
      jointIds.push(joint, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
  };
  names.forEach((name, i) => add(world(name), i + 1));
  if (index.has("Head")) add(turn([0, 1.78, 0]), names.indexOf("Head") + 1);
  if (index.has("LeftFoot")) add(turn([0.1, 0, 0]), names.indexOf("LeftFoot") + 1);
  const vertexCount = positions.length / 3;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 1) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  const inverseBind = joints.flatMap((joint, i) => {
    const at = i === 0 ? ([0, 0, 0] as V3) : world(names[i - 1]!);
    void joint;
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -at[0], -at[1], -at[2], 1];
  });

  const chunks: Buffer[] = [];
  const views: Array<Record<string, unknown>> = [];
  let offset = 0;
  const view = (bytes: Buffer, extra: Record<string, unknown> = {}) => {
    const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...extra });
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };
  const f32 = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
  const u16 = (values: number[]) => Buffer.from(new Uint16Array(values).buffer);
  const positionView = view(f32(positions), { target: 34962 });
  const jointView = view(u16(jointIds), { target: 34962 });
  const weightView = view(f32(weights), { target: 34962 });
  const uvView = view(f32(Array.from({ length: vertexCount * 2 }, (_, i) => (i % 2 ? 0.25 : 0.75))), { target: 34962 });
  const indexView = view(u16(Array.from({ length: vertexCount }, (_, i) => i)), { target: 34963 });
  const bindView = view(f32(inverseBind));
  const imageViews = [view(textures.color), view(textures.metal), view(textures.normal)];

  const meshNode = nodes.length;
  nodes.push({ name: "Body", mesh: 0, ...(options.skin === false ? {} : { skin: 0 }) });
  const json = {
    asset: { version: "2.0", generator: "tripo-like regression fixture" },
    scene: 0,
    scenes: [{ nodes: [0, meshNode] }],
    nodes,
    ...(options.skin === false ? {} : { skins: [{ joints, inverseBindMatrices: 5 }] }),
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, TEXCOORD_0: 3 }, indices: 4, material: 0 },
        ],
      },
    ],
    accessors: [
      { bufferView: positionView, componentType: 5126, count: vertexCount, type: "VEC3", min, max },
      { bufferView: jointView, componentType: 5123, count: vertexCount, type: "VEC4" },
      { bufferView: weightView, componentType: 5126, count: vertexCount, type: "VEC4" },
      { bufferView: uvView, componentType: 5126, count: vertexCount, type: "VEC2" },
      { bufferView: indexView, componentType: 5123, count: vertexCount, type: "SCALAR" },
      { bufferView: bindView, componentType: 5126, count: joints.length, type: "MAT4" },
    ],
    materials: [
      {
        name: "tripo",
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } },
        normalTexture: { index: 2 },
      },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
    images: [
      { bufferView: imageViews[0], mimeType: "image/jpeg" },
      { bufferView: imageViews[1], mimeType: "image/jpeg" },
      { bufferView: imageViews[2], mimeType: "image/png" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: offset }],
    ...(options.extensionsUsed ? { extensionsUsed: options.extensionsUsed } : {}),
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + 8 + bin.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, bin]);
}

const owner = { ownerType: "character", ownerId: "char_tripo" } as const;
const vrmInput = (bytes: Uint8Array) => ({ owner, filename: "model.vrm", bytes });
/** The whole binary chunk (header and data) after the JSON chunk. */
const binChunk = (glb: Buffer) => glb.subarray(20 + glb.readUInt32LE(12));

// ── The conversion ──
const tripoGlb = riggedGlb();
const converted = convertRiggedGlbToVrm(tripoGlb, { name: "Maukie" });
{
  const { report } = converted;
  assert.equal(report.humanBones.hips, "mixamorig:Hips");
  assert.equal(report.humanBones.chest, "mixamorig:Spine1", "Spine1 is the chest");
  assert.equal(report.humanBones.upperChest, "mixamorig:Spine2", "Spine2 is the upper chest");
  assert.equal(report.humanBones.leftUpperArm, "mixamorig:LeftArm");
  assert.equal(report.humanBones.rightLowerLeg, "mixamorig:RightLeg");
  assert.equal(report.humanBones.leftToes, "mixamorig:LeftToeBase");
  assert.equal(Object.keys(report.humanBones).length, 22, "every Mixamo joint but Root is a humanoid bone");
  assert.deepEqual(report.unmappedJoints, ["Root"]);
  assert.equal(report.facingTurnDegrees, -90, "a model facing +X turns -90° around the up axis");
  assert.ok(Math.abs(report.armDropDegrees[0]) < 1 && Math.abs(report.armDropDegrees[1]) < 1, "a T-pose");
  assert.ok(Math.abs(report.heightMetres - 1.8) < 0.01, `height ${report.heightMetres}`);
  assert.equal(report.metalMaterials, 1);
  assert.ok(binChunk(converted.vrm).equals(binChunk(tripoGlb)), "the binary chunk is copied byte for byte");

  const { json } = parseGlb(converted.vrm);
  const vrm = (json.extensions as { VRMC_vrm: Record<string, any> }).VRMC_vrm;
  assert.ok(json.extensionsUsed?.includes("VRMC_vrm"));
  assert.equal(vrm.specVersion, "1.0");
  assert.equal(vrm.meta.name, "Maukie", "the model is named after its owner");
  assert.deepEqual(vrm.meta.authors, ["Tripo AI"]);
  assert.equal(vrm.meta.licenseUrl, "https://vrm.dev/licenses/1.0/");
  assert.equal(vrm.meta.otherLicenseUrl, "https://developers.tripo3d.ai/en/terms", "Tripo's terms are linked");
  assert.equal(vrm.meta.avatarPermission, "onlyAuthor", "no use by others is claimed");
  assert.equal(vrm.meta.commercialUsage, "personalNonProfit", "no commercial use is claimed");
  assert.equal(vrm.meta.allowRedistribution, false);
  assert.equal(vrm.expressions, undefined, "no expressions: the model has no face shapes");
  assert.equal(vrm.lookAt, undefined);
  assert.equal(json.materials?.[0]?.pbrMetallicRoughness?.metallicFactor, 0, "metal is off");
  const root = json.nodes!.at(-1)!;
  assert.equal(root.name, "VRM_FacingRoot");
  assert.deepEqual(json.scenes![0]!.nodes, [json.nodes!.length - 1], "one new root holds the scene");
}
{
  // The Engine's importer takes it as a body-only VRM 1.0 model.
  const input = vrmInput(new Uint8Array(converted.vrm));
  const validated = await vrmImporter.validate(input);
  const built = buildVrmImport(validated, input, null);
  assert.equal(built.data.specVersion, "1.0");
  assert.deepEqual(built.data.expressionNames, []);
  assert.equal(built.data.meta?.title, "Maukie");
  assert.deepEqual(built.data.meta?.authors, ["Tripo AI"]);
  assert.equal(built.data.meta?.termsUrl, "https://developers.tripo3d.ai/en/terms");
  assert.ok(
    built.warnings.includes("This model has no face expressions, so its face doesn't move."),
    "the import says the face doesn't move",
  );
  assert.equal(
    built.warnings.some((warning) => warning.includes("You can pick them in setup")),
    false,
    "no offer to pick expressions the model doesn't have",
  );
}
// Facing is worked out from the shoulders, not assumed.
assert.equal(convertRiggedGlbToVrm(riggedGlb({ facing: "+Z" }), { name: "x" }).report.facingTurnDegrees, 0);
assert.equal(
  parseGlb(convertRiggedGlbToVrm(riggedGlb({ facing: "+Z" }), { name: "x" }).vrm).json.nodes!.some(
    (node) => node.name === "VRM_FacingRoot",
  ),
  false,
  "a model already facing +Z gets no extra root",
);
assert.equal(convertRiggedGlbToVrm(riggedGlb({ facing: "-X" }), { name: "x" }).report.facingTurnDegrees, 90);

// Refusals, each before anything is written.
const refusal = (glb: Buffer, code: string, pattern: RegExp) =>
  assert.throws(
    () => convertRiggedGlbToVrm(glb, { name: "x" }),
    (error: unknown) => error instanceof VrmConversionError && error.code === code && pattern.test(error.message),
    code,
  );
refusal(
  riggedGlb({ pose: "arms-down" }),
  "not-t-pose",
  /arms aren't held out.*Use a full-body sprite where the whole character is visible\./u,
);
refusal(
  riggedGlb({ legless: true }),
  "no-legs",
  /no legs\. Use a full-body sprite where the whole character is visible\./u,
);
refusal(riggedGlb({ drop: "LeftFoot" }), "missing-bones", /missing parts a VRM needs: leftFoot\./u);
refusal(riggedGlb({ skin: false }), "not-rigged", /without a skeleton/u);
refusal(riggedGlb({ extensionsUsed: ["KHR_draco_mesh_compression"] }), "compressed", /compressed/u);
refusal(Buffer.from("not a model"), "invalid", /damaged/u);

// ── Smaller textures ──
const shrunk = await shrinkGlbTextures(converted.vrm, getSharp);
{
  assert.equal(shrunk.skipped, false);
  assert.deepEqual(
    shrunk.resized.map(({ image, to }) => [image, to]),
    [
      [1, 1024],
      [2, 1024],
    ],
    "the metal and normal maps drop to 1024; the colour map keeps its 2048",
  );
  const before = parseGlb(converted.vrm);
  const after = parseGlb(shrunk.glb);
  const viewBytes = (parsed: typeof before, index: number) => {
    const view = parsed.json.bufferViews![index]!;
    return parsed.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  };
  for (let index = 0; index < 6; index += 1) {
    assert.ok(viewBytes(before, index).equals(viewBytes(after, index)), `mesh data ${index} is unchanged`);
  }
  for (const view of after.json.bufferViews!) assert.equal((view.byteOffset ?? 0) % 4, 0, "views stay aligned");
  const sizes = await Promise.all(
    after.json.images!.map(async (image) => (await sharp(viewBytes(after, image.bufferView!)).metadata()).width),
  );
  assert.deepEqual(sizes, [2048, 1024, 1024]);
  assert.ok(shrunk.glb.length < converted.vrm.length);
  await vrmImporter.validate(vrmInput(new Uint8Array(shrunk.glb)));
  const noSharp = await shrinkGlbTextures(converted.vrm, async () => {
    throw new Error("Image processing is unavailable on this platform");
  });
  assert.equal(noSharp.skipped, true, "without sharp (Lite, Termux) the textures stay as they are");
  assert.ok(noSharp.glb.equals(converted.vrm));
}

// ── The stage's own loader (three + three-vrm) in Node ──
{
  const { loadStoredVrm } = await import("../../packages/client/src/features/avatars/renderers/vrm/vrm-renderer.js");
  // Node has no image decoder for three's texture loader, so this copy leaves the pictures out.
  const { json, bin } = parseGlb(shrunk.glb);
  delete json.images;
  delete json.textures;
  json.materials = [{ name: "tripo", pbrMetallicRoughness: { metallicFactor: 0 } }];
  const untextured = writeGlb(json, bin);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(untextured))) as typeof fetch;
  try {
    const gltf = await loadStoredVrm(owner, VRM_MODEL_FILE, new AbortController().signal);
    const vrm = gltf.userData.vrm as {
      humanoid: { getRawBoneNode(name: string): unknown };
      expressionManager?: { expressions: unknown[] };
      lookAt?: unknown;
    };
    assert.ok(vrm, "three-vrm loads the model");
    assert.ok(vrm.humanoid.getRawBoneNode("hips") && vrm.humanoid.getRawBoneNode("leftHand"));
    assert.equal(vrm.expressionManager?.expressions.length ?? 0, 0, "no face expressions to drive");
    assert.equal(vrm.lookAt ?? null, null, "no eye gaze");
    // Facing +Z: the left hand at +X, the toes forward (+Z), once skinned as the renderer draws it.
    gltf.scene.updateMatrixWorld(true);
    let mesh: any = null;
    gltf.scene.traverse((object: any) => {
      if (object.isSkinnedMesh) mesh = object;
    });
    assert.ok(mesh, "the body is a skinned mesh");
    const vertex = (joint: string) => {
      // A three Vector3, from the loader's own copy of three.
      const position = mesh.position.clone();
      const order = Object.keys(PARENTS);
      mesh.getVertexPosition(order.indexOf(joint) * 3, position);
      return position.applyMatrix4(mesh.matrixWorld);
    };
    const hand = vertex("LeftHand");
    assert.ok(hand.x > 0.6 && Math.abs(hand.z) < 0.05, `left hand at ${hand.toArray().map((n) => n.toFixed(2))}`);
    const toe = vertex("LeftToeBase");
    assert.ok(toe.z > 0.1, `toes point forward (+Z): ${toe.toArray().map((n) => n.toFixed(2))}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── The Tripo client ──
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
interface Answer {
  status?: number;
  json?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
}
function mockTripo(handler: (call: Call, index: number) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit & { maxResponseBytes: number }) => {
    init.signal?.throwIfAborted();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    const call = { url, method: init.method ?? "GET", headers, body };
    calls.push(call);
    const answer = await handler(call, calls.length - 1);
    return new Response(answer.bytes ?? JSON.stringify(answer.json ?? {}), {
      status: answer.status ?? 200,
      headers: answer.headers,
    });
  };
  return { calls, fetch };
}
const ok = (data: unknown): Answer => ({ json: { code: 0, data } });
const fail = (status: number, code: number, message = "nope"): Answer => ({ json: { code, message }, status });
const noWait = async () => undefined;
const client = (fetch: ReturnType<typeof mockTripo>["fetch"], extra: Record<string, unknown> = {}) =>
  createTripoClient({ apiKey: KEY, fetch, wait: noWait, ...extra });
const tripoError = (kind: string, pattern: RegExp) => (error: unknown) =>
  error instanceof TripoError && error.kind === kind && pattern.test(error.message) && !error.message.includes(KEY);

{
  for (const [answer, kind, pattern] of [
    [fail(401, 1000), "bad-key", /Check the key of your Tripo connection in Connections\./u],
    [fail(401, 1001), "bad-key", /Connections/u],
    [fail(403, 2010), "no-credits", /Top up at Tripo/u],
    [fail(400, 2008), "content-policy", /content policy/u],
    [fail(500, 9999), "unavailable", /problem on its side/u],
    [fail(400, 1234, `bad input for ${KEY}`), "refused", /\(1234\): bad input for \[redacted\]/u],
  ] as const) {
    const { fetch } = mockTripo(() => answer);
    await assert.rejects(client(fetch).balance(), tripoError(kind, pattern), kind);
  }
  const offline = createTripoClient({
    apiKey: KEY,
    wait: noWait,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(offline.balance(), tripoError("unavailable", /Check your internet connection/u));
}
{
  // Busy: wait as long as Tripo asks, then go on; still busy after the retries: a plain message.
  const waits: number[] = [];
  const busyOnce = mockTripo((_, index) =>
    index === 0 ? { ...fail(429, 2000), headers: { "retry-after": "7" } } : ok({ balance: 80, frozen: 5 }),
  );
  const result = await createTripoClient({
    apiKey: KEY,
    fetch: busyOnce.fetch,
    wait: async (ms: number) => {
      waits.push(ms);
    },
  }).balance();
  assert.deepEqual(result, { balance: 80, frozen: 5 });
  assert.deepEqual(waits, [7000], "Retry-After is honoured");
  const alwaysBusy = mockTripo(() => fail(429, 1007));
  await assert.rejects(client(alwaysBusy.fetch).balance(), tripoError("rate-limited", /Try again in a minute\./u));
  assert.equal(alwaysBusy.calls.length, 5, "four retries, then the plain message");
}
{
  // Polling: queued → running → success, with progress as it changes; a failed or banned task is plain.
  const progress: Array<number | null> = [];
  const states = [
    { status: "queued", progress: 0 },
    { status: "running", progress: 40 },
    { status: "running", progress: 40 },
    { status: "success", progress: 100, output: { model_url: "https://x" }, credits_consumed: 30 },
  ];
  const polled = mockTripo((_, index) => ok({ task_id: "t1", ...states[index] }));
  const task = await client(polled.fetch).waitForTask("t1", "the 3D model", (p) => progress.push(p));
  assert.equal(task.credits_consumed, 30);
  assert.deepEqual(progress, [0, 40, 100], "progress is reported when it changes");
  assert.ok(polled.calls.every((call) => call.url === "https://openapi.tripo3d.ai/v3/tasks/t1"));
  const failed = mockTripo(() => ok({ task_id: "t2", status: "failed", error_code: 500 }));
  await assert.rejects(
    client(failed.fetch).waitForTask("t2", "the 3D model"),
    tripoError("task-failed", /couldn't make the 3D model \(failed\)\. Credits for a failed step are given back\./u),
  );
  const banned = mockTripo(() => ok({ task_id: "t3", status: "banned" }));
  await assert.rejects(client(banned.fetch).waitForTask("t3", "x"), tripoError("content-policy", /content policy/u));
  let clock = 0;
  const slow = mockTripo(() => ok({ task_id: "t4", status: "running" }));
  await assert.rejects(
    client(slow.fetch, {
      now: () => (clock += 60_000),
      taskTimeoutMs: 120_000,
    }).waitForTask("t4", "x"),
    tripoError("timeout", /taking too long/u),
  );
}
{
  // Cancel: the wait between polls stops at once and nothing more is asked.
  const controller = new AbortController();
  const polled = mockTripo(() => ok({ task_id: "t5", status: "running", progress: 10 }));
  const pending = createTripoClient({
    apiKey: KEY,
    fetch: polled.fetch,
    signal: controller.signal,
    pollIntervalMs: 60_000,
  }).waitForTask("t5", "x");
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new DOMException("The request was cancelled.", "AbortError"));
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  const asked = polled.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(polled.calls.length, asked, "no request after Cancel");
  assert.equal(asked, 1);
}
{
  // Downloads: HTTPS links only, never with the key.
  const downloads = mockTripo(() => ({ bytes: Buffer.from("glb!") }));
  const bytes = await client(downloads.fetch).download("https://tripo-data.example.com/a.glb?sig=abc", 1024);
  assert.equal(bytes.toString(), "glb!");
  assert.equal(downloads.calls[0]!.headers.authorization, undefined, "the key never goes to a download link");
  await assert.rejects(client(downloads.fetch).download("http://tripo-data.example.com/a.glb", 1024), /secure/u);
  await assert.rejects(client(downloads.fetch).download(undefined, 1024), /secure/u);
  // A failed download is logged in debug mode without the link's signature.
  const lines: string[] = [];
  const warn = logger.warn.bind(logger);
  (logger as { warn: unknown }).warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const broken = createTripoClient({
      apiKey: KEY,
      debug: true,
      fetch: async () => {
        throw new Error("Refused to fetch https://tripo-data.example.com/a.glb?sig=SECRET123: blocked");
      },
    });
    await assert.rejects(broken.download("https://tripo-data.example.com/a.glb?sig=SECRET123", 1024), /Try again/u);
  } finally {
    (logger as { warn: unknown }).warn = warn;
  }
  assert.ok(
    lines.some((line) => line.includes("https://tripo-data.example.com/a.glb")),
    "the failure is logged",
  );
  assert.equal(lines.join("\n").includes("SECRET123"), false, "the signature never reaches the log");
  const missing = mockTripo(() => ({ status: 404, bytes: Buffer.from("") }));
  await assert.rejects(
    client(missing.fetch).download("https://tripo-data.example.com/a.glb", 1024),
    tripoError("unavailable", /error 404/u),
  );
}

// ── The whole run, with a mocked Tripo ──
const db = await getDB();
try {
  const characters = createCharactersStorage(db);
  const character = await characters.create(characterDataSchema.parse({ name: "Maukie", description: "A cat." }));
  const runOwner = { ownerType: "character" as const, ownerId: character.id };
  const connections = createConnectionsStorage(db);
  const tripo = await connections.create(
    createConnectionSchema.parse({
      name: "My Tripo",
      provider: "tripo",
      apiKey: KEY,
      isDefault: true,
      useForRandom: true,
    }),
  );
  const chat = await connections.create(
    createConnectionSchema.parse({ name: "Chat", provider: "openai", apiKey: "sk" }),
  );
  assert.equal(
    (await connections.getById(tripo.id))?.isDefault,
    "false",
    "a Tripo connection never becomes the chat default",
  );
  assert.equal((await connections.getById(tripo.id))?.useForRandom, "false");
  assert.equal((await connections.getById(tripo.id))?.apiKeyEncrypted === KEY, false, "the key is stored encrypted");
  // A cut-out sprite on a canvas, as sprite folders hold them.
  const spriteDir = join(dataDir, "sprites", character.id);
  mkdirSync(spriteDir, { recursive: true });
  const sprite = await sharp({
    create: { width: 600, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><rect x="200" y="100" width="200" height="1000" fill="#d08040"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  writeFileSync(join(spriteDir, "full_neutral.png"), sprite);
  const tposePicture = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();

  const tasks: Record<string, unknown[]> = {};
  const script = (rigged: Buffer, overrides: { balance?: number; riggable?: boolean } = {}) =>
    mockTripo((call) => {
      const path = call.url.replace("https://openapi.tripo3d.ai/v3", "");
      if (!call.url.startsWith("https://openapi.tripo3d.ai/v3/")) {
        if (call.url.includes("rigged.glb")) return { bytes: rigged };
        return { bytes: tposePicture };
      }
      if (path === "/account/balance") return ok({ balance: overrides.balance ?? 710, frozen: 0 });
      if (path === "/files") return ok({ file_token: "file-token-1" });
      const started: Record<string, string> = {
        "/generation/image-to-image": "11111111-1111-4111-8111-111111111111",
        "/generation/image-to-model": "22222222-2222-4222-8222-222222222222",
        "/animations/rig-check": "33333333-3333-4333-8333-333333333333",
        "/animations/rig": "44444444-4444-4444-8444-444444444444",
      };
      if (started[path]) return ok({ task_id: started[path] });
      const id = path.replace("/tasks/", "");
      const done: Record<string, Record<string, unknown>> = {
        [started["/generation/image-to-image"]!]: {
          output: { generated_image_url: "https://tripo-data.example.com/t/generated_image.png?sig=1" },
          credits_consumed: 5,
        },
        [started["/generation/image-to-model"]!]: {
          output: {
            model_url: "https://tripo-data.example.com/t/model.glb?sig=2",
            rendered_image_url: "https://tripo-data.example.com/t/legacy_mesh.webp?sig=3",
          },
          credits_consumed: 30,
        },
        [started["/animations/rig-check"]!]: {
          output: { riggable: overrides.riggable ?? true, rig_type: "biped" },
          credits_consumed: 0,
        },
        [started["/animations/rig"]!]: {
          output: { model_url: "https://tripo-data.example.com/t/rigged.glb?sig=4" },
          credits_consumed: 25,
        },
      };
      // Each task is queued, then running, then done.
      const seen = (tasks[id] ??= []);
      seen.push(id);
      if (seen.length === 1) return ok({ task_id: id, status: "queued", progress: 0 });
      if (seen.length === 2) return ok({ task_id: id, status: "running", progress: 50 });
      return ok({ task_id: id, status: "success", progress: 100, ...done[id] });
    });

  const captured: string[] = [];
  const warn = logger.warn.bind(logger);
  (logger as { warn: unknown }).warn = (...args: unknown[]) => {
    captured.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  const events: Array<{ step: string; status: string; creditsUsed: number }> = [];
  const happy = script(riggedGlb());
  let draft;
  try {
    draft = await generateVrmModel(
      db,
      { owner: runOwner, sourceLabel: "full_neutral", connectionId: tripo.id, debugMode: true },
      { fetch: happy.fetch, wait: noWait, onProgress: (event) => events.push(event) },
    );
  } finally {
    (logger as { warn: unknown }).warn = warn;
  }

  // Exactly the settings tried by hand, in order, with the key only on the API.
  const api = happy.calls.filter((call) => call.url.startsWith("https://openapi.tripo3d.ai/v3/"));
  const posts = api.filter((call) => call.method === "POST");
  assert.deepEqual(
    posts.map((call) => call.url.replace("https://openapi.tripo3d.ai/v3", "")),
    ["/files", "/generation/image-to-image", "/generation/image-to-model", "/animations/rig-check", "/animations/rig"],
  );
  assert.ok(posts[0]!.body instanceof FormData && (posts[0]!.body.get("file") as Blob).type === "image/png");
  assert.deepEqual(posts[1]!.body, {
    input: "file-token-1",
    template: "t_pose",
    model: "seedream_v5",
    output_format: "png",
  });
  assert.deepEqual(posts[2]!.body, {
    input: "11111111-1111-4111-8111-111111111111",
    model: "v3.1-20260211",
    texture: true,
    pbr: true,
    texture_quality: "standard",
    face_limit: 40000,
    auto_size: true,
  });
  for (const left of ["export_orientation", "compress", "quad"]) {
    assert.equal(left in (posts[2]!.body as object), false, `${left} is never sent`);
  }
  assert.deepEqual(posts[3]!.body, { input: "22222222-2222-4222-8222-222222222222" });
  assert.deepEqual(posts[4]!.body, {
    input: "22222222-2222-4222-8222-222222222222",
    model: "v1.0-20240301",
    rig_type: "biped",
    spec: "mixamo",
    out_format: "glb",
  });
  assert.deepEqual(TRIPO_REQUESTS.rig, {
    model: "v1.0-20240301",
    rig_type: "biped",
    spec: "mixamo",
    out_format: "glb",
  });
  assert.ok(
    api.every((call) => call.headers.authorization === `Bearer ${KEY}`),
    "the key goes to the API",
  );
  assert.ok(
    happy.calls
      .filter((call) => !call.url.startsWith("https://openapi.tripo3d.ai/"))
      .every((call) => !call.headers.authorization),
    "and nowhere else",
  );
  assert.equal(api[0]!.url, "https://openapi.tripo3d.ai/v3/account/balance", "the balance is checked first");

  // Progress per step, with the credits used.
  const steps = events.filter((event) => event.status === "done").map((event) => [event.step, event.creditsUsed]);
  assert.deepEqual(steps, [
    ["redraw", 5],
    ["model", 35],
    ["rig", 60],
    ["convert", 60],
  ]);
  assert.equal(events[0]!.step, "redraw");
  assert.equal(events[0]!.status, "running");
  assert.equal(TRIPO_VRM_MODEL_CREDITS, 60);

  // The draft: a VRM the importer takes, previews, and nothing stored yet.
  assert.ok(draft);
  assert.equal(draft.creditsUsed, 60);
  assert.equal(draft.fileName, "Maukie.vrm");
  assert.match(draft.preview ?? "", /^data:image\/webp;base64,/u);
  assert.match(draft.tpose ?? "", /^data:image\/webp;base64,/u);
  assert.ok(draft.warnings.includes("This model has no face expressions, so its face doesn't move."));
  const draftBytes = Buffer.from(draft.vrm, "base64");
  const validated = await vrmImporter.validate({
    owner: runOwner,
    filename: draft.fileName,
    bytes: new Uint8Array(draftBytes),
  });
  assert.equal(validated.type, "model");
  assert.equal(existsSync(avatarOwnerDir(runOwner)), false, "generating stores nothing");

  // Debug mode logs every request's parameters and task id, never the key or a download signature.
  const log = captured.join("\n");
  assert.ok(log.includes('"template":"t_pose"') && log.includes('"face_limit":40000'), "request parameters are logged");
  assert.ok(log.includes("22222222-2222-4222-8222-222222222222"), "task ids are logged");
  assert.equal(log.includes(KEY), false, "the key is never logged");
  assert.equal(log.includes("sig="), false, "download signatures are never logged");
  assert.equal(log.includes("Tripo GET /tasks"), false, "polls are not logged one by one");

  // Not enough credits: refused before anything is paid for.
  const poor = script(riggedGlb(), { balance: 40 });
  await assert.rejects(
    generateVrmModel(
      db,
      { owner: runOwner, sourceLabel: "full_neutral", connectionId: tripo.id },
      { fetch: poor.fetch, wait: noWait },
    ),
    (error: unknown) =>
      error instanceof AvatarGenerationError &&
      error.statusCode === 402 &&
      /needs about 60 Tripo credits and your account has 40/u.test(error.message),
  );
  assert.equal(poor.calls.length, 1, "only the balance was read");

  // Tripo can't rig it: stop before the paid skeleton.
  const unriggable = script(riggedGlb(), { riggable: false });
  for (const key of Object.keys(tasks)) delete tasks[key];
  await assert.rejects(
    generateVrmModel(
      db,
      { owner: runOwner, sourceLabel: "full_neutral", connectionId: tripo.id },
      { fetch: unriggable.fetch, wait: noWait },
    ),
    /can't give this model a skeleton\. Use a full-body sprite where the whole character is visible\./u,
  );
  assert.equal(
    unriggable.calls.some((call) => call.url.endsWith("/animations/rig")),
    false,
    "the rig is never paid for",
  );

  // An arms-down model is refused with the full-body advice, and nothing is saved.
  for (const key of Object.keys(tasks)) delete tasks[key];
  const armsDown = script(riggedGlb({ pose: "arms-down" }));
  await assert.rejects(
    generateVrmModel(
      db,
      { owner: runOwner, sourceLabel: "full_neutral", connectionId: tripo.id },
      { fetch: armsDown.fetch, wait: noWait },
    ),
    (error: unknown) =>
      error instanceof AvatarGenerationError &&
      error.statusCode === 422 &&
      /Use a full-body sprite where the whole character is visible\./u.test(error.message),
  );
  assert.equal(existsSync(avatarOwnerDir(runOwner)), false, "a refused model stores nothing");

  // Only a Tripo connection with a key will do.
  await assert.rejects(
    generateVrmModel(db, { owner: runOwner, sourceLabel: "full_neutral", connectionId: chat.id }),
    /Choose a Tripo connection/u,
  );

  // The route: a bad body is a 400; a refusal streams as a plain error event.
  const app = Fastify();
  app.decorate("db", db);
  await app.register(avatarGenerationRoutes);
  try {
    const bad = await app.inject({ method: "POST", url: "/vrm-model", payload: { owner: runOwner } });
    assert.equal(bad.statusCode, 400);
    const refused = await app.inject({
      method: "POST",
      url: "/vrm-model",
      payload: { owner: runOwner, sourceLabel: "full_neutral", connectionId: chat.id },
    });
    assert.match(String(refused.headers["content-type"]), /text\/event-stream/u);
    const events = refused.body
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => JSON.parse(block.slice(6)));
    assert.deepEqual(events, [
      {
        type: "error",
        data: { message: "Choose a Tripo connection. Add one in Connections with your Tripo API key." },
      },
    ]);
    const balance = await app.inject({ method: "GET", url: "/vrm-model/balance" });
    assert.equal(balance.statusCode, 400, "the balance needs a connection");
  } finally {
    await app.close();
  }
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("avatar VRM generation regression passed");
