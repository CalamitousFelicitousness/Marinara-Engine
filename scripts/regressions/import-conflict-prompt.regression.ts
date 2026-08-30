// The import dialog asks before it duplicates, and defaults to what it always did.
//
// Source-shape assertions rather than a rendered tree: this repo has no
// component test runner, and the properties worth pinning are structural. The
// default matters most. A dialog that pre-selected "replace" would turn a
// question into a data loss the user never asked for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importConflictIsRecoverable,
  importConflictNameKey,
  readExportEnvelopeCandidate,
  IMPORT_CONFLICT_KINDS,
  IMPORT_CONFLICT_RESOLUTIONS,
} from "../../packages/shared/src/types/import-conflict.ts";
import { overwriteTargets, skippedRefs } from "../../packages/client/src/lib/import-conflicts.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(repositoryRoot, ...parts), "utf8");

// Every kind the lookup answers about can be named by the dialog
{
  const prompt = read("packages", "client", "src", "components", "modals", "ImportConflictPrompt.tsx");
  for (const kind of IMPORT_CONFLICT_KINDS) {
    assert.ok(
      prompt.includes(`${kind}: "ui.modals.importconflictprompt.kind`),
      `the dialog labels the ${kind} kind, rather than falling back to another kind's word`,
    );
  }
  for (const resolution of IMPORT_CONFLICT_RESOLUTIONS) {
    assert.ok(
      prompt.includes(`${resolution}: "ui.modals.importconflictprompt.`),
      `the dialog offers ${resolution}`,
    );
  }
  assert.ok(prompt.includes("applyToAll"), "a batch can be answered once rather than row by row");
  assert.ok(
    prompt.includes("!conflict.recoverable") && prompt.includes("unrecoverableWarning"),
    "choosing an overwrite nothing snapshots warns about it",
  );
}

// Nothing is replaced unless it was chosen
{
  const modal = read("packages", "client", "src", "components", "modals", "ImportCharacterModal.tsx");
  assert.ok(
    modal.includes('[c.ref ?? c.name, "additional" as const]'),
    "every row starts on keep-both, which is what an import did before this question existed",
  );
  assert.ok(
    modal.includes("setPendingConflicts({ files, importEmbeddedLorebook, conflicts })"),
    "a collision parks the import rather than proceeding",
  );
  assert.ok(
    modal.includes('form.append("overwriteTargets"'),
    "the batch upload carries the per-file answers",
  );
  assert.ok(modal.includes("skipped.has"), "a skipped file is never uploaded");
}

// The answers map to what the server is told
{
  const conflicts = [
    { kind: "character" as const, name: "Mari", ref: "a.png", existingId: "id-a", existingName: "Mari", recoverable: true },
    { kind: "character" as const, name: "Nori", ref: "b.png", existingId: "id-b", existingName: "Nori", recoverable: true },
    { kind: "lorebook" as const, name: "Notes", ref: "c.json", existingId: "id-c", existingName: "Notes", recoverable: false },
  ];
  const choices = { "a.png": "overwrite" as const, "b.png": "skip" as const, "c.json": "additional" as const };

  assert.deepEqual(
    overwriteTargets(conflicts, choices),
    [{ filename: "a.png", existingId: "id-a" }],
    "only the rows told to replace name a target",
  );
  assert.deepEqual([...skippedRefs(conflicts, choices)], ["b.png"], "only the skipped row is held back");
  assert.deepEqual(overwriteTargets(conflicts, {}), [], "an unanswered dialog replaces nothing");
  assert.deepEqual([...skippedRefs(conflicts, {})], [], "and skips nothing");
}

// Recoverability is a property of the kind, not of the caller
{
  assert.equal(importConflictIsRecoverable("character"), true, "characters keep a version of what they replace");
  assert.equal(importConflictIsRecoverable("persona"), true, "so do personas");
  assert.equal(importConflictIsRecoverable("lorebook"), false, "lorebooks keep nothing");
  assert.equal(importConflictIsRecoverable("preset"), false, "nor do presets");
}

// Names match the way a person reads them
{
  assert.equal(importConflictNameKey("  Mari "), importConflictNameKey("mari"), "case and space are the same name");
  assert.notEqual(importConflictNameKey("Mari"), importConflictNameKey("Marii"), "a different name is different");
  assert.equal(importConflictNameKey("   "), "", "a blank name keys to nothing and matches nothing");
}

// A native export says what it is without the client re-deriving the paths
{
  assert.deepEqual(
    readExportEnvelopeCandidate({ type: "marinara_lorebook", data: { lorebook: { name: "Notes" } } }, "c.json"),
    { kind: "lorebook", name: "Notes", ref: "c.json" },
    "a lorebook envelope names its lorebook",
  );
  assert.deepEqual(
    readExportEnvelopeCandidate({ type: "marinara_character", data: { data: { name: "Mari" } } }),
    { kind: "character", name: "Mari" },
    "a character envelope nests its card one deeper",
  );
  assert.deepEqual(
    readExportEnvelopeCandidate({ type: "marinara_persona", data: { name: "Nori" } }),
    { kind: "persona", name: "Nori" },
    "a persona envelope names itself directly",
  );
  assert.deepEqual(
    readExportEnvelopeCandidate({ type: "marinara_preset", data: { preset: { name: "Roleplay" } } }),
    { kind: "preset", name: "Roleplay" },
    "a preset envelope nests its preset",
  );
  assert.equal(
    readExportEnvelopeCandidate({ type: "marinara_profile", data: { name: "Everything" } }),
    null,
    "a whole-profile export is not one named row and cannot collide as one",
  );
  assert.equal(readExportEnvelopeCandidate({ type: "marinara_character", data: {} }), null, "a nameless card is skipped");
  assert.equal(readExportEnvelopeCandidate(null), null, "so is nothing at all");
}

console.info("Import conflict prompt regression passed.");
