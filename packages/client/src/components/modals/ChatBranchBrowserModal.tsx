// ──────────────────────────────────────────────
// Branch browser: read any branch of a chat without switching to it
// ──────────────────────────────────────────────
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, GitBranch, Loader2, MessageSquare } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { Message } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { ChatBranchTail, formatBranchDate } from "../chat/ChatBranchTail";
import { useCharacterSummaries } from "../../hooks/use-characters";
import { useChat, useChatGroup, useChatMessageCount, useChatTranscriptPreview } from "../../hooks/use-chats";
import { getChatDisplayName, parseChatMetadata } from "../../lib/chat-display";
import { orderBranches, previewSpeakerName, visibleBranchMessages } from "../../lib/chat-branch-preview";
import { applyInlineMarkdown, renderMarkdownBlocks } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat.store";

const TRANSCRIPT_PAGE_SIZE = 30;

interface ChatBranchBrowserModalProps {
  open: boolean;
  onClose: () => void;
  groupId: string | null;
  initialBranchId: string | null;
  /** Narrow screens open on the transcript instead of the list. */
  startInPreview?: boolean;
}

export function ChatBranchBrowserModal({
  open,
  onClose,
  groupId,
  initialBranchId,
  startInPreview = false,
}: ChatBranchBrowserModalProps) {
  const { t: localizeUi } = useUiTranslation();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const setActiveChatId = useChatStore((s) => s.setActiveChatId);
  const { data: groupChats, isLoading } = useChatGroup(groupId);
  const { data: activeChat } = useChat(groupId ? null : activeChatId);
  const [selectedId, setSelectedId] = useState<string | null>(initialBranchId ?? activeChatId);
  const [mobilePane, setMobilePane] = useState<"list" | "transcript">(startInPreview ? "transcript" : "list");

  const branches = useMemo(() => {
    const rows = groupChats?.length ? groupChats : activeChat ? [activeChat] : [];
    return orderBranches(rows, activeChatId);
  }, [activeChat, activeChatId, groupChats]);
  const selected = branches.find((branch) => branch.id === selectedId) ?? branches[0] ?? null;
  const selectedMeta = parseChatMetadata(selected?.metadata);
  const parentBranch =
    typeof selectedMeta.branchParentChatId === "string"
      ? branches.find((branch) => branch.id === selectedMeta.branchParentChatId)
      : undefined;
  const { data: selectedCount } = useChatMessageCount(selected?.id ?? null);

  const switchTo = (branchId: string) => {
    if (branchId !== activeChatId) setActiveChatId(branchId);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={localizeUi("ui.chat.chatbranchselector.chatBranches")}
      width="max-w-5xl"
      mobileFullscreen
      panelClassName="sm:h-[min(88dvh,52rem)]"
    >
      <div className="flex h-full min-h-0 gap-4">
        <nav
          aria-label={localizeUi("ui.chat.chatbranchselector.chatBranches")}
          className={cn(
            "flex min-h-0 w-full flex-col gap-1 overflow-y-auto sm:w-72 sm:shrink-0 sm:border-r sm:border-[var(--border)] sm:pr-3",
            mobilePane === "transcript" && "max-sm:hidden",
          )}
        >
          {isLoading && <Loader2 size="1rem" className="mx-auto my-6 animate-spin text-[var(--muted-foreground)]" />}
          {branches.map((branch) => {
            const isActive = branch.id === activeChatId;
            const isSelected = branch.id === selected?.id;
            return (
              <button
                key={branch.id}
                type="button"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => {
                  setSelectedId(branch.id);
                  setMobilePane("transcript");
                }}
                onDoubleClick={() => switchTo(branch.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                  isSelected ? "bg-[var(--accent)]/70" : "hover:bg-[var(--accent)]/45",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                    isActive
                      ? "bg-[var(--foreground)]/15 text-[var(--foreground)]"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)]",
                  )}
                >
                  {isActive ? <Check size="0.75rem" /> : <MessageSquare size="0.75rem" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-medium text-[var(--foreground)]">
                    {getChatDisplayName(branch)}
                  </span>
                  <ChatBranchTail chatId={branch.id} updatedAt={branch.updatedAt} lines={2} />
                </span>
              </button>
            );
          })}
        </nav>

        <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col", mobilePane === "list" && "max-sm:hidden")}>
          {selected && (
            <>
              <header className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] pb-2">
                <button
                  type="button"
                  onClick={() => setMobilePane("list")}
                  aria-label={localizeUi("chat.branches.backToList")}
                  className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] sm:hidden"
                >
                  <ArrowLeft size="0.875rem" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--foreground)]">
                    {getChatDisplayName(selected)}
                  </div>
                  <div className="truncate text-[0.6875rem] text-[var(--muted-foreground)]">
                    {localizeUi("chat.branches.updatedAt", { date: formatBranchDate(selected.updatedAt) })}
                    {typeof selectedCount?.count === "number" && (
                      <> · {localizeUi("chat.branches.messageCount", { count: selectedCount.count })}</>
                    )}
                    {parentBranch && (
                      <> · {localizeUi("chat.branches.branchedFrom", { name: getChatDisplayName(parentBranch) })}</>
                    )}
                  </div>
                </div>
              </header>

              <BranchTranscript
                key={selected.id}
                chatId={selected.id}
                forkMessageId={typeof selectedMeta.branchMessageId === "string" ? selectedMeta.branchMessageId : null}
              />

              <footer className="flex shrink-0 justify-end border-t border-[var(--border)] pt-3">
                {selected.id === activeChatId ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-[var(--muted-foreground)]">
                    <Check size="0.75rem" />
                    {localizeUi("chat.branches.current")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => switchTo(selected.id)}
                    className="mari-chrome-control mari-chrome-control--primary px-4 py-2 text-xs max-sm:w-full"
                  >
                    <GitBranch size="0.75rem" />
                    {localizeUi("chat.branches.switchToBranch")}
                  </button>
                )}
              </footer>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

function BranchTranscript({ chatId, forkMessageId }: { chatId: string; forkMessageId: string | null }) {
  const { t: localizeUi } = useUiTranslation();
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useChatTranscriptPreview(
    chatId,
    TRANSCRIPT_PAGE_SIZE,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Pages arrive newest first, each oldest first.
  const { rows, forkAfterId } = useMemo(() => {
    const seen = new Set<string>();
    const ordered: Message[] = [];
    for (const page of [...(data?.pages ?? [])].reverse()) {
      for (const message of page) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        ordered.push(message);
      }
    }
    const visible = visibleBranchMessages(ordered);
    // The divider follows the last visible message at or before the fork, which may itself be hidden.
    const forkIndex = forkMessageId ? ordered.findIndex((message) => message.id === forkMessageId) : -1;
    const positions = new Map(ordered.map((message, index) => [message.id, index]));
    const beforeFork = forkIndex < 0 ? [] : visible.filter((message) => positions.get(message.id)! <= forkIndex);
    return { rows: visible, forkAfterId: beforeFork[beforeFork.length - 1]?.id ?? null };
  }, [data, forkMessageId]);

  const characterIds = useMemo(
    () => rows.flatMap((message) => (message.characterId ? [message.characterId] : [])),
    [rows],
  );
  const { data: summaries } = useCharacterSummaries(characterIds);
  const characterNames = useMemo(() => new Map((summaries ?? []).map((row) => [row.id, row.name])), [summaries]);

  // Re-armed after every page so a short transcript keeps loading until it overflows.
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      { root, rootMargin: "320px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, rows.length]);

  const speakerFor = (message: Message) =>
    previewSpeakerName(message, characterNames) ??
    (message.role === "user"
      ? localizeUi("chat.branches.speakerYou")
      : message.role === "assistant"
        ? localizeUi("chat.branches.speakerCharacter")
        : localizeUi("chat.branches.speakerNarrator"));

  return (
    // column-reverse opens at the newest message and keeps the reader's place when older pages prepend.
    <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain py-3">
      <div className="flex flex-col gap-2.5 pr-1">
        <div ref={sentinelRef} className="flex justify-center text-[0.6875rem] text-[var(--muted-foreground)]">
          {isLoading || isFetchingNextPage ? (
            <Loader2 size="0.875rem" className="animate-spin" />
          ) : isError ? (
            localizeUi("chat.branches.previewFailed")
          ) : !hasNextPage && rows.length > 0 ? (
            localizeUi("chat.branches.startOfChat")
          ) : null}
        </div>
        {!isLoading && !isError && rows.length === 0 && (
          <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">
            {localizeUi("chat.branches.noMessages")}
          </p>
        )}
        {rows.map((message) => (
          <div key={message.id} className="flex flex-col gap-2.5">
            <PreviewMessage message={message} speaker={speakerFor(message)} />
            {message.id === forkAfterId && (
              <div
                role="separator"
                className="flex items-center gap-2 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--primary)]"
              >
                <span className="h-px flex-1 bg-[var(--primary)]/40" />
                <GitBranch size="0.75rem" />
                {localizeUi("chat.branches.branchedHere")}
                <span className="h-px flex-1 bg-[var(--primary)]/40" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const PreviewMessage = memo(function PreviewMessage({ message, speaker }: { message: Message; speaker: string }) {
  const rendered = useMemo(
    () => renderMarkdownBlocks(message.content, applyInlineMarkdown, `branch-preview-${message.id}`),
    [message.content, message.id],
  );
  return (
    <article
      className={cn(
        "rounded-xl px-3 py-2",
        message.role === "user" && "bg-[var(--secondary)]/70 ring-1 ring-[var(--border)]",
      )}
    >
      <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {speaker}
      </div>
      <div className="mari-message-content whitespace-pre-wrap break-words text-[0.8125rem] leading-relaxed text-[var(--foreground)]">
        {rendered}
      </div>
    </article>
  );
});
