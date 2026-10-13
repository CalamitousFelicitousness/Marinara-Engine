// ──────────────────────────────────────────────
// Avatar generation: a mesh-avatar rig from one sprite (lane: generation)
// ──────────────────────────────────────────────
// The user's vision model reads the sprite with the 2D agent's `avatar-mesh-rig-layout` template and
// answers with the layout JSON (`layoutSchema`); a JavaScript layer builder on sharp (already a server
// dependency) cuts the layers and packs a `.mavatar`, stored through services/avatars/storage.ts.
// No Python, OpenCV or GPU. Log the final prompt with logDebugOverride (debugMode / DEBUG_AGENTS).
//
// Contract stub: the generation lane fills it in.
import type { AvatarGenerationResponse, AvatarMeshRigRequest } from "@marinara-engine/shared";
import type { AvatarGenerationOptions } from "./pngtuber-variants.js";

export async function generateMeshRig(
  _request: AvatarMeshRigRequest,
  _options: AvatarGenerationOptions = {},
): Promise<AvatarGenerationResponse> {
  throw new Error("Mesh avatar generation is not available yet");
}
