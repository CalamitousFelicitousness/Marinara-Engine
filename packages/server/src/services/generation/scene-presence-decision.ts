/**
 * Automated active characters for Merged Roleplay groups.
 *
 * In Merged mode every active card sits in the narrator's context, so a big cast either
 * bloats every prompt or needs the eye toggles flipped by hand. This keeps the active list
 * equal to who is in the scene, read either from the Decision model (one yes/no question per
 * character, asked before the reply, like Smart response order) or from the Character
 * Tracker's present characters (one turn late, but free).
 *
 * Everything here is pure, so the rules are pinned by a regression without a model.
 */
import { estimateTextTokens } from "@marinara-engine/shared";
import { buildDecisionState, type DecisionMessage } from "./agent-activation-questions.js";
import type { NoulQuestion } from "../decision/system-one.client.js";

export interface ScenePresenceCandidate {
  id: string;
  name: string;
  /** Description or personality, already shortened. */
  about?: string;
}

/** The same transcript Smart response order reads. */
export const SCENE_PRESENCE_TRANSCRIPT_DEPTH = 5;

/**
 * Per-candidate `about` lengths, tried in order until the roster fits: one long card cannot
 * crowd the transcript out, and a big cast falls back to names alone.
 */
const CANDIDATE_ABOUT_CHARS = [300, 100, 0] as const;

/** The least transcript worth asking about; below this the question is not asked. */
const TRANSCRIPT_FLOOR_TOKENS = 256;

/**
 * The state every question is asked against: the recent transcript, the cast, and who the
 * Character Tracker last saw, which keeps presence steady between turns.
 *
 * Null when even the names leave too little room for the transcript in `maxStateTokens`;
 * the caller then skips the Decision model rather than send a state it cannot read.
 */
export function scenePresenceState(
  messages: DecisionMessage[],
  candidates: ScenePresenceCandidate[],
  lastTrackedPresent: string[],
  maxStateTokens: number,
): Record<string, unknown> | null {
  for (const aboutChars of CANDIDATE_ABOUT_CHARS) {
    const roster = candidates.map((candidate) => ({
      name: candidate.name,
      ...(candidate.about && aboutChars > 0 ? { about: candidate.about.slice(0, aboutChars) } : {}),
    }));
    const extra = {
      candidates: roster,
      ...(lastTrackedPresent.length > 0 ? { last_tracked_present: lastTrackedPresent } : {}),
    };
    const transcriptBudget = maxStateTokens - estimateTextTokens(JSON.stringify(extra));
    if (transcriptBudget < TRANSCRIPT_FLOOR_TOKENS) continue;
    return { ...buildDecisionState(messages, SCENE_PRESENCE_TRANSCRIPT_DEPTH, transcriptBudget), ...extra };
  }
  return null;
}

/** One question per candidate, keyed by character id. */
export function scenePresenceQuestions(candidates: ScenePresenceCandidate[]): NoulQuestion[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    instructions: `${candidate.name} is physically present in the scene the next reply continues, or enters it in response to the latest message. Being mentioned, remembered or talked about while absent does not count.`,
  }));
}

/**
 * Ids the Decision model judged present, or null unless it answered for every candidate.
 * A missing answer (malformed, or timed out) is silence, not absence, so a partial set is
 * not used: it would turn off whoever went unanswered.
 */
export function presentFromDecision(
  answers: Map<string, number>,
  threshold: number,
  candidateIds: string[],
): string[] | null {
  if (candidateIds.length === 0 || !candidateIds.every((id) => answers.has(id))) return null;
  return candidateIds.filter((id) => answers.get(id)! >= threshold);
}

/**
 * Chat character ids in the Character Tracker's present characters, or null when it has no
 * list to read. An empty list is "no data", as the tracker merge treats it, not "nobody here".
 *
 * A list naming no attached character is no data too: the tracker model writes the ids, so
 * a scene of NPCs only looks the same as ids it got wrong, and keeping the cast costs less
 * than sending it away.
 */
export function presentFromTracker(presentCharacters: unknown, candidateIds: string[]): string[] | null {
  if (!Array.isArray(presentCharacters) || presentCharacters.length === 0) return null;
  const candidates = new Set(candidateIds);
  const present = presentCharacters
    .map((entry) => (entry && typeof entry === "object" ? (entry as { characterId?: unknown }).characterId : null))
    .filter((id): id is string => typeof id === "string" && candidates.has(id));
  return present.length > 0 ? present : null;
}

/**
 * The new `inactiveCharacterIds`, or null to leave the chat as it is: nothing to read, no
 * change, or a choice that would leave nobody active.
 *
 * Pinned characters keep their current state. The narrator is always active.
 */
export function chooseSceneCharacters(args: {
  /** Every attached character, in roster order. */
  candidateIds: string[];
  /** Ids judged present, or null when no source answered. */
  presentIds: string[] | null;
  currentInactiveIds: string[];
  pinnedIds: string[];
  narratorId: string | null;
}): string[] | null {
  if (!args.presentIds) return null;
  const present = new Set(args.presentIds);
  const pinned = new Set(args.pinnedIds);
  const currentlyInactive = new Set(args.currentInactiveIds);
  const inactive = args.candidateIds.filter((id) => {
    if (id === args.narratorId) return false;
    if (pinned.has(id)) return currentlyInactive.has(id);
    return !present.has(id);
  });
  if (inactive.length === args.candidateIds.length) return null;
  const unchanged =
    inactive.length === args.candidateIds.filter((id) => currentlyInactive.has(id)).length &&
    inactive.every((id) => currentlyInactive.has(id));
  return unchanged ? null : inactive;
}
