import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const roleplayHud = readSource("packages/client/src/components/chat/RoleplayHUD.tsx");
const roleplayPanels = readSource("packages/client/src/components/chat/RoleplayHUDPanels.tsx");
const chatHelp = readSource("packages/client/src/components/chat/ChatHelpOverlay.tsx");

const beholderLauncher = roleplayHud.indexOf("item.id}-beholder-launcher");
const agentsGroup = roleplayHud.indexOf("<ActionsGroup");
assert.ok(
  beholderLauncher >= 0 && beholderLauncher < agentsGroup,
  "Beholder must launch between Tracker Panel and Agents",
);
assert.doesNotMatch(
  roleplayHud,
  /\[\.\.\.memoryNagTrackerPackages, \.\.\.otherRoleplayTrackerPackages, \.\.\.beholderTrackerPackages\]/u,
  "mobile must not mount standalone Memory Nag or Beholder controls in the tracker row",
);
assert.match(
  roleplayPanels,
  /showQuests[\s\S]*showInventory[\s\S]*memoryNagPackageIds\.map[\s\S]*showCustomTracker/u,
  "the combined mobile tracker panel must order Inventory and Memory Nag after Quests and before Custom",
);
assert.match(
  chatHelp,
  /element\.matches\("button, \[role='button'\], input, textarea"\)[\s\S]*interactiveRect/u,
  "help targets must be able to use the full interactive control bounds",
);
assert.match(
  chatHelp,
  /definition\.selector\.startsWith\("\[data-chat-help="\)[\s\S]*readVisibleRect\(element, preferInteractive\)/u,
  "only chat toolbar targets should shrink to their interactive controls",
);
assert.match(
  chatHelp,
  /window\.innerWidth < 768 \? 0 : TARGET_PADDING/u,
  "dense mobile help targets must not be expanded into overlapping frames",
);

process.stdout.write("Mobile tracker and help layout regression passed\n");
