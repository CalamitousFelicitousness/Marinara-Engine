// ──────────────────────────────────────────────
// Avatar generation: PNGTuber blink and talk variants (lane: generation)
// ──────────────────────────────────────────────
// One click from a sprite: edit it into "eyes closed" and "mouth open" variants with the existing
// sprite/image generation (routes/sprites.routes.ts, services/image), using the 2D agent's
// `avatar-pngtuber-eyes-closed` / `avatar-pngtuber-mouth-open` templates, and store the results as
// PNGTuber layers through services/avatars/storage.ts. Log the final prompt with logDebugOverride
// (debugMode / DEBUG_AGENTS) before it reaches the provider.
//
// Contract stub: the generation lane fills it in.
import type { AvatarGenerationResponse, AvatarPngtuberVariantsRequest } from "@marinara-engine/shared";

export interface AvatarGenerationOptions {
  signal?: AbortSignal;
}

export async function generatePngtuberVariants(
  _request: AvatarPngtuberVariantsRequest,
  _options: AvatarGenerationOptions = {},
): Promise<AvatarGenerationResponse> {
  throw new Error("PNGTuber variant generation is not available yet");
}
