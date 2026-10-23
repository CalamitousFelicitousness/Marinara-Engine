// ──────────────────────────────────────────────
// Zustand Store: Combat Screen Slice
// ──────────────────────────────────────────────
// Whether a fight is on screen: the fight screen sets `round` while it is mounted and clears it when
// it goes, so the sheet settles and the accent stops cycling only then.
import { create } from "zustand";

interface CombatScreenState {
  /** The round of the fight on screen, or null when no fight is showing. */
  round: number | null;
  setRound: (round: number | null) => void;
}

export const useCombatScreenStore = create<CombatScreenState>((set) => ({
  round: null,
  setRound: (round) => set({ round }),
}));
