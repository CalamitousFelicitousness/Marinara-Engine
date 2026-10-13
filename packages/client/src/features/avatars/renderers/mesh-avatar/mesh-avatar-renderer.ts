// ──────────────────────────────────────────────
// Avatar renderer: mesh-avatar `.mavatar` (lane: 2D)
// ──────────────────────────────────────────────
// Thin adapter over npm "mesh-avatar" 0.1.1 (MIT, pure JS WebGL2, pinned exactly): create it with
// `manual: true` and drive it with advance() from update(), so the stage's loop sets the frame rate.
// Emotions map to setEmotion(), visemes to holdMouth(), mouthOpen to setVoiceLevel().
//
// Contract stub: draws nothing until the 2D lane fills it in.
import type { AvatarRenderer } from "../../contract";

export function createAvatarRenderer(): AvatarRenderer {
  return {
    kind: "mesh-avatar",
    mount: async () => {},
    update() {},
    resize() {},
    setPaused() {},
    dispose() {},
  };
}
