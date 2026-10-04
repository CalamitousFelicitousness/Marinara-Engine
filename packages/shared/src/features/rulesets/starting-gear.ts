// Starting gear (Capability API 1.73): what a ruleset lets a character take into their bag at the
// start, never on its own. Resolving a choice is shared by the server, which adds what it resolves to,
// and the client, which shows it: one reading of the gear, so what the player saw is what is added.
//
// Nothing here trusts a selection. A pick must be one of its line's own list and one of the ruleset's
// catalog items the game offers (never a coin, an invented item or one a layer hides); every choice
// needs one of its options.

import type {
  RulesetDefinition,
  RulesetSheetBuild,
  RulesetStartingGear,
  RulesetStartingGearLine,
} from "../../schemas/ruleset.schema.js";
import { gameInventoryCoinRef } from "../../utils/game-inventory-stacks.js";
import { rulesetLayeredCurrencies, type RulesetLayerOptions } from "./layers.js";
import type { RulesetItemBook } from "./item-book.js";
import { resolveRulesetValueRef } from "./sheet-math.js";

/** What the player chose: the gear, an option for each of its choices, and an item for each line
 *  that lists several. A pick is keyed `"<line>"` for one of the gear's own lines and
 *  `"<choice>.<line>"` for one of the chosen option's. */
export interface RulesetStartingGearSelection {
  gear: string;
  choices: number[];
  picks: Record<string, string>;
}

/** One thing the gear adds: one of the ruleset's items, coins (as their coin's item), or a plain item
 *  by name; `equip` where it is put on as it is taken. */
export interface RulesetStartingGearAdd {
  item?: string;
  name: string;
  count: number;
  equip?: true;
}

export type RulesetStartingGearRefusal = "unknown-gear" | "choice" | "pick" | "unknown-item";

export type RulesetStartingGearResolution =
  | {
      ok: true;
      gear: RulesetStartingGear;
      adds: RulesetStartingGearAdd[];
      /** What the game's layers took out of the ruleset, which the gear then does without. */
      dropped: string[];
    }
  | { ok: false; reason: RulesetStartingGearRefusal; detail: string };

/** The ruleset's starting gear, in the order it lists them. */
export function rulesetStartingGear(definition: RulesetDefinition): readonly RulesetStartingGear[] {
  return definition.items?.startingGear ?? [];
}

/** Whether a character's sheet is what the gear is for. Gear that names nobody fits nobody in
 *  particular; it is offered all the same, as every gear is. */
export function rulesetStartingGearFits(
  definition: RulesetDefinition,
  gear: RulesetStartingGear,
  build: RulesetSheetBuild | undefined,
): boolean {
  if (!gear.fits || !build) return false;
  return resolveRulesetValueRef(definition, build, gear.fits.value) >= gear.fits.atLeast;
}

/** The lines a selection takes, each with the key a pick names it by. */
function selectedLines(
  gear: RulesetStartingGear,
  choices: readonly number[],
): { lines: Array<{ key: string; line: RulesetStartingGearLine }> } | { refused: string } {
  if (choices.length !== gear.choices.length) return { refused: `"${gear.label}" asks ${gear.choices.length} choices` };
  const lines = gear.lines.map((line, index) => ({ key: String(index), line }));
  for (const [choiceIndex, choice] of gear.choices.entries()) {
    const optionIndex = choices[choiceIndex]!;
    const option = Number.isInteger(optionIndex) ? choice.options[optionIndex] : undefined;
    if (!option) return { refused: `Choose one of "${choice.label}"` };
    option.lines.forEach((line, lineIndex) => lines.push({ key: `${choiceIndex}.${lineIndex}`, line }));
  }
  return { lines };
}

/**
 * A selection as the things it adds, merged by item so two picks of the same weapon are one add of
 * two. A fixed item a layer takes out of the game, and coins of a family a layer takes out, are left
 * out and named in `dropped`; coins of a single coin a layer takes out are paid at the same worth in
 * the largest coin left, as a price is. Refused: an unknown gear, a choice without an option, a pick
 * that is not one of its list or not one of the game's items, and an item the ruleset does not have.
 */
export function resolveRulesetStartingGear(
  definition: RulesetDefinition,
  book: RulesetItemBook,
  selection: RulesetStartingGearSelection,
  layerOptions?: RulesetLayerOptions | null,
): RulesetStartingGearResolution {
  const gear = rulesetStartingGear(definition).find((entry) => entry.id === selection.gear);
  if (!gear) return { ok: false, reason: "unknown-gear", detail: `No starting gear "${selection.gear}"` };
  const selected = selectedLines(gear, selection.choices);
  if ("refused" in selected) return { ok: false, reason: "choice", detail: selected.refused };

  // The game's own catalog items: what a layer hides is not among them, and nor is a coin or an item
  // the Game Master invented.
  const offered = new Map(book.entries.map((entry) => [entry.item, entry]));
  const adds = new Map<string, RulesetStartingGearAdd>();
  const dropped: string[] = [];
  const add = (key: string, next: RulesetStartingGearAdd) => {
    const before = adds.get(key);
    if (before) before.count += next.count;
    else adds.set(key, { ...next });
    if (next.equip) adds.get(key)!.equip = true;
  };
  const families = definition.items?.currencies ?? [];
  const left = rulesetLayeredCurrencies(definition, layerOptions);

  for (const { key, line } of selected.lines) {
    if (line.oneOf) {
      const picked = selection.picks[key];
      const entry = picked !== undefined && line.oneOf.includes(picked) ? offered.get(picked) : undefined;
      if (!entry) return { ok: false, reason: "pick", detail: `Pick one of the list for line ${key}` };
      add(entry.item, {
        item: entry.item,
        name: entry.name,
        count: line.count,
        ...(line.equip ? { equip: true } : {}),
      });
    } else if (line.item) {
      const entry = offered.get(line.item);
      if (!entry) {
        const known = book.itemOf(line.item);
        if (!known) return { ok: false, reason: "unknown-item", detail: `No item "${line.item}" in this ruleset` };
        dropped.push(known.name);
        continue;
      }
      add(entry.item, {
        item: entry.item,
        name: entry.name,
        count: line.count,
        ...(line.equip ? { equip: true } : {}),
      });
    } else if (line.coins) {
      const family = families.find((each) => each.units.some((unit) => unit.id === line.coins));
      const named = family?.units.find((unit) => unit.id === line.coins);
      const kept = family && left.find((each) => each.id === family.id);
      if (!family || !named || !kept) {
        dropped.push(named?.label ?? line.coins);
        continue;
      }
      // The family's smallest coin, worth 1, is always left, so some coin pays the worth exactly.
      const unit = kept.units.some((each) => each.id === named.id)
        ? named
        : [...kept.units]
            .sort((a, b) => b.value - a.value)
            .find((each) => (line.count * named.value) % each.value === 0)!;
      const count = (line.count * named.value) / unit.value;
      const item = gameInventoryCoinRef(unit.id);
      add(item, { item, name: unit.label, count });
    } else if (line.name) {
      add(`name:${line.name.toLowerCase()}`, { name: line.name, count: line.count });
    }
  }
  return { ok: true, gear, adds: [...adds.values()], dropped };
}
