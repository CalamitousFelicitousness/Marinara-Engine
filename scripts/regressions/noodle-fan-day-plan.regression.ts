import assert from "node:assert/strict";
import {
  claimNoodleFanActivityRun,
  dueNoodleFanActivityRun,
  finishNoodleFanActivityRun,
  markNoodleFanActivityApplied,
  parsePersistedNoodleFanActivityDayPlan,
  reconcileNoodleFanActivityDayPlan,
  storeNoodleFanAcceptedActivities,
} from "../../packages/server/src/services/noodle/noodle-fan-activity-day-plan.js";

const morning = new Date(2026, 6, 10, 10, 0, 0, 0);
const creators = Array.from({ length: 13 }, (_, index) => `creator-${String(index + 1).padStart(2, "0")}`);
const plan = reconcileNoodleFanActivityDayPlan(null, creators, morning);

assert.equal(plan.runs.length, 4);
assert.deepEqual(plan.runs[0]!.creatorIds, creators.slice(0, 12));
assert.deepEqual(plan.runs[1]!.creatorIds, [creators[12], ...creators.slice(0, 11)]);
assert.deepEqual(plan.runs[2]!.creatorIds, creators.slice(11, 13).concat(creators.slice(0, 10)));
assert.equal(plan.nextCreatorOffset, 9);

const reconciled = reconcileNoodleFanActivityDayPlan(plan, creators, morning);
assert.equal(reconciled.runs[0]!.status, "skipped");
assert.equal(reconciled.runs[1]!.status, "scheduled");
assert.equal(dueNoodleFanActivityRun(reconciled, morning)?.id, reconciled.runs[1]!.id);

const claimed = claimNoodleFanActivityRun(reconciled, reconciled.runs[1]!.id, morning);
const stored = storeNoodleFanAcceptedActivities(claimed, claimed.runs[1]!.id, [
  {
    creatorId: "creator-1",
    actorId: "fan-1",
    type: "like",
    targetPostId: "post-1",
    snapshot: {
      id: "fan-1",
      kind: "random_user",
      entityId: "fan-1",
      handle: "fan_1",
      displayName: "Fan 1",
      avatarUrl: null,
      avatarCrop: null,
    },
  },
]);
assert.equal(stored.runs[1]!.status, "applying");
assert.equal(stored.runs[1]!.acceptedActivities[0]!.id, `${stored.runs[1]!.id}-activity-1`);
assert.equal(stored.runs[1]!.acceptedActivities[0]!.applied, false);

const applied = markNoodleFanActivityApplied(stored, stored.runs[1]!.id, stored.runs[1]!.acceptedActivities[0]!.id);
const completed = finishNoodleFanActivityRun(applied, applied.runs[1]!.id, "completed", morning);
assert.equal(completed.runs[1]!.acceptedActivities[0]!.applied, true);
assert.equal(completed.runs[1]!.status, "completed");
assert.deepEqual(parsePersistedNoodleFanActivityDayPlan(JSON.parse(JSON.stringify(completed))), completed);
assert.equal(parsePersistedNoodleFanActivityDayPlan({ ...completed, version: 2 }), null);

process.stdout.write("Noodle fan day-plan regression passed.\n");
