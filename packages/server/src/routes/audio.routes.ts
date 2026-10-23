import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import {
  AudioGenerationConfigurationError,
  generateAudioAsset,
  resolveGenerativeAudioConfig,
} from "../services/audio/generative-audio.service.js";

const key = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const generateSchema = z.object({
  kind: z.enum(["music", "sfx"]),
  prompt: z.string().trim().min(1).max(4_100),
  audioConnectionId: z.string().trim().max(200).nullable().optional(),
  debugMode: z.boolean().default(false),
  context: z
    .object({
      scope: key.max(80),
      key,
      lengthMs: z.number().int().min(10_000).max(300_000).optional(),
    })
    .optional(),
});

export async function audioRoutes(app: FastifyInstance) {
  app.get("/config", async (req, reply) => {
    const { audioConnectionId } = z
      .object({ audioConnectionId: z.string().trim().max(200).optional() })
      .parse(req.query);
    try {
      const config = await resolveGenerativeAudioConfig(app.db, audioConnectionId);
      return {
        connectionId: config.id,
        configured: (config.music || config.soundEffects) && (config.source === "custom" || Boolean(config.apiKey)),
        music: config.music,
        soundEffects: config.soundEffects,
        source: config.source,
      };
    } catch (error) {
      if (!(error instanceof AudioGenerationConfigurationError)) throw error;
      if (error.statusCode === 409) return reply.status(409).send({ error: error.message });
      return { connectionId: null, configured: false, music: false, soundEffects: false, source: null };
    }
  });

  app.post("/generate", async (req, reply) => {
    const input = generateSchema.parse(req.body);
    if ((input.kind === "music") !== Boolean(input.context)) {
      return reply.status(400).send({
        error:
          input.kind === "music"
            ? "Music generation requires a context scope and key"
            : "Context tracks are music only",
      });
    }
    try {
      return await generateAudioAsset(app.db, input);
    } catch (error) {
      if (error instanceof AudioGenerationConfigurationError)
        return reply.status(error.statusCode).send({ error: error.message });
      logger.error(error, "Audio generation failed");
      return reply.status(502).send({
        error: "Audio generation failed",
        detail: error instanceof Error ? error.message : "Unknown provider error",
      });
    }
  });
}
