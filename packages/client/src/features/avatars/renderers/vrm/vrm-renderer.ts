// ──────────────────────────────────────────────
// Avatar renderer: VRM 0.x / 1.0 (lane: 3D)
// ──────────────────────────────────────────────
// three + @pixiv/three-vrm (+ @pixiv/three-vrm-animation for `.vrma` idle motion), all MIT and pinned
// exactly. One WebGLRenderer for every VRM avatar on screen; the frame's emotion and viseme drive the
// model's bound expressions (VrmAvatarData.expressionMap).
//
// Contract stub: draws nothing until the 3D lane fills it in.
import type { AvatarRenderer } from "../../contract";

export function createAvatarRenderer(): AvatarRenderer {
  return {
    kind: "vrm",
    mount: async () => {},
    update() {},
    resize() {},
    setPaused() {},
    dispose() {},
  };
}
