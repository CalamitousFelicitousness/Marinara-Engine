// ──────────────────────────────────────────────
// Zustand Store: Multiswipe candidate progress
// ──────────────────────────────────────────────
// Transient only. Which message still needs finalizing is derived from the
// persisted swipe extra instead, so it survives a reload.
import { create } from "zustand";

export interface MultiSwipeProgress {
  messageId: string;
  /** Candidate ordinal currently generating or just finished (2..total). */
  current: number;
  total: number;
  status: "generating" | "saved" | "failed";
  /** Candidates that produced nothing usable, surfaced after the run. */
  failed: number;
}

interface MultiSwipeStore {
  progressByChatId: Record<string, MultiSwipeProgress | undefined>;
  setProgress: (chatId: string, progress: Omit<MultiSwipeProgress, "failed">) => void;
  clearProgress: (chatId: string) => void;
}

export const useMultiSwipeStore = create<MultiSwipeStore>((set) => ({
  progressByChatId: {},
  setProgress: (chatId, progress) =>
    set((state) => {
      const previous = state.progressByChatId[chatId];
      const failedBefore = previous?.messageId === progress.messageId ? previous.failed : 0;
      return {
        progressByChatId: {
          ...state.progressByChatId,
          [chatId]: { ...progress, failed: progress.status === "failed" ? failedBefore + 1 : failedBefore },
        },
      };
    }),
  clearProgress: (chatId) =>
    set((state) => {
      if (!state.progressByChatId[chatId]) return state;
      const next = { ...state.progressByChatId };
      delete next[chatId];
      return { progressByChatId: next };
    }),
}));
