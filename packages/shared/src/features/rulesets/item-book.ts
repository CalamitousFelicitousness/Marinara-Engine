// ──────────────────────────────────────────────
// Game Mode rulesets: the items a game's inventory can hold
//
// A ruleset lists its items in catalogs that hold items. The inventory reads them through one book:
// which name is which item (a label, in any case), how many of one a stack holds, and what the
// screen and the Game Master are shown about it. The server builds the book from the catalogs it
// loads and the browser from the ones it fetches, so both read an item the same way.
// ──────────────────────────────────────────────
import {
  rulesetItemIssues,
  type RulesetCatalogEntry,
  type RulesetCatalogItem,
  type RulesetDefinition,
  type RulesetItemStat,
  type RulesetSheetBuild,
} from "../../schemas/ruleset.schema.js";
import { normalizeCharacterLookupName } from "../../utils/character-lookup-name.js";
import {
  gameInventoryNameKey,
  type GameInventoryBearer,
  type GameInventoryItemRules,
  type GameInventoryRulesetItem,
} from "../../utils/game-inventory-stacks.js";
import {
  inventRulesetItem,
  rulesetInventedItemId,
  rulesetInventedItemRef,
  rulesetInventedItemText,
  RULESET_INVENTED_ITEMS_MAX,
  type RulesetInventedItem,
} from "./invented-items.js";
import { catalogEntryHiddenByLayers, type RulesetLayerOptions } from "./layers.js";
import { defaultRulesetSheetBuild, evaluateRulesetSheet, resolveRulesetValueRef } from "./sheet-math.js";

/** One stat an item gives, in the ruleset's words. `text` is absent for a yes-or-no stat that is
 *  yes, whose label says it all. */
export interface RulesetItemStatFact {
  id: string;
  label: string;
  text?: string;
  /** Whether the Game Master is shown it. */
  promptVisible: boolean;
}

/** What an item is, as labels: what the screen and the Game Master show. */
export interface RulesetItemFacts {
  category: string;
  rarity?: string;
  tags: string[];
  /** The stats the item gives, in the order the ruleset declares them. */
  stats: RulesetItemStatFact[];
  /** What it costs, in the unit's own label ("8", "shillings"). */
  cost?: { amount: number; unit: string };
}

export interface RulesetItemBookEntry extends GameInventoryRulesetItem {
  /** The catalog it is listed in; empty for an item the Game Master invented. */
  catalogId: string;
  /** The catalog entry, for a picker's search and filters. An invented item's is made from it. */
  entry: RulesetCatalogEntry;
  summary?: string;
  facts: RulesetItemFacts;
  /** Set on an item the Game Master invented, with what the Engine changed from its proposal. */
  invented?: { notes: string[] };
}

/** The sheets a book reads what each character carries and binds off: the player's own, and every
 *  other party member's by the name their card and their bag have. One without a sheet reads a blank
 *  one, as the rest of the game does. */
export interface RulesetItemBookSheets {
  player?: RulesetSheetBuild;
  members?: ReadonlyArray<{ name: string; build: RulesetSheetBuild }>;
}

export interface RulesetItemBook extends GameInventoryItemRules {
  /** Every item a layer leaves in, catalog by catalog, in the order the ruleset lists them. Items the
   *  Game Master invented are not among them: nobody picks those off a list. */
  entries: readonly RulesetItemBookEntry[];
  /** Also an item a layer has taken out, so one already held still reads as itself, and an item the
   *  Game Master invented. */
  itemOf(item: string): RulesetItemBookEntry | undefined;
  itemNamed(name: string): RulesetItemBookEntry | undefined;
  /** The game's invented items, as they are to be saved: the ones it was built with, and any `invent`
   *  has made or replaced since. */
  inventedItems(): RulesetInventedItem[];
  /** Whether `invent` has made or replaced an item since the book was built. */
  inventedChanged(): boolean;
}

function statText(stat: RulesetItemStat, value: string | number | boolean): string | undefined {
  if (stat.type === "boolean") return undefined;
  if (stat.type === "enum") return stat.valueLabels?.[String(value)] ?? String(value);
  return String(value);
}

/** An item's labels and stats, read against the ruleset's `items` block. */
export function rulesetItemFacts(definition: RulesetDefinition, item: RulesetCatalogItem): RulesetItemFacts {
  const block = definition.items;
  const labelOf = (words: ReadonlyArray<{ id: string; label: string }> | undefined, id: string) =>
    words?.find((word) => word.id === id)?.label ?? id;
  const stats = (block?.stats ?? []).flatMap((stat): RulesetItemStatFact[] => {
    const value = item.stats?.[stat.id];
    if (value === undefined || value === false || value === "") return [];
    const text = statText(stat, value);
    return [
      { id: stat.id, label: stat.label, ...(text !== undefined ? { text } : {}), promptVisible: stat.promptVisible },
    ];
  });
  const unit = item.cost
    ? block?.currencies?.flatMap((family) => family.units).find((each) => each.id === item.cost!.unit)
    : undefined;
  return {
    category: labelOf(block?.categories, item.category),
    ...(item.rarity ? { rarity: labelOf(block?.rarities, item.rarity) } : {}),
    tags: (item.tags ?? []).map((tag) => labelOf(block?.tags, tag)),
    stats,
    ...(item.cost ? { cost: { amount: item.cost.amount, unit: unit?.label ?? item.cost.unit } } : {}),
  };
}

/**
 * The book for a game: its ruleset's item catalogs, with the entries each has (`entries` by catalog
 * id; a catalog that could not be read is simply absent). `layerOptions` are the game's pinned layer
 * choices, which may take entries out. `plain` is whether something that is not one of these items
 * may be added: the ruleset's `freeform` for the player, and always for the Game Master until the
 * native switch arrives. `invented` are the items the Game Master has invented in this game (read with
 * `readRulesetInventedItems`); the Game Master's book (`actor: "game-master"`) can invent more.
 */
export function rulesetItemBook(
  definition: RulesetDefinition,
  entries: Readonly<Record<string, readonly RulesetCatalogEntry[]>>,
  options: {
    layerOptions?: RulesetLayerOptions | null;
    plain?: "allow" | "refuse";
    actor?: "player" | "game-master";
    sheets?: RulesetItemBookSheets;
    invented?: readonly RulesetInventedItem[];
  } = {},
): RulesetItemBook {
  const carryStat = definition.items?.carry?.stat;
  const bookEntry = (
    ref: string,
    catalogId: string,
    entry: RulesetCatalogEntry & { item: RulesetCatalogItem },
  ): RulesetItemBookEntry => {
    const weight = carryStat ? entry.item.stats?.[carryStat] : undefined;
    return {
      item: ref,
      name: entry.label,
      ...(entry.item.stack !== undefined ? { stack: entry.item.stack } : {}),
      ...(typeof weight === "number" && weight > 0 ? { weight } : {}),
      ...(entry.item.slots && Object.keys(entry.item.slots).length > 0 ? { slots: entry.item.slots } : {}),
      ...(entry.item.binds ? { binds: { ...(entry.item.binds.cursed ? { cursed: true } : {}) } } : {}),
      catalogId,
      entry,
      ...(entry.summary ? { summary: entry.summary } : {}),
      facts: rulesetItemFacts(definition, entry.item),
    };
  };
  const all = new Map<string, RulesetItemBookEntry>();
  const visible: RulesetItemBookEntry[] = [];
  const offered = new Set<string>();
  const byName = new Map<string, RulesetItemBookEntry>();
  for (const catalog of definition.catalogs ?? []) {
    if (catalog.holds !== "items") continue;
    for (const entry of entries[catalog.id] ?? []) {
      if (!entry.item) continue;
      const read = bookEntry(`${catalog.id}/${entry.id}`, catalog.id, { ...entry, item: entry.item });
      all.set(read.item, read);
      if (catalogEntryHiddenByLayers(definition, options.layerOptions, catalog.id, entry)) continue;
      visible.push(read);
      offered.add(read.item);
      // Two items of one name: the first the ruleset lists is the one the name finds.
      const key = gameInventoryNameKey(entry.label);
      if (!byName.has(key)) byName.set(key, read);
    }
  }
  // The items the Game Master invented, found by name after the ruleset's own.
  const invented = new Map<string, RulesetInventedItem>();
  const inventedByName = new Map<string, RulesetInventedItem>();
  let changed = false;
  const keep = (made: RulesetInventedItem) => {
    const previous = invented.get(made.id);
    if (previous) inventedByName.delete(gameInventoryNameKey(previous.name));
    invented.set(made.id, made);
    inventedByName.set(gameInventoryNameKey(made.name), made);
    const ref = rulesetInventedItemRef(made.id);
    all.set(ref, {
      ...bookEntry(ref, "", {
        id: made.id,
        label: made.name,
        ...(made.summary ? { summary: made.summary } : {}),
        item: made.item,
      }),
      invented: { notes: made.notes ?? [] },
    });
    offered.add(ref);
  };
  for (const made of options.invented ?? []) {
    if (invented.size >= RULESET_INVENTED_ITEMS_MAX) break;
    if (!invented.has(made.id)) keep(made);
  }
  const itemNamed = (name: string): RulesetItemBookEntry | undefined => {
    const key = gameInventoryNameKey(name);
    const made = inventedByName.get(key);
    return byName.get(key) ?? (made ? all.get(rulesetInventedItemRef(made.id)) : undefined);
  };
  const invent: GameInventoryItemRules["invent"] = (proposal, stacks) => {
    const text = rulesetInventedItemText(proposal);
    if (!text.name) return { refused: "unreadable" };
    const key = gameInventoryNameKey(text.name);
    const own = byName.get(key);
    if (own) return { item: own.item, notes: [`${own.name} is one of this ruleset's own items, so it is that item.`] };
    if (definition.items?.propose === false) return { refused: "no-invention" };
    // One of that name the game still holds is that item: a proposal never changes it. One nobody
    // holds any more (the turn that made it was told again) is made anew.
    const known = inventedByName.get(key);
    if (known && stacks.some((stack) => stack.item === rulesetInventedItemRef(known.id))) {
      return { item: rulesetInventedItemRef(known.id), notes: [] };
    }
    if (!known && invented.size >= RULESET_INVENTED_ITEMS_MAX) return { refused: "too-many" };
    const likeText = proposal.like?.trim();
    const like = likeText ? (offered.has(likeText) ? all.get(likeText) : itemNamed(likeText)) : undefined;
    const made = inventRulesetItem(definition, proposal, like?.entry.item);
    if (!made || rulesetItemIssues(definition, made.item).length > 0) return { refused: "unreadable" };
    const notes = [...(likeText && !like ? [`No item "${likeText.slice(0, 60)}" to start from.`] : []), ...made.notes];
    const id = known?.id ?? rulesetInventedItemId(text.name, (taken) => invented.has(taken));
    keep({ id, ...text, item: made.item, ...(notes.length ? { notes } : {}) });
    changed = true;
    return { item: rulesetInventedItemRef(id), notes };
  };
  return {
    entries: visible,
    itemOf: (item) => all.get(item),
    offers: (item) => offered.has(item),
    itemNamed,
    inventedItems: () => [...invented.values()],
    inventedChanged: () => changed,
    ...(options.actor === "game-master" && definition.items ? { invent } : {}),
    plain: options.plain ?? "allow",
    ...(options.actor ? { actor: options.actor } : {}),
    ...(definition.items?.slots?.length
      ? { slots: definition.items.slots.map(({ id, label, count }) => ({ id, label, count })) }
      : {}),
    ...(definition.items?.carry || definition.items?.binding
      ? { bearer: rulesetItemBearers(definition, options.sheets) }
      : {}),
  };
}

/**
 * What each character carries and binds, read off their sheet: the ruleset's `carry` values and its
 * binding maximum, worked out once per character. These are read without live state (the ruleset is
 * checked for that at import), so a sheet's build is all they need.
 */
export function rulesetItemBearers(
  definition: RulesetDefinition,
  sheets: RulesetItemBookSheets = {},
): (holder: string | undefined) => GameInventoryBearer {
  const block = definition.items;
  const read = new Map<string, GameInventoryBearer>();
  const buildOf = (holder: string | undefined): RulesetSheetBuild => {
    if (!holder) return sheets.player ?? defaultRulesetSheetBuild(definition);
    const key = normalizeCharacterLookupName(holder);
    return (
      sheets.members?.find((member) => normalizeCharacterLookupName(member.name) === key)?.build ??
      defaultRulesetSheetBuild(definition)
    );
  };
  return (holder) => {
    const key = holder ? normalizeCharacterLookupName(holder) : "";
    const known = read.get(key);
    if (known) return known;
    const build = buildOf(holder);
    const evaluated = evaluateRulesetSheet(definition, build);
    const value = (ref: Parameters<typeof resolveRulesetValueRef>[2] | undefined) =>
      ref ? resolveRulesetValueRef(definition, build, ref, evaluated) : undefined;
    const encumberedAbove = value(block?.carry?.encumberedAbove);
    const limit = value(block?.carry?.limit);
    const bindingMax = value(block?.binding?.max);
    const bearer: GameInventoryBearer = {
      ...(encumberedAbove !== undefined ? { encumberedAbove } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(bindingMax !== undefined ? { bindingMax: Math.max(0, Math.floor(bindingMax)) } : {}),
    };
    read.set(key, bearer);
    return bearer;
  };
}

/** The item catalogs a ruleset declares: the ones the book is built from. */
export function rulesetItemCatalogIds(definition: RulesetDefinition): string[] {
  return (definition.catalogs ?? []).filter((catalog) => catalog.holds === "items").map((catalog) => catalog.id);
}

/** An item's facts as one line for the Game Master: category, rarity and tags, then the stats the
 *  ruleset shows it, such as "Weapon, Common, Thrown; Damage 1d6, Reach close". */
export function rulesetItemPromptFacts(facts: RulesetItemFacts): string {
  const kind = [facts.category, facts.rarity, ...facts.tags].filter(Boolean).join(", ");
  const stats = facts.stats
    .filter((stat) => stat.promptVisible)
    .map((stat) => (stat.text !== undefined ? `${stat.label} ${stat.text}` : stat.label))
    .join(", ");
  return stats ? `${kind}; ${stats}` : kind;
}
