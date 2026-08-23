import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const trackerSidebar = readSource("packages/client/src/features/tracker-panel/components/TrackerDataSidebar.tsx");
const inventoryTracker = readSource(
  "packages/client/src/features/tracker-panel/components/sections/InventoryTrackerPanel.tsx",
);
const roleplayHud = readSource("packages/client/src/components/chat/RoleplayHUD.tsx");
const chatGallery = readSource("packages/client/src/components/chat/ChatGallery.tsx");
const chatSettingsDrawer = readSource("packages/client/src/components/chat/ChatSettingsDrawer.tsx");
const agentSettingsControls = readSource("packages/client/src/components/chat/AgentSettingsControls.tsx");
const translationSection = readSource("packages/client/src/features/chat-settings/sections/TranslationSection.tsx");

assert.doesNotMatch(
  trackerSidebar,
  /className="block \[--tracker-profile-icon:var\(--marinara-chat-chrome-accent\)\]"/u,
  "downloadable Tracker Panel sections must inherit the shared neutral header icon color",
);
assert.match(
  trackerSidebar,
  /className="block"/u,
  "downloadable Tracker Panel sections must retain block display styling",
);
assert.doesNotMatch(
  inventoryTracker,
  /className="\[--tracker-profile-icon:var\(--marinara-chat-chrome-accent\)\]"/u,
  "Inventory must inherit the same header icon color as other Tracker Panel sections",
);
assert.match(
  inventoryTracker,
  /<section className="@container relative z-10 overflow-hidden border-b/u,
  "Inventory must retain the shared Tracker Panel section wrapper",
);
assert.match(
  roleplayHud,
  /className: compact \? CHAT_TOOLBAR_MOBILE_OVERFLOW_HEIGHT_CLASS : undefined/u,
  "downloadable tracker controls must receive the built-in mobile toolbar height",
);
assert.match(
  chatGallery,
  /className="mari-chrome-field h-10 w-full !rounded-md pl-9 pr-10 text-xs"/u,
  "the shared Gallery search must reuse the standard chat field",
);
assert.match(
  chatSettingsDrawer,
  /case "director":\s*return <Clapperboard/u,
  "Narrative Director must use a distinct clapperboard icon instead of the generic agent star",
);
assert.match(
  chatSettingsDrawer,
  /case "expression":\s*return <VenetianMask/u,
  "Expression Engine must use a distinct theatre-mask icon in Chat Settings",
);
assert.match(
  agentSettingsControls,
  /<div className="flex h-full flex-col gap-1">[\s\S]*?"flex-1 justify-between rounded-md/u,
  "paired agent setting toggles must stretch to the same height",
);
assert.match(
  chatSettingsDrawer,
  /function getActiveAgentMenuDescription/u,
  "active agent menus must strip package installation instructions from their descriptions",
);
assert.match(chatSettingsDrawer, /"Add the Agent in Chat Settings"/u);
assert.match(chatSettingsDrawer, /"Enable it per chat from Chat Settings"/u);
assert.equal(
  (chatSettingsDrawer.match(/!h-8 !min-h-8 w-full whitespace-nowrap !py-0/gu) ?? []).length,
  2,
  "Lorebook Keeper actions must share one explicit height",
);
assert.match(
  translationSection,
  /className="mari-chrome-field mt-0\.5 w-full !rounded-md px-3 py-2 text-xs"/u,
  "the shared Translation language field must use the canonical Chat Settings input style",
);

process.stdout.write("Tracker and Gallery UI regression passed\n");
