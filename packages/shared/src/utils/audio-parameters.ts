// ──────────────────────────────────────────────
// Audio Parameter Access
// ──────────────────────────────────────────────
// Reading and editing the per-purpose parameter records an audio connection
// stores. The merge into an outbound request lives on the server, next to the
// prototype-pollution guard it shares with the LLM request path; this file only
// gets values in and out.
//
// Paths are dotted in the catalog and nested in storage, because that is what
// the backends want: voice_settings.style has to arrive inside voice_settings
// without erasing stability beside it.

import type { AudioPurpose } from "../constants/audio-purposes.js";
import type { AudioParameterRecord, TTSConfig } from "../types/tts.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parameters for one lane. Empty when none are stored, which is the state that
 * makes an outbound body identical to what it was before this feature existed.
 */
export function audioParametersFor(cfg: TTSConfig, purpose: AudioPurpose): AudioParameterRecord {
  return cfg.audioParameters?.[purpose] ?? {};
}

/** Value at a dotted path, or undefined when any segment is missing. */
export function readParameterPath(record: AudioParameterRecord, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * A copy of the record with the dotted path set, or removed when the value is
 * undefined. Removal prunes parents it empties, so clearing the last
 * voice_settings row leaves no empty object to be sent.
 */
export function writeParameterPath(record: AudioParameterRecord, path: string, value: unknown): AudioParameterRecord {
  const segments = path.split(".");
  const [head, ...rest] = segments;
  if (head === undefined) return record;

  const next: AudioParameterRecord = { ...record };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }

  const child = isPlainRecord(next[head]) ? (next[head] as AudioParameterRecord) : {};
  const updated = writeParameterPath(child, rest.join("."), value);
  if (Object.keys(updated).length === 0) delete next[head];
  else next[head] = updated;
  return next;
}

/**
 * Dotted paths to every stored value, nested ones included, so the editor can
 * show a key the catalog does not describe instead of hiding it. An empty
 * object is its own leaf: it is storage the user wrote and must stay visible.
 */
export function audioParameterPaths(record: AudioParameterRecord): string[] {
  const paths: string[] = [];
  const walk = (value: Record<string, unknown>, prefix: string): void => {
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainRecord(entry) && Object.keys(entry).length > 0) walk(entry, path);
      else paths.push(path);
    }
  };
  walk(record, "");
  return paths;
}
