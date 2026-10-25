// Package integration controls live with their package: a chat or character control for Noodle or
// Slurp only shows while that package is installed and active, and package prompt context receives
// the preset's wrap format so its block matches the prompt around it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const drawer = read("packages/client/src/components/chat/ChatSettingsDrawer.tsx");
const convoFields = read("packages/client/src/components/characters/ConvoProfileFields.tsx");
const characterEditor = read("packages/client/src/components/characters/CharacterEditor.tsx");
const homeBrowserHub = read("packages/client/src/components/chat/HomeBrowserHub.tsx");
const promptContext = read("packages/server/src/services/capability-packages/capability-prompt-context.service.ts");
const chatsRoutes = read("packages/server/src/routes/chats.routes.ts");
const english = JSON.parse(read("packages/client/src/localization/locales/en.json")) as Record<string, string>;

// Chat settings: each package's toggle is gated on that package.
assert.match(drawer, /const noodleInstalled = isCapabilityPackageAvailable\(installedCapabilities, "noodle"\);/u);
assert.match(drawer, /const slurp2Installed = isCapabilityPackageAvailable\(installedCapabilities, "slurp2"\);/u);
assert.match(drawer, /\{noodleInstalled && \(\s*<SettingsSwitch[\s\S]*?noodleTimelineContextEnabled: checked/u);
assert.match(drawer, /\{slurp2Installed && \(\s*<SettingsSwitch[\s\S]*?slurp2ActivityContextEnabled: checked/u);
assert.doesNotMatch(drawer, /renderNoodleTimelineContextToggle/u, "no render site may bypass the install gate");
assert.equal(
  drawer.match(/\{renderPackageContextToggles\(\)\}/gu)?.length,
  4,
  "every chat mode renders the gated toggles",
);
// Slurp activity is opt-in per chat.
assert.match(drawer, /const slurp2ActivityContextEnabled = metadata\.slurp2ActivityContextEnabled === true;/u);
assert.ok(english["ui.chat.chatsettingsdrawer.allowSlurpActivity"]);
assert.ok(english["ui.chat.chatsettingsdrawer.allowSlurpActivityDescription"]);
assert.match(chatsRoutes, /typeof incoming\.slurp2ActivityContextEnabled !== "boolean"/u);

// Character editor: the image instructions stay; the Noodle checkbox moved into Noodle's own profile editor.
assert.match(convoFields, /\{kind === "character" && onImageInstructionsChange && \(/u);
assert.doesNotMatch(convoFields, /onApplyImageInstructionsToNoodleChange/u);
assert.doesNotMatch(characterEditor, /applyConversationImageInstructionsToNoodle/u);
// Capability API 1.67: the browser view can open a character in the editor, on a tab.
assert.match(
  homeBrowserHub,
  /openCharacter: \(characterId: string, options\?: \{ tab\?: string \}\) => \{[\s\S]*?openCharacterDetail\(characterId, \{\s*initialTab:/u,
);
// Capability API 1.386: it can open a connection in the editor and comes back to its tab. Home is asked
// for the tab first, because the desktop shell unmounts Home while the editor is open; the request
// outlives the editor and the remounted Home consumes it.
assert.match(
  homeBrowserHub,
  /openConnection: \(connectionId: string\) => \{\s*if \(typeof connectionId !== "string" \|\| !connectionId\) return;[\s\S]*?\.requestHome\(\{ kind: "tab", tab: activeTab \}\);\s*\S+\.openConnectionDetail\(connectionId\);/u,
);
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const { useUIStore, pickPersistedUIState } = await import("../../packages/client/src/stores/ui.store.js");
useUIStore.getState().requestHome({ kind: "tab", tab: "story-writer" });
useUIStore.getState().openConnectionDetail("connection-1");
assert.equal(useUIStore.getState().connectionDetailId, "connection-1");
useUIStore.getState().closeConnectionDetail();
assert.deepEqual(useUIStore.getState().homeRequest, { kind: "tab", tab: "story-writer" });
assert.ok(!("homeRequest" in pickPersistedUIState(useUIStore.getState())), "a Home request is never saved");

// Package prompt context carries the wrap format.
assert.match(promptContext, /wrapFormat\?: "xml" \| "markdown" \| "none";/u);
// The actual contributor inputs are exercised through generation and preview in
// capability-prompt-preview.regression.ts, independent of the collector's file or call shape.

console.log("capability package chat controls regression passed");
