// Pure logic for the Professor Mari composer's `@` (reference) and `/` (command) triggers, plus the
// keyboard routing that decides who owns a key: the picker, the inline ghost, or Send.

export type ComposerTrigger = "@" | "/";

export type ActiveComposerToken = {
  trigger: ComposerTrigger;
  /** The text typed after the trigger, up to the caret (the opening quote of the `@"..."` form is stripped). */
  query: string;
  /** Index of the trigger character. */
  start: number;
  /** Index just past the token (the closing quote included for a quoted token). */
  end: number;
  quoted: boolean;
};

const OPENERS = "([{\"'";

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** `@` opens a token only at the start of the text, after whitespace or after opening punctuation. */
function canOpenAt(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1]!;
  return isWhitespace(prev) || OPENERS.includes(prev);
}

/** The trigger token the caret is inside or at the end of, or null. */
export function activeToken(text: string, caret: number): ActiveComposerToken | null {
  if (caret < 0 || caret > text.length) return null;

  // Quoted `@"..."`: the query may hold spaces; a closing quote before the caret ends it.
  for (let i = 0; i < caret; i++) {
    if (text[i] !== "@" || text[i + 1] !== '"' || !canOpenAt(text, i)) continue;
    const close = text.indexOf('"', i + 2);
    if (close !== -1 && close < caret) {
      i = close;
      continue;
    }
    const query = text.slice(i + 2, caret);
    if (query.includes("\n")) continue;
    return { trigger: "@", query, start: i, end: close === -1 ? caret : close + 1, quoted: true };
  }

  // Unquoted `@`: look inside the non-whitespace run the caret sits in.
  let wordStart = caret;
  while (wordStart > 0 && !isWhitespace(text[wordStart - 1])) wordStart--;
  for (let i = wordStart; i < caret; i++) {
    if (text[i] !== "@" || !canOpenAt(text, i)) continue;
    if (text[i + 1] === '"') return null; // a quoted token that already closed
    let end = caret;
    while (end < text.length && !isWhitespace(text[end])) end++;
    return { trigger: "@", query: text.slice(i + 1, caret), start: i, end, quoted: false };
  }

  // `/` only at the start of a line, with no further slash or whitespace in the query.
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const slash = /^([ \t]*)\/([^\s/]*)$/.exec(text.slice(lineStart, caret));
  if (slash) {
    let end = caret;
    while (end < text.length && !isWhitespace(text[end])) end++;
    return { trigger: "/", query: slash[2]!, start: lineStart + slash[1]!.length, end, quoted: false };
  }
  return null;
}

/** `@Alice`, or `@"Alice in Wonderland"` when the label has whitespace or quotes (inner quotes dropped). */
export function formatReferenceToken(label: string): string {
  if (!/[\s"]/.test(label)) return `@${label}`;
  return `@"${label.replace(/"/g, "").trim()}"`;
}

export type ComposerKeyInput = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  pickerOpen: boolean;
  hasGhost: boolean;
  enterToSend: boolean;
};

export type ComposerKeyAction =
  "picker-next" | "picker-prev" | "picker-accept" | "picker-close" | "ghost-accept" | "send" | "none";

/** Who owns a key in the composer textarea. Priority: picker, then the ghost, then Send. */
export function composerKeyAction(input: ComposerKeyInput): ComposerKeyAction {
  if (input.isComposing) return "none";
  if (input.pickerOpen) {
    if (input.key === "ArrowDown") return "picker-next";
    if (input.key === "ArrowUp") return "picker-prev";
    if (input.key === "Enter" || input.key === "Tab") return "picker-accept";
    if (input.key === "Escape") return "picker-close";
  }
  if (input.key === "Tab" && !input.shiftKey && input.hasGhost) return "ghost-accept";
  if (input.key === "Enter" && !input.shiftKey && (input.enterToSend || input.metaKey || input.ctrlKey)) return "send";
  return "none";
}
