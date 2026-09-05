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
// The grouped layout gates its below-body row on hasSwipeContent, which carries
// the same flag so the [data-card-css] trailing wrapper collapses with it.
for (const [surface, source, name, belowGuard] of [
  ["roleplay", chatMessage, "roleplayMessageControls", "!messageControlsAbove"],
  ["texting", chatMessage, "messageControls", "!messageControlsAbove"],
  ["conversation bubble", conversationBubble, "swipeControls", "!messageControlsAbove"],
  ["conversation line", conversationLine, "swipeControls", "!messageControlsAbove"],
  ["conversation grouped", conversationGrouped, "swipeControls", "hasSwipeContent"],
]) {
  assert.match(
    source,
    new RegExp(`messageControlsAbove && [\\s\\S]{0,200}${name}`, "u"),
    `${surface} messages must offer an above-body placement`,
  );
  assert.match(
    source,
    new RegExp(`${belowGuard} && [\\s\\S]{0,120}${name}`, "u"),
    `${surface} messages must keep the below-body placement`,
  );
}

assert.match(
  conversationMessage,
  /controlsSlot=\{messageControlsAbove \? actionsRow : null\}/u,
  "the Conversation shell must hand its action row to the layout only when it belongs above the body",
);
assert.equal(
  countOccurrences(conversationMessage, /controlsSlot=\{messageControlsAbove \? actionsRow : null\}/gu),
  2,
  "both the bubble and line layouts must receive the action row slot",
);

// The grouped layout wraps trailing content in [data-card-css]; leaving swipes in
// that tally would paint an empty themed box once they render above instead.
assert.match(
  conversationGrouped,
  /const hasSwipeContent =\s*\n?\s*!messageControlsAbove &&/u,
  "grouped trailing content must stop counting swipes once they move above the segments",
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
