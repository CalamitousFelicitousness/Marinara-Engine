import type { AgentContext, ChatMode } from "@marinara-engine/shared";

export function applyTrackerLorebookContextPolicy(args: {
  context: AgentContext;
  chatMode: ChatMode;
  isTracker: boolean;
  attachLorebooksToTrackers: boolean;
}): AgentContext {
  if (
    args.chatMode !== "roleplay" ||
    !args.isTracker ||
    args.attachLorebooksToTrackers ||
    !args.context.activatedLorebookEntries?.length
  ) {
    return args.context;
  }

  return { ...args.context, activatedLorebookEntries: [] };
}

export function appendTrackerLorebookBatchContextKey(
  currentKey: string | undefined,
  attachLorebooksToTrackers: boolean,
): string {
  const policyKey = attachLorebooksToTrackers ? "tracker-lorebooks-on" : "tracker-lorebooks-off";
  return currentKey ? `${currentKey}|${policyKey}` : policyKey;
}
