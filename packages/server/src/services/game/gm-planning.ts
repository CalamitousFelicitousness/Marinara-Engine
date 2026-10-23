// ──────────────────────────────────────────────
// Game Master planning written out as prose
// ──────────────────────────────────────────────

/** The labels a Game Master's written-out plan opens its paragraphs with. Narration never starts this way. */
const PLANNING_LABEL =
  /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning|location|setting|goals?|notes?|intent|stakes|mechanics|rolls?|checks?)(?:[*_]+)?\s*:/i;
/**
 * The labels only a plan uses. An out-of-character answer can open with "Checks:", "Notes:" or "Approach:", so a
 * paragraph is lifted only when one of its own lines carries one of these.
 */
const PLAN_ONLY_LABEL = /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning)(?:[*_]+)?\s*:/im;

export interface LeadingPlanningExtraction {
  content: string;
  planning: string;
}

/**
 * Lift the plan a Game Master wrote out before its scene ("Opening scene: ... / Plan: ...") off the reply, so it
 * goes with the turn's thinking instead of opening the narration. Only whole paragraphs at the very start are lifted,
 * each only when it opens with a planning label and is unmistakably a plan itself, stopping at the first that is not,
 * and only when something follows them.
 */
export function extractLeadingGmPlanning(text: string): LeadingPlanningExtraction {
  const paragraphs = text.trimStart().split(/(\n\s*\n)/);
  let planned = 0;
  // Paragraphs sit at even indexes, the blank lines between them at odd ones.
  while (planned < paragraphs.length) {
    const paragraph = paragraphs[planned] ?? "";
    if (!PLANNING_LABEL.test(paragraph) || !PLAN_ONLY_LABEL.test(paragraph)) break;
    planned += 2;
  }
  if (planned === 0) return { content: text, planning: "" };
  const content = paragraphs.slice(planned).join("").trimStart();
  if (!content) return { content: text, planning: "" };
  return {
    content,
    planning: paragraphs
      .slice(0, planned - 1)
      .join("")
      .trim(),
  };
}
