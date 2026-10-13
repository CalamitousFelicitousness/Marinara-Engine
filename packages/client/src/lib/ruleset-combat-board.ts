// What a positioned ruleset fight's board shows, with no React in it.
//
// The server sends the whole board: the terrain, where everybody stands, which cells the walk may
// end on and what each one costs, who a path would be struck at by, who an option may be pointed
// at, and which cells a shape may be aimed at with everybody each aim would catch. Nothing here
// measures a distance, decides who may be hit or works out whether a step is legal: it reads the
// view, indexes it by cell, and hands a component one row per square.
//
// The one number this file turns into another is the ruleset's own: a count of cells becomes the
// ruleset's own distance by its own `perCell`, so the screen says "20 ft" or "8 paces" rather than
// a cell count nobody at the table would recognise.
import type {
  DirectedRulesetCombatant,
  DirectedRulesetOption,
  DirectedRulesetView,
  RulesetCombatCell,
  TacticalTerrain,
} from "@marinara-engine/shared";
import { TERRAIN_DATA } from "@marinara-engine/shared";
import type { TFunction } from "i18next";
import type { RulesetAimLay, RulesetMenuStep } from "./ruleset-combat-menu";

/** What this ruleset calls one cell's worth of distance. */
export type RulesetBoardDistance = { label: string; perCell: number };

/** One square of a board, ready to draw. Every flag came off the view. */
export interface RulesetBoardCell {
  x: number;
  y: number;
  terrain: TacticalTerrain;
  /** Nothing walks into it and nothing sees through it. From the Engine's own terrain table, which
   *  is the same table the server's own reachable cells were worked out from. */
  solid: boolean;
  /** How high the cell stands (combat C6b), 0 on level ground. */
  height: number;
  /** Who is standing here, defeated or not. */
  occupant?: DirectedRulesetCombatant;
  /** Set while a walk is being chosen: what ending here costs of the allowance, in cells, and the
   *  ids of the standing enemies the path would be struck at by. */
  reach?: { cost: number; provokes: string[] };
  /** Set while a target is being chosen and a legal one stands here. */
  targetable?: boolean;
  /** Set while a shape is being aimed: the ids this aim would catch, which may be nobody. */
  aim?: { targetIds: string[] };
  /** A cell the shape being laid has already been set down on (1.176, 1.177). */
  laid?: true;
  /** The labels of the lasting areas covering it (1.171), first cast first. */
  zones?: string[];
}

export const rulesetCellKey = (cell: { x: number; y: number }): string => `${cell.x},${cell.y}`;

/** Whether taking this option on a board asks the player to aim it at a cell rather than at anybody.
 *  Every shape does, one with nowhere to land included: the server refuses a shape sent with no
 *  cell, so the step opens and says nobody would be caught instead of sending a choice that fails. */
export function rulesetOptionNeedsAim(option: DirectedRulesetOption): boolean {
  return !!option.area;
}

/** Whether a shape has any square it may be aimed at right now. */
export function rulesetOptionHasAim(option: DirectedRulesetOption): boolean {
  return (option.aim?.length ?? 0) > 0;
}

/** What an aimed shape sends: where it lands, and how it is laid (1.176, 1.177). */
export interface RulesetAimChoice {
  at: RulesetCombatCell;
  toward?: RulesetCombatCell;
  side?: "near" | "far";
  ring?: boolean;
  also?: RulesetCombatCell[];
}

/** The cells a choice made on the board carries: where a walk goes, or where a shape lands and how
 *  it is laid. */
export type RulesetCellChoice = { to?: RulesetCombatCell } & Partial<RulesetAimChoice>;

/** Whether a wall being aimed has been set down and waits for the way it runs: any cell picks it. */
export function rulesetAimTurning(option: DirectedRulesetOption, lay: RulesetAimLay | undefined): boolean {
  return option.area?.shape === "wall" && !lay?.ring && !!lay?.at;
}

/** What is sent for the shape as it is laid so far, or null while nothing has been set down. */
export function rulesetAimSoFar(lay: RulesetAimLay | undefined): RulesetAimChoice | null {
  if (!lay?.at) return null;
  return {
    at: { ...lay.at },
    ...(lay.side ? { side: lay.side } : {}),
    ...(lay.ring ? { ring: true } : {}),
    ...(lay.also?.length ? { also: lay.also.map((cell) => ({ ...cell })) } : {}),
  };
}

/**
 * Picking a cell while a shape is aimed. Most shapes are sent there and then. A wall is set down on
 * the first cell and turned by the second, which is the cell it runs toward (the first again lays
 * it across its maker's line); a ring is sent at once. A shape set down several times (1.177) takes
 * one cell for each copy, and is sent with the last one it may have.
 */
export function rulesetAimTake(
  option: DirectedRulesetOption,
  lay: RulesetAimLay | undefined,
  cell: RulesetCombatCell,
): { send: RulesetAimChoice } | { lay: RulesetAimLay } {
  const at = { x: cell.x, y: cell.y };
  const area = option.area;
  if (area?.shape === "wall") {
    if (lay?.ring) return { send: { ...rulesetAimSoFar({ ...lay, at })!, ring: true } };
    if (!lay?.at) return { lay: { ...lay, at } };
    const across = lay.at.x === at.x && lay.at.y === at.y;
    return { send: { ...rulesetAimSoFar(lay)!, ...(across ? {} : { toward: at }) } };
  }
  if ((area?.copies ?? 1) > 1) {
    if (!lay?.at) return { lay: { ...lay, at } };
    const taken = [lay.at, ...(lay.also ?? [])].some((one) => one.x === at.x && one.y === at.y);
    if (taken) return { lay };
    const next = { ...lay, also: [...(lay.also ?? []), at] };
    return 1 + next.also.length >= area!.copies! ? { send: rulesetAimSoFar(next)! } : { lay: next };
  }
  return { send: { at } };
}

/** Whether taking this option asks the player to pick a cell to walk to. Getting back up spends
 *  movement and goes nowhere, so it is sent straight off the menu. */
export function rulesetOptionNeedsCell(option: DirectedRulesetOption): boolean {
  return option.kind === "move" && (option.cells?.length ?? 0) > 0;
}

/**
 * Every square of the board, in reading order, with whatever the half-made choice highlights.
 *
 * `step` is the menu's own half-made choice: while a walk is being chosen the reachable cells carry
 * their cost, while a target is being chosen the cells the legal targets stand on are marked, and
 * while a shape is being aimed every cell it may be aimed at carries who it would catch.
 */
export function rulesetBoardCells(view: DirectedRulesetView, step: RulesetMenuStep | null): RulesetBoardCell[] {
  const grid = view.grid;
  if (!grid) return [];
  const standing = new Map<string, DirectedRulesetCombatant>();
  for (const combatant of view.combatants) {
    if (typeof combatant.x !== "number" || typeof combatant.y !== "number") continue;
    standing.set(rulesetCellKey({ x: combatant.x, y: combatant.y }), combatant);
  }
  const reach = new Map<string, { cost: number; provokes: string[] }>();
  if (step?.stage === "move") {
    for (const cell of step.option.cells ?? []) {
      reach.set(rulesetCellKey(cell), { cost: cell.cost, provokes: [...cell.provokes] });
    }
  }
  const aims = new Map<string, { targetIds: string[] }>();
  const laid = new Set<string>();
  if (step?.stage === "aim") {
    for (const entry of step.option.aim ?? []) aims.set(rulesetCellKey(entry), { targetIds: [...entry.targetIds] });
    for (const cell of [step.lay?.at, ...(step.lay?.also ?? [])]) if (cell) laid.add(rulesetCellKey(cell));
  }
  const targets = new Set(step?.stage === "target" ? step.option.targetIds : []);
  const zoned = new Map<string, string[]>();
  for (const zone of view.zones ?? []) {
    for (const cell of zone.cells) {
      const key = rulesetCellKey(cell);
      zoned.set(key, [...(zoned.get(key) ?? []), zone.label]);
    }
    // A wall's side (1.176) is drawn as the zone's too: walking there is caught as it says.
    for (const cell of zone.side ?? []) {
      const key = rulesetCellKey(cell);
      zoned.set(key, [...(zoned.get(key) ?? []), zone.label]);
    }
  }
  const cells: RulesetBoardCell[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      // A row the board is shorter than is drawn as plains rather than crashing the screen: the
      // route bounds the saved shape, and a screen is not the place to find out it did not.
      const terrain = grid.tiles[y]?.[x] ?? "plains";
      const key = rulesetCellKey({ x, y });
      const occupant = standing.get(key);
      const aim = aims.get(key);
      cells.push({
        x,
        y,
        terrain,
        // A standing wall that blocks movement is as solid as rock while it stands (1.176).
        solid: TERRAIN_DATA[terrain]?.impassable === true || ((grid.walls?.[key] ?? 0) & 1) === 1,
        height: grid.elevation?.[y]?.[x] ?? 0,
        ...(occupant ? { occupant } : {}),
        ...(reach.has(key) ? { reach: reach.get(key)! } : {}),
        ...(occupant && targets.has(occupant.id) ? { targetable: true } : {}),
        ...(aim ? { aim } : {}),
        ...(laid.has(key) ? { laid: true as const } : {}),
        ...(zoned.has(key) ? { zones: zoned.get(key)! } : {}),
      });
    }
  }
  return cells;
}

/** The cells a walk to this one passes through, from the one after the actor's own up to it, or an
 *  empty path for a cell the walk was never offered. */
export function rulesetPathTo(step: RulesetMenuStep | null, cell: { x: number; y: number }): RulesetCombatCell[] {
  if (step?.stage !== "move") return [];
  const key = rulesetCellKey(cell);
  return (step.option.cells ?? []).find((entry) => rulesetCellKey(entry) === key)?.path ?? [];
}

/** A count of cells said in the ruleset's own distance: "20 ft", "8 paces". Without a board there
 *  is no unit to say it in, so the count is printed as it stands. */
export function rulesetDistanceText(cells: number, distance: RulesetBoardDistance | undefined, t: TFunction): string {
  if (!distance) return String(cells);
  return t("game.combat.ruleset.board.distance", { amount: cells * distance.perCell, unit: distance.label });
}

/**
 * Whether this fight offers nothing that can be pointed at the other side, while the other side is
 * still standing. It is the one line the board says out loud, because a menu with an attack on it
 * that can be pointed at nobody reads as a bug rather than as "you are too far away".
 *
 * Only in a positioned fight, and only about options that COULD reach an opponent: a heal with
 * nobody hurt to point it at says nothing about how far away the enemy is.
 */
export function rulesetNothingInReach(view: DirectedRulesetView): boolean {
  if (!view.grid || !view.options) return false;
  if (!view.combatants.some((combatant) => combatant.side === "enemy" && !combatant.defeated)) return false;
  const offensive = view.options.filter(
    (option) =>
      (option.kind === "attack" ||
        option.kind === "ability" ||
        option.kind === "item" ||
        option.kind === "block" ||
        option.kind === "contest") &&
      (option.targets.side === "enemy" || option.targets.side === "any" || !!option.area),
  );
  if (offensive.length === 0) return false;
  return offensive.every((option) => option.targetIds.length === 0 && (option.aim?.length ?? 0) === 0);
}

/** The ids on a line, as names, for the sentences that have to say who. */
export function rulesetNamesOf(view: DirectedRulesetView, ids: readonly string[]): string[] {
  const names = new Map(view.combatants.map((combatant) => [combatant.id, combatant.name]));
  return ids.flatMap((id) => {
    const name = names.get(id);
    return name ? [name] : [];
  });
}

/**
 * What one square says, in whole sentences: the terrain, who is standing on it, and whatever the
 * half-made choice makes of it. It is the square's accessible name and the line under the board at
 * once, so a player reading with their eyes and a player reading with a screen reader are told the
 * same things in the same words.
 *
 * The terrain words are the Tactical board's own, because it is the same terrain of the same
 * battlefield and translating it twice would let the two boards disagree.
 */
export function rulesetCellSentences(cell: RulesetBoardCell, view: DirectedRulesetView, t: TFunction): string[] {
  const said: string[] = [
    t("game.combat.ruleset.board.terrain", {
      label: t(`ui.game.tacticalcombatui.terrain.${cell.terrain}`, { defaultValue: cell.terrain }),
    }),
  ];
  if (cell.height > 0) said.push(t("game.combat.ruleset.board.height", { height: cell.height }));
  // Water is walked round but seen across; a wall or a mountain is neither (combat C6).
  if (cell.solid)
    said.push(
      t(
        TERRAIN_DATA[cell.terrain]?.blocksSight
          ? "game.combat.ruleset.board.solid"
          : "game.combat.ruleset.board.seenAcross",
      ),
    );
  const who = cell.occupant;
  if (who) {
    said.push(t("game.combat.ruleset.board.who", { name: who.name, value: who.health.value, max: who.health.max }));
    if (who.altitude !== undefined) said.push(t("game.combat.ruleset.board.flying", { height: who.altitude }));
    if (who.id === view.actorId) said.push(t("game.combat.ruleset.board.onTurn"));
    if (who.defeated) said.push(t("game.combat.ruleset.status.defeated"));
    else if (who.down) said.push(t("game.combat.ruleset.status.down"));
  }
  if (cell.reach) {
    said.push(
      t("game.combat.ruleset.board.reachable", {
        amount: rulesetDistanceText(cell.reach.cost, view.grid?.distance, t),
      }),
    );
    if (cell.reach.provokes.length > 0) {
      said.push(
        t("game.combat.ruleset.board.provokes", { names: rulesetNamesOf(view, cell.reach.provokes).join(", ") }),
      );
    }
  }
  if (cell.targetable) said.push(t("game.combat.ruleset.board.targetable"));
  if (cell.aim) {
    const names = rulesetNamesOf(view, cell.aim.targetIds);
    said.push(
      names.length > 0
        ? t("game.combat.ruleset.board.aimable", { names: names.join(", ") })
        : t("game.combat.ruleset.board.aimableEmpty"),
    );
  }
  return said;
}

/** How full a health bar is drawn, as a percentage. Presentation only: the two numbers were both
 *  sent by the server and neither is changed here. */
export function rulesetHealthPercent(health: { value: number; max: number }): number {
  if (health.max <= 0) return 0;
  return Math.max(0, Math.min(100, (health.value / health.max) * 100));
}
