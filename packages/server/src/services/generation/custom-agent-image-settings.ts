import { BUILT_IN_AGENTS } from "@marinara-engine/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCustomAgentImageSettings(
  agentType: string,
  chatMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  // Built-in agents keep their own dedicated chat-level override keys
  // (illustratorImageConnectionId, gameImageConnectionId, ...); this map is
  // custom-agent-only (#4682).
  if (BUILT_IN_AGENTS.some((agent) => agent.id === agentType)) return null;
  const overrides = chatMetadata?.customAgentImageSettings;
  if (!isRecord(overrides)) return null;
  const settings = overrides[agentType];
  return isRecord(settings) ? settings : null;
}

/**
 * Apply this chat's per-agent image overrides to a custom image agent's
 * resolved settings, mirroring applyKnowledgeAgentChatSettings. An empty or
 * missing entry leaves the agent's own configuration untouched, so "Agent
 * default" in the chat drawer behaves like no override at all.
 */
export function applyCustomAgentImageChatSettings(
  agentType: string,
  settings: Record<string, unknown>,
  chatMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const override = readCustomAgentImageSettings(agentType, chatMetadata);
  if (!override) return settings;

  const next = { ...settings };
  if (typeof override.imageConnectionId === "string" && override.imageConnectionId.trim()) {
    next.imageConnectionId = override.imageConnectionId;
  }
  return next;
}
