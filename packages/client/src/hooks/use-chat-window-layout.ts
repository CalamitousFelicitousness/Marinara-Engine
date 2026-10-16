// ──────────────────────────────────────────────
// Per-chat window layout
//
// Each chat keeps its own window layout (places, sizes, pinned and locked state,
// popped-out drawers, phone bubble places) in `chat.metadata.windowLayout`, so chat settings profiles
// save and apply it with the rest of the chat's settings. This hook loads the open
// chat's layout into the window store and saves the user's changes back.
//
// With the shared-layout setting on, every chat of a mode loads and saves one layout kept in
// app settings instead (`chat-window-shared-<mode>`); each chat's own layout stays as it was.
// ──────────────────────────────────────────────
import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getChatWindowSharedLayoutSettingsKey, type Chat, type ChatMode } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { readChatMetadata } from "../lib/chat-wizard-defaults";
import { getLegacyChatWindowLayout } from "../lib/chat-window-migration";
import {
  isEmptyWindowLayoutSnapshot,
  serializeWindowLayoutSnapshot,
  type WindowLayoutSnapshot,
} from "../lib/floating-window-layout";
import { selectWindowLayoutSnapshot, useFloatingWindowStore } from "../stores/floating-window.store";
import { useUIStore } from "../stores/ui.store";
import { useUpdateChatMetadata } from "./use-chats";

/** Moves and resizes come in bursts; save once the user stops. */
const SAVE_DELAY_MS = 400;
const EMPTY_LAYOUT = serializeWindowLayoutSnapshot(null);
const SHARED_TARGET_PREFIX = "shared:";

export const sharedChatWindowLayoutKey = (mode: ChatMode) => ["chat-window-shared", mode] as const;

/** The layout the window store shows now, as the chat stores it (none when it is all defaults). */
export function readCurrentWindowLayout(): WindowLayoutSnapshot | null {
  const snapshot = selectWindowLayoutSnapshot(useFloatingWindowStore.getState());
  return isEmptyWindowLayoutSnapshot(snapshot) ? null : snapshot;
}

/** A mode's shared layout as saved (`null` when none has been saved yet). */
function useSharedChatWindowLayout(mode: ChatMode | null) {
  return useQuery({
    queryKey: sharedChatWindowLayoutKey(mode ?? "roleplay"),
    queryFn: async () => {
      const { value } = await api.get<{ value: string | null }>(
        `/app-settings/${getChatWindowSharedLayoutSettingsKey(mode!)}`,
      );
      return value ? (JSON.parse(value) as WindowLayoutSnapshot | null) : null;
    },
    enabled: mode !== null,
    staleTime: Infinity,
  });
}

/**
 * Keeps the window store in step with the open chat (`null` when closed, `undefined` while loading): its saved layout
 * replaces the previous chat's when it opens or changes elsewhere (a profile applied, another tab),
 * and the user's changes save to it after a short pause. Bad or old saved data loads as the defaults.
 */
export function useChatWindowLayout(chat: Chat | null | undefined) {
  // Queued with the chat's other settings saves, so an older layout can never land after a newer one.
  const updateMeta = useUpdateChatMetadata({ serialize: true });
  const mutateRef = useRef(updateMeta.mutate);
  mutateRef.current = updateMeta.mutate;
  const queryClient = useQueryClient();
  const chatId = chat?.id ?? null;
  const metadata = chat ? readChatMetadata(chat) : {};
  // Multiplayer chats have their own controls, so they always keep their own layout.
  const sharedMode =
    useUIStore((state) => state.sharedChatWindowLayout) &&
    chat &&
    !metadata.multiplayer &&
    metadata.multiplayerSetup !== true
      ? chat.mode
      : null;
  const shared = useSharedChatWindowLayout(sharedMode);
  const loading = chat === undefined || (sharedMode !== null && shared.isPending);
  const legacyLayout = chat ? getLegacyChatWindowLayout(chat.mode, metadata) : null;
  const chatLayout = chat ? serializeWindowLayoutSnapshot(legacyLayout ?? metadata.windowLayout) : EMPTY_LAYOUT;
  // Until a shared layout is saved, the open chat's own layout is where it starts.
  const savedLayout = sharedMode !== null && shared.data ? serializeWindowLayoutSnapshot(shared.data) : chatLayout;
  const target = sharedMode !== null ? `${SHARED_TARGET_PREFIX}${sharedMode}` : chatId;
  // Where the store's layout saves (a chat id or a shared mode), and that layout as last loaded or saved.
  const syncedRef = useRef<{ target: string | null; layout: string }>({ target: null, layout: EMPTY_LAYOUT });
  const pendingRef = useRef<{ target: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Shared saves go out one at a time, so an older layout can never land after a newer one.
  const sharedSaveRef = useRef<Promise<unknown>>(Promise.resolve());

  const save = (saveTarget: string) => {
    const layout = readCurrentWindowLayout();
    syncedRef.current = { target: saveTarget, layout: serializeWindowLayoutSnapshot(layout) };
    if (!saveTarget.startsWith(SHARED_TARGET_PREFIX)) {
      mutateRef.current({ id: saveTarget, windowLayout: layout });
      return;
    }
    const mode = saveTarget.slice(SHARED_TARGET_PREFIX.length) as ChatMode;
    queryClient.setQueryData(sharedChatWindowLayoutKey(mode), layout);
    sharedSaveRef.current = sharedSaveRef.current
      .catch(() => undefined)
      .then(() =>
        api.put(`/app-settings/${getChatWindowSharedLayoutSettingsKey(mode)}`, { value: JSON.stringify(layout) }),
      );
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const flushPendingSave = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
    saveRef.current(pending.target);
  };
  const flushRef = useRef(flushPendingSave);
  flushRef.current = flushPendingSave;

  // Load before paint, so a chat's windows never flash in the previous chat's places.
  useLayoutEffect(() => {
    // A query's loading gap is not a closed chat. Keep its layout until the next chat is ready, so
    // pinned windows stay open and a pending move is saved to the chat that owns it.
    if (loading) return;
    const synced = syncedRef.current;
    if (synced.target === target && synced.layout === savedLayout) return;
    if (synced.target !== target) flushRef.current();
    else if (pendingRef.current) {
      // The same layout changed elsewhere (a profile applied, another tab): that layout wins.
      clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
    }
    syncedRef.current = { target, layout: savedLayout };
    useFloatingWindowStore.getState().hydrate(savedLayout === EMPTY_LAYOUT ? null : JSON.parse(savedLayout));
  }, [target, savedLayout, loading]);

  // An older chat's toolbar tools become its saved layout once, whichever layout is showing.
  const legacyLayoutJson = legacyLayout ? JSON.stringify(legacyLayout) : null;
  useEffect(() => {
    if (!legacyLayoutJson || !chatId) return;
    // Persist through the same queue as later moves/docking. View-only metadata keeps chat recency intact.
    mutateRef.current({ id: chatId, windowLayout: JSON.parse(legacyLayoutJson) });
  }, [chatId, legacyLayoutJson]);

  // Save the user's changes to the layout they changed.
  useEffect(() => {
    const unsubscribe = useFloatingWindowStore.subscribe((state, previous) => {
      if (
        state.layouts === previous.layouts &&
        state.detached === previous.detached &&
        state.phoneBubbles === previous.phoneBubbles &&
        state.bubbles === previous.bubbles &&
        state.phoneMenu === previous.phoneMenu
      ) {
        return;
      }
      const { target: syncedTarget, layout } = syncedRef.current;
      if (!syncedTarget) return;
      if (serializeWindowLayoutSnapshot(selectWindowLayoutSnapshot(state)) === layout) {
        // Back to what the layout already is (a hydrate, or a change undone): nothing to save.
        if (pendingRef.current) clearTimeout(pendingRef.current.timer);
        pendingRef.current = null;
        return;
      }
      if (pendingRef.current) clearTimeout(pendingRef.current.timer);
      pendingRef.current = {
        target: syncedTarget,
        timer: setTimeout(() => {
          pendingRef.current = null;
          saveRef.current(syncedTarget);
        }, SAVE_DELAY_MS),
      };
    });
    return () => {
      unsubscribe();
      // Leaving the chat view keeps the last change.
      flushRef.current();
      syncedRef.current = { target: null, layout: EMPTY_LAYOUT };
    };
  }, []);
}
