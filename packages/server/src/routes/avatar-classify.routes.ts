// ──────────────────────────────────────────────
// Routes: streaming emotion classifier for avatars (lane: director)
// ──────────────────────────────────────────────
// Registered at /api/avatar-classify (AVATAR_API_PREFIXES.classify):
//   POST /    AvatarClassifyRequest (avatarClassifyRequestSchema) → AvatarClassifyResponse
// Backed by services/avatars/emotion-classifier.ts. Rate limited in middleware/rate-limit.ts.
import type { FastifyInstance } from "fastify";
import { avatarClassifyRequestSchema } from "@marinara-engine/shared";
import { AVATAR_CLASSIFY_RATE_LIMIT } from "../middleware/rate-limit.js";
import { classifyAvatarEmotions } from "../services/avatars/emotion-classifier.js";

export async function avatarClassifyRoutes(app: FastifyInstance) {
  app.post("/", { config: { rateLimit: AVATAR_CLASSIFY_RATE_LIMIT } }, async (req, reply) => {
    const parsed = avatarClassifyRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid classify request" });
    return classifyAvatarEmotions(parsed.data);
  });
}
