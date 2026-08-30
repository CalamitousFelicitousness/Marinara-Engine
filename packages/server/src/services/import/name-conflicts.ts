// Which incoming names already exist in the library.
//
// Asked before an import commits, so the caller can offer to replace the
// existing row instead of quietly producing a second one with the same name.
// Nothing in storage prevents that second row: no table constrains its name, so
// a duplicate is a question for the user rather than an error.
//
// The lookup reads only the kinds it was asked about. Importing one card should
// not walk every lorebook.

import { eq } from "../../db/file-query.js";
import {
  importConflictIsRecoverable,
  importConflictNameKey,
  type ImportConflictCandidate,
  type ImportConflictKind,
  type ImportNameConflict,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { characters, lorebooks, personas, promptPresets } from "../../db/schema/index.js";

interface ExistingRow {
  id: string;
  name: string;
}

/** A character keeps its name inside the card JSON, so the row alone does not carry one. */
function readCharacterName(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : null;
  } catch {
    // A row whose card will not parse cannot be matched by name, and is not the
    // import's problem to report.
    return null;
  }
}

async function existingRows(db: DB, kind: ImportConflictKind): Promise<ExistingRow[]> {
  switch (kind) {
    case "character": {
      const rows = await db.select().from(characters);
      return rows.flatMap((row) => {
        const name = readCharacterName(row.data);
        return name ? [{ id: row.id, name }] : [];
      });
    }
    case "persona": {
      const rows = await db.select().from(personas);
      return rows.map((row) => ({ id: row.id, name: row.name }));
    }
    case "lorebook": {
      const rows = await db.select().from(lorebooks);
      return rows.map((row) => ({ id: row.id, name: row.name }));
    }
    case "preset": {
      const rows = await db.select().from(promptPresets);
      return rows.map((row) => ({ id: row.id, name: row.name }));
    }
  }
}

export async function findImportNameConflicts(
  db: DB,
  candidates: readonly ImportConflictCandidate[],
): Promise<ImportNameConflict[]> {
  const kinds = new Set(candidates.map((candidate) => candidate.kind));
  const byKind = new Map<ImportConflictKind, Map<string, ExistingRow>>();
  for (const kind of kinds) {
    const index = new Map<string, ExistingRow>();
    for (const row of await existingRows(db, kind)) {
      // First writer wins, so a library that already holds two of a name offers
      // the older one rather than flipping between them run to run.
      const key = importConflictNameKey(row.name);
      if (key && !index.has(key)) index.set(key, row);
    }
    byKind.set(kind, index);
  }

  const conflicts: ImportNameConflict[] = [];
  for (const candidate of candidates) {
    const key = importConflictNameKey(candidate.name);
    if (!key) continue;
    const match = byKind.get(candidate.kind)?.get(key);
    if (!match) continue;
    conflicts.push({
      kind: candidate.kind,
      name: candidate.name,
      ...(candidate.ref === undefined ? {} : { ref: candidate.ref }),
      existingId: match.id,
      existingName: match.name,
      recoverable: importConflictIsRecoverable(candidate.kind),
    });
  }
  return conflicts;
}

/** Whether a row the caller means to overwrite is still there. */
export async function importTargetExists(db: DB, kind: ImportConflictKind, id: string): Promise<boolean> {
  switch (kind) {
    case "character":
      return (await db.select().from(characters).where(eq(characters.id, id))).length > 0;
    case "persona":
      return (await db.select().from(personas).where(eq(personas.id, id))).length > 0;
    case "lorebook":
      return (await db.select().from(lorebooks).where(eq(lorebooks.id, id))).length > 0;
    case "preset":
      return (await db.select().from(promptPresets).where(eq(promptPresets.id, id))).length > 0;
  }
}
