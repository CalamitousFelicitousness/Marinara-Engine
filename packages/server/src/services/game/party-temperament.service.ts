// A party member's temperament is theirs for the whole game (Alyssa 2026-10-31): read once from their
// description, kept on their game card, and the same in every fight until the story changes it.

import {
  gameCardTemperament,
  normalizeCharacterLookupName,
  partyTemperamentFallback,
  readPartyTemperament,
  withKeptTemperament,
  type CombatAiHints,
  type CombatPartyTemperament,
} from "@marinara-engine/shared";

/**
 * A game card with its temperament kept as the model wrote it at the card's making (game setup, a
 * recruit), or as it was before (a regenerated card): the one it starts with is never rewritten.
 */
export function withCardTemperament(
  card: Record<string, unknown>,
  written: unknown,
  before?: Record<string, unknown> | null,
): Record<string, unknown> {
  const kept = gameCardTemperament(before);
  const current = readPartyTemperament(written) ?? kept?.current;
  const { temperament: _t, temperamentInitial: _i, ...rest } = card;
  if (!current) return rest;
  return { ...rest, temperament: current, temperamentInitial: kept?.initial ?? current };
}

/**
 * The party of a fight's blueprint with every member's own temperament kept over whatever the fight's
 * setup hinted, and the temperaments to write onto cards that had none yet: the hint the setup read
 * from their description where it gave one a party member may have, else one drawn once for the game.
 */
export function keepPartyTemperaments<T extends { name?: unknown; aiHints?: CombatAiHints }>(
  party: readonly T[],
  cards: readonly Record<string, unknown>[],
  gameId: string,
): { party: T[]; fresh: Map<string, CombatPartyTemperament> } {
  const byName = new Map<string, Record<string, unknown>>();
  for (const card of cards)
    if (typeof card.name === "string" && card.name.trim()) byName.set(normalizeCharacterLookupName(card.name), card);
  const fresh = new Map<string, CombatPartyTemperament>();
  const kept = party.map((member) => {
    const name = typeof member.name === "string" ? member.name.trim() : "";
    if (!name) return member;
    const key = normalizeCharacterLookupName(name);
    const card = byName.get(key);
    let temperament = gameCardTemperament(card)?.current;
    if (!temperament) {
      temperament =
        fresh.get(key) ?? readPartyTemperament(member.aiHints?.temperament) ?? partyTemperamentFallback(gameId, name);
      // Only a member with a card keeps one: a summoned or room-added unit fights with this one.
      if (card) fresh.set(key, temperament);
    }
    return { ...member, aiHints: withKeptTemperament(member.aiHints, temperament) };
  });
  return { party: kept, fresh };
}

/** The game's cards with the temperaments drawn for them written on, where they still have none. */
export function cardsWithFreshTemperaments(
  cards: readonly Record<string, unknown>[],
  fresh: ReadonlyMap<string, CombatPartyTemperament>,
): { cards: Record<string, unknown>[]; changed: boolean } {
  let changed = false;
  const next = cards.map((card) => {
    if (typeof card.name !== "string" || gameCardTemperament(card)) return card;
    const temperament = fresh.get(normalizeCharacterLookupName(card.name));
    if (!temperament) return card;
    changed = true;
    return { ...card, temperament, temperamentInitial: temperament };
  });
  return { cards: next, changed };
}
