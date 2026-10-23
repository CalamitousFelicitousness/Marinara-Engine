// ──────────────────────────────────────────────
// Game Master planning written out as prose
// ──────────────────────────────────────────────

/** The labels a Game Master's written-out plan opens its paragraphs with. Narration never starts this way. */
const PLANNING_LABEL =
  /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning|outline|beats?|approach|next steps?|location|setting|goals?|notes?|intent|stakes|mechanics|rolls?|checks?)(?:[*_]+)?\s*:/i;
/**
 * The labels only a plan uses. An out-of-character answer can open with "Checks:" or "Notes:", so a leading run of
 * labelled paragraphs is lifted only when one of its lines carries one of these.
 */
const PLAN_ONLY_LABEL =
  /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning|outline|beats?|approach|next steps?)(?:[*_]+)?\s*:/im;

export interface LeadingPlanningExtraction {
  content: string;
  planning: string;
}

/**
 * Lift the plan a Game Master wrote out before its scene ("Opening scene: ... / Plan: ...") off the reply, so it
 * goes with the turn's thinking instead of opening the narration. Only whole paragraphs at the very start that each
 * open with a planning label are lifted, only when one of them is unmistakably a plan, and only when narration
 * follows them.
 */
export function extractLeadingGmPlanning(text: string): LeadingPlanningExtraction {
  const paragraphs = text.trimStart().split(/(\n\s*\n)/);
  let planned = 0;
  // Paragraphs sit at even indexes, the blank lines between them at odd ones.
  while (planned < paragraphs.length && PLANNING_LABEL.test(paragraphs[planned] ?? "")) planned += 2;
  if (planned === 0) return { content: text, planning: "" };
  const planning = paragraphs
    .slice(0, planned - 1)
    .join("")
    .trim();
  const content = paragraphs.slice(planned).join("").trimStart();
  if (!content || !PLAN_ONLY_LABEL.test(planning)) return { content: text, planning: "" };
  return { content, planning };
}
