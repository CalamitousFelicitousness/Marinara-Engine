function hasHtmlOrXmlTag(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}

function hasFencedBlock(text: string): boolean {
  return /```/.test(text);
}

export function textRewriteDropsProtectedMarkup(original: string | null | undefined, edited: string): boolean {
  if (!original) return false;

  const originalHasTags = hasHtmlOrXmlTag(original);
  const originalHasFences = hasFencedBlock(original);
  if (!originalHasTags && !originalHasFences) return false;

  return (originalHasTags && !hasHtmlOrXmlTag(edited)) || (originalHasFences && !hasFencedBlock(edited));
}

/** Answered world, place and story tags: the Engine's record of what a reply did (worldgen W4, W10). */
const ANSWERED_TAG = /\[(?:world|place|story):[^\]]*result="ok"[^\]]*\]/gi;

/**
 * True when a rewrite changes what the Engine wrote into a reply: the text it put before the reply (a
 * walk's, a visit's and a story's tags, and a scene shown as written, which the player must see as
 * written), or any answered tag, which the world's and the story's ledgers are read from.
 */
export function textRewriteChangesEngineText(original: string | null | undefined, edited: string, prefix: string) {
  if (!original) return false;
  if (prefix && original.startsWith(prefix) && !edited.startsWith(prefix)) return true;
  return (original.match(ANSWERED_TAG) ?? []).some((tag) => !edited.includes(tag));
}
