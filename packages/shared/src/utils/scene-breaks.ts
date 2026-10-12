/** A Markdown thematic break on its own line: 3+ of one of `*`, `-`, `_`, spaced or not, indented up to 3 spaces. */
const SCENE_BREAK = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split a reply at its scene or POV break lines (`***`, `---`, `___`, `* * *`), outside fenced code. Each break line
 * opens the part after it. A part never lacks text: a break before any text, after the last text or next to another
 * break joins the part that has text. Text without a break comes back unchanged as the only part.
 */
export function splitAtSceneBreaks(text: string): string[] {
  const parts: Array<{ lines: string[]; hasText: boolean }> = [{ lines: [], hasText: false }];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    const current = parts.at(-1)!;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(bare)) fence = null;
    } else {
      fence = FENCE.exec(bare)?.[1] ?? null;
      if (!fence && SCENE_BREAK.test(bare)) {
        if (current.hasText) parts.push({ lines: [line], hasText: false });
        else current.lines.push(line);
        continue;
      }
    }
    current.lines.push(line);
    if (bare.trim()) current.hasText = true;
  }
  // Breaks after the last text stay at the end of the part before them.
  if (parts.length > 1 && !parts.at(-1)!.hasText) parts.at(-2)!.lines.push(...parts.pop()!.lines);
  return parts.length > 1 ? parts.map((part) => part.lines.join("\n").trim()) : [text];
}
