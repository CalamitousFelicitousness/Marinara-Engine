import { ENEMY_AI_VARIATION, type GameDifficulty } from "./combat-conditions.js";
import { z } from "zod";
import type { CombatSkill, CombatStatusEffect } from "../types/game.js";

import { COMBAT_MINDS, COMBAT_ROLES, COMBAT_TEMPERAMENTS, type CombatMind } from "./combat-minds.js";
export {
  COMBAT_MINDS,
  COMBAT_ROLES,
  COMBAT_TEMPERAMENTS,
  type CombatMind,
  type CombatRole,
  type CombatTemperament,
} from "./combat-minds.js";
export const COMBAT_ADJECTIVES = ["mindless", ...COMBAT_TEMPERAMENTS] as const;
/** The temperaments an animal's nature may have: none that plans. */
const INSTINCT_ADJECTIVES: readonly (typeof COMBAT_ADJECTIVES)[number][] = [
  "reckless",
  "cautious",
  "opportunistic",
  "protective",
  "cowardly",
  "coordinated",
];
export const combatAiHintsSchema = z.object({
  category: z.enum(["beast", "monstrosity", "other", "unknown"]).optional(),
  proficiency: z.enum(["novice", "trained", "veteran", "master"]).optional(),
  temperament: z.enum(COMBAT_ADJECTIVES).optional(),
  /** Its mind, where the story says what the creature's own data cannot: one dominated, one enraged. */
  mind: z.enum(COMBAT_MINDS).optional(),
  /** A named individual of the story rather than a nameless foe (combat AI P9): one the Game Master
   *  may play itself, as it plays a boss. */
  named: z.boolean().optional(),
});
export const combatTacticsSchema = z
  .object({
    version: z.literal(1),
    seed: z.number().int().min(0).max(0xffffffff),
    category: z.enum(["beast", "monstrosity", "other", "unknown"]),
    proficiency: z.enum(["novice", "trained", "veteran", "master"]),
    role: z.enum(COMBAT_ROLES),
    adjective: z.enum(COMBAT_ADJECTIVES),
    targetId: z.string().max(256).optional(),
    holds: z.number().int().min(0).max(2).optional(),
    /** Its mind (see `COMBAT_MINDS`); one saved before minds were read is played as `tactical`. */
    mind: z.enum(COMBAT_MINDS).optional(),
    /** It has made its opening move (a ruleset creature's `behavior.opens`, 1.710). */
    opened: z.literal(true).optional(),
    /** It lay in wait and has sprung (a ruleset creature's `behavior.ambush`, 1.710). */
    sprung: z.literal(true).optional(),
    /** Its role was read off what its ruleset sheet or block can do (1.710). */
    roleRead: z.literal(true).optional(),
    /** Turns in a row it spent dodging, getting away or hiding: two, and it fights again, so two
     *  careful sides never stare at each other all fight. */
    wary: z.number().int().min(0).max(99).optional(),
  })
  .superRefine((value, ctx) => {
    // A mindless creature has no temperament but its own, and nothing else is mindless.
    if ((value.mind === "mindless") !== (value.adjective === "mindless") && value.mind !== undefined) {
      ctx.addIssue({ code: "custom", path: ["adjective"], message: "Only a mindless creature is Mindless." });
    }
  });
export type CombatTactics = z.infer<typeof combatTacticsSchema>;
/**
 * Where a companion the Engine plays stands in a fight, as its player orders: `guard` the leader (a
 * companion's default), `follow` the leader onto whoever they are attacking, `protect` one friend
 * (`protectId`), `hold` its ground, stay `back` out of harm's way, or `retreat` from the fight.
 */
export const COMBAT_POSTURES = ["guard", "follow", "protect", "hold", "back", "retreat"] as const;
export type CombatPosture = (typeof COMBAT_POSTURES)[number];
/** A companion's standing orders: its posture, and whether it keeps its best for when it matters
 *  (`conserve`), heals and helps before anything else (`heal`), and beats opponents without killing
 *  them (`spare`). */
export const combatOrdersSchema = z
  .object({
    posture: z.enum(COMBAT_POSTURES).optional(),
    protectId: z.string().min(1).max(256).optional(),
    conserve: z.boolean().optional(),
    heal: z.boolean().optional(),
    spare: z.boolean().optional(),
  })
  .strict()
  .refine((orders) => (orders.posture === "protect") === (orders.protectId !== undefined), {
    message: "Protect names whom, and only protect does.",
    path: ["protectId"],
  });
export type CombatOrders = z.infer<typeof combatOrdersSchema>;
export type CombatAiHints = z.infer<typeof combatAiHintsSchema>;
export type CombatController = "manual" | "ai";

export interface AiCombatant {
  id: string;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  level: number;
  mp?: number;
  maxMp?: number;
  skills?: CombatSkill[];
  statusEffects?: CombatStatusEffect[];
  combatClass?: string;
  tactics?: CombatTactics;
  aiHints?: CombatAiHints;
  /** Its player's standing orders, for a companion the Engine plays. */
  orders?: CombatOrders;
}

/** Domain-separated deterministic choices, independent of combat rolls. */
export function combatAiHash(value: string): number {
  let hash = 2166136261;
  for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/**
 * A combatant's profile, made once and kept. `mind` is what its own data says it is (a ruleset's
 * creature, see `rulesetCombatantMind`); the Game Master's hint wins over it, and with neither an
 * animal (`category` beast) is `instinct` and anything else plays as `tactical`.
 */
export function assignCombatTactics(unit: AiCombatant, seed: number, mind?: CombatMind): CombatTactics {
  const hints = combatAiHintsSchema.parse(unit.aiHints ?? {});
  if (unit.tactics) return combatTacticsSchema.parse(unit.tactics);
  const minded: CombatMind =
    hints.mind ??
    (hints.temperament === "mindless" ? "mindless" : undefined) ??
    mind ??
    (hints.category === "beast" ? "instinct" : "tactical");
  const skills = unit.skills ?? [];
  const support = skills.some((s) => s.type === "heal" || s.type === "buff");
  const control = skills.some((s) => s.type === "debuff");
  const role: CombatTactics["role"] = support
    ? "supporter"
    : control
      ? "controller"
      : unit.combatClass === "mage"
        ? "spellcaster"
        : unit.combatClass === "archer"
          ? "marksman"
          : unit.combatClass === "knight"
            ? "bulwark"
            : unit.combatClass === "rogue"
              ? "skirmisher"
              : skills.some((s) => s.element && s.type === "attack")
                ? "spellcaster"
                : "bruiser";
  const trained =
    hints.proficiency ??
    (unit.level >= 15 ? "master" : unit.level >= 8 ? "veteran" : unit.level >= 3 ? "trained" : "novice");
  // A genius is never less than a veteran at it.
  const proficiency: CombatTactics["proficiency"] =
    minded === "genius" && (trained === "novice" || trained === "trained") ? "veteran" : trained;
  const competence = ["novice", "trained", "veteran", "master"].indexOf(proficiency) / 3;
  const suited: Record<CombatTactics["role"], readonly CombatTactics["adjective"][]> = {
    bruiser: ["reckless", "disciplined", "opportunistic"],
    bulwark: ["protective", "patient", "disciplined"],
    skirmisher: ["opportunistic", "cautious", "coordinated"],
    marksman: ["patient", "cautious", "coordinated"],
    spellcaster: ["methodical", "cautious", "disciplined"],
    supporter: ["supportive", "protective", "coordinated"],
    controller: ["methodical", "coordinated", "disciplined"],
  };
  const weighted = COMBAT_ADJECTIVES.filter(
    (a) =>
      a !== "mindless" && (a !== "supportive" || support) && (minded !== "instinct" || INSTINCT_ADJECTIVES.includes(a)),
  ).map((adjective) => ({
    adjective,
    weight: 1 + (suited[role].includes(adjective) ? 2 + 4 * competence : 0) + (hints.temperament === adjective ? 8 : 0),
  }));
  let draw =
    (combatAiHash(`assignment:${seed}:${unit.id}`) / 0x100000000) * weighted.reduce((sum, p) => sum + p.weight, 0);
  let adjective: CombatTactics["adjective"] = "disciplined";
  for (const p of weighted) {
    draw -= p.weight;
    if (draw < 0) {
      adjective = p.adjective;
      break;
    }
  }
  const category = hints.category ?? "unknown";
  if (minded === "mindless") adjective = "mindless";
  return { version: 1, seed: seed >>> 0, category, proficiency, role, adjective, mind: minded };
}

/** Mode adapters enumerate only actions their resolver can actually execute. */
export interface CombatAiCandidate<T> {
  action: T;
  targetId?: string;
  damage?: number;
  finish?: number;
  healing?: number;
  support?: number;
  setup?: number;
  risk?: number;
  cost?: number;
  protection?: number;
  coordination?: number;
  /** What its own data says it goes for first (a ruleset creature's `behavior`, 1.710). */
  focus?: number;
  hold?: boolean;
}

export function combatAiScoreNoise(
  profile: CombatTactics,
  id: string,
  turn: number | string,
  index: number,
  difficulty: GameDifficulty = "normal",
): number {
  const trained = profile.proficiency === "novice" ? 0.12 : profile.proficiency === "trained" ? 0.07 : 0.02;
  // What it is adds to how well it was trained: an animal's choices wander, a genius's do not.
  const variation =
    profile.mind === "instinct"
      ? trained + 0.06
      : profile.mind === "cunning"
        ? trained + 0.03
        : profile.mind === "genius"
          ? trained / 2
          : trained;
  return (
    (variation * ENEMY_AI_VARIATION[difficulty] * combatAiHash(`${index}:decision:${profile.seed}:${id}:${turn}`)) /
    0x100000000
  );
}

export function chooseCombatCandidate<T>(
  unit: AiCombatant,
  candidates: CombatAiCandidate<T>[],
  turn: number,
  difficulty: GameDifficulty = "normal",
  /** Its standing orders: its own unless its caller worked out a companion's default. */
  orders: CombatOrders | undefined = unit.orders,
): T {
  if (!candidates.length) throw new Error("AI needs at least one legal action.");
  const profile = unit.tactics!;
  const adjective = profile.adjective;
  const wounded = unit.hp / Math.max(1, unit.maxHp) < 0.35;
  const weights = {
    damage: adjective === "reckless" ? 2 : 1,
    finish: adjective === "opportunistic" ? 3 : 0.5,
    healing: adjective === "supportive" ? 4 : adjective === "reckless" ? 0.4 : 1.5,
    support: adjective === "supportive" ? 1.2 : 0.35,
    setup: adjective === "methodical" ? 1.6 : 0.2,
    risk:
      adjective === "reckless" ? 0.05 : adjective === "cautious" ? 2 : adjective === "cowardly" && wounded ? 5 : 0.6,
    cost: adjective === "reckless" ? 0 : adjective === "cautious" ? 0.6 : 0.2,
    protection: adjective === "protective" ? 2 : 0,
    coordination: adjective === "coordinated" ? 1.5 : 0,
    focus: 1,
  };
  // What it is bends how it weighs things. A mindless creature knows only to hit; an animal drags down
  // the weakest and minds its own hide once hurt; a genius never ignores the danger it stands in.
  if (profile.mind === "mindless")
    Object.assign(weights, {
      finish: 0,
      healing: 0,
      support: 0,
      setup: 0,
      risk: 0,
      cost: 0,
      protection: 0,
      coordination: 0,
      focus: 0,
    });
  else if (profile.mind === "instinct") {
    weights.finish *= 2;
    weights.setup = Math.min(weights.setup, 0.1);
    if (wounded) weights.risk = Math.max(weights.risk, 3);
  } else if (profile.mind === "genius") weights.risk = Math.max(weights.risk, 0.8);
  // What its player told it: keep the best for later, heal first, beat without killing, keep out of
  // harm's way, or get out of the fight.
  if (orders?.conserve) weights.cost = Math.max(weights.cost, 1.2);
  if (orders?.heal) {
    weights.healing *= 2.5;
    weights.support *= 2;
  }
  if (orders?.spare) weights.finish = 0;
  if (orders?.posture === "back") weights.risk = Math.max(weights.risk, 2.5);
  if (orders?.posture === "retreat") {
    weights.risk = Math.max(weights.risk, 5);
    weights.damage *= 0.25;
  }
  const scores = candidates
    .map((candidate, i) => {
      let score =
        (candidate.damage ?? 0) * weights.damage +
        (candidate.finish ?? 0) * weights.finish +
        (candidate.healing ?? 0) * weights.healing +
        (candidate.support ?? 0) * weights.support +
        (candidate.setup ?? 0) * weights.setup -
        (candidate.risk ?? 0) * weights.risk -
        (candidate.cost ?? 0) * weights.cost +
        (candidate.protection ?? 0) * weights.protection +
        (candidate.coordination ?? 0) * weights.coordination +
        (candidate.focus ?? 0) * weights.focus;
      if (adjective === "methodical" && profile.targetId !== undefined && candidate.targetId === profile.targetId)
        score += 0.35;
      if (candidate.hold && orders?.posture === "retreat") score += 0.8;
      if (candidate.hold && (profile.holds ?? 0) < 1 && profile.mind !== "mindless") {
        if (adjective === "patient") score += 0.65;
        if (adjective === "cowardly" && wounded) score += 0.8;
      }
      score += combatAiScoreNoise(profile, unit.id, turn, i, difficulty);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);
  const chosen = scores[0]!.candidate;
  profile.holds = chosen.hold ? Math.min(2, (profile.holds ?? 0) + 1) : 0;
  if (chosen.targetId) profile.targetId = chosen.targetId;
  return chosen.action;
}
