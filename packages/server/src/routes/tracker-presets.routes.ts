// ──────────────────────────────────────────────
// Routes: Tracker Presets
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import {
  applyTrackerPresetSchema,
  createTrackerPresetSchema,
  reorderTrackerPresetsSchema,
  setActiveTrackerPresetSchema,
  setTrackerAutoAdoptSchema,
  updateTrackerPresetSchema,
} from "@marinara-engine/shared";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createTrackerPresetsStorage } from "../services/storage/tracker-presets.storage.js";
import {
  applyTrackerPresetToChat,
  extractTrackerPresetFromChat,
  isTrackerAutoAdoptEnabled,
  setTrackerAutoAdoptEnabled,
  readChatCharacterIds,
  readChatTrackerPresetId,
} from "../services/tracker/tracker-preset.service.js";

export async function trackerPresetsRoutes(app: FastifyInstance) {
  const storage = createTrackerPresetsStorage(app.db);

  app.get("/", async () => {
    return storage.list();
  });

  // Static paths are declared before "/:id" so an id never shadows them.
  app.get("/active", async () => {
    return { presetId: await storage.getActiveId() };
  });

  app.put("/active", async (req, reply) => {
    const input = setActiveTrackerPresetSchema.parse(req.body);
    if (input.presetId && !(await storage.getById(input.presetId))) {
      return reply.status(404).send({ error: "Tracker preset not found" });
    }
    return { presetId: await storage.setActiveId(input.presetId) };
  });

  app.get("/auto-adopt", async () => {
    return { enabled: await isTrackerAutoAdoptEnabled(app) };
  });

  app.put("/auto-adopt", async (req) => {
    const input = setTrackerAutoAdoptSchema.parse(req.body);
    await setTrackerAutoAdoptEnabled(app, input.enabled);
    return { enabled: input.enabled };
  });

  app.put("/reorder", async (req) => {
    const input = reorderTrackerPresetsSchema.parse(req.body);
    return storage.reorder(input.presetIds);
  });

  /** Stamp a preset into a chat that already exists. Idempotent. */
  app.post("/apply", async (req, reply) => {
    const input = applyTrackerPresetSchema.parse(req.body);
    const chat = await createChatsStorage(app.db).getById(input.chatId);
    if (!chat) return reply.status(404).send({ error: "Chat not found" });
    if (chat.mode !== "roleplay") {
      return reply.status(400).send({ error: "Tracker presets apply to Roleplay chats only" });
    }

    let preset;
    if (input.presetId) {
      preset = await storage.getById(input.presetId);
      if (!preset) return reply.status(404).send({ error: "Tracker preset not found" });
    }

    return applyTrackerPresetToChat(app, {
      chatId: chat.id,
      mode: chat.mode,
      characterIds: readChatCharacterIds(chat.characterIds),
      personaId: chat.personaId ?? null,
      chatPresetId: readChatTrackerPresetId(chat.metadata),
      ...(preset ? { preset } : {}),
      includeCharacters: input.characters,
      includePersona: input.persona,
    });
  });

  /**
   * Derive preset rows from a chat's live tracker. Pure read; the caller
   * reviews and saves. Not gated on chat mode: reading a snapshot is harmless
   * and the rows are shown before anything is written.
   */
  app.get<{ Params: { chatId: string } }>("/from-chat/:chatId", async (req, reply) => {
    const chat = await createChatsStorage(app.db).getById(req.params.chatId);
    if (!chat) return reply.status(404).send({ error: "Chat not found" });
    return extractTrackerPresetFromChat(app, chat.id);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const preset = await storage.getById(req.params.id);
    if (!preset) return reply.status(404).send({ error: "Tracker preset not found" });
    return preset;
  });

  app.post("/", async (req) => {
    const input = createTrackerPresetSchema.parse(req.body);
    return storage.create(input);
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    const data = updateTrackerPresetSchema.parse(req.body);
    return storage.update(req.params.id, data);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await storage.remove(req.params.id);
    return reply.status(204).send();
  });
}
