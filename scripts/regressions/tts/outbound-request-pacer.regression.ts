// A connection's requests-per-minute cap paces every caller of that connection.
//
// The pacer moved out of the LLM RateLimitAwareProvider so the TTS routes could
// use it too. Its behaviour is subtle enough that the move needed a pin of its
// own: the synchronous-undefined return is a concurrency contract, not a
// micro-optimisation, and the abort rollback is the difference between a
// cancelled request costing nothing and it charging its slot to whoever is next.
//
// Real timers, small intervals. 600 requests per minute is 100ms apart, which is
// the top of what the editor accepts and the fastest thing worth measuring.

import assert from "node:assert/strict";
import {
  reserveOutboundSlot,
  resetOutboundPacingForTests,
} from "../../../packages/server/src/services/connections/outbound-request-pacer.ts";
import {
  resetConnectionRateLimitsForTests,
  setConnectionRateLimit,
} from "../../../packages/server/src/services/llm/connection-rate-limit-registry.ts";

const reset = () => {
  resetOutboundPacingForTests();
  resetConnectionRateLimitsForTests();
};

// ── An unthrottled connection never yields ──
// The LLM decorator acquires its inner admission slot synchronously after this
// call. Returning an already-resolved promise instead of undefined would yield a
// tick and briefly open the concurrency gate, which is invisible until two
// requests slip through a limit of one.
{
  reset();
  assert.equal(reserveOutboundSlot("no-cap"), undefined, "a connection with no cap must not wait");

  setConnectionRateLimit("zero", 0);
  assert.equal(reserveOutboundSlot("zero"), undefined, "a zero cap means unlimited, not blocked");

  setConnectionRateLimit("capped", 600);
  assert.equal(reserveOutboundSlot("capped"), undefined, "the first request in a window starts immediately");
}

// ── The second request in a window waits its interval ──
{
  reset();
  setConnectionRateLimit("paced", 600);

  assert.equal(reserveOutboundSlot("paced"), undefined, "the first reserves without waiting");
  const waits: number[] = [];
  const second = reserveOutboundSlot("paced", { onWait: (delayMs) => waits.push(delayMs) });
  assert.ok(second instanceof Promise, "the second request must wait for its slot");
  assert.equal(waits.length, 1, "a caller that waits is told how long");
  assert.ok(waits[0]! > 50 && waits[0]! <= 100, `expected about 100ms, was told ${waits[0]}`);

  const started = Date.now();
  await second;
  assert.ok(Date.now() - started >= 50, "the wait is real, not just reported");

  // Reserving pushes the cursor, so a third queues behind the second rather
  // than racing it for the same slot.
  const third = reserveOutboundSlot("paced");
  assert.ok(third instanceof Promise, "concurrent callers queue rather than sharing one slot");
  await third;
}

// ── An abandoned wait hands its slot back ──
// Without the rollback a cancelled request leaves its reservation on the cursor,
// so the next caller pays for a request that never happened. With a listener who
// navigated away mid-message that is a delay nobody can account for.
{
  reset();
  setConnectionRateLimit("aborting", 300); // 200ms apart

  assert.equal(reserveOutboundSlot("aborting"), undefined, "the first starts immediately");

  const controller = new AbortController();
  const abandoned = reserveOutboundSlot("aborting", { signal: controller.signal });
  assert.ok(abandoned instanceof Promise, "the second waits");
  controller.abort();
  await assert.rejects(abandoned, "an aborted wait rejects rather than proceeding");

  const started = Date.now();
  const next = reserveOutboundSlot("aborting");
  if (next) await next;
  const waited = Date.now() - started;
  assert.ok(waited < 320, `the abandoned slot must be reusable, but the next caller waited ${waited}ms`);
}

// ── Connections are paced independently ──
{
  reset();
  setConnectionRateLimit("first", 600);
  setConnectionRateLimit("second", 600);

  reserveOutboundSlot("first");
  assert.ok(reserveOutboundSlot("first") instanceof Promise, "a second call on the same connection waits");
  assert.equal(reserveOutboundSlot("second"), undefined, "another connection has its own budget");
}

// ── Clearing the cap stops the pacing ──
{
  reset();
  setConnectionRateLimit("temporary", 60);
  reserveOutboundSlot("temporary");
  assert.ok(reserveOutboundSlot("temporary") instanceof Promise, "capped while the cap is set");

  setConnectionRateLimit("temporary", null);
  assert.equal(reserveOutboundSlot("temporary"), undefined, "removing the cap removes the wait");
}

reset();
console.info("Outbound request pacer regression passed.");
