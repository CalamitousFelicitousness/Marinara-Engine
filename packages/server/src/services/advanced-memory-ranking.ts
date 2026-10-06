// Source labels and connective words must not manufacture recall relevance.
const RECALL_STOP_WORDS = new Set(
  "the and that this these those with from into for was were are has have had will would could should can not but you your yours they their them she her his him our ours who what where when why how about after before then than there here just also only some any all each been being did does doing said says say user assistant narrator message messages scene".split(
    " ",
  ),
);

export function recallTerms(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase().match(/[\p{L}][\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !RECALL_STOP_WORDS.has(word)),
  );
}

// ponytail: capitalisation finds names only in cased scripts, and a fixed weight lets one name
// outrank a long message's ordinary words. Entity extraction is the upgrade path.
const NAME_WEIGHT = 8;

/** Query words that the texts write capitalised mid-sentence and never in lowercase: names such as "Shiro". */
export function recallNames(query: ReadonlySet<string>, texts: readonly string[]): Set<string> {
  const named = new Set<string>();
  const lowercase = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/[\p{L}][\p{L}\p{N}]{2,}/gu)) {
      const word = match[0].toLocaleLowerCase();
      if (!query.has(word)) continue;
      if (match[0][0] === word[0]) lowercase.add(word);
      else if (/[\p{L}\p{N},;] $/u.test(text.slice(Math.max(0, match.index - 2), match.index))) named.add(word);
    }
  }
  return new Set([...named].filter((word) => !lowercase.has(word)));
}

/** Binary-term BM25: rare cues survive long recaps, using already-tokenized records. */
export function scoreRecallTerms(
  query: ReadonlySet<string>,
  documents: readonly ReadonlySet<string>[],
  names: ReadonlySet<string> = new Set(),
): number[] {
  const frequencies = new Map<string, number>();
  let totalLength = 0;
  for (const words of documents) {
    totalLength += words.size;
    for (const word of query) {
      if (words.has(word)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }
  const averageLength = totalLength / Math.max(1, documents.length) || 1;
  const weights = [...frequencies].map(([word, frequency]) => ({
    word,
    // A name found in most documents (the persona or the main character) is no cue.
    weight:
      Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5)) *
      (names.has(word) && frequency * 2 <= documents.length ? NAME_WEIGHT : 1),
  }));
  return documents.map((words) => {
    // Standard BM25 k1=1.2 and b=0.75, with each distinct term counted once.
    const lengthFactor = 2.2 / (1 + 1.2 * (0.25 + (0.75 * words.size) / averageLength));
    let score = 0;
    for (const { word, weight } of weights) {
      if (words.has(word)) score += weight * lengthFactor;
    }
    return score / (1 + score); // Keep lexical and semantic relevance on the same 0–1 scale.
  });
}
