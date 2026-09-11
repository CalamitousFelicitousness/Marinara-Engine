import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const uiStore = readSource("packages/client/src/stores/ui.store.ts");
const chatMessage = readSource("packages/client/src/components/chat/ChatMessage.tsx");
const conversationMessage = readSource("packages/client/src/components/chat/ConversationMessage.tsx");
const conversationBubble = readSource("packages/client/src/components/chat/ConversationMessageBubble.tsx");
const conversationLine = readSource("packages/client/src/components/chat/ConversationMessageLine.tsx");
const conversationGrouped = readSource("packages/client/src/components/chat/ConversationMessageGrouped.tsx");
const settingsPanel = readSource("packages/client/src/components/panels/SettingsPanel.tsx");
const englishCatalog = JSON.parse(readSource("packages/client/src/localization/locales/en.json"));

function countOccurrences(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

assert.match(uiStore, /messageControlsAbove: false,/u, "message controls must default to the below-message position");
assert.equal(
  countOccurrences(uiStore, /messageControlsAbove: state\.messageControlsAbove,/gu),
  2,
  "messageControlsAbove must be both synced and persisted",
);

// Each surface renders one placement or the other, never both and never neither.
for (const [surface, source, name] of [
  ["roleplay", chatMessage, "roleplayMessageControls"],
  ["texting", chatMessage, "messageControls"],
  ["conversation grouped", conversationGrouped, "messageControls"],
]) {
  assert.match(
    source,
    new RegExp(`messageControlsAbove && [\\s\\S]{0,200}${name}`, "u"),
    `${surface} messages must offer an above-body placement`,
  );
  assert.match(
    source,
    new RegExp(`!messageControlsAbove && [\\s\\S]{0,120}${name}`, "u"),
    `${surface} messages must keep the below-body placement`,
  );
}

// Bubble and line receive the node through a slot, so they only position it.
for (const [surface, source] of [
  ["conversation bubble", conversationBubble],
  ["conversation line", conversationLine],
]) {
  assert.match(
    source,
    /messageControlsAbove && controlsSlot &&/u,
    `${surface} messages must render the slot only above the body`,
  );
}

assert.match(
  conversationMessage,
  /controlsSlot=\{messageControlsAbove \? messageControls : null\}/u,
  "the Conversation shell must hand its controls to the layout only when they belong above the body",
);
assert.equal(
  countOccurrences(conversationMessage, /controlsSlot=\{messageControlsAbove \? messageControls : null\}/gu),
  2,
  "both the bubble and line layouts must receive the controls slot",
);
assert.match(
  conversationMessage,
  /\{!messageControlsAbove && messageControls\}/u,
  "the Conversation shell must keep the below-body placement",
);

// Swipes and the action row travel as one node. Splitting them would strand the
// swipe row below the body while the actions moved above it.
for (const [surface, source] of [
  ["conversation", conversationMessage],
  ["conversation grouped", conversationGrouped],
]) {
  assert.match(
    source,
    /const messageControls = \(\s*<>\s*<ConversationMessageSwipes ctx=\{ctx\} \/>\s*\{actionsRow\}\s*<\/>\s*\);/u,
    `${surface} controls must carry the swipe row with the action row`,
  );
}

// The grouped layout wraps trailing content in [data-card-css]; counting the
// swipe row there would paint an empty themed box once controls move above.
assert.doesNotMatch(
  conversationGrouped,
  /const hasTrailingContent =[^;]*[Ss]wipe/u,
  "grouped trailing content must not count the swipe row",
);

assert.match(
  settingsPanel,
  /getSettingsControlAnchorId\("message-controls-above"\)/u,
  "Message Tools must expose the control position toggle",
);
assert.equal(
  typeof englishCatalog["settings.controls.messageControlsAbove.label"],
  "string",
  "the control position toggle needs a localized label",
);
assert.equal(
  typeof englishCatalog["settings.controls.messageControlsAbove.help"],
  "string",
  "the control position toggle needs localized help text",
);

process.stdout.write("Message controls position regression passed\n");
