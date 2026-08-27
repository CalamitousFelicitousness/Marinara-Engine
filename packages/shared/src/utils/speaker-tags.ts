// ──────────────────────────────────────────────
// Speaker tag grammar
// ──────────────────────────────────────────────
// One definition of what a speaker tag looks like, for the dozen readers that
// each carried their own copy of it: prompt history stripping, individual-mode
// unwrapping, narration NPC harvesting on both sides, TTS segmentation, and the
// chat renderer's HTML detection plus both of its render paths.
//
// Two spellings exist. `<speaker name="Amy">` is what this app writes and what
// models produce unprompted, because it is well-formed markup. `<speaker="Amy">`
// is the original spelling, chosen so a generic tag regex would not mistake a
// speaker tag for the HTML this app renders inside messages. That distinction is
// better served by matching the tag *name*, which is what the patterns below do,
// so the malformed spelling survives only as stored history.
//
// Readers accept both. Writers emit the well-formed one. A model's output is
// never rewritten on the way in.

/** The element name, for callers that need to spot the tag before parsing it. */
export const SPEAKER_TAG_NAME = "speaker";

/**
 * An opening tag in either spelling.
 *
 * The name is capture group 1 when double-quoted and group 2 when single-quoted,
 * rather than being pulled out of a back-referenced quote, because two callers
 * run this pattern inside a heterogeneous `patterns` array and read `match[1]`
 * from whichever matched. Those callers harvest NPC names out of narration and
 * so miss a single-quoted tag, which only occurs when a character's own name
 * contains a double quote; the cost is one un-suggested NPC, and the benefit is
 * that the shared pattern drops into those loops with no special case.
 *
 * Use `speakerNameFromMatch` anywhere both forms must resolve.
 */
const OPEN_TAG_SOURCE = String.raw`<${SPEAKER_TAG_NAME}(?:\s+name)?\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>`;
const CLOSE_TAG_SOURCE = String.raw`</\s*${SPEAKER_TAG_NAME}\s*>`;
const TAGGED_SPAN_SOURCE = String.raw`${OPEN_TAG_SOURCE}([\s\S]*?)${CLOSE_TAG_SOURCE}`;

/**
 * Fresh regexes per call, never a shared instance.
 *
 * A module-level `RegExp` carrying `g` keeps `lastIndex` between callers, so one
 * consumer's partial scan silently moves where the next one starts. Allocating
 * per call costs nothing measurable beside the string work around it.
 */
export function speakerOpenTagRegex(flags = "gi"): RegExp {
  return new RegExp(OPEN_TAG_SOURCE, flags);
}

export function speakerCloseTagRegex(flags = "gi"): RegExp {
  return new RegExp(CLOSE_TAG_SOURCE, flags);
}

/**
 * An opening tag, the dialogue it wraps and its closing tag as one match:
 * name in group 1 or 2, body in group 3.
 */
export function speakerTaggedSpanRegex(flags = "gi"): RegExp {
  return new RegExp(TAGGED_SPAN_SOURCE, flags);
}

/** Resolve the speaker name from a match of either pattern above. */
export function speakerNameFromMatch(match: RegExpMatchArray): string {
  return (match[1] ?? match[2] ?? "").trim();
}

/** The dialogue from a `speakerTaggedSpanRegex` match. */
export function speakerBodyFromMatch(match: RegExpMatchArray): string {
  return match[3] ?? "";
}

/** True when an opening tag in either spelling appears anywhere in `text`. */
export function hasSpeakerTag(text: string): boolean {
  return text.includes("<") && speakerOpenTagRegex("i").test(text);
}

/** Remove every speaker tag, keeping the dialogue it wrapped. */
export function stripSpeakerTags(text: string): string {
  if (!text.includes("<")) return text;
  return text.replace(speakerOpenTagRegex(), "").replace(speakerCloseTagRegex(), "");
}

/**
 * Replace each complete tagged span with the result of `replacer`.
 *
 * A span with no closing tag is not a match and is left alone, which is what
 * keeps a half-streamed reply from having its remainder swallowed.
 */
export function replaceSpeakerSpans(text: string, replacer: (name: string, body: string) => string): string {
  if (!text.includes("<")) return text;
  return text.replace(speakerTaggedSpanRegex(), (...args) => {
    const match = args.slice(0, -2) as unknown as RegExpMatchArray;
    const name = speakerNameFromMatch(match);
    return name ? replacer(name, speakerBodyFromMatch(match)) : String(args[0]);
  });
}

/**
 * Write a tag in the well-formed spelling.
 *
 * Switches to single quotes when the name contains a double quote rather than
 * emitting a tag that would truncate at it. Both are readable above, so this
 * costs nothing and removes a name the format previously could not express.
 */
export function formatSpeakerTag(name: string): string {
  const quote = name.includes('"') ? "'" : '"';
  return `<${SPEAKER_TAG_NAME} name=${quote}${name.replaceAll(quote, "")}${quote}>`;
}

/** The closing tag this app writes. */
export const SPEAKER_CLOSE_TAG = `</${SPEAKER_TAG_NAME}>`;
