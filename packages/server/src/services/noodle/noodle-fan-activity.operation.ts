import type { NoodleAuthorSnapshot, NoodleSettings } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { noodlerFanActivityState } from "../../db/schema/noodle.js";
import { now } from "../../utils/id-generator.js";
import { tryBackgroundConnection } from "../generation/connection-admission.js";
import { createNoodleStorage } from "../storage/noodle.storage.js";
import {
  claimManualNoodleFanActivityRun,
  claimNoodleFanActivityRun,
  dueNoodleFanActivityRun,
  finishNoodleFanActivityRun,
  markNoodleFanActivityApplied,
  parsePersistedNoodleFanActivityDayPlan,
  reconcileNoodleFanActivityDayPlan,
  storeNoodleFanAcceptedActivities,
  type NoodleFanActivityDayPlanRun,
  type PersistedNoodleFanActivityDayPlan,
} from "./noodle-fan-activity-day-plan.js";
import {
  generateNoodlerFanActivityBatch,
  prepareNoodlerFanCreatorCandidates,
  resolveNoodlerFanActivityPolicy,
  resolveNoodlerFanConnection,
} from "./noodle-noodler-fan-activity.service.js";
import { claimNoodleOperation } from "./noodle-operation-lock.js";

const FAN_PLAN_ROW_PREFIX = "fan-day:";

export type NoodlerFanRunResult = {
  status:
    | "generated"
    | "resumed"
    | "not_due"
    | "disabled"
    | "busy"
    | "limit_reached"
    | "connection_required"
    | "connection_not_found"
    | "no_eligible_posts"
    | "abandoned";
  created: number;
  runId?: string;
};

async function readPlans(db: DB) {
  const rows = await db.select().from(noodlerFanActivityState);
  return rows.flatMap((row) => {
    try {
      const plan = parsePersistedNoodleFanActivityDayPlan(JSON.parse(row.plan));
      return plan ? [plan] : [];
    } catch {
      return [];
    }
  });
}

async function readCurrentPlan(db: DB, at: Date) {
  const plans = await readPlans(db);
  return plans.find((plan) => plan.localDate === localPlanDate(at)) ?? null;
}

function localPlanDate(at: Date) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function planRowId(plan: PersistedNoodleFanActivityDayPlan) {
  return `${FAN_PLAN_ROW_PREFIX}${plan.localDate}:${plan.timezone}`;
}

async function writePlan(db: DB, plan: PersistedNoodleFanActivityDayPlan) {
  const id = planRowId(plan);
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(noodlerFanActivityState).where(eq(noodlerFanActivityState.id, id));
    if (rows[0]) {
      await tx
        .update(noodlerFanActivityState)
        .set({ plan: JSON.stringify(plan), updatedAt: now() })
        .where(eq(noodlerFanActivityState.id, id));
    } else {
      await tx.insert(noodlerFanActivityState).values({ id, plan: JSON.stringify(plan), updatedAt: now() });
    }
  });
}

async function findRecoverablePlan(db: DB) {
  for (const plan of await readPlans(db)) {
    const applying = plan.runs.find((run) => run.status === "applying");
    if (applying) return { plan, run: applying, interrupted: false };
    const generating = plan.runs.find((run) => run.status === "generating");
    if (generating) return { plan, run: generating, interrupted: true };
  }
  return null;
}

async function reconcilePlan(db: DB, settings: NoodleSettings, at: Date) {
  const noodle = createNoodleStorage(db);
  const creators = await noodle.listNoodlerAccounts();
  const eligibleIds = settings.fanActivityEnabled
    ? creators
        .filter((creator) => resolveNoodlerFanActivityPolicy(settings, creator).enabled)
        .map((creator) => creator.id)
    : [];
  const plan = reconcileNoodleFanActivityDayPlan(await readCurrentPlan(db, at), eligibleIds, at);
  await writePlan(db, plan);
  return plan;
}

async function applyAcceptedActivities(
  db: DB,
  plan: PersistedNoodleFanActivityDayPlan,
  run: NoodleFanActivityDayPlanRun,
  settings: NoodleSettings,
) {
  const noodle = createNoodleStorage(db);
  let current = plan;
  let created = 0;
  for (const activity of run.acceptedActivities) {
    if (activity.applied) continue;
    const creator = await noodle.getNoodlerAccountById(activity.creatorId);
    if (!creator || !resolveNoodlerFanActivityPolicy(settings, creator).enabled) {
      current = markNoodleFanActivityApplied(current, run.id, activity.id);
      await writePlan(db, current);
      continue;
    }
    const result = await noodle.createNoodlerFanInteraction(activity.targetPostId, {
      id: activity.id,
      creatorAccountId: activity.creatorId,
      actorId: activity.actorId,
      actorSnapshot: activity.snapshot as NoodleAuthorSnapshot,
      runId: run.id,
      type: activity.type as "like" | "reply" | "repost",
      content: activity.content,
    });
    if (result?.created) created += 1;
    current = markNoodleFanActivityApplied(current, run.id, activity.id);
    await writePlan(db, current);
  }
  current = finishNoodleFanActivityRun(current, run.id, "completed", new Date());
  await writePlan(db, current);
  return created;
}

export async function runNoodlerFanActivity(input: {
  db: DB;
  mode: "automatic" | "manual";
  at?: Date;
  debugMode?: boolean;
}): Promise<NoodlerFanRunResult> {
  const release = claimNoodleOperation("noodler-fan-activity");
  if (!release) return { status: "busy", created: 0 };
  try {
    const at = input.at ?? new Date();
    const noodle = createNoodleStorage(input.db);
    const settings = await noodle.getSettings();
    const recoverable = await findRecoverablePlan(input.db);
    if (recoverable?.interrupted) {
      const abandoned = finishNoodleFanActivityRun(recoverable.plan, recoverable.run.id, "abandoned", at);
      await writePlan(input.db, abandoned);
    } else if (recoverable) {
      return {
        status: "resumed",
        created: await applyAcceptedActivities(input.db, recoverable.plan, recoverable.run, settings),
        runId: recoverable.run.id,
      };
    }
    if (!settings.enableNoodler || !settings.fanActivityEnabled) return { status: "disabled", created: 0 };
    let plan = await reconcilePlan(input.db, settings, at);

    const connectionId = settings.generationConnectionId;
    if (!connectionId) return { status: "connection_required", created: 0 };
    const connection = await resolveNoodlerFanConnection(input.db, settings);
    if (!connection) return { status: "connection_not_found", created: 0 };
    const admission = tryBackgroundConnection(connection.id, at);
    if (!admission.acquired) return { status: "busy", created: 0 };

    try {
      let run: NoodleFanActivityDayPlanRun | null;
      if (input.mode === "manual") {
        const claimed = claimManualNoodleFanActivityRun(plan, at);
        if (!claimed) return { status: "limit_reached", created: 0 };
        plan = claimed.plan;
        run = claimed.run;
      } else {
        run = dueNoodleFanActivityRun(plan, at);
        if (!run) return { status: "not_due", created: 0 };
        plan = claimNoodleFanActivityRun(plan, run.id, at);
        run = plan.runs.find((candidate) => candidate.id === run!.id)!;
      }
      await writePlan(input.db, plan);

      const creators = await prepareNoodlerFanCreatorCandidates({
        db: input.db,
        settings,
        creatorIds: run.creatorIds,
      });
      if (creators.length === 0) {
        plan = finishNoodleFanActivityRun(plan, run.id, "skipped", new Date());
        await writePlan(input.db, plan);
        return { status: "no_eligible_posts", created: 0, runId: run.id };
      }

      try {
        const accepted = await generateNoodlerFanActivityBatch({
          db: input.db,
          settings,
          connection,
          creators,
          debugMode: input.debugMode,
        });
        plan = storeNoodleFanAcceptedActivities(plan, run.id, accepted);
        await writePlan(input.db, plan);
        const storedRun = plan.runs.find((candidate) => candidate.id === run!.id)!;
        const created = await applyAcceptedActivities(input.db, plan, storedRun, settings);
        return { status: "generated", created, runId: run.id };
      } catch (error) {
        plan = finishNoodleFanActivityRun(plan, run.id, "abandoned", new Date());
        await writePlan(input.db, plan);
        throw error;
      }
    } finally {
      admission.release();
    }
  } finally {
    release();
  }
}

export async function getNoodlerFanActivityStatus(db: DB, at = new Date()) {
  const plan = await readCurrentPlan(db, at);
  return {
    localDate: plan?.localDate ?? localPlanDate(at),
    usedRuns: plan?.runs.filter((run) => run.status !== "scheduled").length ?? 0,
    runLimit: plan?.runs.length ?? 4,
    lastRun: plan ? ([...plan.runs].reverse().find((run) => run.status !== "scheduled") ?? null) : null,
  };
}
