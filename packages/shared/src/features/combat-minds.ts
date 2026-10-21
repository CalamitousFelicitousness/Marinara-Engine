/**
 * How much thought a combatant puts into a fight, read off what it is rather than what it looks like:
 * `mindless` (a zombie, a golem, an ooze) goes at whoever is nearest and never gives ground;
 * `instinct` (a wolf, a bear) fights by its nature, the weakest and nearest first, and runs when hurt;
 * `cunning` (a goblin, an ogre) knows the basics; `tactical` plays the fight; `genius` (a lich, an
 * ancient dragon) plays it best of all. On its own so the ruleset schema may read it.
 */
export const COMBAT_MINDS = ["mindless", "instinct", "cunning", "tactical", "genius"] as const;
export type CombatMind = (typeof COMBAT_MINDS)[number];

/** How a combatant that thinks at all goes about a fight: what weighs most with it. */
export const COMBAT_TEMPERAMENTS = [
  "reckless",
  "cautious",
  "opportunistic",
  "protective",
  "supportive",
  "disciplined",
  "cowardly",
  "patient",
  "methodical",
  "coordinated",
] as const;
export type CombatTemperament = (typeof COMBAT_TEMPERAMENTS)[number];

/** What a combatant is for in a fight. */
export const COMBAT_ROLES = [
  "bruiser",
  "bulwark",
  "skirmisher",
  "marksman",
  "spellcaster",
  "supporter",
  "controller",
] as const;
export type CombatRole = (typeof COMBAT_ROLES)[number];
