// ──────────────────────────────────────────────
// Game-state boundary normalization
// ──────────────────────────────────────────────
// `PresentCharacter` declares `characterId`, `name`, `emoji`, `mood`,
// `customFields` and `stats` as non-nullable, but a snapshot is agent JSON: a
// custom tracker prompt that never mentions a field simply omits it, and a
// character with no card of its own has no id. TypeScript then vouches for
// values that are not there, which is how an omitted `characterId` took down
// the whole app shell from inside a useMemo.
//
// Rather than guard every consumer, make the type true where the data enters:
// every writer funnels through the game-state store's single action.
//
// Two rules this must not break:
//
// - Unknown keys are preserved. A custom prompt's nested output (clothing,
//   body, ...) lives directly on the character and is read back by
//   `readCharacterExtras`; rebuilding from known keys would delete it.
// - Objects are returned unchanged when nothing needs fixing, so downstream
//   memoization does not churn on every snapshot.
import type { GameState, PresentCharacter } from "@marinara-engine/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only the fields whose declared type promises non-null and whose absence throws. */
function presentCharacterNeedsRepair(value: Record<string, unknown>) {
  return (
    typeof value.characterId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.emoji !== "string" ||
    typeof value.mood !== "string" ||
    !isRecord(value.customFields) ||
    !Array.isArray(value.stats)
  );
}

export function normalizePresentCharacter(value: unknown): PresentCharacter | null {
  if (!isRecord(value)) return null;
  if (!presentCharacterNeedsRepair(value)) return value as unknown as PresentCharacter;

  // Spread first: prompt-defined keys must survive untouched.
  return {
    ...value,
    characterId: typeof value.characterId === "string" ? value.characterId : "",
    name: typeof value.name === "string" ? value.name : "",
    emoji: typeof value.emoji === "string" ? value.emoji : "",
    mood: typeof value.mood === "string" ? value.mood : "",
    customFields: isRecord(value.customFields) ? value.customFields : {},
    stats: Array.isArray(value.stats) ? value.stats : [],
  } as unknown as PresentCharacter;
}

export function normalizePresentCharacters(value: unknown): PresentCharacter[] {
  if (!Array.isArray(value)) return [];
  let changed = value.length !== value.filter(isRecord).length;
  const normalized: PresentCharacter[] = [];
  for (const entry of value) {
    const character = normalizePresentCharacter(entry);
    if (!character) continue;
    if (character !== entry) changed = true;
    normalized.push(character);
  }
  return changed ? normalized : (value as PresentCharacter[]);
}

/** Repairs a snapshot's character list in place, leaving every other field alone. */
export function normalizeGameStateCharacters<T extends Partial<GameState>>(state: T): T {
  if (!("presentCharacters" in state)) return state;
  const normalized = normalizePresentCharacters(state.presentCharacters);
  return normalized === state.presentCharacters ? state : { ...state, presentCharacters: normalized };
}
