import { resolveMacros, type Lorebook, type LorebookEntry } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import {
  isMessageHiddenFromAI,
  parseExtra,
  parseGameStateRow,
  resolveActiveCharacterIds,
  resolveCharacterNameMap,
} from "../../routes/generate/generate-route-utils.js";
import { normalizeGenerationReplay } from "../../routes/generate/generation-replay.js";
import { normalizeAgentContextSize } from "../agents/agent-executor.js";
import { resolveChatUserIdentity } from "../chat-user-identity.js";
import { createAgentLorebookTriggerResolver } from "../generation/agent-lorebook-triggers.js";
import {
  buildLorebookScanMessagesWithGenerationGuide,
  resolveLorebookGenerationTriggers,
  resolveLorebookTokenBudget,
} from "../generation/lorebook-generation-runtime.js";
import { roleplayAgentsSeeWhispers, roleplayAgentText } from "../generation/roleplay-commands.js";
import { isMemoryRecallVectorizerAvailable, resolveMemoryRecallEmbeddingSource } from "../memory-recall-embedding.js";
import { cardPromptText } from "../prompt/card-text.js";
import {
  buildPromptMacroContext,
  normalizeChatMacroVariables,
  resolveCharacterMacroData,
  resolvePromptMessageMacros,
} from "../prompt/macro-context.js";
import { createAgentsStorage } from "../storage/agents.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";

/** The host supplies packageId: a package cannot select another agent or an arbitrary source book. */
export async function resolvePackageAgentLorebookEntries(
  db: DB,
  packageId: string,
  { chatId, signal }: { chatId: string; signal?: AbortSignal },
): Promise<Array<{ id: string; name?: string; content: string }>> {
  signal?.throwIfAborted();
  const chats = createChatsStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) throw new Error("Chat not found");
  const metadata = parseExtra(chat.metadata);
  const attachments = metadata.agentLorebookAttachments;
  const attachment =
    attachments && typeof attachments === "object" && !Array.isArray(attachments)
      ? (attachments as Record<string, unknown>)[packageId]
      : null;
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return [];
  const selected = attachment as Record<string, unknown>;
  if (selected.enabled !== true || typeof selected.lorebookId !== "string" || !selected.lorebookId.trim()) return [];

  const characters = createCharactersStorage(db);
  const roster: string[] = typeof chat.characterIds === "string" ? JSON.parse(chat.characterIds) : chat.characterIds;
  const characterIds = resolveActiveCharacterIds(roster, metadata, { mode: chat.mode });
  const tags = new Set<string>();
  for (const id of characterIds) {
    const card = await characters.getById(id);
    const data = parseExtra(card?.data);
    if (Array.isArray(data.tags)) for (const tag of data.tags) if (typeof tag === "string") tags.add(tag);
  }
  const persona = await resolveChatUserIdentity(characters, {
    id: chat.id,
    mode: chat.mode,
    personaId: chat.personaId,
    personaCharacterId: chat.personaCharacterId,
  });
  const allMessages = await chats.listMessages(chatId);
  let boundary = 0;
  for (let index = allMessages.length - 1; index >= 0; index--) {
    if (parseExtra(allMessages[index]!.extra).isConversationStart) {
      boundary = index;
      break;
    }
  }
  const visible = allMessages
    .slice(boundary)
    .filter((message) => chat.mode === "game" || !isMessageHiddenFromAI(message));
  const last = visible.at(-1);
  const prior = visible
    .slice(0, -1)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .at(-1);
  const replay = normalizeGenerationReplay(parseExtra(last?.extra).generationReplay);
  const generationTriggers = resolveLorebookGenerationTriggers(
    {
      ...replay,
      userMessage:
        replay?.userMessage ?? (last?.role === "user" ? last.content : prior?.role === "user" ? prior.content : null),
      regenerateMessageId: last?.role === "assistant" && (last.activeSwipeIndex ?? 0) > 0 ? last.id : null,
    },
    chat.mode,
  );
  const books = createLorebooksStorage(db);
  const sourceEntries = (await books.listEntriesByLorebooks([
    selected.lorebookId.trim(),
  ])) as unknown as LorebookEntry[];
  const macros = await buildPromptMacroContext({
    db,
    chatId,
    characterIds,
    personaName: persona?.name ?? "User",
    personaDescription: cardPromptText(persona?.description),
    personaFields: persona
      ? {
          example: cardPromptText(persona.mesExample),
          personality: cardPromptText(persona.personality),
          scenario: cardPromptText(persona.scenario),
          backstory: cardPromptText(persona.backstory),
          appearance: cardPromptText(persona.appearance),
        }
      : {},
    variables: {},
    localVariables: { ...normalizeChatMacroVariables(metadata.macroVariables) },
    lastInput: [...visible].reverse().find((message) => message.role === "user")?.content,
    macroSources: [...visible.map((message) => message.content), ...sourceEntries.map((entry) => entry.content)],
  });
  const profiles = await resolveCharacterMacroData(db, characterIds, chatId);
  const whisperNames = roleplayAgentsSeeWhispers(chat.mode, metadata)
    ? new Map([
        ...(await resolveCharacterNameMap(roster, (id) => characters.getById(id))),
        [persona?.id ?? "user", persona?.name ?? "User"],
      ])
    : null;
  const messages = resolvePromptMessageMacros(
    visible.map((message) => ({
      ...message,
      characterId: message.characterId ?? undefined,
      content: roleplayAgentText(message.content, message, whisperNames),
    })),
    macros,
    profiles.profilesById,
  );
  const scanMessages = buildLorebookScanMessagesWithGenerationGuide(
    messages.map((message) => ({
      role:
        message.role === "user"
          ? ("user" as const)
          : message.role === "system"
            ? ("system" as const)
            : ("assistant" as const),
      content: message.content,
    })),
    replay ?? {},
    (value) => resolveMacros(value, macros, { trimResult: false }),
  );
  const config = await createAgentsStorage(db).getByType(packageId);
  const settings = parseExtra(config?.settings);
  let embeddingSource: Awaited<ReturnType<typeof resolveMemoryRecallEmbeddingSource>> | null = null;
  let vectorizerAvailable = false;
  try {
    embeddingSource = await resolveMemoryRecallEmbeddingSource(db, {
      chatMetadata: metadata,
      connectionId: chat.connectionId,
    });
    vectorizerAvailable =
      embeddingSource !== null ||
      (await isMemoryRecallVectorizerAvailable(db, { chatMetadata: metadata, connectionId: chat.connectionId }));
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(error, "[capability] Embedding source unavailable for agent %s; using keyword matching", packageId);
  }
  const snapshot = await createGameStateStorage(db).getLatestCommitted(chatId);
  const resolved = await createAgentLorebookTriggerResolver({
    agents: [
      {
        id: packageId,
        contextSize: normalizeAgentContextSize(settings.contextSize),
        source: "manual",
        sourceLorebookIds: [selected.lorebookId.trim()],
      },
    ],
    activeCharacterIds: characterIds,
    activeCharacterTags: [...tags],
    embeddingSource,
    entryStateOverrides:
      (metadata.entryStateOverrides as Record<string, { enabled?: boolean; ephemeral?: number | null }>) ?? {},
    filterSourceLorebookIds: async (ids) => ids,
    gameState: snapshot ? { ...parseGameStateRow(snapshot) } : null,
    generationTriggers,
    listEntriesByLorebookIds: async (ids) =>
      sourceEntries.filter((entry) => ids.includes(entry.lorebookId)) as LorebookEntry[],
    listLorebooks: async () => (await books.list()) as unknown as Lorebook[],
    resolveContent: (value) => resolveMacros(value, macros, { trimResult: false }),
    tokenBudget: resolveLorebookTokenBudget(metadata),
    vectorizerAvailable,
    signal,
  })(scanMessages);
  signal?.throwIfAborted();
  return (resolved[packageId] ?? []).map(({ id, name, content }) => ({ id, name, content }));
}
