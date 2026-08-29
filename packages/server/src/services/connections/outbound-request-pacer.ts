// ──────────────────────────────────────────────
// Outbound Request Pacer
// ──────────────────────────────────────────────
// A connection's maxRequestsPerMinute is a property of the service behind it,
// so the cap has to hold across every caller of that connection rather than per
// feature. This keeps the pacing cursor, connection-scoped, and hands back the
// delay a caller must await before its outbound request.
//
// Two callers: the LLM RateLimitAwareProvider decorator, and the TTS routes. A
// connection is a language provider or an audio one, never both, so one cursor
// map serves both without either spending the other's budget.
//
// The synchronous-undefined return is load-bearing, not a micro-optimisation:
// an unthrottled caller must be able to proceed in the SAME microtask, because
// the LLM decorator's inner admission slot is acquired synchronously and an
// awaited already-resolved value would yield a tick and briefly open the
// concurrency gate.

import { getConnectionRateLimit } from "../llm/connection-rate-limit-registry.js";

/** Earliest wall-clock time the next request on a connection may start. */
const nextAllowedAt = new Map<string, number>();

export interface ReserveOutboundSlotOptions {
  signal?: AbortSignal;
  /** Called only when a wait is actually required, with its length. */
  onWait?: (delayMs: number) => void;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Reserve this request's slot on a connection. Returns the delay to await when
 * the connection is over its cap, or undefined when no wait is needed, which is
 * both the common path and the unthrottled one.
 *
 * Reserving pushes the cursor forward by the minimum interval, so concurrent
 * requests queue fairly rather than all seeing the same free slot.
 */
export function reserveOutboundSlot(
  connectionId: string,
  options: ReserveOutboundSlotOptions = {},
): Promise<void> | undefined {
  const maxRpm = getConnectionRateLimit(connectionId);
  if (!maxRpm || maxRpm <= 0) return undefined;
  const minIntervalMs = Math.ceil(60_000 / maxRpm);
  const now = Date.now();
  const earliest = Math.max(now, nextAllowedAt.get(connectionId) ?? 0);
  const reserved = earliest + minIntervalMs;
  nextAllowedAt.set(connectionId, reserved);
  const waitMs = earliest - now;
  if (waitMs <= 0) return undefined;
  options.onWait?.(waitMs);
  return abortableDelay(waitMs, options.signal).catch((error) => {
    // Aborted mid-wait: hand the reservation back if we are still the tail, so a
    // cancelled request does not inject phantom delay into the ones behind it.
    if (nextAllowedAt.get(connectionId) === reserved) {
      nextAllowedAt.set(connectionId, earliest);
    }
    throw error;
  });
}

export function resetOutboundPacingForTests(): void {
  nextAllowedAt.clear();
}
