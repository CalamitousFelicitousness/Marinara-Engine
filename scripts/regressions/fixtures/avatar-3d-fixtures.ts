// A 3D avatar as the one-click Tripo generator saved it, for checking that such models keep loading after the
// generator was withdrawn (maintainer decision, 2026-10-19: Tripo models have no face rig). tripo-made-avatar.vrm
// was written once by that generator's converter (glb-to-vrm.ts, removed with it) from a Tripo-shaped model
// built in code, so no file from Tripo itself is committed: a body-only VRM 1.0 model named "Maukie" by
// "Tripo AI", with a Mixamo skeleton under an unmapped Root turned to face +Z, one skinned mesh with one plain
// PBR material whose normal, colour and metal/roughness maps are embedded 8×8 pictures, and no face shapes,
// jaw or eye bones. Each body part is a flat panel facing forward and moving with one bone, so a browser can see
// the colour and the motion.
import { readFileSync } from "node:fs";

export type Rgb = [number, number, number];

/** The colour map's one colour. */
export const TRIPO_MADE_VRM_COLOUR: Rgb = [200, 60, 40];

/** The model file, as the 3D Avatars page saved it. */
export function tripoMadeVrm(): Buffer {
  return readFileSync(new URL("./tripo-made-avatar.vrm", import.meta.url));
}
