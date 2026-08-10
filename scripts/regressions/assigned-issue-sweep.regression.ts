import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INLINE_MD_RE } from "../../packages/client/src/lib/inline-markdown-regex.js";
import { mergeUndatedSyncedSettings } from "../../packages/client/src/hooks/use-settings-sync.js";
import {
  isStockMarinaraUniversalPreset,
  MARINARA_UNIVERSAL_PRESET_SYSTEM_KEY,
} from "../../packages/shared/src/types/prompt.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const outerMarkdownMatch = new RegExp(INLINE_MD_RE.source, INLINE_MD_RE.flags).exec(
  "*This is **bold** in italic.*",
);
assert.equal(outerMarkdownMatch?.[11], "This is **bold** in italic.", "single-star delimiters keep the full italic span");
const innerMarkdownMatch = new RegExp(INLINE_MD_RE.source, INLINE_MD_RE.flags).exec(outerMarkdownMatch?.[11] ?? "");
assert.equal(innerMarkdownMatch?.[9], "bold", "double-star delimiters remain bold inside italic text");

const mergedSettings = mergeUndatedSyncedSettings({ accentColor: "local", homeGreetingEnabled: true } as never, {
  accentColor: "server",
}) as unknown as Record<string, unknown>;
assert.equal(mergedSettings.accentColor, "server", "server-present settings win over an undated browser cache");
assert.equal(mergedSettings.homeGreetingEnabled, true, "local settings fill only fields absent from the server");

assert.equal(
  isStockMarinaraUniversalPreset({ systemKey: MARINARA_UNIVERSAL_PRESET_SYSTEM_KEY }),
  true,
  "the bundled universal preset is recognized as stock",
);
assert.equal(
  isStockMarinaraUniversalPreset({
    name: "Marinara's Universal Preset",
    author: "Marinara",
    systemKey: "",
  }),
  false,
  "editable name and author fields cannot make a user preset protected stock",
);

const agentsPanelSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/panels/AgentsPanel.tsx"),
  "utf8",
);
const managedAgentFilter = /const visibleBuiltInAgents = useMemo[\s\S]*?\n  \/\/ Custom agents/u.exec(
  agentsPanelSource,
)?.[0];
assert.ok(managedAgentFilter, "the installed-agent management filter remains discoverable");
assert.match(
  managedAgentFilter,
  /availableBuiltInAgents\.filter\(\(agent\) => !deletedBuiltInTypes\.has\(agent\.id\)\)/u,
  "feature-only installed Agents remain visible in the management pane",
);

const characterEditorSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/characters/CharacterEditor.tsx"),
  "utf8",
);
const lorebookCallbacks = /const handleLorebookEmbedded[\s\S]*?\n  const updateExtension/u.exec(
  characterEditorSource,
)?.[0];
assert.ok(lorebookCallbacks, "the embedded-lorebook reconciliation callbacks remain discoverable");
assert.doesNotMatch(
  lorebookCallbacks,
  /if \(!dirtyRef\.current\) return;/u,
  "embedded-lorebook controls reconcile immediately even when the editor is clean",
);

console.info("Assigned issue-sweep regressions passed.");
