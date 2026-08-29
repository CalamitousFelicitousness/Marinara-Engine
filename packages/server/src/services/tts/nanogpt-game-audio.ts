// Sound-effect and music generation on NanoGPT.
//
// Verified against the live API on 2026-08-29, because the docs are incomplete
// here and wrong in one place:
//
//   POST /api/v1/audio/speech   Bearer      -> 202 {status, runId, cost}
//   GET  /api/tts/status        x-api-key   -> {status, audioUrl}
//   GET  audioUrl                           -> audio bytes
//
// Three things the shapes actually differ on, all load-bearing below:
//   - run ids are a UUID for one model and 32 bare hex for another, so the
//     format is never validated;
//   - the audio host varies per run (am.runware.ai, a CloudFront domain), so it
//     is never pinned;
//   - a status body may carry audioUrls[] beside audioUrl.
//
// Unlike ElevenLabs there is no single music endpoint: the lane is chosen by
// model id, and a sound effect is a model rather than a route. Model ids are
// vendor data that changes without us, so the connection supplies one through
// its per-purpose parameters rather than this file listing any.

import { audioParametersFor, type GameAudioPurpose, type TTSConfig } from "@marinara-engine/shared";
import { applyAudioParameters } from "./audio-parameter-merge.js";
import { configuredBaseUrl, nanoGptApiRoot, nanoGptV1BaseUrl } from "./tts-endpoints.js";
import { TTSConfigurationError, type TTSJobResolution, type TTSProviderRequest } from "./tts-types.js";

/** Seconds a context track runs when the scene names no length of its own. */
export const NANOGPT_CONTEXT_MUSIC_DURATION_S = 120;

/** Gap between status polls. A queued job spends most of its life waiting. */
export const NANOGPT_JOB_POLL_INTERVAL_MS = 2_000;

export interface NanoGptGameAudioInput {
  kind: GameAudioPurpose;
  /** Already normalized by the caller. Never replaceable by a parameter. */
  prompt: string;
  /** Music only. Present for a context track, which owns its own length. */
  lengthMs?: number;
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The model is the whole lane selection, so an unset one is a configuration
 * error rather than a guess. Picking a default here would name a vendor model id
 * that can be retired without us, and would silently bill the wrong engine.
 */
function resolveGameAudioModel(cfg: TTSConfig, kind: GameAudioPurpose): string {
  const configured = audioParametersFor(cfg, kind).model;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  throw new TTSConfigurationError(
    `This NanoGPT connection has no ${kind === "music" ? "music" : "sound effect"} model set`,
    `Add a "model" parameter for that purpose, for example ACE-Step-v1.5-Base for music or mirelo-ai/sfx1.6/text-to-audio for sound effects. GET /api/v1/audio-models lists what the key can reach.`,
  );
}

export function nanoGptJobResolution(cfg: TTSConfig, model: string): TTSJobResolution {
  const root = nanoGptApiRoot(configuredBaseUrl(cfg));
  return {
    // A submission that already carried audio never reaches here, so a body
    // without a run id means the backend answered something unexpected.
    readJobId: (payload) => readString(payload, "runId"),
    pollRequest: (jobId) => ({
      url: `${root}/tts/status?runId=${encodeURIComponent(jobId)}&model=${encodeURIComponent(model)}`,
      // The status endpoint authenticates differently from the submission.
      headers: { "x-api-key": cfg.apiKey },
      body: "",
      decodeCompressedResponse: false,
    }),
    readAudioUrl: (payload) => {
      const single = readString(payload, "audioUrl");
      if (single) return single;
      if (typeof payload === "object" && payload !== null) {
        const many = (payload as Record<string, unknown>).audioUrls;
        if (Array.isArray(many) && typeof many[0] === "string" && many[0].trim()) return many[0];
      }
      return null;
    },
    readFailure: (payload) => {
      const status = readString(payload, "status");
      if (status && /^(failed|error|cancell?ed)$/iu.test(status)) {
        return readString(payload, "error") ?? readString(payload, "message") ?? `NanoGPT reported the job ${status}`;
      }
      return readString(payload, "error");
    },
    audioRequest: (url) => ({ url, headers: {}, body: "", decodeCompressedResponse: false }),
    pollIntervalMs: NANOGPT_JOB_POLL_INTERVAL_MS,
  };
}

/**
 * The sound-effect or music request for a game asset, with this connection's
 * parameters for that lane merged in.
 *
 * `duration` is seconds here where ElevenLabs counts milliseconds, and the
 * backend clamps it to the model's own range rather than refusing: asking for
 * 99999 returned exactly 300.000s on ACE-Step. A connection that pins duration
 * overrides the scene, and is warned about, like every computed value.
 */
export function buildNanoGptGameAudioRequest(cfg: TTSConfig, input: NanoGptGameAudioInput): TTSProviderRequest {
  const model = resolveGameAudioModel(cfg, input.kind);
  const body: Record<string, unknown> = {
    model,
    input: input.prompt,
    ...(input.kind === "music"
      ? { duration: Math.max(1, Math.round((input.lengthMs ?? NANOGPT_CONTEXT_MUSIC_DURATION_S * 1000) / 1000)) }
      : {}),
  };

  return {
    url: `${nanoGptV1BaseUrl(configuredBaseUrl(cfg))}/audio/speech`,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      applyAudioParameters(body, audioParametersFor(cfg, input.kind), {
        // The prompt is the one thing a parameter may not replace. `model` is
        // read from this same bag above, so it merges back identical, which
        // applyAudioParameters treats as no override at all.
        protectedKey: "input",
        label: input.kind === "music" ? "game music" : "game sound effect",
      }),
    ),
    decodeCompressedResponse: false,
    job: nanoGptJobResolution(cfg, model),
  };
}
