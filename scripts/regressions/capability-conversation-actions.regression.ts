import assert from "node:assert/strict";
import {
  dispatchCapabilityConversationAction,
  parseCapabilityConversationCommands,
  registerCapabilityConversationCommand,
} from "../../packages/server/src/services/capability-packages/capability-command-registry.service.js";

let handled = 0;
const release = registerCapabilityConversationCommand({
  commandType: "phone",
  tags: ["phone"],
  maxPayloadChars: 80,
  validatePayload: (payload) => payload?.includes("send_message") ?? false,
  handler: () => {
    handled += 1;
  },
});

try {
  const [command] = parseCapabilityConversationCommands(
    'Before it goes, [phone:{"action":"send_message","body":"on my way"}]',
  );
  assert.deepEqual(command, {
    type: "capability",
    commandType: "phone",
    payload: '{"action":"send_message","body":"on my way"}',
  });

  const [oversized] = parseCapabilityConversationCommands(`[phone:${"x".repeat(81)}]`);
  assert.equal(oversized?.payload, null);

  // validatePayload rejects anything that is not the declared action.
  const [rejected] = parseCapabilityConversationCommands('[phone:{"action":"delete_all"}]');
  assert.equal(rejected?.payload, null);

  // Dispatch is idempotent per source message + swipe, so regeneration cannot double-send.
  const action = {
    type: "capability" as const,
    commandType: "phone",
    payload: '{"action":"send_message"}',
    chatId: "c1",
    sourceMessageId: "m1",
    swipeIndex: 0,
    branchChatId: "c1",
    characterId: "char1",
  };
  assert.equal(await dispatchCapabilityConversationAction(action), true);
  assert.equal(await dispatchCapabilityConversationAction(action), false);
  assert.equal(handled, 1);

  console.log("Capability conversation action regression passed.");
} finally {
  release();
}
