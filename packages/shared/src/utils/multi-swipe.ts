// Multiswipe: one regenerate request produces N candidate swipes.
// Candidate 1 is the normal active swipe; candidates 2..N are silent swipes.
// Post-processing agents are deferred per candidate until the user commits to
// that swipe, which keeps every swipe either agent-coherent or visibly pending.

/** Upper bound on candidates per multiswipe request. Each candidate is a full sequential generation. */
export const MAX_MULTI_SWIPE_CANDIDATES = 4;

/** Extra key holding the deferred-agent marker on a message/swipe. */
export const MULTI_SWIPE_EXTRA_KEY = "multiSwipe";

/**
 * Deferred-agent marker written to every candidate swipe of a multiswipe run.
 * Presence means "agents never ran for this swipe". Markers are per swipe:
 * finalize clears only the committed one, so candidates the user did not pick
 * stay pending and can still run their agents if revisited later.
 */
export interface MultiSwipePendingMarker {
  /** Agent types skipped during the multiswipe request, replayed against the chosen swipe. */
  pendingAgents: string[];
  /** Candidates requested for the run that produced this marker. */
  candidateCount: number;
  /** Epoch ms at defer time. Enables a future staleness cutoff. */
  createdAt: number;
}

/** Clamp any client/stored value into 1..MAX_MULTI_SWIPE_CANDIDATES. 1 disables multiswipe. */
export function normalizeMultiSwipeCandidateCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(MAX_MULTI_SWIPE_CANDIDATES, Math.trunc(parsed)));
}

/** Read a marker out of parsed extra. Returns null for absent, malformed, or non-object values. */
export function parseMultiSwipePendingMarker(value: unknown): MultiSwipePendingMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const pendingAgents = Array.isArray(raw.pendingAgents)
    ? raw.pendingAgents.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : null;
  if (!pendingAgents) return null;
  return {
    pendingAgents,
    candidateCount: normalizeMultiSwipeCandidateCount(raw.candidateCount),
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
  };
}

/** Read the marker from a message/swipe extra record without assuming it was parsed. */
export function readMultiSwipePendingMarker(extra: unknown): MultiSwipePendingMarker | null {
  if (!extra) return null;
  let record: unknown = extra;
  if (typeof extra === "string") {
    try {
      record = JSON.parse(extra);
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== "object") return null;
  return parseMultiSwipePendingMarker((record as Record<string, unknown>)[MULTI_SWIPE_EXTRA_KEY]);
}
