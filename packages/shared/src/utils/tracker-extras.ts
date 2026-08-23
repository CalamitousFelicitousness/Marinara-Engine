// ──────────────────────────────────────────────
// Tracker extras: nested per-character data the agent emits
// ──────────────────────────────────────────────
// A custom Character Tracker prompt can define a richer schema than
// `PresentCharacter` knows about: clothing layers, body state, action traces.
// The agent's output was already being persisted verbatim into the snapshot;
// only `customFields` and `stats` were ever read back, so everything else was
// invisible and, on any turn the agent omitted it, silently lost.
//
// These helpers treat every unrecognized key on a character as an "extra", a
// JSON tree that is rendered, edited, locked, and preserved on omission using
// the same dotted lock-key scheme the flat fields already use.
/**
 * Lock-key segment encoding. Deliberately a copy of the private `encodeSegment`
 * in `tracker-field-locks.ts` rather than an import: that module imports this
 * one, and closing the cycle risks a bundler TDZ failure for no benefit. The
 * two are pinned equal by tracker-extras.regression.ts.
 */
function encodeSegment(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return encodeURIComponent(text || "_").replace(/\./g, "%2E");
}

/**
 * Keys `PresentCharacter` renders natively. Everything else is an extra.
 *
 * Deliberately a denylist rather than requiring a container object: existing
 * custom prompts already emit their schema at the top level of each character,
 * so demanding `extras: { ... }` would break every prompt already in use.
 */
export const KNOWN_PRESENT_CHARACTER_KEYS: ReadonlySet<string> = new Set([
  "characterId",
  "name",
  "emoji",
  "action",
  "mood",
  "appearance",
  "outfit",
  "avatarPath",
  "avatarCrop",
  "portraitFocusX",
  "portraitFocusY",
  "portraitZoom",
  "customFields",
  "stats",
  "thoughts",
]);

/** Guards against a pathological tree from a misbehaving prompt. */
export const TRACKER_EXTRA_MAX_DEPTH = 8;

export type TrackerExtraPath = ReadonlyArray<string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Extras carried by one character, in the order the agent emitted them. */
export function readCharacterExtras(character: unknown): Record<string, unknown> {
  if (!isRecord(character)) return {};
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(character)) {
    if (KNOWN_PRESENT_CHARACTER_KEYS.has(key)) continue;
    if (value === undefined) continue;
    extras[key] = value;
  }
  return extras;
}

/**
 * Lock key for one node of an extras tree.
 *
 * `prefix` is `characterTrackerLockPrefix(...)`. The `extra` segment keeps this
 * namespace clear of `custom` (flat custom fields) and `stats`, so a prompt that
 * names an extra "stats" cannot collide with the real stat locks.
 */
export function trackerExtraLockKey(prefix: string, path: TrackerExtraPath): string {
  const segments = path.map((segment) => (typeof segment === "number" ? String(segment) : encodeSegment(segment)));
  return [prefix, "extra", ...segments].join(".");
}

/** A leaf is anything the UI can show on one row. */
export function isTrackerExtraLeaf(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

/**
 * Deep-merge the agent's extras over the previous ones.
 *
 * Preserve-on-omission, matching how `customFields` and `stats` already behave:
 * a key the agent did not mention keeps its previous value rather than
 * vanishing. Arrays take their **length** from the agent, which is authoritative
 * about list membership (a discarded shoe really is gone), but each surviving
 * element is merged by index so an element's unmentioned sub-keys persist.
 *
 * A type change replaces wholesale; merging a string over an object has no
 * sensible meaning.
 */
export function mergeTrackerExtras(previous: unknown, next: unknown, depth = 0): unknown {
  if (next === undefined) return previous;
  if (depth >= TRACKER_EXTRA_MAX_DEPTH) return next;

  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    return next.map((item, index) => mergeTrackerExtras(previous[index], item, depth + 1));
  }

  if (isRecord(next)) {
    if (!isRecord(previous)) return next;
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(next)) {
      merged[key] = mergeTrackerExtras(previous[key], value, depth + 1);
    }
    return merged;
  }

  return next;
}

/**
 * Restore every locked leaf from the previous tree.
 *
 * Locks apply to leaves, and to whole subtrees through the prefix: locking
 * `clothing` freezes everything under it, which is what a user who locked a
 * section header expects.
 */
export function applyTrackerExtraLocks(
  previous: unknown,
  next: unknown,
  isLocked: (path: TrackerExtraPath) => boolean,
  path: TrackerExtraPath = [],
  depth = 0,
): unknown {
  if (depth >= TRACKER_EXTRA_MAX_DEPTH) return next;
  if (isLocked(path)) return previous === undefined ? next : previous;

  if (Array.isArray(next)) {
    const previousArray = Array.isArray(previous) ? previous : [];
    return next.map((item, index) =>
      applyTrackerExtraLocks(previousArray[index], item, isLocked, [...path, index], depth + 1),
    );
  }

  if (isRecord(next)) {
    const previousRecord = isRecord(previous) ? previous : {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      result[key] = applyTrackerExtraLocks(previousRecord[key], value, isLocked, [...path, key], depth + 1);
    }
    return result;
  }

  return next;
}

/** Read one node out of an extras tree. */
export function readTrackerExtraAt(extras: unknown, path: TrackerExtraPath): unknown {
  let node: unknown = extras;
  for (const segment of path) {
    if (Array.isArray(node) && typeof segment === "number") node = node[segment];
    else if (isRecord(node) && typeof segment === "string") node = node[segment];
    else return undefined;
  }
  return node;
}

/**
 * Immutably write one node of an extras tree, cloning only the touched spine.
 * Returns the input unchanged when the path cannot be walked.
 */
export function writeTrackerExtraAt(extras: unknown, path: TrackerExtraPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [segment, ...rest] = path;

  if (typeof segment === "number") {
    if (!Array.isArray(extras)) return extras;
    const copy = [...extras];
    copy[segment] = rest.length === 0 ? value : writeTrackerExtraAt(copy[segment], rest, value);
    return copy;
  }

  const record = isRecord(extras) ? extras : {};
  return {
    ...record,
    [segment as string]: rest.length === 0 ? value : writeTrackerExtraAt(record[segment as string], rest, value),
  };
}

/** Remove an array member, or a record key, at `path`. */
export function removeTrackerExtraAt(extras: unknown, path: TrackerExtraPath): unknown {
  if (path.length === 0) return extras;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = readTrackerExtraAt(extras, parentPath);

  if (typeof last === "number") {
    if (!Array.isArray(parent)) return extras;
    return writeTrackerExtraAt(
      extras,
      parentPath,
      parent.filter((_, index) => index !== last),
    );
  }

  if (!isRecord(parent)) return extras;
  const next = { ...parent };
  delete next[last];
  return writeTrackerExtraAt(extras, parentPath, next);
}

/**
 * Template for a new array member: the shape of the first existing element with
 * its leaves blanked, so adding a row to `footwear` yields the same keys rather
 * than an empty object the agent has to guess at.
 */
export function blankTrackerExtraTemplate(sample: unknown, depth = 0): unknown {
  if (depth >= TRACKER_EXTRA_MAX_DEPTH) return "";
  if (Array.isArray(sample)) return [];
  if (isRecord(sample)) {
    const template: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sample)) template[key] = blankTrackerExtraTemplate(value, depth + 1);
    return template;
  }
  if (typeof sample === "number") return 0;
  if (typeof sample === "boolean") return false;
  return "";
}

/** True when a container carries nothing to show. Leaves are never empty. */
export function isEmptyTrackerExtraContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Leaves under `value`, stopping once `limit` is reached.
 *
 * Drives the renderer's default open state: a small subtree unfolds, a large
 * one stays collapsed so a 40-leaf `body` cannot bury the rest of the card.
 */
export function countTrackerExtraLeaves(value: unknown, limit = 64, depth = 0): number {
  if (depth >= TRACKER_EXTRA_MAX_DEPTH || isTrackerExtraLeaf(value)) return 1;
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  let total = 0;
  for (const entry of entries) {
    total += countTrackerExtraLeaves(entry, limit, depth + 1);
    if (total >= limit) return total;
  }
  return total;
}

// ──────────────────────────────────────────────
// Blank-value filtering
// ──────────────────────────────────────────────
// A tracker prompt emits a fixed schema, so a field that does not apply comes
// back as a placeholder rather than absent: "-", "brak", "n/a", "". A whole
// subtree can be nothing but placeholders -- footwear with no shoes on -- and
// renders as rows carrying no information.
//
// The list is the user's, not a shipped one. Placeholder conventions are written
// into their prompt and follow its language, so no built-in set can cover them.

/** Placeholders that need no configuring. Deliberately excludes "0", which is a real value. */
export const TRACKER_BLANK_VALUE_DEFAULTS = ["-", "--", "—", "n/a", "none", "null"] as const;

/** Trim, lowercase, drop blanks and duplicates. Order is the user's. */
export function normalizeTrackerBlankValues(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * True when a leaf reads as "nothing here".
 *
 * Whole-value equality after trim and lowercase, never substring: "brak" must not
 * also match "brakuje". An empty or whitespace-only string is always blank, with
 * no configuring. Numbers match only if the user listed them, so a real 0 stays.
 */
export function isBlankTrackerValue(value: unknown, blanks: ReadonlySet<string>): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "" || blanks.has(normalized);
  }
  if (typeof value === "number" || typeof value === "boolean") return blanks.has(String(value).toLowerCase());
  return false;
}

/**
 * True when nothing under `value` is worth showing.
 *
 * Cascades, which is the point: a container whose every descendant is blank is
 * itself blank, so a footwear subtree of six placeholders collapses to nothing
 * rather than to six empty rows. An already-empty container stays blank too, so
 * this one predicate replaces `isEmptyTrackerExtraContainer` at render sites.
 */
export function isBlankTrackerNode(value: unknown, blanks: ReadonlySet<string>, depth = 0): boolean {
  if (depth >= TRACKER_EXTRA_MAX_DEPTH) return false;
  if (isTrackerExtraLeaf(value)) return isBlankTrackerValue(value, blanks);
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  // An empty container has nothing to show, matching isEmptyTrackerExtraContainer.
  return entries.every((entry) => isBlankTrackerNode(entry, blanks, depth + 1));
}
