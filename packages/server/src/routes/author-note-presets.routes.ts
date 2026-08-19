// ──────────────────────────────────────────────
// Routes: Author's Note Presets
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import {
  createAuthorNotePresetSchema,
  reorderAuthorNotePresetsSchema,
  updateAuthorNotePresetSchema,
} from "@marinara-engine/shared";
import { createAuthorNotePresetsStorage } from "../services/storage/author-note-presets.storage.js";

export async function authorNotePresetsRoutes(app: FastifyInstance) {
  const storage = createAuthorNotePresetsStorage(app.db);

  app.get("/", async () => {
    return storage.list();
  });

  app.put("/reorder", async (req) => {
    const input = reorderAuthorNotePresetsSchema.parse(req.body);
    return storage.reorder(input.presetIds);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const preset = await storage.getById(req.params.id);
    if (!preset) return reply.status(404).send({ error: "Author's note preset not found" });
    return preset;
  });

  app.post("/", async (req) => {
    const input = createAuthorNotePresetSchema.parse(req.body);
    return storage.create(input);
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    const data = updateAuthorNotePresetSchema.parse(req.body);
    return storage.update(req.params.id, data);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await storage.remove(req.params.id);
    return reply.status(204).send();
  });
}
