// The user's "reads as nothing" list, as a lookup.
//
// Memoized on the stored array so the Set keeps one identity across renders --
// it is passed down the extras tree, where a new Set every render would defeat
// the card's memo boundary.

import { useMemo } from "react";
import { normalizeTrackerBlankValues } from "@marinara-engine/shared";
import { useUIStore } from "../../../stores/ui.store";

export function useTrackerBlankValues(): ReadonlySet<string> {
  const values = useUIStore((state) => state.trackerBlankValues);
  return useMemo(() => new Set(normalizeTrackerBlankValues(values)), [values]);
}
