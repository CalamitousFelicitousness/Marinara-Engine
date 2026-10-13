// ──────────────────────────────────────────────
// Routes: avatar generation from sprites (lane: generation)
// ──────────────────────────────────────────────
// Registered at /api/avatar-generation (AVATAR_API_PREFIXES.generation):
//   POST /pngtuber-variants   AvatarPngtuberVariantsRequest → AvatarGenerationResponse
//   POST /mesh-rig            AvatarMeshRigRequest → AvatarGenerationResponse
// Backed by services/avatars/generation/. Both accept `debugMode` and log the final prompt with
// logDebugOverride, honouring DEBUG_AGENTS. Hosted 3D generation is out of scope.
//
// Contract stub: registers nothing until the generation lane fills it in.
import type { FastifyInstance } from "fastify";

export async function avatarGenerationRoutes(_app: FastifyInstance) {}
