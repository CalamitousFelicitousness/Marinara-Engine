// ──────────────────────────────────────────────
// TTS Service — Server-proxied audio playback
// ──────────────────────────────────────────────
import { TTS_DIALOGUE_PAUSE_MAX_SECONDS } from "@marinara-engine/shared";
import { api } from "./api-client";
import { getOrCreateCachedTTSAudioBlob } from "./tts-audio-cache";
import {
  PASSTHROUGH_TTS_SYNTHESIS_POLICY,
  runWithTTSSynthesisPolicy,
  TTSSynthesisError,
  ttsFailureKindFromResponse,
  type TTSSynthesisPolicy,
} from "./tts-synthesis-policy";

export type TTSState = "idle" | "loading" | "playing" | "paused" | "error";

/**
 * How far through a spoken message the engine is. A message is many chunks, and
 * on a slow engine the wait between pressing speak and hearing anything is the
 * whole synthesis, so this covers generation as well as playback. Which of the
 * two is happening is already carried by TTSState.
 */
export interface TTSProgress {
  /** 1-based position of the chunk being generated or played. */
  index: number;
  total: number;
}

type StateListener = (state: TTSState, activeId: string | null, progress: TTSProgress | null) => void;

export interface TTSSpeakOptions {
  speaker?: string;
  tone?: string;
  voice?: string;
  /** Explicit audio connection to synthesize with. Empty string forces the legacy TTS settings blob. */
  audioConnectionId?: string;
  signal?: AbortSignal;
  throwOnError?: boolean;
  cacheKey?: string;
  cacheAliases?: string[];
  abortCacheGenerationOnAbort?: boolean;
  volume?: number;
  muted?: boolean;
  /** Absent means no client-side timeout and no retries, the behaviour before tuning existed. */
  policy?: TTSSynthesisPolicy;
}

export interface TTSSpeakRequest {
  text: string;
  speaker?: string;
  tone?: string;
  voice?: string;
  pauseAfterMs?: number;
  cacheKey?: string;
  cacheAliases?: string[];
  activeId?: string | null;
}

export interface TTSSpeakSequenceOptions extends Pick<
  TTSSpeakOptions,
  "signal" | "throwOnError" | "volume" | "muted" | "policy" | "audioConnectionId"
> {
  progressive?: boolean;
  /** Requests kept in flight ahead of playback in progressive mode. 1 is serial. */
  concurrency?: number;
  onChunkStart?: (request: TTSSpeakRequest, index: number) => void;
  onChunkEnd?: (request: TTSSpeakRequest, index: number) => void;
}

function clampPlaybackVolume(volume: number | undefined): number {
  if (typeof volume !== "number" || !Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

function waitForBlobWithAbort(promise: Promise<Blob>, signal?: AbortSignal): Promise<Blob> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("TTS request aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("TTS request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (blob) => {
        signal.removeEventListener("abort", onAbort);
        resolve(blob);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function playbackAbortError(): DOMException {
  return new DOMException("TTS playback aborted", "AbortError");
}

export function normalizeTTSPlaybackDelayMs(delayMs: number | undefined): number {
  const maximumDelayMs = TTS_DIALOGUE_PAUSE_MAX_SECONDS * 1000;
  return typeof delayMs === "number" && Number.isFinite(delayMs) ? Math.max(0, Math.min(maximumDelayMs, delayMs)) : 0;
}

function waitForPlaybackDelay(delayMs: number | undefined, signal: AbortSignal): Promise<void> {
  const ms = normalizeTTSPlaybackDelayMs(delayMs);

  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(playbackAbortError());

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(playbackAbortError());
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldWaitForPlaybackReturn(error: unknown): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "NotAllowedError";
}

function waitForPlaybackReturn(signal?: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") return Promise.resolve();
  if (document.visibilityState === "visible" && document.hasFocus()) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(playbackAbortError());

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onReturn = () => {
      if (document.visibilityState === "visible") finish();
    };
    const onAbort = () => {
      cleanup();
      reject(playbackAbortError());
    };

    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function playWhenAvailable(audio: HTMLAudioElement, signal?: AbortSignal): Promise<void> {
  let waitBeforeRetry = typeof document !== "undefined" && document.visibilityState === "hidden";

  while (true) {
    if (signal?.aborted) throw playbackAbortError();
    if (waitBeforeRetry) {
      await waitForPlaybackReturn(signal);
      waitBeforeRetry = false;
    }

    try {
      await audio.play();
      return;
    } catch (err) {
      // play() rejects with AbortError when a pause interrupts the start, but
      // the element can still be running. Treating that as a failure would drop
      // it from tracking and leave a clip nothing can stop (#2647).
      if (!audio.paused && !audio.ended) return;
      if (!shouldWaitForPlaybackReturn(err)) throw err;
      waitBeforeRetry = true;
    }
  }
}

class TTSService {
  private audio: HTMLAudioElement | null = null;
  /**
   * Every element handed to play(), not just the current one. Interleaved
   * playback attempts can orphan an earlier element off the single ref, after
   * which nothing can pause it and clips overlap (#2647).
   */
  private activeAudios = new Set<HTMLAudioElement>();
  /** Consecutive failed sequences, so a dead engine stops being retried forever. */
  private consecutiveFailures = 0;
  private currentObjectUrl: string | null = null;
  private abortController: AbortController | null = null;
  private state: TTSState = "idle";
  private lastError: string | null = null;
  private sequence = 0;
  /** ID of the entity (e.g. message id) currently being spoken */
  private activeId: string | null = null;
  private listeners = new Set<StateListener>();
  private progress: TTSProgress | null = null;
  private livePlaybackVolume: number | null = null;
  private livePlaybackMuted: boolean | null = null;

  // ── Listeners ─────────────────────────────────

  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState(): TTSState {
    return this.state;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getProgress(): TTSProgress | null {
    return this.progress;
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn(this.state, this.activeId, this.progress));
  }

  private setState(s: TTSState, id: string | null = this.activeId) {
    this.state = s;
    this.activeId = s === "idle" || s === "error" ? null : id;
    // Progress belongs to a live sequence; leaving it set would strand a stale
    // count on a message that has stopped.
    if (this.activeId === null) this.progress = null;
    this.notify();
  }

  /**
   * Unchanged values keep the same object, so a subscriber that stores this in
   * React state does not re-render on every notify.
   *
   * The sequence check is defensive rather than load-bearing: every path that
   * resumes after an await already returns on its own isCurrentSequence check
   * before reaching here. It is kept so that a future call added after an await
   * cannot silently write a superseded run's count.
   */
  private setProgress(sequence: number, index: number, total: number): void {
    if (!this.isCurrentSequence(sequence)) return;
    if (this.progress?.index === index && this.progress.total === total) return;
    this.progress = { index, total };
    this.notify();
  }

  private isCurrentSequence(sequence: number): boolean {
    return this.sequence === sequence;
  }

  /**
   * Report a failure to the user. Loaded lazily and skipped outside a browser so
   * the regression suite, which drives this engine under Node, stays silent.
   */
  private notifyFailure(error: Error): void {
    if (typeof document === "undefined") return;
    if (error.name === "AbortError") return;
    void import("./tts-error-notice")
      .then(({ notifyTTSFailure }) => notifyTTSFailure(error))
      .catch(() => {
        /* the toast is best-effort; the button state already reports the failure */
      });
  }

  // ── Playback ──────────────────────────────────

  private beginPlaybackOptions(options: Pick<TTSSpeakOptions, "volume" | "muted">): void {
    this.livePlaybackVolume = typeof options.volume === "number" ? clampPlaybackVolume(options.volume) : null;
    this.livePlaybackMuted = typeof options.muted === "boolean" ? options.muted : null;
  }

  private clearPlaybackOptions(): void {
    this.livePlaybackVolume = null;
    this.livePlaybackMuted = null;
  }

  private applyPlaybackOptions(audio: HTMLAudioElement, options: Pick<TTSSpeakOptions, "volume" | "muted">): void {
    const volume = this.livePlaybackVolume ?? clampPlaybackVolume(options.volume);
    audio.volume = volume;
    audio.muted = (this.livePlaybackMuted ?? options.muted) === true || volume <= 0;
  }

  setCurrentPlaybackVolume(volume: number, muted = false): void {
    this.livePlaybackVolume = clampPlaybackVolume(volume);
    this.livePlaybackMuted = muted;
    if (!this.audio) return;
    this.applyPlaybackOptions(this.audio, { volume, muted });
  }

  async generateAudio(text: string, options: TTSSpeakOptions = {}): Promise<Blob> {
    const body = JSON.stringify({
      text,
      ...(options.speaker ? { speaker: options.speaker } : {}),
      ...(options.tone ? { tone: options.tone } : {}),
      ...(options.voice ? { voice: options.voice } : {}),
      // "" is meaningful (legacy-blob sentinel), so gate on undefined.
      ...(options.audioConnectionId !== undefined ? { audioConnectionId: options.audioConnectionId } : {}),
    });

    return runWithTTSSynthesisPolicy(
      async (signal) => {
        // api.raw rather than a bare fetch: it carries the CSRF header, the
        // admin secret, and the no-store policy every other request gets.
        const res = await api.raw("/tts/speak", { method: "POST", body, signal });
        if (!res.ok) throw await this.synthesisError(res);
        return res.blob();
      },
      options.policy ?? PASSTHROUGH_TTS_SYNTHESIS_POLICY,
      options.signal,
    );
  }

  /** Reads the server's machine-readable code so the UI need not match prose. */
  private async synthesisError(res: Response): Promise<TTSSynthesisError> {
    const raw = await res.text().catch(() => "");
    let code: unknown;
    let retryAfterMs: number | undefined;
    let message = `TTS request failed (${res.status})`;
    if (raw.trim()) {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        code = data.code;
        // The provider's own pause, forwarded by the route. Waiting this long
        // beats any curve the client could invent.
        if (typeof data.retryAfterMs === "number" && Number.isFinite(data.retryAfterMs)) {
          retryAfterMs = data.retryAfterMs;
        }
        const error = typeof data.error === "string" ? data.error : "";
        const detail = typeof data.detail === "string" ? data.detail : "";
        const reported = typeof data.message === "string" ? data.message : "";
        message = [error || reported || message, detail].filter(Boolean).join(": ");
      } catch {
        message = `${message}: ${raw.slice(0, 500)}`;
      }
    }
    return new TTSSynthesisError(message, ttsFailureKindFromResponse(code), res.status, retryAfterMs);
  }

  /**
   * Synthesize one clip without touching playback state.
   *
   * Callers that keep their own cache (the game surfaces bound object URLs in
   * their own maps) pass no cacheKey, which skips the shared IndexedDB store
   * rather than storing every line twice.
   */
  synthesize(text: string, options: TTSSpeakOptions = {}): Promise<Blob> {
    return this.getAudioBlob(text, options);
  }

  /** Consecutive failed sequences. Autoplay stops trying once an engine is clearly down. */
  getConsecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  resetFailureCount(): void {
    this.consecutiveFailures = 0;
  }

  private async getAudioBlob(text: string, options: TTSSpeakOptions = {}): Promise<Blob> {
    if (!options.cacheKey) return this.generateAudio(text, options);
    const sharedPromise = getOrCreateCachedTTSAudioBlob(
      options.cacheKey,
      () =>
        this.generateAudio(text, {
          ...options,
          signal: options.abortCacheGenerationOnAbort ? options.signal : undefined,
        }),
      options.cacheAliases,
    );
    return waitForBlobWithAbort(sharedPromise, options.signal);
  }

  /** Speak the given text. `id` is an optional caller-supplied key (e.g. message id) so callers can track which item is active. */
  async speak(text: string, id?: string, options: TTSSpeakOptions = {}): Promise<void> {
    this.stop();
    this.beginPlaybackOptions(options);
    const sequence = ++this.sequence;
    this.lastError = null;

    this.setState("loading", id ?? null);
    this.setProgress(sequence, 1, 1);
    const abortController = new AbortController();
    this.abortController = abortController;

    let blob: Blob;
    try {
      blob = await this.getAudioBlob(text, { ...options, signal: abortController.signal });
    } catch (err) {
      if (!this.isCurrentSequence(sequence)) return;
      if (err instanceof Error && err.name === "AbortError") {
        this.setState("idle");
        return;
      }
      const error = err instanceof Error ? err : new Error("TTS request failed");
      this.lastError = error.message;
      this.setState("error");
      if (options.throwOnError) throw error;
      return;
    }

    if (!this.isCurrentSequence(sequence)) return;

    const objectUrl = URL.createObjectURL(blob);
    if (!this.isCurrentSequence(sequence)) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    this.currentObjectUrl = objectUrl;

    const audio = new Audio(objectUrl);
    this.applyPlaybackOptions(audio, options);
    this.audio = audio;
    this.activeAudios.add(audio);

    audio.onended = () => {
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.cleanup();
      this.setState("idle");
    };
    audio.onerror = () => {
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.cleanup();
      this.setState("error");
    };

    try {
      await playWhenAvailable(audio, abortController.signal);
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      this.consecutiveFailures = 0;
      this.setState("playing", id ?? null);
    } catch (err) {
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.cleanup();
      const error = err instanceof Error ? err : new Error("Browser blocked audio playback");
      this.lastError = error.message;
      this.setState("error");
      if (options.throwOnError) throw error;
    }
  }

  /**
   * Generate every request first, then play the resulting clips in order.
   * This keeps multi-speaker dialogue from starting until the whole spoken queue is ready.
   */
  async speakSequence(requests: TTSSpeakRequest[], id?: string, options: TTSSpeakSequenceOptions = {}): Promise<void> {
    const playableRequests = requests.filter((request) => request.text.trim().length > 0);
    if (playableRequests.length === 0) return;

    this.stop();
    this.beginPlaybackOptions(options);
    const sequence = ++this.sequence;
    this.lastError = null;

    this.setState("loading", id ?? null);
    const abortController = new AbortController();
    this.abortController = abortController;

    const abortFromCaller = () => abortController.abort();
    const detachAbortSignal = () => options.signal?.removeEventListener("abort", abortFromCaller);
    if (options.signal?.aborted) {
      abortController.abort();
    } else {
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    type ChunkResult =
      | { ok: true; blob: Blob; request: TTSSpeakRequest; index: number }
      | { ok: false; error: Error; request: TTSSpeakRequest; index: number };
    const toError = (err: unknown, fallback: string) => (err instanceof Error ? err : new Error(fallback));
    const isAbortError = (error: Error) => error.name === "AbortError";
    const fetchChunk = async (request: TTSSpeakRequest, index: number): Promise<ChunkResult> => {
      try {
        const blob = await this.getAudioBlob(request.text, {
          speaker: request.speaker,
          tone: request.tone,
          voice: request.voice,
          audioConnectionId: options.audioConnectionId,
          policy: options.policy,
          signal: abortController.signal,
          cacheKey: request.cacheKey,
          cacheAliases: request.cacheAliases,
          abortCacheGenerationOnAbort: true,
        });
        return { ok: true, blob, request, index };
      } catch (err) {
        return { ok: false, error: toError(err, "TTS request failed"), request, index };
      }
    };

    const playBlob = async (blob: Blob, request: TTSSpeakRequest, index: number): Promise<void> => {
      if (!this.isCurrentSequence(sequence)) return;
      this.cleanup();

      const objectUrl = URL.createObjectURL(blob);
      if (!this.isCurrentSequence(sequence)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.currentObjectUrl = objectUrl;

      const audio = new Audio(objectUrl);
      this.applyPlaybackOptions(audio, options);
      this.audio = audio;
      this.activeAudios.add(audio);
      const runChunkStart = () => {
        try {
          options.onChunkStart?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk start callback failed:", err);
        }
      };
      const runChunkEnd = () => {
        try {
          options.onChunkEnd?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk end callback failed:", err);
        }
      };

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          abortController.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          try {
            audio.pause();
          } catch {
            /* ignore interrupted playback cleanup */
          }
          finish(resolve);
        };
        const fail = (error: Error) => {
          if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
          finish(() => {
            this.cleanup();
            this.lastError = error.message;
            this.setState("error");
            reject(error);
          });
        };

        abortController.signal.addEventListener("abort", onAbort, { once: true });
        audio.onended = () => {
          if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
          finish(() => {
            try {
              runChunkEnd();
            } finally {
              this.cleanup();
              resolve();
            }
          });
        };
        audio.onerror = () => {
          try {
            runChunkEnd();
          } finally {
            fail(new Error("Audio playback failed"));
          }
        };

        void playWhenAvailable(audio, abortController.signal)
          .then(() => {
            if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
            this.consecutiveFailures = 0;
            runChunkStart();
            this.setState("playing", request.activeId ?? id ?? null);
          })
          .catch((err) => fail(toError(err, "Browser blocked audio playback")));
      });
    };

    const handleFetchFailure = (error: Error) => {
      this.lastError = error.message;
      this.consecutiveFailures += 1;
      console.warn("[TTS] Audio chunk generation failed; stopping the sequence:", error);
      this.setState("error");
      this.notifyFailure(error);
    };

    try {
      if (options.progressive) {
        const lookahead = Math.max(1, Math.trunc(options.concurrency ?? 1));
        const inFlight = new Map<number, Promise<ChunkResult>>();
        const arrived = new Set<number>();
        // fetchChunk resolves rather than rejects, so queued-but-unread entries
        // can never surface as unhandled rejections when the sequence ends early.
        const topUp = (fromIndex: number) => {
          for (let i = fromIndex; i < playableRequests.length && inFlight.size < lookahead; i += 1) {
            if (inFlight.has(i)) continue;
            const index = i;
            inFlight.set(
              index,
              fetchChunk(playableRequests[index]!, index).then((result) => {
                arrived.add(index);
                return result;
              }),
            );
          }
        };
        topUp(0);

        for (let index = 0; index < playableRequests.length; index += 1) {
          this.setProgress(sequence, index + 1, playableRequests.length);
          const result = await inFlight.get(index)!;
          inFlight.delete(index);
          arrived.delete(index);
          if (!this.isCurrentSequence(sequence)) return;

          if (!result.ok) {
            if (isAbortError(result.error)) {
              detachAbortSignal();
              if (this.abortController === abortController) {
                this.abortController = null;
              }
              this.setState("idle");
              return;
            }
            detachAbortSignal();
            if (this.abortController === abortController) {
              this.abortController = null;
            }
            handleFetchFailure(result.error);
            if (options.throwOnError) throw result.error;
            return;
          }

          topUp(index + 1);

          try {
            await playBlob(result.blob, result.request, result.index);
            await waitForPlaybackDelay(result.request.pauseAfterMs, abortController.signal);
            // Announce loading only while the next clip is still coming.
            // Flipping unconditionally flashed a spinner between chunks the
            // lookahead had already fetched.
            const waitingOnNext = inFlight.has(index + 1) && !arrived.has(index + 1);
            if (waitingOnNext && this.isCurrentSequence(sequence)) {
              this.setState("loading", id ?? null);
            }
          } catch (err) {
            detachAbortSignal();
            if (this.abortController === abortController) {
              this.abortController = null;
            }
            if (err instanceof Error && err.name === "AbortError") {
              this.setState("idle");
              return;
            }
            if (options.throwOnError) throw err;
            return;
          }
        }

        detachAbortSignal();
        if (!this.isCurrentSequence(sequence)) return;
        if (this.abortController === abortController) {
          this.abortController = null;
        }
        this.setState("idle");
        return;
      }

      const playableChunks: Array<Extract<ChunkResult, { ok: true }>> = [];
      for (let index = 0; index < playableRequests.length; index += 1) {
        this.setProgress(sequence, index + 1, playableRequests.length);
        const result = await fetchChunk(playableRequests[index]!, index);
        if (!this.isCurrentSequence(sequence)) return;
        if (!result.ok) {
          detachAbortSignal();
          if (this.abortController === abortController) {
            this.abortController = null;
          }
          if (isAbortError(result.error)) {
            this.setState("idle");
            return;
          }
          handleFetchFailure(result.error);
          if (options.throwOnError) throw result.error;
          return;
        }
        playableChunks.push(result);
      }

      for (const chunk of playableChunks) {
        this.setProgress(sequence, chunk.index + 1, playableRequests.length);
        try {
          await playBlob(chunk.blob, chunk.request, chunk.index);
          await waitForPlaybackDelay(chunk.request.pauseAfterMs, abortController.signal);
        } catch (err) {
          detachAbortSignal();
          if (this.abortController === abortController) {
            this.abortController = null;
          }
          if (err instanceof Error && err.name === "AbortError") {
            this.setState("idle");
            return;
          }
          if (options.throwOnError) throw err;
          return;
        }
        if (!this.isCurrentSequence(sequence)) return;
      }
      detachAbortSignal();
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.setState("idle");
    } finally {
      detachAbortSignal();
    }
  }

  /** Stop any in-progress fetch or playback. */
  stop(): void {
    this.sequence += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.clearPlaybackOptions();

    for (const audio of this.activeAudios) {
      try {
        audio.pause();
      } catch {
        /* an element mid-start can throw; it is being discarded anyway */
      }
      audio.onended = null;
      audio.onerror = null;
    }
    this.activeAudios.clear();
    this.audio = null;

    this.cleanup();
    this.lastError = null;
    this.setState("idle");
  }

  /** Pause the current generated audio without clearing it. */
  pause(): void {
    if (this.state !== "playing" || !this.audio) return;
    this.audio.pause();
    this.setState("paused");
  }

  /** Resume paused generated audio. */
  resume(): void {
    if (this.state !== "paused" || !this.audio) return;
    const audio = this.audio;
    void playWhenAvailable(audio, this.abortController?.signal)
      .then(() => {
        if (this.audio !== audio) return;
        this.setState("playing");
      })
      .catch((err) => {
        if (this.audio !== audio) return;
        this.cleanup();
        const error = err instanceof Error ? err : new Error("Browser blocked audio playback");
        this.lastError = error.message;
        this.setState("error");
      });
  }

  /** Restart the current generated audio from the beginning. */
  restart(): void {
    if (!this.audio || (this.state !== "playing" && this.state !== "paused")) return;
    const audio = this.audio;
    audio.currentTime = 0;
    void playWhenAvailable(audio, this.abortController?.signal)
      .then(() => {
        if (this.audio !== audio) return;
        this.setState("playing");
      })
      .catch((err) => {
        if (this.audio !== audio) return;
        this.cleanup();
        const error = err instanceof Error ? err : new Error("Browser blocked audio playback");
        this.lastError = error.message;
        this.setState("error");
      });
  }

  private cleanup(): void {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
  }
}

export const ttsService = new TTSService();
