import { parseMessageExtraRecord } from "./chat-message-extra";
import { isMessageHiddenFromUser } from "./chat-message-visibility";
import { compareChatsByActivityDesc } from "./chat-recency";

type BranchOrderFields = Parameters<typeof compareChatsByActivityDesc>[0] & { id: string };

/** Active branch first, then most recent activity. */
export function orderBranches<T extends BranchOrderFields>(rows: readonly T[], activeChatId: string | null): T[] {
  return [...rows].sort((left, right) => {
    if (left.id === activeChatId) return -1;
    if (right.id === activeChatId) return 1;
    return compareChatsByActivityDesc(left, right);
  });
}

interface BranchPreviewMessage {
  id: string;
  role: string;
  characterId?: string | null;
  content: string;
  extra?: unknown;
}

/** Messages a reader would see in the transcript, in their original order. */
export function visibleBranchMessages<T extends BranchPreviewMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isMessageHiddenFromUser(message) && message.content.trim().length > 0);
}

/** Newest visible message of `tail` (oldest first), shown as a branch's popover snippet. */
export function pickBranchSnippet<T extends BranchPreviewMessage>(tail: readonly T[]): T | null {
  const visible = visibleBranchMessages(tail);
  return visible[visible.length - 1] ?? null;
}

/** Speaker name for a preview row; null when the caller should fall back to a role label. */
export function previewSpeakerName(
  message: BranchPreviewMessage,
  characterNames: ReadonlyMap<string, string>,
): string | null {
  if (message.role === "user") {
    const persona = parseMessageExtraRecord(message.extra).personaSnapshot as { name?: unknown } | null | undefined;
    return typeof persona?.name === "string" && persona.name.trim() ? persona.name.trim() : null;
  }
  return message.characterId ? (characterNames.get(message.characterId) ?? null) : null;
}
