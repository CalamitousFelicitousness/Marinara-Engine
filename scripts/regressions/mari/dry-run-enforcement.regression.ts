// #7949 run 2: a live 12b sent three app_data dry runs for one card edit and said it was done each time.
// The guard caught the first claim and passed the paraphrase ("now correctly reflects 1745"), the
// result's only warning sat ahead of the whole card echoed twice, and no handbook was read because the
// failure hint never fires on a write that succeeds wrongly. Each fix is pinned here.
import assert from "node:assert/strict";
import {
  APP_DATA_DRY_RUN_SENTINEL,
  auditWorkspaceCompletionClaim,
  compactMutationResult,
  type WorkspaceCommandResult,
} from "../../../packages/server/src/services/professor-mari/workspace-agent.service.js";
import {
  newRoundReviewState,
  reviewRoundClaim,
} from "../../../packages/server/src/services/professor-mari/workspace-round-review.js";
import { skillGateRefusal } from "../../../packages/server/src/services/professor-mari/workspace-commands.js";
import type { MariDbCommandResult } from "../../../packages/server/src/services/mari-db/mari-db.service.js";

const read: WorkspaceCommandResult = {
  id: "get",
  name: "app_data",
  input: { action: "character.get", characterId: "elsie" },
  output: 'Command: app_data character.get\n\nstdout:\n{"ok":true}',
  success: true,
};
const dryRun = (id: string): WorkspaceCommandResult => ({
  id,
  name: "app_data",
  input: { action: "character.update", characterId: "elsie", data: { description: "died in 1745" } },
  output: `${APP_DATA_DRY_RUN_SENTINEL}\nCommand: app_data character.update\n\nstdout:\n{"ok":true,"mode":"dry-run","saved":false}`,
  success: true,
});
const applied: WorkspaceCommandResult = {
  ...dryRun("applied"),
  input: { ...dryRun("x").input, apply: true },
  output: 'Command: app_data character.update\n\nstdout:\n{"ok":true,"mode":"apply","saved":true}',
};
const final = (visibleText: string, commands: unknown[] = []) =>
  ({ visibleText, commands, stop: commands.length === 0 }) as Parameters<typeof auditWorkspaceCompletionClaim>[0];

// The live final reply: no word the tripwire knows, so only the results can catch it.
const paraphrase =
  "I've verified the records, and Elsie's description now correctly reflects her death in 1745.\n\nWhy:\n* Confirmed the year is now 1745.";
const scope = [read, dryRun("d1"), dryRun("d2")];
assert.equal(auditWorkspaceCompletionClaim(final(paraphrase), scope).issue, "dry_run");
assert.equal(auditWorkspaceCompletionClaim(final("Done! Updated the description."), scope).issue, "dry_run");

// Honest endings are not this case: a question, or saying nothing was saved. ("was saved" still trips the
// older word check, which is its own matter.)
assert.equal(auditWorkspaceCompletionClaim(final("Here is the change. Want me to save it?"), scope).issue, null);
assert.notEqual(auditWorkspaceCompletionClaim(final("Preview only: nothing was saved yet."), scope).issue, "dry_run");
// An applied write, or a round that still has commands, is not this case.
assert.notEqual(auditWorkspaceCompletionClaim(final(paraphrase), [...scope, applied]).issue, "dry_run");
assert.notEqual(auditWorkspaceCompletionClaim(final(paraphrase, [{}]), scope).issue, "dry_run");
// Only dry runs since the last audited claim count.
assert.notEqual(auditWorkspaceCompletionClaim(final(paraphrase), scope, { auditFrom: 3 }).issue, "dry_run");

const decision = reviewRoundClaim(newRoundReviewState(), {
  action: { ...final(paraphrase), protocolValid: true },
  commandResultsForContinuity: scope,
  truncated: false,
});
assert.equal(decision.kind, "repair");
assert.match(
  decision.kind === "repair" ? decision.prompt : "",
  /Every write in this run was a dry run, so nothing was saved.*send the same call again with top-level "apply": true/,
);

// The preview keeps only what changed, two levels deep; an insert stays whole.
const card = (description: string) => ({
  id: "elsie",
  data: { name: "Elspeth", description, personality: "x".repeat(4000) },
  comment: "",
});
const compact = compactMutationResult({
  ok: true,
  mode: "dry-run",
  summary: {
    preview: [
      { table: "characters", id: "elsie", action: "replace", before: card("died 1746"), after: card("died 1745") },
      { table: "characters", id: "new", action: "insert", before: null, after: card("new") },
    ],
  },
} as unknown as MariDbCommandResult) as { summary: { preview: Array<Record<string, unknown>> } };
const [replace, insert] = compact.summary.preview;
assert.deepEqual(replace!.before, { data: { description: "died 1746" } });
assert.deepEqual(replace!.after, { data: { description: "died 1745" } });
assert.equal(replace!.unchangedFieldsOmitted, true);
assert.deepEqual(insert!.after, card("new"), "an insert keeps the whole new row");

// The handbook gate: a preview counts as a write.
const preview = skillGateRefusal("character.update", { action: "character.update", apply: false }, new Set<string>());
assert.match(String(preview), /builtin-characters/, "a preview counts as a write");

console.log("Professor Mari dry-run enforcement regression passed.");
