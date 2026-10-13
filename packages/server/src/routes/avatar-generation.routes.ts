// ──────────────────────────────────────────────
// Routes: avatar generation from sprites (lane: generation)
// ──────────────────────────────────────────────
// Registered at /api/avatar-generation (AVATAR_API_PREFIXES.generation). Generating returns drafts and
// stores nothing, so an avatar stays as it was until the user keeps the result:
//   POST /pngtuber-variants/preview   AvatarPngtuberVariantsRequest → { items } for the image prompt review
//   POST /pngtuber-variants           AvatarPngtuberVariantsRequest (+ promptOverrides) → drafts
//   POST /pngtuber-variants/save      { owner, images } → AvatarGenerationResponse
//   POST /mesh-rig                    AvatarMeshRigRequest (+ imageConnectionId, drawVariants, promptOverrides) → draft
//   POST /mesh-rig/save               { owner, archive } → AvatarGenerationResponse
// Backed by services/avatars/generation/. Requests accept `debugMode`, and every prompt is logged with
// logDebugOverride, honouring DEBUG_AGENTS. A closed connection cancels the provider requests. Hosted 3D
// generation is out of scope.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AVATAR_PNGTUBER_VARIANTS,
  avatarMeshRigRequestSchema,
  avatarOwnerRefSchema,
  avatarPngtuberVariantsRequestSchema,
} from "@marinara-engine/shared";
import { logger } from "../lib/logger.js";
import { failureLevel } from "../lib/log-context.js";
import { AvatarGenerationError } from "../services/avatars/generation/generation-context.js";
import { generateMeshRig, saveMeshRig } from "../services/avatars/generation/mesh-rig.js";
import {
  generatePngtuberVariants,
  previewPngtuberVariantPrompts,
  savePngtuberVariants,
} from "../services/avatars/generation/pngtuber-variants.js";

const promptOverridesSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(300),
        prompt: z.string().max(16_000),
        negativePrompt: z.string().max(8_000).optional(),
      })
      .strict(),
  )
  .max(128)
  .optional();

const pngtuberVariantsBodySchema = avatarPngtuberVariantsRequestSchema.extend({
  promptOverrides: promptOverridesSchema,
});

const pngtuberSaveBodySchema = z
  .object({
    owner: avatarOwnerRefSchema,
    images: z
      .array(
        z
          .object({
            label: z.string().min(1).max(64),
            variant: z.enum(AVATAR_PNGTUBER_VARIANTS),
            image: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

const meshRigBodySchema = avatarMeshRigRequestSchema.extend({
  imageConnectionId: z.string().min(1).max(128).nullable().optional(),
  drawVariants: z.boolean().optional(),
  promptOverrides: promptOverridesSchema,
});

const meshSaveBodySchema = z.object({ owner: avatarOwnerRefSchema, archive: z.string().min(1) }).strict();

/** Aborted when the browser goes away (Cancel, a closed tab) before the reply is sent. */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort(new Error("The request was cancelled."));
  });
  return controller.signal;
}

function sendFailure(reply: FastifyReply, error: unknown, what: string) {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: "The request isn't valid.", issues: error.issues.slice(0, 5) });
  }
  if (error instanceof AvatarGenerationError) {
    if (error.statusCode >= 500) logger.warn(error, "%s failed", what);
    return reply.status(error.statusCode).send({ error: error.message });
  }
  logger[failureLevel(error)](error, "%s failed", what);
  const message = String(error instanceof Error ? error.message : error)
    .replace(/<[^>]*>/gu, "")
    .slice(0, 300);
  return reply.status(500).send({ error: message || `${what} failed.` });
}

export async function avatarGenerationRoutes(app: FastifyInstance) {
  app.post("/pngtuber-variants/preview", async (req, reply) => {
    try {
      return {
        items: await previewPngtuberVariantPrompts(app.db, avatarPngtuberVariantsRequestSchema.parse(req.body)),
      };
    } catch (error) {
      return sendFailure(reply, error, "PNGTuber variant preview");
    }
  });

  app.post("/pngtuber-variants", async (req, reply) => {
    try {
      const body = pngtuberVariantsBodySchema.parse(req.body);
      return await generatePngtuberVariants(app.db, body, { signal: abortOnClose(reply) });
    } catch (error) {
      return sendFailure(reply, error, "PNGTuber variant generation");
    }
  });

  app.post("/pngtuber-variants/save", async (req, reply) => {
    try {
      return await savePngtuberVariants(pngtuberSaveBodySchema.parse(req.body));
    } catch (error) {
      return sendFailure(reply, error, "Saving PNGTuber variants");
    }
  });

  app.post("/mesh-rig", async (req, reply) => {
    try {
      const body = meshRigBodySchema.parse(req.body);
      return await generateMeshRig(app.db, body, { signal: abortOnClose(reply) });
    } catch (error) {
      return sendFailure(reply, error, "Mesh avatar generation");
    }
  });

  app.post("/mesh-rig/save", async (req, reply) => {
    try {
      return await saveMeshRig(meshSaveBodySchema.parse(req.body));
    } catch (error) {
      return sendFailure(reply, error, "Saving the mesh avatar");
    }
  });
}
