// Multiswipe gating and candidate sanitizing.
// Pins: which requests may fan out at all, that candidate text is stripped of
// constructs a candidate must never execute, and that the deferred-agent marker
// survives a storage round trip.

import assert from "node:assert/strict";

import {
  MAX_MULTI_SWIPE_CANDIDATES,
  normalizeMultiSwipeCandidateCount,
  parseMultiSwipePendingMarker,
  readMultiSwipePendingMarker,
  type MultiSwipePendingMarker,
} from "../../packages/shared/src/utils/multi-swipe.js";
import {
  resolveMultiSwipeCount,
  sanitizeMultiSwipeCandidate,
  type MultiSwipeCountInput,
  type MultiSwipeSanitizeContext,
} from "../../packages/server/src/routes/generate/multi-swipe-candidates.js";

// ── Count clamping ──
assert.equal(normalizeMultiSwipeCandidateCount(undefined), 1);
assert.equal(normalizeMultiSwipeCandidateCount(0), 1);
assert.equal(normalizeMultiSwipeCandidateCount(-5), 1);
assert.equal(normalizeMultiSwipeCandidateCount(Number.NaN), 1);
assert.equal(normalizeMultiSwipeCandidateCount("3"), 3, "stored settings may arrive as strings");
assert.equal(normalizeMultiSwipeCandidateCount(2.9), 2, "fractions truncate rather than round up");
assert.equal(normalizeMultiSwipeCandidateCount(99), MAX_MULTI_SWIPE_CANDIDATES, "requests above the cap clamp down");

// ── Gating matrix ──
const baseCountInput: MultiSwipeCountInput = {
  requested: 3,
  regenerateMessageId: "message-1",
  continueMessageId: null,
  impersonate: false,
  turnGameBots: false,
  chatMode: "roleplay",
  isGroupChat: false,
  groupChatMode: "merged",
};

assert.equal(resolveMultiSwipeCount(baseCountInput), 3, "a plain roleplay regenerate may fan out");
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, chatMode: "conversation" }),
  3,
  "conversation regenerates may fan out",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, isGroupChat: true, groupChatMode: "merged" }),
  3,
  "merged group regenerates produce one message, so they may fan out",
);
assert.equal(resolveMultiSwipeCount({ ...baseCountInput, requested: 1 }), 1, "a count of 1 stays stock behavior");
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, regenerateMessageId: null }),
  1,
  "a new turn has no message to append candidate swipes to",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, continueMessageId: "message-1" }),
  1,
  "continue extends a message in place instead of adding swipes",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, impersonate: true }),
  1,
  "impersonate saves a user row, not an assistant swipe",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, turnGameBots: true }),
  1,
  "turn-game bot turns drive seats rather than a chat reply",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, chatMode: "game" }),
  1,
  "game mode save-time map parsing and per-swipe snapshots do not replay at finalize",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, isGroupChat: true, groupChatMode: "individual" }),
  1,
  "individual group mode writes one message per speaker",
);
assert.equal(
  resolveMultiSwipeCount({ ...baseCountInput, requested: 99 }),
  MAX_MULTI_SWIPE_CANDIDATES,
  "the server re-clamps whatever the client asked for",
);

// ── Sanitizing ──
const roleplayCtx: MultiSwipeSanitizeContext = {
  chatMode: "roleplay",
  conversationCommandsEnabled: false,
  roleplayDmCommandsEnabled: false,
  stripOocForConnectedChat: false,
  conversationEnvelope: null,
  trimIncompleteModelOutput: false,
  stripSpatialDirectives: false,
};

{
  const result = sanitizeMultiSwipeCandidate("<think>Plotting.</think>She smiles.", roleplayCtx);
  assert.equal(result.content, "She smiles.", "inline reasoning must not reach the visible candidate");
  assert.equal(result.inlineThinking, "Plotting.", "lifted reasoning is retained for the swipe's extra");
}

{
  // A doubled prefill echo collapses to one copy.
  const result = sanitizeMultiSwipeCandidate('"Hello,""Hello," she said.', {
    ...roleplayCtx,
    assistantPrefill: '"Hello,"',
  });
  assert.equal(result.content, '"Hello," she said.', "a repeated prefill echo must collapse to a single copy");
}

{
  const result = sanitizeMultiSwipeCandidate("Visible line.\n\n<ooc>Author aside.</ooc>", {
    ...roleplayCtx,
    stripOocForConnectedChat: true,
  });
  assert.equal(result.content, "Visible line.", "OOC blocks are extracted for the linked chat, never displayed");
  assert.equal(result.droppedOocCount, 1, "dropped OOC blocks are counted for the warning log");
}

{
  const result = sanitizeMultiSwipeCandidate("She steps outside. [spatial_move: location=\"garden\"]", {
    ...roleplayCtx,
    stripSpatialDirectives: true,
  });
  assert.ok(!result.content.includes("spatial_move"), "a candidate must not carry an unexecuted spatial directive");
  assert.equal(result.droppedSpatialDirective, true);
}

{
  const result = sanitizeMultiSwipeCandidate('Talking. [dm: character="Ada" message="Hi"]', {
    ...roleplayCtx,
    roleplayDmCommandsEnabled: true,
  });
  assert.ok(!result.content.includes("[dm:"), "DM commands are stripped because candidates never execute them");
  assert.equal(result.droppedDmCommandCount, 1);
}

{
  const result = sanitizeMultiSwipeCandidate("Trailing spaces   \nnext line", roleplayCtx);
  assert.equal(result.content, "Trailing spaces\nnext line", "roleplay whitespace normalization must still apply");
}

{
  const conversationCtx: MultiSwipeSanitizeContext = {
    chatMode: "conversation",
    conversationCommandsEnabled: true,
    roleplayDmCommandsEnabled: false,
    stripOocForConnectedChat: false,
    conversationEnvelope: { speakerName: "Ada", speakerNames: ["Ada"], preserveSpeakerPrefix: false },
    trimIncompleteModelOutput: false,
    stripSpatialDirectives: false,
  };
  const result = sanitizeMultiSwipeCandidate("[11.07 15:53] Ada: Hey there! [selfie]", conversationCtx);
  assert.equal(result.content, "Hey there!", "leaked timestamps, speaker prefixes, and commands are all stripped");
  assert.ok(
    result.conversationCommandContent?.includes("[selfie]"),
    "the pre-strip text is retained so a chosen candidate keeps commands in model-visible history",
  );
  assert.equal(result.droppedCommandCount, 1);

  const disabled = sanitizeMultiSwipeCandidate("[11.07 15:53] Ada: Hey there! [selfie]", {
    ...conversationCtx,
    filterEnabledCommands: () => [],
  });
  assert.equal(
    disabled.conversationCommandContent,
    null,
    "commands disabled for the chat must not retain hidden command history",
  );
  assert.equal(disabled.content, "Hey there!", "a disabled command is still stripped from visible text");
}

{
  const trimCtx: MultiSwipeSanitizeContext = { ...roleplayCtx, trimIncompleteModelOutput: true };
  const result = sanitizeMultiSwipeCandidate("She smiled. She turned and", trimCtx);
  assert.equal(result.content, "She smiled.", "a dangling final sentence trims back to the last complete one");
  assert.equal(
    sanitizeMultiSwipeCandidate("She turned and", trimCtx).content,
    "She turned and",
    "text with no complete sentence is left alone rather than emptied",
  );
}

{
  const result = sanitizeMultiSwipeCandidate("   \n  ", roleplayCtx);
  assert.equal(result.content, "", "a blank candidate reports empty so the loop can drop it");
}

// ── Marker round trip ──
const marker: MultiSwipePendingMarker = {
  pendingAgents: ["world-state", "expression-engine"],
  candidateCount: 3,
  createdAt: 1_770_000_000,
};

assert.deepEqual(parseMultiSwipePendingMarker(marker), marker);
assert.equal(parseMultiSwipePendingMarker(null), null);
assert.equal(parseMultiSwipePendingMarker("nonsense"), null);
assert.equal(parseMultiSwipePendingMarker([]), null, "an array is not a marker");
assert.equal(parseMultiSwipePendingMarker({ candidateCount: 2 }), null, "a marker without an agent list is not usable");
assert.deepEqual(
  parseMultiSwipePendingMarker({ pendingAgents: ["a", 7, ""], candidateCount: 99, createdAt: "x" }),
  { pendingAgents: ["a"], candidateCount: MAX_MULTI_SWIPE_CANDIDATES, createdAt: 0 },
  "stored markers are re-normalized rather than trusted",
);

assert.deepEqual(
  readMultiSwipePendingMarker(JSON.stringify({ multiSwipe: marker })),
  marker,
  "markers must survive the JSON string form extras are stored in",
);
assert.deepEqual(readMultiSwipePendingMarker({ multiSwipe: marker }), marker);
assert.equal(readMultiSwipePendingMarker({ multiSwipe: null }), null, "finalize clears the marker by nulling it");
assert.equal(readMultiSwipePendingMarker("{not json"), null);
assert.equal(readMultiSwipePendingMarker(undefined), null);

console.info("Multiswipe gating and sanitizing regression passed.");
