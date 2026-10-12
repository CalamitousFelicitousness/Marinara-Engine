import type { MutationFilters } from "@tanstack/react-query";

export const CHAT_PRESET_APPLY_MUTATION_KEY = ["chat-presets", "apply"] as const;

/** Matches a profile being applied to this chat (see useApplyChatPreset). */
export function chatPresetApplyFilters(chatId: string): MutationFilters {
  return {
    mutationKey: CHAT_PRESET_APPLY_MUTATION_KEY,
    predicate: (mutation) => (mutation.state.variables as { chatId?: string } | undefined)?.chatId === chatId,
  };
}
