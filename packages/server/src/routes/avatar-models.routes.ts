// ──────────────────────────────────────────────
// Routes: avatar models for the 2D and 3D avatar agents (lane: base)
// ──────────────────────────────────────────────
// Registered at /api/avatar-models (AVATAR_API_PREFIXES.models). `routes/avatars.routes.ts` is the
// unrelated profile-picture route. Routes this plugin owns:
//   GET    /                                        AvatarOwnerSummary[]
//   GET    /:ownerType/:ownerId                     AvatarConfig (404 when none)
//   PUT    /:ownerType/:ownerId                     AvatarConfigUpdate → AvatarConfig
//   DELETE /:ownerType/:ownerId                     removes the owner's avatar folder
//   DELETE /:ownerType/:ownerId/kinds/:kind         removes one kind → AvatarConfig | null
//   POST   /:ownerType/:ownerId/import              multipart `file` (+ optional `kind`) → AvatarImportResult
//   GET    /:ownerType/:ownerId/files/:kind/:name   a stored file, with a checked content type
// Bodies are validated with the schemas in packages/shared/src/schemas/avatars.schema.ts; imports go
// through services/avatars/formats/registry.ts and add no size limit below the global upload cap.
//
// Contract stub: registers nothing until the base lane fills it in.
import type { FastifyInstance } from "fastify";

export async function avatarModelsRoutes(_app: FastifyInstance) {}
