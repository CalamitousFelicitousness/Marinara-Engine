// The combat-style seam (issue #8109): the game surface asks the active style how to start, draw and
// lay out a battle, and Classic and Tactical are registered through that same seam.
//
// What it pins: both built-in styles are known and cannot be replaced; an id this client has not
// registered plays as classic; a registered style is listed, resolved and removed again by the
// function its registration returned (and a later registration under the same id survives the
// earlier one's removal); only Tactical takes the top chrome; and the game surface reaches the
// battle UI, the top-chrome offset, the active check and the start of a fight through the seam
// rather than by naming a style.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCombatStyle,
  isBuiltInCombatStyle,
  listCombatStyles,
  registerCombatStyle,
  resolveCombatStyle,
  type CombatStyleSurface,
} from "../../packages/client/src/components/game/combat-styles.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

// Built-ins.
assert.deepEqual(listCombatStyles(), ["classic", "tactical"]);
assert.equal(isBuiltInCombatStyle("classic"), true);
assert.equal(isBuiltInCombatStyle("tactical"), true);
assert.equal(isBuiltInCombatStyle("duel"), false);
assert.equal(isBuiltInCombatStyle(undefined), false);
assert.equal(resolveCombatStyle("tactical"), "tactical");
assert.equal(resolveCombatStyle(undefined), "classic");
assert.equal(resolveCombatStyle(null), "classic");
assert.equal(resolveCombatStyle(""), "classic");
assert.equal(resolveCombatStyle("duel"), "classic", "an unregistered id plays as classic");
assert.equal(getCombatStyle("duel"), getCombatStyle("classic"));
assert.equal(getCombatStyle("tactical").ownsTopChrome, true);
assert.notEqual(getCombatStyle("classic").ownsTopChrome, true);
assert.equal(getCombatStyle("classic").start, undefined, "classic keeps the generation pass");
assert.equal(getCombatStyle("tactical").start, undefined, "tactical keeps the generation pass");
assert.equal(getCombatStyle("classic").isActive, undefined);
assert.equal(getCombatStyle("tactical").isActive, undefined);
assert.throws(() => registerCombatStyle("classic", { render: () => null }), /cannot be replaced/);
assert.throws(() => registerCombatStyle("tactical", { render: () => null }), /cannot be replaced/);

// A registered style.
const duel: CombatStyleSurface = { label: "Duel", ownsTopChrome: true, render: () => null };
const unregister = registerCombatStyle("duel", duel);
assert.deepEqual(listCombatStyles(), ["classic", "tactical", "duel"]);
assert.equal(resolveCombatStyle("duel"), "duel");
assert.equal(getCombatStyle("duel"), duel);
unregister();
assert.equal(resolveCombatStyle("duel"), "classic");
assert.deepEqual(listCombatStyles(), ["classic", "tactical"]);

// Re-registration: removing the first leaves the second.
const first: CombatStyleSurface = { render: () => null };
const second: CombatStyleSurface = { render: () => null };
const unregisterFirst = registerCombatStyle("duel", first);
const unregisterSecond = registerCombatStyle("duel", second);
unregisterFirst();
assert.equal(getCombatStyle("duel"), second);
unregisterSecond();
assert.equal(resolveCombatStyle("duel"), "classic");

// The game surface goes through the seam.
const surface = readSource("packages/client/src/components/game/GameSurface.tsx");
assert.match(surface, /combatStyleSurface\.render\(combatSurfaceContext\)/);
assert.match(surface, /combatStyleSurface\.ownsTopChrome/);
assert.match(surface, /combatStyleSurface\.start\?\.\(/);
assert.match(surface, /combatStyleSurface\.isActive\?\.\(/);
assert.doesNotMatch(surface, /<TacticalCombatUI\b/, "the tactical UI is mounted by its style, not the surface");
assert.doesNotMatch(surface, /<GameCombatUI\b/, "the classic UI is mounted by its style, not the surface");
assert.doesNotMatch(surface, /tacticalCombatActive/);

console.log("combat-style-registry regression passed");
