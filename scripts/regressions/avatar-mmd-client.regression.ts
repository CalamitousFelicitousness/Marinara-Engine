// The shipped loader/mixer compose imported bone/morph motion with the existing chat director.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkedPmx } from "../../packages/server/src/services/avatars/formats/mmd.js";
import { withoutDirectedMorphs } from "../../packages/client/src/features/avatars/renderers/mmd/mmd-renderer.js";
import { avatarAgentKinds } from "../../packages/client/src/features/avatars/setup/avatar-setup-logic.js";
import { pickAvatarKind } from "../../packages/client/src/features/avatars/stage/avatar-stage-logic.js";
import { mmdPmx, mmdVmd } from "./fixtures/avatar-mmd-fixtures.js";

const require = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { AnimationClip, AnimationMixer, LoadingManager, Loader, NumberKeyframeTrack, Texture } = await import(
  require.resolve("three")
);
const { MMDLoader } = await import(require.resolve("@takahirox/three-mmd/loaders/MMDLoader.js"));
const { Parser } = await import(require.resolve("mmd-parser"));
// No image decoding is claimed here; browser coverage verifies actual texture pixels under server CSP.
class NoImageLoader extends Loader {
  load() {
    return new Texture();
  }
}
const manager = new LoadingManager();
manager.addHandler(/./u, new NoImageLoader(manager));
const loader = new MMDLoader(manager);
const canonical = checkedPmx(mmdPmx()).bytes;
const model = new Parser().parsePmx(
  canonical.buffer.slice(canonical.byteOffset, canonical.byteOffset + canonical.byteLength),
  true,
);
const mesh = loader.meshBuilder.build(model, "");
assert.equal(mesh.geometry.getAttribute("position").count, 3, "the actual PMX builder reads geometry");
assert.equal(mesh.morphTargetDictionary?.["笑い"], 0, "Japanese morph names survive import and runtime decoding");
assert.equal(mesh.geometry.morphAttributes.position?.length, 1);
const vmd = mmdVmd();
const motion = new Parser().parseVmd(vmd.buffer.slice(vmd.byteOffset, vmd.byteOffset + vmd.byteLength), true);
const animation = loader.animationBuilder.build(motion, mesh);
const mixer = new AnimationMixer(mesh);
mixer.clipAction(animation).play();
mixer.update(0.5);
assert.ok(
  mesh.skeleton.getBoneByName("center")!.position.x > 0.05,
  "the actual VMD clip moves the imported model's bone",
);

const original = new AnimationClip("mixed", 1, [
  ...[0, 1].map((index) => new NumberKeyframeTrack(`.morphTargetInfluences[${index}]`, [0, 1], [0, 1])),
  ...animation.tracks,
]);
const filtered = withoutDirectedMorphs(
  original,
  { morphTargetDictionary: { 笑い: 0, costume: 1 } },
  { happy: { target: "笑い", source: "user", confidence: 1 } },
);
assert.equal(original.tracks.length, 4, "the saved motion is never mutated");
assert.equal(filtered.tracks.length, 3);
assert.ok(
  !filtered.tracks.some((track) => track.name === ".morphTargetInfluences[0]"),
  "the chat director owns its bound face",
);
assert.ok(
  filtered.tracks.some((track) => track.name === ".morphTargetInfluences[1]"),
  "unbound authored morphs still animate",
);
assert.ok(
  filtered.tracks.some((track) => track.name.includes(".bones[center]")),
  "bone motion stays intact",
);
assert.deepEqual(avatarAgentKinds("3d-avatars"), ["vrm", "mmd"]);
assert.equal(pickAvatarKind({ activeKind: "mmd", kinds: ["vrm", "mmd"] }, ["3d-avatars"]), "mmd");
assert.equal(
  pickAvatarKind({ activeKind: "mmd", kinds: ["mmd"] }, ["2d-avatars"]),
  null,
  "the 3D agent must be enabled",
);
mixer.stopAllAction();
mesh.geometry.dispose();
mesh.skeleton.dispose();
mesh.material.forEach((material) => material.dispose());
