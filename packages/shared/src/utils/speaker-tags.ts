// ──────────────────────────────────────────────
// Speaker tag normalization
// ──────────────────────────────────────────────
// Group chat colouring asks the model for `<speaker="Amy">…</speaker>`. That is
// not well-formed markup: an attribute needs a name, so `<speaker name="Amy">`
// is what a model trained on XML and HTML reaches for, and it keeps reaching for
// it however the prompt is worded. Prompt wording cannot reliably beat a
// tokenizer-level prior.
//
// Eleven parsers across server and client hardcode the canonical spelling
// (history stripping, individual-mode unwrapping, the game surface, TTS, the
// chat renderer). Teaching each of them a second syntax multiplies the places a
// third variant would have to be added later. Repairing the model's output once,
// at the boundary, leaves every one of them correct as written.

/** The tag form every parser in the app expects. */
export const CANONICAL_SPEAKER_TAG_PATTERN = /<speaker="([^"]*)">/;

/**
 * The attribute form models produce instead. Tolerates either quote style and
 * whitespace around `=`, because those vary between models and neither changes
 * the intent.
 */
const ATTRIBUTE_SPEAKER_TAG_RE = /<speaker\s+name\s*=\s*(["'])([\s\S]*?)\1\s*>/gi;

/**
 * Rewrite `<speaker name="Amy">` into `<speaker="Amy">`.
 *
 * Leaves already-canonical tags, closing tags and every other tag untouched. A
 * name containing a double quote is dropped rather than emitted, because the
 * canonical form cannot represent one: every consumer matches `[^"]*`, so
 * emitting it would produce a tag that silently truncates at the quote.
 */
export function normalizeSpeakerTags(text: string): string {
  if (!text || !text.includes("<speaker")) return text;
  return text.replace(ATTRIBUTE_SPEAKER_TAG_RE, (match, _quote: string, name: string) =>
    name.includes('"') ? match : `<speaker="${name}">`,
  );
}
