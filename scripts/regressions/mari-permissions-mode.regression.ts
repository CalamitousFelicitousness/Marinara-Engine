// #5725: Professor Mari's Permissions Mode (Auto / Manual / Accept edits /
// Plan / Bypass). Functional checks on the pure pieces plus source pins on the
// enforcement seams.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MARI_PERMISSIONS_MODE,
  isMariPermissionsMode,
  MARI_PERMISSIONS_MODE_LABELS,
  MARI_PERMISSIONS_MODES,
} from "../../packages/shared/src/constants/mari-permissions-mode.js";
import {
  mariPermissionsModePrompt,
  readStoredMariPermissionsMode,
} from "../../packages/server/src/services/professor-mari/workspace-agent.service.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

// ── Constants are self-consistent ───────────────────────────────────────────
assert.equal(DEFAULT_MARI_PERMISSIONS_MODE, "auto");
assert.deepEqual([...MARI_PERMISSIONS_MODES], ["auto", "manual", "accept-edits", "plan", "bypass"]);
for (const mode of MARI_PERMISSIONS_MODES) {
  assert.ok(isMariPermissionsMode(mode));
  assert.ok(MARI_PERMISSIONS_MODE_LABELS[mode].label.length > 0);
  assert.ok(MARI_PERMISSIONS_MODE_LABELS[mode].description.length > 0);
}
assert.equal(isMariPermissionsMode("yolo"), false);
assert.equal(isMariPermissionsMode(null), false);

// ── The stored-mode reader tolerates junk, absence, and storage failure ─────
const fakeStorage = (value: string | null, throws = false) => ({
  get: async () => {
    if (throws) throw new Error("storage down");
    return value;
  },
});
assert.equal(await readStoredMariPermissionsMode(fakeStorage("plan")), "plan");
assert.equal(await readStoredMariPermissionsMode(fakeStorage(null)), "auto");
assert.equal(await readStoredMariPermissionsMode(fakeStorage("garbage")), "auto");
assert.equal(await readStoredMariPermissionsMode(fakeStorage(null, true)), "auto");

// ── The prompt renderer: auto is silent; every other mode instructs ─────────
assert.equal(mariPermissionsModePrompt("auto"), null);
for (const mode of ["manual", "plan", "accept-edits", "bypass"] as const) {
  const block = mariPermissionsModePrompt(mode);
  assert.ok(block && block.startsWith("<permissions_mode>") && block.endsWith("</permissions_mode>"), mode);
  assert.match(block, /may further RESTRICT but never loosen/u, `${mode}: memory precedence rule`);
}
assert.match(mariPermissionsModePrompt("plan") ?? "", /refused by the server/u);
assert.match(mariPermissionsModePrompt("accept-edits") ?? "", /does NOT show a Keep\/Restore review card/u);
assert.match(
  mariPermissionsModePrompt("bypass") ?? "",
  /Sensitive file changes and dependency installs still require/u,
);

// ── Enforcement seams (source pins) ─────────────────────────────────────────
const workspaceAgent = readSource("packages/server/src/services/professor-mari/workspace-agent.service.ts");
// Mode read fresh per run and per status call - never latched at construction.
assert.match(workspaceAgent, /const permissionsMode = await this\.readPermissionsMode\(\);/u);
assert.match(workspaceAgent, /permissionsMode: await this\.readPermissionsMode\(\),/u);
assert.doesNotMatch(
  workspaceAgent,
  /activeRunPermissionsMode\s*=\s*await/u,
  "the transient run field must be assigned from the per-run read, synchronously",
);
// Plan mode is a hard server-side floor in the executor, dry-runs allowed.
assert.match(
  workspaceAgent,
  /activeRunPermissionsMode === "plan" && isMutatingWorkspaceCommand\(command\)/u,
  "plan mode must refuse mutating commands in the executor, not just in the prompt",
);
// Manual forces the deferral; Bypass suppresses it.
assert.match(workspaceAgent, /this\.activeRunPermissionsMode !== "bypass" &&/u);
assert.match(workspaceAgent, /this\.activeRunPermissionsMode === "manual" \|\|/u);
// Accept edits / Bypass ride the envelope, with the delete carve-out.
assert.match(workspaceAgent, /"accept-edits" \|\| this\.activeRunPermissionsMode === "bypass"/u);
assert.match(workspaceAgent, /delete\|forget\|remove\|uninstall/u);
assert.match(workspaceAgent, /reviewPolicy: autoKeep \? "auto-keep" : "standard"/u);
// The mode block is spliced AFTER the memories block.
const instructionsIdx = workspaceAgent.indexOf("if (instructionsPrompt) messages.push");
const modeBlockIdx = workspaceAgent.indexOf(
  "const permissionsModePrompt = mariPermissionsModePrompt(permissionsMode);",
);
assert.ok(instructionsIdx > 0 && modeBlockIdx > instructionsIdx, "mode guidance must come after saved memories");

const mariDb = readSource("packages/server/src/services/mari-db/mari-db.service.ts");
// auto-keep skips ONLY the pending review; history + journal still recorded.
assert.match(mariDb, /if \(this\.activeReviewPolicy === "auto-keep"\) \{/u);
const autoKeepIdx = mariDb.indexOf('if (this.activeReviewPolicy === "auto-keep") {');
const historyIdx = mariDb.lastIndexOf("await this.recordHistory({", autoKeepIdx);
assert.ok(historyIdx > 0, "history is recorded before the auto-keep branch");
// The policy is stripped from the stored command payload.
assert.match(mariDb, /key === "reviewPolicy"/u);
// Reset to standard at every executeAction entry (no leakage across calls).
assert.match(mariDb, /this\.activeReviewPolicy = envelope\.reviewPolicy === "auto-keep" \? "auto-keep" : "standard";/u);

const routes = readSource("packages/server/src/routes/professor-mari-workspace.routes.ts");
assert.match(routes, /z\.enum\(MARI_PERMISSIONS_MODES\)/u, "the PUT must validate against the shared enum");
assert.match(routes, /app\.get\("\/permissions-mode"/u);
assert.match(routes, /app\.put\("\/permissions-mode"/u);
assert.doesNotMatch(
  routes.slice(routes.indexOf('app.put("/permissions-mode"'), routes.indexOf('app.put("/permissions-mode"') + 600),
  /reset\(\)/u,
  "a mode switch must not abort an in-flight Mari turn",
);
// The setting is NOT writable through the generic app-settings passthrough.
const appSettingsRoutes = readSource("packages/server/src/routes/app-settings.routes.ts");
assert.doesNotMatch(appSettingsRoutes, /mari-permissions-mode/u);

// ── Client surfaces exist ───────────────────────────────────────────────────
const mariChat = readSource("packages/client/src/components/chat/HomeProfessorMariChat.tsx");
assert.match(mariChat, /changePermissionsMode/u);
assert.match(mariChat, /workspaceStatus\?\.permissionsMode \?\? DEFAULT_MARI_PERMISSIONS_MODE/u);
const settingControls = readSource("packages/client/src/components/panels/settings/SettingControls.tsx");
assert.match(settingControls, /export function MariPermissionsModeSetting/u);

console.log("Mari permissions-mode regression passed.");
