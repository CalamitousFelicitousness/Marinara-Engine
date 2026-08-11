import assert from "node:assert/strict";
import {
  parseCapabilityConversationCommands,
  registerCapabilityConversationCommand,
} from "../../packages/server/src/services/capability-packages/capability-command-registry.service.js";

const release = registerCapabilityConversationCommand({
  commandType: "phone",
  tags: ["phone"],
  maxPayloadChars: 80,
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

  const [malformed] = parseCapabilityConversationCommands("[phone:not json]");
  assert.equal(malformed?.payload, "not json");
  console.log("Capability conversation action regression passed.");
} finally {
  release();
}
