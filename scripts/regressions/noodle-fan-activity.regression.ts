import assert from "node:assert/strict";
import type { NoodleAccount } from "../../packages/shared/src/types/noodle.js";
import { selectNoodlerFanActivities } from "../../packages/server/src/services/noodle/noodle-noodler-fan-activity.service.js";

const actor = { id: "fan-1", handle: "thread_countess" } as NoodleAccount;
const selected = selectNoodlerFanActivities({
  activities: [
    { actorHandle: "thread_countess", targetPostId: "public-1", type: "like", content: null },
    { actorHandle: "thread_countess", targetPostId: "public-1", type: "like", content: null },
    { actorHandle: "invented", targetPostId: "public-1", type: "reply", content: "Unknown actor" },
    { actorHandle: "thread_countess", targetPostId: "locked-1", type: "reply", content: "Locked" },
    { actorHandle: "thread_countess", targetPostId: "public-1", type: "reply", content: "  Nice post.  " },
    { actorHandle: "thread_countess", targetPostId: "public-1", type: "reply", content: "Over quota" },
    { actorHandle: "thread_countess", targetPostId: "public-1", type: "repost", content: "ignored" },
  ],
  actors: [actor],
  posts: [
    { id: "public-1", access: "public" },
    { id: "locked-1", access: "locked" },
  ],
  existingInteractions: [],
  quotas: { like: 1, reply: 1, repost: 1 },
});

assert.deepEqual(
  selected.map(({ actor: selectedActor, ...activity }) => ({ actorId: selectedActor.id, ...activity })),
  [
    { actorId: "fan-1", postId: "public-1", type: "like", content: null },
    { actorId: "fan-1", postId: "public-1", type: "reply", content: "Nice post." },
    { actorId: "fan-1", postId: "public-1", type: "repost", content: null },
  ],
);

assert.deepEqual(
  selectNoodlerFanActivities({
    activities: [{ actorHandle: "thread_countess", targetPostId: "public-1", type: "like", content: null }],
    actors: [actor],
    posts: [{ id: "public-1", access: "public" }],
    existingInteractions: [{ postId: "public-1", actorAccountId: "fan-1", type: "like", content: null }],
    quotas: { like: 1, reply: 1, repost: 1 },
  }),
  [],
);

process.stdout.write("NoodleR fan activity regression passed.\n");
