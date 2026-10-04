// What the in-game ruleset sheet shows beside its editor: the summary, pool group headings and the
// level the character card's header shows.
import {
  defaultRulesetSheetBuild,
  evaluateRulesetSheet,
  isRulesetItemHidden,
  readRulesetLive,
  type RulesetDefinition,
  type RulesetLiveState,
  type RulesetSheetBuild,
  type RulesetSheetEnvelope,
  type RulesetSheetItem,
} from "@marinara-engine/shared";

/** The summary's fields and derived values the sheet shows for this build: what it hides (a spell save
 *  for someone who casts nothing) the summary hides too, as the Game Master's own summary does. */
export function rulesetSheetSummaryShown(definition: RulesetDefinition, build: RulesetSheetBuild) {
  const summary = definition.gm.sheetSummary;
  return {
    fields: definition.sheet.fields.filter(
      (field) => summary.fields.includes(field.id) && !isRulesetItemHidden(field, build, definition),
    ),
    derived: definition.sheet.derived.filter(
      (entry) => summary.derived.includes(entry.id) && !isRulesetItemHidden(entry, build, definition),
    ),
  };
}

/** A pool group's heading: the ruleset names a group only by its id ("hit_dice"), so the id is read as
 *  words ("Hit dice"). */
export function rulesetPoolGroupLabel(id: string): string {
  const words = id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

/** The character's level by the ruleset's sheet, for the card's header: its derived value named
 *  `level`, while the sheet shows it; null when the ruleset has none, so the header shows no level
 *  rather than a stale one the game card kept. */
export function rulesetSheetLevel(
  definition: RulesetDefinition,
  envelope: RulesetSheetEnvelope | undefined,
  live: RulesetLiveState | undefined,
  items: ReadonlyArray<RulesetSheetItem> | undefined,
): number | null {
  const level = definition.sheet.derived.find((entry) => entry.id === "level");
  const build = envelope?.build ?? defaultRulesetSheetBuild(definition);
  if (!level || isRulesetItemHidden(level, build, definition)) return null;
  const resolved = readRulesetLive(definition, build, live);
  const value = evaluateRulesetSheet(definition, build, items ? { ...resolved, items } : resolved).derived.level;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
