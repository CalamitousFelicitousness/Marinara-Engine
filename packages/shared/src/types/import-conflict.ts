// An import whose name already exists in the library.
//
// Nothing stops a duplicate: neither table constrains its name, and every
// importer creates unconditionally, so importing the same card twice has always
// produced two of it silently. Naming that outcome is what lets the other two be
// offered beside it.
//
// Overwriting is not equally safe across kinds. Characters and personas update
// through storage that snapshots the prior state first, so the row keeps its id
// and the previous content stays in version history. Lorebooks and presets keep
// no snapshots, so replacing one is final. `recoverable` carries that difference
// to whoever has to word the question.

/** A library kind an import can collide with. */
export const IMPORT_CONFLICT_KINDS = ["character", "persona", "lorebook", "preset"] as const;
export type ImportConflictKind = (typeof IMPORT_CONFLICT_KINDS)[number];

/**
 * Kinds whose overwrite can be undone.
 *
 * Read from the storage that performs it rather than declared per call: both
 * take their snapshot inside `update`, so a caller cannot opt out by forgetting.
 */
export const IMPORT_CONFLICT_RECOVERABLE_KINDS: ReadonlyArray<ImportConflictKind> = ["character", "persona"];

export function importConflictIsRecoverable(kind: ImportConflictKind): boolean {
  return IMPORT_CONFLICT_RECOVERABLE_KINDS.includes(kind);
}

/** What the caller asks about: one incoming item, identified however it arrived. */
export interface ImportConflictCandidate {
  kind: ImportConflictKind;
  name: string;
  /** Echoed back untouched so a caller can match an answer to its file. */
  ref?: string;
}

/** An existing row the candidate would collide with. */
export interface ImportNameConflict {
  kind: ImportConflictKind;
  /** The incoming name, as it would be stored. */
  name: string;
  ref?: string;
  existingId: string;
  /** The stored name, which differs from `name` in case or spacing. */
  existingName: string;
  recoverable: boolean;
}

/**
 * What to do with one collision.
 *
 * `additional` is what every import did before this existed, so it stays the
 * option that changes nothing.
 */
export const IMPORT_CONFLICT_RESOLUTIONS = ["overwrite", "additional", "skip"] as const;
export type ImportConflictResolution = (typeof IMPORT_CONFLICT_RESOLUTIONS)[number];

/**
 * Compares names the way a person reads them.
 *
 * Case and surrounding space are not a different character, and a card exported
 * with a trailing space is common enough that matching on the raw string would
 * miss the collision this exists to catch.
 */
export function importConflictNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The kind and name a native export envelope carries, or null when it holds
 * something that cannot collide by name.
 *
 * Each envelope type nests its subject differently, and the importer is the only
 * other reader of those paths. Keeping them here means a client asking about a
 * collision and a server performing the import agree on what the file is called.
 */
export function readExportEnvelopeCandidate(envelope: unknown, ref?: string): ImportConflictCandidate | null {
  if (!envelope || typeof envelope !== "object") return null;
  const { type, data } = envelope as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;

  const nested = (key: string): string | null => {
    const inner = payload[key];
    if (!inner || typeof inner !== "object") return null;
    const name = (inner as Record<string, unknown>).name;
    return typeof name === "string" && name.trim() ? name : null;
  };

  const found: Partial<Record<string, [ImportConflictKind, string | null]>> = {
    marinara_character: ["character", nested("data")],
    marinara_persona: ["persona", typeof payload.name === "string" && payload.name.trim() ? payload.name : null],
    marinara_lorebook: ["lorebook", nested("lorebook")],
    marinara_preset: ["preset", nested("preset")],
  };
  const match = found[type];
  if (!match || !match[1]) return null;
  return { kind: match[0], name: match[1], ...(ref === undefined ? {} : { ref }) };
}
