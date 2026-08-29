// ──────────────────────────────────────────────
// TTS Rate Limit Detection
// ──────────────────────────────────────────────
// Reading a provider's "slow down" answer off a response.
//
// /speak and /game-audio used to flatten every non-ok status to 502, which threw
// away both the fact that it was a rate limit and the Retry-After the provider
// sent. The client then retried on its own fixed backoff, which is the wrong
// wait by construction. Now the routes answer 429 with the delay, and the client
// honours it.
//
// Statuses match isRateLimitError on the LLM side so both paths agree on what
// counts: 429 and 529 always, and 503 only when it carries Retry-After, since a
// bare 503 is more likely a real outage than throttling.

import { parseRetryAfterMs } from "../llm/base-provider.js";

export interface TTSRateLimit {
  /** Absent when the provider sent no Retry-After, or an unparseable one. */
  retryAfterMs?: number;
}

export function readTTSRateLimit(response: Response): TTSRateLimit | null {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const limited =
    response.status === 429 || response.status === 529 || (response.status === 503 && retryAfterMs !== undefined);
  if (!limited) return null;
  return retryAfterMs === undefined ? {} : { retryAfterMs };
}

/** A provider asked for a pause. Carries the delay so the caller need not guess. */
export class TTSRateLimitError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "TTSRateLimitError";
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
