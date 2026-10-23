// ──────────────────────────────────────────────
// Zustand Store: Combat Screen Slice
// ──────────────────────────────────────────────
// Whether a fight is on screen: the fight screen sets `round` while it is mounted and clears it when
// it goes, so the sheet settles and the accent stops cycling only then. The tactical board says only
// that it is showing.
import { create } from "zustand";

interface CombatScreenState {
  /** The round of the fight on screen, or null when no fight is showing. */
  round: number | null;
  /** A tactical board is showing a fight. */
  tacticalShowing: boolean;
  setRound: (round: number | null) => void;
  setTacticalShowing: (showing: boolean) => void;
}

export const useCombatScreenStore = create<CombatScreenState>((set) => ({
  round: null,
  tacticalShowing: false,
  setRound: (round) => set({ round }),
  setTacticalShowing: (tacticalShowing) => set({ tacticalShowing }),
}));
