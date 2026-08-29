// ──────────────────────────────────────────────
// TTS Request Preview
// ──────────────────────────────────────────────
// Turning a built request into something safe to show.
//
// Extra parameters are free-form by necessity, since no backend's schema is
// knowable here. That makes "did my parameter land, and in the shape this engine
// wants" a question the app has to be able to answer, and the provider layer
// already can: it builds a request without sending one.
//
// Redaction covers the URL and the headers, which is where the app puts the key.
// The body is left alone: it is the user's own content and their own parameters,
// and scrubbing it could mangle text that merely resembles the key.

import { TTS_API_KEY_MASK } from "@marinara-engine/shared";
import type { TTSProviderRequest } from "./tts-types.js";

/** Stand-in content, so a preview needs no message and generates no audio. */
export const TTS_PREVIEW_TEXT = "Sample line.";
export const TTS_PREVIEW_GAME_PROMPT = "sample prompt";

export interface TTSRequestPreview {
  url: string;
  headers: Record<string, string>;
  /** Parsed when the backend takes JSON, field names and values when it takes a form. */
  body: unknown;
  /** True when the backend takes multipart, so a reader knows why body is flat. */
  multipart: boolean;
}

function redact(value: string, apiKey: string): string {
  if (!apiKey) return value;
  return value.split(apiKey).join(TTS_API_KEY_MASK);
}

export function buildTTSRequestPreview(request: TTSProviderRequest, apiKey: string): TTSRequestPreview {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = redact(value, apiKey);
  }

  if (request.body instanceof FormData) {
    const fields: Record<string, unknown> = {};
    for (const [name, value] of request.body.entries()) {
      fields[name] = typeof value === "string" ? value : `<${value.size} bytes>`;
    }
    return { url: redact(request.url, apiKey), headers, body: fields, multipart: true };
  }

  let body: unknown = request.body;
  try {
    body = JSON.parse(request.body);
  } catch {
    // A backend that sends something other than JSON is shown its own text.
  }
  return { url: redact(request.url, apiKey), headers, body, multipart: false };
}
