// Asking the server which incoming names already exist.
//
// The character path gets its answer from the inspect call it already makes,
// because that route parses the card server-side and so knows the name. Every
// other kind is a file the client has already parsed, so it can ask directly.

import {
  readExportEnvelopeCandidate,
  type ImportConflictCandidate,
  type ImportNameConflict,
} from "@marinara-engine/shared";
import { api } from "./api-client";

export async function fetchImportNameConflicts(candidates: ImportConflictCandidate[]): Promise<ImportNameConflict[]> {
  if (candidates.length === 0) return [];
  const result = await api.post<{ success: boolean; conflicts: ImportNameConflict[] }>("/import/name-conflicts", {
    candidates,
  });
  return result.conflicts ?? [];
}

/** The candidate a parsed native export stands for, keyed by the file it came from. */
export function envelopeCandidate(payload: unknown, filename: string): ImportConflictCandidate | null {
  return readExportEnvelopeCandidate(payload, filename);
}

/**
 * What the user chose for each colliding file, keyed by the reference the
 * candidate carried.
 */
export type ImportConflictChoices = Record<string, "overwrite" | "additional" | "skip">;

/** The existing row each file should replace, for the files told to replace one. */
export function overwriteTargets(
  conflicts: readonly ImportNameConflict[],
  choices: ImportConflictChoices,
): Array<{ filename: string; existingId: string }> {
  return conflicts.flatMap((conflict) =>
    conflict.ref && choices[conflict.ref] === "overwrite"
      ? [{ filename: conflict.ref, existingId: conflict.existingId }]
      : [],
  );
}

/** Files the user chose not to import at all. */
export function skippedRefs(conflicts: readonly ImportNameConflict[], choices: ImportConflictChoices): Set<string> {
  return new Set(
    conflicts.flatMap((conflict) => (conflict.ref && choices[conflict.ref] === "skip" ? [conflict.ref] : [])),
  );
}
