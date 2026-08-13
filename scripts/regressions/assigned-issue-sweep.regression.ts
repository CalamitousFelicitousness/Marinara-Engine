import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCORD_SUBTEXT_RE, INLINE_MD_RE } from "../../packages/client/src/lib/inline-markdown-regex.js";
import { applyInlineMarkdownHTML } from "../../packages/client/src/lib/markdown.js";
import { mergeUndatedSyncedSettings } from "../../packages/client/src/hooks/use-settings-sync.js";
import {
  formatRuntimeBuild,
  getServerRuntimeBuild,
  isRuntimeBuildCurrent,
} from "../../packages/client/src/lib/runtime-build.js";
import { useAgentStore } from "../../packages/client/src/stores/agent.store.js";
import {
  isStockMarinaraUniversalPreset,
  MARINARA_UNIVERSAL_PRESET_SYSTEM_KEY,
} from "../../packages/shared/src/types/prompt.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const clientBuild = formatRuntimeBuild("2.4.2", "aaaaaaaaaaaa");
assert.equal(clientBuild, "2.4.2+aaaaaaaaaaaa");
assert.equal(
  isRuntimeBuildCurrent("2.4.2", clientBuild, { version: "2.4.2", build: "2.4.2+aaaaaaaaaaaa" }),
  true,
  "matching same-version builds do not refresh",
);
assert.equal(
  isRuntimeBuildCurrent("2.4.2", clientBuild, { version: "2.4.2", build: "2.4.2+bbbbbbbbbbbb" }),
  false,
  "a newer commit with the same release version refreshes the stale client",
);
assert.equal(
  isRuntimeBuildCurrent("2.4.2", clientBuild, { version: "2.4.2" }),
  true,
  "older servers without build metadata retain version-only compatibility",
);
assert.equal(
  getServerRuntimeBuild({ version: "2.4.2", build: " 2.4.2+bbbbbbbbbbbb " }),
  "2.4.2+bbbbbbbbbbbb",
  "the server build identity is normalized for the recovery key",
);

const outerMarkdownMatch = new RegExp(INLINE_MD_RE.source, INLINE_MD_RE.flags).exec("*This is **bold** in italic.*");
assert.equal(
  outerMarkdownMatch?.[11],
  "This is **bold** in italic.",
  "single-star delimiters keep the full italic span",
);
const innerMarkdownMatch = new RegExp(INLINE_MD_RE.source, INLINE_MD_RE.flags).exec(outerMarkdownMatch?.[11] ?? "");
assert.equal(innerMarkdownMatch?.[9], "bold", "double-star delimiters remain bold inside italic text");

const underlineMatch = new RegExp(INLINE_MD_RE.source, INLINE_MD_RE.flags).exec("__underlined__");
assert.equal(underlineMatch?.[10], "underlined", "double underscores retain the underline span");
assert.equal(DISCORD_SUBTEXT_RE.exec("-# quiet context")?.[1], "quiet context", "Discord-style subtext is recognized");
const bareSubtextMatch = DISCORD_SUBTEXT_RE.exec("-#");
assert.ok(bareSubtextMatch, "bare Discord-style subtext is recognized");
assert.equal(bareSubtextMatch[1], undefined, "bare Discord-style subtext has no content");
assert.equal(DISCORD_SUBTEXT_RE.exec("-# ")?.[1], "", "empty Discord-style subtext with spacing is recognized");
assert.equal(DISCORD_SUBTEXT_RE.test("- ordinary list item"), false, "ordinary list items remain ordinary lists");
assert.match(
  applyInlineMarkdownHTML("<span>HTML</span><br>-# quiet context"),
  /<small class="mari-md-subtext">quiet context<\/small>/u,
  "embedded-HTML chat content receives the same Discord-style subtext rendering",
);
assert.equal(applyInlineMarkdownHTML("-#"), '<small class="mari-md-subtext"></small>');
assert.equal(applyInlineMarkdownHTML("-# "), '<small class="mari-md-subtext"></small>');

const markdownSource = readFileSync(join(repositoryRoot, "packages/client/src/lib/markdown.tsx"), "utf8");
assert.match(
  markdownSource,
  /<u key=\{`\$\{keyPrefix\}u\$\{key\+\+\}`\} className="mari-md-underline">/u,
  "the React Markdown path renders double underscores as underline",
);
assert.match(
  markdownSource,
  /<small key=\{`\$\{keyBase\}sub\$\{key\+\+\}`\} className="mari-md-subtext">/u,
  "the React Markdown path renders Discord-style subtext as a semantic small block",
);

const gameNarrationSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/game/GameNarration.tsx"),
  "utf8",
);
assert.match(gameNarrationSource, /mari-md-underline/u, "Game chat narration retains underline markup");
assert.match(gameNarrationSource, /mari-md-subtext/u, "Game chat narration retains Discord-style subtext markup");

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

const presetEditorSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/presets/PresetEditor.tsx"),
  "utf8",
);
assert.equal(
  presetEditorSource.match(/showMarkdownPreview/gu)?.length,
  3,
  "Conversation, Game, and section preset content expose Markdown previews",
);

const professorMariChatSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/chat/HomeProfessorMariChat.tsx"),
  "utf8",
);
assert.match(
  professorMariChatSource,
  /inputDrafts\.get\(PROFESSOR_MARI_DRAFT_KEY\)/u,
  "Home Professor Mari restores her composer from the persisted draft store",
);
assert.match(
  professorMariChatSource,
  /setInputDraft\(PROFESSOR_MARI_DRAFT_KEY,/u,
  "Home Professor Mari saves composer changes through the persisted draft store",
);

const continuationChips = [{ id: "continue", label: "Continue", prompt: "Continue with the current lorebook." }];
const guidedPlan = [
  {
    fieldKey: "setting",
    question: "Where should the story take place?",
    chips: [{ id: "setting-library", label: "Library", prompt: "A candlelit library" }],
  },
  {
    fieldKey: "tone",
    question: "What tone should it use?",
    chips: [{ id: "tone-mysterious", label: "Mysterious", prompt: "Mysterious" }],
  },
];
useAgentStore.getState().reset();
useAgentStore.getState().setMariChips("professor-chat", continuationChips);
useAgentStore.getState().setMariPlan("professor-chat", guidedPlan);
assert.equal(useAgentStore.getState().recordMariPlanAnswer("setting", "A candlelit library"), "advanced");
useAgentStore.getState().setActiveAgents(["professor_mari"]);
useAgentStore.getState().resetForChatChange();
assert.deepEqual(
  useAgentStore.getState().mariChips,
  continuationChips,
  "temporary chat/editor navigation retains Professor Mari continuation suggestions",
);
assert.equal(useAgentStore.getState().mariChipsChatId, "professor-chat");
assert.deepEqual(useAgentStore.getState().mariPlan, guidedPlan);
assert.equal(useAgentStore.getState().mariPlanChatId, "professor-chat");
assert.equal(useAgentStore.getState().mariPlanCursor, 1);
assert.deepEqual(useAgentStore.getState().mariPlanAnswers, { setting: "A candlelit library" });
assert.deepEqual(useAgentStore.getState().activeAgents, [], "other Agent runtime state still resets between chats");
useAgentStore.getState().reset();
assert.equal(useAgentStore.getState().mariPlan, null, "full Agent reset clears Professor Mari's guided plan");
assert.equal(useAgentStore.getState().mariPlanChatId, null);
assert.equal(useAgentStore.getState().mariPlanCursor, 0);
assert.deepEqual(useAgentStore.getState().mariPlanAnswers, {});

const chatStoreSource = readFileSync(join(repositoryRoot, "packages/client/src/stores/chat.store.ts"), "utf8");
assert.match(
  chatStoreSource,
  /useAgentStore\.getState\(\)\.resetForChatChange\(\)/u,
  "chat navigation uses the continuation-preserving Agent reset",
);

const presetsPanelSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/panels/PresetsPanel.tsx"),
  "utf8",
);
const unsupportedRegexPlacementGate =
  /const unsupportedPlacements = getUnsupportedStRegexPlacements\(entry\);[\s\S]*?const normalized =/u.exec(
    presetsPanelSource,
  )?.[0];
assert.ok(unsupportedRegexPlacementGate, "the preset regex placement import branch remains discoverable");
assert.doesNotMatch(
  unsupportedRegexPlacementGate,
  /continue;/u,
  "unsupported SillyTavern placements must not discard the entire preset regex entry",
);
const regexBeforeSuccessfulImport =
  /const unsupportedPlacements = getUnsupportedStRegexPlacements\(entry\);[\s\S]*?await createRegexScript\.mutateAsync\(normalized\);/u.exec(
    presetsPanelSource,
  )?.[0];
assert.ok(regexBeforeSuccessfulImport, "the preset regex pre-import path remains discoverable");
assert.doesNotMatch(
  regexBeforeSuccessfulImport,
  /warnings\.push/u,
  "unsupported placement warnings must not be emitted before the regex imports successfully",
);
const successfulRegexImportWarning =
  /await createRegexScript\.mutateAsync\(normalized\);[\s\S]*?warnings\.push\([\s\S]*?ignoredUnsupportedRegexPlacements"/u.exec(
    presetsPanelSource,
  )?.[0];
assert.ok(successfulRegexImportWarning, "the successful preset regex import warning remains discoverable");
assert.match(
  successfulRegexImportWarning,
  /await createRegexScript\.mutateAsync\(normalized\);[\s\S]*?warnings\.push/u,
  "ignored SillyTavern placements produce a warning only after the regex imports successfully",
);
assert.match(
  successfulRegexImportWarning,
  /localizeUi\("ui\.panels\.presetspanel\.ignoredUnsupportedRegexPlacements"/u,
  "unsupported placement warnings must use the localized message",
);

console.info("Assigned issue-sweep regressions passed.");
