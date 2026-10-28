// Pure logic behind Professor Mari's `@` reference picker: which rows exist, how a query ranks them, how a
// pick is written into the draft, and which picked references are still in the text.
import type { MariComposerReference, ProfessorMariContextResource } from "@marinara-engine/shared";
import { getCharacterDisplayIdentity } from "./character-display";
import { formatReferenceToken, type ActiveComposerToken } from "./composer-triggers";

/** The server resolves at most this many references per message. */
export const MAX_COMPOSER_REFERENCES = 8;
/** Rows shown per group before the query narrows them. */
const ROWS_PER_GROUP = 8;
const ENTRY_ROWS = 30;

export type ReferenceGroupId = "open" | "character" | "persona" | "lorebook" | "preset" | "lorebookEntry";

export const REFERENCE_GROUP_ORDER: readonly ReferenceGroupId[] = [
  "open",
  "character",
  "persona",
  "lorebook",
  "preset",
  "lorebookEntry",
];

export type ReferenceItem = { key: string; group: ReferenceGroupId; ref: MariComposerReference };

type NamedRecord = { id?: unknown; name?: unknown; data?: unknown; comment?: unknown };

/** The picker's rows from the lists the composer already loads for its ghost completion. */
export function buildReferenceItems(sources: {
  characters?: readonly unknown[];
  personas?: readonly unknown[];
  lorebooks?: readonly unknown[];
  presets?: readonly unknown[];
}): ReferenceItem[] {
  const items: ReferenceItem[] = [];
  const add = (group: Exclude<ReferenceGroupId, "open" | "lorebookEntry">, list: readonly unknown[] | undefined) => {
    for (const raw of list ?? []) {
      const record = raw as NamedRecord;
      if (typeof record.id !== "string") continue;
      const label = (
        group === "character"
          ? getCharacterDisplayIdentity({ data: record.data, comment: record.comment as string | null | undefined })
          : typeof record.name === "string"
            ? record.name
            : ""
      ).trim();
      if (label) items.push({ key: `${group}:${record.id}`, group, ref: { kind: group, id: record.id, label } });
    }
  };
  add("character", sources.characters);
  add("persona", sources.personas);
  add("lorebook", sources.lorebooks);
  add("preset", sources.presets);
  return items;
}

/** A lorebook's entries as rows (one drill-down level). */
export function buildEntryItems(lorebook: { id: string }, entries: readonly unknown[] | undefined): ReferenceItem[] {
  const items: ReferenceItem[] = [];
  for (const raw of entries ?? []) {
    const record = raw as NamedRecord;
    const label = typeof record.name === "string" ? record.name.trim() : "";
    if (typeof record.id !== "string" || !label) continue;
    items.push({
      key: `entry:${record.id}`,
      group: "lorebookEntry",
      ref: { kind: "lorebookEntry", id: record.id, label, parentId: lorebook.id },
    });
  }
  return items;
}

const OPENABLE_KINDS = new Set<MariComposerReference["kind"]>(["character", "persona", "lorebook", "preset"]);

/** The open editor's resource as a reference, or null when the resolver cannot read that kind. */
export function referenceFromResource(resource: ProfessorMariContextResource | null | undefined): ReferenceItem | null {
  if (!resource || !OPENABLE_KINDS.has(resource.kind as MariComposerReference["kind"])) return null;
  const label = (resource.label ?? "").trim();
  if (!resource.id || !label) return null;
  const kind = resource.kind as MariComposerReference["kind"];
  return { key: `open:${kind}:${resource.id}`, group: "open", ref: { kind, id: resource.id, label } };
}

export function sameReference(a: MariComposerReference, b: MariComposerReference): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** The query without its `@` / `@"` opener and closing quote: the picker and the ghost read the same text. */
export function maskReferenceQuery(raw: string): string {
  return raw.replace(/^@"?/, "").replace(/"$/, "").trimStart();
}

const WORD_BOUNDARY = /[^\p{L}\p{N}]/u;

/** 0 prefix, 1 word start, 2 substring, 3 empty query; null when the label does not match. */
export function referenceMatchScore(label: string, query: string): number | null {
  const needle = maskReferenceQuery(query).toLowerCase();
  if (!needle) return 3;
  const hay = label.toLowerCase();
  let best: number | null = null;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (at === 0) return 0;
    if (WORD_BOUNDARY.test(hay[at - 1]!)) best = 1;
    else best ??= 2;
  }
  return best;
}

export type RankedReferenceItem = ReferenceItem & { score: number };

/** Matching rows, grouped in `REFERENCE_GROUP_ORDER`; best match first inside a group, list order on ties. */
export function rankReferenceItems(
  items: readonly ReferenceItem[],
  query: string,
  limit = ROWS_PER_GROUP,
): RankedReferenceItem[] {
  const scored: Array<RankedReferenceItem & { index: number }> = [];
  items.forEach((item, index) => {
    const score = referenceMatchScore(item.ref.label, query);
    if (score !== null) scored.push({ ...item, score, index });
  });
  const out: RankedReferenceItem[] = [];
  for (const group of REFERENCE_GROUP_ORDER) {
    const cap = group === "lorebookEntry" ? ENTRY_ROWS : group === "open" ? 1 : limit;
    scored
      .filter((item) => item.group === group)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, cap)
      .forEach(({ index: _index, ...item }) => out.push(item));
  }
  return out;
}

/** The row to highlight first: the best match anywhere, the earliest row on a tie (the open editor's row leads). */
export function defaultActiveIndex(rows: readonly RankedReferenceItem[]): number {
  let best = 0;
  rows.forEach((row, index) => {
    if (row.score < rows[best]!.score) best = index;
  });
  return best;
}

/** Writes the picked token over the live `@` token and returns the new text and where the caret goes. */
export function applyReferencePick(
  draft: string,
  token: Pick<ActiveComposerToken, "start" | "end">,
  ref: MariComposerReference,
): { value: string; caret: number } {
  const text = formatReferenceToken(ref.label);
  const after = draft.slice(token.end);
  const space = /^\s/.test(after) ? "" : " ";
  return {
    value: draft.slice(0, token.start) + text + space + after,
    // Past the space, so the caret leaves the token and the picker does not reopen on it.
    caret: token.start + text.length + 1,
  };
}

const OPENERS = "([{\"'";

function boundaryBefore(text: string, index: number): boolean {
  return index === 0 || /\s/.test(text[index - 1]!) || OPENERS.includes(text[index - 1]!);
}

/**
 * The label the draft already ends with, as a name the ghost just completed: the draft's last word, or its
 * last two or three words joined ("Alice in Wonderland"). Case-insensitive; the longest wins.
 */
export function completedNameAt(draft: string, labels: readonly string[]): { start: number; label: string } | null {
  const tail = draft.trimEnd();
  const lowerTail = tail.toLowerCase();
  let best: { start: number; label: string } | null = null;
  for (const raw of labels) {
    const label = raw.trim();
    if (label.length <= 2) continue;
    const start = lowerTail.length - label.length;
    if (start < 0 || !lowerTail.endsWith(label.toLowerCase()) || !boundaryBefore(tail, start)) continue;
    if (!best || label.length > best.label.length) best = { start, label };
  }
  return best;
}

/**
 * The pick the second Tab makes on a just-completed name. The ghost inserts the label's suffix, so the draft
 * always ends with a full label; the object it names is the row with that label.
 */
export function linkCompletedReference(
  draft: string,
  labels: readonly string[],
  refs: readonly MariComposerReference[],
): { value: string; caret: number; ref: MariComposerReference } | null {
  const found = completedNameAt(draft, labels);
  if (!found) return null;
  const lower = found.label.trim().toLowerCase();
  const ref = refs.find((item) => item.label.trim().toLowerCase() === lower);
  if (!ref) return null;
  const typed = draft.slice(found.start, found.start + found.label.length);
  return {
    value: `${draft.slice(0, found.start)}@${typed}${draft.slice(found.start + found.label.length)}`,
    caret: found.start + 1 + typed.length,
    ref,
  };
}

/** Where each reference's token still sits in the draft, in order (one slot per reference, null when its
 * text was edited or removed). The same token twice takes its occurrences in turn.
 */
export function locateReferenceTokens(
  draft: string,
  refs: readonly MariComposerReference[],
): Array<{ start: number; end: number } | null> {
  const used = new Set<number>();
  return refs.map((ref) => {
    const token = formatReferenceToken(ref.label);
    for (let at = draft.indexOf(token); at !== -1; at = draft.indexOf(token, at + 1)) {
      const end = at + token.length;
      // A bare token may hold spaces, so only its start must be a boundary; its end must too, unless the
      // draft simply goes on with more words of the same name.
      const after = draft[end];
      const endsClean =
        end >= draft.length || after === undefined || /[\s.,;:!?)\]}"']/u.test(after) || /["<>]/u.test(after);
      if (used.has(at) || !boundaryBefore(draft, at) || !endsClean) continue;
      used.add(at);
      return { start: at, end };
    }
    return null;
  });
}

/** Keeps only references whose token is still in the draft. Returns `refs` itself when none dropped. */
export function pruneReferences(
  draft: string,
  refs: readonly MariComposerReference[],
): readonly MariComposerReference[] {
  const spots = locateReferenceTokens(draft, refs);
  const kept = refs.filter((_, index) => spots[index]);
  return kept.length === refs.length ? refs : kept;
}

/** Adds `ref` unless it is already there or the server cap is reached. */
export function addReference(refs: readonly MariComposerReference[], ref: MariComposerReference) {
  if (refs.some((item) => sameReference(item, ref)) || refs.length >= MAX_COMPOSER_REFERENCES) return refs;
  return [...refs, ref];
}
