import { jsonrepair } from "jsonrepair";

function closeOpenJsonContainers(raw: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return null;
  }

  if (inString) return null;
  return (
    raw +
    stack
      .reverse()
      .map((opening) => (opening === "{" ? "}" : "]"))
      .join("")
  );
}

/**
 * Models often write dialogue in plain quotes inside a JSON string ("firstMessage": ""Hi," she says.",). When each
 * property sits on its own line, every quote between a string value's opening and closing quote belongs to the text,
 * so it is escaped. Lines that aren't a single `"key": "value"` are left as they are.
 */
function escapeQuotesInsideLineValues(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line.replace(
        /^(\s*"[^"\n]+"\s*:\s*")(.*)("\s*,?\s*)$/u,
        (_, open: string, value: string, close: string) => `${open}${value.replace(/(?<!\\)"/gu, '\\"')}${close}`,
      ),
    )
    .join("\n");
}

/** Return a valid JSON string after applying the same conservative repair waterfall everywhere. */
export function repairJsonText(raw: string): string | null {
  let repaired: string | null = null;
  try {
    repaired = jsonrepair(raw);
  } catch {
    // Fall through to the conservative container-closing recovery.
  }

  const candidates = [raw, repaired, closeOpenJsonContainers(raw), repaired && closeOpenJsonContainers(repaired)];
  // Last resort, only when nothing above parses: quotes inside one-line string values.
  const lineEscaped = (() => {
    const escaped = escapeQuotesInsideLineValues(raw);
    if (escaped === raw) return null;
    try {
      return jsonrepair(escaped);
    } catch {
      return escaped;
    }
  })();
  candidates.push(lineEscaped);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next repair candidate.
    }
  }
  return null;
}

export function tryParseJsonRecord(raw: string): Record<string, unknown> | null {
  const repaired = repairJsonText(raw);
  if (!repaired) return null;
  const parsed = JSON.parse(repaired) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}
