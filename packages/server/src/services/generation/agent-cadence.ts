import {
  normalizeIllustratorRunInterval,
  normalizeIllustratorVideoMode,
  parseAgentSettingsRecord,
} from "@marinara-engine/shared";

type AgentsStore = {
  getLastSuccessfulRunByType(agentType: string, chatId: string): Promise<{ messageId?: string | null } | null>;
};

type ChatMessageLike = {
  id?: string | null;
  role?: string | null;
};

export function resolveAgentRunInterval(settings: unknown, fallback: number): number {
  const normalizedFallback = Number.isFinite(fallback) ? Math.min(100, Math.max(1, Math.floor(fallback))) : 1;
  const source = settings && typeof settings === "object" ? (settings as { runInterval?: unknown }) : {};
  const rawInterval = source.runInterval;
  const parsed =
    typeof rawInterval === "number" ? rawInterval : typeof rawInterval === "string" ? Number(rawInterval) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(100, Math.floor(parsed)) : normalizedFallback;
}

/**
 * Illustrator settings with a Roleplay chat's Run Interval (0-100) in place of the agent's. Other agents and other
 * modes pass through: Game orders its illustrations by scenes and asset needs, not by a per-chat interval.
 * With Illustrator making clips only, every run is a clip, so the Video Run Interval paces it.
 */
export function applyIllustratorChatRunInterval(
  agentType: string,
  settings: Record<string, unknown>,
  chatMetadata: Record<string, unknown> | null | undefined,
  chatMode: unknown,
): Record<string, unknown> {
  if (agentType !== "illustrator" || chatMode !== "roleplay") return settings;
  if (normalizeIllustratorVideoMode(chatMetadata?.illustratorVideoMode) === "clips_only") {
    return { ...settings, runInterval: resolveVideoRunInterval(chatMetadata ?? {}, settings) };
  }
  const runInterval = normalizeIllustratorRunInterval(chatMetadata?.illustratorRunInterval);
  return runInterval === null ? settings : { ...settings, runInterval };
}

export async function shouldSkipAgentByMessageInterval({
  agentsStore,
  chatId,
  agentType,
  settings,
  fallbackInterval,
  messages,
  countUpcomingAssistantMessage = true,
}: {
  agentsStore: AgentsStore;
  chatId: string;
  agentType: string;
  settings: unknown;
  fallbackInterval: number;
  messages: ChatMessageLike[];
  countUpcomingAssistantMessage?: boolean;
}): Promise<boolean> {
  const rawInterval =
    settings && typeof settings === "object" ? (settings as { runInterval?: unknown }).runInterval : undefined;
  if (agentType === "illustrator" && (rawInterval === 0 || rawInterval === "0")) return true;

  const runInterval = resolveAgentRunInterval(settings, fallbackInterval);
  if (runInterval <= 1) return false;

  const lastRun = await agentsStore.getLastSuccessfulRunByType(agentType, chatId);
  if (!lastRun) return false;

  const messagesSince = countMessagesSinceAgentRun(messages, lastRun.messageId, countUpcomingAssistantMessage);
  return messagesSince !== null && messagesSince < runInterval;
}

/** Shared cadence/activation count; null means there is no usable successful-run anchor. */
export function countMessagesSinceAgentRun(
  messages: ChatMessageLike[],
  lastMessageId: string | null | undefined,
  countUpcomingAssistantMessage = false,
): number | null {
  if (!lastMessageId) return null;
  const lastRunIdx = messages.findIndex((message) => message.id === lastMessageId);
  if (lastRunIdx < 0) return null;
  const messagesSince = messages
    .slice(lastRunIdx + 1)
    .filter((message) => message.role === "user" || message.role === "assistant");
  return messagesSince.length + (countUpcomingAssistantMessage ? 1 : 0);
}

export const DEFAULT_VIDEO_RUN_INTERVAL = 5;

/**
 * Messages between videos an agent or character makes on its own: the chat's Video Run Interval, else the
 * Illustrator agent's, else 5. 0 means videos only come when the user asks (/video, the Gallery).
 */
export function resolveVideoRunInterval(chatMetadata: Record<string, unknown>, illustratorSettings: unknown): number {
  const agentSettings =
    illustratorSettings && typeof illustratorSettings === "object"
      ? (illustratorSettings as { videoRunInterval?: unknown })
      : {};
  return (
    normalizeIllustratorRunInterval(chatMetadata.illustratorVideoRunInterval) ??
    normalizeIllustratorRunInterval(agentSettings.videoRunInterval) ??
    DEFAULT_VIDEO_RUN_INTERVAL
  );
}

/**
 * Whether an automatic video may run now. Anchored on the message the last automatic video joined
 * (`lastAutomaticVideoMessageId`); with no usable anchor the first one is allowed. A new swipe of that
 * same message (`targetMessageId`) replaces the reply the clip belonged to, so it may have its own.
 */
export function automaticVideoAllowed(
  messages: ChatMessageLike[],
  chatMetadata: Record<string, unknown>,
  interval: number,
  countUpcomingAssistantMessage = false,
  targetMessageId?: string | null,
): boolean {
  if (interval <= 0) return false;
  const anchor =
    typeof chatMetadata.lastAutomaticVideoMessageId === "string" ? chatMetadata.lastAutomaticVideoMessageId : null;
  if (anchor && anchor === targetMessageId) return true;
  const since = countMessagesSinceAgentRun(messages, anchor, countUpcomingAssistantMessage);
  return since === null || since >= interval;
}

/** `resolveVideoRunInterval` with the Illustrator agent's saved settings looked up. */
export async function loadVideoRunInterval(
  agentsStore: { getByType(type: string): Promise<{ settings?: unknown } | null> },
  chatMetadata: Record<string, unknown>,
): Promise<number> {
  const agent = await agentsStore.getByType("illustrator").catch(() => null);
  return resolveVideoRunInterval(chatMetadata, parseAgentSettingsRecord(agent?.settings));
}
