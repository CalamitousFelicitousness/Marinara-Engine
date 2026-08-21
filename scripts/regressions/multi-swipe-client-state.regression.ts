// Multiswipe client decision logic and cache plumbing.
// Pins: which action commits the pending swipe, that pending detection reads the
// persisted marker mirrored onto the message by setActiveSwipe, that an appended
// silent swipe raises the cached count, and which counts a surface may offer.

import assert from "node:assert/strict";

import type { Message } from "../../packages/shared/src/types/chat.js";
import { applyAppendedSwipeCount } from "../../packages/client/src/lib/message-cache-reconciliation.js";
import {
  findPendingMultiSwipeMessage,
  multiSwipeCountOptions,
  shouldFinalizeBeforeAction,
} from "../../packages/client/src/lib/multi-swipe-policy.js";
import { MAX_MULTI_SWIPE_CANDIDATES } from "../../packages/shared/src/utils/multi-swipe.js";

const marker = { pendingAgents: ["world-state"], candidateCount: 3, createdAt: 1_770_000_000 };

function message(id: string, role: Message["role"], extra?: unknown, swipeCount?: number): Message {
  return {
    id,
    chatId: "chat-1",
    role,
    characterId: null,
    content: `${id} content`,
    activeSwipeIndex: 0,
    swipeCount,
    createdAt: "2026-08-21T00:00:00.000Z",
    extra: extra as Message["extra"],
  } as Message;
}

// ── Pending detection ──
assert.equal(findPendingMultiSwipeMessage([]), null);
assert.equal(
  findPendingMultiSwipeMessage([message("a", "assistant", { isGenerated: true })]),
  null,
  "an ordinary message has no deferred agents",
);
assert.equal(
  findPendingMultiSwipeMessage([message("u", "user", { multiSwipe: marker })]),
  null,
  "only assistant messages can hold a spread",
);
assert.deepEqual(
  findPendingMultiSwipeMessage([message("a", "assistant", { multiSwipe: marker })]),
  { messageId: "a", pendingAgents: ["world-state"] },
  "a marked assistant message is pending",
);
assert.deepEqual(
  findPendingMultiSwipeMessage([message("a", "assistant", JSON.stringify({ multiSwipe: marker }))]),
  { messageId: "a", pendingAgents: ["world-state"] },
  "extras arriving as JSON strings must still be detected",
);
assert.equal(
  findPendingMultiSwipeMessage([message("a", "assistant", { multiSwipe: null })]),
  null,
  "finalize clears by writing an explicit null, which must read as committed",
);
assert.equal(
  findPendingMultiSwipeMessage([
    message("old", "assistant", { multiSwipe: marker }),
    message("new", "assistant", { multiSwipe: marker }),
  ])?.messageId,
  "new",
  "implicit finalize commits only the swipe the next turn builds on; older pending swipes wait for their badge",
);

// ── Finalize triggers ──
assert.equal(
  shouldFinalizeBeforeAction({ trigger: "send", pendingMessageId: null }),
  false,
  "nothing pending means no work",
);
for (const trigger of ["send", "continue", "explicit"] as const) {
  assert.equal(
    shouldFinalizeBeforeAction({ trigger, pendingMessageId: "a" }),
    true,
    `${trigger} commits whichever swipe the user left active`,
  );
}
assert.equal(
  shouldFinalizeBeforeAction({ trigger: "regenerate", pendingMessageId: "a", targetMessageId: "a" }),
  false,
  "regenerating the undecided message replaces the choice, so its agents must not run first",
);
assert.equal(
  shouldFinalizeBeforeAction({ trigger: "regenerate", pendingMessageId: "a", targetMessageId: "b" }),
  true,
  "regenerating a different message still commits the pending swipe",
);

// ── Cached swipe count ──
const cache = { pages: [[message("a", "assistant", {}, 2), message("b", "assistant", {}, 1)]], pageParams: [0] };

const bumped = applyAppendedSwipeCount(cache, "a", 3);
assert.equal(bumped?.pages[0]?.[0]?.swipeCount, 3, "an appended silent swipe must raise the count");
assert.equal(bumped?.pages[0]?.[1]?.swipeCount, 1, "other messages are untouched");
assert.notEqual(bumped, cache, "a real change produces a new object so React re-renders");

assert.equal(
  applyAppendedSwipeCount(cache, "a", 2),
  cache,
  "a stale or duplicate event must not churn the cache identity",
);
assert.equal(applyAppendedSwipeCount(cache, "missing", 9), cache, "unknown ids are ignored");
assert.equal(applyAppendedSwipeCount(undefined, "a", 3), undefined, "an empty cache stays empty");

const fromUnset = applyAppendedSwipeCount({ pages: [[message("a", "assistant", {})]], pageParams: [0] }, "a", 2);
assert.equal(fromUnset?.pages[0]?.[0]?.swipeCount, 2, "a message with no counted swipes still gains one");

// ── Which counts a surface offers ──
// Shared by the send button and the regenerate menu, so a surface can never
// present a fan-out the chat mode cannot perform.
assert.deepEqual(multiSwipeCountOptions({ multiSwipeMax: 4 }), [2, 3, 4], "the menu lists every count up to the cap");
assert.deepEqual(multiSwipeCountOptions({ multiSwipeMax: 2 }), [2], "a cap of 2 offers exactly one fan-out");
assert.deepEqual(multiSwipeCountOptions({ multiSwipeMax: 1 }), [], "Off means no gesture at all");
assert.deepEqual(
  multiSwipeCountOptions({ multiSwipeMax: 0 }),
  [],
  "a corrupted setting below the floor still means Off",
);
assert.deepEqual(
  multiSwipeCountOptions({ multiSwipeMax: 99 }),
  Array.from({ length: MAX_MULTI_SWIPE_CANDIDATES - 1 }, (_unused, index) => index + 2),
  "a setting above the cap clamps rather than listing impossible counts",
);
assert.deepEqual(
  multiSwipeCountOptions({ multiSwipeMax: 4, chatMode: "game" }),
  [],
  "game mode cannot replay its per-swipe snapshots at finalize, so it offers nothing",
);
for (const chatMode of ["roleplay", "conversation", null, undefined]) {
  assert.deepEqual(
    multiSwipeCountOptions({ multiSwipeMax: 3, chatMode }),
    [2, 3],
    `chat mode ${String(chatMode)} may fan out`,
  );
}

console.info("Multiswipe client state regression passed.");
