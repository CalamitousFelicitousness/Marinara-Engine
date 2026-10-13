// ──────────────────────────────────────────────
// Avatar renderer: PNGTuber layered sprites (lane: 2D)
// ──────────────────────────────────────────────
// Swaps the layer set for the frame's label (or the emotion's bound label), shows the mouth-open and
// eyes-closed variants for talking and blinking, and bounces while talking. Plain canvas 2D; no WebGL.
//
// Contract stub: draws nothing until the 2D lane fills it in.
import type { AvatarRenderer } from "../../contract";

export function createAvatarRenderer(): AvatarRenderer {
  return {
    kind: "pngtuber",
    mount: async () => {},
    update() {},
    resize() {},
    setPaused() {},
    dispose() {},
  };
}
