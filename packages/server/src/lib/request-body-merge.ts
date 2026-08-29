// ──────────────────────────────────────────────
// Request Body Merge
// ──────────────────────────────────────────────
// Folding a user-authored JSON object into a request body the app already
// built. Two callers: LLM connection customParameters and audio connection
// audioParameters.
//
// Shared rather than copied because of isUnsafeRequestBodyKey. A prototype
// pollution guard that exists twice is a guard that will eventually disagree
// with itself, and the half that falls behind is the half nobody is looking at.
//
// Merges recurse into plain objects instead of replacing them: a nested knob
// (voice_settings.style, output_format.bit_rate) has to arrive without erasing
// its siblings.

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isUnsafeRequestBodyKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function deepMergeRequestBody(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isUnsafeRequestBodyKey(key)) continue;
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainRecord(current) && isPlainRecord(value)) {
      deepMergeRequestBody(current, value);
    } else {
      target[key] = value;
    }
  }
}
