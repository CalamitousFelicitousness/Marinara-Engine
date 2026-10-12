// ──────────────────────────────────────────────
// Lorebook Reader: read the chat's lorebook entries without leaving it
//
// A chat control window (a bubble on a computer, a Chat tools sheet on a phone) that
// shows only when the chat uses a lorebook. It is read-only: macros are replaced for
// display, and "Open in editor" hands over to the lorebook editor for changes. Pins
// are saved with the chat as a view-only metadata key.
// ──────────────────────────────────────────────
import { memo, useCallback, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookMarked, BookOpen, ChevronLeft, ChevronRight, Pin, PinOff, Search, SquarePen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { Chat } from "@marinara-engine/shared";
import {
  useDisabledFolderIdsAcrossLorebooks,
  useEntriesAcrossLorebooks,
  useLorebooks,
} from "../../hooks/use-lorebooks";
import { chatKeys, useUpdateChatMetadata } from "../../hooks/use-chats";
import { parseChatMetadata } from "../../lib/chat-display";
import { useMessagePresetVariables } from "../../hooks/use-message-preset-variables";
import {
  deriveActiveLorebookViews,
  getChatActiveLorebookIds,
  getChatExcludedLorebookIds,
} from "../../lib/chat-lorebooks";
import {
  LOREBOOK_PINNED_ENTRY_IDS_KEY,
  buildLorebookReaderEntries,
  createLorebookReaderDisplay,
  groupLorebookReaderEntries,
  readLorebookPinnedEntryIds,
  toggleLorebookPinnedEntry,
  type LorebookReaderEntry,
} from "../../lib/lorebook-reader";
import { applyInlineMarkdown, renderMarkdownBlocks } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui.store";
import { NEUTRAL_PANEL_SCROLL_AREA } from "../ui/neutral-surface-styles";
import { CHAT_CONTROL_WINDOW_IDS, ChatControlWindow } from "./ChatControlWindow";
import type { CharacterMap, PersonaInfo } from "./chat-area.types";

const ICON_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--marinara-chat-chrome-panel-muted)] transition-colors hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] hover:text-[var(--marinara-chat-chrome-button-text-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]";
const SECTION_TITLE =
  "flex items-center gap-1.5 px-1 pb-1 pt-2 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--marinara-chat-chrome-panel-muted)]";

interface LorebookReaderWindowProps {
  chat: Pick<Chat, "id" | "characterIds" | "personaId" | "metadata">;
  chatMeta: Record<string, unknown>;
  characterMap: CharacterMap;
  chatCharIds: string[];
  personaInfo?: PersonaInfo;
  /** Its bubble's place in the default row, counted from the right. */
  slot: number;
  /** Its bubble's place in the phone row (`slot` otherwise). */
  phoneSlot?: number;
}

/** The Lorebook Reader control window; renders nothing while the chat has no lorebook. */
export function LorebookReaderWindow({
  chat,
  chatMeta,
  characterMap,
  chatCharIds,
  personaInfo,
  slot,
  phoneSlot,
}: LorebookReaderWindowProps) {
  const { t } = useTranslation();
  const { data: allLorebooks } = useLorebooks(undefined, { includeHidden: true });
  const lorebooks = useMemo(
    () =>
      deriveActiveLorebookViews({
        activeLorebookIds: getChatActiveLorebookIds(chat),
        excludedLorebookIds: getChatExcludedLorebookIds(chat),
        dropExcluded: true,
        chat,
        lorebooks: allLorebooks ?? [],
      }),
    [allLorebooks, chat],
  );
  if (lorebooks.length === 0) return null;
  return (
    <ChatControlWindow
      id={CHAT_CONTROL_WINDOW_IDS.lorebookReader}
      title={t("chat.lorebookReader.title")}
      icon={<BookMarked size={14} />}
      slot={slot}
      phoneSlot={phoneSlot}
      width={340}
      height={460}
      helpTarget="lorebook-reader"
      scroll={false}
    >
      <LorebookReader
        chatId={chat.id}
        chatMeta={chatMeta}
        lorebooks={lorebooks}
        characterMap={characterMap}
        chatCharIds={chatCharIds}
        personaInfo={personaInfo}
      />
    </ChatControlWindow>
  );
}

function LorebookReader({
  chatId,
  chatMeta,
  lorebooks,
  characterMap,
  chatCharIds,
  personaInfo,
}: {
  chatId: string;
  chatMeta: Record<string, unknown>;
  lorebooks: ReadonlyArray<{ id: string; name: string }>;
  characterMap: CharacterMap;
  chatCharIds: string[];
  personaInfo?: PersonaInfo;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const lorebookIds = useMemo(() => lorebooks.map((lorebook) => lorebook.id), [lorebooks]);
  const {
    entries: rawEntries,
    isLoading: entriesLoading,
    isError: entriesError,
  } = useEntriesAcrossLorebooks(lorebookIds);
  const {
    disabledFolderIds,
    isLoading: foldersLoading,
    isError: foldersError,
  } = useDisabledFolderIdsAcrossLorebooks(lorebookIds);
  const isLoading = entriesLoading || foldersLoading;
  // Without its folders, an entry in a switched-off folder would wrongly show as on.
  const isError = entriesError || foldersError;
  const randomSeed = `lorebook-reader:${chatId}`;
  const presetVariables = useMessagePresetVariables(randomSeed);
  const updateMeta = useUpdateChatMetadata({ serialize: true });
  const [query, setQuery] = useState("");
  const shownQuery = useDeferredValue(query);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listScrollTop = useRef(0);
  const returnFocusId = useRef<string | null>(null);

  // Macros read as they do in this chat's messages, with the same fallback names (display only; entries are
  // never changed). Kept as text so a chat update that leaves these values alone, such as a pin or a reply,
  // keeps the display and its per-entry results.
  const characters = chatCharIds.flatMap((id) => {
    const character = characterMap.get(id);
    return character
      ? [
          {
            id,
            name: character.name,
            description: character.description,
            personality: character.personality,
            backstory: character.backstory,
            appearance: character.appearance,
            scenario: character.scenario,
            example: character.example,
          },
        ]
      : [];
  });
  const userName = personaInfo?.name ?? "You";
  const fallbackCharacter = { name: "Assistant" };
  const macrosJson = JSON.stringify({
    userName,
    persona: {
      name: userName,
      description: personaInfo?.description,
      personality: personaInfo?.personality,
      backstory: personaInfo?.backstory,
      appearance: personaInfo?.appearance,
      scenario: personaInfo?.scenario,
    },
    primaryCharacter: characters[0] ?? fallbackCharacter,
    characters: characters.length > 0 ? characters : [fallbackCharacter],
    variables: presetVariables,
  });
  const display = useMemo(
    () => createLorebookReaderDisplay(JSON.parse(macrosJson), randomSeed),
    [macrosJson, randomSeed],
  );
  const entryStateOverrides = chatMeta.entryStateOverrides as
    Record<string, { enabled?: boolean } | undefined> | undefined;
  const entries = useMemo(
    () =>
      buildLorebookReaderEntries({
        lorebooks,
        entries: rawEntries ?? [],
        entryStateOverrides,
        disabledFolderIds,
        display,
      }),
    [disabledFolderIds, display, entryStateOverrides, lorebooks, rawEntries],
  );
  const pinnedIds = useMemo(() => readLorebookPinnedEntryIds(chatMeta), [chatMeta]);
  const list = useMemo(
    () => groupLorebookReaderEntries(entries, pinnedIds, shownQuery),
    [entries, pinnedIds, shownQuery],
  );
  const openEntry = openEntryId ? entries.find((entry) => entry.id === openEntryId) : undefined;
  const showingEntry = !!openEntry;

  // Opening an entry focuses Back; Back returns to the list where it was, with that entry focused.
  useLayoutEffect(() => {
    if (showingEntry) {
      backRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!listRef.current) return;
    listRef.current.scrollTop = listScrollTop.current;
    const id = returnFocusId.current;
    returnFocusId.current = null;
    if (!id) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-lorebook-reader-entry="${CSS.escape(id)}"]`);
    row?.focus({ preventScroll: true });
    // Pinning or unpinning moves the entry, so make sure it is still in view.
    row?.scrollIntoView({ block: "nearest" });
  }, [showingEntry]);

  const open = useCallback((id: string) => {
    listScrollTop.current = listRef.current?.scrollTop ?? 0;
    setOpenEntryId(id);
  }, []);
  const back = () => {
    returnFocusId.current = openEntryId;
    setOpenEntryId(null);
  };
  const togglePin = (id: string) => {
    // The cache already holds a pin made a moment ago, even before this view shows it.
    const cached = qc.getQueryData<Chat>(chatKeys.detail(chatId));
    const current = cached ? readLorebookPinnedEntryIds(parseChatMetadata(cached.metadata)) : pinnedIds;
    updateMeta.mutate({ id: chatId, [LOREBOOK_PINNED_ENTRY_IDS_KEY]: toggleLorebookPinnedEntry(current, id) });
  };

  if (openEntry) {
    const pinned = pinnedIds.includes(openEntry.id);
    const pinLabel = pinned ? t("chat.lorebookReader.unpin") : t("chat.lorebookReader.pin");
    return (
      <div data-lorebook-reader="entry" className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--marinara-chat-chrome-panel-divider)] px-2 py-2">
          <button
            ref={backRef}
            type="button"
            onClick={back}
            className={ICON_BUTTON}
            title={t("chat.lorebookReader.back")}
            aria-label={t("chat.lorebookReader.back")}
          >
            <ChevronLeft size="1rem" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
              {openEntry.name || t("chat.lorebookReader.untitled")}
            </p>
            <p className="truncate text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)]">
              {openEntry.lorebookName}
            </p>
          </div>
          {openEntry.off && <OffLabel />}
          <button
            type="button"
            onClick={() => togglePin(openEntry.id)}
            className={ICON_BUTTON}
            title={pinLabel}
            aria-label={pinLabel}
            aria-pressed={pinned}
          >
            {pinned ? <PinOff size="0.875rem" /> : <Pin size="0.875rem" />}
          </button>
          <button
            type="button"
            onClick={() =>
              useUIStore
                .getState()
                .openLorebookDetail(openEntry.lorebookId, { initialTab: "entries", entryId: openEntry.id })
            }
            className={ICON_BUTTON}
            title={t("chat.lorebookReader.openInEditor")}
            aria-label={t("chat.lorebookReader.openInEditor")}
          >
            <SquarePen size="0.875rem" />
          </button>
        </div>
        <div className={cn(NEUTRAL_PANEL_SCROLL_AREA, "min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5")}>
          {openEntry.content.trim() ? (
            <div className="mari-message-content w-full whitespace-pre-wrap text-sm leading-6 text-[var(--marinara-chat-chrome-panel-text)]">
              {renderMarkdownBlocks(openEntry.content, applyInlineMarkdown, "lorebook-reader")}
            </div>
          ) : (
            <p className="text-xs text-[var(--marinara-chat-chrome-panel-muted)]">
              {t("chat.lorebookReader.noContent")}
            </p>
          )}
        </div>
      </div>
    );
  }

  const empty = list.pinned.length === 0 && list.groups.length === 0;
  return (
    <div data-lorebook-reader="list" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-1 pt-2">
        <label className="relative block">
          <Search
            size="0.75rem"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--marinara-chat-chrome-panel-muted)]"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("chat.lorebookReader.search")}
            aria-label={t("chat.lorebookReader.search")}
            className="mari-chrome-field w-full pl-7 pr-2.5 text-xs"
          />
        </label>
      </div>
      <div
        ref={listRef}
        className={cn(NEUTRAL_PANEL_SCROLL_AREA, "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2")}
      >
        {isLoading ? (
          <p className="px-1 py-3 text-xs text-[var(--marinara-chat-chrome-panel-muted)]">
            {t("chat.lorebookReader.loading")}
          </p>
        ) : isError ? (
          <p className="px-1 py-3 text-xs text-[var(--destructive)]">{t("chat.lorebookReader.loadError")}</p>
        ) : empty ? (
          <p className="px-1 py-3 text-xs text-[var(--marinara-chat-chrome-panel-muted)]">
            {shownQuery.trim() ? t("chat.lorebookReader.noMatches") : t("chat.lorebookReader.empty")}
          </p>
        ) : (
          <>
            {list.pinned.length > 0 && (
              <section aria-label={t("chat.lorebookReader.pinned")}>
                <h3 className={SECTION_TITLE}>
                  <Pin size="0.6875rem" />
                  {t("chat.lorebookReader.pinned")}
                </h3>
                <EntryList entries={list.pinned} showLorebook onOpen={open} />
              </section>
            )}
            {list.groups.map((group) => (
              <section key={group.id} aria-label={group.name}>
                <h3 className={SECTION_TITLE}>
                  <BookOpen size="0.6875rem" />
                  <span className="truncate">{group.name}</span>
                </h3>
                <EntryList entries={group.entries} onOpen={open} />
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function EntryList({
  entries,
  showLorebook = false,
  onOpen,
}: {
  entries: LorebookReaderEntry[];
  showLorebook?: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          id={entry.id}
          name={entry.name}
          off={entry.off}
          lorebookName={showLorebook ? entry.lorebookName : undefined}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

// Memoized on plain values, so a search keystroke or a chat update redraws only the rows that changed.
const EntryRow = memo(function EntryRow({
  id,
  name,
  off,
  lorebookName,
  onOpen,
}: {
  id: string;
  name: string;
  off: boolean;
  lorebookName?: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        data-lorebook-reader-entry={id}
        data-off={off || undefined}
        onClick={() => onOpen(id)}
        className="mari-chrome-control w-full justify-start gap-2 px-3 py-2 text-left text-xs data-[off]:opacity-60"
      >
        <span className="min-w-0 flex-1">{name || t("chat.lorebookReader.untitled")}</span>
        {off && <OffLabel />}
        {lorebookName !== undefined && (
          <span className="max-w-[40%] shrink-0 text-[0.625rem] font-normal text-[var(--marinara-chat-chrome-panel-muted)]">
            {lorebookName}
          </span>
        )}
        <ChevronRight size="0.75rem" className="shrink-0 text-[var(--marinara-chat-chrome-panel-muted)]" />
      </button>
    </li>
  );
});

function OffLabel() {
  const { t } = useTranslation();
  return (
    <span
      title={t("chat.lorebookReader.offTitle")}
      className="shrink-0 rounded border border-[var(--marinara-chat-chrome-panel-border)] px-1 text-[0.5625rem] font-semibold tracking-wide text-[var(--marinara-chat-chrome-panel-muted)]"
    >
      {t("chat.lorebookReader.off")}
    </span>
  );
}
