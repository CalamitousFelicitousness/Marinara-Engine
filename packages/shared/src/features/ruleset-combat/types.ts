// The shapes a ruleset fight is made of: what goes in, what the state holds, what the menu offers
// and what every resolved step reports.
//
// The state is a plain serialisable object on purpose: no Maps, no class instances and no
// functions, so a later slice can persist a fight as JSON and read it back exactly.

import type {
  RulesetCatalogEntriesById,
  RulesetCreatureHideEntry,
  RulesetCreature,
  RulesetSheetBuild,
  RulesetTargetIs,
  RulesetValueRef,
} from "../../schemas/ruleset.schema.js";
import type { RulesetLiveState } from "../rulesets/live-state.js";
import type { RulesetSheetItem } from "../rulesets/sheet-math.js";
import type { TacticalBattlefieldProvenance, TacticalGrid } from "../tactical-combat/types.js";

/** A die roller: one call, one die, a face from 1 to `sides`. Every random number a fight needs
 *  comes through one of these, so a scripted sequence reproduces a fight exactly. */
export type RulesetCombatRoller = (sides: number) => number;

export type RulesetCombatSide = "party" | "enemy";

/** Dice plus a flat adjustment, as a fight rolls them. */
export interface RulesetCombatAmount {
  count: number;
  sides: number;
  flat: number;
}

/** The save one damage clause asks its target for, resolved to a number when the fight began.
 *  `onSuccess` says what a success leaves of THIS clause: nothing at all, or half of it. */
export interface RulesetCombatClauseSave {
  save: string;
  difficulty: number;
  onSuccess: "none" | "half";
}

/** One more amount on the same blow, rolled and typed on its own. A clause never rolls to hit: it
 *  rides the blow that carried it, and a critical doubles its dice exactly as it doubles the first
 *  amount's. */
export interface RulesetCombatDamageClause extends RulesetCombatAmount {
  type?: string;
  save?: RulesetCombatClauseSave;
  /** Dealt only to a target that is this (1.163). */
  targetIs?: RulesetTargetIs;
  /** Dealt only on a critical hit (1.164): a sword of sharpness's extra. */
  onCritical?: true;
  /** Dealt only while this item of its holder's (its place in `sheet.items`) is switched on (1.165). */
  whileOn?: number;
}

/** An amount of damage, and what kind it is. The type is matched without case against a stat
 *  block's resistances, so "Fire" and "fire" are one thing. */
export interface RulesetCombatDamage extends RulesetCombatAmount {
  type?: string;
  /** What gets it past a resistance or an immunity that names an exception: the tags of the weapon
   *  item it is dealt with. */
  qualities?: string[];
  /** More amounts on the same blow. Each is rolled, typed and saved against on its own; the blow
   *  they make together is ONE check against concentration and one check for going down. */
  plus?: RulesetCombatDamageClause[];
  /** The least the first amount deals on a hit, before a resistance halves it: a pool fight's harm
   *  after soak, a summed fight's damage. A spending blow throws its maker's number and is never
   *  raised to it. */
  floor?: number;
  /** The first amount's own dice at or below this are thrown again once, the new face standing: a
   *  weapon wielded two-handed by a fighter whose sheet gives it (1.93, 5e's Great Weapon Fighting). */
  reroll?: number;
  /** What the first amount is instead while something the fight reads holds, the first that holds
   *  winning (1.97): a creature's longsword with both hands, a swarm at half its health. */
  alternatives?: RulesetCombatDamageAlternative[];
}

/** One amount a creature's action deals in place of its first, and when. */
export interface RulesetCombatDamageAlternative extends RulesetCombatAmount {
  when: "twoHanded" | { selfHealthAtMost: number };
}

/** A condition a hit or a failed save puts on its target. */
export interface RulesetCombatApplies {
  condition: string;
  duration: "instant" | "until-save" | "this-action" | { rounds: number; at?: "turn-start"; of?: "source" };
  saveEnds?: { save: string; at: "turn-end" | "turn-start" | "damaged" };
  endsAfter?: RulesetConditionEnding;
  /** What breaking free of it is rolled against, in place of the holder's own side of the contest
   *  (1.98): 5e's "grappled (escape DC 13)". */
  escapeDc?: number;
  /** It goes on only while this value off its applier's sheet stands within the bounds (1.162). */
  when?: RulesetSheetBounds;
  /** It goes on only a target that is this (1.163). */
  targetIs?: RulesetTargetIs;
}

/** A value read off a sheet and the bounds it must stand within: one bound or both. */
export interface RulesetSheetBounds {
  value: RulesetValueRef;
  atLeast?: number;
  atMost?: number;
}

/** What takes a condition off after it has been used once: the holder's own next attack roll, the
 *  next attack roll made against the holder, or the holder's own next save. */
export type RulesetConditionEnding = "own-attack" | "attacked" | "own-save";

/** One side of a contest as it was thrown: the check it added, and, when a condition made it more or
 *  less than one throw or changed the number, how. */
export interface RulesetContestSide {
  check: string;
  rolls: number[];
  modifier: number;
  total: number;
  mode?: RulesetCombatRollMode;
  bonuses?: RulesetConditionBonus[];
  /** Under `dice-pool`: the pool as it was thrown, and `total` is its net successes. */
  pool?: RulesetCombatPoolRoll;
}

/** One pool a `dice-pool` fight threw to act: how many dice went in after everything that adds or
 *  takes them away (the ruleset's own floor and ceiling included), the per-die target, the wound
 *  penalty it took, and whether it botched. The event's `modifier` is the number it started from and
 *  its `total` the net successes. */
export interface RulesetCombatPoolRoll {
  dice: number;
  target: number;
  /** Dice the wound penalty took off, as a negative number. Absent when it took none. */
  penalty?: number;
  botch?: boolean;
}

/** What one condition (or a level of a track or a derived value) added to, or took from, one roll or
 *  number. `level` is set when it came from a level, and then `condition` is the track's id, or the
 *  derived value's where `derived` is set. Dice it rolled are kept, so the log can say what was thrown. */
export interface RulesetConditionBonus {
  condition: string;
  level?: number;
  derived?: true;
  /** Set on what an item added, whose `condition` is then the stack's name. */
  item?: true;
  value: number;
  rolls?: number[];
}

export interface RulesetCombatSaveRider {
  save: string;
  difficulty: number;
  onSuccess: "none" | "half" | "negates";
  /** Cover does not help the target with this save (combat C6a-2). */
  ignoresCover?: true;
}

/** How often something can be done at all, and over what stretch. `day` outlives one fight, so the
 *  encounter only counts down what it was handed. */
export interface RulesetCombatUses {
  per: "encounter" | "day";
  count: number;
}

/** Spent when it is used, and rolled for at the start of its owner's turn: `from` or higher on
 *  these dice brings it back. It starts the fight available. */
export interface RulesetCombatRecharge {
  dice: { count: number; sides: number };
  from: number;
}

/** One step of a sequence: another action of the same block, done this many times. */
export interface RulesetCombatSequenceStep {
  /** The id of the action this step resolves, as the fight knows it. */
  actionId: string;
  times: number;
}

/** How far something is thrown or shot. `long` is what it still carries beyond `normal`, which a
 *  ruleset may make harder through `combat.ranged`. */
export interface RulesetCombatRange {
  normal: number;
  long?: number;
}

/**
 * Something that adds itself to the first qualifying hit of a period, with nobody choosing it.
 *
 * Passive and never on the menu: a rider is one more damage clause of the blow that carried it, so
 * a critical doubles it and the blow it joined is still one concentration check and one check for
 * going down. Which actions it fires on is resolved once, when the fight begins: `actions` is the
 * list of them, and a rider with none fires on any hit its holder lands.
 */
export interface RulesetCombatRider {
  id: string;
  label: string;
  on: "hit";
  actions?: string[];
  /** Any-of: one of them being true is enough. "ally-adjacent-no-disadvantage" (Capability API
   *  1.121) also needs the roll's final mode not to be disadvantage. */
  when?: Array<"advantage" | "ally-adjacent" | "ally-adjacent-no-disadvantage">;
  oncePer: "turn" | "round";
  amount: RulesetCombatAmount;
  type?: string;
}

/** One thing a stat block can do. `reach` and `range` are in the ruleset's own distance unit; a
 *  positioned fight turns them into cells when it starts. */
export interface RulesetStatBlockAction {
  /** The block's own id when it has one, so a bestiary keeps its names across a reload. A sequence
   *  names its parts by this id, so a block with sequences needs them. */
  id?: string;
  name: string;
  budget: string;
  toHit?: number;
  autoHit?: boolean;
  /** Senses a target must have for this to affect it (Capability API 1.122). */
  needs?: string[];
  damage?: RulesetCombatDamage;
  heal?: RulesetCombatAmount;
  targets?: "ally" | "any";
  save?: RulesetCombatSaveRider;
  /** What a save that ENDS one of `applies` is rolled against, when the action has no save of its
   *  own to borrow the number from. */
  saveDifficulty?: number;
  applies?: RulesetCombatApplies[];
  targetCount?: number;
  reach?: number;
  range?: number | RulesetCombatRange;
  /** The shape it lands in, in the ruleset's own distance unit. */
  area?: { shape: RulesetCombatArea["shape"]; size: number; width?: number; friendlyFire?: boolean };
  uses?: RulesetCombatUses;
  recharge?: RulesetCombatRecharge;
  /** Other actions of this block, in order. ONE budget pays for the lot, and each part takes its
   *  own targets: this is how a creature that strikes twice in one action is written. */
  sequence?: Array<{ action: string; times: number }>;
  /** Bought out of the block's own `signaturePoints` instead of a budget. */
  signature?: { cost: number };
  /** Taken at a moment rather than on a turn, as a catalog entry's reaction is. */
  reaction?: {
    on: RulesetReactionMoment;
    at?: "source" | "chosen" | "target";
    cancels?: true;
    cancelSave?: { save: string; dc: number };
    for?: "self" | "ally" | "any";
    within?: number;
    against?: RulesetReactionAgainst;
    /** More moments it is taken at, each with its own `against` (1.112). */
    also?: RulesetReactionAlso[];
    /** Only a blow of this kind opens its `hit` moment (1.113). */
    blow?: RulesetBlowKind;
    /** Only while its holder sees whoever caused the moment (1.113). */
    seesSource?: true;
    /** It stops only what was paid no higher up its family than itself (1.111). */
    upTo?: "paid";
    /** Above that, a check (its own number, `{ "const": n }`) against `dc` plus the level. */
    above?: { check: { const?: number }; dc: number };
  };
  /** It lands on the creature itself. */
  self?: true;
}

/** An opponent's numbers. A bestiary entry becomes one of these, and a hand-written one is still
 *  accepted, which is why everything a block can do without is optional. */
export interface RulesetStatBlock {
  /** What it can take. With `healthDice` beside it this is the AVERAGE, which is what a forecast
   *  reads while the dice decide the fight. Absent from a block that carries a `sheet`, which says
   *  it in the ruleset's own terms instead. */
  health?: number;
  defense?: number;
  initiativeModifier?: number;
  actions: RulesetStatBlockAction[];
  /** Spells cast without slots, kept beside the block's own actions (1.118). */
  spellcasting?: RulesetCreature["spellcasting"];
  /** The creature described in the ruleset's OWN terms: a character sheet, as partial as it likes,
   *  keyed by the ids the ruleset declares. An opponent built from one is built the way a party
   *  member is, so its health, defense, saves, speed, initiative and the abilities on its lists all
   *  come from what the ruleset declares rather than from the numbers above, which it then does
   *  not carry. Its own `actions` still add to what the sheet gives it. */
  sheet?: RulesetSheetBuild;
  /** Thrown once when the encounter is created, in place of the flat number. */
  healthDice?: RulesetCombatAmount;
  speed?: number;
  /** How fast it moves other than on foot, in the ruleset's own distance (1.108). `speed` is its walk. */
  speeds?: RulesetMoveSpeeds;
  /** It flies without needing to keep moving, so nothing knocks it out of the air (1.108). */
  hover?: true;
  /** Its hands are full, so a `twoHanded` alternative never holds (1.97). */
  shield?: true;
  /** One of `combat.sizes`, by id (1.98). */
  size?: string;
  /** One of `combat.creatureTypes.types`, and its tags (1.163): what a target test reads. */
  type?: string;
  tags?: string[];
  /** Ability scores by the ruleset's own ability ids. Carried for the Game Master, not resolved. */
  abilities?: Record<string, number>;
  /** Save modifiers by the ruleset's own save ids. A save it does not name reads as zero. */
  saves?: Record<string, number>;
  /** What it adds in a contest, by the ids of `combat.checks`. One it does not name reads as zero. */
  checks?: Record<string, number>;
  /** Damage types, matched without case: half damage, double damage, none at all. A resistance or an
   *  immunity may name the item tags a blow gets through it with. */
  resist?: RulesetCreatureHideEntry[];
  vulnerable?: string[];
  immune?: RulesetCreatureHideEntry[];
  /** Conditions it shrugs off, and tracks whose levels it never suffers (1.110). */
  conditionImmunities?: string[];
  /** Where its live tracks stand as the fight begins (1.110). */
  tracks?: Record<string, number>;
  /** What it soaks in a `dice-pool` fight, for any harm and by kind of the health track. */
  soak?: RulesetCombatSoak;
  /** A spending blow whose dice are below this lands and does nothing. */
  hardness?: number;
  /** The threat tier a bestiary filed it under, read when creatures are clamped to the scale. */
  tier?: string;
  /** Lines the Game Master is shown and nothing resolves. */
  traits?: Array<{ name: string; text: string }>;
  /** Points given back at the start of its own turn, spent on `signature` actions. */
  signaturePoints?: number;
  /** What this creature adds to the first qualifying hit of a period, all by itself. */
  riders?: RulesetCombatRider[];
}

/** What a combatant soaks: `all` for any harm, and `byKind` for one kind of the health track. */
export interface RulesetCombatSoak {
  all?: number;
  byKind?: Record<string, number>;
}

/** A block with its own numbers and no sheet. What a Game Master invents is always one, and it is
 *  all the clamp can hold to a tier, because it holds a creature there by exactly those numbers. */
export type RulesetPlainStatBlock = RulesetStatBlock & {
  health: number;
  defense: number;
  initiativeModifier: number;
  sheet?: undefined;
};

/** Who is in the fight. A party member is sheet-backed and reads and writes its numbers through the
 *  sheet's own rules; an opponent carries a stat block and lives inside the encounter only. */
export type RulesetCombatantInput =
  | {
      id: string;
      name: string;
      side: "party";
      build: RulesetSheetBuild;
      /** The stored live blob, read tolerantly exactly as the sheet reads it. */
      live?: unknown;
      /** The catalogs this member's own rows came from, so the fight knows what an ability costs. */
      catalogs?: RulesetCatalogEntriesById;
      /** The items they hold as the fight starts, which an `itemStat` on their sheet reads. */
      items?: ReadonlyArray<RulesetSheetItem>;
    }
  | { id: string; name: string; side: "enemy"; block: RulesetStatBlock }
  /** An opponent out of a bestiary, looked up in the catalogs the encounter was handed. */
  | {
      id: string;
      name: string;
      side: "enemy";
      creature: { catalogId: string; entryId: string };
      /** Where its live tracks stand as the fight begins (1.110), as a bestiary creature has none. */
      tracks?: Record<string, number>;
    };

/** One thing a combatant may do, with every number already read off the sheet or the stat block.
 *  Resolved once, when the fight begins: armour and bonuses do not change mid-fight in this kind. */
export interface RulesetCombatAction {
  /** The entry's qualities, even without damage, for saves against magic (1.129). */
  qualities?: string[];
  /** A catalog attack or debuff targets harmfully even if it deals no damage (1.120). */
  harmful?: true;
  id: string;
  /** `reload` fills a weapon's clip: it has no target and does nothing else. `item` is using an
   *  item the fighter holds. */
  kind: "attack" | "ability" | "block" | "contest" | "reload" | "item" | "switch";
  label: string;
  budget: string;
  /** Who it may be pointed at, relative to the actor: "enemy" is the other side. */
  targets: { side: "enemy" | "ally" | "self" | "any"; count: number };
  /** The ability actually used for the attack roll (Capability API 1.128). A plain stat-block
   *  action has none; a weapon offering several keeps the first best one, as its roll does. */
  ability?: string;
  toHit?: number;
  /** The per-die target a pool fight throws this attack against, where the ruleset lets it move: a
   *  weapon's own. Without one the attack is thrown against the pool's usual target. */
  target?: number;
  autoHit?: boolean;
  /** Senses a target must have for this to affect it (Capability API 1.122). */
  needs?: string[];
  /** Offered only while this reads within its bounds off the holder's sheet (Capability API 1.161). */
  usableWhen?: RulesetSheetBounds;
  /** Who it may be pointed at or catch, by what they are (Capability API 1.163). */
  targetTypes?: { is?: RulesetTargetIs; not?: RulesetTargetIs };
  damage?: RulesetCombatDamage;
  heal?: RulesetCombatAmount;
  temporary?: RulesetCombatAmount;
  /** A pool of each target's sheet this gives back some of: an item's `restore`. */
  restore?: { pool: string; amount: RulesetCombatAmount };
  save?: RulesetCombatSaveRider;
  /** The source's own save difficulty, for a save-ends on an action with no save of its own. */
  saveDifficulty?: number;
  applies?: RulesetCombatApplies[];
  concentration?: boolean;
  /** How the price is paid. The name is what the sheet's own `use` command knows the row by, and
   *  the pool and its family are what a higher-pool payment is measured against. */
  use?: { name: string; pool?: string; group?: string; perCostStep?: RulesetCombatAmount };
  uses?: RulesetCombatUses;
  recharge?: RulesetCombatRecharge;
  /** How many strikes ONE spend of this action's budget buys, when its source said so. Taking it
   *  with none in hand spends the budget and puts the rest in hand; while any are in hand, every
   *  action that declares this costs no budget at all. */
  strikes?: number;
  /** Costs no budget: whatever else it asks for, a turn may hold as many as it can pay for. */
  free?: true;
  /** Budgets this hands its user the moment it is used, capped where they land so nothing banks. */
  gives?: Array<{ budget: string; count: number }>;
  /** The standard actions its holder may take for THIS budget instead of the main one. The action
   *  itself is a permission: what it grants is on the menu as `standard:<id>@<budget>`. */
  standard?: { actions: string[]; budget: string };
  /** The other actions this one resolves, in order, for one budget. */
  sequence?: RulesetCombatSequenceStep[];
  /** Bought with the actor's own points at the end of somebody else's turn, not with a budget. */
  signature?: { cost: number };
  /** Taken at a MOMENT rather than on a turn: which moment, whom it may be aimed at, and whether
   *  taking it stops what opened the window. On no turn's menu, ever. */
  reaction?: {
    on: RulesetReactionMoment;
    at: "source" | "chosen" | "target";
    cancels?: true;
    cancelSave?: { save: string; dc: number };
    for?: "self" | "ally" | "any";
    within?: number;
    /** Only an action from an entry of one of these catalogs, or one of these entries, opens its
     *  moment for this reaction. */
    against?: RulesetReactionAgainst;
    /** More moments it is taken at, each with its own `against` (1.112). */
    also?: RulesetReactionAlso[];
    /** Only a blow of this kind opens its `hit` moment (1.113). */
    blow?: RulesetBlowKind;
    /** Only while its holder sees whoever caused the moment (1.113). */
    seesSource?: true;
    /** It stops only what was paid for no higher up its pool family than this was (1.111). */
    upTo?: "paid";
    /** Above that, a check, read once as the fight began, against `dc` plus the level of what it
     *  answers. */
    above?: { modifier: number; dc: number };
  };
  /** The catalog of the entry this action was built from, when it was built from one. A weapon row,
   *  a stat block's own action, a contest and a standard action have none. */
  catalog?: string;
  /** And the entry itself, as `<catalog>/<entry>` (1.112): what a reaction or a condition that names
   *  one entry reads. */
  entry?: string;
  /** IN CELLS, resolved once when the fight began, and read only by a positioned fight. An action
   *  with neither reaches one cell, which is the smallest step a board has. */
  reach?: number;
  range?: RulesetCombatRange;
  /** The level of a spell cast without slots, and the base it scales from (1.118). */
  innate?: { level: number; baseLevel: number; coven?: { id: string; size: number; within: number } };
  /** What this leaves to strike on later turns (1.117), with distances already in cells. */
  summons?: { budget: string; rounds: number; move?: number; reach?: number };
  /** The shape this one covers, in cells, aimed at a cell rather than at anybody. */
  area?: RulesetCombatArea;
  /** What a contest rolls and what winning it does, on an action of kind `contest`. */
  contest?: RulesetCombatContest;
  /** What a weapon shoots: `per` of the holder's carried items with this tag each attack, and the
   *  share of what was shot that comes back after a fight the party wins. */
  ammo?: { tag: string; per: number; recover?: number };
  /** The loaded count a weapon keeps on itself: which of the holder's items it is (its place in
   *  `sheet.items`) and how many it holds. An attack spends what is loaded; a `reload` fills it. */
  clip?: { item: number; max: number };
  /** Turning one of the holder's items on or off (1.165): its place in `sheet.items`. */
  switches?: { item: number };
  /** Other ways to make this attack, chosen with it like an initiative style. */
  modes?: RulesetCombatMode[];
  /** How many one attack shoots when a mode says so, in place of its ammunition's own. */
  shots?: number;
  /** An off-hand weapon's own attack: attacking with it this turn lets another off-hand weapon strike
   *  on the off-hand budget. The item's place in `sheet.items`. */
  pairs?: number;
  /** The second attack, on the off-hand budget, made with the weapon at this place in `sheet.items`
   *  after its holder attacked with another off-hand weapon this turn. */
  offHandOf?: number;
  /** Conditions the target takes when the harm this blow dealt reached a number. */
  onHit?: Array<{
    condition: string;
    atLeast: number;
    rounds?: number;
    /** The target saves against it, and a success keeps it off (1.164). */
    save?: { save: string; difficulty: number };
    /** It lasts until its holder makes this save at a turn's start or end (1.164). */
    saveEnds?: { save: string; difficulty: number; at: "turn-start" | "turn-end" | "damaged" };
  }>;
  /** Using an item: which of the holder's items it is (its place in `sheet.items`), and what using
   *  it spends of it: one off the stack, or some of its charges. */
  itemUse?: {
    item: number;
    /** A fake used (Capability API 1.74): its true name, and what its true item does in place of what
     *  the action says (`rulesetActionAsUsed`), or `dud` where it does nothing a fight can use, so the
     *  use is spent for nothing. The fight says what it really was once it is spent. */
    fake?: { name: string; dud?: true; does?: Partial<RulesetCombatAction> };
    consumes?: true;
    charges?: { cost: number; max: number; breaksOn?: { die: number; atMost: number } };
    /** Its `gate`, read off the user's sheet as the fight began: what is rolled (a skill's id when it
     *  is one, so what is narrowed to it counts), the sheet's number for it, and the difficulty. No
     *  gate here when the user's sheet was high enough to skip it. */
    gate?: { check: string; skill?: string; modifier: number; difficulty: number };
  };
}

/** One other way to make an attack: how many it shoots, what it adds to hit (dice in a pool fight),
 *  how far it moves a pool fight's per-die target, and how many it may be aimed at. */
export interface RulesetCombatMode {
  id: string;
  label: string;
  ammo?: number;
  toHit?: number;
  target?: number;
  targets?: number;
}

/** A contest as the fight resolves it: the check each side adds, who takes a tie, and what winning
 *  does. Both sides throw the fight's own attack dice. */
export interface RulesetCombatContest {
  /** The contest's own id in `combat.contests`. */
  id: string;
  /** It takes the place of one strike of an attack, so a cap on attacks counts it as one. */
  strike?: true;
  /** Each side rolls the best of the checks it may use here. */
  attacker: string[];
  defender: string[];
  ties: "defender" | "attacker";
  /** Aimed only at whoever put this condition on the actor, and offered only while it holds. */
  from?: string;
  /** Not taken against a target more than this many of `combat.sizes` larger than the actor (1.98). */
  maxSizeAbove?: number;
  applies?: Array<{ condition: string; rounds?: number }>;
  ends?: Array<{ condition: string; on: "actor" | "target" }>;
  /** How far the loser is pushed straight away, IN CELLS. Read only by a positioned fight. */
  push?: number;
}

/** A shape on the board, in cells. `friendlyFire` false leaves the actor's own side out of it. */
export interface RulesetCombatArea {
  shape: "burst" | "cone" | "line";
  size: number;
  /** A line's width in cells (Capability API 1.123). Without it, one cell. */
  width?: number;
  friendlyFire?: boolean;
}

/** One cell of a board, as a fight counts them. */
export interface RulesetCombatCell {
  x: number;
  y: number;
}

/** Where a move could go: what it costs of the allowance, the cells it walks through, and the
 *  standing enemies whose reach it leaves on the way. */
export interface RulesetReachableCell extends RulesetCombatCell {
  cost: number;
  /** From the cell after the actor's own up to and including this one. */
  path: RulesetCombatCell[];
  /** The ids of the enemies this path would be struck at by, in the order it passes them. */
  provokes: string[];
}

/** A condition the fight is keeping time on. The condition itself lives on the sheet for a party
 *  member, so it outlives the battle; this is the bookkeeping beside it. */
export interface RulesetTrackedCondition {
  /** Removed once the action that opened its window finishes (1.126). */
  thisAction?: true;
  condition: string;
  /** Turns of the affected combatant left, or null for a condition with no clock of its own. */
  rounds: number | null;
  saveEnds?: { save: string; at: "turn-end" | "turn-start" | "damaged" };
  /** When its rounds count down: as each of the holder's turns begins, rather than as each ends. */
  clock?: "turn-start";
  /** Whose turns its rounds count (1.114): whoever put it on, while they are in the fight. */
  clockOf?: "source";
  /** What takes it off after one use, whatever its clock says. */
  endsAfter?: RulesetConditionEnding;
  /** The difficulty the repeated save is rolled against: the one that applied it. */
  difficulty?: number;
  /** Who applied it, and whether their concentration is what holds it. */
  source?: string;
  concentration?: boolean;
  /** What breaking free of it is rolled against, from what applied it (1.98). */
  escapeDc?: number;
}

export interface RulesetCombatant {
  id: string;
  name: string;
  side: RulesetCombatSide;
  /** The bestiary entry an opponent was made from, when it was made from one: what its art is found by
   *  (design-game-creature-art.md). Never read by the fight's rules. */
  creature?: { catalogId: string; entryId: string };
  initiative: number;
  initiativeRoll: number[];
  initiativeModifier: number;
  /** What is left of each budget, keyed by budget id. */
  budgets: Record<string, number>;
  actions: RulesetCombatAction[];
  /** How many uses are left of each action that counts them, keyed by action id. */
  uses: Record<string, number>;
  /** The ids of the actions that have been used and are waiting for a recharge roll. */
  spent: string[];
  /** The points a signature action is bought with, when this combatant has any. */
  signature?: { points: number; max: number };
  /** Strikes in hand: what is left of a spend that bought several. Absent when there are none, and
   *  cleared at the end of the turn they were bought on, so nothing carries into the next one. */
  strikesLeft?: number;
  /** What this combatant adds to a qualifying hit without anybody choosing it. */
  riders?: RulesetCombatRider[];
  /** The riders that have already fired in their period. A "turn" rider is fresh at the start of
   *  every turn, whosever it is; a "round" rider when the round turns over. */
  ridersSpent?: string[];
  tracked: RulesetTrackedCondition[];
  concentrating: { actionId: string; label: string } | null;
  /** What a standard action left behind. `dodging`, `dashed`, `disengaged`, `hidden` and `ready`
   *  are cleared at the start of the actor's next turn; `helped` is spent by their next attack. */
  flags: {
    dodging?: boolean;
    dashed?: boolean;
    disengaged?: boolean;
    hidden?: boolean;
    ready?: boolean;
    helped?: boolean;
    /** The off-hand weapon (its place in `sheet.items`) this turn's attack was made with, which
     *  another off-hand weapon may follow on the off-hand budget. */
    offHand?: number;
    /** Attacks made this turn, which a condition's cap on attacks a turn counts (combat C6d). */
    attacks?: number;
    /** Summons made this turn do not spend a round at its end. */
    freshSummons?: string[];
  };
  /** At zero and out of the fight. `dying` is a party member a ruleset with a dying rule still
   *  rolls for; `stable` is one that has stopped rolling; `defeated` is one the fight is over for. */
  down: boolean;
  dying: boolean;
  stable: boolean;
  defeated: boolean;
  /** Read from the sheet or the block once, when the fight began. */
  defense: number;
  /** The lowest natural attack face that is a critical for this fighter, read off their sheet
   *  (`attackRoll.criticalFrom`, 1.76). The die's highest face when absent. */
  criticalFrom?: number;
  saves: Record<string, number>;
  /** What this combatant adds in a contest, by check id. Present only when the ruleset has checks. */
  checks?: Record<string, number>;
  /** Its size, by the id of one of `combat.sizes`, read once as the fight began (1.98). Absent when
   *  the ruleset has no sizes or nothing says this one's. */
  size?: string;
  /** What they soak in a `dice-pool` fight, read once as the fight began. Absent when nothing. */
  soak?: RulesetCombatSoak;
  /** Their hardness, read once as the fight began: a spending blow whose dice are below it lands and
   *  does nothing. Absent when none. */
  hardness?: number;
  /** How many of their own turns they have begun crashed, where initiative is a number attacks move
   *  and the ruleset lets a crash recover. Absent while they are not crashed. */
  crashedTurns?: number;
  /** What a delay held over to their next turn (1.115): the action as it was made, and the budget
   *  completing it takes. Absent while nothing waits. */
  delayed?: RulesetActionResume & { label: string; budget: string };
  /** What the holder's spells left behind (1.117). Distances are in cells. */
  summons?: Array<{
    actionId: string;
    label: string;
    budget: string;
    rounds: number;
    move?: number;
    reach?: number;
    at?: RulesetCombatCell;
    payWith?: string;
  }>;
  /** How much of each limited live pool they may still spend this turn or round, read once as the
   *  fight began and counted down as they pay. Absent for anybody nothing limits. */
  limits?: Record<string, { max: number; per: "turn" | "round"; spent: number }>;
  speed: number;
  /** What the fight has done to the items this fighter holds, each keyed by the item's place in
   *  `sheet.items`: how many of a stack were shot or loaded (`itemsUsed`), what each weapon has loaded
   *  now (`loaded`), and the share of what was shot that comes back after a won fight
   *  (`recoverable`, summed as it is shot and rounded down once). Absent until anything changed. */
  itemsUsed?: Record<string, number>;
  loaded?: Record<string, number>;
  recoverable?: Record<string, number>;
  /** What each item with charges holds now, keyed as the rest are. */
  charges?: Record<string, number>;
  /** The items that broke when their last charge was spent, keyed as the rest are. */
  broken?: Record<string, true>;
  /** Each item switched on or off in this fight, keyed as the rest are (1.165). */
  on?: Record<string, boolean>;
  /** A party member's sheet, which is where their health and conditions really live. */
  sheet?: {
    build: RulesetSheetBuild;
    live: RulesetLiveState;
    catalogs: RulesetCatalogEntriesById;
    /** The items they held as the fight started. */
    items?: ReadonlyArray<RulesetSheetItem>;
  };
  /** An opponent's block, and the health the encounter keeps for it. */
  block?: RulesetStatBlock;
  health?: { value: number; max: number; temp: number };
  /** Where they stand. Present only in a positioned fight, and then on everybody at once. */
  x?: number;
  y?: number;
  /** The whole allowance this turn and what is left of it, both in CELLS. With other ways of moving
   *  than walking (1.108) these are the fastest one's. */
  movement?: number;
  movementLeft?: number;
  /** How fast they move other than on foot, in the ruleset's own distance, read once as the fight
   *  began (1.108). `speed` is their walk. Absent for somebody who only walks. */
  speeds?: RulesetMoveSpeeds;
  /** A flier that hovers (1.108). */
  hover?: true;
  /** What is left this turn of each way they move, in CELLS (1.108): every cell moved comes off all
   *  of them, as switching from walking to flying takes what was already walked off the flight.
   *  Absent for somebody who only walks, whose walk is `movementLeft`. */
  modeLeft?: Partial<Record<RulesetMoveMode, number>>;
  /** The level a flier is at, by the board's own levels, while it is up above the ground beneath it
   *  (1.109). Absent on the ground. */
  altitude?: number;
  /** Where a combatant without a sheet stands on the sheet's live tracks, by track id (1.110): the
   *  levels of `combat.levels` read these as a sheet's are read off its live state. */
  tracks?: Record<string, number>;
}

/** The ways of moving besides walking (1.108). */
export const RULESET_MOVE_MODES = ["fly", "swim", "climb", "burrow"] as const;
export type RulesetMoveMode = "walk" | (typeof RULESET_MOVE_MODES)[number];
export type RulesetMoveSpeeds = Partial<Record<(typeof RULESET_MOVE_MODES)[number], number>>;

export interface RulesetEncounterState {
  /** Bumped when the shape changes, so a persisted fight says what wrote it. */
  v: 1;
  /** The ruleset this fight is resolved by, as the game pinned it. */
  ruleset: { id: string; version: number };
  seed: number;
  /** One tick per die thrown, so a seeded roller picks up exactly where the last step left off. */
  cursor: number;
  round: number;
  /** Where in `order` the turn is. */
  turn: number;
  order: string[];
  combatants: RulesetCombatant[];
  /** The events the fight opened with, so a caller printing a log never rebuilds them. */
  opening: RulesetCombatEvent[];
  /** The board this fight stands on, when it has one. A fight without it is theatre of the mind and
   *  reads nothing about distance at all. */
  board?: RulesetCombatBoard;
  /** The fight held open for somebody who is not the current actor. While it is here NOTHING else
   *  moves: the turn cannot go on, and a choice from anybody but the one being asked is refused. */
  window?: RulesetCombatWindow;
  /** Falls from a step that continued while a window was open, asked one at a time (1.119). */
  pendingFalls?: RulesetFallResume[];
  /** One up per window ever opened in this fight, so no two windows share an id and an answer
   *  written for a closed one is refused rather than spent on the one that replaced it. */
  windows?: number;
  /** Remaining uses shared by a coven, keyed by coven id and spell entry (1.118). */
  covenUses?: Record<string, number>;
}

/** A fight held open between one step and the next, so somebody who is not the current actor may
 *  take something. Every window is answered by exactly one combatant at a time, with an option or
 *  a pass, and the fight picks up where it left off once the last of them has answered.
 *
 *  The window lives IN the state rather than beside it, so a fight saved mid-walk comes back with
 *  the same people still to ask and the same cells still to walk. */
export interface RulesetCombatWindow {
  /** Stable for the life of this window. An answer carrying another one is stale: the window it was
   *  written for has already closed, and applying it now would spend a budget twice. */
  id: string;
  kind: RulesetWindowKind;
  trigger: RulesetWindowTrigger;
  /** Who is still to answer, in the fight's own order. The first is the one being asked; a pass or
   *  a taken option removes them, and the window closes when the list empties. */
  waiting: string[];
  /** What this window interrupted, when something waits for it to close. */
  resume?: RulesetWindowResume;
}

/** What a window is for. `reaction` is somebody spending a budget out of turn; `signature` is a
 *  block buying one of its own actions with its points between two turns. */
export type RulesetWindowKind = "reaction" | "signature";

/** What opened the window. The fight reads it to build the menu, and a caller reads it to say why
 *  somebody is being asked. */
export type RulesetWindowTrigger =
  /** A walk left this one's reach. `from` and `to` are the step that did it, not the whole walk. */
  | { kind: "leaves-reach"; moverId: string; from: RulesetCombatCell; to: RulesetCombatCell }
  /** One turn has ended and the next has not begun. */
  | { kind: "between-turns"; nextActorId: string }
  /** Something is ABOUT to land on the ones being asked. It is already paid for and is held here
   *  until they have answered, and an answer that cancels stops it from happening at all.
   *  `catalog` is where the entry behind it came from, when there is one. */
  | {
      kind: "aimed";
      targetIds?: string[];
      sourceId: string;
      optionId: string;
      label: string;
      catalog?: string;
      entry?: string;
    }
  /** Somebody on the other side is ABOUT to use something, whoever it is aimed at: held the same
   *  way, for everybody holding an answer that reaches them. */
  | { kind: "used"; sourceId: string; optionId: string; label: string; catalog?: string; entry?: string }
  /** An attack roll has just hit the one being asked, and its damage has not been dealt. What they
   *  take counts for it: the roll (`total`, made against `defense`) is checked again afterwards. */
  | {
      kind: "hit";
      targetIds?: string[];
      sourceId: string;
      optionId: string;
      label: string;
      catalog?: string;
      entry?: string;
      /** Whether the blow was struck in reach or from afar (1.113). */
      blow?: RulesetBlowKind;
      total: number;
      defense: number;
    }
  /** Something has just hurt the ones being asked. It has already happened: nothing answered here
   *  unmakes it, and `sourceId` is whoever dealt it, for a reaction aimed back at them. */
  | { kind: "harmed"; sourceId: string; label: string; catalog?: string; entry?: string }
  /** Somebody is falling, before its damage and prone (1.119). The source is the faller. */
  | { kind: "falls"; sourceId: string; label: "fall"; levels: number; fallerIds?: string[] }
  | { kind: "turn-start"; sourceId: string; label: string };

/** The moments the Engine notices, and opens a window for. `aimed` is before something lands on
 *  the holder, `used` is before somebody on the other side uses something, `hit` is after an attack
 *  roll has hit the holder and before its damage, `harmed` is after something has hurt them, and
 *  `falls` is before a falling creature lands, and `turn-start` before its creature acts (1.126). */
export type RulesetReactionMoment = "aimed" | "hit" | "harmed" | "used" | "falls" | "turn-start";

/** A blow struck in reach (`melee`) or from afar (`ranged`), as a reaction that answers only one
 *  of them reads it (1.113). */
export type RulesetBlowKind = "melee" | "ranged";

/** One more moment a reaction is taken at, narrowed on its own (1.112, 1.113). */
export interface RulesetReactionAlso {
  for?: "self" | "ally" | "any";
  within?: number;
  on: RulesetReactionMoment;
  against?: RulesetReactionAgainst;
  blow?: RulesetBlowKind;
  seesSource?: true;
}

/** What caused a moment, as far as a reaction narrows what it answers: the catalog and entry behind
 *  it, and for a hit, the kind of blow. */
export interface RulesetMomentCause {
  targetIds?: string[];
  action?: string;
  catalog?: string;
  entry?: string;
  blow?: RulesetBlowKind;
}

/** What opens a moment for one reaction: an action from an entry of one of `catalogs`, or one of
 *  `entries` (`<catalog>/<entry>`, 1.112). Either is enough. */
export interface RulesetReactionAgainst {
  actions?: string[];
  catalogs?: string[];
  entries?: string[];
}

/** What the fight goes back to once the window closes. A window opened after something has already
 *  happened carries none: there is nothing to pick up. */
export type RulesetWindowResume = RulesetWalkResume | RulesetActionResume | RulesetFallResume;

/** A fall lands after the answers have put their conditions on its target (1.119). */
export interface RulesetFallResume {
  others?: RulesetFallResume[];
  kind: "fall";
  actorId: string;
  targetId: string;
  levels: number;
}

/** Something paid for and held while everybody it is aimed at is asked. It resolves when the window
 *  closes, from the state as it stands then, unless an answer called it off. */
export interface RulesetActionResume {
  kind: "action";
  actorId: string;
  optionId: string;
  targetIds: string[];
  /** The cell an area was aimed at, which a save against it takes cover from (combat C6a-2). */
  at?: RulesetCombatCell;
  payWith?: string;
  /** The initiative style it was made in, so a held attack picks up in the same one. */
  style?: string;
  /** The weapon's mode it was made in, so a held attack picks up in the same one. */
  mode?: string;
  /** What a spending blow throws: its maker's number as they made it. */
  spend?: number;
  /** An answer stopped it. What it cost is still spent: it was paid for before the asking. */
  cancelled?: true;
  /** A later strike spends only the summon's budget and never summons again. */
  summon?: true;
  /** The action landed; only its summon awaits the last reaction window. */
  resolved?: true;
  /** Held after one of its attack rolls hit, rather than before anything happened. */
  held?: RulesetHeldAttack;
}

/** An attack held after its roll hit, while the one it hit is asked. It picks up exactly here: the
 *  same roll against that target, then the rest of this action's targets, then the rest of its parts
 *  when it is one part of an action made of others. */
export interface RulesetHeldAttack {
  /** Its place among the parts of the action it belongs to, when that action is made of others. */
  part?: number;
  targetId: string;
  /** The targets still to come after this one, of the same action or part, in order. */
  rest: string[];
  roll: {
    mode: RulesetCombatRollMode;
    total: number;
    /** What it was rolled against. */
    defense: number;
    critical: boolean;
    /** A natural face decided it, so no change to the defense can turn it. */
    natural: boolean;
  };
  /** The attacker's one-use conditions the roll used, spent once the blow is over. */
  mine: string[];
  /** Whoever the action had already hurt before it was held, for the moment after it. */
  hurt: string[];
}

/** A walk stopped in its tracks, with everything needed to finish it exactly as it would have gone:
 *  the cells already crossed, the ones still to cross, what has been paid so far and who has
 *  already struck, so nobody strikes the same passer-by twice. */
export interface RulesetWalkResume {
  kind: "walk";
  actorId: string;
  from: RulesetCombatCell;
  walked: RulesetCombatCell[];
  path: RulesetCombatCell[];
  /** Everybody already ASKED about this walk, struck or passed: one chance each per walk, so a
   *  long path past the same foe never offers a second. */
  asked: string[];
  spent: number;
}

/** The board, as the fight keeps it: the tactical engine's own grid and where it came from. The
 *  fight never generates one of its own. */
export interface RulesetCombatBoard {
  grid: TacticalGrid;
  battlefield?: TacticalBattlefieldProvenance;
  /** Cells a shot carries further down from higher ground (combat C6b), as the ruleset said when the
   *  fight began. */
  rangeBonus?: number;
  /** Cells one level of height is worth (1.109), as the ruleset's `elevation.levelHeight` and cell
   *  said when the fight began. Present only where there are levels, which is where a flier rises. */
  levelCells?: number;
}

/** Why a choice changed nothing. */
export type RulesetCombatRefusal =
  | "encounter-over"
  | "unknown-actor"
  | "not-your-turn"
  | "unknown-option"
  | "cannot-act"
  | "down"
  | "bad-target"
  | "no-budget"
  | "insufficient"
  | "bad-pool"
  /** A bestiary reference the handed-in catalogs do not hold. */
  | "unknown-creature"
  /** A creature whose sheet gives it no health at all, so it would walk in already out. */
  | "no-health"
  /** A cell this move cannot end on, or cannot pay for. */
  | "unreachable"
  /** The fight is held open for somebody else, and nothing but their answer moves it. */
  | "window-open"
  /** An answer to a window that has already closed. */
  | "stale-window"
  /** A target further away than this reaches or carries. */
  | "out-of-reach"
  /** Something solid stands between the two of them. */
  | "no-line-of-sight"
  /** An area aimed at a cell it may not be aimed at. */
  | "bad-cell"
  /** An initiative style this attack is not offered in. */
  | "unknown-style"
  /** A way of using a weapon that the option does not offer, or cannot now. */
  | "unknown-mode";

export type RulesetCombatAttackOutcome = "hit" | "miss" | "critical";
export type RulesetCombatRollMode = "normal" | "advantage" | "disadvantage";

/** Everything a step did, with the numbers it did it with, so a log can print "17 + 5 = 22 against
 *  15: hit" without doing any arithmetic of its own. */
export type RulesetCombatEvent =
  | { type: "initiative"; entries: Array<{ actorId: string; roll: number[]; modifier: number; total: number }> }
  | { type: "round"; round: number }
  | { type: "turn"; actorId: string; round: number }
  | {
      type: "attack";
      actorId: string;
      targetId: string;
      optionId: string;
      label: string;
      mode: RulesetCombatRollMode;
      rolls: number[];
      kept: number;
      modifier: number;
      /** What the attacker's conditions added, already inside `total`. */
      bonuses?: RulesetConditionBonus[];
      total: number;
      defense: number;
      /** What the target's conditions added to its defense, already inside `defense`. */
      guards?: RulesetConditionBonus[];
      outcome: RulesetCombatAttackOutcome;
      /** Under `dice-pool`: the pool as it was thrown. `total` is its net successes and `defense` the
       *  successes it needed. */
      pool?: RulesetCombatPoolRoll;
      /** The initiative style it was made in, where initiative is a number attacks move. */
      style?: string;
    }
  | {
      type: "save";
      actorId: string;
      /** Who forced it, when somebody did. */
      sourceId?: string;
      save: string;
      /** How it was rolled, when a condition made it more or less than one throw. */
      mode?: RulesetCombatRollMode;
      rolls: number[];
      kept: number;
      modifier: number;
      /** What the saver's conditions added, already inside `total`. */
      bonuses?: RulesetConditionBonus[];
      total: number;
      difficulty: number;
      success: boolean;
      /** A condition that fails this save automatically rolls nothing. */
      automatic?: boolean;
      /** Under `dice-pool`: the pool as it was thrown. `total` is its net successes and `difficulty`
       *  the successes it needed. */
      pool?: RulesetCombatPoolRoll;
    }
  | {
      type: "damage";
      targetId: string;
      sourceId?: string;
      label?: string;
      damageType?: string;
      rolls: number[];
      flat: number;
      /** Before and after the target's own resistances, and how they changed it. */
      amount: number;
      dealt: number;
      adjust: "none" | "resist" | "vulnerable" | "immune";
      /** Halved because the target saved, which is separate from what its hide is made of. */
      saved?: boolean;
      toTemp: number;
      health: number;
      maxHealth: number;
      critical?: boolean;
      /** Under `dice-pool`: `rolls` are the damage dice as they fell, `flat` the automatic successes,
       *  and this is what they counted, against which target, and what soak took off before
       *  `amount`. Soak thrown has its own dice; soak taken off the dice beforehand has none. */
      pool?: {
        target: number;
        successes: number;
        soak?: { value: number; rolls?: number[]; taken: number };
      };
      /** The weapon's floor, when the blow was raised to it. */
      floor?: number;
    }
  | {
      type: "heal";
      targetId: string;
      sourceId?: string;
      rolls: number[];
      flat: number;
      amount: number;
      health: number;
      maxHealth: number;
    }
  | { type: "temporary"; targetId: string; sourceId?: string; rolls: number[]; flat: number; amount: number }
  | {
      type: "restored";
      targetId: string;
      sourceId?: string;
      /** The pool's own label, and where it stands after. */
      pool: string;
      rolls: number[];
      flat: number;
      amount: number;
      value: number;
      max: number;
    }
  | {
      type: "condition";
      targetId: string;
      condition: string;
      active: boolean;
      reason:
        | "applied"
        | "immune"
        | "save"
        | "expired"
        | "damage"
        | "concentration"
        | "revived"
        | "down"
        | "contest"
        | "spent"
        | "recovered"
        | "harmed"
        | "shaken";
    }
  /** A number that attacks move: what came off it or went on it, why, and what it is now. A style
   *  that takes carries the damage dice that decided it, as a damage event does. */
  | {
      type: "shift";
      actorId: string;
      amount: number;
      total: number;
      reason: "taken" | "gained" | "crash" | "spent" | "missed" | "recovered";
      sourceId?: string;
      label?: string;
      rolls?: number[];
      flat?: number;
      pool?: { target: number; successes: number; soak?: { value: number; rolls?: number[]; taken: number } };
    }
  | { type: "spend"; actorId: string; pool: string; label: string; amount: number }
  | { type: "budget"; actorId: string; budget: string; left: number }
  | { type: "uses"; actorId: string; optionId: string; label: string; left: number; of: number }
  /** An item whose last charge was just spent, and whose die said it breaks. */
  | { type: "broke"; actorId: string; optionId: string; label: string; roll: number }
  /** A fake just used, found out (1.74): what it truly was, and whether it did nothing. */
  | { type: "fake"; actorId: string; optionId: string; label: string; truly: string; dud?: true }
  /** An item's gate: the check its user rolled before it could work. A failed one used it up for
   *  nothing. Shaped as a save is, with `check` naming what was rolled. */
  | {
      type: "gate";
      actorId: string;
      optionId: string;
      label: string;
      check: string;
      mode?: RulesetCombatRollMode;
      rolls: number[];
      kept: number;
      modifier: number;
      bonuses?: RulesetConditionBonus[];
      total: number;
      difficulty: number;
      success: boolean;
      pool?: RulesetCombatPoolRoll;
    }
  | {
      type: "recharge";
      actorId: string;
      optionId: string;
      label: string;
      rolls: number[];
      kept: number;
      from: number;
      /** Whether the roll brought it back. */
      back: boolean;
    }
  | { type: "signature"; actorId: string; optionId: string; label: string; cost: number; left: number }
  /** A spend that bought several strikes, and what is left of it after this one. */
  | { type: "strikes"; actorId: string; optionId: string; label: string; left: number }
  /** A budget something handed its user, and what they hold of it now. */
  | { type: "gives"; actorId: string; optionId: string; label: string; budget: string; left: number }
  /** Something that added itself to this blow. The damage it dealt is its own `damage` event, as
   *  every other clause of the blow is. */
  | { type: "rider"; actorId: string; targetId: string; riderId: string; label: string }
  | {
      type: "concentration";
      actorId: string;
      label: string;
      state: "started" | "kept" | "ended";
      reason?: "replaced" | "damage" | "down";
    }
  | { type: "standard"; actorId: string; action: string; targetId?: string }
  | {
      type: "move";
      actorId: string;
      from: RulesetCombatCell;
      to: RulesetCombatCell;
      /** Every cell walked through, the first one after the actor's own. */
      path: RulesetCombatCell[];
      /** In cells of the allowance, and what is left of it afterwards. */
      cost: number;
      left: number;
      /** How far the move got, when a strike on the way stopped it short. */
      stopped?: boolean;
    }
  /** What a summoned weapon did, from its appearance to its ending (1.117). */
  | { type: "summon"; actorId: string; label: string; outcome: "appeared" | "struck" | "ended" }
  /** A flier going up or down a level where it stands (1.109), for cells of its allowance. */
  | { type: "flew"; actorId: string; from: number; to: number; cost: number; left: number }
  /** A strike at somebody leaving this combatant's reach. The attack and the damage that follow are
   *  their own events, exactly as they are on a turn. */
  | { type: "opportunity"; actorId: string; targetId: string; label: string; budget: string }
  /** The fight was held open, and for whom. Everything those combatants then take is its own event,
   *  exactly as it is on a turn, so a log reads the window as an interruption rather than a mode. */
  | {
      type: "window";
      targetIds?: string[];
      window: string;
      kind: RulesetWindowKind;
      waiting: string[];
      moverId?: string;
      /** Which moment opened it, for the ones a reaction waits for, what is happening at it, and
       *  who is doing it. */
      moment?: RulesetReactionMoment;
      label?: string;
      sourceId?: string;
      /** For a held hit: what the roll came to, and what it was made against. */
      total?: number;
      defense?: number;
    }
  /** Somebody let their window go by without spending anything. */
  | { type: "pass"; actorId: string; window: string }
  /** An answer that stops only what was paid no higher than itself (1.111) met something higher:
   *  its level, and the check above it when the answer has one. A `cancelled` follows on a success. */
  | {
      type: "counter";
      actorId: string;
      targetId: string;
      label: string;
      level: number;
      reach: number;
      mode?: RulesetCombatRollMode;
      rolls?: number[];
      kept?: number;
      modifier?: number;
      bonuses?: RulesetConditionBonus[];
      total?: number;
      difficulty?: number;
      success: boolean;
    }
  /** A delay rolled for (1.115): `now` it goes off as made, `held` it waits for its maker's next
   *  turn; then `completed` with that turn's budget, or `lost` when they cannot. */
  | {
      type: "delay";
      actorId: string;
      label: string;
      outcome: "now" | "held" | "completed" | "lost";
      roll?: number;
      needed?: number;
    }
  /** Something held open by a window was called off, and never happened. What it cost stays spent:
   *  it was paid for before anybody was asked. */
  | { type: "cancelled"; actorId: string; optionId: string; label: string; byId: string }
  /** Both sides of a contest: what each threw, what it added and the total, and who won. What winning
   *  did follows as its own events (a condition, a push). */
  | {
      type: "contest";
      actorId: string;
      targetId: string;
      optionId: string;
      label: string;
      attacker: RulesetContestSide;
      /** With `escapeDc`, nobody threw for the holder: this side is that number and nothing else. */
      defender: RulesetContestSide;
      /** Breaking free of a hold that names what escaping it is rolled against (1.98): the actor wins
       *  on meeting it. */
      escapeDc?: number;
      winner: "actor" | "target";
    }
  /** Somebody pushed across the board by somebody else. Forced, so it spends nothing of their own
   *  allowance and draws no strike on the way. */
  /** Somebody shoved off a step of two levels or more (combat C6b), before what the fall does. */
  | { type: "fell"; targetId: string; levels: number }
  | {
      type: "pushed";
      actorId: string;
      targetId: string;
      from: RulesetCombatCell;
      to: RulesetCombatCell;
      path: RulesetCombatCell[];
    }
  /** A held attack's roll, checked again once the one it hit had answered: against what their
   *  defense then was, and whether it still lands. */
  | {
      type: "recheck";
      actorId: string;
      targetId: string;
      optionId: string;
      label: string;
      total: number;
      defense: number;
      guards?: RulesetConditionBonus[];
      outcome: RulesetCombatAttackOutcome;
    }
  /** What the ground the target stands on added to the defense the next attack is rolled against. */
  /** Cover between the target and an attack (`defense` is what it is rolled against now), or between
   *  them and where a save's action came from (`save` is the save it helps). */
  | { type: "cover"; targetId: string; bonus: number; defense?: number; save?: string }
  /** A spending blow whose dice were below the target's hardness: it landed and did nothing. */
  | { type: "hardness"; targetId: string; sourceId: string; label: string; hardness: number; dice: number }
  /** A weapon was fired: what it has loaded now (`of` its clip), or, without a clip, how many of
   *  what it shoots its holder still carries. */
  | { type: "shot"; actorId: string; optionId: string; label: string; left: number; of?: number }
  /** A clip filled, with how many of what it shoots went into it when it draws any. */
  | { type: "reload"; actorId: string; optionId: string; label: string; loaded: number; of: number; drew?: number }
  /** An item switched on or off (1.165). */
  | { type: "switch"; actorId: string; optionId: string; label: string; on: boolean }
  /** Won back after the fight: some of what was shot out of one stack. */
  | { type: "recovered"; actorId: string; label: string; count: number }
  /** Where an area landed, and the cells it covered. */
  | {
      type: "area";
      actorId: string;
      optionId: string;
      label: string;
      at: RulesetCombatCell;
      cells: RulesetCombatCell[];
    }
  | {
      type: "dying";
      actorId: string;
      rolls: number[];
      kept: number;
      difficulty: number;
      successes: number;
      failures: number;
      result: "success" | "failure" | "stable" | "dead" | "revived";
    }
  | { type: "down"; actorId: string; dying: boolean }
  | { type: "defeated"; actorId: string }
  | { type: "revived"; actorId: string; health: number }
  | { type: "outcome"; outcome: RulesetEncounterOutcome }
  | { type: "refused"; actorId: string; optionId?: string; reason: RulesetCombatRefusal };

export type RulesetEncounterOutcome = "ongoing" | "victory" | "defeat";

/** One legal thing the actor whose turn it is may do right now. Everything a player, an opponent's
 *  own choices and a forecast go through is on this menu: nothing else computes legality. */
export interface RulesetCombatOption {
  /** The holder must pass this save to cancel (1.126). */
  cancelSave?: { save: string; dc: number; label: string };
  /** The holder and condition named by an ally's shake-off option (1.120). */
  shakeOff?: { holderId: string; condition: string; name: string; label: string };
  id: string;
  /** `move` is the one a positioned fight adds: walking, and getting back up. `reload` fills a
   *  weapon's clip. */
  kind: "attack" | "ability" | "block" | "contest" | "standard" | "end-turn" | "move" | "reload" | "item" | "switch";
  label: string;
  /** Absent on "end turn", which spends nothing, and on anything that costs no budget: something
   *  the entry called free, or a strike taken out of what a spend already bought. */
  budget?: string;
  /** Strikes in hand this one would be taken out of. Present only while it costs no budget. */
  strikes?: number;
  targets: { side: "enemy" | "ally" | "self" | "any"; count: number };
  cost?: Array<{ pool: string; label: string; amount: number }>;
  /** Other pools of the same family this could be paid from instead, in declaration order. */
  payWith?: string[];
  /** What it costs in the actor's own points, and how many they have. A signature option spends no
   *  budget: it is bought at the end of somebody else's turn. */
  signature?: { cost: number; points: number };
  /** How many times this is left, for an action that counts its uses. */
  left?: number;
  /** How many of what a weapon shoots its holder carries, for one that shoots something. */
  ammo?: number;
  /** What a weapon with a clip has loaded, on its attack and on its reload. */
  loaded?: { now: number; max: number };
  /** A second attack with a weapon in the off hand, on the ruleset's off-hand budget. */
  offHand?: true;
  /** Whether the item a switch turns is on now (1.165). */
  on?: boolean;
  /** Paid out of a budget a condition grants for an attack of one strike (combat C6d, Haste's extra
   *  action): the strikes the attack would otherwise put in hand are not given. */
  oneStrike?: true;
  /** Whether the amount below is health GIVEN BACK rather than taken off. Without it a menu and an
   *  opponent's own choices cannot tell a heal from a blow, because both are an amount. */
  heals?: boolean;
  /** The pool of its target's sheet it gives back some of, so a picker can leave a full one alone. */
  restores?: string;
  /** Expected values, never a future die: `averageDamage` is the average of the amount rolled and
   *  `hitChance` the share of rolls that would land against the first legal target. A sequence
   *  forecasts the sum of its parts' damage and no single chance to hit, because its parts each
   *  roll their own. */
  forecast?: { hitChance?: number; averageDamage?: number };
  /** The initiative styles this attack may be made in, each with what it is expected to do: a style
   *  that takes says how much of the target's number it would take (`shift`), one that spends says
   *  the harm its dice would do. Present only where initiative is a number attacks move. */
  styles?: Array<{
    id: string;
    label: string;
    forecast?: { hitChance?: number; averageDamage?: number; shift?: number };
  }>;
  /** Other ways a weapon may be used for this attack, each with what it is expected to do. Only the
   *  ones its holder has the shots for. */
  modes?: Array<{
    id: string;
    label: string;
    targets: number;
    forecast?: { hitChance?: number; averageDamage?: number };
  }>;
  /** Where the `move` option may go, with what each cell costs of the allowance and who a path to
   *  it would be struck at by. */
  cells?: RulesetReachableCell[];
  /** What a `move` option that is not a step costs of the allowance: getting back up. */
  movementCost?: number;
  /** The shape this covers, in cells, and how far away it may be aimed. Present only in a
   *  positioned fight, and then the option is aimed at a cell rather than at anybody. */
  area?: { shape: RulesetCombatArea["shape"]; size: number; width?: number; range: number };
}

export interface RulesetCombatChoice {
  actorId: string;
  optionId: string;
  /** Who it is pointed at. A sequence takes the targets of all its parts in order; hand it fewer
   *  than that and every part takes the ones at the front of the list, so one id is "all of it at
   *  the same target". */
  targetIds: string[];
  /** Pay out of another pool of the same family: the upcast, under the `use` command's own rule. */
  payWith?: string;
  /** Where the `move` option is walking to. */
  to?: RulesetCombatCell;
  /** The cell an area is aimed at. An option with an area takes this instead of target ids. */
  at?: RulesetCombatCell;
  /** The window this answers, when it answers one. An answer carrying the id of a window that has
   *  already closed changes nothing: it was written for a question the fight has moved past. */
  window?: string;
  /** Which of the ruleset's initiative styles an attack is made in, where initiative is a number
   *  attacks move. The first style when left out; one the option does not offer is refused. */
  style?: string;
  /** Which of a weapon's modes it is used in. The attack as it is when left out; one the option does
   *  not offer is refused. */
  mode?: string;
}

export interface RulesetCombatStep {
  state: RulesetEncounterState;
  events: RulesetCombatEvent[];
}

export interface RulesetEncounterSummary {
  outcome: RulesetEncounterOutcome;
  rounds: number;
  party: Array<{
    id: string;
    name: string;
    health: number;
    maxHealth: number;
    temp: number;
    down: boolean;
    dying: boolean;
    /** Down and no longer being rolled for. A recap that only knew `down` and `dying` could not
     *  tell a member who has stopped slipping from one who is still on the clock. */
    stable: boolean;
    conditions: string[];
  }>;
  enemies: Array<{ id: string; name: string; health: number; maxHealth: number; defeated: boolean }>;
}
