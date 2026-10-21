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
 * so it is escaped. Only a `"key": "value"` line that isn't valid on its own is touched, so a valid line (even one
 * holding two properties) is never merged into one value, and a value that runs on into another property (`, "key":`)
 * is left for jsonrepair, which keeps both properties.
 */
function escapeQuotesInsideLineValues(raw: string): string {
  const validProperties = (line: string) => {
    try {
      JSON.parse(`{${line.trim().replace(/,$/u, "")}}`);
      return true;
    } catch {
      return false;
    }
  };
  // A value runs on into another property only where what follows a comma parses as properties of its own.
  const runsIntoAnotherProperty = (valueWithClose: string) => {
    const boundary = /,\s*(?="[^"\n]+"\s*:)/u.exec(valueWithClose);
    return boundary !== null && validProperties(valueWithClose.slice(boundary.index + 1));
  };
  return raw
    .split("\n")
    .map((line) =>
      validProperties(line)
        ? line
        : line.replace(
            /^(\s*"[^"\n]+"\s*:\s*")(.*)("\s*,?\s*)$/u,
            (match: string, open: string, value: string, close: string) =>
              runsIntoAnotherProperty(`${value}${close}`)
                ? match
                : `${open}${value.replace(/(?<!\\)"/gu, '\\"')}${close}`,
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

  // Unescaped quotes inside a one-line string value come before jsonrepair, which "repairs" them by cutting the text
  // off at the first inner quote. Only lines that aren't valid on their own change, so valid JSON is never touched.
  const lineEscaped = (() => {
    const escaped = escapeQuotesInsideLineValues(raw);
    if (escaped === raw) return null;
    try {
      return jsonrepair(escaped);
    } catch {
      return escaped;
    }
  })();
  const candidates = [
    raw,
    lineEscaped,
    repaired,
    closeOpenJsonContainers(raw),
    repaired && closeOpenJsonContainers(repaired),
  ];
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
