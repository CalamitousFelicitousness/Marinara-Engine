/**
 * How much thought a combatant puts into a fight, read off what it is rather than what it looks like:
 * `mindless` (a zombie, a golem, an ooze) goes at whoever is nearest and never gives ground;
 * `instinct` (a wolf, a bear) fights by its nature, the weakest and nearest first, and runs when hurt;
 * `cunning` (a goblin, an ogre) knows the basics; `tactical` plays the fight; `genius` (a lich, an
 * ancient dragon) plays it best of all. On its own so the ruleset schema may read it.
 */
export const COMBAT_MINDS = ["mindless", "instinct", "cunning", "tactical", "genius"] as const;
export type CombatMind = (typeof COMBAT_MINDS)[number];
