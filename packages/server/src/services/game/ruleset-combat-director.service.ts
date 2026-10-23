// ──────────────────────────────────────────────
// Game: the director's third style, a fight the ruleset resolves itself
// ──────────────────────────────────────────────
// The same ledger as the other two styles: one storage row, one revision, one request-id guard and
// one per-chat queue. Only what happens inside a step is different, and all of it goes through the
// pure resolver in `@marinara-engine/shared`: the menu decides legality, the dice come from the
// session's own seed and cursor, and everything a party member spends or loses is written through
// the sheet's own rules.
//
// Everything here is pure over `(definition, state)` so a regression can drive a whole fight with
// no database and no network. The two things that are not pure, reading the ruleset and writing the
// party's live sheet state back, live in the route.

import {
  rulesetActionAvailable,
  parseRulesetCombatDice,
  advanceRulesetTurn,
  applyRulesetCombatChoice,
  assignCombatTactics,
  combatMindWithHint,
  chooseRankedCombatCandidate,
  rankCombatCandidates,
  type CombatAiScoreParts,
  clampRulesetStatBlock,
  createRulesetEncounter,
  currentRulesetActor,
  deterministicRng,
  findRulesetCreature,
  fillRulesetSheetChoices,
  generateTacticalBattlefield,
  madeTacticalBattlefield,
  foothillElevation,
  holdRulesetCombatant,
  holdRulesetSheetHealth,
  settleRulesetFledFight,
  rulesetLetGoOfHeld,
  rulesetReleaseHeldGround,
  type RulesetHeldGroundRelease,
  normalizeCharacterLookupName,
  normalizeGameDifficulty,
  normalizeTacticalEnvironment,
  normalizeTacticalFormation,
  placeSpawns,
  readRulesetLive,
  rulesetHitChances,
  rulesetSaveFailChances,
  rulesetSequenceForecastAgainst,
  rulesetAimCells,
  rulesetAnswerDeflects,
  rulesetItemSlotPayment,
  rulesetBlowKind,
  rulesetCombatant,
  rulesetCreatureKind,
  rulesetActiveConditions,
  rulesetItemEffectFacts,
  rulesetCombatConditions,
  rulesetZoneConditions,
  rulesetCombatHealth,
  rulesetDefenseAgainst,
  rulesetForecastsByTarget,
  rulesetConditionIcons,
  rulesetCombatHide,
  rulesetCombatOptions,
  rulesetCostSteps,
  rulesetAverageAmount,
  rulesetAverageDamage,
  rulesetImmuneToCondition,
  rulesetAreaTargets,
  rulesetAimedCells,
  rulesetCombatIsPool,
  rulesetPoolChance,
  rulesetDamageAverage,
  planRulesetCombatCost,
  rulesetActionUses,
  rulesetInnateSlot,
  rulesetInnateSlotsLeft,
  rulesetUsesKey,
  rulesetCombatRoller,
  rulesetCombatStanding,
  rulesetHiddenFrom,
  rulesetStandardName,
  rulesetContestChance,
  rulesetProposedCreatureSchema,
  rulesetEncounterOutcome,
  rulesetEncounterSummary,
  rulesetOptionTargets,
  rulesetAroundTargets,
  rulesetReactionPointsAtSource,
  rulesetReactionTarget,
  rulesetFallTargets,
  rulesetPositionOf,
  rulesetLightAt,
  rulesetWalkingDistances,
  rulesetFootprint,
  rulesetFootprintAt,
  rulesetSees,
  rulesetSpanOf,
  rulesetSqueezeAt,
  rulesetBehaviorAnchor,
  rulesetGapFrom,
  rulesetDragging,
  rulesetPushPath,
  rulesetActionReach,
  rulesetGap,
  rulesetAtBoardEdge,
  rulesetInCells,
  rulesetCombatantBehavior,
  rulesetCombatantRole,
  rulesetActionIsSpell,
  rulesetCombatantMind,
  rulesetAirborne,
  RULESET_FLY_UP_OPTION,
  shiftCombatTemperament,
  withRulesetPlanMemo,
  withOwnRulesetPlanMemo,
  rulesetSheetBuildsByName,
  rulesetCardCreaturesByName,
  readProposedRulesetSheet,
  restrictRulesetSheetEntries,
  RULESET_PROPOSED_SHEET_REPLACES,
  rulesetProposedStatBlock,
  rulesetTierStatBlock,
  rulesetWindowMoment,
  rulesetZonesShown,
  rulesetBoardShading,
  rulesetOpenLairWindow,
  rulesetStandingAtStart,
  type RulesetStandingZone,
  rulesetWindowOptions,
  rulesetAreaCells,
  rulesetZoneCatches,
  rulesetZoneCells,
  RULESET_LAIR_OPTION_PREFIX,
  RULESET_MOVE_OPTION,
  RULESET_ZONE_OPTION_PREFIX,
  RULESET_ZONE_TURN_OPTION_PREFIX,
  RULESET_PASS_OPTION,
  RULESET_STAND_OPTION,
  RULESET_CLIMB_OUT_OPTION,
  type CombatAiCandidate,
  type Combatant,
  type CombatDecisionOption,
  type DirectedCommand,
  type DirectedRulesetEvent,
  type DirectedRulesetReason,
  type DirectedRulesetCombatant,
  type DirectedRulesetOption,
  rulesetPaidLevel,
  type DirectedRulesetView,
  type RulesetBoardLight,
  type RulesetCatalogEntriesById,
  type RulesetCombatAction,
  type RulesetCombatApplies,
  type RulesetCombatChoice,
  type RulesetCombatEvent,
  type RulesetCombatOption,
  type RulesetCombatant,
  type RulesetCombatantInput,
  type RulesetCombatBehavior,
  type RulesetDefinition,
  type RulesetTargetPreference,
  type RulesetEncounterState,
  type RulesetHeldGround,
  type RulesetLiveState,
  type RulesetLiveStates,
  type TacticalBattlefieldBrief,
  type TacticalMadeBattlefield,
  type TacticalGrid,
  type CombatMind,
  type CombatOrders,
  type CombatTactics,
  type RulesetSheetItem,
  rulesetCombatantFlying,
  withRulesetSheetEvaluationCache,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { combatDirectorView, type CombatDirectorState } from "./combat-director.service.js";

/** How many events a session keeps. A screen prints the tail and asks for nothing older, so the
 *  ledger row stays small however long a fight runs.
 *  ponytail: a fixed window. A fight that needs its whole history on screen wants the events in
 *  their own paged store, which is the upgrade path. */
export const RULESET_COMBAT_EVENT_LIMIT = 200;

/** How many lines the opponents' own build is allowed to leave behind. */
const RULESET_ADJUSTMENT_LIMIT = 60;

/** How many actions one turn of an actor nobody controls may take before the turn is ended anyway.
 *  Budgets already bound it; this is the belt beside the braces. */
const RULESET_TURN_ACTION_LIMIT = 12;

/** The fight itself, as the director's ledger stores it. Plain JSON by design: it is persisted, read
 *  back and resolved from exactly as it was left. */
export interface RulesetFightState {
  encounter: RulesetEncounterState;
  /** One per event ever produced, so a client prints only what it has not seen. */
  eventSeq: number;
  events: Array<{ seq: number; event: DirectedRulesetEvent }>;
  /** Who plays each party member. An opponent is never in here. */
  controllers: Record<string, "manual" | "ai">;
  /** The opponents the client marked as bosses, which is what routes a turn to the Game Master. */
  bosses: string[];
  /** The named and the brilliant opponents (combat AI P9), whose turns go to the Game Master too in a
   *  game that asks it to play them. */
  thinkers?: string[];
  /** Every clamp and every fallback the opponents were built with, in plain words. */
  adjustments: string[];
  /** The loot table each opponent built from the bestiary carries, by combatant id: what a win rolls. */
  lootTables?: Record<string, string>;
  /** What the turn being played has done so far, kept while a window it opened waits on a person:
   *  the rest of the turn picks up from here rather than from its start (re-test 11: an archer that
   *  shot, waited on Elara's Shield, then walked in as though it never had). */
  turnSoFar?: {
    actorId: string;
    round: number;
    turn: number;
    shotFromAfar: "stay" | "kite" | false;
    defended: boolean;
    /** Whether it has struck up close this turn (combat AI A4), and may get out again after. */
    struckClose?: boolean;
  };
}

export type RulesetCommandResult = { ok: true } | { ok: false; error: string; code: string };

const refuse = (error: string, code: string): RulesetCommandResult => ({ ok: false, error, code });

/** Where the fight stands, once a command has been applied: who is waited on, or that it is over. */
export function rulesetDirectorStage(state: CombatDirectorState): CombatDirectorState["stage"] {
  const fight = fightOf(state);
  if (!fight) return state.stage;
  if (state.outcome) return "finished";
  if (state.window) return "decision";
  // A window the fight is holding open is waited on exactly as a turn is, and by whoever it is
  // asking rather than whoever is on turn. Reading only the turn here would leave a client whose
  // own party member is being asked seeing an opponent's turn and sending `continue` at it.
  const asked = fight.encounter.window?.waiting[0];
  const waiting = asked ? rulesetCombatant(fight.encounter, asked) : currentRulesetActor(fight.encounter);
  return waiting && rulesetController(state, fight, waiting) === "manual" ? "action" : "select";
}

/** Where a command leaves the session. The director's own view is built once here, because that is
 *  what keeps the Engine's `party`, `enemies` and `CombatSummary` in step with the fight, and a
 *  fight that has ended has no decision open and nobody on turn. */
function settled(state: CombatDirectorState): RulesetCommandResult {
  combatDirectorView(state);
  if (state.outcome) {
    state.window = undefined;
    state.choices = [];
  }
  state.stage = rulesetDirectorStage(state);
  return { ok: true };
}

// ── Building the fight ──

export interface RulesetFightOpponent {
  id: string;
  name: string;
  /** A bestiary reference (`<catalogId>/<entryId>`) or a name, as the Game Master wrote it. */
  creature?: string;
  tier?: string;
  /** A stat block the Game Master proposed, in the shared creature form. Clamped onto the scale. */
  proposed?: unknown;
  boss?: boolean;
  /** A named individual of the story rather than a nameless foe (combat AI P9), as the Game Master
   *  wrote it: one the Game Master may play itself, as it plays a boss. */
  named?: boolean;
  /** Its mind where the story changes what its own data says (a dominated creature). */
  mind?: CombatMind;
  /** Its side follows it, by the story (combat AI E2): a bandit chief nobody's bestiary marks. */
  leader?: boolean;
  /** How it fights: the same competence and temperament its choices in the fight are made with,
   *  which is also what fills an invented sheet's open choices. Assigned here when not given. */
  tactics?: Pick<CombatTactics, "proficiency" | "adjective">;
  /** How a story fight has it (1.363): its Legendary Resistance and health, when it is a bestiary's. */
  adjust?: { legendaryResistance?: number; maxHp?: number; calls?: Array<{ action: string; creature: string }> };
}

export interface RulesetFightSeed {
  definition: RulesetDefinition;
  seed: number;
  party: Array<{ id: string; name: string }>;
  enemies: RulesetFightOpponent[];
  /** Whether this fight is fought on a board. The ruleset still has to say what a cell is worth:
   *  one that does not stays theatre of the mind whatever the game asked for. */
  positioned?: boolean;
  /** What the tactical style's own generator is handed, unchanged: this fight has no second
   *  generator, no second terrain table and no board sizes of its own. */
  environment?: string | null;
  formation?: string | null;
  battlefield?: TacticalBattlefieldBrief;
  /** A board painted for the fight's place (worldgen W9g), fought on as painted: the brief is not used. */
  made?: TacticalMadeBattlefield;
  /** The board pack it is drawn with (1.333), by library id: this one, else the painted board's. */
  pack?: string;
  /** The chat's own party cards, which is where a sheet build lives. */
  cards: unknown;
  playerName: string | null;
  /** The stored live sheet state of the whole game. */
  live: RulesetLiveStates | null;
  /** What each party member holds, by name, when the ruleset's sheet reads items. */
  items?: (name: string) => RulesetSheetItem[];
  /** Whose bag each party member's items are in, by name (1.705): null for the player's own. */
  holders?: (name: string) => string | null;
  /** The catalogs the party's own rows came from, so the fight knows what an ability costs. */
  partyCatalogs: RulesetCatalogEntriesById;
  /** Every catalog of this ruleset that holds creatures. */
  bestiary: RulesetCatalogEntriesById;
  /** Who is caught unaware as it begins (1.237), by id, as the Game Master set the scene. */
  surprised?: string[];
  /** Who fights in its own lair (1.315), by id: its lair actions are taken on its lair's count. */
  inLair?: string[];
  /** Held Ground (1.323): whoever reaches no health in this fight is felled instead. The story's
   *  region rule decides it; the fight only keeps it. */
  heldGround?: RulesetHeldGround;
  /** What was set up before the fight (1.446), standing as it begins. */
  standing?: RulesetStandingZone[];
  /** The scene's time of day as the game tracks it (1.291), which sets the light outdoors. */
  time?: string | null;
}

export type RulesetFightSeedResult = { ok: true; fight: RulesetFightState } | { ok: false; error: string };

/**
 * A fight, ready for its first turn, or a plain sentence saying why it could not be built.
 *
 * The server decides what the fight is resolved by and what everybody's numbers are: a party
 * member's come off their own sheet, and an opponent's off a bestiary, off a clamped proposal or
 * off the ruleset's own threat scale, in that order. A client-sent sheet is never read.
 */
export function createRulesetFight(input: RulesetFightSeed): RulesetFightSeedResult {
  const { definition } = input;
  const combat = definition.combat;
  if (!combat) return { ok: false, error: "This game's ruleset does not resolve its own fights." };

  const adjustments: string[] = [];
  const lootTables: Record<string, string> = {};
  /** Invented opponents written as sheets, and the tier each is held to once it is built. */
  const heldToTier = new Map<string, NonNullable<typeof combat.threat>["tiers"][number]>();
  const builds = rulesetSheetBuildsByName(definition, input.cards, input.playerName);
  const creatures = rulesetCardCreaturesByName(input.cards);
  const combatants: RulesetCombatantInput[] = [];
  // With no persona the first character card plays as the player: a member the setup named for a
  // player with no sheet ("User") is that card, where the party does not already hold it.
  const named = new Set(input.party.map((member) => normalizeCharacterLookupName(member.name)));
  const firstCard = input.playerName
    ? undefined
    : (Array.isArray(input.cards) ? (input.cards as Array<{ name?: unknown }>) : [])
        .map((card) => (typeof card.name === "string" ? card.name.trim() : ""))
        .find((name) => name && builds.has(normalizeCharacterLookupName(name)));
  let standIn = firstCard && !named.has(normalizeCharacterLookupName(firstCard)) ? firstCard : undefined;
  // A member the setup invented, with neither a sheet nor a creature, stays out of the fight
  // (2026-10-23 playtest), and the fight's numbers are only ever a sheet's.
  for (const listed of input.party) {
    let member = listed;
    if (
      standIn &&
      !builds.has(normalizeCharacterLookupName(member.name)) &&
      !creatures.has(normalizeCharacterLookupName(member.name))
    ) {
      adjustments.push(`${member.name} fights as ${standIn}, the character the player plays.`);
      member = { ...member, name: standIn };
      standIn = undefined;
    }
    const key = normalizeCharacterLookupName(member.name);
    const build = builds.get(key);
    // A member who is a bestiary creature (a copy of one, 5e's Simulacrum) fights as that creature.
    const creature = build ? undefined : creatures.get(key);
    if (creature) {
      combatants.push({ id: member.id, name: member.name, side: "party", creature, live: input.live?.[key] ?? {} });
      continue;
    }
    if (!build) {
      adjustments.push(`${member.name} has no ruleset sheet and stays out of the fight.`);
      continue;
    }
    combatants.push({
      id: member.id,
      name: member.name,
      side: "party",
      build,
      live: input.live?.[key],
      catalogs: input.partyCatalogs,
      ...(input.items ? { items: input.items(member.name) } : {}),
      ...(input.holders ? { holder: input.holders(member.name) } : {}),
    });
  }
  if (input.party.length > 0 && !combatants.some((one) => one.side === "party")) {
    return { ok: false, error: "Nobody in this party has a ruleset sheet, so this fight cannot read their numbers." };
  }

  for (const opponent of input.enemies) {
    // By the reference the Game Master named, then by the opponent's own name, and no further: a
    // fight built on a near miss is worse than one the Engine says it could not build.
    const named = opponent.creature ? findRulesetCreature(input.bestiary, opponent.creature) : null;
    const found = named ?? findRulesetCreature(input.bestiary, opponent.name);
    if (opponent.creature && !named) {
      adjustments.push(
        found
          ? `No bestiary holds "${opponent.creature}", so ${opponent.name} was looked up by name.`
          : `No bestiary of this ruleset holds "${opponent.creature}".`,
      );
    }
    if (found) {
      combatants.push({
        id: opponent.id,
        name: opponent.name,
        side: "enemy",
        creature: { catalogId: found.catalogId, entryId: found.entry.id },
        ...(opponent.adjust
          ? {
              adjust: {
                ...(opponent.adjust.legendaryResistance !== undefined
                  ? { legendaryResistance: opponent.adjust.legendaryResistance }
                  : {}),
                ...(opponent.adjust.maxHp !== undefined ? { health: opponent.adjust.maxHp } : {}),
                ...(opponent.adjust.calls?.length ? { calls: opponent.adjust.calls.map((call) => ({ ...call })) } : {}),
              },
            }
          : {}),
      });
      if (found.entry.creature?.loot) lootTables[opponent.id] = found.entry.creature.loot;
      continue;
    }
    const proposed =
      opponent.proposed === undefined ? null : rulesetProposedCreatureSchema.safeParse(opponent.proposed);
    // A creature invented for this fight in the ruleset's own terms: a mage with slots and spells.
    // Read leniently, held to its tier the way a plain invention is, and held again once it is built.
    if (proposed?.success && proposed.data.sheet) {
      const said = (line: string) => adjustments.push(`${opponent.name}: ${line}`);
      const beside = RULESET_PROPOSED_SHEET_REPLACES.filter(
        (key) => (opponent.proposed as Record<string, unknown>)[key] !== undefined,
      );
      if (beside.length > 0)
        said(`its sheet says its ${beside.join(", ")}, so the numbers written beside it were not used.`);
      const read = readProposedRulesetSheet(definition, proposed.data.sheet, input.bestiary);
      read.adjusted.forEach(said);
      // A boss is the Game Master's to write in full, as the exception it may be. Anything else keeps
      // only what the ruleset opens to its sheet (a Sorcerer's spells, not every spell) and has the
      // choices it left open filled by its temperament and competence, without another model call.
      let sheet = read.sheet;
      if (!opponent.boss) {
        const open = restrictRulesetSheetEntries(definition, sheet, input.bestiary);
        open.adjusted.forEach(said);
        const tactics =
          opponent.tactics ??
          assignCombatTactics(
            { id: opponent.id, hp: 1, maxHp: 1, attack: 0, defense: 0, speed: 0, level: 1 },
            input.seed,
          );
        const filled = fillRulesetSheetChoices(
          definition,
          open.sheet,
          input.bestiary,
          tactics,
          `choices:${input.seed}:${opponent.id}`,
        );
        filled.adjusted.forEach(said);
        sheet = filled.sheet;
      }
      const tiers = combat.threat?.tiers ?? [];
      const wanted = opponent.tier ?? proposed.data.tier;
      const tier = tiers.find((entry) => entry.id === wanted) ?? tiers[0];
      const held = tier ? holdRulesetSheetHealth(definition, sheet, tier) : { sheet, adjusted: [] };
      held.adjusted.forEach(said);
      // What the entry adds beside the sheet (its own actions, riders, the damage it shrugs off) is
      // held by the plain clamp, on a block that borrows the tier's own numbers for the ones the
      // sheet will give, so only the lines about those parts are said.
      const { sheet: _sheet, ...parts } = proposed.data;
      const plain = rulesetProposedStatBlock(definition, {
        ...parts,
        health: tier?.health[0] ?? 1,
        defense: 0,
        initiativeModifier: 0,
      });
      const clamped = plain ? clampRulesetStatBlock(definition, plain, wanted) : null;
      clamped?.adjusted.forEach(said);
      const {
        health: _health,
        healthDice: _dice,
        defense: _defense,
        initiativeModifier: _initiative,
        ...extras
      } = clamped?.block ?? { actions: [] };
      combatants.push({
        id: opponent.id,
        name: opponent.name,
        side: "enemy",
        block: { ...extras, sheet: held.sheet, ...(tier ? { tier: tier.id } : {}) },
      });
      if (tier) heldToTier.set(opponent.id, tier);
      continue;
    }
    if (proposed?.success) {
      const block = rulesetProposedStatBlock(definition, proposed.data);
      if (block) {
        const clamped = clampRulesetStatBlock(definition, block, opponent.tier ?? proposed.data.tier);
        for (const line of clamped.adjusted) adjustments.push(`${opponent.name}: ${line}`);
        combatants.push({ id: opponent.id, name: opponent.name, side: "enemy", block: clamped.block });
        continue;
      }
    }
    if (proposed && !proposed.success) {
      adjustments.push(`The proposed stat block for ${opponent.name} could not be read, so its tier was used.`);
    }
    const built = rulesetTierStatBlock(definition, opponent.tier, opponent.name);
    if (!built) {
      return {
        ok: false,
        error: `${opponent.name} is in no bestiary of this ruleset, carries no stat block, and the ruleset declares no threat tiers to build one from.`,
      };
    }
    if (opponent.tier && built.tier.id !== opponent.tier) {
      adjustments.push(`The tier "${opponent.tier}" is not on this ruleset's scale, so ${built.tier.label} was used.`);
    }
    adjustments.push(`${opponent.name} was built from the numbers of ${built.tier.label}.`);
    combatants.push({ id: opponent.id, name: opponent.name, side: "enemy", block: built.block });
  }

  const board = buildRulesetBoard(input, combatants);
  if (board && "error" in board) return { ok: false, error: board.error };
  let encounter = createRulesetEncounter({
    definition,
    seed: input.seed,
    combatants,
    bestiary: input.bestiary,
    ...(board ? { board } : {}),
    ...(input.surprised?.length ? { surprised: input.surprised } : {}),
    ...(input.inLair?.length ? { inLair: input.inLair } : {}),
    ...(input.heldGround ? { heldGround: input.heldGround } : {}),
  });
  for (const [id, tier] of heldToTier) {
    const built = rulesetCombatant(encounter, id);
    if (!built) continue;
    for (const line of holdRulesetCombatant(definition, built, tier)) adjustments.push(`${built.name}: ${line}`);
  }
  // What was set up before it stands as it begins (1.446).
  if (input.standing?.length) {
    const stood = rulesetStandingAtStart(definition, encounter, input.standing);
    encounter = stood.state;
    adjustments.push(...stood.skipped);
  }
  // A lair whose count comes before everybody's acts before the first turn (1.315).
  encounter = rulesetOpenLairWindow(definition, encounter);
  // Whom its side follows by the story (combat AI E2): its fall shakes the rest as a stat block's
  // leader's does.
  for (const opponent of input.enemies) {
    const one = opponent.leader ? encounter.combatants.find((combatant) => combatant.id === opponent.id) : undefined;
    if (one) one.leader = true;
  }
  const fight: RulesetFightState = {
    encounter,
    eventSeq: 0,
    events: [],
    controllers: {},
    bosses: input.enemies.filter((opponent) => opponent.boss).map((opponent) => opponent.id),
    ...rulesetThinkersOf(input.definition, encounter, input.enemies),
    adjustments: adjustments.slice(0, RULESET_ADJUSTMENT_LIMIT),
    ...(Object.keys(lootTables).length > 0 ? { lootTables } : {}),
  };
  record(fight, encounter.opening);
  for (const line of fight.adjustments) logger.info("[game/combat:ruleset] %s", line);
  return { ok: true, fight };
}

/**
 * What the Game Master is told of an opponent it plays (combat AI P9): how it thinks and fights (its
 * mind, temperament, role and its own data's `behavior`), the other side ranked by the danger each
 * poses, and the standing orders the party gave its companions. Nothing a player could not read off
 * the fight; no die that has not been thrown.
 */
export function rulesetGmBrief(definition: RulesetDefinition, state: CombatDirectorState, actorId: string) {
  const fight = fightOf(state);
  const combat = definition.combat;
  const actor = fight ? rulesetCombatant(fight.encounter, actorId) : undefined;
  if (!fight || !combat || !actor) return {};
  // A state built for a single question may carry no units at all.
  const party = state.party ?? [];
  const unit = [...party, ...(state.enemies ?? [])].find((one) => one.id === actorId);
  const behavior = rulesetCombatantBehavior(definition, actor);
  const mind = combatMindWithHint(unit?.aiHints?.mind, rulesetCombatantMind(definition, actor));
  const temperament = unit?.aiHints?.temperament ?? behavior?.temperament ?? unit?.tactics?.adjective;
  const role = behavior?.role ?? unit?.tactics?.role;
  const threats = fight.encounter.combatants
    .filter((one) => one.side !== actor.side && rulesetCombatStanding(one))
    .map((one) => ({
      id: one.id,
      name: one.name,
      threat: Math.round(rulesetThreat(definition, combat, fight.encounter, one) * 100) / 100,
    }))
    .sort((a, b) => b.threat - a.threat);
  const companionOrders = Object.fromEntries(party.filter((one) => one.orders).map((one) => [one.id, one.orders!]));
  return {
    profile: {
      ...(mind ? { mind } : {}),
      ...(temperament ? { temperament } : {}),
      ...(role ? { role } : {}),
      ...(unit?.tactics?.proficiency ? { proficiency: unit.tactics.proficiency } : {}),
      ...(behavior ? { behavior } : {}),
    },
    threats,
    ...(Object.keys(companionOrders).length > 0 ? { companionOrders } : {}),
  };
}

/** The opponents the Game Master may play beside its bosses (combat AI P9): every named one, and
 *  every one whose mind is a genius's, by the story or else by its own data. */
function rulesetThinkersOf(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  enemies: readonly RulesetFightOpponent[],
): { thinkers?: string[] } {
  const thinkers = enemies
    .filter((opponent) => {
      if (opponent.boss) return false;
      if (opponent.named) return true;
      const combatant = rulesetCombatant(encounter, opponent.id);
      const own = combatant ? rulesetCombatantMind(definition, combatant) : undefined;
      return combatMindWithHint(opponent.mind, own) === "genius";
    })
    .map((opponent) => opponent.id);
  return thinkers.length > 0 ? { thinkers } : {};
}

/**
 * The board, from the tactical style's OWN path: its generator, its terrain, its board sizes, its
 * formations and the same bounded brief the Game Master may propose. Nothing here draws a grid.
 *
 * The units it places are stand-ins. A ruleset fight has no tactical units at all, because the
 * tactical engine's stats and arithmetic are the Engine's own and this fight runs on the ruleset's;
 * what placement reads off a unit is its side, whether it anchors the group and the tile it lands
 * on, and a stand-in carries exactly that.
 *
 * Null is a fight that stays theatre of the mind: the game did not ask for a board, or the ruleset
 * says nothing about what a cell is worth.
 */
function buildRulesetBoard(
  input: RulesetFightSeed,
  combatants: readonly RulesetCombatantInput[],
):
  | {
      grid: TacticalGrid;
      placements: Record<string, { x: number; y: number }>;
      battlefield?: unknown;
      light?: RulesetBoardLight;
      environment?: string;
      props?: NonNullable<TacticalMadeBattlefield["props"]>;
      events?: NonNullable<TacticalMadeBattlefield["events"]>;
      ground?: Record<string, { growth?: true; season?: string }>;
      lightRule?: NonNullable<TacticalMadeBattlefield["lightRule"]>;
    }
  | { error: string }
  | null {
  if (!input.positioned || !input.definition.combat?.distance) return null;
  const bosses = new Set(input.enemies.filter((opponent) => opponent.boss).map((opponent) => opponent.id));
  const stands = combatants.map((entry) => ({
    id: entry.id,
    side: entry.side,
    ...(bosses.has(entry.id) ? { isBoss: true } : {}),
    x: 0,
    y: 0,
  }));
  // The same cursor the tactical style reserves for setup, from the same seed, so the two styles
  // generate the same board for the same fight.
  const rng = deterministicRng(input.seed >>> 0, 0);
  const generated = input.made
    ? madeTacticalBattlefield(input.made)
    : generateTacticalBattlefield(
        stands.length,
        rng,
        normalizeTacticalEnvironment(input.environment ?? undefined),
        input.battlefield,
      );
  if (!generated.ok) return { error: generated.error };
  const { grid } = generated;
  if (
    !placeSpawns(
      grid,
      stands,
      normalizeTacticalFormation(input.formation ?? undefined),
      rng,
      generated.protectedTiles,
      true,
    )
  )
    return { error: "Battlefield features prevent a connected deployment." };
  // A generated board's foothills, read off the tiles as deployment left them (combat C6b).
  if (!input.made) {
    const elevation = foothillElevation(grid);
    if (elevation) grid.elevation = elevation;
  }
  const placements: Record<string, { x: number; y: number }> = {};
  for (const stand of stands) placements[stand.id] = { x: stand.x, y: stand.y };
  // The light it is fought in and the kind of place it is (1.291): what keen eyes, a sensitivity
  // to light, camouflage and hiding in shadows read.
  const environment = input.environment ? normalizeTacticalEnvironment(input.environment) : undefined;
  const light = rulesetBoardLightFor(input.time, environment);
  return {
    grid,
    placements,
    battlefield: generated.battlefield,
    ...(light ? { light } : {}),
    ...(environment ? { environment } : {}),
    // The art it is drawn with (1.333).
    ...((input.pack ?? input.made?.pack) ? { pack: (input.pack ?? input.made?.pack)! } : {}),
    // What its painter stood on it that may be broken (1.316).
    ...(input.made?.props?.length ? { props: input.made.props } : {}),
    // What it does each round, and the growth and seasons on its cells (1.318).
    ...(input.made?.events?.length ? { events: input.made.events } : {}),
    ...(madeGround(input.made) ? { ground: madeGround(input.made)! } : {}),
    // What standing in its light does (1.319).
    ...(input.made?.lightRule ? { lightRule: input.made.lightRule } : {}),
  };
}

/** The growth and seasons a painted board's cells start with (1.318), or null. */
function madeGround(
  made: TacticalMadeBattlefield | undefined,
): Record<string, { growth?: true; season?: string }> | null {
  const ground: Record<string, { growth?: true; season?: string }> = {};
  for (const cell of made?.growth ?? []) ground[`${cell.x},${cell.y}`] = { growth: true };
  for (const [at, season] of Object.entries(made?.seasons ?? {})) ground[at] = { ...ground[at], season };
  return Object.keys(ground).length ? ground : null;
}

/** Places a fight's light comes from its own lamps rather than the sky. */
const INDOOR_ENVIRONMENTS = new Set(["dungeon", "cave", "castle", "mansion", "spaceship"]);
/** Places with no lamps of their own (1.294): dark whatever the hour, lit only by what is carried. */
const DARK_ENVIRONMENTS = new Set(["dungeon", "cave"]);

/**
 * The light a fight is fought in (1.291), off the scene's time of day: outdoors, the sun by day,
 * dim light at dawn and dusk, darkness at night; indoors, or when the time says nothing it
 * understands, bright light that is not the sun's (nothing said). A clock reading ("14:30",
 * "7pm") is read by its hour. A cave or a dungeon is dark at any hour (1.294).
 */
export function rulesetBoardLightFor(
  time: string | null | undefined,
  environment: string | undefined,
): RulesetBoardLight | undefined {
  if (environment && DARK_ENVIRONMENTS.has(environment)) return "dark";
  if (!time || (environment && INDOOR_ENVIRONMENTS.has(environment))) return undefined;
  const text = time.trim().toLowerCase();
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3] === "pm" && hour < 12) hour += 12;
    if (clock[3] === "am" && hour === 12) hour = 0;
    if (hour > 23) return undefined;
    if (hour >= 7 && hour < 18) return "sunlight";
    if (hour === 6 || hour === 18 || hour === 19) return "dim";
    return "dark";
  }
  if (/\b(midnight|night)\b/.test(text)) return "dark";
  if (/\b(dawn|dusk|twilight|sunrise|sunset|evening)\b/.test(text)) return "dim";
  if (/\b(morning|noon|midday|day|daytime|afternoon)\b/.test(text)) return "sunlight";
  return undefined;
}

// ── Reading the fight ──

const fightOf = (state: CombatDirectorState): RulesetFightState | null =>
  state.style === "ruleset" ? (state.rulesetFight ?? null) : null;

function record(fight: RulesetFightState, events: readonly DirectedRulesetEvent[]): void {
  for (const event of events) fight.events.push({ seq: ++fight.eventSeq, event });
  fight.events = trimRulesetFightEvents(fight.events);
}

/**
 * The fight's events cut back to `RULESET_COMBAT_EVENT_LIMIT`. The AI's reasons (only ever shown
 * with Debug on) go first, oldest first, so they never cost a player an event of the fight itself:
 * the fight's own events keep the whole window, and only once they fill it does the oldest go.
 */
export function trimRulesetFightEvents<T extends { event: { type: string } }>(events: T[]): T[] {
  let over = events.length - RULESET_COMBAT_EVENT_LIMIT;
  if (over <= 0) return events;
  const kept = events.filter((entry) => !(entry.event.type === "reasoning" && over-- > 0));
  return over > 0 ? kept.slice(over) : kept;
}

/** Who plays this combatant: the player, the Engine's own picker, or the Game Master. */
export function rulesetController(
  state: CombatDirectorState,
  fight: RulesetFightState,
  combatant: RulesetCombatant | undefined,
): "manual" | "ai" | "gm" {
  if (!combatant) return "ai";
  // A party member is the player's to play unless they handed them over. Whoever was called to the
  // party's side (1.325) is the Engine's unless the player took them.
  if (combatant.side === "party") {
    const chosen = fight.controllers[combatant.id];
    // Out of their caller's command (1.604), they act on their own, whoever took them.
    if (combatant.calledOnOwn) return "ai";
    return chosen === "ai" || (combatant.calledBy && chosen !== "manual") ? "ai" : "manual";
  }
  if (!state.gm) return "ai";
  if (fight.bosses.includes(combatant.id) || state.gmAll) return "gm";
  return state.gmNamed && fight.thinkers?.includes(combatant.id) ? "gm" : "ai";
}

/** The dice this fight throws next: the session's own seed, from the cursor the last step left. */
const rollerFor = (fight: RulesetFightState) => rulesetCombatRoller(fight.encounter.seed, fight.encounter.cursor);

/** The party's live sheet state, keyed the way the game stores it, so the caller can write it back
 *  where the sheet reads it. */
export function rulesetFightLiveStates(fight: RulesetFightState): RulesetLiveStates {
  const live: RulesetLiveStates = {};
  for (const combatant of fight.encounter.combatants) {
    // The PARTY, and only the party. An opponent may carry a sheet too, but it exists for the fight
    // alone: writing it back would store it as a character's, keyed by the opponent's name, and a
    // character who happened to share that name would have their sheet overwritten.
    if (combatant.side !== "party") continue;
    // A member who is a bestiary creature with no sheet keeps the conditions it came in holding,
    // while it still holds them, and its health in the health pool's place.
    if (combatant.cardLive && !combatant.sheet) {
      const conditions = combatant.cardLive.conditions.filter((condition) =>
        combatant.tracked.some((entry) => entry.condition === condition),
      );
      const pool = combatant.cardLive.pool;
      live[normalizeCharacterLookupName(combatant.name)] = {
        ...(conditions.length ? { conditions } : {}),
        ...(pool !== undefined && combatant.health
          ? { pools: { [pool]: { value: combatant.defeated ? 0 : Math.max(0, combatant.health.value) } } }
          : {}),
      };
      continue;
    }
    if (!combatant.sheet) continue;
    live[normalizeCharacterLookupName(combatant.name)] = combatant.sheet.live as RulesetLiveState;
  }
  return live;
}

/**
 * The Engine's own `party` and `enemies` arrays, kept in step with the fight after every step: the
 * client's recap, the journal and the outcome the director reads all go through them, so they are
 * never allowed to drift from what the ruleset says.
 */
export function syncRulesetCombatants(definition: RulesetDefinition, state: CombatDirectorState): void {
  const fight = fightOf(state);
  const combat = definition.combat;
  if (!fight || !combat) return;
  // The ruleset decides who won, not the Engine's own hit points. They agree, because the numbers
  // below are the same numbers, but the ruleset is the one that is read.
  const outcome = rulesetEncounterOutcome(fight.encounter);
  // A party gone from the fight alive (1.279) got away, as fleeing does.
  if (!state.outcome && outcome !== "ongoing") state.outcome = outcome === "fled" ? "flee" : outcome;
  // The Engine's own round is the ruleset's round here, so the shell's header and the recap's
  // "after N rounds" report the fight that was actually fought rather than staying on round one.
  state.round = fight.encounter.round;
  const units = new Map<string, Combatant>();
  for (const unit of [...state.party, ...state.enemies]) units.set(unit.id, unit);
  for (const combatant of fight.encounter.combatants) {
    const unit = units.get(combatant.id);
    if (!unit) continue;
    rulesetReadRole(definition, unit, combatant, fight.encounter);
    // Its data's temperament from the start, so what happens before its first choice (a shift, a
    // proud one's flight) reads it too (combat AI T5).
    const own = rulesetCombatantBehavior(definition, combatant)?.temperament;
    if (unit.tactics && unit.tactics.mind !== "mindless" && own && !unit.aiHints?.temperament && !unit.tactics.shifted)
      unit.tactics.adjective = own;
    // The ground a territorial one keeps: where it stood when it first did (combat AI T4).
    const at = rulesetPositionOf(combatant);
    if (unit.tactics && rulesetTerritorial(definition, combatant, unit.tactics) && !unit.tactics.home && at)
      unit.tactics.home = { x: at.x, y: at.y };
    // The temperament it is played with, for the rules' morale (combat AI T1, T2).
    const temperament =
      unit.tactics?.mind === "mindless"
        ? undefined
        : unit.tactics?.shifted
          ? unit.tactics.adjective
          : (unit.aiHints?.temperament ??
            rulesetCombatantBehavior(definition, combatant)?.temperament ??
            unit.tactics?.adjective);
    // Cruel only where the game allows it (combat AI T3): otherwise it plays as an opportunist.
    if (temperament) combatant.temperament = temperament === "cruel" && !state.cruel ? "opportunistic" : temperament;
    else delete combatant.temperament;
    // Who plays a party member, as the fight has it: what the party panel shows.
    if (combatant.side === "party")
      unit.controller = rulesetController(state, fight, combatant) === "ai" ? "ai" : "manual";
    const health = rulesetCombatHealth(definition, combat, combatant);
    unit.maxHp = Math.max(1, Math.floor(health.max));
    // Somebody away from the fight is not dead: what they had stays theirs.
    unit.hp = combatant.defeated && !combatant.away ? 0 : Math.min(unit.maxHp, Math.max(0, Math.floor(health.value)));
    unit.statusEffects = conditionsOf(definition, combatant).map((condition) => ({
      name: condition.label,
      modifier: 0,
      stat: "hp" as const,
      turnsLeft: Math.min(100, Math.max(0, condition.rounds ?? 0)),
    }));
  }
}

/** What a fighter is for, read once off what its ruleset sheet or block can do (a priest supports, a
 *  mage casts), or as its own data says (1.747). The ruleset is what it fights with, so a game card's
 *  class or skills say nothing here. */
function rulesetReadRole(
  definition: RulesetDefinition,
  unit: Combatant,
  combatant: RulesetCombatant,
  encounter: RulesetEncounterState,
): void {
  if (!unit.tactics || unit.tactics.roleRead) return;
  const role =
    rulesetCombatantBehavior(definition, combatant)?.role ?? rulesetCombatantRole(combatant, definition, encounter);
  // Its temperament drawn again with what it is for (combat AI A3): a priest leans supportive and a
  // goblin opportunistic, which a guess from its Engine class never gave them. A temperament the
  // story or its data names still wins. Not an opponent invented with a sheet: its open choices were
  // filled by the temperament it was given, and it fights with that one.
  if (
    role !== unit.tactics.role &&
    unit.tactics.mind !== "mindless" &&
    !(combatant.sheet && combatant.side === "enemy")
  ) {
    const { seed, mind } = unit.tactics;
    unit.tactics.adjective =
      unit.aiHints?.temperament ?? assignCombatTactics({ ...unit, tactics: undefined }, seed, mind, role).adjective;
  }
  unit.tactics.role = role;
  unit.tactics.roleRead = true;
}

function conditionsOf(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): Array<{ id: string; label: string; rounds?: number; trait?: true; icons?: string[] }> {
  const declared = new Map(definition.sheet.live.conditions.map((entry) => [entry.id, entry.label]));
  const tracked = new Map(combatant.tracked.map((entry) => [entry.condition, entry.rounds]));
  // And what a zone they stand in puts on them while they stay (1.179).
  const zoned = state ? rulesetZoneConditions(state, combatant, definition) : [];
  const ids = new Set([...rulesetCombatConditions(definition, combatant), ...zoned]);
  // What the fight, a zone or their own sheet put on them; the rest only what they are or carry
  // keeps on them all fight (a race's Lucky, a worn item's), which is a trait, not news.
  const put = new Set([
    ...combatant.tracked.filter((entry) => !entry.kept).map((entry) => entry.condition),
    ...zoned,
    ...(combatant.sheet
      ? readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live, combatant.sheet.items)
          .conditions.filter((condition) => condition.active)
          .map((condition) => condition.id)
      : []),
  ]);
  return [...ids].map((id) => {
    const rounds = tracked.get(id);
    const icons = rulesetConditionIcons(definition, id);
    return {
      id,
      label: declared.get(id) ?? id,
      ...(typeof rounds === "number" ? { rounds } : {}),
      ...(put.has(id) ? {} : { trait: true as const }),
      ...(icons.length ? { icons } : {}),
    };
  });
}

/** What a standard action left a combatant doing until their next turn, for the fight's badges. */
function stancesOf(combatant: RulesetCombatant): DirectedRulesetCombatant["stances"] {
  const stances: NonNullable<DirectedRulesetCombatant["stances"]> = [];
  if (combatant.flags.dodging) stances.push("dodging");
  if (combatant.hiding?.from.length) stances.push("hidden");
  if (combatant.flags.disengaged) stances.push("disengaged");
  if (combatant.readied) stances.push("readied");
  return stances.length ? stances : undefined;
}

function deathTrackOf(definition: RulesetDefinition, combatant: RulesetCombatant) {
  const dying = definition.combat?.dying;
  // Only the party rolls against death; an opponent at zero is out, sheet or no sheet.
  if (!dying || combatant.side !== "party" || !combatant.sheet) return undefined;
  const live = readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live, combatant.sheet.items);
  const value = (track: string) => live.tracks.find((entry) => entry.id === track)?.value ?? 0;
  // The member's own top, since a plain track's maximum may be a value their sheet works out.
  const max = (track: string) => live.tracks.find((entry) => entry.id === track)?.max ?? 0;
  return {
    successes: value(dying.successes),
    failures: value(dying.failures),
    successesMax: max(dying.successes),
    failuresMax: max(dying.failures),
  };
}

/** What a party member has left of the pools their actions spend (spell slots, ki, sorcery points),
 *  for the fight's own HUD: a player should not have to open the sheet mid-fight to count slots. */
function spentPoolsOf(definition: RulesetDefinition, combatant: RulesetCombatant) {
  if (combatant.side !== "party" || !combatant.sheet) return undefined;
  // What one of it is called, for a player paying with it (1.378): "a 2nd-level slot".
  const unitOf = (id: string) => {
    const declared = definition.sheet.live.pools.find((pool) => pool.id === id);
    return declared?.unit ? { unit: declared.unit } : {};
  };
  // The ruleset may name them itself, in its own order (1.375).
  const named = definition.combat?.display?.pools;
  if (named) {
    const live = readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live, combatant.sheet.items);
    const pools = named.flatMap((id) =>
      live.pools
        .filter((pool) => pool.key === id && !pool.listId && pool.max > 0)
        .map((pool) => ({ id: pool.key, label: pool.label, value: pool.value, max: pool.max, ...unitOf(pool.key) })),
    );
    return pools.length ? pools : undefined;
  }
  const spent = new Set<string>();
  const groups = new Set<string>();
  for (const action of combatant.actions) {
    if (action.use?.pool) spent.add(action.use.pool);
    if (action.use?.group) groups.add(action.use.group);
  }
  for (const pool of definition.sheet.live.pools) {
    if ((pool.group && groups.has(pool.group)) || pool.pays?.some((group) => groups.has(group))) spent.add(pool.id);
  }
  if (spent.size === 0) return undefined;
  const live = readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live, combatant.sheet.items);
  const pools = live.pools
    .filter((pool) => !pool.listId && pool.max > 0 && spent.has(pool.key))
    .map((pool) => ({ id: pool.key, label: pool.label, value: pool.value, max: pool.max, ...unitOf(pool.key) }));
  return pools.length ? pools : undefined;
}
/** What is done by praying whatever the ruleset marks (1.770): a Channel Divinity, a turning, a prayer. */
const PRAYED_BY_NAME =
  /\b(?:channel divinity|turn(?:s|ing)? (?:the )?(?:undead|faithless|unholy)|divine intervention|pray(?:s|ers?|ing)?|worship)\b/i;

/** The ids of what a combatant casts by praying (1.770), in a ruleset with `combat.poses` only. */
function rulesetPrayedOptions(definition: RulesetDefinition, combatant: RulesetCombatant): string[] {
  if (!definition.combat?.poses) return [];
  return combatant.actions
    .filter((action) => action.divine || PRAYED_BY_NAME.test(action.label))
    .map((action) => action.id);
}

/** Who has prayed since their own turn last began (1.770): a "prayed" of theirs after their last "turn". */
function rulesetPraying(fight: RulesetFightState): Set<string> {
  const praying = new Set<string>();
  for (const { event } of fight.events) {
    if (event.type === "turn") praying.delete(event.actorId);
    else if (event.type === "prayed") praying.add(event.actorId);
  }
  return praying;
}

function projectCombatant(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  state: RulesetEncounterState,
  /** Whose turn it is, when one is taking it. */
  attacker: RulesetCombatant | undefined,
  /** Who has prayed since their turn began (1.770). */
  praying?: ReadonlySet<string>,
): DirectedRulesetCombatant {
  const combat = definition.combat!;
  const health = rulesetCombatHealth(definition, combat, combatant);
  const deathTrack = deathTrackOf(definition, combatant);
  const active = rulesetActiveConditions(definition, combat, combatant, state);
  const saveModifiers = active.flatMap((source) =>
    rulesetItemEffectFacts(definition, {
      modifiers: source.modifiers?.filter((one) => one.against),
      saves: source.saves,
    }),
  );
  // Sneaking (1.770): hidden by Hide or by one of the ruleset's hiding conditions. Only the party's own
  // are told, which says nothing of an opponent the screen should not know.
  const sneaking =
    !!combat.poses &&
    combatant.side === "party" &&
    (!!combatant.hiding ||
      !!combatant.flags.hidden ||
      (combat.poses.hidden ?? []).some((id) => rulesetCombatConditions(definition, combatant).includes(id)));
  const posed = [
    ...(sneaking && !combatant.hiding?.from.length ? (["hidden"] as const) : []),
    ...(praying?.has(combatant.id) ? (["praying"] as const) : []),
  ];
  const stances = posed.length ? [...(stancesOf(combatant) ?? []), ...posed] : stancesOf(combatant);
  return {
    id: combatant.id,
    name: combatant.name,
    side: combatant.side,
    ...(combatant.creature ? { creature: { ...combatant.creature } } : {}),
    initiative: combatant.initiative,
    health,
    // What an attack is rolled against now, with what its conditions add (a Shield's +5), what a
    // dropped shield took away and the cover of the ground it stands on. Against a foe whose turn it
    // is, the cover and high ground between them too: the number the log will say. With no such foe,
    // only what holds against a blow from anywhere.
    defense: rulesetDefenseAgainst(
      definition,
      combat,
      state,
      combatant,
      attacker && attacker.side !== combatant.side ? attacker : undefined,
    ).defense,
    conditions: conditionsOf(definition, combatant, state),
    ...(stances ? { stances } : {}),
    hides: rulesetCombatHide(definition, combatant, state),
    damageModifiers: active.flatMap((source) => {
      const modifiers = source.modifiers?.filter((one) => one.to === "damage" || one.to === "damage-taken");
      if (!modifiers?.length) return [];
      const name = source.item
        ? source.condition
        : (definition.sheet.live.conditions.find((one) => one.id === source.condition)?.label ?? source.condition);
      return [{ name, facts: rulesetItemEffectFacts(definition, { modifiers }) }];
    }),
    budgets: { ...combatant.budgets },
    down: combatant.down,
    dying: combatant.dying,
    stable: combatant.stable,
    defeated: combatant.defeated,
    ...(combatant.away ? { away: true as const } : {}),
    ...(combatant.away?.surrendered ? { surrendered: true as const } : {}),
    ...(combatant.away?.left ? { left: true as const } : {}),
    ...(combatant.surprised ? { surprised: true as const } : {}),
    ...(deathTrack ? { deathTrack } : {}),
    ...((pools) => (pools ? { pools } : {}))(spentPoolsOf(definition, combatant)),
    ...(saveModifiers.length ? { saveModifiers } : {}),
    ...(() => {
      // Its creature type and tags, by their labels (1.168).
      const kinds = combat.creatureTypes;
      const kind = rulesetCreatureKind(definition, combatant);
      if (!kinds || (kind.type === undefined && !kind.tags.length)) return {};
      const type = kinds.types.find((one) => one.id === kind.type)?.label;
      // A creature's card names its own tags, and its alignment in its own words beside them: the
      // tags its alignment names ("Evil", "Neutral") are for the rules to read, not a list to print.
      const alignment = combatant.block?.alignment?.trim();
      const shown = combatant.block
        ? kind.tags.filter((tag) => (combatant.block!.tags ?? []).includes(tag))
        : kind.tags;
      const tags = shown.map((tag) => kinds.tags?.find((one) => one.id === tag)?.label ?? tag);
      return {
        kind: { ...(type ? { type } : {}), ...(tags.length ? { tags } : {}), ...(alignment ? { alignment } : {}) },
      };
    })(),
    ...(combatant.concentrating ? { concentrating: combatant.concentrating.label } : {}),
    ...((pools) => (pools ? { pools } : {}))(spentPoolsOf(definition, combatant)),
    ...(combatant.block?.tier ? { tier: combatant.block.tier } : {}),
    ...(combatant.block?.traits?.length ? { traits: combatant.block.traits.map((trait) => ({ ...trait })) } : {}),
    ...(typeof combatant.x === "number" && typeof combatant.y === "number" ? { x: combatant.x, y: combatant.y } : {}),
    ...(combatant.movement !== undefined
      ? { movement: combatant.movement, movementLeft: combatant.movementLeft ?? 0 }
      : {}),
    ...(combatant.altitude !== undefined ? { altitude: combatant.altitude } : {}),
    ...(combatant.span !== undefined ? { span: combatant.span } : {}),
    // Drawn in its flying art (1.352): never read by the rules.
    ...(rulesetCombatantFlying(state.board?.grid, combatant) ? { flying: true as const } : {}),
    // Drawn praying as it casts these, and sneaking while hidden (1.770): never read by the rules. Only
    // the party's own are told hidden, which says nothing of an opponent the screen should not know.
    ...(() => {
      const prays = rulesetPrayedOptions(definition, combatant);
      return prays.length ? { prays } : {};
    })(),
    ...(sneaking ? { hidden: true as const } : {}),
  };
}

/** How many cells one area option may be offered aimed at. A board is at most 14 by 10 and a shape
 *  reaches a handful of cells, so this is the belt beside the braces: the payload a screen is sent
 *  stays small however far a ruleset says something carries.
 *  ponytail: the nearest legal aims, cut at a fixed number. The upgrade path is to send the shape
 *  and let the board work the cells out, which is what slice C4b may prefer once it draws one. */
const RULESET_AIM_LIMIT = 120;

/** Every option of the legal menu, with the combatants each one may be pointed at right now, and,
 *  for a shape, the cells it may be aimed at and who each aim would catch. */
export function rulesetMenu(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  /** The open window's menu rather than this actor's turn: what they may spend out of turn. */
  inWindow = false,
): DirectedRulesetOption[] {
  const asked = rulesetCombatant(encounter, actorId);
  // A guard that cannot turn this hit aside (Shield against a roll it does not beat, or a natural
  // 20) is not offered: taking it would only spend it.
  const menu = inWindow
    ? rulesetWindowOptions(definition, encounter, actorId).filter(
        (option) => !asked || rulesetAnswerDeflects(definition, encounter, asked, option.id) !== false,
      )
    : rulesetCombatOptions(definition, encounter, actorId).filter((option) => !option.futile);
  const offered = menu.map((option) => {
    // A teleport is aimed as a shape is (1.276): at a cell it may go to, catching nobody.
    const aim = option.area
      ? rulesetAimCells(encounter, actorId, option.id, RULESET_AIM_LIMIT)
      : (option.teleport?.cells.map((cell) => ({ x: cell.x, y: cell.y, targetIds: [] as string[] })) ?? []);
    const actor = rulesetCombatant(encounter, actorId);
    const action = actor?.actions.find((one) => one.id === option.id);
    const fallers =
      inWindow && encounter.window?.trigger.kind === "falls" && option.targets.count > 1 && actor && action
        ? rulesetFallTargets(definition, encounter, actor, action)
        : undefined;
    // Paying out of a higher pool is offered only where it gains something (more dice, more
    // targets, a level that stops or ends more) or where only a higher pool can pay now: Misty Step
    // and Shield are cast as they are.
    const grows = !!action && rulesetPaidLevelMatters(action);
    const payWith = option.payWith && (grows || option.upcastOnly) ? option.payWith : undefined;
    const { payWith: _offered, ...rest } = option;
    const targetIds = fallers ?? rulesetOptionTargets(definition, encounter, actorId, option);
    // The odds for each target a player may pick, where there is more than one to pick between.
    const hitChances =
      targetIds.length > 1 && option.forecast?.hitChance !== undefined
        ? rulesetHitChances(definition, encounter, actorId, option.id, targetIds)
        : undefined;
    // The whole forecast for each one it may be pointed at, where there is a choice between them.
    const forecastFor =
      targetIds.length > 1 && option.forecast && !option.area
        ? rulesetForecastsByTarget(definition, encounter, actorId, option.id, targetIds)
        : undefined;
    // And the chance each fails the save, for one that calls for a save: Hold Person's.
    const saveChances =
      targetIds.length > 0 && action?.save && option.forecast?.hitChance === undefined
        ? rulesetSaveFailChances(definition, encounter, actorId, option.id, targetIds)
        : undefined;
    // What each way of paying is worth in levels, for an alteration that counts them (Sculpt Spells).
    const levels =
      payWith && actor && action && option.alters?.some((offer) => offer.sparesByLevel)
        ? {
            base: rulesetPaidLevel(definition, actor, action),
            pay: Object.fromEntries(payWith.map((pool) => [pool, rulesetPaidLevel(definition, actor, action, pool)])),
          }
        : undefined;
    const raisesDefense =
      inWindow && encounter.window?.trigger.kind === "hit" && option.kind !== "end-turn"
        ? heldHitAnswer(definition, encounter, actorId, option, targetIds, encounter.window.trigger)
        : undefined;
    return {
      ...rest,
      ...(payWith ? { payWith, payLabels: rulesetPoolLabels(definition, payWith) } : {}),
      ...(levels ? { levels } : {}),
      targetIds,
      ...(forecastFor && Object.keys(forecastFor).length > 0 ? { forecastFor } : {}),
      ...(raisesDefense ? { raisesDefense } : {}),
      ...(aim.length > 0 ? { aim } : {}),
      ...(hitChances && Object.keys(hitChances).length > 0 ? { hitChances } : {}),
      ...(saveChances && Object.keys(saveChances).length > 0 ? { saveChances } : {}),
    };
  });
  // Treating somebody with nobody to treat is no choice: pulling a friend out of a cube nobody is
  // in, or first aid with nobody dying, is left off rather than offered all fight. Readying one of
  // them is left off with it: there is nobody to wait to treat either.
  return offered.filter((option) => {
    const id = option.ready?.optionId ?? option.id;
    const contest = asked?.actions.find((one) => one.id === id)?.contest;
    if (!(contest?.pulls || contest?.targetHolds || contest?.targetDying)) return true;
    return (option.ready ? offered.find((one) => one.id === id) : option)?.targetIds.length ? true : false;
  });
}

/** Whether paying for an action out of a higher pool changes anything it does: more dice or targets
 *  or a bigger shape, a level that stops (Counterspell) or ends (Dispel Magic) more, a held spell
 *  harder to end, healing that grows with its level. */
function rulesetPaidLevelMatters(action: RulesetCombatAction): boolean {
  return (
    !!action.use?.perCostStep ||
    !!action.use?.targetsPerStep ||
    !!action.area?.sizePerCostStep ||
    action.reaction?.upTo === "paid" ||
    !!action.endsSpells ||
    !!action.ends ||
    !!action.concentration ||
    !!action.healAdd?.length ||
    !!action.healsSelf?.length ||
    !!action.altered?.sparesByLevel
  );
}

/** What the sheet calls each pool, by id ("3rd-level slots" for `slots_3`), for a menu to show. */
function rulesetPoolLabels(definition: RulesetDefinition, pools: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pool of pools) {
    const id = rulesetItemSlotPayment(pool)?.pool ?? pool;
    const label = definition.sheet.live.pools.find((one) => one.id === id)?.label;
    if (label) labels[id] = label;
  }
  return labels;
}

/** What a window holds while it is answered, where that is something being used (1.116): the level
 *  it was paid at and where an area of it was aimed, for a prompt that says what it would stop. */
function rulesetHeldUse(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  window: NonNullable<RulesetEncounterState["window"]>,
):
  | {
      level: number;
      at?: { x: number; y: number };
      targetIds?: string[];
      cells?: Array<{ x: number; y: number }>;
    }
  | undefined {
  const resume = window.resume;
  if (
    (resume?.kind !== "action" && resume?.kind !== "answer") ||
    (window.trigger.kind !== "used" && window.trigger.kind !== "aimed")
  )
    return undefined;
  const caster = rulesetCombatant(encounter, resume.actorId);
  const action = caster?.actions.find((entry) => entry.id === resume.optionId);
  if (!caster || !action) return undefined;
  // Whom it would catch and where, so the one asked sees what they would stop: the ones it was aimed
  // at, everybody its area takes in, and that area on the board. An answer is aimed at whoever cast
  // what it answers.
  const lay =
    resume.kind === "action"
      ? {
          ...(resume.toward ? { toward: resume.toward } : {}),
          ...(resume.ring ? { ring: true } : {}),
          ...(resume.also ? { also: resume.also } : {}),
        }
      : undefined;
  const at = resume.kind === "action" ? resume.at : undefined;
  const targetIds = [
    ...new Set([
      ...(resume.kind === "action" ? resume.targetIds : []),
      ...(window.trigger.kind === "aimed" ? (window.trigger.targetIds ?? []) : []),
      ...(at ? rulesetAreaTargets(encounter, caster.id, action.id, at, lay) : []),
    ]),
  ];
  const cells = at ? rulesetAimedCells(encounter, caster.id, action.id, at, lay) : [];
  return {
    level: rulesetPaidLevel(definition, caster, action, resume.payWith),
    ...(at ? { at: { ...at } } : {}),
    ...(targetIds.length ? { targetIds } : {}),
    ...(cells.length ? { cells: cells.map((cell) => ({ x: cell.x, y: cell.y })) } : {}),
  };
}

/** Each answer that stops what is held only up to its own level (1.116), with whether it does so
 *  outright or the check it needs: what a player weighs before spending a Counterspell. */
function rulesetCounterOdds(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  window: NonNullable<RulesetEncounterState["window"]>,
  answeringId: string,
  options: DirectedRulesetOption[],
): DirectedRulesetOption[] {
  const held = rulesetHeldUse(definition, encounter, window);
  const answering = rulesetCombatant(encounter, answeringId);
  if (!held || !answering) return options;
  return options.map((option) => {
    const action = answering.actions.find((entry) => entry.id === option.id);
    if (action?.reaction?.upTo !== "paid") return option;
    const reach = rulesetPaidLevel(definition, answering, action);
    if (held.level <= reach) return { ...option, counter: { sure: true, level: reach } };
    const above = action.reaction.above;
    return {
      ...option,
      counter: { level: reach, ...(above ? { dc: above.dc + held.level, modifier: above.modifier } : {}) },
    };
  });
}

type HeldHit = Extract<NonNullable<RulesetEncounterState["window"]>["trigger"], { kind: "hit" }>;

/** What taking one answer to a held hit does to the defense it is checked against: the answer is
 *  taken on a copy of the fight with every die at its middle, and the defense read again. Nothing
 *  when it does not raise it (a counter-strike, or a reaction aimed elsewhere). */
function heldHitAnswer(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  option: RulesetCombatOption,
  targetIds: string[],
  hit: HeldHit,
): { to: number; misses?: true } | undefined {
  const combat = definition.combat;
  if (!combat) return undefined;
  const struckId = hit.targetIds?.[0] ?? actorId;
  // The one struck leads, when the answer may go to them: a reaction shielding an ally.
  const aimed = targetIds.includes(struckId) ? [struckId, ...targetIds.filter((id) => id !== struckId)] : targetIds;
  try {
    // In a planning pass of its own: the view's pass remembers each sheet as it stands, and this
    // answer changes what the struck one holds.
    const step = withOwnRulesetPlanMemo(() =>
      applyRulesetCombatChoice(
        definition,
        encounter,
        { actorId, optionId: option.id, targetIds: aimed.slice(0, Math.max(0, option.targets.count)) },
        (sides) => Math.ceil(sides / 2),
      ),
    );
    const struck = rulesetCombatant(step.state, struckId);
    const source = rulesetCombatant(step.state, hit.sourceId);
    if (!struck) return undefined;
    const heldId = hit.optionId.startsWith(RULESET_LAIR_OPTION_PREFIX)
      ? hit.optionId.slice(RULESET_LAIR_OPTION_PREFIX.length)
      : hit.optionId;
    const action = source?.actions.find((one) => one.id === heldId);
    const to = rulesetDefenseAgainst(definition, combat, step.state, struck, source, action).defense;
    if (to <= hit.defense) return undefined;
    return { to, ...(hit.total < to ? { misses: true as const } : {}) };
  } catch (error) {
    logger.debug(error, "[game/combat:ruleset] could not preview %s's answer %s to a held hit", actorId, option.id);
    return undefined;
  }
}

/** About how much a held hit's damage comes to against the one it hit. */
function heldHitStakes(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  hit: HeldHit,
  /** The one being asked, who was hit where the hit names nobody else. */
  askedId: string,
): number | undefined {
  const struckId = hit.targetIds?.[0] ?? askedId;
  const damage = rulesetForecastsByTarget(definition, encounter, hit.sourceId, hit.optionId, [struckId])[struckId]
    ?.averageDamage;
  return damage !== undefined && Math.round(damage) > 0 ? Math.round(damage) : undefined;
}

/** What spells called up that strike from a square of their own, standing on the board. */
function rulesetSummonsShown(
  encounter: RulesetEncounterState,
): Array<{ casterId: string; label: string; x: number; y: number }> {
  return encounter.combatants.flatMap((caster) =>
    rulesetCombatStanding(caster)
      ? (caster.summons ?? []).flatMap((summon) =>
          summon.at && summon.rounds > 0
            ? [{ casterId: caster.id, label: summon.label, x: summon.at.x, y: summon.at.y }]
            : [],
        )
      : [],
  );
}
/** Whether the party may give itself up (combat AI T6): every opponent still standing is one the
 *  Engine plays as honourable. */
function rulesetPartyMayYield(state: CombatDirectorState, encounter: RulesetEncounterState): boolean {
  const standing = encounter.combatants.filter(
    (one) => one.side !== "party" && !one.object && one.calledBy === undefined && rulesetCombatStanding(one),
  );
  return (
    standing.length > 0 &&
    standing.every((one) => state.enemies?.find((unit) => unit.id === one.id)?.tactics?.adjective === "honourable")
  );
}

/** The fight as a screen reads it. A projection: no sheet build, no live blob and no catalogs.
 *  Nothing changes while it is drawn, so every fighter's sheet is worked out once for it, however
 *  many options, targets and forecasts read it. */
export function directedRulesetView(
  definition: RulesetDefinition,
  state: CombatDirectorState,
): DirectedRulesetView | undefined {
  return withRulesetPlanMemo(() => rulesetViewOf(definition, state));
}

function rulesetViewOf(definition: RulesetDefinition, state: CombatDirectorState): DirectedRulesetView | undefined {
  const fight = fightOf(state);
  if (!fight || !definition.combat) return undefined;
  const encounter = fight.encounter;
  const praying = rulesetPraying(fight);
  const actor = currentRulesetActor(encounter);
  const controller = rulesetController(state, fight, actor);
  const over = !!state.outcome || rulesetEncounterOutcome(encounter) !== "ongoing";
  const asking = encounter.window?.waiting[0];
  const held =
    encounter.window && asking
      ? {
          window: encounter.window,
          actorId: asking,
          controller: rulesetController(state, fight, rulesetCombatant(encounter, asking)),
        }
      : null;
  const distance = definition.combat.distance;
  const grid = encounter.board?.grid;
  const made = encounter.board?.battlefield?.kind === "hand-made" ? encounter.board.battlefield : null;
  // Light and fog drawn on the board: only cells that are not bright and clear.
  const shading = grid && distance ? rulesetBoardShading(definition, encounter) : null;
  const shaded = shading
    ? {
        ...(Object.keys(shading.light).length > 0
          ? { light: shading.light as Record<string, "sunlight" | "dim" | "dark"> }
          : {}),
        ...(Object.keys(shading.fog).length > 0 ? { fog: shading.fog } : {}),
      }
    : {};
  return {
    ruleset: { ...encounter.ruleset },
    round: encounter.round,
    ...(!over && rulesetPartyMayYield(state, encounter) ? { canYield: true as const } : {}),
    order: [...encounter.order],
    ...(grid && distance
      ? {
          grid: {
            width: grid.width,
            height: grid.height,
            tiles: grid.tiles.map((row) => [...row]),
            ...(grid.elevation ? { elevation: grid.elevation.map((row) => [...row]) } : {}),
            ...(grid.walls ? { walls: { ...grid.walls } } : {}),
            // Growth and seasons on its cells (1.318); light and fog come with the shading.
            ...(grid.ground && Object.values(grid.ground).some((here) => here.growth || here.season)
              ? {
                  ground: Object.fromEntries(
                    Object.entries(grid.ground).flatMap(([at, here]) =>
                      here.growth || here.season
                        ? [
                            [
                              at,
                              {
                                ...(here.growth ? { growth: true as const } : {}),
                                ...(here.season ? { season: here.season } : {}),
                              },
                            ],
                          ]
                        : [],
                    ),
                  ),
                }
              : {}),
            distance: { ...distance },
            ...(made ? { scene: made.scene } : {}),
            // The board pack it is drawn with (1.333), and its environment's when it names none.
            ...(encounter.board?.pack ? { pack: encounter.board.pack } : {}),
            ...(encounter.board?.environment ? { environment: encounter.board.environment } : {}),
            ...shaded,
          },
        }
      : {}),
    ...(actor && !over ? { actorId: actor.id } : {}),
    controller,
    combatants: encounter.combatants.map((combatant) =>
      projectCombatant(definition, combatant, encounter, actor && !over ? actor : undefined, praying),
    ),
    // The areas spells left standing (1.172), drawn on the board and listed beside it.
    ...(rulesetZonesShown(encounter).length > 0 ? { zones: rulesetZonesShown(encounter) } : {}),
    // What spells called up, where it strikes from: a Spiritual Weapon's square.
    ...(grid && rulesetSummonsShown(encounter).length > 0 ? { summons: rulesetSummonsShown(encounter) } : {}),
    // What stands on the board that may be broken (1.316), broken ones too.
    ...(grid && distance && encounter.board?.props?.length
      ? {
          props: encounter.board.props.map((prop) => ({
            id: prop.id,
            label: prop.label,
            cells: prop.cells.map((cell) => ({ x: cell.x, y: cell.y })),
            health: prop.health,
            max: prop.max,
            ...(prop.art ? { art: prop.art } : {}),
          })),
        }
      : {}),
    // A window is answered by the one it asks, so while it is open the menu on screen is THEIRS.
    // The actor's own turn is standing still behind it and has nothing to offer until it closes.
    ...(held && !over
      ? {
          window: {
            id: held.window.id,
            kind: held.window.kind,
            actorId: held.actorId,
            waiting: Math.max(0, held.window.waiting.length - 1),
            ...(held.window.trigger.kind === "leaves-reach" ? { moverId: held.window.trigger.moverId } : {}),
            ...(held.window.trigger.kind === "readied" ? { readied: held.window.trigger.on } : {}),
            ...("sourceId" in held.window.trigger ? { sourceId: held.window.trigger.sourceId } : {}),
            ...("targetIds" in held.window.trigger ? { targetIds: held.window.trigger.targetIds } : {}),
            ...(rulesetWindowMoment(held.window.trigger) ? { moment: rulesetWindowMoment(held.window.trigger)! } : {}),
            ...("label" in held.window.trigger ? { label: held.window.trigger.label } : {}),
            ...(held.window.trigger.kind === "hit"
              ? ((hit, stakes) => ({
                  total: hit.total,
                  defense: hit.defense,
                  ...(stakes !== undefined ? { stakes } : {}),
                }))(held.window.trigger, heldHitStakes(definition, encounter, held.window.trigger, held.actorId))
              : {}),
            // What is held, with whom it would catch and the cells its area covers, laid as it was aimed:
            // what a board tints while the ones it would catch decide whether to answer.
            ...((what) =>
              what
                ? {
                    held: what,
                    ...(what.targetIds ? { targetIds: what.targetIds } : {}),
                    ...(grid && what.cells ? { cells: what.cells } : {}),
                  }
                : {})(rulesetHeldUse(definition, encounter, held.window)),
            controller: held.controller,
          },
          ...(held.controller === "manual" && !state.window
            ? {
                options: rulesetCounterOdds(
                  definition,
                  encounter,
                  held.window,
                  held.actorId,
                  rulesetMenu(definition, encounter, held.actorId, true),
                ),
              }
            : {}),
        }
      : actor && !over && controller === "manual" && !state.window
        ? { options: rulesetMenu(definition, encounter, actor.id) }
        : {}),
    events: fight.events.map((entry) => ({ seq: entry.seq, event: entry.event })),
    ...(over ? { summary: rulesetEncounterSummary(definition, encounter) } : {}),
    adjustments: [...fight.adjustments],
  };
}

// ── Choosing, for everybody no human plays ──

interface RulesetCandidate {
  choice: RulesetCombatChoice;
  option: RulesetCombatOption;
  targetId?: string;
  /** A dodge, a getaway or a hide taken in place of an attack (1.745): made where it stands, and a
   *  getaway walks off to `to` once it is taken. */
  defensive?: "dodge" | "disengage" | "hide";
  /** Where the actor walks to before doing it, on a board. The move is its own step, resolved
   *  through the same menu a player's would be. */
  to?: { x: number; y: number };
  /** What a closing walk costs of the movement left, so a sprint is taken only when it is short. */
  walked?: number;
  /** The harm it is expected to do, before any of it is weighed against health: a blow's average
   *  times its chance to land. */
  expected?: number;
  /** Whom of the other side it would likely drop, for orders that spare them. */
  drops?: string[];
}

/** How many cells a turn is weighed from. The board is small and a turn is short, so this is a
 *  ceiling on the enumeration rather than a rule anybody can feel.
 *  ponytail: the cheapest cells, cut at a fixed number. The upgrade path is to rank them by what
 *  they open up before cutting, which needs a scoring pass this slice does not have. */
const RULESET_MOVE_CANDIDATE_CELLS = 48;
/** How long the picker may spend weighing places to walk to before it settles for those it weighed.
 *  On every board the Engine draws it is done long before; this is what keeps a huge imported board
 *  or a creature with a hundred options from holding the server while it thinks. */
const RULESET_MOVE_PLAN_MS = 2000;

/** The largest board on which a shape is also aimed from the cells an actor could walk to. The
 *  generator's own largest board is 14 by 10; this is a few times that. */
const RULESET_AREA_WALK_BOARD_CELLS = 400;

/** What one strike on the way is worth against doing the thing at all: enough that a creature will
 *  not walk through three people's reach for a marginally better target, and not so much that it
 *  will stand still rather than take one hit to reach the only enemy it can fight. */
const RULESET_PROVOKE_PENALTY = 0.25;
/** How close to its hardest blow one must come for a mind's lean to count on it (re-test 13). */
const RULESET_FOCUS_ALIKE = 0.97;

/**
 * Everything the actor could do, scored the way every other combat AI in the Engine is scored.
 * The menu is the only source of legality, so the picker can never choose something a player could
 * not, and the option's own forecast is the only thing it is allowed to know about the dice.
 */
function rulesetCandidates(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  /** The Game Master's window is shown everything; the Engine's own picker is not (see the end). */
  everything = false,
  /** Who it is (1.745): a careful, cowardly or patient one keeps its dodge, getaway and hide. */
  tactics?: CombatTactics,
  /** A companion's standing orders: one told to hold its ground weighs nowhere else to stand. */
  orders?: CombatOrders,
): Array<CombatAiCandidate<RulesetCandidate>> {
  const worth = (candidate: CombatAiCandidate<RulesetCandidate>) => (candidate.damage ?? 0) + (candidate.healing ?? 0);
  const here = rulesetCandidatesFrom(definition, encounter, actorId, null);
  const moved = orders?.posture === "hold" ? [] : rulesetCandidatesAfterMoving(definition, encounter, actorId);
  // Standing still is preferred when it can already do its best from where it is: a candidate that
  // walks first has to be strictly better than every one that does not, not merely as good.
  const staying = here.reduce((most, candidate) => Math.max(most, worth(candidate)), 0);
  // One that stands by its friends or fights beside them (1.745) also weighs walking to an opponent it
  // cannot reach from here, where it is worth anything: whoever is on a friend.
  const roams = tactics?.adjective === "protective" || tactics?.adjective === "coordinated";
  const reachable = new Set(here.map((candidate) => candidate.targetId));
  // Standing in burning oil or a Cloud of Daggers: a step out of it that does as much is weighed too,
  // so the danger it stands in can tell them apart.
  const actor = rulesetCombatant(encounter, actorId);
  const home = rulesetPositionOf(actor);
  const burning = actor && home ? rulesetZoneHarmAt(encounter, actor, home) : 0;
  const cooler = (candidate: CombatAiCandidate<RulesetCandidate>) =>
    burning > 0 &&
    !!actor &&
    !!candidate.action.to &&
    worth(candidate) >= staying &&
    rulesetZoneHarmAt(encounter, actor, candidate.action.to) < burning;
  const candidates = [
    ...here,
    ...moved.filter(
      (candidate) =>
        worth(candidate) > staying ||
        cooler(candidate) ||
        (roams && worth(candidate) > 0 && candidate.targetId !== undefined && !reachable.has(candidate.targetId)),
    ),
  ];
  // Somebody who can hurt an opponent or help a friend does that. The scoring weighs a blow by the
  // share of the target's health it takes, so against a sturdy target a careful creature would score
  // a standard action (dodging, say) above every attack it has and stand there all fight. A standard
  // action or an empty turn is what is left when there is nothing better, never a rival. Judged over
  // the WHOLE list, walks included, so a creature that has to take a step first still takes it.
  if (everything) return candidates;
  // A free trait taken before an attack (1.590) is taken as the attack is made, never in its place.
  const own = candidates.filter((candidate) => {
    const action = actor?.actions.find((one) => one.id === candidate.action.option.id);
    if (action?.free && action.beforeAttack) return false;
    // Told to hold its ground: a dash or a getaway goes nowhere it may go, so it is a wasted turn.
    if (orders?.posture === "hold" && candidate.action.option.kind === "standard") {
      const name = rulesetStandardName(candidate.action.option.id);
      if (name === "dash" || name === "disengage") return false;
    }
    return true;
  });
  // Helping is aiding a friend against an opponent beside its helper: with none beside it, nothing
  // comes of it (a wolf helping from across the field, a companion helping a friend nobody is near).
  const beside = (cell: { x: number; y: number } | null | undefined) =>
    !!actor &&
    !!cell &&
    encounter.combatants.some(
      (one) =>
        one.side !== actor.side &&
        rulesetCombatStanding(one) &&
        !!rulesetPositionOf(one) &&
        rulesetGapFrom(cell, rulesetSpanOf(actor), one) <= 1,
    );
  for (let index = own.length - 1; index >= 0; index--) {
    const candidate = own[index]!;
    if (candidate.action.option.kind !== "standard" || rulesetStandardName(candidate.action.option.id) !== "help")
      continue;
    if (actor && rulesetPositionOf(actor) && !beside(candidate.action.to ?? rulesetPositionOf(actor)))
      own.splice(index, 1);
  }
  const keeps = !!actor && rulesetKeepsDefensive(definition, encounter, actor, tactics, orders);
  // Nothing to hurt or help from anywhere it can get to this turn: a dodge, a getaway or a hide only
  // for one that keeps to them (and not past two turns of it). Anybody else goes looking for the
  // fight, which a defensive pick would stop it doing, so healthy wolves would hide all fight.
  if (!own.some((candidate) => worth(candidate) > 0))
    return keeps ? own : own.filter((candidate) => rulesetDefensiveName(candidate.action.option) === undefined);
  return own.filter(
    (candidate) =>
      (!candidate.hold && candidate.action.option.kind !== "standard") ||
      (keeps && rulesetDefensiveName(candidate.action.option) !== undefined),
  );
}

/** The standard actions a creature may take in place of an attack to keep itself whole (1.745). */
function rulesetDefensiveName(option: RulesetCombatOption): RulesetCandidate["defensive"] {
  if (option.kind !== "standard") return undefined;
  const name = rulesetStandardName(option.id);
  return name === "dodge" || name === "disengage" || name === "hide" ? name : undefined;
}

/** Whether a creature weighs dodging, getting away or hiding against its attacks (1.745): a careful,
 *  cowardly or patient one once it has lost a quarter and stands where a turn of blows would take a
 *  good share of what it has left, any of them and an animal once it is down to half, and one told to
 *  keep back wherever it is in danger. Never a mindless one, and never a whole one: a creature at full
 *  health fights on rather than dodging all fight. */
function rulesetKeepsDefensive(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  tactics: CombatTactics | undefined,
  orders?: CombatOrders,
): boolean {
  if (!tactics || tactics.mind === "mindless" || !definition.combat) return false;
  // Told to get out of the fight, or to keep out of harm's way.
  if (orders?.posture === "retreat") return true;
  // Two turns of it in a row and nothing has changed: it fights again, or the fight never ends.
  if ((tactics.wary ?? 0) >= 2) return false;
  const careful =
    orders?.posture === "back" ||
    tactics.adjective === "cautious" ||
    tactics.adjective === "cowardly" ||
    tactics.adjective === "patient";
  if (!careful && tactics.mind !== "instinct") return false;
  const health = rulesetCombatHealth(definition, definition.combat, actor);
  if (health.value < health.max * 0.5) return true;
  // An animal minds itself once it is hurt, not before: a wolf beside its prey bites rather than
  // dodging because the prey could hit back.
  if (!careful) return false;
  // Kept out of harm's way by its player: wherever a turn of blows would take a good share of it.
  const home = rulesetPositionOf(actor);
  const endangered = !!home && rulesetDangerAt(definition, encounter, actor, home) >= 0.3;
  if (orders?.posture === "back") return endangered;
  // A careful creature is careful sooner, once it has lost a quarter, but a whole one fights: an orc
  // at full health beside a hurt rogue swings rather than dodging half the fight (playtest).
  return health.value < health.max * 0.75 && endangered;
}

/**
 * The harm a combatant would stand in at a cell (1.745), as a share of what it has left: for every
 * opponent still standing, the worst of its blows that could reach it there next turn, in full from
 * where it is and at half from a walk away. What the cautious weigh against standing there.
 */
/** Whether budgets handed over for this turn (Action Surge) buy a blow now: the turn's own of each
 *  is already spent, and something paid from it reaches a standing opponent from here or from where
 *  the movement left takes it. */
function rulesetGiftStrikes(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  gives: Array<{ budget: string }>,
): boolean {
  const here = rulesetPositionOf(actor);
  const span = rulesetSpanOf(actor);
  // Where it could still stand this turn, walked the way the board lets it: a foe across a pit is
  // not in reach for being near in a straight line.
  let stands: Array<{ x: number; y: number }> | undefined;
  const reaches = (foe: RulesetCombatant, reach: number) => {
    if (!here) return true;
    if (rulesetGapFrom(here, span, foe) <= reach) return true;
    stands ??= rulesetWalkableCells(definition, encounter, actor.id);
    return stands.some((cell) => rulesetGapFrom(cell, span, foe) <= reach);
  };
  // Only what its menu would offer with the budget in hand: a handaxe in its pack is not a blow.
  const offered = (budget: string) => {
    const before = actor.budgets[budget];
    actor.budgets[budget] = 1;
    try {
      return new Set(rulesetCombatOptions(definition, encounter, actor.id).map((option) => option.id));
    } finally {
      if (before === undefined) delete actor.budgets[budget];
      else actor.budgets[budget] = before;
    }
  };
  return gives.some((gift) => {
    if ((actor.budgets[gift.budget] ?? 0) > 0) return false;
    const menu = offered(gift.budget);
    return actor.actions.some(
      (action) =>
        menu.has(action.id) &&
        action.budget === gift.budget &&
        !!(action.damage || action.sequence) &&
        encounter.combatants.some(
          (foe) =>
            foe.side !== actor.side &&
            rulesetCombatStanding(foe) &&
            !foe.down &&
            reaches(foe, rulesetActionReach(action)),
        ),
    );
  });
}

/** The health a side stands up with, on average across its standing members. */
function rulesetSideHealthMean(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  side: string,
): number {
  const pools = encounter.combatants
    .filter((one) => one.side === side && rulesetCombatStanding(one))
    .map((one) => {
      const health = rulesetCombatHealth(definition, combat, one);
      return Math.max(1, health.value + health.temp);
    });
  return pools.length ? pools.reduce((sum, pool) => sum + pool, 0) / pools.length : 1;
}

function rulesetDangerAt(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  cell: { x: number; y: number },
  /** Staying there to fight, not getting away: a walk away is no safer than beside it. */
  fights = false,
): number {
  const combat = definition.combat;
  if (!combat) return 0;
  const perCell = combat.distance?.perCell;
  const health = rulesetCombatHealth(definition, combat, actor);
  const pool = Math.max(1, health.value + health.temp);
  const span = rulesetSpanOf(actor);
  let harm = 0;
  for (const foe of encounter.combatants) {
    if (foe.side === actor.side || !rulesetCombatStanding(foe) || !rulesetPositionOf(foe)) continue;
    const gap = rulesetGapFrom(cell, span, foe);
    const walks = perCell ? rulesetInCells(foe.speed, perCell) : 6;
    let worst = 0;
    for (const action of foe.actions) {
      // Only what it could use: a Sunbeam's line while it holds the spell, not before.
      if (!action.damage || !rulesetActionAvailable(foe, action, encounter, definition)) continue;
      const reach = action.range ? (action.range.long ?? action.range.normal) : (action.reach ?? 1);
      // One a walk away comes on its own turn all the same, so standing a square off it is
      // nearly as dangerous as standing beside it; only the far end of its walk is much safer, to
      // one getting away. To one staying to fight there, anywhere it can walk to and strike is as
      // dangerous as beside it, and no reason to throw from afar instead: a captain walking six
      // squares off a knight who walks six squares back makes nothing safer by it (re-test 14).
      // Only a little less, so between two cells that do alike it takes the further.
      const out = (gap - reach) / Math.max(1, walks);
      const at =
        gap <= reach ? 1 : gap > reach + walks ? 0 : fights ? 1 - 0.1 * out ** 2 : Math.max(0, 1 - 1.1 * out ** 3);
      worst = Math.max(worst, rulesetSafeAverage(action.damage) * at);
    }
    harm += worst;
  }
  harm += rulesetZoneHarmAt(encounter, actor, cell);
  harm += rulesetCrowdHarmAt(definition, encounter, actor, cell);
  return Math.min(3, harm / pool);
}

/**
 * What standing bunched with its own side adds where an opponent holds a blast it could still use
 * (S1): an area is worth more to its maker the more it catches, so each friend within its size of the
 * cell makes it likelier to land there, a share of its average for each, up to all of it. Any area
 * that harms, whatever the ruleset calls it: a dragon's breath, a fireball, a grenade.
 */
function rulesetCrowdHarmAt(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  cell: { x: number; y: number },
): number {
  const perCell = definition.combat?.distance?.perCell;
  const span = rulesetSpanOf(actor);
  const friends = encounter.combatants.filter(
    (one) =>
      one.side === actor.side &&
      one.id !== actor.id &&
      !one.object &&
      rulesetCombatStanding(one) &&
      !!rulesetPositionOf(one),
  );
  if (friends.length === 0) return 0;
  let harm = 0;
  for (const foe of encounter.combatants) {
    if (foe.side === actor.side || !rulesetCombatStanding(foe) || !rulesetPositionOf(foe)) continue;
    const gap = rulesetGapFrom(cell, span, foe);
    const walks = perCell ? rulesetInCells(foe.speed, perCell) : 6;
    let worst = 0;
    for (const action of foe.actions) {
      if (!action.area || !action.damage) continue;
      if (!rulesetActionAvailable(foe, action, encounter, definition)) continue;
      if (gap > (action.range?.long ?? action.range?.normal ?? action.area.size) + walks) continue;
      // A burst catches all around its centre; a cone or a line only along one way, so less of it.
      const across = action.area.shape === "burst" ? action.area.size : Math.max(1, Math.floor(action.area.size / 3));
      const caught = friends.filter((one) => rulesetGapFrom(cell, span, one) <= across).length;
      worst = Math.max(worst, rulesetSafeAverage(action.damage) * Math.min(1, 0.3 * caught));
    }
    harm += worst;
  }
  return harm;
}

/** The harm a zone at a cell does whoever starts or ends a turn in it, whoever left it (1.745):
 *  burning oil, a Cloud of Daggers, its own side's Spirit Guardians aside (it spares them). */
function rulesetZoneHarmAt(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  cell: { x: number; y: number },
): number {
  const filled = rulesetFootprintAt(cell, rulesetSpanOf(actor));
  let harm = 0;
  for (const caster of encounter.combatants) {
    for (const zone of caster.zones ?? []) {
      const action = caster.actions.find((entry) => entry.id === zone.actionId);
      if (!action?.damage || !zone.triggers.some((when) => when === "turn-start" || when === "turn-end")) continue;
      const cells = rulesetZoneCells(encounter, caster, zone);
      if (!filled.some((one) => cells.some((at) => at.x === one.x && at.y === one.y))) continue;
      if (!rulesetZoneCatches(caster, zone, action, actor)) continue;
      harm += rulesetSafeAverage(action.damage);
    }
  }
  return harm;
}

/** The cell furthest from every opponent a combatant may walk to (1.745), its danger breaking ties:
 *  where a getaway goes. Null when no cell is further than where it stands. */
function rulesetRetreatCell(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  /** Opponents it takes along (a hungry one's prey, dragged): no reason to get away from them. */
  bringing: readonly string[] = [],
): { x: number; y: number } | null {
  const actor = rulesetCombatant(encounter, actorId);
  const from = rulesetPositionOf(actor);
  if (!actor || !from || !encounter.board?.grid) return null;
  const foes = encounter.combatants.filter(
    (one) =>
      one.side !== actor.side && rulesetCombatStanding(one) && rulesetPositionOf(one) && !bringing.includes(one.id),
  );
  if (foes.length === 0) return null;
  const span = rulesetSpanOf(actor);
  const nearest = (cell: { x: number; y: number }) => Math.min(...foes.map((foe) => rulesetGapFrom(cell, span, foe)));
  let best: { cell: { x: number; y: number }; away: number; danger: number } | null = null;
  const here = nearest(from);
  for (const cell of rulesetWalkableCells(definition, encounter, actorId)) {
    const away = nearest(cell);
    if (away <= here) continue;
    const danger = rulesetDangerAt(definition, encounter, actor, cell);
    // Never into a gap it has to squeeze into (re-test 14 and 15: a crocodile that dragged its prey
    // into a corner gap, or a gap between rocks, and bit at a disadvantage for twelve rounds).
    if (span > 1 && rulesetSqueezeAt(definition, encounter, actor, cell)) continue;
    if (!best || away > best.away || (away === best.away && danger < best.danger))
      best = { cell: { x: cell.x, y: cell.y }, away, danger };
  }
  return best?.cell ?? null;
}

/**
 * The rest of what a creature weighs beside harm and help (1.745), onto each candidate: the danger it
 * would stand in (`risk`), less for a dodge or a hide, and a getaway's from the cell it would run to;
 * standing up for a friend an opponent is on (`protection`), more for one who is hurt or who it
 * guards; and going at whoever its own side is already on (`coordination`).
 */
function weighRulesetTeam(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
  orders?: CombatOrders,
): void {
  const combat = definition.combat;
  if (!combat) return;
  const home = rulesetPositionOf(actor);
  const dangers = new Map<string, number>();
  const danger = (cell: { x: number; y: number }, fights = true) => {
    const key = `${cell.x},${cell.y},${fights}`;
    if (!dangers.has(key)) dangers.set(key, rulesetDangerAt(definition, encounter, actor, cell, fights));
    return dangers.get(key)!;
  };
  const allies = encounter.combatants.filter(
    (one) => one.side === actor.side && one.id !== actor.id && rulesetCombatStanding(one),
  );
  const foes = encounter.combatants.filter((one) => one.side !== actor.side && rulesetCombatStanding(one));
  const near = (a: RulesetCombatant, b: RulesetCombatant) =>
    !!rulesetPositionOf(a) && !!rulesetPositionOf(b) && rulesetGap(a, b) <= 1;
  const hurt = (one: RulesetCombatant) => {
    const health = rulesetCombatHealth(definition, combat, one);
    return health.value < health.max * 0.5;
  };
  const threatened = allies.filter((ally) => foes.some((foe) => near(ally, foe)));
  const units = new Map([...state.party, ...state.enemies].map((unit) => [unit.id, unit]));
  const focus = new Set(allies.map((ally) => units.get(ally.id)?.tactics?.targetId).filter(Boolean));
  // Only one that means to keep itself whole takes these in place of closing in: anybody else's
  // standard action is what is left when nothing is in reach, and it walks instead.
  const keeps = rulesetKeepsDefensive(definition, encounter, actor, units.get(actor.id)?.tactics, orders);
  const role = units.get(actor.id)?.tactics?.role;
  // Getting away from nobody gets it nothing: with no opponent beside it, Disengage is left out (a
  // goblin's Nimble Escape spent eight times out in the open), and so it is with no walk left to
  // get away on.
  if (!foes.some((foe) => near(actor, foe)) || (actor.movement !== undefined && (actor.movementLeft ?? 0) < 1)) {
    const kept = candidates.filter((candidate) => rulesetDefensiveName(candidate.action.option) !== "disengage");
    if (kept.length > 0) candidates.splice(0, candidates.length, ...kept);
  }
  for (const candidate of candidates) {
    const defensive = keeps ? rulesetDefensiveName(candidate.action.option) : undefined;
    if (defensive) {
      candidate.action.defensive = defensive;
      candidate.hold = true;
      candidate.setup = 0;
    }
    if (home) {
      if (defensive === "disengage") {
        const away = rulesetRetreatCell(definition, encounter, actor.id);
        candidate.risk = away ? danger(away, false) : danger(home, false);
        if (away) candidate.action.to = away;
      } else {
        const cell = candidate.action.to ?? home;
        // Hiding is worth something only out of an opponent's reach: next to one, it is seen.
        const seen = foes.some((foe) => near(actor, foe));
        candidate.risk = danger(cell) * (defensive === "dodge" ? 0.7 : defensive === "hide" && !seen ? 0.6 : 1);
      }
    }
    // Where it ends up (combat AI A1): beside a friend an opponent is on, which a bulwark stands up
    // for, and beside a hurt one, which a supporter keeps close to.
    const lands = candidate.action.to;
    const beside = (ally: RulesetCombatant) => {
      const at = rulesetPositionOf(ally);
      return !!lands && !!at && Math.max(Math.abs(at.x - lands.x), Math.abs(at.y - lands.y)) <= 1;
    };
    const covers = lands ? threatened.filter(beside).length : 0;
    if (role === "supporter" && lands && allies.some((ally) => hurt(ally) && beside(ally)))
      candidate.support = (candidate.support ?? 0) + 0.15;
    const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : undefined;
    if (!target || target.side === actor.side) {
      if (covers > 0) candidate.protection = Math.min(1, 0.3 * covers);
      continue;
    }
    const guarding = threatened.filter((ally) => near(ally, target));
    if (guarding.length > 0 || covers > 0)
      candidate.protection = Math.min(
        1,
        guarding.reduce((sum, ally) => sum + 0.5 + (hurt(ally) ? 0.3 : 0), 0) + 0.3 * covers,
      );
    const engaged = allies.filter((ally) => near(ally, target)).length;
    // From across the target from a friend already on it (combat AI A1): a flank, a skirmisher's.
    const there = rulesetPositionOf(target);
    const flanks =
      !!lands &&
      !!there &&
      allies.some((ally) => {
        const at = rulesetPositionOf(ally);
        return (
          !!at &&
          near(ally, target) &&
          Math.sign(at.x - there.x) === -Math.sign(lands.x - there.x) &&
          Math.sign(at.y - there.y) === -Math.sign(lands.y - there.y)
        );
      });
    const together = Math.min(1, 0.35 * engaged + (focus.has(target.id) ? 0.3 : 0) + (flanks ? 0.3 : 0));
    if (together > 0) candidate.coordination = together;
  }
}

/** What a mindless creature does (1.745): whoever it went for, while they stand, else whoever is
 *  nearest, and nothing between turns but strike at one walking away. */
function mindlessCandidates(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  tactics: CombatTactics,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
  menu: boolean,
): Array<CombatAiCandidate<RulesetCandidate>> {
  if (menu) {
    if (encounter.window?.trigger.kind === "leaves-reach") return candidates;
    const pass = candidates.filter((candidate) => candidate.hold);
    return pass.length > 0 ? pass : candidates;
  }
  const foes = encounter.combatants.filter((one) => one.side !== actor.side && rulesetCombatStanding(one));
  const kept = foes.find((one) => one.id === tactics.targetId);
  const target = kept ?? [...foes].sort((a, b) => rulesetGap(actor, a) - rulesetGap(actor, b))[0];
  if (!target) return candidates;
  const at = candidates.filter((candidate) => candidate.targetId === target.id && (candidate.damage ?? 0) > 0);
  return at.length > 0 ? at : candidates;
}

/**
 * Everything the actor could do from the cells it can walk to, each candidate carrying the walk
 * that gets it there. The walk's own price is the strikes it would be met with on the way, taken
 * off the candidate's score, so a creature will not dance through three people's reach for a
 * slightly better target.
 */
/**
 * The cells the actor may walk to, exactly as its own menu offers them, nearest an opponent first.
 *
 * Read off the MENU, never worked out again here: the menu is where a creature that cannot move,
 * or that has to stand up before it walks, is told so, and a picker with its own idea of where it
 * can go would choose a walk the rules then refuse and lose its turn to the refusal.
 *
 * Nearest an opponent first, because that is where the cells worth scoring are: a creature that can
 * cover eight cells has hundreds to choose from, and the ones next to it are the ones it least wants.
 */
export function rulesetWalkableCells(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
): NonNullable<RulesetCombatOption["cells"]> {
  const actor = rulesetCombatant(encounter, actorId);
  const walk = rulesetCombatOptions(definition, encounter, actorId).find((option) => option.id === RULESET_MOVE_OPTION);
  const cells = walk?.cells ?? [];
  if (!actor || cells.length === 0) return [];
  const foes = encounter.combatants.filter(
    (combatant) => combatant.side !== actor.side && rulesetCombatStanding(combatant) && rulesetPositionOf(combatant),
  );
  // Footprint to footprint (1.194).
  const span = rulesetSpanOf(actor);
  const away = (cell: { x: number; y: number }) =>
    foes.reduce((closest, foe) => Math.min(closest, rulesetGapFrom(cell, span, foe)), Infinity);
  // Open ground before a gap it would squeeze into, as near (re-test 17).
  const squeezes = new Map<string, number>();
  const squeezed = (cell: { x: number; y: number }) => {
    if (span <= 1 && !actor.squeezedFrom) return 0;
    const key = `${cell.x},${cell.y}`;
    if (!squeezes.has(key)) squeezes.set(key, rulesetSqueezeAt(definition, encounter, actor, cell) ? 1 : 0);
    return squeezes.get(key)!;
  };
  // A stable sort over an already deterministic list, so the same fight always picks the same cell.
  return [...cells].sort(
    (left, right) => away(left) - away(right) || squeezed(left) - squeezed(right) || left.cost - right.cost,
  );
}

/** What blows from a squeeze gap are worth against the same from open ground: about what a
 *  disadvantage takes off a middling chance to hit. */
const RULESET_SQUEEZED_BLOWS = 0.6;

function rulesetCandidatesAfterMoving(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
): Array<CombatAiCandidate<RulesetCandidate>> {
  const actor = rulesetCombatant(encounter, actorId);
  if (!encounter.board?.grid || !actor || typeof actor.x !== "number" || typeof actor.y !== "number") return [];
  const cells = rulesetWalkableCells(definition, encounter, actorId).slice(0, RULESET_MOVE_CANDIDATE_CELLS);
  if (cells.length === 0) return [];
  const home = { x: actor.x, y: actor.y, movementLeft: actor.movementLeft };
  const span = rulesetSpanOf(actor);
  const candidates: Array<CombatAiCandidate<RulesetCandidate>> = [];
  const deadline = Date.now() + RULESET_MOVE_PLAN_MS;
  for (const cell of cells) {
    // The places nearest an opponent come first, so what a long think leaves out mattered least.
    if (Date.now() > deadline) break;
    // Standing the actor in the cell for exactly as long as the menu is read from it. Nothing else
    // is touched, and everything is put straight back, so the fight is the one it was. The
    // allowance is emptied for the pass because a candidate that walks here has spent it getting
    // here, and the picker never chains a second walk onto one.
    actor.x = cell.x;
    actor.y = cell.y;
    actor.movementLeft = 0;
    let from: Array<CombatAiCandidate<RulesetCandidate>> = [];
    try {
      from = rulesetCandidatesFrom(definition, encounter, actorId, cell);
    } finally {
      actor.x = home.x;
      actor.y = home.y;
      actor.movementLeft = home.movementLeft;
    }
    const penalty = cell.provokes.length * RULESET_PROVOKE_PENALTY;
    // Blows from a gap it squeezes into are at a disadvantage the menu read here does not know of
    // yet; blows from open ground, once squeezed, are out of the one it has (re-test 17: a
    // crocodile biting from a gap for fifty rounds with open ground beside Brom).
    const squeezes = (span > 1 || !!actor.squeezedFrom) && !!rulesetSqueezeAt(definition, encounter, actor, cell);
    const scale = squeezes ? RULESET_SQUEEZED_BLOWS : actor.squeezedFrom ? 1 / RULESET_SQUEEZED_BLOWS : 1;
    for (const candidate of from) {
      if (candidate.damage !== undefined) candidate.damage = Math.max(0, candidate.damage * scale - penalty);
      if (candidate.healing !== undefined) candidate.healing = Math.max(0, candidate.healing - penalty);
      candidates.push(candidate);
    }
  }
  return candidates;
}

/** What a window's answer of "nothing" is called when the Game Master is the one answering. Plain
 *  text like the resolver's own "Move" and "Stand up": it is written for the model that reads the
 *  menu, and the client draws its own words over the same choice. */
const RULESET_PASS_LABEL = "Let the moment go by";

/** The pool an answer is paid from and the initiative style it is made in, each left out entirely
 *  when it is the option's own. */
const paying = (way: { payWith?: string; style?: string; mode?: string; option?: RulesetCombatOption }) => ({
  ...(way.payWith === undefined ? {} : { payWith: way.payWith }),
  ...(way.style === undefined ? {} : { style: way.style }),
  ...(way.mode === undefined ? {} : { mode: way.mode }),
  // One castable now only with an alteration (1.253) is cast with it: Quickened once the action is spent.
  ...(way.option?.alterNeeded ? { alters: [way.option.alterNeeded] } : {}),
});

/** One way of doing something off the menu: the option, the pool it is paid from and the style it
 *  is made in when those are not the option's own, and what that way costs. A style that takes also
 *  says what it is expected to take off a target and what its maker gains on top. */
interface PricedOption {
  option: RulesetCombatOption;
  payWith?: string;
  style?: string;
  mode?: string;
  takes?: { shift: number; gain: number };
  price: number;
}

/**
 * Every option on a menu, and every BIGGER way of paying for one, each with what that costs.
 *
 * A player is offered the pools an ability could be paid from and picks one. A party member the
 * Engine plays was not: the picker only ever saw the base cost, so a character handed to the Engine
 * never cast a spell that grows any bigger, on a turn or in a window. Each way of paying is its own
 * candidate now, so casting it bigger is weighed against casting it at all.
 *
 * Only somebody with a SHEET has pools to pay out of. A plain stat block's actions cost nothing off
 * any pool (see `planRulesetCombatCost`), so an opponent without a sheet, a Game Master's invented
 * one included, has no bigger way of paying to be offered. A bestiary creature that carries a sheet
 * does, and is offered them exactly as a party member is, whoever is deciding for it.
 *
 * The price counts the steps as well as the amount, because one pool of a higher rung is worth more
 * than one of a lower: without that the bigger version reads as free and nothing would ever cast
 * the small one.
 */
export function priced(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  menu?: RulesetCombatOption[],
): PricedOption[] {
  const out: PricedOption[] = [];
  // What is left in each pool of its sheet: the fewer left, the dearer each one, so the last is kept
  // for when it matters (half again its price) and a full pool is spent freely.
  const left = actor.sheet
    ? new Map(
        readRulesetLive(definition, actor.sheet.build, actor.sheet.live, actor.sheet.items).pools.map((pool) => [
          pool.key,
          pool.value,
        ]),
      )
    : undefined;
  for (const option of menu ?? rulesetCombatOptions(definition, encounter, actor.id)) {
    const base =
      (option.cost ?? []).reduce(
        (total, entry) => total + entry.amount * (1 + 0.5 / Math.max(1, left?.get(entry.pool) ?? Infinity)),
        0,
      ) +
      (option.signature?.cost ?? 0) +
      // An item used up by using it (a flask of oil, a vial of acid) is not thrown for nothing.
      (actor.actions.find((action) => action.id === option.id)?.itemUse?.consumes ? 0.25 : 0);
    // One that only a higher pool can pay for now (1.171) is never taken at its own price.
    const ways: PricedOption[] = [
      ...(option.upcastOnly ? [] : [{ option, price: base }]),
      ...biggerWays(definition, actor, option),
    ];
    // Modes first, so each mode is then made in every style, forecast as that style does.
    out.push(...ways.flatMap(modedWays).flatMap((way) => styledWays(definition, way)));
  }
  return out;
}

/** The bigger ways of paying for one option: once per pool it could be paid from, each with its
 *  own label, cost and forecast. None for something that grows no bigger. */
function biggerWays(
  definition: RulesetDefinition,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
): PricedOption[] {
  const action = actor.actions.find((entry) => entry.id === option.id);
  // What grows paid bigger, or what can only be paid out of another pool now (1.171).
  const grows = !!action?.use?.perCostStep || !!action?.use?.targetsPerStep;
  if (!action || (!grows && !option.upcastOnly)) return [];
  const ways: PricedOption[] = [];
  for (const pool of option.payWith ?? []) {
    const steps = rulesetCostSteps(definition, action, pool, actor);
    if (steps < 1 && !option.upcastOnly) continue;
    const paid = planRulesetCombatCost(definition, actor, action, pool);
    if (!paid) continue;
    const extra = action.use?.perCostStep ? steps * rulesetAverageAmount(action.use.perCostStep) : 0;
    const forecast = option.forecast ? { ...option.forecast } : undefined;
    if (forecast?.averageDamage !== undefined) {
      forecast.averageDamage = Math.round((forecast.averageDamage + extra) * 100) / 100;
    }
    ways.push({
      option: {
        ...option,
        // Named for the pool it spends, so a Game Master reading the menu can tell the two apart.
        label: `${option.label} (${paid.cost[0]?.label ?? pool})`,
        cost: paid.cost.map((entry) => ({ pool: entry.pool, label: entry.label, amount: entry.amount })),
        ...(forecast ? { forecast } : {}),
        // As many targets as this pool lets it take (1.171).
        ...(option.targetsWith?.[pool] !== undefined
          ? { targets: { ...option.targets, count: option.targetsWith[pool]! } }
          : {}),
      },
      payWith: pool,
      price: paid.cost.reduce((total, entry) => total + entry.amount, 0) + steps,
    });
  }
  return ways;
}

/**
 * Every way of paying, once per initiative style the attack may be made in, where initiative is a
 * number attacks move. A style that spends forecasts the harm its maker's number would do; one that
 * takes forecasts no harm at all and carries what it would take instead, which the picker weighs as
 * what those dice would be worth to spend later.
 */
function styledWays(definition: RulesetDefinition, way: PricedOption): PricedOption[] {
  const styles = way.option.styles;
  const resource = definition.combat?.initiative.resource;
  if (!styles?.length || !resource) return [way];
  const option = { ...way.option };
  delete option.styles;
  return styles.map((style) => {
    const takes = resource.styles.find((entry) => entry.id === style.id)?.takes;
    const hitChance = way.option.forecast?.hitChance ?? style.forecast?.hitChance;
    const averageDamage = takes ? 0 : (style.forecast?.averageDamage ?? 0);
    return {
      ...way,
      option: {
        ...option,
        // Named for its style as well, so a Game Master reading the menu can tell them apart.
        label: `${option.label}, ${style.label}`,
        forecast: { ...(hitChance !== undefined ? { hitChance } : {}), averageDamage },
      },
      style: style.id,
      ...(takes ? { takes: { shift: way.option.forecast?.averageDamage ?? 0, gain: takes.gain } } : {}),
    };
  });
}

/**
 * Every way of paying, once more for each mode the weapon may be used in now, named for it and
 * forecast as it would do. Only a mode aimed at one target: the picker aims every candidate at one,
 * and a mode for several would pay for shots it never takes.
 * ponytail: a party member the Engine plays never looses a volley at several; weighing a candidate
 * per group of targets is the upgrade.
 */
function modedWays(way: PricedOption): PricedOption[] {
  const modes = way.option.modes;
  if (!modes?.length) return [way];
  const option = { ...way.option };
  delete option.modes;
  return [
    { ...way, option },
    ...modes
      .filter((mode) => mode.targets <= 1)
      .map((mode) => ({
        ...way,
        option: {
          ...option,
          // Named for its mode as well, so a Game Master reading the menu can tell them apart.
          label: `${option.label} (${mode.label})`,
          ...(mode.forecast ? { forecast: { ...mode.forecast } } : {}),
        },
        mode: mode.id,
      })),
  ];
}

/** Whom a window option really lands on when the option itself asks for nobody: the one walking
 *  away from a reach, or whoever caused a moment, for a reaction pointed back at them. Undefined for
 *  something its holder does to themselves, which is weighed as what it is. */
export function rulesetWindowTargetOf(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
): string | undefined {
  const trigger = encounter.window?.trigger;
  if (!trigger || option.targets.count > 0 || option.id === RULESET_PASS_OPTION) return undefined;
  if (trigger.kind === "leaves-reach") return trigger.moverId;
  if (trigger.kind === "falls") return trigger.sourceId;
  if (
    trigger.kind !== "aimed" &&
    trigger.kind !== "hit" &&
    trigger.kind !== "harmed" &&
    trigger.kind !== "used" &&
    trigger.kind !== "turn-start" &&
    trigger.kind !== "caught" &&
    trigger.kind !== "attacked"
  ) {
    return undefined;
  }
  const action = actor.actions.find((entry) => entry.id === option.id);
  if (action?.reaction?.at === "target")
    return rulesetReactionTarget(encounter, actor, action, trigger.kind, trigger.sourceId, {
      ...("targetIds" in trigger ? { targetIds: trigger.targetIds } : {}),
      ...("optionId" in trigger &&
      rulesetCombatant(encounter, trigger.sourceId)?.block &&
      !("catalog" in trigger && trigger.catalog)
        ? { action: trigger.label }
        : {}),
      ...("catalog" in trigger ? { catalog: trigger.catalog } : {}),
      ...("entry" in trigger ? { entry: trigger.entry } : {}),
      ...(trigger.kind === "hit" ? { blow: trigger.blow } : {}),
    });
  // A Counterspell lands on the cast, whatever its own targets say: a creature's is written as one
  // it casts on itself, and weighed as that it was a slot spent for nothing.
  return action &&
    (rulesetReactionPointsAtSource(action) || (action.reaction?.cancels && action.reaction.at === "source"))
    ? trigger.sourceId
    : undefined;
}

function rulesetCandidatesFrom(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  /** The cell the actor is standing in for this pass, or null for the one they are really in. */
  standing: { x: number; y: number } | null,
  /** The menu to score. A turn's by default; a window hands in its own, so what an opponent takes
   *  out of turn is weighed by exactly the same scoring as what it takes on one. */
  menu?: RulesetCombatOption[],
): Array<CombatAiCandidate<RulesetCandidate>> {
  const combat = definition.combat;
  const actor = rulesetCombatant(encounter, actorId);
  if (!combat || !actor) return [];
  const candidates: Array<CombatAiCandidate<RulesetCandidate>> = [];
  // A window's menu may always be declined. Without this the picker would spend a reaction every
  // time one was on offer, and availability alone should never force a spend: letting the moment go
  // by is weighed exactly as ending a turn is.
  if (menu) {
    const letGo: RulesetCombatOption = {
      id: RULESET_PASS_OPTION,
      kind: "end-turn",
      label: RULESET_PASS_LABEL,
      targets: { side: "self", count: 0 },
    };
    candidates.push({ action: { choice: { actorId, optionId: letGo.id, targetIds: [] }, option: letGo }, hold: true });
  }
  for (const way of priced(definition, encounter, actor, menu)) {
    const { option, price } = way;
    // Nothing can come of it from here: a Hide in the open.
    if (option.futile) continue;
    // Waiting to treat somebody (pulling a friend out of a cube, first aid) is the Game Master's to
    // ready, never the picker's: it would stand there all fight for a turn nobody needs.
    if (option.ready) {
      const contest = actor.actions.find((one) => one.id === option.ready?.optionId)?.contest;
      if (contest?.pulls || contest?.targetHolds || contest?.targetDying) continue;
    }
    // Cast again while what it left still stands, it only puts back what is there and spends another
    // slot on it: a Spiritual Weapon strikes again instead, and a standing zone stays where it is.
    if (
      !menu &&
      (actor.summons?.some((one) => one.actionId === option.id) ||
        actor.zones?.some((one) => one.actionId === option.id))
    )
      continue;
    // Turning a line or cone the actor carries (1.182) is weighed the same way, before any walk.
    if (option.id.startsWith(RULESET_ZONE_TURN_OPTION_PREFIX)) {
      const turned = standing ? null : zoneTurnCandidate(encounter, actor, option, price);
      if (turned) candidates.push(turned);
      continue;
    }
    // Moving a lasting area (1.173) is weighed from where the actor stands, by whom it would catch.
    if (option.id.startsWith(RULESET_ZONE_OPTION_PREFIX)) {
      const moved = standing ? null : zoneMoveCandidate(encounter, actor, option, price);
      if (moved) candidates.push(moved);
      continue;
    }
    // A teleport (1.276) is weighed from where the actor stands, by where it would take them.
    if (option.teleport) {
      const gone = standing ? null : teleportCandidate(definition, combat, encounter, actor, option, way, price);
      if (gone) candidates.push(gone);
      continue;
    }
    // A legendary move (1.283) the same way, by where it would take them, and a creature's move on
    // its own turn (1.591): an orc's Aggressive.
    if (
      option.cells &&
      !option.moveAfter &&
      (option.signature || actor.actions.find((one) => one.id === option.id)?.move)
    ) {
      const moved = standing ? null : legendaryMoveCandidate(definition, combat, encounter, actor, option, price);
      if (moved) candidates.push(moved);
      continue;
    }
    // Walking is not a candidate of its own: it is what a candidate does before it acts, and a turn
    // with nothing to act on closes the distance instead (see `rulesetClosingMove`).
    if (option.kind === "move") continue;
    // Averting the eyes is settled as the turn starts (see `playRulesetTurn`), and so is slipping free.
    if (option.avert || option.slip) continue;
    // An attack given up for a called creature's (1.472) is its player's own call: the Engine keeps
    // its own attacks.
    if (option.lend) continue;
    // Putting away a weapon put in hand (1.308) is its player's own call: the Engine keeps it.
    if (option.dismiss) continue;
    // So is turning something off, or a light, pulling blows or an item's form: flicked every turn
    // for a guessed worth, it only filled the log. Orders that want blows pulled pull them (P7). An
    // item turned on (a flame tongue lit) is still weighed, once. A lantern only where it is dark
    // enough to want one: lit in daylight it is a turn spent on nothing.
    if (option.on !== undefined) {
      const switches = actor.actions.find((entry) => entry.id === option.id)?.switches;
      if (option.on || !switches || !("item" in switches)) continue;
      const item = actor.sheet?.items?.[switches.item]?.item;
      const at = rulesetPositionOf(actor);
      const light = at ? rulesetLightAt(definition, encounter, at) : "bright";
      if ((item?.carried?.light || item?.toggle?.offLight) && (light === "bright" || light === "sunlight")) continue;
    }
    // From another cell, only what the actor would do THERE is worth enumerating: everything it
    // could do without moving is already on the list.
    if (standing && option.targets.count <= 0 && !option.area) continue;
    if (option.kind === "end-turn") {
      candidates.push({ action: { choice: { actorId, optionId: option.id, targetIds: [] }, option }, hold: true });
      continue;
    }
    // A weapon put in hand (1.306), once, before it fights: the one that hits hardest of those it
    // may make or bind. With one in hand already it is never taken again.
    const conjuring = actor.actions.find((entry) => entry.id === option.id);
    if (conjuring?.conjures) {
      if (standing || actor.conjured?.[option.id]) continue;
      const average = (mode: string) =>
        Math.max(
          0,
          ...(actor.conjurable?.[`${option.id}|${mode}`]?.actions ?? []).map((one) =>
            one.damage ? (one.damage.count * (one.damage.sides + 1)) / 2 + one.damage.flat : 0,
          ),
        );
      // The action's own modes: each way weighed here is one of them, with the others taken off.
      const best = [...(conjuring.modes ?? [])].sort((a, b) => average(b.id) - average(a.id))[0];
      // Each mode is a way of its own: only the best is weighed.
      if (!best || average(best.id) <= 0 || way.mode !== best.id) continue;
      candidates.push({
        action: { choice: { actorId, optionId: option.id, targetIds: [], ...paying(way) }, option },
        setup: 0.6,
        cost: price,
      });
      continue;
    }
    // A guard taken after being hit is worth the blow it turns aside, and nothing at all when the
    // roll beats it anyway: spending it then would only waste it. Read before any other weighing,
    // since a guard aimed at its own holder would otherwise be scored as help for a friend.
    const deflects = menu ? rulesetAnswerDeflects(definition, encounter, actor, option.id) : null;
    if (deflects === false) continue;
    if (deflects) {
      candidates.push({
        action: { choice: { actorId, optionId: option.id, targetIds: [], ...paying(way) }, option },
        healing: 1,
        cost: price,
      });
      continue;
    }
    // A contest is weighed by what winning it would do, times the chance of winning against THAT
    // target, and kept modest: a grab or a shove sets something up, and an opponent that wrestled
    // instead of fighting would be played badly. Breaking free is worth most, and only while held.
    if (option.kind === "contest") {
      const contest = actor.actions.find((entry) => entry.id === option.id)?.contest;
      if (!contest) continue;
      for (const targetId of rulesetOptionTargets(definition, encounter, actorId, option)) {
        const target = rulesetCombatant(encounter, targetId);
        if (!target) continue;
        // Treating somebody (1.193): steadying a friend who is dying, or ending what holds a friend.
        const ally = target.side === actor.side;
        const steadies = ally && !!contest.stabilizes && target.dying && !target.stable && !target.defeated;
        if (target.down && !steadies) continue;
        const chance = rulesetContestChance(definition, combat, actor, target, contest, encounter) ?? 0.5;
        const held = new Set(rulesetCombatConditions(definition, actor));
        const theirs = new Set(rulesetCombatConditions(definition, target));
        const frees = (contest.ends ?? []).some((entry) => entry.on === "actor" && held.has(entry.condition));
        const treats =
          ally && (contest.ends ?? []).some((entry) => entry.on === "target" && theirs.has(entry.condition));
        const holds = !ally && (contest.applies ?? []).some((entry) => !theirs.has(entry.condition));
        // A shove with nowhere to send them (cornered, or held in place) does nothing (re-test 16).
        const shoves =
          !ally &&
          contest.push !== undefined &&
          !!encounter.board &&
          rulesetPushPath(encounter, actorId, targetId, Math.max(1, contest.push)).length > 0;
        // What it puts on them, read as any condition is and never more than a modest setup: a shove
        // down is worth little to a lone shover, whose target stands up before it could use it.
        const read = holds
          ? rulesetEffectWorth(
              definition,
              combat,
              encounter,
              actor,
              // What a won contest puts on lasts until it is ended (escaping a grapple, standing up).
              {
                applies: (contest.applies ?? []).map((entry) => ({ duration: "until-dispelled", ...entry })),
              } as RulesetCombatAction,
              target,
            )
          : undefined;
        // Somebody it holds already is set up as much as wrestling them will: its blows are what is
        // left (re-test 16, a crocodile shoving the cleric in its jaws a hundred times).
        const mine = !ally && rulesetDragging(definition, encounter, actor).ids.includes(targetId);
        const worth = frees ? 1 : mine ? 0 : holds ? Math.min(0.3, read ?? 0.3) : shoves ? 0.15 : 0;
        // A treatment is weighed as the heal it stands in for.
        const care = steadies ? 1 : treats ? 0.5 : 0;
        if (worth <= 0 && care <= 0) continue;
        candidates.push({
          action: {
            choice: { actorId, optionId: option.id, targetIds: [targetId], ...paying(way) },
            option,
            targetId,
          },
          targetId,
          ...(care > 0 ? { healing: care * chance } : { setup: worth * chance }),
          cost: price,
        });
      }
      continue;
    }
    // In a window, an option that asks for nobody may still land on somebody: whoever is walking
    // away, or whoever caused the moment. It is weighed by what it would do to THEM, and its answer
    // still names nobody, because the rules fill that target in.
    const fallingAction = actor.actions.find((entry) => entry.id === option.id);
    if (menu && encounter.window?.trigger.kind === "falls" && option.targets.count > 1 && fallingAction) {
      const targetIds = rulesetFallTargets(definition, encounter, actor, fallingAction).slice(0, option.targets.count);
      candidates.push({
        action: { choice: { actorId, optionId: option.id, targetIds, ...paying(way) }, option },
        setup: targetIds.length,
        cost: price,
      });
      continue;
    }
    // A burst centred on the actor (1.282) is worth whom it catches from where it stands: the other
    // side for it, its own against it, or the other way round for one that mends.
    const aroundAction = fallingAction?.around ? fallingAction : undefined;
    if (aroundAction) {
      if (standing) continue;
      const caught = rulesetAroundTargets(encounter, actor, aroundAction);
      // Harm that catches nobody of the other side is not worth its price, whoever it does catch.
      if (!aroundAction.heal && !caught.some((one) => one.side !== actor.side && !one.down)) continue;
      const candidate: CombatAiCandidate<RulesetCandidate> = {
        action: { choice: { actorId, optionId: option.id, targetIds: [], ...paying(way) }, option },
        cost: price,
      };
      if (weighCaught(definition, combat, encounter, actor, option, caught, candidate)) candidates.push(candidate);
      continue;
    }
    const lands = menu ? rulesetWindowTargetOf(encounter, actor, option) : undefined;
    if (option.targets.count <= 0 && !lands) {
      // Holding the thing it is already holding would end it and start it again for the same price.
      if (actor.concentrating?.actionId === option.id) continue;
      const self: CombatAiCandidate<RulesetCandidate> = {
        action: { choice: { actorId, optionId: option.id, targetIds: [], ...paying(way) }, option },
        cost: price,
      };
      if (option.heals && option.targets.side === "self") {
        // Mending itself (Second Wind) is worth what it is missing, and nothing when whole.
        const health = rulesetCombatHealth(definition, combat, actor);
        const worth = rulesetHealingWorth(option.forecast?.averageDamage ?? 0, health);
        if (worth <= 0) continue;
        self.healing = worth;
      } else if (fallingAction?.gives?.length) {
        // A budget handed to itself for this turn (Action Surge) is worth only a blow it can buy:
        // once the turn's own is spent, with something that reaches an opponent from here.
        if (!rulesetGiftStrikes(definition, encounter, actor, fallingAction.gives)) continue;
        self.support = 1;
      } else {
        // What it puts on itself, where that can be read; else the old modest guess.
        const own =
          option.targets.side === "self"
            ? rulesetEffectWorth(definition, combat, encounter, actor, fallingAction, actor)
            : undefined;
        if (own === 0 && option.kind !== "standard") continue;
        self.setup = option.kind === "standard" ? 0.05 : (own ?? 0.4);
      }
      candidates.push(self);
      continue;
    }
    // A shape lands on a cell, so the aims are the candidates: each one is worth what it catches,
    // and the actor's own side counts against it.
    if (option.area) {
      // Aiming a shape is the one thing here whose cost grows with the BOARD, and it is asked again
      // from every cell the actor might walk to. On the boards this Engine draws that is nothing; on
      // a far larger one that arrived through an import, a shape is only aimed from where the actor
      // really stands, which costs a creature a cleverer walk and never costs the server a turn.
      const grid = encounter.board?.grid;
      if (standing && grid && grid.width * grid.height > RULESET_AREA_WALK_BOARD_CELLS) continue;
      candidates.push(...areaCandidates(definition, combat, encounter, actor, option, standing, way, price));
      continue;
    }
    const legal = lands ? [lands] : rulesetOptionTargets(definition, encounter, actorId, option);
    // An action made of other actions sends all of them at one opponent. Anything else that may
    // take several targets takes as many as it is allowed: a breath that could catch three people
    // and is pointed at one is an opponent played badly, not an opponent played kindly.
    const sequenced = !!actor.actions.find((entry) => entry.id === option.id)?.sequence;
    const spreads = option.targets.count > 1 && !sequenced;
    for (const targetId of legal) {
      const target = rulesetCombatant(encounter, targetId);
      if (!target) continue;
      // Whose side the TARGET is on, not whose side the option was written for: an author may let a
      // blast reach either side, and a fight where the Engine drops one on its own party is worse
      // than one where it never does.
      const ally = target.side === actor.side;
      // Out of what its health pool or ceiling reaches (Sleep, Power Word Stun): nothing done to them.
      if (rulesetPoolReaches(definition, combat, actor, fallingAction, [target], way.payWith).length === 0) continue;
      const health = rulesetCombatHealth(definition, combat, target);
      const pool = Math.max(1, health.value + health.temp);
      // As likely to land on this one as it is: a dagger thrown far, at disadvantage, against the
      // one beside it. A Multiattack counts each part's own chance in what it is worth, below. A
      // mode or a style has its own forecast, which is kept.
      const chance = sequenced
        ? 1
        : option.forecast?.hitChance !== undefined && way.mode === undefined && way.style === undefined
          ? (rulesetHitChances(definition, encounter, actorId, option.id, [targetId])[targetId] ??
            option.forecast.hitChance)
          : 1;
      // A Multiattack is worth only the parts that reach this one: a captain's scimitars do nothing
      // to somebody it could only throw a dagger at.
      const forecast =
        (sequenced
          ? rulesetSequenceForecastAgainst(definition, encounter, actorId, option.id, targetId)
          : option.forecast
        )?.averageDamage ?? 0;
      // As the target's own hide takes it, on the other side only: a weakness found, a regeneration
      // stopped, an immunity not wasted on (I1).
      const average =
        !ally && !sequenced && fallingAction?.damage
          ? rulesetAverageAgainst(definition, combat, encounter, target, fallingAction.damage, forecast)
          : forecast;
      const candidate: CombatAiCandidate<RulesetCandidate> = {
        action: {
          choice: { actorId, optionId: option.id, targetIds: lands ? [] : [targetId], ...paying(way) },
          option,
          targetId,
        },
        targetId,
        cost: price,
      };
      if (way.takes) {
        // A blow that takes is weighed a turn ahead, against spending now and spending again from
        // the base: taking and then spending throws the number plus what was taken and gained,
        // which beats that only when the taking is worth more than the base. A crash it would cause
        // adds its bonus. Never on its own side or on somebody already down, and worth a little as
        // a setup either way, since a crashed maker has nothing else to attack with.
        if (ally || target.down) continue;
        const resource = combat.initiative.resource;
        const crash = resource?.crash;
        const crashes = !!crash && target.initiative > crash.at && target.initiative - way.takes.shift <= crash.at;
        const gained = chance * (way.takes.shift + way.takes.gain + (crashes ? crash.bonus : 0));
        const ahead = Math.max(0, actor.initiative + gained - (resource?.base ?? 0));
        candidate.damage = Math.min(2, (rulesetDamageAverage(definition, combat, ahead) / pool) * chance);
        candidate.setup = Math.min(1, gained / 6);
        candidates.push(candidate);
        continue;
      }
      if (option.heals) {
        // Never on the other side, and never on somebody with nothing to gain by it.
        if (!ally || (health.value >= health.max && !target.down)) continue;
        // Healing that stops at half their health (Preserve Life) is worth only what it gives below
        // that (re-test 2026-10-23: a Channel Divinity spent on 2 health).
        const capped =
          fallingAction?.sharesHeal === "half"
            ? { value: health.value, max: Math.max(health.value, Math.floor(health.max / 2)) }
            : health;
        if (capped.value >= capped.max && !target.down) continue;
        candidate.healing =
          rulesetHealingWorth(average, capped) * (capped.max / Math.max(1, health.max)) + (target.down ? 1 : 0);
      } else if (average > 0) {
        // Never its own side, and never somebody who is already down: the rules let a blow land on
        // them, and a table where every opponent finishes off the dying is not one anybody plays
        // at. A human may still choose it; nothing the Engine enumerates for itself or for a Game
        // Master's boss includes it, but a cruel one's where the game allows it (combat AI T3).
        if (ally || (target.down && (actor.temperament !== "cruel" || target.defeated))) continue;
        const others = spreads
          ? legal
              .filter((id) => id !== targetId)
              .map((id) => rulesetCombatant(encounter, id))
              .filter((other): other is RulesetCombatant => !!other && other.side !== actor.side && !other.down)
              .slice(0, option.targets.count - 1)
          : [];
        // What is left of one that may be pointed at the same one again (1.305) goes at this one:
        // eldritch blast's every beam.
        const again = option.targets.repeat ? Math.max(0, option.targets.count - 1 - others.length) : 0;
        if (!lands)
          candidate.action.choice.targetIds = [
            targetId,
            ...others.map((other) => other.id),
            ...Array.from({ length: again }, () => targetId),
          ];
        // Weighed against what its side stands up with as well as what the target has: a scratch on
        // the frail one is still a scratch, and a full Multiattack on the one beside it is worth more
        // than a dagger thrown far at disadvantage. Nobody counts as frailer than its side's mean, so
        // two daggers thrown at long range at the wizard do not beat the Multiattack on the fighter
        // two steps away (re-test 12). By what it does, not by who takes it (re-test 13): the knight's
        // greater health makes a Multiattack on him worth no less than the same harm on the wizard.
        // Finishing one off is weighed by its own health, though never as frailer than three quarters
        // of its side's mean.
        const mean = rulesetSideHealthMean(definition, combat, encounter, target.side);
        const weighed = average >= pool ? Math.max(pool, mean * 0.75) : mean;
        candidate.damage = Math.min(2, (average / weighed) * (1 + others.length + again)) * chance;
        candidate.action.expected = average * chance * (1 + others.length + again);
        if (average >= pool) candidate.finish = chance;
        // Everybody it could drop, the others it spreads to included: by its average, and by the most
        // its dice can roll where the blow is not one pulled to knock out (re-test 2026-10-23: a Sacred
        // Flame of 2d8 on a thug at 11 killed under orders to spare), every dart it takes counted
        // (round 2: three Magic Missile darts on a captain at 10).
        const most = average * rulesetDamageCeiling(fallingAction?.damage);
        const dropped = [target, ...others].filter((one) => {
          const left = rulesetCombatHealth(definition, combat, one);
          return most * (one === target ? 1 + again : 1) >= Math.max(1, left.value + left.temp);
        });
        if (dropped.length) candidate.action.drops = dropped.map((one) => one.id);
        // What it puts on them as well (a stunning blow), and the spell it may break by hurting
        // whoever holds one up.
        const rider = rulesetEffectWorth(definition, combat, encounter, actor, fallingAction, target) ?? 0;
        // Worth as much as the save it forces is likely to fail (re-test 9): a dagger's scratch on a
        // caster who shrugs off any concentration save is no reason to throw it past a Multiattack.
        const breaks = target.concentrating ? 0.3 * rulesetConcentrationFails(combat, target, average) : 0;
        if (rider + breaks > 0) candidate.setup = (rider + breaks) * chance;
      } else if (ally) {
        // Giving back a pool that is already full, or one somebody without a sheet does not have,
        // gives nothing.
        if (option.restores && !rulesetPoolHasRoom(definition, target, option.restores)) continue;
        // A budget handed over for this turn (Action Surge) is worth only a blow it can buy: taken
        // once the turn's own is spent, with something that reaches an opponent from where it can
        // still walk to. Never a Dash with it, and never a surge it then stands about with.
        if (fallingAction?.gives?.length) {
          if (!rulesetGiftStrikes(definition, encounter, actor, fallingAction.gives)) continue;
          candidate.support = 1;
        } else {
          // What it does for them, read off what it puts on them: nothing, for what they already have.
          const helps = rulesetEffectWorth(definition, combat, encounter, actor, fallingAction, target);
          // Next to nothing in a fight is not worth a turn's action, nor holding a spell up for
          // (re-test 2026-10-23: Guidance cast nine times while Spirit Guardians waited).
          if (helps === 0 || (helps !== undefined && helps < RULESET_TRIFLING_HELP)) continue;
          candidate.support = helps ?? 0.4;
        }
      } else if (
        menu &&
        fallingAction?.reaction?.cancels &&
        (encounter.window?.trigger.kind === "aimed" || encounter.window?.trigger.kind === "used")
      ) {
        // Stopping what is coming (Counterspell) is worth what it would have done, weighed as the harm
        // it saves rather than by temperament: a cantrip is let through, a Fireball at the party is
        // stopped by anybody who can. The first quarter is what a reaction is worth, a tenth more
        // for each level of the slot it spends, however little the spender minds the price, and
        // more again for each level that slot stands above the cast it stops: a 3rd-level slot is
        // thrown at a Fire Bolt only to keep its spender alive. That is its whole price, so none is
        // added.
        const level = rulesetPaidLevel(definition, actor, fallingAction, way.payWith);
        const stoppedLevel = rulesetStoppedLevel(definition, encounter);
        // A slot is never spent on a cantrip but to keep its spender alive (re-test round 2: a
        // 3rd-level Counterspell on a cult fanatic's Sacred Flame).
        if (level > 0 && stoppedLevel === 0 && !rulesetStoppedDropsSpender(definition, combat, encounter, actor))
          continue;
        const above = Math.max(0, level - stoppedLevel);
        const saved =
          Math.max(0, rulesetStoppedWorth(definition, combat, encounter, actor) - 0.25 - 0.1 * level - 0.15 * above) *
          chance;
        if (saved <= 0) continue;
        candidate.damage = saved;
        candidate.cost = 0;
      } else if (option.forecast?.averageDamage !== undefined) {
        // A blow that does no harm (an unarmed strike for 0) is worth only what it puts on them.
        if (ally || target.down) continue;
        const rider = rulesetEffectWorth(definition, combat, encounter, actor, fallingAction, target) ?? 0;
        if (rider <= 0) continue;
        candidate.setup = rider * chance;
      } else {
        // What it does to them, read off what it puts on them: nothing, for what they already have
        // or cannot take.
        const holds = rulesetEffectWorth(definition, combat, encounter, actor, fallingAction, target);
        if (holds === 0) continue;
        candidate.setup = holds ?? 0.4;
      }
      // Starting another held spell lets go of the one it holds up: as dear as what that one is worth,
      // so Guidance or Shield of Faith held does not keep Spirit Guardians in the book (re-test
      // 2026-10-23).
      if (fallingAction?.concentration && actor.concentrating && actor.concentrating.actionId !== option.id)
        candidate.cost = (candidate.cost ?? 0) + rulesetHeldWorth(definition, combat, encounter, actor);
      candidates.push(candidate);
    }
  }
  // A legendary action that moves after what it does (1.285): on to where a teleport would go, or
  // nowhere when nowhere is worth it.
  for (const candidate of standing ? [] : candidates) {
    const { option, choice } = candidate.action;
    if (!option.moveAfter || !option.cells?.length || choice.to) continue;
    const picked = repositionCell(definition, combat, encounter, actor, option.cells);
    if (picked) choice.to = { x: picked.best.x, y: picked.best.y };
  }
  if (standing) for (const candidate of candidates) candidate.action.to = { ...standing };
  return candidates;
}

/** What each effect of a condition is worth on an opponent (`foe`) or a friend (`friend`), as a share
 *  of a turn of theirs: taking a turn away entirely is worth a whole one. */
const RULESET_EFFECT_WORTH: Partial<Record<string, { foe?: number; friend?: number }>> = {
  "cannot-act": { foe: 1 },
  "cannot-harm": { foe: 0.8 },
  "cannot-target-source-side": { foe: 0.5 },
  "cannot-target-source": { foe: 0.25 },
  "speed-zero": { foe: 0.25 },
  "own-attacks-disadvantage": { foe: 0.35 },
  "attacks-against-advantage": { foe: 0.35 },
  "attacks-against-adjacent-advantage": { foe: 0.15 },
  "attacks-from-adjacent-critical": { foe: 0.2 },
  "cannot-approach-source": { foe: 0.15 },
  "cannot-react": { foe: 0.1 },
  "cannot-heal": { foe: 0.1 },
  "own-saves-disadvantage": { foe: 0.15 },
  "own-checks-disadvantage": { foe: 0.05 },
  "own-attacks-advantage": { friend: 0.35 },
  "attacks-against-disadvantage": { friend: 0.35 },
  "attacks-against-no-advantage": { friend: 0.1 },
  "resist-all": { friend: 0.4 },
  "own-saves-advantage": { friend: 0.15 },
  "own-checks-advantage": { friend: 0.05 },
};

/** How much of a turn's worth of blows the actor's side gets in at a target before the target's own
 *  next turn: a half for each friend who acts first, at most one. The actor's own action is the one
 *  being weighed. */
function rulesetBlowsBeforeTurn(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  target: RulesetCombatant,
): number {
  const order = encounter.order;
  const at = order.indexOf(actor.id);
  const until = order.indexOf(target.id);
  if (at < 0 || until < 0) return 0.5;
  let friends = 0;
  for (let step = 1; step < order.length; step++) {
    const id = order[(at + step) % order.length]!;
    if (id === target.id) break;
    const one = rulesetCombatant(encounter, id);
    if (one && one.side === actor.side && rulesetCombatStanding(one)) friends++;
  }
  return Math.min(1, friends * 0.5);
}

/**
 * A blow's average as its target's own hide takes it (I1), part by part: nothing to a type it is
 * immune to, half to one it resists, double to one it is vulnerable to. And where one of the blow's
 * types stops it regenerating, what it would have regained besides: holy water on a fiend, fire on
 * a troll, whatever the ruleset calls them. The menu's forecast leaves a target's hide out (it cannot
 * promise what the player has not found out); the Engine's own side reads it.
 */
function rulesetAverageAgainst(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  target: RulesetCombatant,
  damage: RulesetCombatAction["damage"],
  average: number,
): number {
  if (!damage || average <= 0 || rulesetCombatIsPool(combat)) return average;
  const parts = [
    { type: damage.type, average: rulesetSafeAverage({ ...damage, plus: undefined }) },
    ...(damage.plus ?? []).map((clause) => ({
      type: clause.type ?? damage.type,
      average: rulesetSafeAverage({ count: clause.count, sides: clause.sides, flat: clause.flat }),
    })),
  ].filter((part) => part.average > 0);
  const whole = parts.reduce((sum, part) => sum + part.average, 0);
  if (whole <= 0) return average;
  const hide = rulesetCombatHide(definition, target, encounter);
  const listed = (list: ReadonlyArray<string | { type: string; except: string[] }>, type: string) =>
    list.some((entry) => (typeof entry === "string" ? entry : entry.type).trim().toLowerCase() === type);
  let taken = 0;
  const types = new Set<string>();
  for (const part of parts) {
    const type = part.type?.trim().toLowerCase();
    if (!type) {
      taken += part.average;
      continue;
    }
    types.add(type);
    const resists = listed(hide.resist, type);
    const vulnerable = listed(hide.vulnerable, type);
    taken +=
      part.average * (listed(hide.immune, type) ? 0 : resists && !vulnerable ? 0.5 : vulnerable && !resists ? 2 : 1);
  }
  let worth = average * (taken / whole);
  const regenerates = target.block?.regenerates;
  if (worth > 0 && regenerates?.stoppedBy?.some((type) => types.has(type.trim().toLowerCase()))) {
    const dice = regenerates.dice ? parseRulesetCombatDice(regenerates.dice) : null;
    worth += (regenerates.flat ?? 0) + (dice ? rulesetSafeAverage(dice) : 0);
  }
  return worth;
}

/** An amount's average, nothing for one that has none or is written loosely. */
function rulesetSafeAverage(amount: RulesetCombatAction["damage"]): number {
  const average = amount ? rulesetAverageAmount(amount) : 0;
  return Number.isFinite(average) ? average : 0;
}

/** The share of a target's turns a thing put on them lasts for: a moment, a few rounds, until they
 *  shake it off, or for good. */
function rulesetDurationWorth(duration: RulesetCombatApplies["duration"]): number {
  if (duration === "instant" || duration === "this-action") return 0.3;
  if (duration === "until-save") return 0.75;
  if (duration === "until-dispelled") return 1;
  if (duration.untilDispelled) return 1;
  return Math.min(1, 0.35 + 0.25 * duration.rounds);
}

/** The chance a target fails a save, read the way the save will be thrown: its own modifier against
 *  the difficulty on a d20, or on dice pools its save's pool short of the successes the difficulty
 *  asks for (combat AI E4), by the pool's own odds. */
function rulesetFailChance(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  target: RulesetCombatant,
  save: { save: string; difficulty: number },
): number {
  const own = target.saves[save.save] ?? 0;
  if (rulesetCombatIsPool(combat))
    return Math.max(
      0.05,
      Math.min(0.95, 1 - rulesetPoolChance(definition, Math.max(0, own), Math.max(1, save.difficulty))),
    );
  return Math.max(0.05, Math.min(0.95, (save.difficulty - 1 - own) / 20));
}

/** How dangerous a combatant is to the other side, against what that side has left: 0.5 for one
 *  that barely scratches, up to 1.5 for one whose best blow takes a whole fighter's health. */
function rulesetThreat(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  one: RulesetCombatant,
): number {
  const best = Math.max(0, ...one.actions.map((action) => rulesetSafeAverage(action.damage)));
  const others = encounter.combatants.filter((other) => other.side !== one.side && rulesetCombatStanding(other));
  if (others.length === 0) return 1;
  const pools = others.map((other) => {
    const health = rulesetCombatHealth(definition, combat, other);
    return Math.max(1, health.value + health.temp);
  });
  const mean = pools.reduce((sum, pool) => sum + pool, 0) / pools.length;
  // And what it has shown this fight: the harm it has dealt and the health it has given back a round,
  // the spell it holds, and how many of the other side it holds down.
  const shown = Math.min(0.4, ((one.done?.dealt ?? 0) + (one.done?.healed ?? 0)) / Math.max(1, encounter.round) / mean);
  const holding = others.filter((other) => other.tracked.some((entry) => entry.source === one.id)).length;
  const control = Math.min(0.3, 0.15 * holding) + (one.concentrating ? 0.1 : 0);
  return 0.5 + Math.min(1, best / mean) + shown + control;
}

/** Whether anybody standing against this side deals this damage type with one of their actions. */
function rulesetSideDeals(encounter: RulesetEncounterState, side: string, damageType: string): boolean {
  const wanted = damageType.trim().toLowerCase();
  return encounter.combatants.some(
    (one) =>
      one.side !== side &&
      rulesetCombatStanding(one) &&
      one.actions.some((action) =>
        [action.damage?.type, ...(action.damage?.plus ?? []).map((clause) => clause.type)].some(
          (type) => type?.trim().toLowerCase() === wanted,
        ),
      ),
  );
}

/**
 * What an action is worth by what it puts on a target, read off the ruleset's own conditions: what
 * their effects and behaviours do, how long they last, the chance it lands, and how much the target
 * matters. An opponent is worth more held down the more dangerous it is; a friend is helped by what
 * helps. Nothing for a condition the target already holds or cannot take. Undefined when the action
 * puts nothing readable on anybody, so its caller keeps its own guess.
 */
export function rulesetEffectWorth(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  action: RulesetCombatAction | undefined,
  target: RulesetCombatant,
  /** Weighed as harm whoever it lands on: what a blast does to its maker's own side. */
  asHarm = false,
): number | undefined {
  if (!action) return undefined;
  const foe = asHarm || target.side !== actor.side;
  let worth: number | undefined;
  // Sent out of the fight (1.236): its turns are gone while it is away.
  if (action.dismisses && foe) worth = 1;
  if (!action.applies?.length)
    return worth === undefined ? undefined : worth * rulesetThreat(definition, combat, encounter, target);
  const held = new Set(rulesetCombatConditions(definition, target));
  for (const applied of action.applies) {
    worth ??= 0;
    if (held.has(applied.condition)) continue;
    if (rulesetImmuneToCondition(target, applied.condition, definition, encounter, actor)) continue;
    const rule = combat.conditions?.find((one) => one.condition === applied.condition);
    let each = 0;
    // One they get up from on their own turn (prone): gone before they act, so it is worth only the
    // move it costs them and the blows their side takes before then (re-test 10: a lone sentinel
    // shoving the fighter down every turn and never striking).
    const standsUp = foe && !!rule?.effects?.includes("half-move-to-stand");
    const before = standsUp ? rulesetBlowsBeforeTurn(encounter, actor, target) : 1;
    for (const effect of rule?.effects ?? []) {
      const one = (foe ? RULESET_EFFECT_WORTH[effect]?.foe : RULESET_EFFECT_WORTH[effect]?.friend) ?? 0;
      each += standsUp ? (effect === "own-attacks-disadvantage" ? 0 : one * before) : one;
    }
    if (standsUp) each += 0.1;
    // What it makes them do (1.264, 1.527): run, wander, strike whoever is nearest, waste a turn.
    const behavior = rule?.behavior;
    if (foe && behavior) {
      if (behavior.table || behavior.only) each += 0.6;
      else if (behavior.moves === "away" || behavior.nearest) each += 0.5;
      else if (behavior.wastes) each += 0.4;
      else each += 0.15;
    }
    // A number added or taken off, whichever way it points, is worth a little; more damage of one
    // type taken only when somebody on the other side deals that type (lamp oil wants a fire), and
    // one that counts only on blows of some types (1.777) only when somebody deals one of them.
    const counted = (rule?.modifiers ?? []).filter(
      (modifier) =>
        modifier.to !== "damage-taken" ||
        (modifier.onTypes
          ? modifier.onTypes.some((type) => rulesetSideDeals(encounter, target.side, type))
          : !modifier.damageType ||
            (modifier.flat ?? 0) <= 0 ||
            rulesetSideDeals(encounter, target.side, modifier.damageType)),
    );
    // One that only touches ability checks is next to nothing in a fight (re-test 2026-10-23: a cleric
    // spent six actions on Guidance); one spent the first time it adds (1.777) is worth half.
    each += Math.min(
      0.3,
      counted.reduce(
        (sum, modifier) => sum + (modifier.to === "checks" ? 0.02 : 0.1) * (modifier.spentOnUse ? 0.5 : 1),
        0,
      ),
    );
    // An aura it gives off to its own side (5e's Leadership): what it puts on each friend in reach.
    if (!foe) {
      const perCell = combat.distance?.perCell;
      for (const aura of rule?.auras ?? []) {
        if (aura.side === "enemies") continue;
        const reach = perCell ? rulesetInCells(aura.distance, perCell) : Infinity;
        const friends = encounter.combatants.filter(
          (one) =>
            one.side === target.side &&
            !one.object &&
            rulesetCombatStanding(one) &&
            (aura.self || one.id !== target.id) &&
            (!rulesetPositionOf(one) || !rulesetPositionOf(target) || rulesetGap(one, target) <= reach),
        ).length;
        for (const id of aura.conditions ?? []) {
          const given = combat.conditions?.find((one) => one.condition === id);
          const effects = (given?.effects ?? []).reduce(
            (sum, effect) => sum + (RULESET_EFFECT_WORTH[effect]?.friend ?? 0),
            0,
          );
          each += (Math.min(0.3, (given?.modifiers?.length ?? 0) * 0.1) + effects) * friends;
        }
      }
    }
    if (rule?.effects?.includes("ends-on-damage")) each *= 0.6;
    worth += Math.min(1.2, each) * rulesetDurationWorth(applied.duration);
  }
  if (worth === undefined) return undefined;
  const lands = action.save && foe ? rulesetFailChance(definition, combat, target, action.save) : 1;
  return worth * lands * (foe ? rulesetThreat(definition, combat, encounter, target) : 1);
}

/** What stopping a cast or a blow aimed at this side is worth (an answer that cancels, 5e's
 *  Counterspell): the harm it would do to whom it is aimed at here, what it would put on them, or the
 *  healing it would give the other side. A modest guess when the thing itself cannot be read. */
export function rulesetStoppedWorth(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): number {
  const trigger = encounter.window?.trigger;
  if (!trigger || (trigger.kind !== "aimed" && trigger.kind !== "used")) return 0.4;
  // Stopping an answer (a Counterspell at our own cast) is worth what that answer would have stopped:
  // what our cast does to its side, read from where its caster stands.
  const answering = encounter.window?.resume?.kind === "answer" ? encounter.window.outer : undefined;
  const counterer = rulesetCombatant(encounter, trigger.sourceId);
  if (answering && counterer) {
    return rulesetStoppedWorth(definition, combat, { ...encounter, window: answering }, counterer);
  }
  const stopped = rulesetStoppedCast(encounter);
  if (!stopped) return 0.4;
  const { source, action, aimedAt } = stopped;
  const mine = aimedAt.filter((one) => one.side === actor.side);
  let worth = 0;
  const average = rulesetSafeAverage(action.damage);
  for (const one of mine) {
    const health = rulesetCombatHealth(definition, combat, one);
    // Its own life, or itself held down (Hold Person on the one who could stop it), is the rest of
    // its fight lost, and weighs half again as much.
    const self = one.id === actor.id ? 1.5 : 1;
    const pool = Math.max(1, health.value + health.temp);
    if (average > 0) worth += Math.min(1, average / pool) * (average >= pool ? self : 1);
    worth += (rulesetEffectWorth(definition, combat, encounter, source, action, one) ?? 0) * self;
  }
  // Healing or helping their own side is worth stopping too.
  for (const one of aimedAt.filter((other) => other.side === source.side)) {
    const health = rulesetCombatHealth(definition, combat, one);
    if (action.heal) worth += Math.min(1, (health.max - health.value) / Math.max(1, health.max));
    worth += (rulesetEffectWorth(definition, combat, encounter, source, action, one) ?? 0) * 0.5;
  }
  if (action.summons || action.calls) worth += 0.6;
  // Something it could read and found small is worth that little; only what says nothing gets a guess.
  const read = average > 0 || !!action.heal || !!action.applies?.length || !!action.summons || !!action.calls;
  return Math.min(2, read ? worth : 0.4);
}

/** The cast or blow an answer would stop, and whom it is aimed at: as the moment says, else as the
 *  held use says, its area's catch included. */
function rulesetStoppedCast(
  encounter: RulesetEncounterState,
): { source: RulesetCombatant; action: RulesetCombatAction; aimedAt: RulesetCombatant[] } | undefined {
  const trigger = encounter.window?.trigger;
  if (!trigger || (trigger.kind !== "aimed" && trigger.kind !== "used")) return undefined;
  const source = rulesetCombatant(encounter, trigger.sourceId);
  const action = source?.actions.find((one) => one.id === trigger.optionId);
  if (!source || !action) return undefined;
  const resume = encounter.window?.resume;
  const held = resume?.kind === "action" && resume.actorId === source.id ? resume : undefined;
  const ids = new Set([
    ...(trigger.kind === "aimed" ? (trigger.targetIds ?? []) : []),
    ...(held?.targetIds ?? []),
    ...(held?.at ? rulesetAreaTargets(encounter, source.id, held.optionId, held.at) : []),
  ]);
  const aimedAt = [...ids]
    .map((id) => rulesetCombatant(encounter, id))
    .filter((one): one is RulesetCombatant => !!one && !one.defeated);
  return { source, action, aimedAt };
}

/** Whether what an answer would stop could drop its spender, by the most its dice can roll. */
function rulesetStoppedDropsSpender(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): boolean {
  const stopped = rulesetStoppedCast(encounter);
  if (!stopped || !stopped.aimedAt.some((one) => one.id === actor.id)) return false;
  const most = rulesetSafeAverage(stopped.action.damage) * rulesetDamageCeiling(stopped.action.damage);
  const health = rulesetCombatHealth(definition, combat, actor);
  return most > 0 && most >= Math.max(1, health.value + health.temp);
}

/** The level of the cast an answer would stop (Counterspell's target): what its caster paid for it,
 *  0 for a cantrip. An answer at our own cast is that answer's level. */
function rulesetStoppedLevel(definition: RulesetDefinition, encounter: RulesetEncounterState): number {
  const trigger = encounter.window?.trigger;
  if (!trigger || (trigger.kind !== "aimed" && trigger.kind !== "used")) return 0;
  const source = rulesetCombatant(encounter, trigger.sourceId);
  const action = source?.actions.find((one) => one.id === trigger.optionId);
  if (!source || !action) return 0;
  const resume = encounter.window?.resume;
  const payWith =
    (resume?.kind === "action" || resume?.kind === "answer") && resume.actorId === source.id
      ? resume.payWith
      : undefined;
  return rulesetPaidLevel(definition, source, action, payWith);
}

/** What healing is worth to one: only what they are missing counts, and less the less they miss, so
 *  a Second Wind is kept for when it matters rather than spent on a scratch. */
function rulesetHealingWorth(average: number, health: { value: number; max: number }): number {
  const max = Math.max(1, health.max);
  const missing = Math.max(0, health.max - health.value);
  // A scratch is no reason to spend a turn or a potion on mending (I2: healing given at 85%).
  if (missing < max * 0.25) return 0;
  return (Math.min(average, missing) / max) * Math.min(1, (2 * missing) / max);
}

/** Whether a pool of this fighter's sheet has room for more. */
function rulesetPoolHasRoom(definition: RulesetDefinition, fighter: RulesetCombatant, pool: string): boolean {
  if (!fighter.sheet) return false;
  const now = readRulesetLive(definition, fighter.sheet.build, fighter.sheet.live, fighter.sheet.items).pools.find(
    (entry) => entry.key === pool,
  );
  return !!now && now.value < now.max;
}

/**
 * One candidate per cell a shape may be aimed at, worth what it would catch.
 *
 * Its own side counts AGAINST it, so a creature does not drop a blast on its friends to reach one
 * more enemy, and an aim that would catch nobody but friends is left off the list entirely.
 */
function areaCandidates(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
  standing: { x: number; y: number } | null,
  /** The pool this way of paying spends and the style it is made in, and what that way costs. */
  way: { payWith?: string; style?: string; mode?: string; option?: RulesetCombatOption },
  price: number,
): Array<CombatAiCandidate<RulesetCandidate>> {
  const candidates: Array<CombatAiCandidate<RulesetCandidate>> = [];
  // The same bound the view keeps, and the aims that catch the most people first, so what is left
  // out on a very large board is what mattered least. The sort is stable, so equal aims keep the
  // board's own order and the picker stays deterministic.
  // The scan itself is bounded too, at a few times what is kept: on the boards this Engine draws
  // that is every aim there is, and on a very large imported one it is enough to rank from without
  // the ranking becoming the cost.
  const aims = [...rulesetAimCells(encounter, actor.id, option.id, RULESET_AIM_LIMIT * 4)]
    .sort((left, right) => right.targetIds.length - left.targetIds.length)
    .slice(0, RULESET_AIM_LIMIT);
  // An alteration that spares its own side for nothing (Sculpt Spells), taken whenever the aim would
  // catch a friend it can spare (re-test 2026-10-23: an Evoker's Fireball hit the fighter for 23).
  const action = actor.actions.find((one) => one.id === option.id);
  const sculpt = option.alters?.find(
    (offer) => offer.cost === 0 && !offer.budget && ((offer.spares ?? 0) > 0 || offer.sparesByLevel),
  );
  const spareable = sculpt
    ? (sculpt.spares ?? 0) +
      (sculpt.sparesByLevel && action ? rulesetPaidLevel(definition, actor, action, way.payWith) : 0)
    : 0;
  for (const aim of aims) {
    const all = aim.targetIds
      .map((id) => rulesetCombatant(encounter, id))
      .filter((target): target is RulesetCombatant => !!target);
    const mine = all.filter((target) => target.side === actor.side);
    const spared = sculpt && mine.length > 0 && mine.length <= spareable ? mine.map((one) => one.id) : [];
    const caught = spared.length ? all.filter((target) => !spared.includes(target.id)) : all;
    const foes = caught.filter((target) => target.side !== actor.side && !target.down);
    const candidate: CombatAiCandidate<RulesetCandidate> = {
      action: {
        choice: {
          actorId: actor.id,
          optionId: option.id,
          targetIds: [],
          at: { x: aim.x, y: aim.y },
          ...paying(way),
          ...(spared.length
            ? { alters: [...(way.option?.alterNeeded ? [way.option.alterNeeded] : []), sculpt!.id], spares: spared }
            : {}),
        },
        option,
        ...(foes[0] ? { targetId: foes[0].id } : {}),
        ...(standing ? { to: { ...standing } } : {}),
      },
      ...(foes[0] ? { targetId: foes[0].id } : {}),
      cost: price,
    };
    if (!weighCaught(definition, combat, encounter, actor, option, caught, candidate)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Who of those caught a health pool or a health ceiling reaches (re-test 10): Sleep's 5d8 shared out
 * least health first while its average lasts, Power Word Stun only at or under its number. Everybody
 * caught, for anything else. A Sleep that can put nobody down is worth nothing, so it never spends a
 * slot held back for Shield.
 */
function rulesetPoolReaches(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  actor: RulesetCombatant,
  action: RulesetCombatAction | undefined,
  caught: RulesetCombatant[],
  payWith: string | undefined,
): RulesetCombatant[] {
  if (!action || (!action.healthPool && action.healthAtMost === undefined)) return caught;
  const healthOf = (target: RulesetCombatant) => rulesetCombatHealth(definition, combat, target).value;
  const under =
    action.healthAtMost !== undefined ? caught.filter((target) => healthOf(target) <= action.healthAtMost!) : caught;
  if (!action.healthPool) return under;
  const step = action.use?.perCostStep;
  const steps = step && payWith ? rulesetCostSteps(definition, action, payWith, actor) : 0;
  let left =
    rulesetAverageAmount(action.healthPool) +
    (step ? Math.floor(steps / (action.use?.stepsEvery ?? 1)) * rulesetAverageAmount(step) : 0);
  const reached: RulesetCombatant[] = [];
  for (const target of [...under].sort((a, b) => healthOf(a) - healthOf(b))) {
    const health = healthOf(target);
    if (health > left) continue;
    left -= health;
    reached.push(target);
  }
  return reached;
}

/** What a shape is worth by whom it catches (an aimed one, or one centred on its maker, 1.282): the
 *  harm to the other side less the harm to its own, healing for its own, or a setup or a support.
 *  False when it is worth nothing. */
function weighCaught(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
  caught: RulesetCombatant[],
  candidate: CombatAiCandidate<RulesetCandidate>,
): boolean {
  const average = option.forecast?.averageDamage ?? 0;
  const chance = option.forecast?.hitChance ?? 1;
  // What its conditions are worth on each it catches, read off the ruleset (see `rulesetEffectWorth`).
  const action = actor.actions.find((one) => one.id === option.id);
  caught = rulesetPoolReaches(definition, combat, actor, action, caught, candidate.action.choice.payWith);
  const foes = caught.filter((target) => target.side !== actor.side && !target.down);
  let friends = caught.filter((target) => target.side === actor.side);
  // A hazard that stays (lamp oil set alight, ball bearings) catches whoever walks into it later, and
  // its own side is who is fighting beside it (re-test 2026-10-23: the party burnt and tripped on
  // its own rogue's): a friend within a step of where it lands counts as caught.
  // One that leaves its own side out (Spirit Guardians) or goes where its maker goes catches no friend.
  // A friend's turn in it counts twice what a foe's does: they walk where the fight is, and a turn
  // of the party's lost is worse than one of theirs (re-test 2026-10-23: Web and ball bearings).
  const at = candidate.action.choice.at;
  let friendWeight = 1;
  // And the other side's within a step of it, who walk into it on their way (I3: caltrops and ball
  // bearings left in the pack): each counts at half of one caught where it lands.
  let walkers: RulesetCombatant[] = [];
  if (
    at &&
    action?.zone &&
    action.zone.rounds > 0 &&
    action.zone.triggers.length > 0 &&
    action.zone.anchor !== "caster" &&
    action.area?.friendlyFire !== false &&
    !option.heals
  ) {
    friendWeight = 2;
    const perCell = definition.combat?.distance?.perCell ?? 1;
    const reach = Math.ceil((action.area?.size ?? perCell) / perCell) + 1;
    const near = encounter.combatants.filter(
      (one) =>
        one.side === actor.side &&
        rulesetCombatStanding(one) &&
        !friends.includes(one) &&
        !!rulesetPositionOf(one) &&
        rulesetGapFrom(at, 1, one) <= reach,
    );
    friends = [...friends, ...near];
    walkers = encounter.combatants.filter(
      (one) =>
        one.side !== actor.side &&
        !one.object &&
        !one.down &&
        rulesetCombatStanding(one) &&
        !caught.includes(one) &&
        !!rulesetPositionOf(one) &&
        rulesetGapFrom(at, 1, one) <= reach,
    );
  }
  const worthOn = (target: RulesetCombatant) =>
    rulesetEffectWorth(definition, combat, encounter, actor, action, target);
  const riders = (who: RulesetCombatant[]) => who.reduce((sum, target) => sum + (worthOn(target) ?? 0), 0);
  // What it does to its own side caught in it, weighed as the harm it is.
  const harms = (who: RulesetCombatant[]) =>
    friendWeight *
    who.reduce(
      (sum, target) => sum + (rulesetEffectWorth(definition, combat, encounter, actor, action, target, true) ?? 0),
      0,
    );
  if (option.heals) {
    const helped = friends.filter((target) => {
      const health = rulesetCombatHealth(definition, combat, target);
      return target.down || health.value < health.max;
    });
    if (helped.length === 0) return false;
    candidate.healing = helped.reduce((total, target) => {
      const health = rulesetCombatHealth(definition, combat, target);
      return total + rulesetHealingWorth(average, health) + (target.down ? 1 : 0);
    }, 0);
  } else if (average > 0) {
    if (foes.length === 0 && walkers.length === 0) return false;
    // Never a blast that could kill its own maker: a mage's Fireball at its own feet.
    if (caught.some((target) => target.id === actor.id)) {
      const own = rulesetCombatHealth(definition, combat, actor);
      if (average >= own.value + own.temp) return false;
    }
    // Each foe counts for at most what dropping it is worth, weighed against what its side stands up
    // with as a blow is: a cleric at 3 health is not worth a Fireball over its own two mages.
    const share = [...foes, ...walkers].reduce((total, target) => {
      const health = rulesetCombatHealth(definition, combat, target);
      const pool = Math.max(
        1,
        health.value + health.temp,
        0.75 * rulesetSideHealthMean(definition, combat, encounter, target.side),
      );
      return total + (walkers.includes(target) ? 0.5 : 1) * Math.min(1, average / pool);
    }, 0);
    // Never one that would likely drop somebody of its own side either: a mage's Fireball over the
    // other mage. A friend it only grazes counts against it three times over, and its own hide four times.
    if (
      caught.some(
        (target) =>
          target.side === actor.side &&
          target.id !== actor.id &&
          rulesetCombatStanding(target) &&
          average * chance >= rulesetCombatHealth(definition, combat, target).value,
      )
    )
      return false;
    const hurt = friends.reduce((total, target) => {
      const health = rulesetCombatHealth(definition, combat, target);
      return total + ((target.id === actor.id ? 4 : 3) * average) / Math.max(1, health.value + health.temp);
    }, 0);
    // And worth at least twice what it costs its own: a blast that only just outweighs burning a
    // friend is one no tactician throws.
    if (hurt > 0 && share < 2 * hurt) return false;
    candidate.damage = Math.max(0, Math.min(2, share - hurt)) * chance;
    if (candidate.damage <= 0) return false;
    // Whom of the other side it would likely drop, for orders that spare them.
    const dropped = foes.filter((target) => {
      const health = rulesetCombatHealth(definition, combat, target);
      return average >= Math.max(1, health.value + health.temp);
    });
    if (dropped.length) candidate.action.drops = dropped.map((target) => target.id);
    // What it puts on those it catches as well, less what it puts on its own (a burst that stuns).
    const rider = riders(foes) + 0.5 * riders(walkers) - harms(friends);
    if (rider > 0) candidate.setup = Math.min(2, rider) * chance;
  } else if (foes.length > 0 || walkers.length > 0) {
    // What it puts on them, less what it puts on its own side: a Hypnotic Pattern over the party
    // and not over its own.
    const read = [...foes, ...walkers].some((target) => worthOn(target) !== undefined);
    const worth = riders(foes) + 0.5 * riders(walkers) - harms(friends);
    if (read && worth <= 0) return false;
    candidate.setup = read ? Math.min(2, worth) : 0.4;
  } else {
    // Something meant for the other side that would catch only its own: ball bearings under a friend.
    if (option.targets.side === "enemy") return false;
    // Nor anybody at all: ball bearings thrown on an empty floor beside a friend, who then walks on
    // them. What is worth laying for nobody yet is weighed as a zone, never here.
    if (friends.length === 0) return false;
    // And nothing that would harm the friends it catches: ball bearings under them, any side's.
    if (harms(friends) > 0 && riders(friends) <= 0) return false;
    if (option.restores && !friends.some((friend) => rulesetPoolHasRoom(definition, friend, option.restores!))) {
      return false;
    }
    const read = friends.some((target) => worthOn(target) !== undefined);
    const worth = riders(friends);
    if (read && worth <= 0) return false;
    candidate.support = read ? Math.min(2, worth) : 0.4;
  }
  return true;
}

/**
 * Where to move a lasting area its actor holds (1.173): the cell that would catch the most standing
 * opponents less friends, and only when that beats where it stands now. Ties keep the menu's own
 * order, so the picker stays deterministic.
 */
function zoneMoveCandidate(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
  price: number,
): CombatAiCandidate<RulesetCandidate> | null {
  const actionId = option.id.slice(RULESET_ZONE_OPTION_PREFIX.length);
  const zone = actor.zones?.find((entry) => entry.actionId === actionId);
  const action = actor.actions.find((entry) => entry.id === actionId);
  const grid = encounter.board?.grid;
  if (!zone?.at || !action?.area || !grid) return null;
  const worth = (at: { x: number; y: number }) => {
    const cells = new Set(rulesetAreaCells("burst", action.area!.size, at, at, grid).map((c) => `${c.x},${c.y}`));
    let total = 0;
    for (const one of encounter.combatants) {
      if (typeof one.x !== "number" || typeof one.y !== "number" || one.down) continue;
      // Caught by any cell they fill (1.194).
      const inside = rulesetFootprint(one).some((cell) => cells.has(`${cell.x},${cell.y}`));
      if (!inside || !rulesetZoneCatches(actor, zone, action, one)) continue;
      total += one.side === actor.side ? -1 : 1;
    }
    return total;
  };
  const now = worth(zone.at);
  let best: { cell: { x: number; y: number }; gain: number } | null = null;
  for (const cell of option.cells ?? []) {
    const gain = worth(cell) - now;
    if (gain > 0 && (!best || gain > best.gain)) best = { cell, gain };
  }
  if (!best) return null;
  return {
    action: {
      choice: { actorId: actor.id, optionId: option.id, targetIds: [], to: { x: best.cell.x, y: best.cell.y } },
      option,
    },
    setup: Math.min(1, 0.4 * best.gain),
    cost: price,
  };
}

/**
 * Where an opponent teleports to (1.276), if anywhere: away from the enemies beside it when it is
 * hurt badly enough (half its health or less), as far from the nearest of them as it can get, or,
 * when it fights in reach and has nobody in reach, next to the nearest enemy. Otherwise nowhere:
 * spending it to stand somewhere else for nothing is an opponent played badly.
 */
function teleportCandidate(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
  way: { payWith?: string; style?: string; mode?: string },
  price: number,
): CombatAiCandidate<RulesetCandidate> | null {
  const cells = option.teleport?.cells ?? [];
  // Out of the fight (1.279), when it is going badly: at a quarter of its health or less, with
  // whoever may go along.
  if (option.teleport?.leaves) {
    const health = rulesetCombatHealth(definition, combat, actor);
    const threatened = encounter.combatants.some(
      (one) => one.side !== actor.side && rulesetCombatStanding(one) && !one.away,
    );
    if (threatened && health.max > 0 && health.value * 4 <= health.max) {
      const carries = option.teleport.carries
        ? option.teleport.carries.ids.slice(0, option.teleport.carries.count)
        : [];
      return {
        action: {
          choice: {
            actorId: actor.id,
            optionId: option.id,
            targetIds: [],
            ...(carries.length ? { carries } : {}),
            ...paying(way),
          },
          option,
        },
        setup: 0.7,
        cost: price,
      };
    }
  }
  const picked = repositionCell(definition, combat, encounter, actor, cells);
  if (!picked) return null;
  const { best, worth } = picked;
  return {
    action: {
      choice: { actorId: actor.id, optionId: option.id, targetIds: [], at: { x: best.x, y: best.y }, ...paying(way) },
      option,
    },
    setup: worth,
    cost: price,
  };
}

/** A legendary move (1.283), weighed as a teleport is: away when hurt and beside an enemy, or into
 *  reach of one when none is. */
function legendaryMoveCandidate(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
  price: number,
): CombatAiCandidate<RulesetCandidate> | null {
  const picked = repositionCell(definition, combat, encounter, actor, option.cells ?? []);
  if (!picked) return null;
  return {
    action: {
      choice: { actorId: actor.id, optionId: option.id, targetIds: [], to: { x: picked.best.x, y: picked.best.y } },
      option,
    },
    setup: picked.worth,
    cost: price,
  };
}

/** Where to go among `cells`, and what it is worth: the cell farthest from every enemy when hurt and
 *  beside one, so long as it gets clear; else the nearest one that puts an enemy in reach when none
 *  is. Null when neither is worth it. */
function repositionCell(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  cells: ReadonlyArray<{ x: number; y: number }>,
): { best: { x: number; y: number }; worth: number } | null {
  const span = rulesetSpanOf(actor);
  const foes = encounter.combatants.filter(
    (one) => one.side !== actor.side && rulesetCombatStanding(one) && !one.away && !!rulesetPositionOf(one),
  );
  if (cells.length === 0 || foes.length === 0 || !rulesetPositionOf(actor)) return null;
  const nearest = (at: { x: number; y: number }) => Math.min(...foes.map((foe) => rulesetGapFrom(at, span, foe)));
  const here = rulesetPositionOf(actor)!;
  const health = rulesetCombatHealth(definition, combat, actor);
  const reaches = actor.actions
    .filter((action) => action.kind !== "reload" && action.damage && action.reach !== undefined && !action.range)
    .map((action) => action.reach!);
  let best: { x: number; y: number } | null = null;
  let worth = 0;
  if (nearest(here) <= 1 && health.max > 0 && health.value * 2 <= health.max) {
    // Fleeing: the cell farthest from every enemy, and only if it gets clear of them.
    for (const cell of cells) if (!best || nearest(cell) > nearest(best)) best = cell;
    if (best && nearest(best) > 1) worth = 0.6;
  } else if (reaches.length > 0 && nearest(here) > Math.max(...reaches)) {
    // Closing: the cell nearest an enemy that puts one in reach.
    const reach = Math.max(...reaches);
    for (const cell of cells) {
      if (nearest(cell) > reach) continue;
      if (!best || nearest(cell) < nearest(best)) best = cell;
    }
    if (best) worth = 0.5;
  }
  if (!best || worth <= 0) return null;
  return { best, worth };
}

/**
 * Which way to turn a line or cone its actor carries (1.182): the facing that would catch the most
 * standing opponents less friends, and only when that beats the way it faces now.
 */
function zoneTurnCandidate(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  option: RulesetCombatOption,
  price: number,
): CombatAiCandidate<RulesetCandidate> | null {
  const actionId = option.id.slice(RULESET_ZONE_TURN_OPTION_PREFIX.length);
  const zone = actor.zones?.find((entry) => entry.actionId === actionId);
  const action = actor.actions.find((entry) => entry.id === actionId);
  if (!zone?.facing || !action || typeof actor.x !== "number" || typeof actor.y !== "number") return null;
  const worth = (facing: { dx: number; dy: number }) => {
    const cells = new Set(rulesetZoneCells(encounter, actor, { ...zone, facing }).map((cell) => `${cell.x},${cell.y}`));
    let total = 0;
    for (const one of encounter.combatants) {
      if (typeof one.x !== "number" || typeof one.y !== "number" || one.down) continue;
      // Caught by any cell they fill (1.194).
      const inside = rulesetFootprint(one).some((cell) => cells.has(`${cell.x},${cell.y}`));
      if (!inside || !rulesetZoneCatches(actor, zone, action, one)) continue;
      total += one.side === actor.side ? -1 : 1;
    }
    return total;
  };
  const now = worth(zone.facing);
  let best: { cell: { x: number; y: number }; gain: number } | null = null;
  for (const cell of option.cells ?? []) {
    const gain = worth({ dx: cell.x - actor.x, dy: cell.y - actor.y }) - now;
    if (gain > 0 && (!best || gain > best.gain)) best = { cell, gain };
  }
  if (!best) return null;
  return {
    action: {
      choice: { actorId: actor.id, optionId: option.id, targetIds: [], to: { x: best.cell.x, y: best.cell.y } },
      option,
    },
    setup: Math.min(1, 0.4 * best.gain),
    cost: price,
  };
}

/**
 * The walk a turn with nothing in reach takes: the reachable cell that ends up nearest an opponent,
 * cheapest first, and never one that would be struck at on the way when a quieter cell gets as
 * close. Nearest is measured by the walk still left to get there, not in a straight line: a wall
 * between two fighters makes every straight-line-closer cell solid, and both would stand and look
 * at each other for the rest of the fight. Null when nothing is worth walking to, which is what
 * keeps a cornered creature from shuffling on the spot for the rest of the fight.
 */
export function rulesetClosingMove(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  /** Guarding or protecting somebody (P7): only cells within `within` of them, and back toward them
   *  first when it has strayed further. */
  leash?: RulesetLeash,
  /** Toward this opponent only, not the nearest. */
  toward?: string,
): RulesetCandidate | null {
  const actor = rulesetCombatant(encounter, actorId);
  const from = rulesetPositionOf(actor);
  if (!actor || !from || !encounter.board?.grid) return null;
  // Driven away from, or toward, whoever put a condition on (1.264): as far off, or as near, as the
  // walk goes. The cells offered already only go that way.
  const driven = rulesetDrivenFrom(definition, encounter, actor);
  if (driven) {
    let best: { cell: { x: number; y: number }; gap: number } | null = null;
    for (const cell of rulesetWalkableCells(definition, encounter, actorId)) {
      const gap = rulesetGapFrom(cell, rulesetSpanOf(actor), driven.source);
      if (!best || (driven.moves === "away" ? gap > best.gap : gap < best.gap)) best = { cell, gap };
    }
    if (!best) return null;
    return {
      choice: { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: { x: best.cell.x, y: best.cell.y } },
      option: { id: RULESET_MOVE_OPTION, kind: "move", label: "Move", targets: { side: "self", count: 0 } },
      to: { x: best.cell.x, y: best.cell.y },
    };
  }
  const span = rulesetSpanOf(actor);
  const strayed = !!leash && rulesetGapFrom(from, span, leash.charge) > leash.within;
  const foes = strayed
    ? rulesetFootprint(leash!.charge)
    : encounter.combatants
        .filter(
          (combatant) =>
            combatant.side !== actor.side &&
            rulesetCombatStanding(combatant) &&
            (toward === undefined || combatant.id === toward),
        )
        // Every cell an opponent fills (1.194).
        .flatMap((combatant) => rulesetFootprint(combatant));
  if (foes.length === 0) return null;
  const walking = rulesetWalkingDistances(encounter.board.grid, foes, actor);
  // Somebody bigger than one cell is as near as the nearest cell they would fill (1.194).
  const nearest = (cell: { x: number; y: number }) =>
    Math.min(...rulesetFootprintAt(cell, span).map((one) => walking.get(`${one.x},${one.y}`) ?? Infinity));
  const already = nearest(from);
  // Bunched with its own side under an opponent's blast (S1): as good as a couple of cells further
  // off at worst, so it closes in spread out rather than in a clump.
  const combat = definition.combat;
  const health = combat ? rulesetCombatHealth(definition, combat, actor) : undefined;
  const pool = Math.max(1, (health?.value ?? 1) + (health?.temp ?? 0));
  const crowded = (cell: { x: number; y: number }) =>
    Math.min(2, (2 * rulesetCrowdHarmAt(definition, encounter, actor, cell)) / pool);
  let best: { cell: { x: number; y: number; cost: number; provokes: string[] }; away: number } | null = null;
  // Every cell it may walk to, not a sample of them: closing the distance is one comparison a cell.
  for (const cell of rulesetWalkableCells(definition, encounter, actorId)) {
    const closer = nearest(cell);
    if (closer >= already) continue;
    if (leash && !strayed && rulesetGapFrom(cell, span, leash.charge) > leash.within) continue;
    const away = closer + crowded(cell);
    const better =
      !best ||
      away < best.away ||
      (away === best.away &&
        (cell.provokes.length < best.cell.provokes.length ||
          (cell.provokes.length === best.cell.provokes.length && cell.cost < best.cell.cost)));
    if (better) best = { cell, away };
  }
  if (!best) return null;
  return {
    choice: { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: { x: best.cell.x, y: best.cell.y } },
    option: { id: RULESET_MOVE_OPTION, kind: "move", label: "Move", targets: { side: "self", count: 0 } },
    to: { x: best.cell.x, y: best.cell.y },
    walked: best.cell.cost,
  };
}

/** Whoever a condition on this actor drives them away from or toward (1.264), standing on the board. */
function rulesetDrivenFrom(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): { source: RulesetCombatant; moves: "away" | "toward" } | null {
  if (!definition.combat) return null;
  for (const entry of rulesetActiveConditions(definition, definition.combat, actor, encounter)) {
    const moves = entry.behavior?.moves;
    if (!moves) continue;
    // From whoever put it on, or the point it was put on from (1.441).
    const source = rulesetBehaviorAnchor(encounter, actor, entry.condition, entry.behavior);
    if (source) return { source, moves };
  }
  return null;
}

/** The choice the picker would make, or null when the actor has nothing at all to pick from. */
export function pickRulesetChoice(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  /** A window's own menu, when the pick is an answer to one rather than a turn. */
  menu?: RulesetCombatOption[],
): RulesetCandidate | null {
  return pickRulesetRanked(definition, state, encounter, actorId, menu)?.candidate.action ?? null;
}

/** A pick with how it was scored, for the reasons the debug log gives after it. */
interface RulesetRankedPick {
  candidate: CombatAiCandidate<RulesetCandidate>;
  parts: CombatAiScoreParts;
}

/** The pick with how it was scored, for the reasons the debug log gives after it. */
function pickRulesetRanked(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  menu?: RulesetCombatOption[],
): RulesetRankedPick | null {
  // Every sheet, health and condition read while weighing is worked out once for the whole pick.
  return withRulesetPlanMemo(() => pickChoice(definition, state, encounter, actorId, menu));
}

function pickChoice(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  menu?: RulesetCombatOption[],
): RulesetRankedPick | null {
  const weighed = weighChoices(definition, state, encounter, actorId, menu);
  if (!weighed || "only" in weighed) return weighed?.only ? { candidate: { action: weighed.only }, parts: {} } : null;
  const { unit, actor, candidates, orders, behavior, opening } = weighed;
  const ranked = chooseRankedCombatCandidate(
    unit,
    candidates,
    encounter.round,
    normalizeGameDifficulty(state.difficulty),
    orders,
  );
  const chosen = ranked.candidate.action;
  if (opening && behavior!.opens!.some((id) => rulesetOpensWith(actor, chosen, id))) unit.tactics!.opened = true;
  // Counted only on its own turn's choice, not on a reaction's. Walking, dashing or waiting is not
  // fighting, so only a blow or a spell lets it grow careful again, and then for one turn at most:
  // otherwise a beast with nobody in reach hides, walks a step and hides again all fight.
  if (!menu && chosen) {
    if (rulesetDefensiveName(chosen.option)) unit.tactics!.wary = (unit.tactics!.wary ?? 0) + 1;
    else if (chosen.option.kind !== "move" && chosen.option.kind !== "end-turn" && chosen.option.kind !== "standard")
      unit.tactics!.wary = Math.min(unit.tactics!.wary ?? 0, 1);
  }
  return ranked;
}

/** How small a part of a pick's score is too small to give as a reason. */
const RULESET_REASON_FLOOR = 0.05;

/**
 * Why a pick was made, read back from its own scoring (debug log): the parts that weighed most,
 * largest first, at most three, then the walk it took to get where it acted from. Nothing here is
 * asked of a model, and nothing names a ruleset's own spells or attacks.
 */
function rulesetPickReasons(
  candidate: CombatAiCandidate<RulesetCandidate>,
  parts: CombatAiScoreParts,
  walked?: number,
): DirectedRulesetReason[] {
  const targetId = candidate.targetId;
  const reasons = (Object.entries(parts) as Array<[keyof CombatAiScoreParts, number]>)
    .filter(([, part]) => Math.abs(part) >= RULESET_REASON_FLOOR)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([why]): DirectedRulesetReason => {
      if (why === "damage") {
        const damage = candidate.damage ?? 0;
        return {
          why,
          ...(targetId ? { targetId } : {}),
          strength: damage >= 0.5 ? "heavy" : damage >= 0.2 ? "solid" : "some",
        };
      }
      if (why === "risk" || why === "cost") return { why };
      return { why, ...(targetId ? { targetId } : {}) };
    });
  if (walked) reasons.push({ why: "walked", cells: walked });
  if (reasons.length === 0 && candidate.action.option.kind === "end-turn") reasons.push({ why: "nothingWorth" });
  return reasons;
}

/** The reasons for a step just taken, on the log after it. Nothing when there is nothing to say. */
function recordReasons(fight: RulesetFightState, actorId: string, reasons: DirectedRulesetReason[]): void {
  if (reasons.length) record(fight, [{ type: "reasoning", actorId, reasons }]);
}

/**
 * What the Engine's own tactics would do with this unit's turn, best first (the Game Master's
 * suggestions): its candidates weighed and scored exactly as its own pick weighs them, with what
 * each part of the score came from. Nothing on the unit changes. Empty for one with nobody to play it.
 */
export function rankRulesetChoices(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  count: number,
  menu?: RulesetCombatOption[],
): Array<{ candidate: CombatAiCandidate<RulesetCandidate>; score: number; parts: CombatAiScoreParts }> {
  return withRulesetPlanMemo(() => {
    const weighed = weighChoices(definition, state, encounter, actorId, menu);
    if (!weighed || "only" in weighed) return [];
    const tactics = structuredClone(weighed.unit.tactics);
    try {
      return rankCombatCandidates(
        weighed.unit,
        weighed.candidates,
        encounter.round,
        normalizeGameDifficulty(state.difficulty),
        weighed.orders,
      ).slice(0, count);
    } finally {
      weighed.unit.tactics = tactics;
    }
  });
}

/** The candidates of a pick, weighed by everything the unit is and was told; `only` where there is
 *  nothing to weigh. */
function weighChoices(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  menu?: RulesetCombatOption[],
):
  | { only: RulesetCandidate }
  | {
      unit: CombatDirectorState["party"][number];
      actor: RulesetCombatant;
      candidates: Array<CombatAiCandidate<RulesetCandidate>>;
      orders: CombatOrders | undefined;
      behavior: ReturnType<typeof rulesetCombatantBehavior> | undefined;
      opening: boolean;
    }
  | null {
  const unit = [...state.party, ...state.enemies].find((entry) => entry.id === actorId);
  const actor = rulesetCombatant(encounter, actorId);
  // Its mind as its own data says (1.745), unless the Game Master said otherwise for this fight: a
  // profile made before that was read is made again with it.
  if (unit && actor) {
    // How hurt it is, as the fight has it now: what a coward or a hurt animal weighs.
    if (definition.combat) {
      const health = rulesetCombatHealth(definition, definition.combat, actor);
      unit.maxHp = Math.max(1, Math.floor(health.max));
      unit.hp = Math.min(unit.maxHp, Math.max(0, Math.floor(health.value)));
    }
    const mind = rulesetCombatantMind(definition, actor);
    const hinted = unit.aiHints?.mind ?? (unit.aiHints?.temperament === "mindless" ? "mindless" : undefined);
    const wanted = combatMindWithHint(hinted, mind);
    if (!unit.tactics || (wanted !== undefined && unit.tactics.mind !== wanted)) {
      // The ground it keeps stays where it was (combat AI T4).
      const home = unit.tactics?.home;
      delete unit.tactics;
      unit.tactics = assignCombatTactics(unit, state.seed, mind);
      if (home) unit.tactics.home = home;
    }
    rulesetReadRole(definition, unit, actor, encounter);
    // How its own data says it goes about a fight (1.747): its temperament, unless the Game Master
    // gave it one for this fight, and its role.
    const behavior = rulesetCombatantBehavior(definition, actor);
    if (behavior && unit.tactics.mind !== "mindless") {
      if (behavior.temperament && !unit.aiHints?.temperament && !unit.tactics.shifted)
        unit.tactics.adjective = behavior.temperament;
      if (behavior.role) unit.tactics.role = behavior.role;
    }
  }
  const ordered = unit && actor ? rulesetOrdersFor(definition, encounter, actor, unit) : undefined;
  // Retreating with nobody beside it, it has already got away: it helps from afar as `back` does
  // rather than dodging nobody (re-test 2026-10-23: two turns of Dodge with foes 4 and 9 squares off).
  const orders =
    ordered?.posture === "retreat" &&
    actor &&
    !encounter.combatants.some(
      (foe) =>
        foe.side !== actor.side &&
        rulesetCombatStanding(foe) &&
        !!rulesetPositionOf(foe) &&
        !!rulesetPositionOf(actor) &&
        rulesetGap(foe, actor) <= 1,
    )
      ? { ...ordered, posture: "back" as const }
      : ordered;
  let candidates = menu
    ? rulesetCandidatesFrom(definition, encounter, actorId, null, brokenLairMenu(definition, encounter, actorId, menu))
    : rulesetCandidates(definition, encounter, actorId, false, unit?.tactics, orders);
  if (candidates.length === 0) return null;
  if (!unit || !actor) return { only: candidates[0]!.action };
  // A mindless bodyguard weighs nothing but the blow, so its order narrows what it does instead: it
  // strikes whoever is on its charge when it can, before going at the nearest.
  if (unit.tactics!.mind === "mindless" && orders?.protectId && actor.side !== "party") {
    const charge = rulesetCombatant(encounter, orders.protectId);
    const onCharge = candidates.filter((candidate) => {
      const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : undefined;
      return !!charge && !!target && target.side !== actor.side && rulesetGap(target, charge) <= 1;
    });
    if (onCharge.length > 0) candidates = onCharge;
  }
  if (unit.tactics!.mind === "mindless")
    candidates = mindlessCandidates(encounter, actor, unit.tactics!, candidates, !!menu);
  weighRulesetTeam(definition, state, encounter, actor, candidates, orders);
  if (orders) weighRulesetOrders(definition, state, encounter, actor, orders, candidates);
  weighRulesetDowned(encounter, actor, candidates);
  if (!menu && actor.side === "party") weighRulesetBlasters(definition, state, encounter, actor, candidates);
  // An honourable one (combat AI T6) strikes nobody running from it, beaten or down, and fights
  // whoever is fighting it, one on one.
  if (unit.tactics!.adjective === "honourable") {
    const fair = candidates.filter((candidate) => {
      const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : undefined;
      return !target || target.side === actor.side || !(target.routed || target.down || target.away?.surrendered);
    });
    if (fair.length > 0) candidates.splice(0, candidates.length, ...fair);
    for (const candidate of candidates) {
      const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : undefined;
      if (!target || target.side === actor.side || (!candidate.damage && !candidate.setup)) continue;
      // Most of all the one that last hurt it, and whoever stands up to it beside it.
      const beside = !!rulesetPositionOf(target) && !!rulesetPositionOf(actor) && rulesetGap(actor, target) <= 1;
      candidate.focus = (candidate.focus ?? 0) + (actor.harmedBy === target.id ? 0.6 : 0) + (beside ? 0.3 : 0);
    }
  }
  // A hungry one (combat AI T8) keeps at the one prey it has chosen: with it in hand, by biting it
  // (re-test 16, a hundred shoves at a cornered Mira).
  if (unit.tactics!.adjective === "hungry" && unit.tactics!.targetId) {
    const held = rulesetDragging(definition, encounter, actor).ids.includes(unit.tactics!.targetId);
    for (const candidate of candidates)
      if (
        candidate.targetId === unit.tactics!.targetId &&
        ((candidate.damage ?? 0) > 0 || (!held && (candidate.setup ?? 0) > 0))
      )
        candidate.focus = (candidate.focus ?? 0) + 0.6;
  }
  // A territorial one walks nowhere off its ground, but back onto it (combat AI T4).
  const territory = rulesetTerritoryLeash(definition, encounter, actor, unit);
  if (territory) {
    const gap = rulesetGap(actor, territory.charge);
    const kept = candidates.filter((candidate) => {
      const to = candidate.action.to;
      if (!to) return true;
      const after = rulesetGapFrom(to, rulesetSpanOf(actor), territory.charge);
      return after <= territory.within || after < gap;
    });
    candidates.splice(0, candidates.length, ...kept);
  }
  // Everything it had would take it off its leash: nothing to do but get back to its charge.
  if (candidates.length === 0) return null;
  const behavior = unit.tactics!.mind === "mindless" ? undefined : rulesetCombatantBehavior(definition, actor);
  const opening = !menu && !!behavior?.opens && !unit.tactics!.opened && encounter.round <= 2;
  // Whom it goes for, by its own data or else by what it is. Only on its turn: an answer goes where
  // the moment points, and a Counterspell is not taken for liking the look of its caster.
  if (behavior && !menu) weighRulesetBehavior(definition, encounter, actor, behavior, candidates, opening);
  if (!menu && !behavior?.targets?.length)
    weighRulesetMindFocus(definition, encounter, actor, unit.tactics!, candidates);
  if (!menu) weighRulesetReserve(definition, encounter, actor, unit.tactics!, candidates);
  if (!menu) weighRulesetPrepare(definition, encounter, actor, unit.tactics!, candidates);
  if (!menu && unit.tactics!.mind !== "mindless")
    weighRulesetLeadership(definition, state, encounter, actor, candidates);
  return { unit, actor, candidates, orders, behavior, opening };
}

/** Whether a combatant leads its side: its stat block's `leader`, or the story's (E2). */
function rulesetLeads(one: RulesetCombatant): boolean {
  return !!(one.leader || one.block?.leader);
}

/**
 * A leader and its side (combat AI A6): on its first turns a leader opens with what helps several of
 * its side at once (a Leadership, a Bless, a battle cry), and an opponent goes at whoever its own
 * side's leader last went at, as companions told to follow do.
 */
function weighRulesetLeadership(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  // For several of its side at once: more than one target, or a shape, on friends; or a condition
  // on itself whose aura reaches its friends (5e's Leadership, following the knight for a minute).
  const sideWide = (option: RulesetCombatOption) =>
    (option.targets.side === "ally" || option.targets.side === "any") && (option.targets.count >= 2 || !!option.area);
  const leadsFriends = (option: RulesetCombatOption) =>
    !!actor.actions
      .find((action) => action.id === option.id)
      ?.applies?.some((applied) =>
        definition.combat?.conditions
          ?.find((rule) => rule.condition === applied.condition)
          ?.auras?.some((aura) => aura.side === "allies" || aura.side === "all"),
      );
  if (rulesetLeads(actor) && encounter.round <= 2) {
    for (const candidate of candidates) {
      const option = candidate.action.option;
      if (((candidate.support ?? 0) > 0 && sideWide(option)) || leadsFriends(option))
        candidate.focus = (candidate.focus ?? 0) + 1;
    }
    return;
  }
  if (actor.side === "party") return;
  const disciplined =
    [...state.party, ...state.enemies].find((one) => one.id === actor.id)?.tactics?.adjective === "disciplined";
  const leader = encounter.combatants.find(
    (one) => one.side === actor.side && one.id !== actor.id && rulesetLeads(one) && rulesetCombatStanding(one),
  );
  if (!leader) return;
  let marked: string | undefined;
  for (const { event } of [...(fightOf(state)?.events ?? [])].reverse()) {
    const by = "sourceId" in event ? event.sourceId : "actorId" in event ? event.actorId : undefined;
    const at = "targetId" in event ? event.targetId : undefined;
    if (by !== leader.id || typeof at !== "string") continue;
    const target = rulesetCombatant(encounter, at);
    if (target && target.side !== actor.side && rulesetCombatStanding(target)) {
      marked = target.id;
      break;
    }
  }
  if (!marked) return;
  for (const candidate of candidates)
    if (candidate.targetId === marked && ((candidate.damage ?? 0) > 0 || (candidate.setup ?? 0) > 0))
      // A disciplined one carries out its leader's choice (combat AI T1).
      candidate.focus = (candidate.focus ?? 0) + (disciplined ? 0.6 : 0.3);
}

/**
 * Turns the temperament of a creature the Engine plays as its `shifts` say (combat AI T7): the
 * story's, else its own data's. Bloodied below half its health, one of its side or its leader down,
 * or cornered: below a quarter, an opponent beside it and no cell to run to.
 */
function shiftRulesetTemperament(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): { to: string; on: string } | undefined {
  const combat = definition.combat;
  const unit = [...state.party, ...state.enemies].find((one) => one.id === actor.id);
  if (!combat || !unit?.tactics) return undefined;
  const shifts = unit.aiHints?.shifts ?? rulesetCombatantBehavior(definition, actor)?.shifts;
  const health = rulesetCombatHealth(definition, combat, actor);
  const ours = encounter.combatants.filter(
    (one) => one.side === actor.side && one.id !== actor.id && one.calledBy === undefined && !one.object,
  );
  const fallen = ours.filter(
    (one) => one.down || (one.defeated && (!one.away || !!one.away.left || !!one.away.surrendered)),
  );
  const happened = (trigger: string): boolean =>
    trigger === "bloodied"
      ? health.value < health.max / 2
      : trigger === "ally-down"
        ? fallen.length > 0
        : trigger === "leader-down"
          ? fallen.some(rulesetLeads)
          : health.value < health.max / 4 &&
            encounter.combatants.some(
              (one) =>
                one.side !== actor.side &&
                rulesetCombatStanding(one) &&
                !!rulesetPositionOf(one) &&
                !!rulesetPositionOf(actor) &&
                rulesetGap(one, actor) <= 1,
            ) &&
            !rulesetRetreatCell(definition, encounter, actor.id);
  // What turned it, for the log (re-test 14): the first of its shifts that has happened.
  let on: string | undefined;
  const turned = shiftCombatTemperament(unit.tactics, shifts, (trigger) => {
    const now = happened(trigger);
    if (now) on ??= trigger;
    return now;
  });
  if (!turned) return undefined;
  actor.temperament = turned;
  return { to: turned, on: on! };
}

/**
 * Its side rallied (combat AI A6): as a leader the Engine plays starts its turn, each of its side
 * running from the fight within six squares of it (thirty feet in 5e) stops, and checks its nerve
 * again as its own next turn starts, on what broke it. Only in a ruleset with `combat.morale`.
 */
function rallyRulesetSide(definition: RulesetDefinition, encounter: RulesetEncounterState, leader: RulesetCombatant) {
  if (!definition.combat?.morale || !rulesetLeads(leader) || !rulesetCombatStanding(leader)) return;
  if (!rulesetPositionOf(leader)) return;
  for (const one of encounter.combatants) {
    if (one.side !== leader.side || one.id === leader.id || !one.routed || !rulesetCombatStanding(one)) continue;
    if (!rulesetPositionOf(one) || rulesetGap(leader, one) > 6) continue;
    delete one.routed;
    one.moraleChecked = (one.moraleChecked ?? []).slice(0, -1);
  }
}

/**
 * A companion's standing orders (P7): its player's, else its default, guarding the leader and keeping
 * its best for when it matters, which it stops doing once the fight goes badly for the party. None
 * for anybody else.
 */
function rulesetOrdersFor(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  unit: { orders?: CombatOrders },
): CombatOrders | undefined {
  if (actor.side !== "party") return rulesetBodyguardOrders(definition, encounter, actor);
  if (unit.orders) return unit.orders;
  return { posture: "guard", ...(rulesetGoingBadly(definition, encounter, "party") ? {} : { conserve: true }) };
}

/**
 * Whom a bodyguard (a `behavior.guards`, combat AI A5, 1.761) stands up for: the nearest friend still
 * standing of the kinds it names (its side's leader, a caster, one who heals others), as a companion
 * told to protect them: a standing order, so a mindless one (a Shield Guardian, a zombie) keeps it
 * too. None once nobody of those kinds is left.
 */
function rulesetBodyguardOrders(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): CombatOrders | undefined {
  const guards = rulesetCombatantBehavior(definition, actor)?.guards;
  if (!guards || !rulesetPositionOf(actor)) return undefined;
  const actions = (one: RulesetCombatant) => one.actions.filter((action) => !action.whileHolds);
  const kept = (one: RulesetCombatant) =>
    guards.some((kind) =>
      kind === "leader"
        ? !!(one.leader || one.block?.leader)
        : kind === "casters"
          ? actions(one).some(rulesetActionIsSpell)
          : actions(one).some((action) => action.heal && action.targets.side !== "self"),
    );
  const charges = encounter.combatants.filter(
    (one) =>
      one.side === actor.side &&
      one.id !== actor.id &&
      !one.object &&
      rulesetCombatStanding(one) &&
      !!rulesetPositionOf(one) &&
      kept(one),
  );
  if (charges.length === 0) return undefined;
  const charge = charges.reduce((best, one) => (rulesetGap(actor, one) < rulesetGap(actor, best) ? one : best));
  return { posture: "protect", protectId: charge.id };
}

/** Whether a fight is going badly for a side: less than half its health left between those still in
 *  it, or more of it down than of the other side. */
function rulesetGoingBadly(definition: RulesetDefinition, encounter: RulesetEncounterState, side: string): boolean {
  const combat = definition.combat;
  if (!combat) return false;
  const ours = encounter.combatants.filter((one) => one.side === side && !one.object);
  const theirs = encounter.combatants.filter((one) => one.side !== side && !one.object);
  const left = ours.reduce((sum, one) => sum + Math.max(0, rulesetCombatHealth(definition, combat, one).value), 0);
  const most = ours.reduce((sum, one) => sum + Math.max(1, rulesetCombatHealth(definition, combat, one).max), 0);
  const down = (who: RulesetCombatant[]) =>
    who.filter((one) => !rulesetCombatStanding(one)).length / Math.max(1, who.length);
  return left < most * 0.5 || down(ours) > down(theirs);
}

/** The chance a concentration save forced by this much damage fails, on a d20 against the ruleset's
 *  difficulty: one for a ruleset with no such save, where any harm breaks it. */
function rulesetConcentrationFails(
  combat: NonNullable<RulesetDefinition["combat"]>,
  target: RulesetCombatant,
  damage: number,
): number {
  const concentration = combat.concentration;
  if (!concentration) return 1;
  const difficulty = Math.max(concentration.floor, Math.floor(damage * concentration.fromDamage));
  const modifier = target.saves[concentration.save] ?? 0;
  return Math.min(1, Math.max(0, (difficulty - 1 - modifier) / 20));
}

/** How far a companion guarding or protecting somebody strays from them (P7), in squares. */
const RULESET_LEASH = 3;

/** How far it strays under its orders: three squares from whoever it guards or protects, but beside
 *  the leader it follows until they strike (re-test 2026-10-23: a rogue on follow walked up beside
 *  the leader, then Dashed three squares on into the orcs before the leader had struck anyone). */
function rulesetLeashWithin(orders: CombatOrders): number {
  return orders.posture === "follow" ? 1 : RULESET_LEASH;
}

/** Whether an actor could shoot somebody of the other side from where it stands: one in range of a
 *  ranged blow it has and in its sight. Out of sight, staying put is a turn thrown away (re-test
 *  2026-10-23: a wizard stood three turns behind a wall while her friends bled out). */
function rulesetHasShot(definition: RulesetDefinition, encounter: RulesetEncounterState, actorId: string): boolean {
  const actor = rulesetCombatant(encounter, actorId);
  if (!actor || !rulesetPositionOf(actor)) return false;
  const reach = Math.max(
    0,
    ...actor.actions
      .filter(
        (one) => one.range && !one.reach && one.damage && rulesetActionAvailable(actor, one, encounter, definition),
      )
      .map((one) => one.range!.long ?? one.range!.normal),
  );
  if (reach <= 1) return false;
  return encounter.combatants.some(
    (foe) =>
      foe.side !== actor.side &&
      rulesetCombatStanding(foe) &&
      !!rulesetPositionOf(foe) &&
      rulesetGap(actor, foe) <= reach &&
      rulesetSees(encounter, actor, foe),
  );
}

/** The roles that fight from afar, and so never walk in once somebody is already in their range. */
const RULESET_KEEPS_RANGE = new Set(["spellcaster", "marksman", "controller", "supporter"]);
interface RulesetLeash {
  charge: RulesetCombatant;
  within: number;
}

/** Whether it keeps its ground (combat AI T4): territorial, or a mindless one whose data says so, as
 *  a golem set to guard a place by its maker keeps to it with no temperament of its own. */
function rulesetTerritorial(definition: RulesetDefinition, actor: RulesetCombatant, tactics: CombatTactics): boolean {
  if (tactics.adjective === "territorial") return true;
  return tactics.mind === "mindless" && rulesetCombatantBehavior(definition, actor)?.temperament === "territorial";
}

/**
 * The ground a territorial one keeps (combat AI T4): within its `behavior.territory` squares (6
 * unless it says) of where it began, as a leash on that spot. None once whoever last hurt it stands
 * off that ground, struck from afar: then it goes after them.
 */
function rulesetTerritoryLeash(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  unit: Combatant,
): RulesetLeash | undefined {
  const home = unit.tactics?.home;
  if (!home || !rulesetTerritorial(definition, actor, unit.tactics!)) return undefined;
  const within = rulesetCombatantBehavior(definition, actor)?.territory ?? 6;
  const charge = { ...actor, x: home.x, y: home.y } as RulesetCombatant;
  const harm = actor.harmedBy ? rulesetCombatant(encounter, actor.harmedBy) : undefined;
  if (
    harm &&
    harm.side !== actor.side &&
    rulesetCombatStanding(harm) &&
    rulesetPositionOf(harm) &&
    rulesetGap(harm, charge) > within
  )
    return undefined;
  return { charge, within };
}

/** Whom a companion's orders keep it near (P7): the leader it guards or the friend it protects,
 *  standing and somebody else. None for any other orders. */
function rulesetLeashOf(
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  orders: CombatOrders,
): RulesetLeash | undefined {
  const charge = rulesetChargeOf(state, encounter, actor, orders);
  return charge && charge.id !== actor.id && rulesetCombatStanding(charge) && rulesetPositionOf(charge)
    ? { charge, within: rulesetLeashWithin(orders) }
    : undefined;
}

/**
 * Whom a guarding companion stays near (playtest re-test 9): the leader while nobody is fighting or
 * the leader is, else the nearest friend with an opponent beside them, so a guard whose leader hangs
 * back goes to the friend fighting alone instead of standing idle at the leader's side.
 */
/** Whom a companion's orders keep it beside: the friend it protects, the one it guards, and the leader
 *  it follows until the leader has gone at somebody (re-test 2026-10-23: a rogue on follow dashed ten
 *  squares into three orcs before the leader had struck anyone). */
function rulesetChargeOf(
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  orders: CombatOrders,
): RulesetCombatant | undefined {
  if (orders.posture === "protect") return rulesetCombatant(encounter, orders.protectId!);
  if (orders.posture === "guard") return rulesetGuardCharge(state, encounter, actor);
  if (orders.posture === "follow" && !rulesetFollowedTarget(state, encounter, actor))
    return rulesetPartyLeader(state, encounter);
  return undefined;
}

/** Whoever the party's leader went at last, still standing, for a companion that follows them. */
function rulesetFollowedTarget(
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): string | undefined {
  const leader = rulesetPartyLeader(state, encounter);
  if (!leader || leader.id === actor.id) return undefined;
  for (const { event } of [...(fightOf(state)?.events ?? [])].reverse()) {
    const by = "sourceId" in event ? event.sourceId : "actorId" in event ? event.actorId : undefined;
    const at = "targetId" in event ? event.targetId : undefined;
    if (by !== leader.id || typeof at !== "string") continue;
    const target = rulesetCombatant(encounter, at);
    if (target && target.side !== actor.side && rulesetCombatStanding(target)) return target.id;
  }
  return undefined;
}

function rulesetGuardCharge(
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): RulesetCombatant | undefined {
  const leader = rulesetPartyLeader(state, encounter);
  const engaged = (one: RulesetCombatant) =>
    !!rulesetPositionOf(one) &&
    encounter.combatants.some(
      (foe) =>
        foe.side !== one.side &&
        !foe.object &&
        rulesetCombatStanding(foe) &&
        !!rulesetPositionOf(foe) &&
        rulesetGap(one, foe) <= 1,
    );
  if (!leader || leader.id === actor.id || engaged(leader) || !rulesetPositionOf(actor)) return leader;
  const fighting = encounter.combatants.filter(
    (one) => one.side === actor.side && one.id !== actor.id && rulesetCombatStanding(one) && engaged(one),
  );
  if (!fighting.length) return leader;
  return fighting.reduce((best, one) => (rulesetGap(actor, one) < rulesetGap(actor, best) ? one : best));
}

/** The party's leader: the first of it its player plays and still standing, else the first standing. */
function rulesetPartyLeader(
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
): RulesetCombatant | undefined {
  const fight = fightOf(state);
  const standing = encounter.combatants.filter((one) => one.side === "party" && rulesetCombatStanding(one));
  return (fight ? standing.find((one) => rulesetController(state, fight, one) === "manual") : undefined) ?? standing[0];
}

/**
 * What a companion's orders say it goes for (P7), onto each candidate: whoever the leader is
 * attacking (`follow`), an opponent beside the one it guards or protects, and help for that one;
 * never finishing anybody with a blow that would kill rather than knock out (`spare`); and nowhere
 * to walk to while it holds its ground. The weights its orders change are `chooseCombatCandidate`'s.
 */
function weighRulesetOrders(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  orders: CombatOrders,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  const charge = rulesetChargeOf(state, encounter, actor, orders);
  const guarded = charge && charge.id !== actor.id && rulesetCombatStanding(charge) ? charge : undefined;
  const strength = orders.posture === "protect" ? 1 : 0.3;
  // Whoever is on the one it protects comes before whoever is on itself (re-test 2026-10-23: a rogue
  // protecting the wizard stabbed the orc beside him while an ogre clubbed her from 27 to 5).
  const pressing =
    orders.posture === "protect" && guarded
      ? encounter.combatants.some(
          (foe) =>
            foe.side !== actor.side &&
            rulesetCombatStanding(foe) &&
            !!rulesetPositionOf(foe) &&
            !!rulesetPositionOf(guarded) &&
            rulesetGap(foe, guarded) <= 1,
        )
      : false;
  const near = (a: RulesetCombatant, b: RulesetCombatant) =>
    !!rulesetPositionOf(a) && !!rulesetPositionOf(b) && rulesetGap(a, b) <= 1;
  // Whoever the leader went at last, still standing.
  const followed = orders.posture === "follow" ? rulesetFollowedTarget(state, encounter, actor) : undefined;
  // Guarding or protecting somebody keeps it on a leash: nothing is worth walking more than three
  // squares from them for, so it never runs off across the board after the first foe it sees. With
  // nothing left, its turn walks back toward them (see `walkTowardsTrouble`).
  if (guarded) {
    const gap = rulesetGap(actor, guarded);
    // Already off it, it does nothing where it stands but harm or help: no hiding, dodging, readying
    // or waiting out there, so its turn goes to walking back.
    const within = rulesetLeashWithin(orders);
    const strayed = gap > within;
    const kept = candidates.filter((candidate) => {
      const to = candidate.action.to;
      if (to) {
        // A walk to strike ends on the leash: off it, closer than before is still running off after
        // a foe (re-test 14, a cultist eight squares out walking to six to stab a rogue). It walks
        // back instead.
        const after = rulesetGapFrom(to, rulesetSpanOf(actor), guarded);
        return after <= within;
      }
      return (
        !strayed ||
        (candidate.damage ?? 0) > 0 ||
        (candidate.healing ?? 0) > 0 ||
        (candidate.support ?? 0) > 0 ||
        // Setting somebody up, not merely itself (a Ready or a Dash on the spot).
        ((candidate.setup ?? 0) > 0 && !!candidate.targetId)
      );
    });
    candidates.splice(0, candidates.length, ...kept);
  }
  for (const candidate of candidates) {
    const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : undefined;
    const harms = !!target && target.side !== actor.side && ((candidate.damage ?? 0) > 0 || (candidate.setup ?? 0) > 0);
    let focus = 0;
    if (harms && target!.id === followed) focus += 0.6;
    if (harms && guarded && near(target!, guarded)) focus += strength;
    else if (harms && pressing) focus -= 0.5;
    if (
      !harms &&
      guarded &&
      target?.id === guarded.id &&
      ((candidate.healing ?? 0) > 0 || (candidate.support ?? 0) > 0)
    )
      focus += strength * 0.7;
    if (focus !== 0) candidate.focus = (candidate.focus ?? 0) + focus;
  }
  // Retreating is getting away (re-test 2026-10-23: a wizard on retreat Dodged in a corner five turns
  // of seven, an ogre beside her, Misty Step in hand): with an opponent beside it, a getaway or a
  // step through space comes first; with none near, it keeps helping from afar as `back` does rather
  // than dodging nobody.
  if (orders.posture === "retreat") {
    const pressed = encounter.combatants.some(
      (foe) =>
        foe.side !== actor.side &&
        rulesetCombatStanding(foe) &&
        !!rulesetPositionOf(foe) &&
        !!rulesetPositionOf(actor) &&
        rulesetGap(foe, actor) <= 1,
    );
    for (const candidate of candidates) {
      const defensive = rulesetDefensiveName(candidate.action.option);
      const action = actor.actions.find((one) => one.id === candidate.action.option.id);
      const away = defensive === "disengage" || (!!action?.teleport && candidate.action.option.targets.side === "self");
      if (pressed && away) candidate.focus = (candidate.focus ?? 0) + 1;
      if (!pressed && defensive === "dodge") {
        candidate.hold = false;
        candidate.focus = (candidate.focus ?? 0) - 0.5;
      }
    }
  }
  // A blow, a spell, an area or an aura that would kill (re-test 2026-10-23: a Fire Bolt, a Fireball
  // and Spirit Guardians all killed under spare): only one in melee by somebody pulling their blows
  // knocks out instead. Any of the rest is never taken while something that kills nobody is there: a
  // knockout, a healthier target, a hold or a Dodge. With nothing else, it is worth no harm.
  if (orders.spare) {
    const kills = (candidate: CombatAiCandidate<RulesetCandidate>) => {
      const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : undefined;
      const harms =
        !!target && target.side !== actor.side && ((candidate.damage ?? 0) > 0 || (candidate.setup ?? 0) > 0);
      if (!(harms && (candidate.finish ?? 0) > 0) && !candidate.action.drops?.length) return false;
      const action = actor.actions.find((one) => one.id === candidate.action.option.id);
      const knocksOut =
        !!actor.knocksOut &&
        !action?.range &&
        !action?.area &&
        !action?.around &&
        (candidate.action.drops?.length ?? 1) <= 1;
      return !knocksOut;
    };
    const kind = candidates.filter((candidate) => !kills(candidate));
    if (kind.length > 0 && kind.length < candidates.length) candidates.splice(0, candidates.length, ...kind);
    else if (kind.length === 0) {
      // Everything it could do kills: it ends its turn rather than finish anybody off.
      const end = rulesetCombatOptions(definition, encounter, actor.id).find((option) => option.kind === "end-turn");
      if (end)
        candidates.splice(0, candidates.length, {
          action: { choice: { actorId: actor.id, optionId: end.id, targetIds: [] }, option: end },
          hold: true,
        });
      else
        for (const candidate of candidates) {
          candidate.damage = 0;
          candidate.finish = 0;
        }
    }
  }
}

/** How far above its average a blow's dice can roll: its most over its average, 1 for a blow of no
 *  dice (or one the forecast reads some other way). */
function rulesetDamageCeiling(damage: RulesetCombatAction["damage"] | undefined): number {
  if (!damage || !("sides" in damage)) return 1;
  const average = rulesetAverageDamage(damage);
  if (average <= 0) return 1;
  const most =
    damage.count * damage.sides +
    damage.flat +
    (damage.plus ?? [])
      .filter((one) => !one.targetIs && !one.onCritical && one.whileOn === undefined)
      .reduce((sum, one) => sum + one.count * one.sides + one.flat, 0);
  return Math.max(1, most / average);
}

/** Help worth less than this is not worth a turn: an ability check's die in a fight. */
const RULESET_TRIFLING_HELP = 0.05;

/** What letting go of the spell an actor holds up costs it: what holding it does, up to 0.4 for one
 *  that harms (a zone, a blow held up) or whose worth cannot be read. */
function rulesetHeldWorth(
  definition: RulesetDefinition,
  combat: NonNullable<RulesetDefinition["combat"]>,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): number {
  const held = actor.concentrating;
  if (!held) return 0;
  const action = actor.actions.find((one) => one.id === held.actionId);
  if (!action || action.damage || action.zone || action.heal) return 0.4;
  const on = (held.targets ?? [actor.id])
    .map((id) => rulesetCombatant(encounter, id))
    .filter((one): one is RulesetCombatant => !!one && rulesetCombatStanding(one));
  if (on.length === 0) return 0;
  // Read as though not yet put on them, so what they hold counts.
  const puts = new Set((action.applies ?? []).map((applied) => applied.condition));
  const worth = on.reduce((sum, one) => {
    const bare: RulesetCombatant = { ...one, tracked: one.tracked.filter((entry) => !puts.has(entry.condition)) };
    return sum + (rulesetEffectWorth(definition, combat, encounter, actor, action, bare) ?? 0.4);
  }, 0);
  return Math.min(0.4, worth);
}

/** What getting a friend back on their feet is worth over anything else it could do. */
const RULESET_DOWNED_FOCUS = 2;

/**
 * A friend down and dying comes first (re-test 2026-10-23: a cleric with Healing Word in hand cast
 * Sacred Flame and swung Spiritual Weapon while the wizard failed a death save): whatever heals one
 * is all it does while it can, whatever its orders (round 2: under no orders, Bless and then Spirit
 * Guardians outranked lifting a rogue three death saves from dying).
 */
function weighRulesetDowned(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  const raises = candidates.filter((candidate) => {
    if ((candidate.healing ?? 0) <= 0) return false;
    const ids = candidate.targetId ? [candidate.targetId] : candidate.action.choice.targetIds;
    return ids.some((id) => {
      const one = rulesetCombatant(encounter, id);
      return !!one && one.side === actor.side && one.down && !one.defeated;
    });
  });
  if (raises.length === 0) return;
  for (const candidate of raises) candidate.focus = (candidate.focus ?? 0) + RULESET_DOWNED_FOCUS;
  candidates.splice(0, candidates.length, ...raises);
}

/** What harming an opponent who drops areas on its side is worth over anything else it could do,
 *  once one has landed; half that for one who only holds one. */
const RULESET_BLASTER_FOCUS = 0.8;

/**
 * A companion goes after whoever is dropping areas on its side (re-test round 2: a cult mage threw a
 * Fireball into the party every round and ended both fights untouched, while the wizard and the
 * cleric shot its cultists): a blow, a hold or an area that catches them comes first. Read from the
 * areas that landed this fight and from what each opponent still holds that harms an area.
 */
function weighRulesetBlasters(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  const landed = new Set<string>();
  for (const { event } of fightOf(state)?.events ?? []) if (event.type === "area") landed.add(event.actorId);
  const blasters = new Map<string, number>();
  for (const foe of encounter.combatants) {
    if (foe.side === actor.side || !rulesetCombatStanding(foe)) continue;
    const holds = foe.actions.some(
      (action) =>
        !!(action.area || action.zone) && !!action.damage && rulesetActionAvailable(foe, action, encounter, definition),
    );
    if (landed.has(foe.id) && holds) blasters.set(foe.id, RULESET_BLASTER_FOCUS);
    else if (holds) blasters.set(foe.id, RULESET_BLASTER_FOCUS / 2);
  }
  if (blasters.size === 0) return;
  for (const candidate of candidates) {
    if ((candidate.damage ?? 0) <= 0 && (candidate.setup ?? 0) <= 0) continue;
    const { choice, option } = candidate.action;
    const caught = choice.at ? rulesetAreaTargets(encounter, actor.id, option.id, choice.at) : [];
    const ids = new Set([...(candidate.targetId ? [candidate.targetId] : []), ...choice.targetIds, ...caught]);
    const by = Math.max(0, ...[...ids].map((id) => blasters.get(id) ?? 0));
    if (by > 0) candidate.focus = (candidate.focus ?? 0) + by;
  }
}

/** Whether a pick is the action or spell an `opens` names: its own id, or the catalog entry it was
 *  made from (`fireball`, or `spells/fireball`). */
function rulesetOpensWith(actor: RulesetCombatant, candidate: RulesetCandidate, id: string): boolean {
  if (candidate.option.id === id) return true;
  const entry = actor.actions.find((action) => action.id === candidate.option.id)?.entry;
  return entry !== undefined && (entry === id || entry.endsWith(`/${id}`));
}

/** What a tactician keeps back for an answer (combat AI P8): the price of a turn that would spend
 *  what its last Counterspell or Shield needs. */
const RULESET_RESERVE_PRICE = 0.3;

/**
 * A tactician or a genius keeps what its answers need (combat AI P8): a turn that would spend the last
 * slot, use or pool a reaction it holds could still be paid from costs that much more, so a mage casts
 * its cantrip and keeps the 3rd-level slot for the Counterspell unless the spell is worth giving it
 * up. Nothing to keep when no answer can be paid now.
 */
function weighRulesetReserve(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  tactics: CombatTactics,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  if (tactics.mind !== "tactical" && tactics.mind !== "genius") return;
  const answers = actor.actions.filter((action) => action.reaction && !action.innate?.coven);
  if (answers.length === 0) return;
  const pools = actor.sheet
    ? readRulesetLive(definition, actor.sheet.build, actor.sheet.live, actor.sheet.items).pools.map((pool) => pool.key)
    : [];
  // Whether one of its answers can be paid by this holder, as its slots, uses and sheet stand.
  const answerable = (holder: RulesetCombatant) =>
    answers.some((answer) => {
      if (answer.innate?.slot) return rulesetInnateSlot(holder, answer, encounter) !== undefined;
      if (answer.uses && rulesetActionUses(holder, answer, encounter) < 1) return false;
      if (!answer.use || !holder.sheet) return !!answer.uses;
      return [undefined, ...pools].some((pool) => planRulesetCombatCost(definition, holder, answer, pool) !== null);
    });
  if (!answerable(actor)) return;
  const spent = new Map<string, boolean>();
  for (const candidate of candidates) {
    const action = actor.actions.find((one) => one.id === candidate.action.option.id);
    if (!action || action.reaction) continue;
    const payWith = candidate.action.choice.payWith;
    const key = `${action.id}\u0000${payWith ?? ""}`;
    let drains = spent.get(key);
    if (drains === undefined) {
      // The holder as this would leave it: a slot, a use or the pool it is paid from spent.
      const after: RulesetCombatant = { ...actor, uses: { ...actor.uses } };
      const slot = action.innate?.slot ? rulesetInnateSlot(actor, action, encounter) : undefined;
      if (slot !== undefined) after.uses[`slot:${slot}`] = rulesetInnateSlotsLeft(actor, action, slot, encounter) - 1;
      if (action.uses) after.uses[rulesetUsesKey(action)] = rulesetActionUses(actor, action, encounter) - 1;
      if (action.use && actor.sheet) {
        const paid = planRulesetCombatCost(definition, actor, action, payWith);
        if (paid?.live) after.sheet = { ...actor.sheet, live: paid.live };
      }
      drains = !answerable(after);
      spent.set(key, drains);
    }
    if (drains) candidate.cost = (candidate.cost ?? 0) + RULESET_RESERVE_PRICE;
  }
}

/** What a tactician gives a lasting help to its own side while the fight is still coming (combat AI P8). */
const RULESET_PREPARE_FOCUS = 0.35;

/**
 * A tactician or a genius readies itself while the fight is still far (combat AI P8): with no
 * opponent able to walk up and strike it before its next turn, a help that lasts (Shield of Faith,
 * Mage Armor, Greater Invisibility) on itself or a friend is worth more than a chip shot from afar.
 * Never one that would end what it already holds, and never once an opponent is close.
 */
function weighRulesetPrepare(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  tactics: CombatTactics,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  if (tactics.mind !== "tactical" && tactics.mind !== "genius") return;
  if (!encounter.board?.grid || !rulesetPositionOf(actor)) return;
  const perCell = definition.combat?.distance?.perCell;
  const foes = encounter.combatants.filter((one) => one.side !== actor.side && rulesetCombatStanding(one));
  if (foes.length === 0) return;
  // Close when any opponent could walk up and strike it, or any friend of it already stands beside one.
  const close = foes.some((foe) => {
    if (!rulesetPositionOf(foe)) return true;
    const walks = perCell ? rulesetInCells(foe.speed, perCell) : 6;
    const reach = Math.max(1, ...foe.actions.filter((one) => one.damage && !one.range).map((one) => one.reach ?? 1));
    if (rulesetGap(actor, foe) <= walks + reach) return true;
    return encounter.combatants.some(
      (friend) =>
        friend.side === actor.side &&
        rulesetCombatStanding(friend) &&
        rulesetPositionOf(friend) &&
        rulesetGap(friend, foe) <= 1,
    );
  });
  if (close) return;
  for (const candidate of candidates) {
    const helps = (candidate.setup ?? 0) + (candidate.support ?? 0);
    if (helps <= 0 || (candidate.healing ?? 0) > 0 || (candidate.damage ?? 0) > 0) continue;
    const option = candidate.action.option;
    if (option.kind === "standard" || option.kind === "move") continue;
    const target = candidate.targetId ? rulesetCombatant(encounter, candidate.targetId) : actor;
    if (!target || target.side !== actor.side) continue;
    const action = actor.actions.find((one) => one.id === option.id);
    if (!action?.applies?.length) continue;
    if (action.concentration && actor.concentrating) continue;
    // Only what lasts into the fight: a moment's help is spent before anybody arrives.
    if (!action.applies.some((applied) => rulesetDurationWorth(applied.duration) >= 0.85)) continue;
    candidate.focus = (candidate.focus ?? 0) + RULESET_PREPARE_FOCUS;
  }
}

/**
 * Whom a creature goes for by what it is (combat AI P6), onto each candidate as `focus`, where its
 * own data names nobody: an animal the nearest and the weakest, a cunning one the weakest and then the
 * most dangerous, a tactician and a genius whoever is doing its side the most harm (its blows, the
 * health it gives back, the spell it holds and who of its side it holds down). A mindless one is
 * played apart.
 */
function weighRulesetMindFocus(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  tactics: CombatTactics,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
): void {
  const combat = definition.combat;
  if (!combat || tactics.mind === undefined || tactics.mind === "mindless") return;
  const foes = encounter.combatants.filter((one) => one.side !== actor.side && rulesetCombatStanding(one));
  if (foes.length < 2) return;
  const lowest = (score: (one: RulesetCombatant) => number) => {
    const scored = foes.map((one) => ({ one, score: score(one) }));
    const best = Math.min(...scored.map((entry) => entry.score));
    // Nobody stands out when they are all alike.
    if (scored.every((entry) => entry.score === best)) return new Set<string>();
    return new Set(scored.filter((entry) => entry.score === best).map((entry) => entry.one.id));
  };
  const at = rulesetPositionOf(actor);
  const nearest = () =>
    at ? lowest((one) => (rulesetPositionOf(one) ? rulesetGap(actor, one) : Infinity)) : new Set<string>();
  const weakest = () =>
    lowest((one) => {
      const health = rulesetCombatHealth(definition, combat, one);
      return health.value + health.temp;
    });
  const dangerous = () => lowest((one) => -rulesetThreat(definition, combat, encounter, one));
  const leanings: Array<[Set<string>, number]> =
    tactics.mind === "instinct"
      ? [
          [nearest(), 0.15],
          [weakest(), 0.15],
        ]
      : tactics.mind === "cunning"
        ? [
            [weakest(), 0.15],
            [dangerous(), 0.1],
          ]
        : [[dangerous(), tactics.mind === "genius" ? 0.25 : 0.2]];
  const worth = (candidate: CombatAiCandidate<RulesetCandidate>) => (candidate.damage ?? 0) + (candidate.setup ?? 0);
  const best = Math.max(0, ...candidates.map(worth));
  const hardest = Math.max(0, ...candidates.map((candidate) => candidate.action.expected ?? 0));
  for (const candidate of candidates) {
    const target = candidate.targetId;
    // Only something done to an opponent: a heal or a help is aimed by need.
    if (target === undefined || ((candidate.damage ?? 0) <= 0 && (candidate.setup ?? 0) <= 0)) continue;
    let focus = 0;
    for (const [ids, by] of leanings) if (ids.has(target)) focus += by;
    // Shrunk by how far short of its best this falls: liking the look of a target never makes a token
    // blow (a long-range dagger at a healer) beat stepping in for a full Multiattack.
    if (best > 0) focus *= Math.min(1, worth(candidate) / best);
    // Nor a blow that does much less harm than its hardest, whoever takes it: two daggers thrown at
    // disadvantage at a wizard do some six tenths of a Multiattack on the knight beside it, and win
    // nothing by its liking (re-test 10). Full only for its hardest, none below 85 hundredths: two
    // daggers worth nine tenths of a Multiattack on the fighter two steps off no longer walk it away
    // from him (re-test 12). Nor at all for a blow weaker than its hardest (re-test 13): the lean picks
    // between blows that hurt alike, and never lets two daggers worth 94 hundredths of a Multiattack
    // win over it.
    const expected = candidate.action.expected;
    if (expected !== undefined && hardest > 0 && expected < hardest * RULESET_FOCUS_ALIKE) focus = 0;
    if (focus > 0) candidate.focus = (candidate.focus ?? 0) + focus;
  }
}

/**
 * What a creature's own data says it goes for (1.747), onto each candidate as `focus`: whom it goes
 * for first (`targets`, the first named most), a friend's opponent for a `pack` hunter, and on its
 * first turns the opener it names, ahead of anything else worth doing.
 */
function weighRulesetBehavior(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
  behavior: RulesetCombatBehavior,
  candidates: Array<CombatAiCandidate<RulesetCandidate>>,
  opening: boolean,
): void {
  const combat = definition.combat;
  if (!combat) return;
  const foes = encounter.combatants.filter((one) => one.side !== actor.side && rulesetCombatStanding(one));
  const allies = encounter.combatants.filter(
    (one) => one.side === actor.side && one.id !== actor.id && rulesetCombatStanding(one),
  );
  const at = rulesetPositionOf(actor);
  const near = (a: RulesetCombatant, b: RulesetCombatant) =>
    !!rulesetPositionOf(a) && !!rulesetPositionOf(b) && rulesetGap(a, b) <= 1;
  const health = (one: RulesetCombatant) => rulesetCombatHealth(definition, combat, one);
  const lowest = (score: (one: RulesetCombatant) => number) => {
    const scored = foes.map((one) => ({ one, score: score(one) }));
    const best = Math.min(...scored.map((entry) => entry.score));
    return new Set(scored.filter((entry) => entry.score === best).map((entry) => entry.one.id));
  };
  const preferred = (preference: RulesetTargetPreference): Set<string> => {
    switch (preference) {
      case "nearest":
        return at ? lowest((one) => (rulesetPositionOf(one) ? rulesetGap(actor, one) : Infinity)) : new Set();
      case "weakest":
        return lowest((one) => health(one).value + health(one).temp);
      case "strongest":
        return lowest((one) => -rulesetThreat(definition, combat, encounter, one));
      case "wounded":
        return new Set(foes.filter((one) => health(one).value < health(one).max * 0.5).map((one) => one.id));
      case "casters":
        return new Set(foes.filter((one) => one.actions.some(rulesetActionIsSpell)).map((one) => one.id));
      case "healers":
        return new Set(foes.filter((one) => one.actions.some((action) => action.heal)).map((one) => one.id));
      case "attacker":
        return new Set(actor.harmedBy && foes.some((one) => one.id === actor.harmedBy) ? [actor.harmedBy] : []);
      case "concentrating":
        return new Set(foes.filter((one) => one.concentrating).map((one) => one.id));
      case "leader":
        return new Set(foes.filter((one) => one.leader || one.block?.leader).map((one) => one.id));
    }
  };
  const ranked = (behavior.targets ?? []).map(preferred);
  const hunted = behavior.pack
    ? new Set(foes.filter((foe) => allies.some((ally) => near(ally, foe))).map((one) => one.id))
    : new Set<string>();
  // Its opener: the first named that it can do and that is worth doing.
  const opener = opening
    ? behavior.opens!.find((id) => candidates.some((one) => rulesetOpensWith(actor, one.action, id)))
    : undefined;
  for (const candidate of candidates) {
    let focus = 0;
    const target = candidate.targetId;
    // Only something done to an opponent: a heal or a help is aimed by need, never by preference.
    const harms =
      target !== undefined &&
      foes.some((one) => one.id === target) &&
      ((candidate.damage ?? 0) > 0 || (candidate.setup ?? 0) > 0);
    if (harms) {
      ranked.forEach((ids, place) => {
        if (ids.has(target!)) focus += Math.max(0.1, 0.4 - 0.1 * place);
      });
      if (hunted.has(target!)) focus += 0.25;
    }
    if (opener !== undefined && rulesetOpensWith(actor, candidate.action, opener)) focus += 1;
    if (focus > 0) candidate.focus = (candidate.focus ?? 0) + focus;
  }
}

/**
 * A concentration broken into one of a list of lair actions (1.336): the one taken is whichever would
 * catch the most foes, the shelves leaning onto the side of the room the party stands in. The others
 * leave the menu; equal ones, and letting the moment go, stay for the usual picker to weigh.
 */
function brokenLairMenu(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  menu: RulesetCombatOption[],
): RulesetCombatOption[] {
  const actor = rulesetCombatant(encounter, actorId);
  const lairs = menu.filter((option) => option.lairOf);
  if (!actor || !Array.isArray(actor.lair?.next) || lairs.length < 2) return menu;
  const foes = (ids: string[]) =>
    new Set(
      ids.filter((id) => {
        const one = rulesetCombatant(encounter, id);
        return !!one && one.side !== actor.side && !one.down;
      }),
    ).size;
  const catches = new Map(
    lairs.map((option) => {
      const aims = rulesetAimCells(encounter, actorId, option.id);
      let best = 0;
      for (const candidate of rulesetCandidatesFrom(definition, encounter, actorId, null, [option])) {
        const { at, targetIds } = candidate.action.choice;
        const caught = at ? (aims.find((aim) => aim.x === at.x && aim.y === at.y)?.targetIds ?? []) : targetIds;
        best = Math.max(best, foes(caught));
      }
      return [option.id, best] as const;
    }),
  );
  const most = Math.max(...catches.values());
  return menu.filter((option) => !option.lairOf || catches.get(option.id) === most);
}

// ── One step ──

/** One choice, and then the window it may have opened, answered by everybody in it the player is
 *  not playing. Every caller that acts for somebody wants both: a walk that provokes a strike must
 *  come back with the strike already made, or the fight would stand still waiting for an opponent
 *  to decide something it decides itself. */
function applyChoice(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  choice: RulesetCombatChoice,
): { refused: RulesetCombatEvent | null } {
  const step = applyChoiceOnly(definition, state, fight, choice);
  if (!step.refused) answerRulesetWindows(definition, state, fight);
  return step;
}

/** The choice alone. Answering a window is itself a choice, so the loop that drives one uses this
 *  rather than the pair above. */
function applyChoiceOnly(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  choice: RulesetCombatChoice,
): { refused: RulesetCombatEvent | null } {
  // Cast by praying (1.770): read before the step, which may spend what it was.
  const user = rulesetCombatant(fight.encounter, choice.actorId);
  const prayed =
    user && rulesetPrayedOptions(definition, user).includes(choice.optionId)
      ? user.actions.find((action) => action.id === choice.optionId)
      : undefined;
  const step = applyRulesetCombatChoice(definition, fight.encounter, choice, rollerFor(fight));
  const refused = step.events.find((event) => event.type === "refused") ?? null;
  // A refusal changes nothing and bumps nothing: the state it was given is the state it hands back.
  if (refused) return { refused };
  absorb(
    definition,
    state,
    fight,
    prayed
      ? {
          ...step,
          events: [
            { type: "prayed", actorId: choice.actorId, optionId: prayed.id, label: prayed.label },
            ...step.events,
          ],
        }
      : step,
  );
  return { refused: null };
}

/** A step's events into the fight, and the books that follow from them. A round can turn over on an
 *  ordinary turn or inside a window that was holding one up, and the Game Master gets its calls back
 *  either way, so the reading is here rather than at one of the two places a turn can end. */
function absorb(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  step: { state: RulesetEncounterState; events: readonly RulesetCombatEvent[] },
): void {
  fight.encounter = step.state;
  record(fight, step.events);
  if (step.events.some((event) => event.type === "round")) state.gmCalls = 0;
  syncRulesetCombatants(definition, state);
}

/** How many answers one window may take before the fight is let go. A window asks each waiting
 *  combatant once, so this is only ever reached by a bug; it is here so a fight can never hang. */
const RULESET_WINDOW_ANSWER_LIMIT = 24;

/**
 * The open window, answered by everybody in it who is not a person's to play.
 *
 * A fight never waits on an opponent: the same picker that plays its turn picks in its window, out
 * of the window's own menu, and passes when there is nothing there worth spending. A Game Master's
 * boss is asked through the Game Master's own decision, exactly as it is asked on its turn. The
 * window is left standing only when the one being asked is somebody's to play, and that is what the
 * client draws a React or Pass on.
 */
function answerRulesetWindows(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
): void {
  for (let answer = 0; answer < RULESET_WINDOW_ANSWER_LIMIT; answer++) {
    const window = fight.encounter.window;
    const asking = window?.waiting[0];
    if (!window || !asking) return;
    const combatant = rulesetCombatant(fight.encounter, asking);
    const controller = rulesetController(state, fight, combatant);
    if (controller === "manual") {
      // Asked with nothing worth taking (a Shield that would not stop the hit): let go for them,
      // rather than holding the fight on a prompt with only "Let it go by" on it.
      if (rulesetMenu(definition, fight.encounter, asking, true).length > 0) return;
      applyChoiceOnly(definition, state, fight, {
        actorId: asking,
        optionId: RULESET_PASS_OPTION,
        targetIds: [],
        window: window.id,
      });
      continue;
    }
    if (controller === "gm" && openRulesetWindowDecision(definition, state, fight, asking)) return;
    const menu = rulesetWindowOptions(definition, fight.encounter, asking);
    // Somebody hidden from it, and a Detect to look for them with (1.287).
    const looking = searchOption(definition, fight.encounter, asking, menu, false);
    const ranked = looking
      ? null
      : menu.length > 0
        ? pickRulesetRanked(definition, state, fight.encounter, asking, menu)
        : null;
    const picked = ranked?.candidate.action;
    const choice: RulesetCombatChoice = looking
      ? { actorId: asking, optionId: looking.id, targetIds: [], window: window.id }
      : picked?.choice
        ? { ...picked.choice, window: window.id }
        : { actorId: asking, optionId: RULESET_PASS_OPTION, targetIds: [], window: window.id };
    // A refusal inside a window would ask the same question again with the same state, so the
    // moment is let go instead and the fight moves on. It is an Engine bug rather than anybody's
    // choice, so it is said out loud: a refusal is never recorded, and this pass would otherwise
    // look exactly like the picker deciding to let it go.
    if (applyChoiceOnly(definition, state, fight, choice).refused) {
      logger.warn(
        "[game/combat:ruleset] The picker's answer to window %s for %s was refused by the rules and the moment was let go",
        window.id,
        asking,
      );
      applyChoiceOnly(definition, state, fight, {
        actorId: asking,
        optionId: RULESET_PASS_OPTION,
        targetIds: [],
        window: window.id,
      });
    } else if (ranked && choice.optionId !== RULESET_PASS_OPTION) {
      recordReasons(fight, asking, rulesetPickReasons(ranked.candidate, ranked.parts));
    }
  }
}

function advanceTurn(definition: RulesetDefinition, state: CombatDirectorState, fight: RulesetFightState): void {
  // A fight that is over has no next turn, and saying so a second time would print the outcome twice.
  if (rulesetEncounterOutcome(fight.encounter) !== "ongoing") return;
  // A window is holding this turn open, and the turn it is holding up begins when the window
  // closes. Asking for it here would be refused by the rules and write that refusal into the log.
  if (fight.encounter.window) return;
  const step = advanceRulesetTurn(definition, fight.encounter, rollerFor(fight));
  absorb(definition, state, fight, step);
  answerRulesetWindows(definition, state, fight);
  // A player's member on the ground and dying has rolled against death as the turn began and has
  // nothing else to do: the turn ends by itself rather than waiting on a click that decides nothing.
  const next = currentRulesetActor(fight.encounter);
  if (
    next &&
    next.dying &&
    !next.stable &&
    rulesetEncounterOutcome(fight.encounter) === "ongoing" &&
    !fight.encounter.window &&
    rulesetController(state, fight, next) === "manual" &&
    rulesetCombatOptions(definition, fight.encounter, next.id).every((option) => option.kind === "end-turn")
  )
    advanceTurn(definition, state, fight);
}

/**
 * One whole turn of an actor no human plays: every action it takes, and then the end of its turn.
 *
 * On a board, a candidate may be "walk here, then do this", and the walk is its own step through the
 * same menu a player's would be, so the strikes it is met with on the way land exactly as they would
 * for anybody. With nothing to do at all, it closes the distance instead, and takes the ruleset's
 * own sprint first when the ruleset has one.
 */
function playRulesetTurn(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): void {
  // Somebody on the ground gets up before anything else, when the rules offer it. Fighting from
  // the floor is worse in every ruleset that has a floor, walking is not offered until they are up,
  // and a creature that never stood would lie where it fell for the rest of the fight.
  // Out of a fallen holder first (1.389), where it was inside one: nothing else is offered in there.
  const climb = rulesetCombatOptions(definition, fight.encounter, actorId).find(
    (option) => option.id === RULESET_CLIMB_OUT_OPTION,
  );
  if (climb) applyChoice(definition, state, fight, { actorId, optionId: climb.id, targetIds: [] });
  const stand = rulesetCombatOptions(definition, fight.encounter, actorId).find(
    (option) => option.id === RULESET_STAND_OPTION,
  );
  if (stand) applyChoice(definition, state, fight, { actorId, optionId: stand.id, targetIds: [] });
  // And picks up what it dropped (1.266), with the turn's free pick-up.
  const pickUp = rulesetCombatOptions(definition, fight.encounter, actorId).find(
    (option) => option.pickUp && !option.budget,
  );
  if (pickUp) applyChoice(definition, state, fight, { actorId, optionId: pickUp.id, targetIds: [] });
  // Slips free of whatever holds it that it may (1.470): staying held never helps it.
  for (let tries = 0; tries < 12; tries += 1) {
    const slip = rulesetCombatOptions(definition, fight.encounter, actorId).find((option) => option.slip);
    if (!slip) break;
    applyChoice(definition, state, fight, { actorId, optionId: slip.id, targetIds: [] });
  }
  // A gaze it may keep its eyes from (1.268): kept from while anybody else is left to fight, looked
  // at again once its holder is all that is left.
  for (const option of rulesetCombatOptions(definition, fight.encounter, actorId)) {
    if (!option.avert) continue;
    const self = rulesetCombatant(fight.encounter, actorId);
    const others = fight.encounter.combatants.some(
      (one) => !one.defeated && one.side !== self?.side && one.id !== option.avert!.holderId,
    );
    if (option.avert.back ? !others : others)
      applyChoice(definition, state, fight, { actorId, optionId: option.id, targetIds: [] });
  }
  // Driven away or toward somebody (1.264), the walk comes first, sprinting where it may.
  const actor = rulesetCombatant(fight.encounter, actorId);
  if (actor && rulesetDrivenFrom(definition, fight.encounter, actor)) {
    if (walkTowardsTrouble(definition, state, fight, actorId, undefined, undefined, false))
      recordReasons(fight, actorId, [{ why: "driven" }]);
  }
  // A leader steadies those of its side running near it (combat AI A6).
  if (actor && !actor.routed) rallyRulesetSide(definition, fight.encounter, actor);
  // Its temperament turned by what has happened (combat AI T7).
  const turned = actor ? shiftRulesetTemperament(definition, state, fight.encounter, actor) : undefined;
  if (turned) record(fight, [{ type: "temperamentShift", actorId, ...turned }]);
  // Broken (1.746): its whole turn is getting away.
  if (actor?.routed) {
    runForTheEdge(definition, state, fight, actorId);
    advanceTurn(definition, state, fight);
    return;
  }
  // Lying in wait (1.747): it hides where it can and keeps still until its prey comes to it.
  if (actor && rulesetLiesInWait(definition, state, fight.encounter, actor)) {
    const hide = rulesetCombatOptions(definition, fight.encounter, actorId).find(
      (option) => option.kind === "standard" && rulesetStandardName(option.id) === "hide",
    );
    if (hide && !actor.hiding) applyChoice(definition, state, fight, { actorId, optionId: hide.id, targetIds: [] });
    advanceTurn(definition, state, fight);
    return;
  }
  // Everybody it could fight is hidden from it (1.287): it looks for them first.
  const looking = searchOption(
    definition,
    fight.encounter,
    actorId,
    rulesetCombatOptions(definition, fight.encounter, actorId),
    true,
  );
  if (looking) applyChoice(definition, state, fight, { actorId, optionId: looking.id, targetIds: [] });
  // A companion's orders (P7): pulling its blows when told to spare, falling back when told to
  // retreat, and never walking into the fight when told to hold or to retreat.
  const unit = [...state.party, ...state.enemies].find((one) => one.id === actorId);
  const orders = actor && unit ? rulesetOrdersFor(definition, fight.encounter, actor, unit) : undefined;
  if (orders?.spare && actor && !actor.knocksOut) {
    const pull = rulesetCombatOptions(definition, fight.encounter, actorId).find((option) => {
      const action = actor.actions.find((one) => one.id === option.id);
      return !!action?.switches && "knockOut" in action.switches;
    });
    if (pull) applyChoice(definition, state, fight, { actorId, optionId: pull.id, targetIds: [] });
  }
  if (orders?.posture === "retreat" && actor) {
    const now = rulesetCombatant(fight.encounter, actorId)!;
    const beside = fight.encounter.combatants.some(
      (one) =>
        one.side !== now.side && rulesetCombatStanding(one) && rulesetPositionOf(one) && rulesetGap(now, one) <= 1,
    );
    const away = beside ? null : rulesetRetreatCell(definition, fight.encounter, actorId);
    if (away)
      applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: away });
  }
  const stays = orders?.posture === "hold" || orders?.posture === "retreat";
  // A proud legend near its end takes to the sky and fights from there (combat AI T5).
  const aloof = !stays && retreatAloft(definition, state, fight, actorId);
  letGoOfTheDown(definition, state, fight, actorId);
  // A hungry one with its prey in hand drags it off, away from the rest (combat AI T8).
  const feeding = !stays && dragOffPrey(definition, state, fight, actorId);
  const ordered = actor && orders ? rulesetLeashOf(state, fight.encounter, actor, orders) : undefined;
  const territory =
    !ordered && actor && unit ? rulesetTerritoryLeash(definition, fight.encounter, actor, unit) : undefined;
  const leash = ordered ?? territory;
  // What it had done before this turn's choices, so a territorial one that does nothing says why.
  const seqBefore = fight.eventSeq;
  // A caster or archer caught beside an opponent gets clear before it shoots (re-test 9).
  if (!stays) getClearToShoot(definition, state, fight, actorId);
  // A companion steps up to where it can reach whoever is dropping areas on the party.
  const pressing = !stays && pressRulesetBlaster(definition, state, fight, actorId, orders);
  // Picked up where it was left when a window it opened was answered by a person.
  const earlier =
    fight.turnSoFar?.actorId === actorId &&
    fight.turnSoFar.round === fight.encounter.round &&
    fight.turnSoFar.turn === fight.encounter.turn
      ? fight.turnSoFar
      : undefined;
  // Once it has dodged, got away or hidden (1.745), it does not walk back into the fight this turn.
  let defended = earlier?.defended ?? false;
  // Whether its last blow was thrown from afar (combat AI P8), and whether it keeps its distance after.
  let shotFromAfar: "stay" | "kite" | false = earlier?.shotFromAfar ?? false;
  // Whether it has struck up close (combat AI A4): a skirmisher, or a careful one, gets out after.
  let struckClose = earlier?.struckClose ?? false;
  const remember = () => {
    fight.turnSoFar = {
      actorId,
      round: fight.encounter.round,
      turn: fight.encounter.turn,
      shotFromAfar,
      defended,
      ...(struckClose ? { struckClose } : {}),
    };
  };
  for (let action = 0; action < RULESET_TURN_ACTION_LIMIT; action++) {
    if (rulesetEncounterOutcome(fight.encounter) !== "ongoing") break;
    remember();
    // Waiting on a person's answer: the rest of the turn waits with it.
    if (fight.encounter.window) return;
    const ranked = pickRulesetRanked(definition, state, fight.encounter, actorId);
    const picked = ranked?.candidate.action ?? null;
    const idle = !picked || picked.option.kind === "end-turn";
    if (idle) {
      // A shot thrown, it steps back where nobody can walk up and strike it, still in range for the
      // next; and with somebody still in its range it does not walk in to meet them.
      if (!stays && keepAloft(definition, state, fight, actorId)) continue;
      if (shotFromAfar && !stays && keepRulesetRange(definition, state, fight, actorId, shotFromAfar === "kite")) break;
      if (struckClose && !shotFromAfar && !defended && !stays && hitAndRun(definition, state, fight, actorId)) break;
      // A caster or archer with somebody already in its range stays where it can shoot from rather
      // than walking in to a melee (re-test 2026-10-23: a wizard on guard drifted up to her fighter
      // after casting and was clubbed down).
      if (
        !struckClose &&
        !stays &&
        RULESET_KEEPS_RANGE.has(unit?.tactics?.role ?? "") &&
        rulesetHasShot(definition, fight.encounter, actorId) &&
        keepRulesetRange(definition, state, fight, actorId, false)
      )
        break;
      if (defended || stays || aloof || feeding) break;
      // Nothing to do yet with the one dropping areas on the party out of reach: it heads for them.
      if (pressing && walkTowardsTrouble(definition, state, fight, actorId, undefined, pressing)) continue;
      if (!walkTowardsTrouble(definition, state, fight, actorId, leash)) {
        // Ending a turn it did nothing with says why; ending one it already spent says nothing new.
        if (ranked && picked && action === 0)
          recordReasons(fight, actorId, rulesetPickReasons(ranked.candidate, ranked.parts));
        break;
      }
      continue;
    }
    if (picked.defensive) defended = true;
    // A standard action is only ever picked when nothing it has can hurt or help anybody from
    // anywhere it can get to. On a board that means it is out of reach, and the action is worth
    // more as a sprint towards the fight than as a dodge nobody is swinging at; the standard is
    // what is left once there is nowhere better to stand.
    // Never once it has shot from afar this turn (re-test 12): it keeps the range it shot from.
    if (
      picked.option.kind === "standard" &&
      !picked.defensive &&
      !stays &&
      !shotFromAfar &&
      walkTowardsTrouble(definition, state, fight, actorId, leash)
    )
      continue;
    // A sprint with nowhere to go is a turn spent on the spot.
    if (picked.option.kind === "standard" && rulesetStandardName(picked.option.id) === "dash") break;
    // Held at the end of its leash, a companion does not search for nobody or ready itself against
    // opponents far off (playtest re-test 9): it waits beside the one it guards.
    if (
      leash &&
      picked.option.kind === "standard" &&
      !picked.defensive &&
      (picked.option.ready || rulesetStandardName(picked.option.id) === "search")
    )
      break;
    // A getaway is taken where it stands, and then it runs (1.745).
    if (picked.defensive === "disengage") {
      if (applyChoice(definition, state, fight, picked.choice).refused) break;
      recordReasons(fight, actorId, rulesetPickReasons(ranked!.candidate, ranked!.parts));
      const away = rulesetRetreatCell(definition, fight.encounter, actorId);
      if (away)
        applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: away });
      continue;
    }
    const fromHere =
      !!picked.to &&
      !picked.defensive &&
      rulesetShootsFromHere(definition, state, fight.encounter, actorId, picked.choice, picked.to);
    const from = rulesetPositionOf(rulesetCombatant(fight.encounter, actorId));
    if (picked.to && !picked.defensive && !fromHere && !stepBefore(definition, state, fight, actorId, picked.to)) break;
    // Reckless first (1.590), as it is about to make a melee weapon attack.
    takeBeforeMelee(definition, state, fight, actorId, picked.choice);
    const afar = rulesetShotFromAfar(definition, state, fight.encounter, actorId, picked.choice);
    // A refusal here would be an Engine bug rather than a player's mistake, so the turn ends
    // instead of asking again with the same state and looping.
    if (applyChoice(definition, state, fight, picked.choice).refused) {
      // Refused from where it stood after all: it takes the walk it was picked with, and shoots.
      if (!fromHere || !stepBefore(definition, state, fight, actorId, picked.to!)) break;
      if (applyChoice(definition, state, fight, picked.choice).refused) break;
    }
    const at = rulesetPositionOf(rulesetCombatant(fight.encounter, actorId));
    const walked = from && at ? Math.max(Math.abs(at.x - from.x), Math.abs(at.y - from.y)) : undefined;
    recordReasons(fight, actorId, rulesetPickReasons(ranked!.candidate, ranked!.parts, walked));
    // Kept through what it does after the shot that is no blow of its own (a goblin's Hide), so
    // the rest of its walk still keeps its distance (re-test 9); a blow up close ends it.
    const blow = !!rulesetCombatant(fight.encounter, actorId)?.actions.find((one) => one.id === picked.choice.optionId)
      ?.damage;
    if (afar || blow) shotFromAfar = afar;
    if (blow && !afar) struckClose = true;
  }
  delete fight.turnSoFar;
  // Keeping to its ground with nobody on it (combat AI T4): said, so it is no frozen token (re-test 14).
  if (
    territory &&
    !earlier &&
    !fight.encounter.window &&
    !fight.events.some((one) => one.seq > seqBefore && "actorId" in one.event && one.event.actorId === actorId)
  )
    record(fight, [{ type: "holdsGround", actorId }]);
  advanceTurn(definition, state, fight);
}

/** Whether this choice is a blow thrown from afar (combat AI P8): one with a range and no reach of its
 *  own (a bow or a spell; a thrown dagger is a melee weapon thrown, and its thrower walks in after it),
 *  at somebody not beside it. A tactician or a genius then steps back (`kite`); anybody else who thinks at all stays
 *  where it threw from (`stay`) rather than walk into the reach it just kept out of. */
function rulesetShotFromAfar(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  choice: RulesetCombatChoice,
): "stay" | "kite" | false {
  const mind = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics?.mind;
  if (mind === undefined || mind === "mindless") return false;
  const actor = rulesetCombatant(encounter, actorId);
  const action = actor?.actions.find((one) => one.id === choice.optionId);
  const target = choice.targetIds[0] ? rulesetCombatant(encounter, choice.targetIds[0]) : undefined;
  // An area thrown at a spot away from it (a Fireball) is a shot from afar too (re-test 2026-10-23:
  // read as a blow up close, it walked the wizard in after it).
  if (actor && action && !target && choice.at && action.range && !action.reach && action.damage) {
    if (!rulesetPositionOf(actor) || rulesetGapFrom(choice.at, 1, actor) <= 1) return false;
    return mind === "tactical" || mind === "genius" ? "kite" : "stay";
  }
  if (!actor || !action || !target || target.side === actor.side) return false;
  // A block (a scout's Multiattack) shoots only when every blow of it does.
  const blows = action.sequence?.length
    ? action.sequence.map((step) => actor.actions.find((one) => one.id === step.actionId))
    : [action];
  if (!blows.every((blow) => !!blow?.range && !blow.reach && !!blow.damage)) return false;
  if (!rulesetPositionOf(actor) || !rulesetPositionOf(target) || rulesetGap(actor, target) <= 1) return false;
  // One far better up close (a knight's greatsword against its crossbow) shoots only while it cannot
  // reach, and walks in after it (playtest re-test 15): keeping its distance is for those it serves.
  // Each blow as often as it is made: a scout's two Longbow shots against its two Shortswords
  // (re-test 17).
  const melee = (part: RulesetCombatAction | undefined) => !!part?.damage && (!part.range || !!part.reach);
  const ranged = (part: RulesetCombatAction | undefined) => !!part?.damage && !!part.range && !part.reach;
  const average = (one: RulesetCombatAction, kind: (part: RulesetCombatAction | undefined) => boolean): number =>
    one.sequence?.length
      ? one.sequence.reduce((sum, step) => {
          const part = actor.actions.find((each) => each.id === step.actionId);
          return kind(part) ? sum + rulesetAverageDamage(part!.damage!) * (step.times ?? 1) : sum;
        }, 0)
      : kind(one)
        ? rulesetAverageDamage(one.damage!)
        : 0;
  // Only what it may take now: a Flame Blade it has not called up is no blade (re-test 16).
  const usable = new Set(rulesetCombatOptions(definition, encounter, actorId).map((one) => one.id));
  const now = actor.actions.filter((one) => usable.has(one.id));
  const close = Math.max(0, ...now.map((one) => average(one, melee)));
  const shot = Math.max(average(action, ranged), ...now.map((one) => average(one, ranged)));
  if (close > shot * 1.5) return false;
  return mind === "tactical" || mind === "genius" ? "kite" : "stay";
}

/**
 * Whether a shot from afar is better thrown from where it stands than after the walk it was picked
 * with (playtest re-test 9): a thinking archer with its target already in normal range does not
 * walk toward the other side first, only away from it.
 */
function rulesetShootsFromHere(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  choice: RulesetCombatChoice,
  to: { x: number; y: number },
): boolean {
  if (!rulesetShotFromAfar(definition, state, encounter, actorId, choice)) return false;
  const actor = rulesetCombatant(encounter, actorId)!;
  const action = actor.actions.find((one) => one.id === choice.optionId)!;
  const blows = action.sequence?.length
    ? action.sequence.map((step) => actor.actions.find((one) => one.id === step.actionId)!)
    : [action];
  const normal = Math.min(...blows.map((blow) => blow.range!.normal));
  const home = rulesetPositionOf(actor)!;
  const span = rulesetSpanOf(actor);
  const targets = choice.targetIds.map((id) => rulesetCombatant(encounter, id));
  if (targets.some((target) => !target || !rulesetPositionOf(target) || rulesetGapFrom(home, span, target) > normal))
    return false;
  const foes = encounter.combatants.filter(
    (one) => one.side !== actor.side && !one.object && rulesetCombatStanding(one) && rulesetPositionOf(one),
  );
  const nearest = (cell: { x: number; y: number }) => Math.min(...foes.map((foe) => rulesetGapFrom(cell, span, foe)));
  if (nearest(to) >= nearest(home)) return false;
  // In range is not in sight: a hill or a wood between them leaves the walk to a clear line
  // (re-test 10), so the shot must be one it may take at them from here.
  const option = rulesetCombatOptions(definition, encounter, actorId).find((one) => one.id === choice.optionId);
  const legal = option ? new Set(rulesetOptionTargets(definition, encounter, actorId, option)) : new Set<string>();
  return choice.targetIds.every((id) => legal.has(id));
}

/**
 * Getting clear before it shoots (playtest re-test 9): one that thinks, standing beside an opponent
 * while its blows from afar do more than its blows up close (a mage's Fire Bolt against its
 * quarterstaff), first teleports where nobody is beside it and an opponent is in the normal range of
 * one of them, by a teleport another budget pays for (Misty Step). Walking off would be struck on the
 * way, and shooting from there is at a disadvantage in most rulesets. True when it moved.
 */
/**
 * A companion out of reach of an opponent who has dropped an area on the party steps up to where it
 * can reach them (re-test round 3: a cult mage twelve squares back in the dusk threw a Fireball every
 * round and took no companion's blow in two lost fights): before it acts, to the safest cell this
 * turn's walk reaches from which it sees them within its longest blow's range. Returns whom it is
 * after while they are still out of its reach, for its idle turn to walk toward. Never under orders
 * that keep it at somebody's side (protect, or follow before the leader strikes), to hold or retreat.
 */
function pressRulesetBlaster(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
  orders: CombatOrders | undefined,
): string | undefined {
  const encounter = fight.encounter;
  const actor = rulesetCombatant(encounter, actorId);
  const home = rulesetPositionOf(actor);
  if (!actor || !home || actor.side !== "party" || !encounter.board?.grid) return undefined;
  if (
    orders?.posture === "protect" ||
    (orders?.posture === "follow" && rulesetChargeOf(state, encounter, actor, orders))
  )
    return undefined;
  const landed = new Set<string>();
  for (const { event } of fight.events) if (event.type === "area") landed.add(event.actorId);
  const blasters = encounter.combatants.filter(
    (foe) => foe.side !== actor.side && landed.has(foe.id) && rulesetCombatStanding(foe) && !!rulesetPositionOf(foe),
  );
  if (blasters.length === 0) return undefined;
  const options = rulesetCombatOptions(definition, encounter, actorId);
  const blows = options.flatMap((option) => {
    const action = actor.actions.find((one) => one.id === option.id);
    return action?.damage && !action.area && option.targets.side !== "ally" && option.targets.count > 0
      ? [{ option, action }]
      : [];
  });
  if (blows.length === 0) return undefined;
  // Already able to strike one of them from here.
  if (
    blows.some(({ option }) =>
      blasters.some((foe) => rulesetOptionTargets(definition, encounter, actorId, option).includes(foe.id)),
    )
  )
    return undefined;
  const reach = Math.max(1, ...blows.map(({ action }) => (action.reach ? 1 : (action.range?.normal ?? 1))));
  const span = rulesetSpanOf(actor);
  const blaster = blasters.reduce((best, foe) => (rulesetGap(actor, foe) < rulesetGap(actor, best) ? foe : best));
  let best: { cell: { x: number; y: number }; provokes: number; danger: number; cost: number } | null = null;
  for (const cell of rulesetWalkableCells(definition, encounter, actorId)) {
    if (rulesetGapFrom(cell, span, blaster) > reach) continue;
    if (!rulesetSees(encounter, { ...actor, x: cell.x, y: cell.y } as RulesetCombatant, blaster)) continue;
    const entry = {
      cell,
      provokes: cell.provokes.length,
      danger: rulesetDangerAt(definition, encounter, actor, cell),
      cost: cell.cost,
    };
    if (
      !best ||
      entry.provokes < best.provokes ||
      (entry.provokes === best.provokes &&
        (entry.danger < best.danger || (entry.danger === best.danger && entry.cost < best.cost)))
    )
      best = entry;
  }
  if (best) {
    applyChoice(definition, state, fight, {
      actorId,
      optionId: RULESET_MOVE_OPTION,
      targetIds: [],
      to: { x: best.cell.x, y: best.cell.y },
    });
    return undefined;
  }
  return blaster.id;
}

function getClearToShoot(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  const encounter = fight.encounter;
  const mind = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics?.mind;
  if (mind === undefined || mind === "mindless") return false;
  const actor = rulesetCombatant(encounter, actorId);
  const home = rulesetPositionOf(actor);
  if (!actor || !home || !encounter.board?.grid) return false;
  const foes = encounter.combatants.filter(
    (one) => one.side !== actor.side && !one.object && rulesetCombatStanding(one) && rulesetPositionOf(one),
  );
  const span = rulesetSpanOf(actor);
  if (foes.every((foe) => rulesetGapFrom(home, span, foe) > 1)) return false;
  const options = rulesetCombatOptions(definition, encounter, actorId);
  const blows = options.flatMap((option) => {
    const action = actor.actions.find((one) => one.id === option.id);
    return action?.damage &&
      option.targets.side !== "ally" &&
      rulesetOptionTargets(definition, encounter, actorId, option).length > 0
      ? [{ option, action, average: rulesetAverageDamage(action.damage) }]
      : [];
  });
  const ranged = blows.filter((blow) => !!blow.action.range && !blow.action.reach);
  const close = Math.max(0, ...blows.filter((blow) => !ranged.includes(blow)).map((blow) => blow.average));
  const shots = ranged.filter((blow) => blow.average > close);
  if (shots.length === 0) return false;
  const clear = (cell: { x: number; y: number }) =>
    foes.every((foe) => rulesetGapFrom(cell, span, foe) > 1) &&
    shots.some((shot) => foes.some((foe) => rulesetGapFrom(cell, span, foe) <= shot.action.range!.normal));
  for (const option of options) {
    if (!option.teleport?.cells.length || option.targets.side === "enemy") continue;
    // Paid out of what a shot is not, so the shot is still there after it.
    if (option.budget && shots.every((shot) => shot.option.budget === option.budget)) continue;
    let best: { cell: { x: number; y: number }; danger: number } | null = null;
    for (const cell of option.teleport.cells) {
      if (!clear(cell)) continue;
      const danger = rulesetDangerAt(definition, encounter, actor, cell);
      if (!best || danger < best.danger) best = { cell: { x: cell.x, y: cell.y }, danger };
    }
    if (
      best &&
      !applyChoice(definition, state, fight, { actorId, optionId: option.id, targetIds: [], at: best.cell }).refused
    )
      return true;
  }
  return false;
}

/**
 * Keeping its distance (combat AI P8): for one that kites, the safest cell it may still walk to
 * without being struck on the way, from which an opponent stays in range of one of its blows from
 * afar (in its normal range, where it has somebody there now), taken when it is safer than where it
 * stands. True when it has somebody in range, moved or not: then it stays rather than walk
 * in to meet them.
 */
function keepRulesetRange(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
  kites: boolean,
): boolean {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const home = rulesetPositionOf(actor);
  if (!actor || !home || !fight.encounter.board?.grid) return false;
  const ranged = actor.actions.filter(
    (one) => one.range && !one.reach && one.damage && rulesetActionAvailable(actor, one, fight.encounter, definition),
  );
  const normal = Math.max(0, ...ranged.map((one) => one.range!.normal));
  const long = Math.max(normal, ...ranged.map((one) => one.range!.long ?? one.range!.normal));
  if (long <= 1) return false;
  const foes = fight.encounter.combatants.filter(
    (one) => one.side !== actor.side && rulesetCombatStanding(one) && rulesetPositionOf(one),
  );
  const span = rulesetSpanOf(actor);
  const within = (cell: { x: number; y: number }, reach: number) =>
    foes.some((foe) => rulesetGapFrom(cell, span, foe) <= reach);
  if (!within(home, long)) return false;
  if (!kites || (actor.movement !== undefined && (actor.movementLeft ?? 0) < 1)) return true;
  const reach = normal > 1 && within(home, normal) ? normal : long;
  const inRange = (cell: { x: number; y: number }) => within(cell, reach);
  // The danger first, then the furthest from the nearest opponent: the edge of a walk reads as no
  // danger, and a step beyond it is safer still.
  const nearest = (cell: { x: number; y: number }) => Math.min(...foes.map((foe) => rulesetGapFrom(cell, span, foe)));
  let best: { cell: { x: number; y: number }; danger: number; away: number } | null = null;
  const here = rulesetDangerAt(definition, fight.encounter, actor, home);
  const gap = nearest(home);
  for (const cell of rulesetWalkableCells(definition, fight.encounter, actorId)) {
    // Back or across, never in: a cell nearer the other side that reads as safer (woods between, a
    // foe slowed by the ground) is still a walk into them after the shot (re-test 10).
    if (cell.provokes.length > 0 || !inRange(cell) || nearest(cell) < gap) continue;
    const danger = rulesetDangerAt(definition, fight.encounter, actor, cell);
    // Any real step down counts: much of the danger may be spells that reach it anywhere.
    if (!best ? danger > here - 0.03 : danger > best.danger) continue;
    const away = nearest(cell);
    if (best && danger === best.danger && away <= best.away) continue;
    best = { cell: { x: cell.x, y: cell.y }, danger, away };
  }
  if (best)
    applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: best.cell });
  return true;
}

/**
 * In and out again (combat AI A4): a skirmisher, or a cautious or cowardly one, that has struck up
 * close and has walk left gets away from whoever it struck rather than standing there for the
 * answer. With a Disengage it can still take (a goblin's Nimble Escape) it goes to its getaway cell;
 * without one, only to a cell it can reach without drawing a blow, beside nobody. Never a mindless
 * one. Whether it got out.
 */
function hitAndRun(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const tactics = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics;
  if (!actor || !tactics || tactics.mind === "mindless" || !fight.encounter.board?.grid) return false;
  if (tactics.role !== "skirmisher" && tactics.adjective !== "cautious" && tactics.adjective !== "cowardly")
    return false;
  if (actor.movement !== undefined && (actor.movementLeft ?? 0) < 1) return false;
  const foes = fight.encounter.combatants.filter(
    (one) => one.side !== actor.side && rulesetCombatStanding(one) && rulesetPositionOf(one),
  );
  if (!foes.some((foe) => rulesetGap(actor, foe) <= 1)) return false;
  const disengage = rulesetCombatOptions(definition, fight.encounter, actorId).find(
    (option) => rulesetDefensiveName(option) === "disengage",
  );
  if (disengage && !applyChoice(definition, state, fight, { actorId, optionId: disengage.id, targetIds: [] }).refused) {
    const away = rulesetRetreatCell(definition, fight.encounter, actorId);
    if (away)
      applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: away });
    return true;
  }
  const span = rulesetSpanOf(actor);
  let best: { cell: { x: number; y: number }; danger: number } | null = null;
  for (const cell of rulesetWalkableCells(definition, fight.encounter, actorId)) {
    if (cell.provokes.length > 0 || foes.some((foe) => rulesetGapFrom(cell, span, foe) <= 1)) continue;
    const danger = rulesetDangerAt(definition, fight.encounter, actor, cell);
    if (!best || danger < best.danger) best = { cell: { x: cell.x, y: cell.y }, danger };
  }
  if (!best) return false;
  applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: best.cell });
  return true;
}

/**
 * Up out of reach (combat AI A7): a flier with something to shoot with, on the ground at the end of
 * what it does and with an opponent about who cannot fly, takes to the air where the board has
 * levels, so those who cannot fly cannot walk up and strike it. Not a bruiser, which wants to be in
 * among them, nor a reckless one, nor a mindless one. Whether it went up.
 */
/**
 * A hungry one (combat AI T8) holding its prey where it can drag them: off, away from everybody
 * else, prey and all. Whether it has its prey, so it stays with them rather than walking at anybody.
 */
/**
 * Letting go of those it holds who are down while an opponent still stands (playtest re-test 16): a
 * crocodile with two downed in its jaws could bite nobody and readied all fight. A hold costs nothing
 * to let go of. A cruel one the game allows to strike the fallen keeps hold of them.
 */
function letGoOfTheDown(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): void {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const tactics = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics;
  if (!actor || !fight.encounter.board || (state.cruel && tactics?.adjective === "cruel")) return;
  const foe = (one: RulesetCombatant) => one.side !== actor.side && !one.object;
  const down = rulesetDragging(definition, fight.encounter, actor).ids.filter((id) => {
    const one = rulesetCombatant(fight.encounter, id);
    return !!one && foe(one) && (one.down || !rulesetCombatStanding(one));
  });
  if (down.length === 0) return;
  if (!fight.encounter.combatants.some((one) => foe(one) && rulesetCombatStanding(one) && !!rulesetPositionOf(one)))
    return;
  absorb(definition, state, fight, rulesetLetGoOfHeld(definition, fight.encounter, rollerFor(fight), actorId, down));
}

function dragOffPrey(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const tactics = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics;
  if (!actor || tactics?.adjective !== "hungry" || !fight.encounter.board?.grid) return false;
  // Only prey still fighting it: one lying down is no longer worth hauling off, and dragging it on
  // round after round kept a fight going for twenty-five rounds (re-test 15).
  const prey = rulesetDragging(definition, fight.encounter, actor).ids.filter((id) => {
    const one = rulesetCombatant(fight.encounter, id);
    return !!one && one.side !== actor.side && !one.down && rulesetCombatStanding(one);
  });
  if (prey.length === 0) return false;
  tactics.targetId = prey[0];
  // Already where none of the rest can walk up to it this turn: it stays and feeds there, rather
  // than going round in circles as they shift about.
  const perCell = definition.combat?.distance?.perCell;
  const rest = fight.encounter.combatants.filter(
    (one) =>
      one.side !== actor.side && !prey.includes(one.id) && rulesetCombatStanding(one) && !!rulesetPositionOf(one),
  );
  const safe = rest.every((one) => rulesetGap(actor, one) > (perCell ? rulesetInCells(one.speed, perCell) : 6) + 1);
  if (safe) return true;
  const away = rulesetRetreatCell(definition, fight.encounter, actorId, prey);
  if (away) applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to: away });
  return true;
}

/**
 * An arrogant legend (combat AI T5) with a fly speed, below a quarter of its health: up into the sky
 * if it is not there already. Whether it is aloft, so it does not come down to walk at anybody.
 */
function retreatAloft(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const tactics = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics;
  const grid = fight.encounter.board?.grid;
  const combat = definition.combat;
  if (!actor || !tactics || !grid || !combat || !actor.speeds?.fly) return false;
  if (tactics.adjective !== "arrogant" && tactics.shiftedFrom !== "arrogant") return false;
  const legendary =
    actor.signature !== undefined ||
    (actor.block?.legendaryResistance ?? 0) > 0 ||
    actor.actions.some((one) => one.signature !== undefined);
  const health = rulesetCombatHealth(definition, combat, actor);
  if (!legendary || health.value >= health.max / 4) return false;
  if (rulesetAirborne(grid, actor)) return true;
  const up = rulesetCombatOptions(definition, fight.encounter, actorId).find(
    (option) => option.id === RULESET_FLY_UP_OPTION,
  );
  return !!up && !applyChoice(definition, state, fight, { actorId, optionId: up.id, targetIds: [] }).refused;
}

function keepAloft(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const tactics = [...state.party, ...state.enemies].find((one) => one.id === actorId)?.tactics;
  const grid = fight.encounter.board?.grid;
  if (!actor || !tactics || !grid || !actor.speeds?.fly || rulesetAirborne(grid, actor)) return false;
  if (tactics.mind === "mindless" || tactics.role === "bruiser" || tactics.adjective === "reckless") return false;
  const shoots = actor.actions.some(
    (one) => one.range && !one.reach && one.damage && rulesetActionAvailable(actor, one, fight.encounter, definition),
  );
  if (!shoots) return false;
  const grounded = fight.encounter.combatants.some(
    (one) => one.side !== actor.side && rulesetCombatStanding(one) && !!rulesetPositionOf(one) && !one.speeds?.fly,
  );
  if (!grounded) return false;
  const up = rulesetCombatOptions(definition, fight.encounter, actorId).find(
    (option) => option.id === RULESET_FLY_UP_OPTION,
  );
  if (!up) return false;
  return !applyChoice(definition, state, fight, { actorId, optionId: up.id, targetIds: [] }).refused;
}

/**
 * Whether an ambusher (a `behavior.ambush`, 1.747) still lies in wait: until an opponent stands where
 * it could strike them this turn, walking first, or it has been hurt. Once it springs it never waits
 * again. Never a mindless one, and never one the Game Master or a player decides for.
 */
function rulesetLiesInWait(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): boolean {
  const combat = definition.combat;
  const unit = [...state.party, ...state.enemies].find((one) => one.id === actor.id);
  if (!combat || !unit?.tactics || unit.tactics.sprung || unit.tactics.mind === "mindless") return false;
  if (!rulesetCombatantBehavior(definition, actor)?.ambush) return false;
  const at = rulesetPositionOf(actor);
  const health = rulesetCombatHealth(definition, combat, actor);
  const perCell = combat.distance?.perCell;
  const walks = perCell ? rulesetInCells(actor.speed, perCell) : 6;
  const reach = Math.max(
    1,
    ...actor.actions
      .filter((action) => action.damage || action.applies?.length)
      .map((action) => (action.range ? (action.range.long ?? action.range.normal) : (action.reach ?? 1))),
  );
  const prey =
    !at ||
    encounter.combatants.some(
      (one) =>
        one.side !== actor.side &&
        rulesetCombatStanding(one) &&
        !!rulesetPositionOf(one) &&
        rulesetGapFrom(at, rulesetSpanOf(actor), one) <= reach + walks,
    );
  if (prey || actor.harmedBy !== undefined || health.value < health.max) {
    unit.tactics.sprung = true;
    return false;
  }
  return true;
}

/**
 * A broken creature's turn (1.746): it gets away from an opponent beside it, else dashes, and runs
 * for the nearest edge of the board, where it is out of the fight as its next turn starts.
 */
function runForTheEdge(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): void {
  const standard = (name: string) =>
    rulesetCombatOptions(definition, fight.encounter, actorId).find(
      (option) => option.kind === "standard" && rulesetStandardName(option.id) === name,
    );
  const actor = rulesetCombatant(fight.encounter, actorId);
  if (!actor) return;
  const beside = fight.encounter.combatants.some(
    (one) =>
      one.side !== actor.side &&
      rulesetCombatStanding(one) &&
      !!rulesetPositionOf(one) &&
      !!rulesetPositionOf(actor) &&
      rulesetGap(one, actor) <= 1,
  );
  const first = (beside ? standard("disengage") : undefined) ?? standard("dash");
  if (first) applyChoice(definition, state, fight, { actorId, optionId: first.id, targetIds: [] });
  for (let leg = 0; leg < 2; leg++) {
    const now = rulesetCombatant(fight.encounter, actorId);
    if (!now || rulesetAtBoardEdge(fight.encounter, now)) break;
    const to = rulesetEdgeCell(definition, fight.encounter, actorId);
    if (!to) break;
    if (applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to }).refused)
      break;
  }
}

/** The cell a running creature may walk to nearest the board's edge (1.746), furthest from its
 *  opponents among those as near: null when none is nearer the edge than where it stands. */
function rulesetEdgeCell(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
): { x: number; y: number } | null {
  const actor = rulesetCombatant(encounter, actorId);
  const from = rulesetPositionOf(actor);
  const grid = encounter.board?.grid;
  if (!actor || !from || !grid) return null;
  const span = rulesetSpanOf(actor);
  const edge = (cell: { x: number; y: number }) =>
    Math.min(cell.x, cell.y, grid.width - (cell.x + span), grid.height - (cell.y + span));
  const foes = encounter.combatants.filter(
    (one) => one.side !== actor.side && rulesetCombatStanding(one) && rulesetPositionOf(one),
  );
  const away = (cell: { x: number; y: number }) =>
    foes.length === 0 ? 0 : Math.min(...foes.map((foe) => rulesetGapFrom(cell, span, foe)));
  let best: { cell: { x: number; y: number }; edge: number; away: number } | null = null;
  const here = edge(from);
  for (const cell of rulesetWalkableCells(definition, encounter, actorId)) {
    const near = edge(cell);
    if (near >= here) continue;
    const far = away(cell);
    if (!best || near < best.edge || (near === best.edge && far > best.away))
      best = { cell: { x: cell.x, y: cell.y }, edge: near, away: far };
  }
  return best?.cell ?? null;
}

/**
 * A free trait of its own taken before its first attack of the turn (1.590), when what it is about
 * to do is a melee weapon attack: a berserker's or a minotaur's Reckless, landing on itself.
 */
function takeBeforeMelee(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
  choice: RulesetCombatChoice,
): void {
  const actor = rulesetCombatant(fight.encounter, actorId);
  const blow = actor?.actions.find((one) => one.id === choice.optionId);
  const target = choice.targetIds[0] ? rulesetCombatant(fight.encounter, choice.targetIds[0]) : undefined;
  if (!actor || !blow || !target || blow.toHit === undefined || blow.catalog || blow.area) return;
  if ((actor.flags.attacks ?? 0) > 0) return;
  if (rulesetBlowKind(fight.encounter, actor, target, blow) !== "melee") return;
  for (const option of rulesetCombatOptions(definition, fight.encounter, actorId)) {
    const own = actor.actions.find((one) => one.id === option.id);
    if (!own?.free || !own.beforeAttack || own.targets.side !== "self") continue;
    applyChoice(definition, state, fight, { actorId, optionId: option.id, targetIds: [actorId] });
  }
}

/**
 * The option that looks for whoever hides from this actor (1.287), when it should: on its turn the
 * Search, once every opponent still standing is hidden from it; between turns a Detect, once any is.
 */
function searchOption(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  menu: RulesetCombatOption[],
  everyone: boolean,
): RulesetCombatOption | undefined {
  const actor = rulesetCombatant(encounter, actorId);
  if (!actor || !definition.combat?.hiding) return undefined;
  const foes = encounter.combatants.filter((one) => one.side !== actor.side && rulesetCombatStanding(one));
  const hidden = foes.filter((one) => rulesetHiddenFrom(actor, one));
  if (hidden.length === 0 || (everyone && hidden.length < foes.length)) return undefined;
  return menu.find((option) =>
    option.signature
      ? !everyone && !!actor.actions.find((action) => action.id === option.id)?.search
      : everyone && option.kind === "standard" && rulesetStandardName(option.id) === "search",
  );
}

/** The walk a candidate does before it acts, refused exactly as a player's would be. */
function stepBefore(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
  to: { x: number; y: number },
): boolean {
  const moved = applyChoice(definition, state, fight, { actorId, optionId: RULESET_MOVE_OPTION, targetIds: [], to });
  if (moved.refused) return false;
  // A strike on the way may have dropped it, or left it short of where it meant to be, and then the
  // thing it meant to do from there is no longer the thing it can do.
  const after = rulesetCombatant(fight.encounter, actorId);
  return !!after && rulesetCombatStanding(after) && after.x === to.x && after.y === to.y;
}

/** Nothing in reach: close the distance, sprinting first when the ruleset has a sprint and the
 *  actor has nothing else to spend its turn on. False when there is nowhere better to stand, which
 *  is what ends the turn rather than shuffling on the spot. */
function walkTowardsTrouble(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
  leash?: RulesetLeash,
  /** Toward this one only, not the nearest opponent. */
  toward?: string,
  /** Whether to say why on the debug log: it closed on the nearest opponent, or on `toward`. */
  explain = true,
): boolean {
  if (!fight.encounter.board?.grid) return false;
  const actor = rulesetCombatant(fight.encounter, actorId);
  if (!actor || (actor.movementLeft ?? 0) < 1) return false;
  const closing = rulesetClosingMove(definition, fight.encounter, actorId, leash, toward);
  if (!closing) return false;
  const walked = (sprinted: boolean): boolean => {
    if (explain) {
      const after = rulesetCombatant(fight.encounter, actorId);
      const nearest = toward ?? (after ? rulesetApproachedOpponent(fight.encounter, after)?.id : undefined);
      recordReasons(fight, actorId, [
        toward
          ? { why: "pressCaster", targetId: toward }
          : { why: "approach", ...(nearest ? { targetId: nearest } : {}), ...(sprinted ? { sprinted: true } : {}) },
      ]);
    }
    return true;
  };
  // A walk that stops with movement to spare (at the end of a guard's leash, or already beside the
  // opponent) gains nothing from a sprint, which would only be the turn's action thrown away.
  const sprint =
    (definition.combat?.standard ?? []).includes("dash") &&
    !actor.flags.dashed &&
    (closing.walked === undefined || closing.walked >= (actor.movementLeft ?? 0));
  if (sprint) {
    const sprinted = applyChoice(definition, state, fight, {
      actorId,
      optionId: "standard:dash",
      targetIds: [],
    });
    // A sprint the rules refused costs nothing: the walk below happens either way.
    if (!sprinted.refused) {
      const again = rulesetClosingMove(definition, fight.encounter, actorId, leash, toward);
      return !!again && !applyChoice(definition, state, fight, again.choice).refused && walked(true);
    }
  }
  return !applyChoice(definition, state, fight, closing.choice).refused && walked(false);
}

/**
 * The opponent its walk closed on, for a reason that names whom it walked toward: the one nearest by
 * the walk still left to reach any cell they fill, which is how the closing move chose its cell, so a
 * wall between them or a big foe's reach counts as it did there.
 */
function rulesetApproachedOpponent(
  encounter: RulesetEncounterState,
  actor: RulesetCombatant,
): RulesetCombatant | undefined {
  const grid = encounter.board?.grid;
  if (!grid || !rulesetPositionOf(actor)) return undefined;
  const mine = rulesetFootprint(actor);
  let best: { one: RulesetCombatant; gap: number } | undefined;
  for (const one of encounter.combatants) {
    if (one.side === actor.side || !rulesetPositionOf(one) || !rulesetCombatStanding(one)) continue;
    const walking = rulesetWalkingDistances(grid, rulesetFootprint(one), actor);
    const gap = Math.min(...mine.map((cell) => walking.get(`${cell.x},${cell.y}`) ?? Infinity));
    if (gap < (best?.gap ?? Infinity)) best = { one, gap };
  }
  return best?.one;
}

// ── The Game Master's window ──

const windowKind = (kind: RulesetCombatOption["kind"]): CombatDecisionOption["kind"] =>
  kind === "ability"
    ? "skill"
    : kind === "standard"
      ? "defend"
      : kind === "end-turn"
        ? "wait"
        : kind === "move"
          ? "move"
          : "attack";

/** How many candidates one boss decision may hold. A positioned turn enumerates every cell the
 *  opponent could walk to against every option from there, which is a list no model should be asked
 *  to read: the best by the picker's own score, and the end of the turn beside them.
 *  ponytail: a fixed number, cut by score. The upgrade path is to group them by what they do rather
 *  than by what they score, which needs a summariser this slice does not have. */
const RULESET_WINDOW_CANDIDATE_LIMIT = 24;

/** One `CombatDecisionOption` per candidate, carrying the ruleset's own id, targets and label so the
 *  answer the Game Master picks resolves straight back through the menu. A positioned candidate may
 *  be "walk here, then do this", and carries the cell it walks to and the cell a shape is aimed at. */
function windowOptions(
  definition: RulesetDefinition,
  encounter: RulesetEncounterState,
  actorId: string,
  /** A window's own menu, when the decision is an answer to one rather than a whole turn. */
  menu?: RulesetCombatOption[],
): CombatDecisionOption[] {
  const candidates = menu
    ? rulesetCandidatesFrom(definition, encounter, actorId, null, menu)
    : withRulesetPlanMemo(() => rulesetCandidates(definition, encounter, actorId, true));
  const worth = (candidate: (typeof candidates)[number]) =>
    (candidate.damage ?? 0) + (candidate.healing ?? 0) + (candidate.support ?? 0) + (candidate.setup ?? 0);
  const ending = candidates.filter((candidate) => candidate.action.option.kind === "end-turn");
  const rest = candidates
    .filter((candidate) => candidate.action.option.kind !== "end-turn")
    .sort((a, b) => worth(b) - worth(a))
    .slice(0, Math.max(0, RULESET_WINDOW_CANDIDATE_LIMIT - ending.length));
  return [...rest, ...ending].map((candidate, index) => decisionOptionOf(candidate, actorId, String(index)));
}

/** One candidate as a Game Master's decision offers it. */
function decisionOptionOf(
  candidate: CombatAiCandidate<RulesetCandidate>,
  actorId: string,
  id: string,
): CombatDecisionOption {
  return {
    id,
    kind: windowKind(candidate.action.option.kind),
    actorId,
    ...(candidate.action.targetId ? { targetId: candidate.action.targetId } : {}),
    mpCost: 0,
    legendaryCost: 0,
    optionId: candidate.action.option.id,
    targetIds: [...candidate.action.choice.targetIds],
    label: candidate.action.option.label,
    ...(candidate.action.to ? { to: { ...candidate.action.to } } : {}),
    ...(candidate.action.choice.at ? { at: { ...candidate.action.choice.at } } : {}),
    // Which pool this way of paying spends. Two entries of the same ability differ only by this and
    // by the label that names it, so dropping it would offer a choice and then ignore it. A boss
    // whose bestiary entry carries a sheet pays out of its own pools, and is cast as big as it chose.
    ...(candidate.action.choice.payWith !== undefined ? { payWith: candidate.action.choice.payWith } : {}),
    ...(candidate.action.choice.style !== undefined ? { style: candidate.action.choice.style } : {}),
    ...(candidate.action.choice.mode !== undefined ? { mode: candidate.action.choice.mode } : {}),
    // A zone moved or turned keeps where it goes, and an option that needs an alteration keeps it:
    // without them the rules refuse the choice and the boss loses its turn.
    ...(candidate.action.choice.to &&
    (candidate.action.option.id.startsWith(RULESET_ZONE_OPTION_PREFIX) ||
      candidate.action.option.id.startsWith(RULESET_ZONE_TURN_OPTION_PREFIX))
      ? { zoneTo: { ...candidate.action.choice.to } }
      : {}),
    ...(candidate.action.choice.alters?.length ? { alters: [...candidate.action.choice.alters] } : {}),
  };
}

/**
 * The Engine's own top picks for a Game Master's turn (re-test 9 follow-up): its tactics' best three,
 * each marked on the decision's option with a short reason, and added to the options where the
 * shortlist left it out. The Game Master still chooses; this is what this Engine would have done.
 */
function suggestRulesetOptions(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  encounter: RulesetEncounterState,
  actorId: string,
  options: CombatDecisionOption[],
  /** A window's own menu, when the decision is an answer to one rather than a whole turn. */
  menu?: RulesetCombatOption[],
): CombatDecisionOption[] {
  const ranked = rankRulesetChoices(definition, state, encounter, actorId, RULESET_SUGGESTION_COUNT, menu);
  const same = (option: CombatDecisionOption, candidate: CombatAiCandidate<RulesetCandidate>) => {
    const made = decisionOptionOf(candidate, actorId, option.id);
    return (
      JSON.stringify({ ...made, kind: undefined }) ===
      JSON.stringify({ ...option, kind: undefined, suggested: undefined })
    );
  };
  const out = options.map((option) => ({ ...option }));
  ranked.forEach(({ candidate, parts }, rank) => {
    let option = out.find((one) => same(one, candidate));
    if (!option) {
      option = decisionOptionOf(candidate, actorId, String(out.length));
      out.push(option);
    }
    option.suggested = { rank: rank + 1, reason: rulesetSuggestionReason(encounter, candidate, parts) };
  });
  return out;
}

/** How many of the Engine's own picks a Game Master is shown. */
const RULESET_SUGGESTION_COUNT = 3;

/** Why the Engine would pick this, in a few words: the biggest parts of its score, largest first. */
function rulesetSuggestionReason(
  encounter: RulesetEncounterState,
  candidate: CombatAiCandidate<RulesetCandidate>,
  parts: CombatAiScoreParts,
): string {
  const nameOf = (id: string | undefined) => (id ? (rulesetCombatant(encounter, id)?.name ?? id) : "");
  const target = nameOf(candidate.targetId);
  const option = candidate.action.option;
  const said: Record<keyof CombatAiScoreParts, () => string> = {
    damage: () => {
      const average = option.forecast?.averageDamage;
      const chance = option.forecast?.hitChance;
      return `${(candidate.damage ?? 0) >= 0.5 ? "heavy" : (candidate.damage ?? 0) >= 0.2 ? "solid" : "some"} damage${
        target ? ` to ${target}` : ""
      }${average !== undefined ? ` (about ${Math.round(average)} damage${chance !== undefined ? `, ${Math.round(chance * 100)}% to hit` : ""})` : ""}`;
    },
    finish: () => `likely takes ${target || "its target"} out of the fight`,
    healing: () => `heals ${target || "a friend"}`,
    support: () => `helps ${target || "its side"}`,
    setup: () => `sets up what comes next (a condition, a broken concentration, a better position)`,
    risk: () => "puts itself in danger",
    cost: () =>
      `spends ${option.cost?.length ? option.cost.map((one) => `${one.amount} ${one.label}`).join(", ") : "a limited use"}`,
    protection: () => "stands up for a friend under attack",
    coordination: () => `joins its side's attack${target ? ` on ${target}` : ""}`,
    focus: () => `${target || "its target"} is the one it most wants down`,
  };
  const reasons = (Object.entries(parts) as Array<[keyof CombatAiScoreParts, number]>)
    .filter(([, part]) => Math.abs(part) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([key]) => said[key]());
  if (candidate.action.to) reasons.push(`after walking to ${candidate.action.to.x},${candidate.action.to.y}`);
  if (reasons.length) return reasons.join("; ");
  return option.kind === "end-turn" ? "nothing offered is worth what it costs right now" : "the best of what is left";
}

/**
 * The Game Master's decision over a ruleset WINDOW's menu rather than a turn's. Its boss is asked
 * whether to spend out of turn exactly as it is asked what to do on one, and letting the moment go
 * by is one of the answers rather than a timeout.
 *
 * False when there is nothing to ask about, and the caller lets the moment go by without spending a
 * model call on a menu with only a pass on it.
 */
function openRulesetWindowDecision(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  // A decision is already standing: the fight waits on that one rather than stacking another.
  if (state.window) return true;
  const menu = rulesetWindowOptions(definition, fight.encounter, actorId);
  if (menu.length === 0) return false;
  // Letting the moment go by is one of the candidates, so it is one of the answers.
  const shortlist = windowOptions(definition, fight.encounter, actorId, menu);
  if (shortlist.length <= 1) return false;
  const options = suggestRulesetOptions(definition, state, fight.encounter, actorId, shortlist, menu);
  state.choices = options;
  state.window = {
    id: `${state.id}:${++state.serial}`,
    kind: "ordinary",
    actorId,
    controller: "gm",
    options,
  };
  state.stage = "decision";
  return true;
}

function openRulesetWindow(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): boolean {
  const shortlist = windowOptions(definition, fight.encounter, actorId);
  // Nothing but the end of the turn left: there is no decision worth a model call.
  if (shortlist.length <= 1) return false;
  const options = suggestRulesetOptions(definition, state, fight.encounter, actorId, shortlist);
  state.choices = options;
  state.window = {
    id: `${state.id}:${++state.serial}`,
    kind: "ordinary",
    actorId,
    controller: "gm",
    options,
  };
  state.stage = "decision";
  return true;
}

function closeWindow(state: CombatDirectorState): void {
  state.window = undefined;
  state.choices = [];
}

/** After an opponent the Game Master plays has acted: another decision while it still has one, and
 *  otherwise the end of its turn. */
function continueBossTurn(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  fight: RulesetFightState,
  actorId: string,
): void {
  if (
    rulesetEncounterOutcome(fight.encounter) === "ongoing" &&
    currentRulesetActor(fight.encounter)?.id === actorId &&
    openRulesetWindow(definition, state, fight, actorId)
  ) {
    return;
  }
  if (currentRulesetActor(fight.encounter)?.id === actorId) advanceTurn(definition, state, fight);
}

/**
 * Held Ground let go in a running fight (1.330), as the story says the year has turned: the felled
 * die (or go down), the marks come due, and the log tells the Game Master. Refused when the battle
 * is not a ruleset's, is over, or is not on Held Ground.
 */
export function releaseRulesetHeldGround(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  release: RulesetHeldGroundRelease = {},
): RulesetCommandResult {
  const fight = fightOf(state);
  if (!fight) return refuse("This battle is not resolved by a ruleset.", "ruleset_combat_not_a_ruleset_fight");
  if (!definition.combat)
    return refuse("This game's ruleset no longer resolves its own fights.", "ruleset_combat_no_block");
  if (state.outcome) return refuse("Battle already finished.", "ruleset_combat_encounter-over");
  if (!fight.encounter.heldGround) return refuse("This battle is not on Held Ground.", "ruleset_combat_not_held");
  absorb(definition, state, fight, rulesetReleaseHeldGround(definition, fight.encounter, rollerFor(fight), release));
  return settled(state);
}

// ── Commands ──
// ── Commands ──

/**
 * One command against a ruleset fight. Never throws: a refusal changes nothing, bumps nothing and
 * comes back with the resolver's own reason in a stable code, so a client can say why.
 *
 * `source` is who the answer came from, exactly as the other styles record it.
 */
export function commandRulesetCombatDirector(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  command: DirectedCommand,
  source: "gm" | "ai" | "manual" | "fallback" = "manual",
): RulesetCommandResult {
  // The option and picker loops read the same sheets thousands of times in one command, and no build
  // is written to during it: the fight's creation and the creature-sheet hold run outside it.
  return withRulesetSheetEvaluationCache(() => runRulesetCommand(definition, state, command, source));
}

function runRulesetCommand(
  definition: RulesetDefinition,
  state: CombatDirectorState,
  command: DirectedCommand,
  source: "gm" | "ai" | "manual" | "fallback",
): RulesetCommandResult {
  const fight = fightOf(state);
  if (!fight) return refuse("This battle is not resolved by a ruleset.", "ruleset_combat_not_a_ruleset_fight");
  if (!definition.combat)
    return refuse("This game's ruleset no longer resolves its own fights.", "ruleset_combat_no_block");
  if (state.outcome) return refuse("Battle already finished.", "ruleset_combat_encounter-over");

  if (command.type === "begin" || command.type === "classic" || command.type === "tactical") {
    return refuse("Action does not match this combat mode.", "ruleset_combat_wrong_style");
  }

  if (command.type === "flee") {
    state.outcome = "flee";
    fight.encounter = settleRulesetFledFight(definition, fight.encounter, rollerFor(fight)).state;
    return settled(state);
  }

  // Given up to opponents who are all honourable (combat AI T6): they take the party alive.
  if (command.type === "yield") {
    if (state.window) return refuse("Resolve the open decision first.", "ruleset_combat_decision_open");
    if (!rulesetPartyMayYield(state, fight.encounter))
      return refuse("Only honourable opponents accept a surrender.", "ruleset_combat_no_yield");
    state.outcome = "defeat";
    state.yielded = true;
    // Said in the fight's own log, so a surrender never reads as a wipe (re-test 14).
    record(fight, [{ type: "outcome", outcome: "defeat", yielded: true }]);
    return settled(state);
  }

  if (command.type === "control") {
    const combatant = rulesetCombatant(fight.encounter, command.unitId);
    if (!combatant || combatant.side !== "party") {
      return refuse("Only a party member has a controller.", "ruleset_combat_unknown-actor");
    }
    if (state.window) return refuse("Resolve the open decision first.", "ruleset_combat_decision_open");
    fight.controllers[combatant.id] = command.controller;
    // The party panel reads the unit's own controller: said at once, not at the next turn.
    syncRulesetCombatants(definition, state);
    return settled(state);
  }

  if (command.type === "orders") {
    const unit = state.party.find((one) => one.id === command.unitId);
    const combatant = rulesetCombatant(fight.encounter, command.unitId);
    if (!unit || !combatant || combatant.side !== "party")
      return refuse("Only a companion takes orders.", "ruleset_combat_unknown-actor");
    const charge = command.orders?.protectId;
    if (charge !== undefined) {
      const one = rulesetCombatant(fight.encounter, charge);
      if (!one || one.side !== "party" || one.id === combatant.id)
        return refuse("A companion protects somebody else of the party.", "ruleset_combat_unknown-actor");
    }
    if (command.orders) unit.orders = command.orders;
    else delete unit.orders;
    return settled(state);
  }

  const actor = currentRulesetActor(fight.encounter);
  if (!actor) return refuse("Nobody is on turn.", "ruleset_combat_unknown-actor");
  const controller = rulesetController(state, fight, actor);

  if (command.type === "ruleset") {
    if (state.window) return refuse("Resolve the open decision first.", "ruleset_combat_decision_open");
    // While a window holds the fight open the command belongs to whoever it is asking, not to the
    // actor whose turn is standing still behind it.
    const held = fight.encounter.window;
    const acting = held ? rulesetCombatant(fight.encounter, held.waiting[0] ?? "") : actor;
    if (!acting) return refuse("Nobody is being asked.", "ruleset_combat_unknown-actor");
    if (rulesetController(state, fight, acting) !== "manual") {
      return refuse(
        held ? "This window is not yours to answer." : "This turn is not yours to play.",
        "ruleset_combat_not-your-turn",
      );
    }
    const step = applyChoice(definition, state, fight, {
      actorId: acting.id,
      optionId: command.optionId,
      targetIds: command.targetIds,
      ...(held ? { window: held.id } : {}),
      ...(command.payWith !== undefined ? { payWith: command.payWith } : {}),
      ...(command.style !== undefined ? { style: command.style } : {}),
      ...(command.mode !== undefined ? { mode: command.mode } : {}),
      ...(command.to ? { to: command.to } : {}),
      ...(command.at ? { at: command.at } : {}),
      ...(command.toward ? { toward: command.toward } : {}),
      ...(command.side ? { side: command.side } : {}),
      ...(command.ring !== undefined ? { ring: command.ring } : {}),
      ...(command.also?.length ? { also: command.also } : {}),
      ...(command.wall ? { wall: command.wall } : {}),
      ...(command.dispel ? { dispel: command.dispel } : {}),
      ...(command.cut ? { cut: command.cut } : {}),
      ...(command.storesIn ? { storesIn: command.storesIn } : {}),
      ...(command.ends?.length ? { ends: command.ends } : {}),
      ...(command.carries?.length ? { carries: command.carries } : {}),
      ...(command.designates?.length ? { designates: command.designates } : {}),
      ...(command.kinds?.length ? { kinds: command.kinds } : {}),
      ...(command.amount !== undefined ? { amount: command.amount } : {}),
      ...(command.rises !== undefined ? { rises: command.rises } : {}),
      ...(command.alters?.length ? { alters: command.alters } : {}),
      ...(command.spares ? { spares: command.spares } : {}),
      ...(command.heightens ? { heightens: command.heightens } : {}),
    });
    if (step.refused && step.refused.type === "refused") {
      return refuse(rulesetRefusalMessage(step.refused.reason), `ruleset_combat_${step.refused.reason}`);
    }
    return settled(state);
  }

  if (command.type === "choose" || command.type === "fallback") {
    const open = state.window;
    if (!open) return refuse("No decision is pending.", "ruleset_combat_no_decision");
    const chosen =
      command.type === "choose" ? open.options.find((option) => option.id === command.candidateId) : undefined;
    if (command.type === "choose" && !chosen) {
      return refuse("Unknown decision option.", "ruleset_combat_unknown-option");
    }
    const actorId = open.actorId;
    closeWindow(state);
    // A decision opened over a ruleset WINDOW is answered into that window, not onto a turn: the
    // one being asked is not the one acting, and there is no turn of theirs to go on with.
    const held = fight.encounter.window;
    if (held && held.waiting[0] === actorId) {
      const menu = rulesetWindowOptions(definition, fight.encounter, actorId);
      const answer =
        chosen && chosen.optionId && chosen.optionId !== RULESET_PASS_OPTION
          ? {
              actorId,
              optionId: chosen.optionId,
              targetIds: [...(chosen.targetIds ?? [])],
              // Everything the picked option came with. An area is aimed at a CELL, and dropping
              // it would have the rules refuse the answer and the moment let go instead. The pool
              // is carried for the same reason: a boss with a sheet pays out of one.
              ...(chosen.at ? { at: { ...chosen.at } } : {}),
              ...(chosen.payWith !== undefined ? { payWith: chosen.payWith } : {}),
              ...(chosen.zoneTo ? { to: { ...chosen.zoneTo } } : {}),
              ...(chosen.alters?.length ? { alters: [...chosen.alters] } : {}),
            }
          : chosen
            ? null
            : // Nothing usable came back, so the local picker answers instead, exactly as it does
              // for a turn: the model call is spent either way.
              (pickRulesetChoice(definition, state, fight.encounter, actorId, menu)?.choice ?? null);
      const letGo = { actorId, optionId: RULESET_PASS_OPTION, targetIds: [], window: held.id };
      if (!answer || applyChoiceOnly(definition, state, fight, { ...answer, window: held.id }).refused) {
        applyChoiceOnly(definition, state, fight, letGo);
      }
      answerRulesetWindows(definition, state, fight);
      return settled(state);
    }
    const picked = chosen ? null : pickRulesetChoice(definition, state, fight.encounter, actorId);
    const walkTo = chosen ? chosen.to : picked?.to;
    const choice: RulesetCombatChoice | null = chosen
      ? {
          actorId,
          optionId: chosen.optionId ?? "end-turn",
          targetIds: [...(chosen.targetIds ?? [])],
          ...(chosen.payWith !== undefined ? { payWith: chosen.payWith } : {}),
          ...(chosen.style !== undefined ? { style: chosen.style } : {}),
          ...(chosen.mode !== undefined ? { mode: chosen.mode } : {}),
          ...(chosen.at ? { at: { ...chosen.at } } : {}),
          ...(chosen.zoneTo ? { to: { ...chosen.zoneTo } } : {}),
          ...(chosen.alters?.length ? { alters: [...chosen.alters] } : {}),
        }
      : // The local picker is the fallback, so a Game Master that answered nothing usable costs the
        // fight nothing but the model call.
        (picked?.choice ?? null);
    // A candidate that walks first walks first, exactly as the local picker's would: one step, one
    // refusal of its own, and the strikes on the way land before the thing it walked to do.
    if (choice && walkTo && !stepBefore(definition, state, fight, actorId, walkTo)) {
      if (currentRulesetActor(fight.encounter)?.id === actorId) advanceTurn(definition, state, fight);
      return settled(state);
    }
    // The menu's own "end turn" IS the end of the turn, exactly as the local picker reads it. Asking
    // again would reopen the same window with the same list, and the fight would stand on this actor
    // for as long as the answer stayed the same.
    if (!choice || choice.optionId === "end-turn") {
      if (currentRulesetActor(fight.encounter)?.id === actorId) advanceTurn(definition, state, fight);
      return settled(state);
    }
    const step = applyChoice(definition, state, fight, choice);
    if (step.refused) {
      logger.warn(
        "[game/combat:ruleset] A %s decision for %s was refused by the rules and the turn was ended",
        source,
        actorId,
      );
      if (currentRulesetActor(fight.encounter)?.id === actorId) advanceTurn(definition, state, fight);
      return settled(state);
    }
    continueBossTurn(definition, state, fight, actorId);
    return settled(state);
  }

  // `continue`: one whole turn of whoever the player is not playing.
  if (state.window) return { ok: true };
  // A window comes first: the turn behind it is standing still, and everybody in it who is not a
  // person's to play answers here. One that is theirs is left for them to answer.
  if (fight.encounter.window) {
    answerRulesetWindows(definition, state, fight);
    // Still standing means it is somebody's own to answer, and no amount of asking again moves it.
    return settled(state);
  }
  if (controller === "manual") return settled(state);
  if (controller === "gm" && openRulesetWindow(definition, state, fight, actor.id)) return { ok: true };
  playRulesetTurn(definition, state, fight, actor.id);
  return settled(state);
}

/** The resolver's own reason, in a sentence a player can read. The code beside it is what a client
 *  keys off; this is only what it says when it has nothing better. */
function rulesetRefusalMessage(reason: string): string {
  const said: Record<string, string> = {
    "encounter-over": "This fight is already over.",
    "unknown-actor": "That combatant is not in this fight.",
    "not-your-turn": "It is not their turn.",
    "unknown-option": "That is not on the menu.",
    "cannot-act": "They cannot act right now.",
    down: "They are down.",
    surprised: "They are surprised: this first turn can only be ended.",
    "bad-target": "That is not a legal target for this.",
    "no-budget": "They have nothing left to spend on it this turn.",
    insufficient: "They cannot pay for it.",
    "bad-pool": "That is not a pool this can be paid from.",
    "unknown-style": "That attack cannot be made that way right now.",
    "unknown-mode": "That weapon cannot be used that way right now.",
    "bad-alter": "It cannot be changed that way right now.",
    compelled: "Something on them decides what this turn may hold.",
    dropped: "What it is made with lies where it was dropped.",
    "targets-apart": "The ones picked stand too far from each other, or from the first one picked, for this.",
    "unknown-creature": "That opponent is not in any bestiary this game can read.",
    "no-health": "That opponent's sheet gives it no health, so it was left out of the fight.",
    unreachable: "They cannot walk to that square.",
    "out-of-reach": "That is further off than this reaches.",
    "no-line-of-sight": "Something solid stands in the way.",
    "bad-cell": "That is not a square this can be aimed at.",
    "window-open": "The fight is waiting on somebody else's answer first.",
    "stale-window": "That moment has already passed.",
  };
  return said[reason] ?? "The rules refused that choice.";
}
