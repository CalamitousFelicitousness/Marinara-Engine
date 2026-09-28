import assert from "node:assert/strict";
import {
  MAX_PINNED_CONTEXT_MESSAGES,
  PINNED_CONTEXT_MESSAGE_MARKER,
  applyContextMessageLimitWithPins,
  normalizeMessageMarkPatch,
  stripPrivateMessageNote,
} from "../../packages/shared/src/utils/message-marks.js";

type Row = { id: string; content: string; extra: string };
const row = (id: string, pinned = false): Row => ({
  id,
  content: `content ${id}`,
  extra: JSON.stringify(pinned ? { pinnedToContext: true } : {}),
});
const history = Array.from({ length: 12 }, (_, index) => row(`m${index + 1}`, [1, 4, 9].includes(index)));

assert.deepEqual(
  applyContextMessageLimitWithPins(history, 4).map((message) => message.id),
  ["m2", "m5", "m9", "m10", "m11", "m12"],
);
const limited = applyContextMessageLimitWithPins(history, 4);
assert.equal(limited[0]!.content, `${PINNED_CONTEXT_MESSAGE_MARKER}\ncontent m2`);
assert.equal(limited[3], history[9], "a pinned message already inside the retained window is unchanged");
assert.equal(history[1]!.content, "content m2", "pin marking must not mutate persisted history");
const manyPins = Array.from({ length: 30 }, (_, index) => row(`p${index}`, true));
assert.equal(applyContextMessageLimitWithPins(manyPins, 5).length, 5 + MAX_PINNED_CONTEXT_MESSAGES);
assert.deepEqual(
  applyContextMessageLimitWithPins(history, 0.5),
  history,
  "a positive fractional limit that floors to zero does not remove the entire history",
);

assert.deepEqual(normalizeMessageMarkPatch({ bookmark: true }, () => "2026-09-27T00:00:00.000Z"), {
  patch: { bookmark: { label: null, createdAt: "2026-09-27T00:00:00.000Z" } },
});
assert.ok("error" in normalizeMessageMarkPatch({ privateNote: "x".repeat(2001) }));
assert.deepEqual(normalizeMessageMarkPatch({ privateNote: "  " }), { patch: { privateNote: null } });
assert.deepEqual(stripPrivateMessageNote({ other: true, privateNote: "secret" }), { other: true });

process.stdout.write("Message marks regression passed.\n");
