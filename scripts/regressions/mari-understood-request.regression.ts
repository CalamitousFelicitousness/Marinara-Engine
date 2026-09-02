// #5740: the "understood request" triage tool - Mari reports the phrase she
// treated as the request/permission for mutating commands; it is persisted as
// ONE latest-round in-memory record (maintainer call: no growing history),
// shown under the matching reply (truncated, expandable), and included in
// Support Diagnostics. HARD CONSTRAINT: diagnostic only - never validated,
// never gates anything (#5721's lesson stands).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAssistantWorkspaceAction } from "../../packages/server/src/services/professor-mari/workspace-agent.service.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

// ── Functional: the field parses, trims, caps, and tolerates absence ────────
const withField = parseAssistantWorkspaceAction(
  JSON.stringify({
    say: "",
    understoodRequest: "  rework her personality to be more cynical  ",
    commands: [
      {
        name: "app_data",
        arguments: { action: "character.update", characterId: "c1", patch: { personality: "x" }, apply: true },
      },
    ],
    stop: false,
  }),
);
assert.equal(withField.understoodRequest, "rework her personality to be more cynical");

const withoutField = parseAssistantWorkspaceAction(JSON.stringify({ say: "hello", commands: [], stop: true }));
assert.equal(withoutField.understoodRequest, null);

const nonString = parseAssistantWorkspaceAction(
  JSON.stringify({ say: "", understoodRequest: 42, commands: [], stop: true }),
);
assert.equal(nonString.understoodRequest, null);

const capped = parseAssistantWorkspaceAction(
  JSON.stringify({ say: "", understoodRequest: "x".repeat(5000), commands: [], stop: true }),
);
assert.equal(capped.understoodRequest?.length, 2000, "the quoted phrase is capped, never unbounded");

// ── Server: capture, retention, and the never-enforce constraint ────────────
const workspaceAgent = readSource("packages/server/src/services/professor-mari/workspace-agent.service.ts");
// The prompt tells the model the field is shown and NEVER validated.
assert.match(workspaceAgent, /shown to the user for transparency and NEVER validated/u);
assert.match(workspaceAgent, /"understoodRequest": "the exact words you are treating as the request or permission/u);
// One latest-round record, overwritten per qualifying round - no history.
assert.match(workspaceAgent, /private latestUnderstoodRequest: MariUnderstoodRequest \| null = null;/u);
assert.doesNotMatch(
  workspaceAgent,
  /latestUnderstoodRequest\.push|understoodRequests\b/u,
  "retention is one record, never a list",
);
// Captured for every round with mutating commands (deferred or executed),
// and bound to the persisted message once known.
assert.match(
  workspaceAgent,
  /if \(parsedAction\.commands\.some\(isMutatingWorkspaceCommand\)\) \{\s*\n\s*this\.latestUnderstoodRequest = \{/u,
);
assert.match(workspaceAgent, /deferred: Boolean\(shouldDeferMutations\)/u);
assert.match(
  workspaceAgent,
  /this\.latestUnderstoodRequest = \{ \.\.\.this\.latestUnderstoodRequest, messageId: message\.id \};/u,
);
// Status carries it.
assert.match(workspaceAgent, /latestUnderstoodRequest: this\.latestUnderstoodRequest,/u);
// NEVER ENFORCED: no conditional anywhere in the server gates on the field.
for (const file of [
  "packages/server/src/services/professor-mari/workspace-agent.service.ts",
  "packages/server/src/services/mari-db/mari-db.service.ts",
]) {
  const source = readSource(file);
  assert.doesNotMatch(
    source,
    /if\s*\([^)]*understoodRequest/u,
    `${file} must never branch on the understood request - it is diagnostic only`,
  );
  assert.doesNotMatch(
    source,
    /understoodRequest[^\n]*throw|throw[^\n]*understoodRequest/u,
    `${file} must never refuse anything over the understood request`,
  );
}

// ── Client: visible by default, truncated one row, expandable ───────────────
const mariChat = readSource("packages/client/src/components/chat/HomeProfessorMariChat.tsx");
assert.match(
  mariChat,
  /latestUnderstoodRequest\.messageId === message\.id/u,
  "the line anchors to the reply its round produced",
);
assert.match(
  mariChat,
  /understoodRequestExpanded \? "min-w-0 whitespace-pre-wrap" : "min-w-0 truncate"/u,
  "one-row truncation with click-to-expand",
);
assert.match(mariChat, /setUnderstoodRequestExpanded\(\(current\) => !current\)/u);

const enJson = JSON.parse(readSource("packages/client/src/localization/locales/en.json")) as Record<string, string>;
for (const key of [
  "ui.chat.homeprofessormarichat.actingOnValue1",
  "ui.chat.homeprofessormarichat.actingOnNothingReported",
  "ui.chat.homeprofessormarichat.actingOnExpand",
  "ui.chat.homeprofessormarichat.heldForYourApproval",
]) {
  assert.ok(key in enJson, `en.json must carry ${key}`);
}

// ── Diagnostics: the triage line distinguishes unreachable / none / recorded ─
const diagnostics = readSource("packages/client/src/lib/support-diagnostics.ts");
assert.match(diagnostics, /Mari last acted on:/u);
assert.match(diagnostics, /Unavailable \(workspace status not reachable\)/u);
assert.match(diagnostics, /none recorded this session/u);
const settingsPanel = readSource("packages/client/src/components/panels/SettingsPanel.tsx");
assert.match(settingsPanel, /\.catch\(\(\) => undefined\);/u);
assert.match(settingsPanel, /mariActingOn,/u, "the diagnostics copy must include the triage line");

console.log("Mari understood-request regression passed.");
