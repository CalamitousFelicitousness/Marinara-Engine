/**
 * What a sheet works out to, kept while the Engine plans one choice, so a planner that reads the
 * same fighter's sheet for every cell, option and aim it weighs works it out once.
 *
 * Only inside `withRulesetPlanMemo`, and only for reads keyed by the very objects they read: nothing
 * changes a sheet while a choice is weighed, and everything is let go the moment the choice is made.
 * Outside a pass every read works its answer out afresh, exactly as it always has.
 */
let pass: Map<unknown, unknown> | null = null;

/** Runs `plan` with every keyed read inside it remembered until it returns. */
export function withRulesetPlanMemo<T>(plan: () => T): T {
  if (pass) return plan();
  pass = new Map();
  try {
    return plan();
  } finally {
    pass = null;
  }
}

/** `make()`, remembered under `keys` while a planning pass is open. */
export function rulesetPlanMemo<T>(keys: readonly unknown[], make: () => T): T {
  if (!pass) return make();
  let level: Map<unknown, unknown> = pass;
  for (const key of keys.slice(0, -1)) {
    let next = level.get(key) as Map<unknown, unknown> | undefined;
    if (!next) level.set(key, (next = new Map()));
    level = next;
  }
  const last = keys[keys.length - 1];
  if (level.has(last)) return level.get(last) as T;
  const made = make();
  level.set(last, made);
  return made;
}
