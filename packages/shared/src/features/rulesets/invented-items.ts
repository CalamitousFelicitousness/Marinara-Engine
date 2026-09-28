// ──────────────────────────────────────────────
// Game Mode rulesets: items the Game Master invents
//
// A story needs things no catalog lists: a named blade, a strange charm. The Game Master proposes one
// in its inventory tag, and the Engine makes it an item of the ruleset: every part read against the
// ruleset's own words, what it does not have left out, a rarity it does not have made its lowest,
// and every number stat held to the most `rarityCaps` allows at that rarity. Each change is said, so
// the Game Master reads it in its answer and the player in the item's details. The item is kept on
// the game, and every stack of it, the screen and the Game Master read that one item.
// ──────────────────────────────────────────────
import {
  rulesetCatalogItemSchema,
  rulesetItemIssues,
  type RulesetCatalogItem,
  type RulesetDefinition,
  type RulesetItemStat,
} from "../../schemas/ruleset.schema.js";
import type { GameInventoryItemProposal } from "../../utils/game-inventory-stacks.js";

/** What a stack of an invented item has before the invented item's id. */
export const RULESET_INVENTED_ITEM_PREFIX = "invented:";
/** The most items one game keeps invented. */
export const RULESET_INVENTED_ITEMS_MAX = 200;
/** The most changes one invented item keeps said about it. */
const NOTES_MAX = 8;
const NOTE_MAX_LENGTH = 200;
const NAME_MAX_LENGTH = 120;
const SUMMARY_MAX_LENGTH = 300;
const ID_MAX_LENGTH = 60;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Dice as an invented item may give them: `1d8`, `2d6+1`. */
const DICE_PATTERN = /^\d{1,3}d\d{1,4}(?:[+-]\d{1,4})?$/i;

/** One item the Game Master invented in this game. */
export interface RulesetInventedItem {
  /** A stack of it has `item: "invented:<id>"`. */
  id: string;
  name: string;
  item: RulesetCatalogItem;
  summary?: string;
  /** What the Engine changed from the proposal. */
  notes?: string[];
}

/** The `item` a stack of an invented item has. */
export function rulesetInventedItemRef(id: string): string {
  return `${RULESET_INVENTED_ITEM_PREFIX}${id}`;
}

/** Any text as one plain line: no line breaks, control characters or square brackets. */
function plainLine(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** A short, stable fingerprint, for a name with nothing to spell an id from (FNV-1a). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** A name as an invented item's id: its Latin letters and digits joined by dashes ("Mourning Edge"
 *  is `mourning-edge`), or a fingerprint for a name with none. `taken` ids get a number after them. */
export function rulesetInventedItemId(name: string, taken: (id: string) => boolean = () => false): string {
  const spelled = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ID_MAX_LENGTH - 4)
    .replace(/-+$/, "");
  const base = spelled || `item-${fingerprint(name.toLowerCase())}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!taken(next)) return next;
  }
}

/** One of the ruleset's words (a category, rarity, tag, stat or slot) a proposal names by its id or
 *  its label, in any case, with spaces, dashes and underscores alike. */
function wordNamed<T extends { id: string; label: string }>(
  words: readonly T[] | undefined,
  text: string,
): T | undefined {
  const key = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "_");
  const wanted = key(text);
  return words?.find((word) => key(word.id) === wanted) ?? words?.find((word) => key(word.label) === wanted);
}

/** A stat's value as its type reads it, or why it cannot be. */
function readStat(stat: RulesetItemStat, text: string): { value: string | number | boolean } | { wrong: string } {
  const raw = text.trim();
  switch (stat.type) {
    case "number": {
      const value = Number(raw.replace(/^\+/, ""));
      return raw !== "" && Number.isFinite(value) ? { value } : { wrong: "a number" };
    }
    case "boolean": {
      const word = raw.toLowerCase();
      if (["yes", "true", "1", "on"].includes(word)) return { value: true };
      if (["no", "false", "0", "off"].includes(word)) return { value: false };
      return { wrong: "yes or no" };
    }
    case "enum": {
      const key = raw.toLowerCase();
      const value =
        stat.values.find((each) => each.toLowerCase() === key) ??
        stat.values.find((each) => stat.valueLabels?.[each]?.toLowerCase() === key);
      return value !== undefined ? { value } : { wrong: `one of ${stat.values.join(", ")}` };
    }
    case "dice":
      return DICE_PATTERN.test(raw) ? { value: raw.toLowerCase() } : { wrong: "dice such as 1d8" };
    case "text":
      return raw ? { value: plainLine(raw, stat.maxLength) } : { wrong: "text" };
  }
}

/**
 * An item made from the Game Master's proposal, read against the ruleset's `items` block. `like` is
 * the catalog item it starts from, already found by the caller: anything the proposal gives replaces
 * that part. Null when the ruleset has no items block to write an item in.
 */
export function inventRulesetItem(
  definition: RulesetDefinition,
  proposal: Omit<GameInventoryItemProposal, "name">,
  like?: RulesetCatalogItem,
): { item: RulesetCatalogItem; notes: string[] } | null {
  const block = definition.items;
  if (!block) return null;
  const notes: string[] = [];

  const named = proposal.category !== undefined ? wordNamed(block.categories, proposal.category) : undefined;
  let category = named?.id ?? like?.category;
  if (!category) {
    const first = block.categories[0]!;
    category = first.id;
    notes.push(
      proposal.category !== undefined
        ? `No category "${plainLine(proposal.category, 40)}", so it is in ${first.label}.`
        : `No category was given, so it is in ${first.label}.`,
    );
  } else if (proposal.category !== undefined && !named) {
    notes.push(
      `No category "${plainLine(proposal.category, 40)}", so it stays in ${wordNamed(block.categories, category)?.label ?? category}.`,
    );
  }

  let rarity: string | undefined;
  if (block.rarities?.length) {
    const lowest = block.rarities[0]!;
    const namedRarity = proposal.rarity !== undefined ? wordNamed(block.rarities, proposal.rarity) : undefined;
    rarity = namedRarity?.id ?? (proposal.rarity === undefined ? like?.rarity : undefined);
    if (!rarity) {
      rarity = lowest.id;
      notes.push(
        proposal.rarity !== undefined
          ? `No rarity "${plainLine(proposal.rarity, 40)}", so it is ${lowest.label}.`
          : `No rarity was given, so it is ${lowest.label}.`,
      );
    }
  }

  let tags = like?.tags ? [...like.tags] : [];
  if (proposal.tags) {
    tags = [];
    for (const given of proposal.tags) {
      const tag = wordNamed(block.tags, given);
      if (!tag) notes.push(`No tag "${plainLine(given, 40)}", so it was left out.`);
      else if (!tags.includes(tag.id)) tags.push(tag.id);
    }
  }

  const stats: Record<string, string | number | boolean> = { ...(like?.stats ?? {}) };
  for (const [given, text] of Object.entries(proposal.stats ?? {})) {
    const stat = wordNamed(block.stats, given);
    if (!stat) {
      notes.push(`No stat "${plainLine(given, 40)}", so it was left out.`);
      continue;
    }
    const read = readStat(stat, text);
    if ("wrong" in read) {
      notes.push(`${stat.label} takes ${read.wrong}, so "${plainLine(text, 40)}" was left out.`);
      continue;
    }
    let value = read.value;
    if (stat.type === "number" && typeof value === "number") {
      const whole = stat.integer ? Math.round(value) : value;
      if (whole !== value) notes.push(`${stat.label} takes whole numbers, so it is ${whole}.`);
      const held = Math.min(stat.max, Math.max(stat.min, whole));
      if (held !== whole) notes.push(`${stat.label} runs from ${stat.min} to ${stat.max}, so it is ${held}.`);
      value = held;
    }
    stats[stat.id] = value;
  }
  // Every number stat, the ones it started from included, is held to the most its rarity allows.
  const caps = block.rarityCaps?.find((cap) => cap.rarity === rarity)?.stats ?? {};
  const rarityLabel = block.rarities?.find((each) => each.id === rarity)?.label ?? rarity;
  for (const [id, most] of Object.entries(caps)) {
    const value = stats[id];
    if (typeof value !== "number" || value <= most) continue;
    const label = block.stats?.find((stat) => stat.id === id)?.label ?? id;
    notes.push(`${label} is ${most} instead of ${value}, the most at ${rarityLabel}.`);
    stats[id] = most;
  }

  let slots: Record<string, number> = { ...(like?.slots ?? {}) };
  if (proposal.slots) {
    slots = {};
    for (const [given, text] of Object.entries(proposal.slots)) {
      const slot = wordNamed(block.slots, given);
      if (!slot) {
        notes.push(`No slot "${plainLine(given, 40)}", so it was left out.`);
        continue;
      }
      const count = Number.parseInt(text.trim() || "1", 10);
      const taken = Number.isFinite(count) && count >= 1 ? Math.min(count, slot.count) : 1;
      if (taken !== count) notes.push(`A character has ${slot.count} ${slot.label}, so it takes ${taken}.`);
      slots[slot.id] = taken;
    }
  }

  let binds = like?.binds;
  if (proposal.binds !== undefined) {
    const word = proposal.binds.trim().toLowerCase();
    const wanted = ["no", "false", "0", "none"].includes(word) ? undefined : word === "cursed" ? { cursed: true } : {};
    if (wanted && !block.binding) notes.push("This ruleset binds nothing, so it does not bind.");
    binds = wanted && block.binding ? wanted : undefined;
  }

  const item: RulesetCatalogItem = {
    category,
    ...(rarity ? { rarity } : {}),
    ...(tags.length ? { tags } : {}),
    ...(Object.keys(stats).length ? { stats } : {}),
    ...(Object.keys(slots).length ? { slots } : {}),
    ...(like?.stack !== undefined ? { stack: like.stack } : {}),
    ...(binds
      ? { binds: { ...(like?.binds?.restriction ? { restriction: like.binds.restriction } : {}), ...binds } }
      : {}),
  };
  return { item, notes: notes.slice(0, NOTES_MAX).map((note) => plainLine(note, NOTE_MAX_LENGTH)) };
}

/** A proposal's name and summary as the invented item keeps them. */
export function rulesetInventedItemText(proposal: { name: string; summary?: string }): {
  name: string;
  summary?: string;
} {
  const name = plainLine(proposal.name, NAME_MAX_LENGTH);
  const summary = proposal.summary !== undefined ? plainLine(proposal.summary, SUMMARY_MAX_LENGTH) : "";
  return { name, ...(summary ? { summary } : {}) };
}

/**
 * The game's invented items as saved (chat metadata `gameInventedItems`), each one the ruleset can
 * still read: a well-formed id and name, and an item every part of which is still one of the ruleset's
 * words. One the ruleset has since changed under is left out, and its stacks read as plain names.
 */
export function readRulesetInventedItems(definition: RulesetDefinition, raw: unknown): RulesetInventedItem[] {
  if (!Array.isArray(raw)) return [];
  const read: RulesetInventedItem[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (read.length >= RULESET_INVENTED_ITEMS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const { id, name, item, summary, notes } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length > ID_MAX_LENGTH || !ID_PATTERN.test(id) || ids.has(id)) continue;
    if (typeof name !== "string") continue;
    const text = rulesetInventedItemText({ name, ...(typeof summary === "string" ? { summary } : {}) });
    if (!text.name) continue;
    const parsed = rulesetCatalogItemSchema.safeParse(item);
    if (!parsed.success || rulesetItemIssues(definition, parsed.data).length > 0) continue;
    const said = Array.isArray(notes)
      ? notes
          .filter((note): note is string => typeof note === "string")
          .map((note) => plainLine(note, NOTE_MAX_LENGTH))
          .filter(Boolean)
          .slice(0, NOTES_MAX)
      : [];
    ids.add(id);
    read.push({ id, ...text, item: parsed.data, ...(said.length ? { notes: said } : {}) });
  }
  return read;
}
