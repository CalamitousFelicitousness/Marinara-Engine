import type { FastifyInstance } from "fastify";
import { createParameterBaselineResolver } from "../../services/generation/parameter-baseline.js";
import { createChatsStorage } from "../../services/storage/chats.storage.js";
import { parseExtra } from "./generate-route-utils.js";

type BaselineQuery = { chatId?: string; connectionId?: string; promptPresetId?: string; mode?: string };

/** An absent field keeps the chat's stored value; an empty one asks for none. */
function readQuery(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

/** GET /parameter-baseline: what a chat's Connection state shows, for a saved chat or choices not saved yet. */
export async function registerParameterBaselineRoute(app: FastifyInstance) {
  const chats = createChatsStorage(app.db);
  const resolveParameterBaseline = createParameterBaselineResolver(app.db);

  app.get<{ Querystring: BaselineQuery }>("/parameter-baseline", async (req, reply) => {
    const chatId = readQuery(req.query.chatId);
    const chat = chatId ? await chats.getById(chatId) : null;
    if (chatId && !chat) return reply.status(404).send({ error: "Chat not found" });
    const mode = readQuery(req.query.mode) ?? chat?.mode ?? null;
    if (!mode) return reply.status(400).send({ error: "Pass a chatId or a mode" });
    const queryConnectionId = readQuery(req.query.connectionId);
    const queryPresetId = readQuery(req.query.promptPresetId);
    return resolveParameterBaseline({
      mode,
      meta: chat ? (parseExtra(chat.metadata) as Record<string, unknown>) : {},
      connectionId: queryConnectionId === undefined ? (chat?.connectionId ?? null) : queryConnectionId,
      chatPromptPresetId: queryPresetId === undefined ? (chat?.promptPresetId ?? null) : queryPresetId,
    });
  });
}
