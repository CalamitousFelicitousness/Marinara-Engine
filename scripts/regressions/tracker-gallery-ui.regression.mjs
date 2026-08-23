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

assert.doesNotMatch(
  trackerSidebar,
  /className="block \[--tracker-profile-icon:var\(--marinara-chat-chrome-accent\)\]"/u,
  "downloadable Tracker Panel sections must inherit the shared neutral header icon color",
);
assert.doesNotMatch(
  inventoryTracker,
  /className="\[--tracker-profile-icon:var\(--marinara-chat-chrome-accent\)\]"/u,
  "Inventory must inherit the same header icon color as other Tracker Panel sections",
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

process.stdout.write("Tracker and Gallery UI regression passed\n");
