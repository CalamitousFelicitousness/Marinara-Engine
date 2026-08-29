// Turns a submitted audio job into the audio it produces.
//
// Some backends answer a generation request with a run id rather than bytes.
// NanoGPT does it per model, not per backend: a speech model on
// /v1/audio/speech streams audio back, a music or sound-effect model on the
// same endpoint answers 202 with a run id, then the audio arrives from a
// storage host after polling a separate status endpoint that authenticates
// differently. See TTSJobResolution in tts-types.ts.
//
// The caller keeps its single outbound helper, deadline and abort chain, and
// passes them in as `send`. That is also what lets the loop be asserted without
// a live server.

import { logger } from "../../lib/logger.js";
import type { TTSJobResolution, TTSProviderRequest } from "./tts-types.js";

/** How a caller performs one outbound request. Supplied so this module does no I/O. */
export type TTSJobSend = (request: TTSProviderRequest, method: "GET" | "POST") => Promise<Response>;

export class TTSJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TTSJobError";
  }
}

/**
 * A JSON content type is what separates a job from inline audio, so the
 * submission body is never consumed to find out. Reading it would leave the
 * audio path holding a used stream.
 */
export function isJobResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TTSJobError(`${label} answered with a body that is not JSON`);
  }
}

/**
 * Polls `submitted` to completion and returns the response carrying the audio.
 *
 * `deadline` bounds the whole loop rather than each request, because a queued
 * job spends most of its life waiting rather than transferring.
 */
export async function resolveTTSJobAudio(
  submitted: Response,
  job: TTSJobResolution,
  send: TTSJobSend,
  options: { signal: AbortSignal; label: string; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<Response> {
  const sleep = options.sleep ?? defaultSleep;
  const jobId = job.readJobId(parseJson(await submitted.text(), options.label));
  if (jobId === null) {
    throw new TTSJobError(`${options.label} answered with JSON that names no job`);
  }
  logger.debug("Waiting on the %s job %s", options.label, jobId);

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal.aborted) throw new TTSJobError(`${options.label} job ${jobId} ran out of time`);
    const polled = await send(job.pollRequest(jobId), "GET");
    if (!polled.ok) {
      throw new TTSJobError(`${options.label} job ${jobId} status check returned ${polled.status}`);
    }
    const payload = parseJson(await polled.text(), `${options.label} status`);

    const failure = job.readFailure(payload);
    if (failure) throw new TTSJobError(failure);

    const audioUrl = job.readAudioUrl(payload);
    if (audioUrl) {
      logger.debug("The %s job %s finished after %d polls", options.label, jobId, attempt + 1);
      return send(job.audioRequest(audioUrl), "GET");
    }

    await sleep(job.pollIntervalMs, options.signal);
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TTSJobError("Cancelled while waiting for an audio job"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
