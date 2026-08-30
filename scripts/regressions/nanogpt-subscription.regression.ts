// A plan's counters reach the browser and its billing identifiers do not.
//
// NanoGPT answers /api/v1/subscription/usage with the payment processor, the
// processor's own status strings and the subscription id, all beside the
// counters a cost display actually needs. The parser selects rather than
// forwards, so a field added upstream cannot ride along into a client.
//
// The shape below is what the live endpoint returned on 2026-08-30, with the
// identifiers replaced.

import assert from "node:assert/strict";
import { parseNanoGptSubscription } from "../../packages/server/src/services/llm/nanogpt-subscription.ts";

const live = {
  active: true,
  provider: "stripe",
  providerStatus: "active",
  providerStatusRaw: "active",
  stripeSubscriptionId: "sub_EXAMPLEIDENTIFIER",
  cancellationReason: null,
  canceledAt: null,
  endedAt: null,
  cancelAt: null,
  cancelAtPeriodEnd: false,
  limits: { weeklyInputTokens: 60000000, dailyInputTokens: null, dailyImages: 100 },
  allowOverage: false,
  period: { currentPeriodEnd: "2026-09-22T04:23:32.000Z" },
  dailyImages: { used: 0, remaining: 100, percentUsed: 0, resetAt: 1788134400000 },
  dailyInputTokens: null,
  weeklyInputTokens: { used: 4945, remaining: 59995055, percentUsed: 8.241666666666667e-5, resetAt: 1788134400000 },
  state: "active",
  graceUntil: null,
  routing: {
    scope: "text",
    recommendedMode: "subscription",
    reason: "included_quota_available",
    billingMode: "both",
    subscriptionRequestsPermitted: true,
    subscriptionQuotaAvailable: true,
    paidSpendPolicyAllowsBalance: true,
    paidOverageEnabled: false,
  },
};

// ── Nothing that identifies the plan survives ──
{
  const parsed = parseNanoGptSubscription(live);
  const serialized = JSON.stringify(parsed);
  for (const secret of ["sub_EXAMPLEIDENTIFIER", "stripe", "providerStatusRaw"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not reach a client`);
  }
  assert.deepEqual(
    Object.keys(parsed ?? {}).sort(),
    ["active", "allowOverage", "dailyImages", "periodEnd", "recommendedMode", "weeklyInputTokens"].sort(),
    "the parser selects its fields, so an upstream addition cannot ride along",
  );
}

// ── The counters a cost display needs do survive ──
{
  const parsed = parseNanoGptSubscription(live);
  assert.equal(parsed?.active, true, "an active plan reads as active");
  assert.equal(parsed?.allowOverage, false, "overage off means the request after the quota is refused, not billed");
  assert.equal(parsed?.recommendedMode, "subscription", "the provider says which purse the next request draws on");
  assert.equal(parsed?.periodEnd, "2026-09-22T04:23:32.000Z", "the period end is carried for the reset copy");
  assert.equal(parsed?.weeklyInputTokens?.used, 4945, "used tokens survive");
  assert.equal(parsed?.weeklyInputTokens?.remaining, 59995055, "so does the remainder, which is the useful half");
  assert.equal(parsed?.weeklyInputTokens?.resetAt, 1788134400000, "and when it rolls over");
  assert.equal(parsed?.dailyImages?.remaining, 100, "image allowances are metered separately");
  assert.equal("dailyInputTokens" in (parsed ?? {}), false, "an allowance the plan does not meter is left off");
}

// ── An unauthenticated or absent plan reads as inactive, not as an error ──
{
  const anonymous = parseNanoGptSubscription({
    active: false,
    limits: { weeklyInputTokens: 60000000, dailyInputTokens: null, dailyImages: null },
    period: { currentPeriodEnd: null },
    dailyImages: null,
    dailyInputTokens: null,
    weeklyInputTokens: null,
    unauthenticated: true,
  });
  assert.equal(anonymous?.active, false, "no plan is a state, not a failure");
  assert.equal(anonymous?.weeklyInputTokens, undefined, "a limit with no counters is not an allowance");
  assert.equal(anonymous?.periodEnd, null, "an absent period end stays null");
}

// ── Malformed counters are dropped rather than rendered ──
{
  const partial = parseNanoGptSubscription({
    active: true,
    weeklyInputTokens: { used: 10, percentUsed: 1 },
    dailyImages: { used: 1, remaining: 9 },
  });
  assert.equal(partial?.weeklyInputTokens, undefined, "a counter with no remainder cannot say how much is left");
  assert.equal(partial?.dailyImages?.percentUsed, 0, "an absent percentage reads as none used, not as NaN");
  assert.equal(partial?.dailyImages?.resetAt, null, "an absent reset stays null rather than becoming a date");
  // An omitted flag is not a plan. Reading absence as active would hide every
  // price from an account that has no subscription at all.
  const silent = parseNanoGptSubscription({ weeklyInputTokens: { used: 1, remaining: 2 } });
  assert.equal(silent?.active, false, "a payload that never says it is active is not active");
  assert.equal(silent?.allowOverage, false, "nor does silence permit overage");

  assert.equal(parseNanoGptSubscription(null), null, "no payload is no subscription");
  assert.equal(parseNanoGptSubscription("active"), null, "a string is not a subscription");
}

console.info("NanoGPT subscription regression passed.");
