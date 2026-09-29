// What a weapon shoots and what it has loaded, as a fight counts them.
//
// A weapon's `ammo` draws from the items its holder carries with that tag, in the order the bag keeps
// them; its `clip` is a loaded count the weapon keeps on itself. Both are counted on the fighter
// (`itemsUsed`, `loaded`, `recoverable`), keyed by the item's place in the fighter's items, so what a
// step changed can be written back to exactly those inventory stacks.
//
// Pure, like the rest of the fight: each function changes the fighter it is handed and returns the
// event that says so.

import type { GameInventoryJournalEntry } from "../../utils/game-inventory-ops.js";
import { GAME_INVENTORY_MAX_QUANTITY, type GameInventoryStack } from "../../utils/game-inventory-stacks.js";
import type { RulesetCombatAction, RulesetCombatant, RulesetCombatEvent, RulesetEncounterState } from "./types.js";

/** How many of the items with this tag the fighter still carries. */
export function rulesetAmmoLeft(actor: RulesetCombatant, tag: string): number {
  let left = 0;
  (actor.sheet?.items ?? []).forEach((held, index) => {
    if (held.item.tags?.includes(tag)) left += Math.max(0, held.quantity - (actor.itemsUsed?.[index] ?? 0));
  });
  return left;
}

/** What a weapon has loaded now: what this fight has left in it, else what its stack kept, else a
 *  full clip, since a weapon nobody has fired yet is loaded. */
export function rulesetLoaded(actor: RulesetCombatant, clip: NonNullable<RulesetCombatAction["clip"]>): number {
  const now = actor.loaded?.[clip.item] ?? actor.sheet?.items?.[clip.item]?.loaded ?? clip.max;
  return Math.max(0, Math.min(clip.max, now));
}

/** Whether what an action shoots or loads lets it happen now: an attack needs a shot loaded or
 *  carried, a reload a clip with room in it and, where it loads from the bag, something to load. */
export function rulesetShotsAvailable(actor: RulesetCombatant, action: RulesetCombatAction): boolean {
  if (action.kind === "reload") {
    if (!action.clip || rulesetLoaded(actor, action.clip) >= action.clip.max) return false;
    return !action.ammo || rulesetAmmoLeft(actor, action.ammo.tag) > 0;
  }
  const per = action.ammo?.per ?? 1;
  if (action.clip) return rulesetLoaded(actor, action.clip) >= per;
  if (action.ammo) return rulesetAmmoLeft(actor, action.ammo.tag) >= per;
  return true;
}

/** Takes up to `count` of the items with this tag out of the fighter's bag, first stack first, and
 *  notes the share of them that comes back after a won fight. How many were taken. */
function draw(actor: RulesetCombatant, tag: string, count: number, recover?: number): number {
  let wanted = count;
  (actor.sheet?.items ?? []).forEach((held, index) => {
    if (wanted <= 0 || !held.item.tags?.includes(tag)) return;
    const used = actor.itemsUsed?.[index] ?? 0;
    const take = Math.min(wanted, Math.max(0, held.quantity - used));
    if (take <= 0) return;
    (actor.itemsUsed ??= {})[index] = used + take;
    if (recover) {
      const recoverable = (actor.recoverable ??= {});
      recoverable[index] = (recoverable[index] ?? 0) + take * recover;
    }
    wanted -= take;
  });
  return count - wanted;
}

/** One attack's shots, spent: out of the clip where the weapon has one, and otherwise out of the
 *  bag. Null for an action that shoots nothing. */
export function spendRulesetShots(actor: RulesetCombatant, action: RulesetCombatAction): RulesetCombatEvent | null {
  if (action.kind === "reload") return null;
  const said = { type: "shot" as const, actorId: actor.id, optionId: action.id, label: action.label };
  const per = action.ammo?.per ?? 1;
  if (action.clip) {
    const left = Math.max(0, rulesetLoaded(actor, action.clip) - per);
    (actor.loaded ??= {})[action.clip.item] = left;
    return { ...said, left, of: action.clip.max };
  }
  if (!action.ammo) return null;
  draw(actor, action.ammo.tag, per, action.ammo.recover);
  return { ...said, left: rulesetAmmoLeft(actor, action.ammo.tag) };
}

/** A clip filled to its most, out of what it shoots where it loads from the bag: as much as the bag
 *  still holds when that is less. */
export function reloadRulesetClip(actor: RulesetCombatant, action: RulesetCombatAction): RulesetCombatEvent | null {
  const clip = action.clip;
  if (!clip) return null;
  const now = rulesetLoaded(actor, clip);
  const drew = action.ammo ? draw(actor, action.ammo.tag, clip.max - now) : undefined;
  const loaded = now + (drew ?? clip.max - now);
  (actor.loaded ??= {})[clip.item] = loaded;
  return {
    type: "reload",
    actorId: actor.id,
    optionId: action.id,
    label: action.label,
    loaded,
    of: clip.max,
    ...(drew !== undefined ? { drew } : {}),
  };
}

/** After a fight the party won: the share of what each of them shot that comes back, stack by stack,
 *  rounded down once for the whole fight. */
export function recoverRulesetAmmo(state: RulesetEncounterState): RulesetCombatEvent[] {
  const events: RulesetCombatEvent[] = [];
  for (const combatant of state.combatants) {
    if (!combatant.recoverable) continue;
    for (const [index, share] of Object.entries(combatant.recoverable)) {
      // A share summed in steps of a fraction may land a hair under the whole number it means.
      const back = Math.min(Math.floor(share + 1e-9), combatant.itemsUsed?.[index] ?? 0);
      if (back <= 0) continue;
      combatant.itemsUsed![index]! -= back;
      events.push({
        type: "recovered",
        actorId: combatant.id,
        label: combatant.sheet?.items?.[Number(index)]?.name ?? "",
        count: back,
      });
    }
    delete combatant.recoverable;
  }
  return events;
}

/** What one step of a fight did to one of the party's inventory stacks: how many it took out of it
 *  (fewer than none when a won fight gave some back) and what a weapon has loaded now. */
export interface RulesetFightItemChange {
  stack: { id: string; ref: string; holder?: string };
  /** The stack's own name, for the journal and for a stack made again. */
  name: string;
  taken: number;
  loaded?: number;
}

/**
 * What changed of the party's inventory between two states of one fight, stack by stack: every shot,
 * load and share won back since `before`, which is nothing at all when the fight is new. An item the
 * fight was handed without a stack (a test's, or one read from nowhere) is never written anywhere.
 */
export function rulesetFightItemChanges(
  before: RulesetEncounterState | undefined,
  after: RulesetEncounterState,
): RulesetFightItemChange[] {
  const changes: RulesetFightItemChange[] = [];
  for (const combatant of after.combatants) {
    const items = combatant.sheet?.items;
    if (combatant.side !== "party" || !items || (!combatant.itemsUsed && !combatant.loaded)) continue;
    const earlier = before?.combatants.find((entry) => entry.id === combatant.id);
    items.forEach((held, index) => {
      if (!held.stack) return;
      const taken = (combatant.itemsUsed?.[index] ?? 0) - (earlier?.itemsUsed?.[index] ?? 0);
      const loaded = combatant.loaded?.[index];
      const reloaded = loaded !== undefined && loaded !== earlier?.loaded?.[index];
      if (taken === 0 && !reloaded) return;
      changes.push({
        stack: { ...held.stack },
        name: held.name ?? held.stack.ref,
        taken,
        ...(reloaded ? { loaded } : {}),
      });
    });
  }
  return changes;
}

/**
 * A fight's changes written onto the inventory, by stack id: each stack takes what was shot or loaded
 * out of it (and is gone at none), a weapon keeps what it has loaded, and what a won fight gives back
 * to a stack it had emptied makes that stack again, where it was. Null when the inventory no longer
 * holds what the fight counted on (a stack gone, another item or another bag under its id, or fewer
 * in it than were shot), which the caller refuses the step for, as it does a spent item it cannot
 * find.
 */
export function applyRulesetFightItemChanges(
  stacks: readonly GameInventoryStack[],
  changes: readonly RulesetFightItemChange[],
): { stacks: GameInventoryStack[]; journal: GameInventoryJournalEntry[] } | null {
  let next = [...stacks];
  const journal: GameInventoryJournalEntry[] = [];
  for (const change of changes) {
    const at = next.findIndex((stack) => stack.id === change.stack.id);
    if (change.taken > 0) journal.push({ item: change.name, action: "used", quantity: change.taken });
    if (change.taken < 0) journal.push({ item: change.name, action: "acquired", quantity: -change.taken });
    if (at < 0) {
      // Only what came back may land where nothing is left: a shot or a load needed the stack.
      if (change.taken >= 0 || change.loaded !== undefined) return null;
      next.push({
        id: change.stack.id,
        name: change.name,
        item: change.stack.ref,
        quantity: Math.min(GAME_INVENTORY_MAX_QUANTITY, -change.taken),
        ...(change.stack.holder !== undefined ? { holder: change.stack.holder } : {}),
      });
      continue;
    }
    const stack = next[at]!;
    // Given to somebody else keeps a stack's id, and one fighter's shots never come out of another's bag.
    if (stack.item !== change.stack.ref || stack.holder !== change.stack.holder) return null;
    const quantity = Math.min(GAME_INVENTORY_MAX_QUANTITY, stack.quantity - change.taken);
    if (quantity < 0) return null;
    if (quantity === 0) {
      next = next.filter((_, index) => index !== at);
      continue;
    }
    next[at] = { ...stack, quantity, ...(change.loaded !== undefined ? { loaded: change.loaded } : {}) };
  }
  return { stacks: next, journal };
}
