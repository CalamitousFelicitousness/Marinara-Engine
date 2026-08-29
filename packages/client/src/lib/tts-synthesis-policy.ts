// ──────────────────────────────────────────────
// TTS Synthesis Policy
// ──────────────────────────────────────────────
// Timeout, retry, and failure classification for one synthesis request.
//
// Kept out of tts-service.ts so it can be exercised without the playback
// singleton, and so the engine's diff against upstream stays small.
//
// The chat path had no retries at all: one transient 502 ended the whole
// sequence. The game path has shipped two attempts with a 350ms linear backoff
// for months, so that curve is reused rather than invented.
//
// Attaches listeners only to the signal it is handed. speakSequence gives it the
// engine-internal signal, never the caller's, because a superseded sequence must
// leave exactly one caller listener behind to detach.

import { TTS_TIMEOUT_MS_DEFAULT } from "@marinara-engine/shared";

/** Why a synthesis request failed, in a form the UI can branch on. */
export type TTSFailureKind = "timeout" | "unreachable" | "provider" | "rate_limited" | "aborted";

export class TTSSynthesisError extends Error {
  readonly kind: TTSFailureKind;
  readonly status?: number;
  /** Rate limits only: the pause the provider asked for, when it named one. */
  readonly retryAfterMs?: number;

  constructor(message: string, kind: TTSFailureKind, status?: number, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    // The engine distinguishes a user stop from a failure by error name, so an
    // aborted synthesis has to keep answering to that check.
    this.name = kind === "aborted" ? "AbortError" : "TTSSynthesisError";
  }
}

export interface TTSSynthesisPolicy {
  /** Client-side backstop. 0 leaves the server's budget as the only limit. */
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export const TTS_RETRY_BASE_DELAY_MS = 350;

/**
 * The server owns the budget and answers a timeout with a reason; the client
 * only needs a backstop for a socket that never answers at all. Waiting the
 * server's budget plus this grace lets the server's answer win the race, so the
 * user sees "the engine timed out" rather than an opaque client-side abort.
 */
export const TTS_CLIENT_TIMEOUT_GRACE_MS = 15_000;

/** No client-side timeout and no retries: the engine's behaviour before this module. */
export const PASSTHROUGH_TTS_SYNTHESIS_POLICY: TTSSynthesisPolicy = {
  requestTimeoutMs: 0,
  maxRetries: 0,
  retryBaseDelayMs: TTS_RETRY_BASE_DELAY_MS,
};

export function resolveTTSSynthesisPolicy(
  config?: { timeoutMs?: number | null; maxRetries?: number | null } | null,
): TTSSynthesisPolicy {
  if (!config) return PASSTHROUGH_TTS_SYNTHESIS_POLICY;
  const configured = Number(config.timeoutMs ?? TTS_TIMEOUT_MS_DEFAULT);
  const retries = Number(config.maxRetries ?? 0);
  return {
    requestTimeoutMs: Number.isFinite(configured) && configured > 0 ? configured + TTS_CLIENT_TIMEOUT_GRACE_MS : 0,
    maxRetries: Number.isFinite(retries) ? Math.max(0, Math.trunc(retries)) : 0,
    retryBaseDelayMs: TTS_RETRY_BASE_DELAY_MS,
  };
}

/**
 * Maps a /speak failure onto a kind, preferring the server's own code over the
 * status, since a timeout and an unreachable host both surface as 502.
 */
export function ttsFailureKindFromResponse(code?: unknown): TTSFailureKind {
  if (code === "timeout" || code === "unreachable" || code === "aborted" || code === "rate_limited") return code;
  return "provider";
}

/**
 * How long to wait before the next attempt. A provider that named a delay knows
 * better than any curve here, so its Retry-After wins; everything else keeps the
 * linear backoff the game path has shipped for months.
 *
 * Capped, because an engine may ask for minutes and a listener waiting on a
 * message is better told it failed than left with silence.
 */
export const TTS_RATE_LIMIT_WAIT_CAP_MS = 30_000;

export function ttsRetryDelayMs(error: unknown, policy: TTSSynthesisPolicy, attemptIndex: number): number {
  if (error instanceof TTSSynthesisError && typeof error.retryAfterMs === "number" && error.retryAfterMs >= 0) {
    return Math.min(error.retryAfterMs, TTS_RATE_LIMIT_WAIT_CAP_MS);
  }
  return policy.retryBaseDelayMs * (attemptIndex + 1);
}

/**
 * Retries transient failures only. A 4xx means the request or the configuration
 * is wrong, and repeating it just multiplies the wait before the user is told.
 */
export function isRetryableTTSFailure(error: unknown): boolean {
  if (error instanceof TTSSynthesisError) {
    if (error.kind === "aborted") return false;
    if (error.kind === "timeout" || error.kind === "unreachable") return true;
    // A rate limit is a 4xx that means "later", not "wrong". It is the one
    // status the rule below must not read as a permanent refusal.
    if (error.kind === "rate_limited") return true;
    return typeof error.status === "number" ? error.status >= 500 : true;
  }
  if (error instanceof Error && error.name === "AbortError") return false;
  // A bare network error (DNS, refused, dropped socket) is worth one more try.
  return true;
}

function abortedError(): TTSSynthesisError {
  return new TTSSynthesisError("TTS request aborted", "aborted");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one attempt under a deadline. Composed by hand rather than with
 * AbortSignal.any, which the Android WebView this app ships in may not have.
 */
function runAttempt<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  // With no deadline, hand the caller's own signal through untouched so no
  // extra listener is attached and abort semantics stay exactly as they were.
  if (!(timeoutMs > 0)) return attempt(signal ?? new AbortController().signal);
  if (signal?.aborted) return Promise.reject(abortedError());

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  };

  return attempt(controller.signal).then(
    (value) => {
      done();
      return value;
    },
    (error: unknown) => {
      done();
      if (timedOut) {
        throw new TTSSynthesisError(`TTS request exceeded ${Math.round(timeoutMs / 1000)}s`, "timeout");
      }
      throw error;
    },
  );
}

export async function runWithTTSSynthesisPolicy<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  policy: TTSSynthesisPolicy,
  signal?: AbortSignal,
): Promise<T> {
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    if (signal?.aborted) throw abortedError();
    try {
      return await runAttempt(attempt, policy.requestTimeoutMs, signal);
    } catch (error) {
      if (attemptIndex >= policy.maxRetries || !isRetryableTTSFailure(error)) throw error;
      await delay(ttsRetryDelayMs(error, policy, attemptIndex), signal);
    }
  }
}
