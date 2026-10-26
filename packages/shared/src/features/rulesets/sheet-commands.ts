// Every `[sheet: ...]` command in one reply, applied to the party's live state.
//
// The Game Master says what it wants to happen and the Engine decides whether it may: each command
// is checked against the state the ones before it left behind, applied or refused, and the tag is
// rewritten with the outcome. A refusal is kept in the reply on purpose — the narration has to be
// able to see that the spell was never cast.

import {
  RULESET_PARTY_KEY,
  rulesetPartyDefinition,
  type RulesetCatalogEntriesById,
  type RulesetDefinition,
  type RulesetSheetBuild,
} from "../../schemas/ruleset.schema.js";
import { defaultRulesetSheetBuild, type RulesetSheetItem } from "./sheet-math.js";
import { rulesetMaterialFor } from "./material.js";
import { normalizeCharacterLookupName } from "../../utils/character-lookup-name.js";
import {
  createSheetCommandTagRegex,
  joinSheetSummary,
  parseSheetCommandTagBody,
  serializeSheetCommandTag,
  type SheetCommandTagOutcome,
} from "../../utils/sheet-command-tag.js";
import {
  applyRulesetRestRecoveries,
  applyRulesetSheetOp,
  rulesetRestDiceEntries,
  rulesetRestRecoveries,
  rulesetRestExtraDie,
  planRulesetUse,
  type RulesetLiveState,
  type RulesetLiveStates,
  type RulesetSheetOp,
  type RulesetSheetOpResult,
  rulesetUseHealOutsideFight,
  rulesetUseKeptCall,
  rulesetUseKeptForm,
  rulesetPoolNowText,
  readRulesetLive,
} from "./live-state.js";

/** A priced material a cast used up (1.775): whose, and how many out of which of their stacks. */
export interface RulesetMaterialTaken {
  who: string;
  stacks: Array<{ id: string; count: number }>;
}

export interface SheetCommandCard {
  name: string;
  build: RulesetSheetBuild;
  /** What they carry, which a rest's dice read for an `itemStat` (1.337): Pell's Teapot. */
  items?: ReadonlyArray<RulesetSheetItem>;
}

export interface SheetCommandContext {
  definition: RulesetDefinition;
  /** Null means a stored party sheet could not be read. */
  partyBuild?: RulesetSheetBuild | null;
  cards: SheetCommandCard[];
  /** The player's own card, which a command that names nobody applies to. */
  playerName: string | null;
  /** Re-evaluate a saved reply after its permanent build write failed. */
  advancementRefusal?: "save-failed";
  live: RulesetLiveStates;
  /** The entries of the catalogs the party's rows point at, which the `use` command needs to know
   *  what an ability costs. Absent, every `use` is refused as naming nothing the Engine knows. */
  catalogs?: RulesetCatalogEntriesById;
  /** What a rest rolls for a condition that lowers health's maximum (1.260). Absent, its dice count
   *  their average. */
  roll?: (sides: number) => number;
  /** The cards of those no longer with the party (taken out of it, their card kept): a command to
   *  the whole party passes them by, as it does the dead. Named, they are still found. */
  away?: readonly string[];
}

export interface SheetCommandOutcome {
  who: string;
  ok: boolean;
  reason?: string;
  now?: string;
  /** The tag as it was written back into the reply. */
  tag: string;
}

/** One reply's worth of bookkeeping. Past this, a model is looping rather than narrating. */
const MAX_SHEET_COMMANDS = 40;
/** The word that addresses the whole party at once. */
const PARTY_TARGET = "party";
/** A party summary is capped again by the tag writer; this keeps the join itself bounded. */

type TargetMatch =
  { cards: SheetCommandCard[]; who: string } | { refusal: "unknown-character" | "ambiguous-character" };

/** Apply every sheet command in a reply, in order, and rewrite each tag with what happened.
 *  Pure: the context and its live state are never mutated, and nothing here throws. */
export function applySheetCommandTags(
  content: string,
  ctx: SheetCommandContext,
): {
  content: string;
  live: RulesetLiveStates;
  changed: boolean;
  outcomes: SheetCommandOutcome[];
  builds: Record<string, RulesetSheetBuild>;
  /** Each rest a character took, by card name: what a rest does to the items they carry follows it. */
  rests: Array<{ who: string; rest: string }>;
  /** The priced materials a cast used up (1.775), by card name and the stacks they came out of. */
  materials: RulesetMaterialTaken[];
} {
  const builds: Record<string, RulesetSheetBuild> = {};
  const partyDefinition = rulesetPartyDefinition(ctx.definition);
  let partyBuild =
    ctx.partyBuild === null
      ? null
      : (ctx.partyBuild ?? (partyDefinition ? defaultRulesetSheetBuild(partyDefinition) : null));
  const cards = ctx.cards.map((card) => ({ ...card }));
  const live: RulesetLiveStates = { ...ctx.live };
  const outcomes: SheetCommandOutcome[] = [];
  const rests: Array<{ who: string; rest: string }> = [];
  const materials: RulesetMaterialTaken[] = [];
  /** What each card's casts have used up this reply, by place in its items. */
  const usedUp = new Map<string, Record<string, number>>();
  let changed = false;
  let seen = 0;

  const byName = new Map<string, SheetCommandCard[]>();
  for (const card of cards) {
    const key = normalizeCharacterLookupName(card.name);
    const group = byName.get(key);
    if (group) group.push(card);
    else byName.set(key, [card]);
  }
  const playerKey = ctx.playerName ? normalizeCharacterLookupName(ctx.playerName) : null;
  const playerCard = (playerKey !== null ? byName.get(playerKey)?.[0] : undefined) ?? null;

  const away = new Set((ctx.away ?? []).map((name) => normalizeCharacterLookupName(name)));
  /** Dead by the ruleset's dying saves: every failure it allows marked. */
  const deadOnSheet = (card: SheetCommandCard): boolean => {
    const failures = ctx.definition.combat?.dying?.failures;
    if (!failures) return false;
    const key = normalizeCharacterLookupName(card.name);
    const track = readRulesetLive(ctx.definition, card.build, live[key], card.items).tracks.find(
      (entry) => entry.id === failures,
    );
    return !!track && track.max > 0 && track.value >= track.max;
  };
  const findTargets = (who: string | undefined): TargetMatch => {
    if (who === undefined)
      return playerCard ? { cards: [playerCard], who: playerCard.name } : { refusal: "unknown-character" };
    const key = normalizeCharacterLookupName(who);
    if (key === PARTY_TARGET) {
      // One card per live-state key. Two cards under one name share one entry, so applying to both
      // would charge that character twice for one command. The same tie rule as a named target:
      // the player's own card stands for a name it shares, and any other shared name is left out
      // because the game cannot tell whose sheet it would be.
      // Nor anyone gone from the party or dead on their sheet (laptop pass 6, 2026-10-26: a party
      // long rest put two fallen companions back on their feet, death saves cleared).
      const members = [...byName.entries()].flatMap(([groupKey, group]) =>
        (group.length === 1 || groupKey === playerKey) && !away.has(groupKey) && !deadOnSheet(group[0]!)
          ? [group[0]!]
          : [],
      );
      return members.length > 0 ? { cards: members, who: PARTY_TARGET } : { refusal: "unknown-character" };
    }
    const group = byName.get(key) ?? [];
    if (group.length === 0) return { refusal: "unknown-character" };
    // Two cards under one name: only the player's own card breaks the tie, because that is the one
    // the game knows it has. Anything else would be picking a character at random.
    if (group.length > 1) {
      return key === playerKey && playerCard
        ? { cards: [playerCard], who: playerCard.name }
        : { refusal: "ambiguous-character" };
    }
    return { cards: [group[0]!], who: group[0]!.name };
  };

  const store = (key: string, state: RulesetLiveState) => {
    if (Object.keys(state).length > 0) live[key] = state;
    else delete live[key];
    changed = true;
  };

  // `use` is several spends at once, so it is all or nothing: every step goes onto a working copy
  // and the first refusal refuses the whole command, with the sheet exactly as it was.
  const useOn = (card: SheetCommandCard, key: string, op: Extract<RulesetSheetOp, { op: "use" }>) => {
    const plan = planRulesetUse(ctx.definition, card.build, live[key], ctx.catalogs ?? {}, op);
    if (!plan.ok) return { ok: false, reason: plan.reason } as const;
    // The creature a call that stays calls (1.788), named before anything is paid for it.
    const kept = rulesetUseKeptCall(ctx.definition, card.build, ctx.catalogs ?? {}, op);
    if (kept && !kept.ok) return kept;
    // The shape one that changes its user's own keeps them in (1.791), named the same way.
    const shaped = rulesetUseKeptForm(ctx.definition, card.build, ctx.catalogs ?? {}, op, live[key], card.items);
    if (shaped && !shaped.ok) return shaped;
    // A priced material (1.775) carried, and taken only once everything else is paid.
    const used = usedUp.get(key) ?? {};
    const material = plan.material ? rulesetMaterialFor(ctx.definition, plan.material, card.items, used) : undefined;
    if (material === null) return { ok: false, reason: `no-material: ${plan.material!.label}` } as const;
    let state = live[key] as RulesetLiveState | undefined;
    const paid: string[] = [];
    for (const step of plan.steps) {
      const result = applyRulesetSheetOp(ctx.definition, card.build, state, step.op, ctx.roll, card.items);
      if (!result.ok) return result;
      state = result.live;
      paid.push(`${step.label} ${result.now}`);
    }
    // What it heals its user outside a fight (1.773): Second Wind's 1d10 plus the fighter's level.
    const healed = rulesetUseHealOutsideFight(
      ctx.definition,
      card.build,
      ctx.catalogs ?? {},
      op.name,
      state ?? live[key],
      ctx.roll,
      card.items,
    );
    if (healed && !healed.ok && healed.reason !== "cannot-heal") return healed;
    if (healed?.ok) {
      state = healed.live;
      paid.push(`${plan.label} ${healed.now}`);
    }
    if (material && plan.material?.consumed) {
      const stacks = material.flatMap(({ index, count }) => {
        const stack = card.items?.[index]?.stack;
        used[index] = (used[index] ?? 0) + count;
        return stack ? [{ id: stack.id, count }] : [];
      });
      usedUp.set(key, used);
      materials.push({ who: card.name, stacks });
      paid.push(`${plan.material.label} used up`);
    }
    // Kept on the sheet (1.788), in place of whatever it called before: it joins every fight its
    // user is in until it is dismissed or killed.
    if (kept) {
      const before = (state ?? live[key] ?? {}) as RulesetLiveState;
      state = { ...before, called: { ...before.called, [kept.entry]: kept.as } };
      paid.push(`${kept.as || plan.label} called, and stays`);
    }
    // Kept on the sheet too (1.791), in place of any shape before it: they start every fight in it
    // until it ends, with the form's own health.
    if (shaped) {
      state = { ...((state ?? live[key] ?? {}) as RulesetLiveState), shaped: shaped.shaped };
      paid.push(`in the shape of ${shaped.shaped.as}`);
    }
    // An ability that costs nothing, such as a cantrip or a passive feature, is fine and changes
    // nothing: it is the Game Master saying what happened, not asking to spend.
    if (paid.length === 0) return { ok: true, live: {}, now: `${plan.label}: no cost` } as const;
    // Only a material used up, on a sheet with nothing live yet.
    if (!state) return { ok: true, live: {}, now: paid.join(", ") } as const;
    store(key, state);
    return { ok: true, live: state, now: paid.join(", ") } as const;
  };

  const partyExtra = (restId: string): { extra?: { sides: number; add: number } } => {
    const rest = ctx.definition.rests.find(
      (entry) => entry.id === restId || entry.label.trim().toLowerCase() === restId.trim().toLowerCase(),
    );
    let best: { sides: number; add: number } | null = null;
    for (const member of rulesetRestDiceEntries(rest?.dice).some((entry) => entry.extra) ? ctx.cards : []) {
      const extra = rulesetRestExtraDie(
        ctx.definition,
        member.build,
        rest!.id,
        member.items,
        live[normalizeCharacterLookupName(member.name)],
      );
      if (extra && (!best || extra.sides > best.sides || (extra.sides === best.sides && extra.add > best.add)))
        best = extra;
    }
    return best ? { extra: best } : {};
  };

  // A feature the rest offers as it ends (1.774), named on the tag: the rest stands whatever it does,
  // and its words say what the feature gave back or why it gave nothing.
  const restEnds = (
    card: SheetCommandCard,
    op: Extract<RulesetSheetOp, { op: "rest" }>,
    rested: Extract<RulesetSheetOpResult, { ok: true }>,
  ): RulesetSheetOpResult => {
    const rest = ctx.definition.rests.find(
      (entry) => entry.id === op.rest || entry.label.trim().toLowerCase() === op.rest.trim().toLowerCase(),
    );
    const wanted = op.use!.trim().toLowerCase();
    const offer = rest
      ? rulesetRestRecoveries(ctx.definition, card.build, rested.live, ctx.catalogs ?? {}, rest.id).find(
          (one) => one.name.trim().toLowerCase() === wanted,
        )
      : undefined;
    if (!rest || !offer) return { ...rested, now: `${rested.now}; ${op.use}: nothing it can give back now` };
    const used = applyRulesetRestRecoveries(
      ctx.definition,
      card.build,
      rested.live,
      ctx.catalogs ?? {},
      rest.id,
      [{ name: offer.name, recover: op.recover?.length ? [...op.recover] : offer.picks }],
      ctx.roll,
      card.items,
    );
    if (!used.ok) return { ...rested, now: `${rested.now}; ${offer.name} refused: ${used.reason}` };
    return { ...rested, live: (used.live ?? {}) as RulesetLiveState, now: [rested.now, ...used.now].join("; ") };
  };

  const applyTo = (card: SheetCommandCard, op: RulesetSheetOp): RulesetSheetOpResult => {
    const key = normalizeCharacterLookupName(card.name);
    try {
      if (op.op === "advance" && ctx.advancementRefusal) return { ok: false, reason: ctx.advancementRefusal };
      if (op.op === "use") return useOn(card, key, op);
      // Dice spent on a rest (1.335) take the party's best extra die (Song of Rest), whoever has it.
      const given = op.op === "rest" && op.dice && !op.extra ? { ...op, ...partyExtra(op.rest) } : op;
      let result = applyRulesetSheetOp(ctx.definition, card.build, live[key], given, ctx.roll, card.items);
      if (result.ok && op.op === "rest" && op.use) result = restEnds(card, op, result);
      if (result.ok) {
        store(key, result.live);
        if (result.build) {
          card.build = result.build;
          builds[key] = result.build;
        }
      }
      if (result.ok && op.op === "rest") rests.push({ who: card.name, rest: op.rest });
      return result;
    } catch {
      // A turn is never lost to its bookkeeping; an impossible command is simply refused.
      return { ok: false, reason: "malformed" };
    }
  };

  const rewritten = content.replace(createSheetCommandTagRegex(), (_match, rawBody: string) => {
    const body = rawBody ?? "";
    const parsed = parseSheetCommandTagBody(body);
    // Once the target is known the tag says so, even where the Game Master left it implied: the
    // saved reply is the record, and "who did this happen to" is the first thing it has to answer.
    const record = (who: string, outcome: SheetCommandTagOutcome, named?: string): string => {
      const tag = serializeSheetCommandTag(
        { op: parsed.op, sheet: parsed.sheet, who: named ?? parsed.who, raw: body },
        outcome,
      );
      outcomes.push({
        who,
        ok: outcome.ok,
        ...(outcome.ok ? { now: outcome.now } : { reason: outcome.reason }),
        tag,
      });
      return tag;
    };

    seen += 1;
    const named = parsed.sheet === "party" ? "party" : (parsed.who ?? ctx.playerName ?? "");
    if (seen > MAX_SHEET_COMMANDS) return record(named, { ok: false, reason: "too-many" });
    if (!parsed.op) return record(named, { ok: false, reason: "malformed" });

    if (parsed.sheet !== undefined) {
      if (parsed.sheet !== "party" || !partyDefinition || !partyBuild)
        return record("party", { ok: false, reason: "unknown-sheet" });
      if (parsed.who !== undefined) return record("party", { ok: false, reason: "malformed" });
      const op = parsed.op;
      if (op.op !== "spend" && op.op !== "restore" && !(op.op === "advance" && "field" in op))
        return record("party", { ok: false, reason: "not-allowed" });
      if (op.op === "advance" && ctx.advancementRefusal)
        return record("party", { ok: false, reason: ctx.advancementRefusal });
      let result: RulesetSheetOpResult;
      try {
        result = applyRulesetSheetOp(partyDefinition, partyBuild, live[RULESET_PARTY_KEY], op);
      } catch {
        // As applyTo: one bad command is refused, never the whole turn.
        return record("party", { ok: false, reason: "malformed" });
      }
      if (result.ok) {
        store(RULESET_PARTY_KEY, result.live);
        if (result.build) builds[RULESET_PARTY_KEY] = partyBuild = result.build;
      }
      return record("party", result);
    }

    const targets = findTargets(parsed.who);
    if ("refusal" in targets) return record(named, { ok: false, reason: targets.refusal });

    // A pool left out is health's, where the ruleset keeps health in a pool.
    const health = ctx.definition.combat?.health;
    const healthPool = health && "pool" in health ? health.pool : undefined;
    if ("pool" in parsed.op && !parsed.op.pool && !healthPool)
      return record(named, { ok: false, reason: "unknown-pool" });
    const op = "pool" in parsed.op && !parsed.op.pool ? { ...parsed.op, pool: healthPool! } : parsed.op;
    // The saved reply says which pool it was.
    parsed.op = op;
    // Damage or a spend whose `now` is what the sheet already reads was already paid: by the fight
    // the reply follows, or a command before it. Paying it again would count it twice (a crossbow
    // hit a fight already took, written again after the fight was left).
    const paidAlready = (card: SheetCommandCard): RulesetSheetOpResult | null => {
      if (!parsed.claimed || (op.op !== "damage" && op.op !== "spend") || !("pool" in op)) return null;
      const reads = rulesetPoolNowText(
        ctx.definition,
        card.build,
        live[normalizeCharacterLookupName(card.name)],
        op.pool,
        card.items,
      );
      const value = (text: string) => /^(-?\d+)\s*\/\s*(\d+)/.exec(text.trim())?.slice(1, 3).join("/");
      const said = value(parsed.claimed);
      if (!reads || !said || value(reads) !== said) return null;
      return {
        ok: true,
        live: (live[normalizeCharacterLookupName(card.name)] ?? {}) as RulesetLiveState,
        now: `${reads} (already paid)`,
      };
    };
    const results = targets.cards.map((card) => ({ card, result: paidAlready(card) ?? applyTo(card, op) }));
    // One target reads as the value alone; a party tag has to say whose value each one is.
    const many = results.length > 1;
    const applied = results.flatMap((entry) =>
      entry.result.ok ? [many ? `${entry.card.name} ${entry.result.now}` : entry.result.now] : [],
    );
    // A party command can work for some members and not for others (a spend only some can afford).
    // The record names the ones it was refused for too, or the saved reply would read as if it had
    // applied to everyone.
    const refused = results.flatMap((entry) =>
      entry.result.ok ? [] : [`${entry.card.name} refused (${entry.result.reason})`],
    );
    if (applied.length === 0) {
      const first = results.find((entry) => !entry.result.ok);
      return record(
        targets.who,
        { ok: false, reason: first && !first.result.ok ? first.result.reason : "malformed" },
        targets.who,
      );
    }
    return record(targets.who, { ok: true, now: joinSheetSummary(applied, undefined, refused) }, targets.who);
  });

  return { content: rewritten, live, changed, outcomes, rests, materials, builds };
}
