import assert from "node:assert/strict";
import {
  replaceBuiltInAgentDefinitions,
  type BuiltInAgentManifest,
} from "../../packages/shared/dist/index.js";
import { buildRoleplayAgentSettingsOrder } from "../../packages/client/src/lib/agent-settings-order.js";
import { isReviewableWriterAgentType } from "../../packages/server/src/services/generation/runtime-agent-sections.js";

const manifests: BuiltInAgentManifest[] = [
  {
    id: "late-tracker",
    name: "Late tracker",
    description: "Loaded after the consuming modules.",
    phase: "post_processing",
    enabledByDefault: false,
    category: "tracker",
  },
  {
    id: "illustrator",
    name: "Illustrator",
    description: "Writer ordering anchor.",
    phase: "pre_generation",
    enabledByDefault: false,
    category: "writer",
  },
  {
    id: "late-writer",
    name: "Late writer",
    description: "Loaded after the consuming modules.",
    phase: "pre_generation",
    enabledByDefault: false,
    category: "writer",
  },
  {
    id: "late-misc",
    name: "Late misc agent",
    description: "Loaded after the consuming modules.",
    phase: "post_processing",
    enabledByDefault: false,
    category: "misc",
  },
  {
    id: "director",
    name: "Director",
    description: "Deliberately excluded from writer approval.",
    phase: "pre_generation",
    enabledByDefault: false,
    category: "writer",
    libraryHidden: true,
  },
  {
    id: "knowledge-retrieval",
    name: "Knowledge retrieval",
    description: "Deliberately excluded from writer approval.",
    phase: "pre_generation",
    enabledByDefault: false,
    category: "writer",
    libraryHidden: true,
  },
  {
    id: "knowledge-router",
    name: "Knowledge router",
    description: "Deliberately excluded from writer approval.",
    phase: "pre_generation",
    enabledByDefault: false,
    category: "writer",
    libraryHidden: true,
  },
];

replaceBuiltInAgentDefinitions(manifests);

assert.equal(
  isReviewableWriterAgentType("late-writer"),
  true,
  "Writer approval eligibility must observe agents hydrated after module import",
);
assert.equal(isReviewableWriterAgentType("illustrator"), true);
assert.equal(isReviewableWriterAgentType("late-tracker"), false);
assert.equal(isReviewableWriterAgentType("director"), false);
assert.equal(isReviewableWriterAgentType("knowledge-retrieval"), false);
assert.equal(isReviewableWriterAgentType("knowledge-router"), false);

const settingsOrder = buildRoleplayAgentSettingsOrder(manifests);
assert.equal(settingsOrder.get("illustrator"), 0);
assert.equal(settingsOrder.get("late-writer"), 1);
assert.equal(settingsOrder.get("storyboard"), 0.5);
assert.equal(settingsOrder.get("late-tracker"), 2);
assert.equal(settingsOrder.get("late-misc"), 3);

console.info("Agent registry hydration regression passed.");
