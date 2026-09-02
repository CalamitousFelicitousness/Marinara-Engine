// #5748: once Professor Mari asks the user whether to apply, the question is
// binding for the rest of the run - she must never answer it herself. The
// reported shape: an ask-frame whose only command was an apply:false preview
// could not be held (previews are non-mutating), so the run continued and she
// pivoted to apply:true one round later with no user reply in between.
// The fix is a run-scoped ask latch: any round that asks (awaitingAuthorization
// or ask-shaped visible text) makes every LATER mutating round of the same run
// defer behind the Accept action, and silent mutating frames are refused with
// guidance. A user reply or Accept starts a new run with a fresh latch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAssistantWorkspaceAction,
  visibleTextRequestsUserApproval,
} from "../../packages/server/src/services/professor-mari/workspace-agent.service.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

// ── Functional: the detector fires on the reported round-3 ask ──────────────
assert.equal(
  visibleTextRequestsUserApproval(
    "I've drafted up a magical girl transformation for Kaz! I'm running this as a preview so you can review the proposed edits in the UI. Let me know if you want me to apply these changes!",
  ),
  true,
  "the reported ask-phrasing must arm the latch",
);
// The round-4 self-answer is declarative and does NOT match - which is exactly
// why the latch (armed on the earlier ask), not this detector, must catch it.
assert.equal(
  visibleTextRequestsUserApproval(
    "Ah, my bad! To properly show you the Keep/Restore review card UI for character edits, I need to actually submit the changes. Let's apply the magical girl transformation right now so you can see the visual diffs!",
  ),
  false,
  "the declarative self-answer does not match - the latch is the guard, not the regex",
);
// awaitingAuthorization is the deterministic arm - the prompt now instructs
// proposal frames to set it explicitly instead of relying on phrasing.
assert.equal(
  parseAssistantWorkspaceAction(
    JSON.stringify({ say: "Apply this?", awaitingAuthorization: true, commands: [], stop: true }),
  ).awaitingAuthorization,
  true,
);

// ── Engine: the latch exists, arms, holds, and floors ───────────────────────
const workspaceAgent = readSource("packages/server/src/services/professor-mari/workspace-agent.service.ts");
// Run-LOCAL latch, never shared instance state (a superseded run must not
// inherit or clobber another run's ask).
assert.match(workspaceAgent, /let runAskedForApproval = false;/u);
assert.doesNotMatch(workspaceAgent, /private runAskedForApproval/u, "the latch is run-local, never an instance field");
// Armed on ANY asking round, regardless of that round's commands - this is the
// hole: the reported ask-frame carried only a non-mutating preview.
assert.match(
  workspaceAgent,
  /if \(parsedAction\.awaitingAuthorization \|\| visibleTextRequestsUserApproval\(parsedAction\.visibleText\)\) \{\s*\n\s*runAskedForApproval = true;/u,
);
// The latch joins the deferral disjunction, so later described mutations in
// the same run are held behind Accept.
assert.match(
  workspaceAgent,
  /runAskedForApproval\) &&\s*\n\s*parsedAction\.commands\.some\(isMutatingWorkspaceCommand\);/u,
  "the deferral must consider the run's earlier ask, not only the current round's text",
);
// Silent mutating frames after an ask are refused at the executor (Manual is
// carved out - its own floor plus manualApprovalArmed govern the post-Accept
// silent re-send; Bypass never holds).
assert.match(workspaceAgent, /private activeRoundAskLatchSilentMutationBlocked = false;/u);
assert.match(
  workspaceAgent,
  /this\.activeRoundAskLatchSilentMutationBlocked =\s*runAskedForApproval && !action\.visibleText && permissionsMode !== "manual" && permissionsMode !== "bypass";/u,
);
assert.match(
  workspaceAgent,
  /if \(this\.activeRoundAskLatchSilentMutationBlocked && isMutatingWorkspaceCommand\(command\)\) \{/u,
);
assert.match(workspaceAgent, /only their reply or Accept can answer it/u);

// ── The dry-run result no longer coaches a self-authorized pivot ────────────
assert.doesNotMatch(
  workspaceAgent,
  /Use apply:true only if the user asked you to make the change/u,
  "the old dry-run text re-posed the apply decision to Mari every round",
);
assert.match(
  workspaceAgent,
  /the user cannot see this preview - apply:false renders no card or diff in the UI/u,
  "the dry-run result must state, truthfully, that previews are invisible to the user",
);
assert.match(workspaceAgent, /the user's reply or Accept is the only go-ahead/u);

// ── Prompt: propose maps to one held proposal; asks are binding ─────────────
assert.match(workspaceAgent, /"Propose your edits" \/ "present a proposal" \/ "draft a change" style requests/u);
assert.match(workspaceAgent, /One response, one proposal, no duplicate work\./u);
assert.match(workspaceAgent, /the question is binding for the rest of the run/u);
assert.match(
  workspaceAgent,
  /A dry run renders nothing in the UI - the user cannot see it/u,
  "the apply:false rule must carry the invisibility fact",
);

console.log("Mari ask-latch regression passed.");
