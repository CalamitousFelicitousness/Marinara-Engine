// ──────────────────────────────────────────────
// Game Master planning written out as prose
// ──────────────────────────────────────────────

/** The labels a Game Master's written-out plan opens its paragraphs with. Narration never starts this way. */
const PLANNING_LABEL =
  /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning|location|setting|goals?|notes?|outline|beats?|approach|intent|stakes|next steps?|mechanics|rolls?|checks?)(?:[*_]+)?\s*:/i;

export interface LeadingPlanningExtraction {
  content: string;
  planning: string;
}

/**
 * Lift the plan a Game Master wrote out before its scene ("Opening scene: ... / Plan: ...") off the reply, so it
 * goes with the turn's thinking instead of opening the narration. Only whole paragraphs at the very start that each
 * open with a planning label are lifted, and only when narration follows them.
 */
export function extractLeadingGmPlanning(text: string): LeadingPlanningExtraction {
  const paragraphs = text.split(/(\n\s*\n)/);
  let planned = 0;
  // Paragraphs sit at even indexes, the blank lines between them at odd ones.
  while (planned < paragraphs.length && PLANNING_LABEL.test(paragraphs[planned] ?? "")) planned += 2;
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
