// ──────────────────────────────────────────────
// Routes: streaming emotion classifier for avatars (lane: director)
// ──────────────────────────────────────────────
// Registered at /api/avatar-classify (AVATAR_API_PREFIXES.classify):
//   POST /    AvatarClassifyRequest (avatarClassifyRequestSchema) → AvatarClassifyResponse
// Backed by services/avatars/emotion-classifier.ts.
//
// Contract stub: registers nothing until the director lane fills it in.
import type { FastifyInstance } from "fastify";

export async function avatarClassifyRoutes(_app: FastifyInstance) {}
