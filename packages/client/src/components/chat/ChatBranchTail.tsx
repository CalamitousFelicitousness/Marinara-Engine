// ──────────────────────────────────────────────
// Branch row summary: activity, size, and the newest line of the branch
// ──────────────────────────────────────────────
import { useMemo } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useCharacterSummaries } from "../../hooks/use-characters";
import { useChatMessageCount, useChatMessagePeek } from "../../hooks/use-chats";
import { pickBranchSnippet, previewSpeakerName } from "../../lib/chat-branch-preview";
import { cn } from "../../lib/utils";

/** Matches the sidebar hover peek, so both read one cached window per chat. */
const BRANCH_TAIL_MESSAGE_COUNT = 4;

export function formatBranchDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ChatBranchTailProps {
  chatId: string;
  updatedAt: string;
  /** Snippet line clamp: 1 in the popover, 2 in the browser list. */
  lines?: 1 | 2;
  className?: string;
}

export function ChatBranchTail({ chatId, updatedAt, lines = 1, className }: ChatBranchTailProps) {
  const { t: localizeUi } = useUiTranslation();
  const { data: tail, isLoading } = useChatMessagePeek(chatId, BRANCH_TAIL_MESSAGE_COUNT, true);
  const { data: count } = useChatMessageCount(chatId);
  const snippet = useMemo(() => pickBranchSnippet(tail ?? []), [tail]);
  const { data: summaries } = useCharacterSummaries(snippet?.characterId ? [snippet.characterId] : []);
  const speaker = snippet
    ? (previewSpeakerName(snippet, new Map((summaries ?? []).map((row) => [row.id, row.name]))) ??
      (snippet.role === "user" ? localizeUi("chat.branches.speakerYou") : null))
    : null;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[0.625rem] text-[var(--muted-foreground)]">
        {formatBranchDate(updatedAt)}
        {typeof count?.count === "number" && <> · {localizeUi("chat.branches.messageCount", { count: count.count })}</>}
      </div>
      <p
        className={cn(
          "break-words text-[0.6875rem] leading-snug text-[var(--foreground)]/75",
          lines === 1 ? "line-clamp-1" : "line-clamp-2",
        )}
      >
        {isLoading ? (
          <span className="text-[var(--muted-foreground)]">{localizeUi("ui.layout.chatsidebar.loading")}</span>
        ) : snippet ? (
          <>
            {speaker && <span className="font-medium text-[var(--foreground)]">{speaker}: </span>}
            {snippet.content}
          </>
        ) : (
          <span className="text-[var(--muted-foreground)]">{localizeUi("chat.branches.noMessages")}</span>
        )}
      </p>
    </div>
  );
}
