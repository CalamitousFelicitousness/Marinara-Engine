// ──────────────────────────────────────────────
// Audio Parameter Merge
// ──────────────────────────────────────────────
// Folding a connection's stored parameters into a request an engine already
// built. Every outbound audio request passes through here: speech from the five
// providers, sound effects and music from the ElevenLabs game-audio builder.
//
// The app cannot know any backend's schema, so this validates nothing about the
// keys. What it does own is the one thing a stored value must never be allowed
// to do, which is replace the content the caller was asked to synthesize.

import { deepMergeRequestBody, isPlainRecord } from "../../lib/request-body-merge.js";
import { logger } from "../../lib/logger.js";
import type { AudioParameterRecord } from "@marinara-engine/shared";

export interface AudioParameterMergeOptions {
  /**
   * The key holding what the caller asked to be spoken or composed: "input" for
   * OpenAI-compatible speech, "text" for ElevenLabs speech and sound effects,
   * "prompt" for music. A stored parameter may never replace it.
   */
  protectedKey: string;
  /** Names the request in log lines, for example "speech" or "game music". */
  label: string;
}

/**
 * Merges parameters into body and returns body.
 *
 * Mutates its argument, as applyCustomParameters does on the LLM side, so every
 * caller passes a freshly built object literal rather than anything it holds on
 * to.
 *
 * Contract:
 *   - No parameters means body is returned untouched. This is what keeps an
 *     untouched install byte-identical on the wire, and the regression suite
 *     asserts exactly that for all five providers.
 *   - options.protectedKey is never replaced, and an attempt is worth a warning:
 *     a connection that silently stopped speaking the right words would be a
 *     miserable thing to diagnose.
 *   - Everything else may be added or replaced, including a value the caller
 *     computed, such as music_length_ms derived from the scene. Overriding one
 *     is legitimate (the user typed it and means it) but never silent, so it
 *     warns naming the key.
 *   - Nested objects merge rather than replace, which deepMergeRequestBody
 *     already does. voice_settings.style must arrive without erasing stability.
 *     Prototype-polluting keys are dropped there too, so they need no handling
 *     here.
 *
 * Collision warnings look only at the top level. That is where the computed
 * values live, and walking deeper would report the merge doing its job.
 */
export function applyAudioParameters(
  body: Record<string, unknown>,
  parameters: AudioParameterRecord,
  options: AudioParameterMergeOptions,
): Record<string, unknown> {
  if (Object.keys(parameters).length === 0) return body;

  // Spread, never per-key assignment: writing "__proto__" onto a plain object
  // invokes the prototype setter, while a spread defines an own property that
  // deepMergeRequestBody then drops with the rest of the unsafe keys.
  const merged: Record<string, unknown> = { ...parameters };

  if (Object.prototype.hasOwnProperty.call(merged, options.protectedKey)) {
    logger.warn(
      "Ignoring the %s parameter %s: it would replace what this request asks the engine to render",
      options.label,
      options.protectedKey,
    );
    delete merged[options.protectedKey];
  }

  for (const [key, value] of Object.entries(merged)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    // Two plain objects merge instead of replacing, so nothing is lost and
    // there is nothing to report. Reporting it would fire on every ElevenLabs
    // request that sets a voice_settings knob.
    if (isPlainRecord(body[key]) && isPlainRecord(value)) continue;
    // An override that changes nothing is not an override. NanoGPT reads the
    // model out of this same bag to build the request, so the value always
    // arrives back identical and would otherwise warn on every game request.
    if (Object.is(body[key], value)) continue;
    logger.warn("The %s parameter %s overrides a value this request computed", options.label, key);
  }

  deepMergeRequestBody(body, merged);
  return body;
}

/**
 * The multipart form the official PocketTTS server takes, with parameters
 * appended. Values are stringified because that is all multipart carries; an
 * object or array is skipped with a warning rather than sent as its toString,
 * since there is no encoding for one a backend could be expected to agree on.
 *
 * No prototype guard here: FormData is not an object being indexed, so an
 * unsafe key is just a field name the server will ignore.
 */
export function appendAudioParameters(
  form: FormData,
  parameters: AudioParameterRecord,
  options: AudioParameterMergeOptions,
): FormData {
  for (const [key, value] of Object.entries(parameters)) {
    if (key === options.protectedKey) {
      logger.warn("Ignoring the %s parameter %s: it would replace the text to synthesize", options.label, key);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      logger.warn(
        "Ignoring the %s parameter %s: this engine takes form fields, which carry no nested value",
        options.label,
        key,
      );
      continue;
    }
    // set, not append: a parameter replaces a field the builder wrote.
    form.set(key, String(value));
  }
  return form;
}
