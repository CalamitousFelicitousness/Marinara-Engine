// ──────────────────────────────────────────────
// Game Master planning written out as prose
// ──────────────────────────────────────────────

/** The labels only a plan uses. A run of planning paragraphs is lifted only when one of its lines carries one. */
const PLAN_ONLY_LABEL = /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning)(?:[*_]+)?\s*:/im;
/**
 * The labels a plan's other paragraphs open with, ahead of the plan or behind it, which no out-of-character answer
 * plausibly opens with. "Notes:", "Checks:", "Approach:", "Goals:", "Outline:" or "Next steps:" can open an answer or
 * a question to the player, so a paragraph opening with one of those ends the run.
 */
const PLAN_PART_LABEL =
  /^\s*(?:[*_#>-]+\s*)?(?:opening scene|scene plan|plan|planning|location|setting|beats?)(?:[*_]+)?\s*:/i;

export interface LeadingPlanningExtraction {
  content: string;
  planning: string;
}

/**
 * Lift the plan a Game Master wrote out before its scene ("Opening scene: ... / Location: ... / Plan: ...") off the
 * reply, so it goes with the turn's thinking instead of opening the narration. The leading run of paragraphs that
 * each open with a plan's label is lifted whole, only when one of them names itself a plan and only when something
 * follows the run; the first paragraph that opens otherwise ends the run and stays with everything behind it.
 */
export function extractLeadingGmPlanning(text: string): LeadingPlanningExtraction {
  const paragraphs = text.trimStart().split(/(\n\s*\n)/);
  let planned = 0;
  // Paragraphs sit at even indexes, the blank lines between them at odd ones.
  while (planned < paragraphs.length && PLAN_PART_LABEL.test(paragraphs[planned] ?? "")) planned += 2;
  if (planned === 0) return { content: text, planning: "" };
  const planning = paragraphs
    .slice(0, planned - 1)
    .join("")
    .trim();
  const content = paragraphs.slice(planned).join("").trimStart();
  if (!content || !PLAN_ONLY_LABEL.test(planning)) return { content: text, planning: "" };
  return { content, planning };
}

/**
 * A Game Master that calls a tool mid-reply often announces it first ("... in the lamplight — let me get the
 * number."). The announcement is the model talking to itself, not the scene, so it is cut off the end of the text
 * written before the call. Only a final sentence or dash-led clause that says the writer is about to roll dice or
 * get a die's number is cut; anything before it stays. Rolling must be "roll it", "roll for ..." or roll something
 * dice-shaped, and any other verb must name the number it is after (the number, the save, the damage, how much it
 * heals), so a line that only sounds like it ("Time to check the cellar before the light goes.") is left alone.
 */
const ANNOUNCEMENT_WORD = String.raw`[ \t]+[^\s.!?,;:"“”—–]+`;
const DICE_WORD = String.raw`(?:numbers?|results?|rolls?|dice|d\d+|\d*d\d+(?:[+-]\d+)?|totals?|damage|heal(?:s|ing)?|saves?|saving throws?|checks?|outcomes?|odds|dc|modifiers?|bonus|initiative)`;
const DICE_OBJECT = String.raw`(?:${ANNOUNCEMENT_WORD}){0,4}?[ \t]+${DICE_WORD}(?=[\s.!?:…]|$)(?:[ \t]+(?:for|on|against)(?:${ANNOUNCEMENT_WORD}){1,3})?`;
const TOOL_ANNOUNCEMENT = new RegExp(
  String.raw`(?:^|(?<=[.!?…"'”’*_)\]])\s+|\s*[—–]\s*|\s+-{1,2}\s+)` +
    String.raw`(?:(?:okay|ok|alright|right|now|first|so),?\s+)*` +
    String.raw`(?:let(?:'s|’s| me| us)|i(?:'ll|’ll| will| need to| have to|'m going to|’m going to| am going to)|time to)\s+` +
    String.raw`(?:(?:roll|re-?roll|throw)(?:${DICE_OBJECT}|[ \t]+(?:the|a)[ \t]+die|(?:[ \t]+(?:it|them|that|this))?(?:[ \t]+for(?:${ANNOUNCEMENT_WORD}){1,5})?)` +
    String.raw`|(?:get|check|see|find out|call|look up|determine|work out|figure out)${DICE_OBJECT})` +
    String.raw`[ \t]*[.!?:…]*\s*$`,
  "i",
);

export function stripTrailingToolAnnouncement(text: string): string {
  const match = TOOL_ANNOUNCEMENT.exec(text);
  return match ? text.slice(0, match.index).trimEnd() : text;
}
