// ──────────────────────────────────────────────
// TTS Provider Types
// ──────────────────────────────────────────────

/** Everything that varies per spoken line. Provider settings come from the config. */
export interface TTSSpeechInput {
  text: string;
  /** Already resolved against the request override and the configured default. */
  voice: string;
  speaker?: string;
  tone?: string;
}

/**
 * A ready-to-send provider request. Speech providers and the game-audio builder
 * produce this and nothing else, so the outbound call happens in exactly one
 * place and the deadline, the abort chain, the URL policy, and the size cap
 * cannot drift apart per backend. Being pure also means request shapes can be
 * asserted without a live server, and shown to the user before one is made.
 */
export interface TTSProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string | FormData;
  /** ElevenLabs answers gzipped, and undici will not unwrap it for us. */
  decodeCompressedResponse: boolean;
  /**
   * Present when this submission may answer with a job instead of audio. Whether
   * it does is a property of the model, not the backend: NanoGPT returns bytes
   * inline for a speech model and 202 with a run id for a music model, on the
   * same endpoint. So the job is detected from the response and never declared
   * in config.
   */
  job?: TTSJobResolution;
}

/**
 * How to turn a submitted job into audio. Pure, like the request it rides on:
 * every method reads a parsed body or builds another request, and the caller
 * owns all three outbound calls, the deadline and the abort chain.
 */
export interface TTSJobResolution {
  /** Run id from the submit body, or null when the body was already audio. */
  readJobId(payload: unknown): string | null;
  /** Status poll for a run id. May carry different auth than the submission. */
  pollRequest(jobId: string): TTSProviderRequest;
  /** Finished audio URL, or null while the job is still pending. */
  readAudioUrl(payload: unknown): string | null;
  /** Reason the job failed, or null when it has not failed. */
  readFailure(payload: unknown): string | null;
  /** Download of the finished audio. The host is the provider's storage CDN and
   *  varies per run, so it is never pinned. */
  audioRequest(url: string): TTSProviderRequest;
  /** Gap between polls. The whole loop still runs inside the caller's deadline. */
  pollIntervalMs: number;
}

/** Saved settings that cannot produce speech. Surfaces as a 4xx, not a gateway error. */
export class TTSConfigurationError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "TTSConfigurationError";
    this.detail = detail;
  }
}
