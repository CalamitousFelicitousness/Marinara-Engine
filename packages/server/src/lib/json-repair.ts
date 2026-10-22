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
 * so it is escaped. Only a `"key": "value"` line that isn't valid on its own is touched, so a valid line is never
 * merged into one value; a broken line holding several properties is split at each `, "key": "` (the key quoted,
 * single-quoted or bare, as models mix them) and each value is escaped on its own.
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
  const escapeValue = (property: string) =>
    property.replace(
      /^(\s*(?:"[^"\n]+"|'[^'\n]+'|[A-Za-z_$][\w$]*)\s*:\s*")(.*)("\s*,?\s*)$/u,
      (_: string, open: string, value: string, close: string) => `${open}${value.replace(/(?<!\\)"/gu, '\\"')}${close}`,
    );
  return raw
    .split("\n")
    .map((line) =>
      validProperties(line)
        ? line
        : line
            .split(/,(?=\s*(?:"[^"\n]+"\s*:|(?:'[^'\n]+'|[A-Za-z_$][\w$]*)\s*:\s*["']))/u)
            .map(escapeValue)
            .join(","),
    )
    .join("\n");
}

/**
 * Every key the model wrote in `text`: quoted (`"key":`, decoded as JSON reads it), single-quoted (`'key':`) or bare
 * (`key:` at the start of a line or after `{` or `,`), as models often mix them.
 */
function writtenKeysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"\s*:/gu)) {
    try {
      keys.add(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // Not a valid JSON string; it can't be a key jsonrepair kept either.
    }
  }
  for (const match of text.matchAll(/'((?:[^'\\\n]|\\.)*)'\s*:/gu)) keys.add(match[1]!.replace(/\\(.)/gu, "$1"));
  for (const match of text.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*:/gmu)) keys.add(match[1]!);
  return keys;
}

/** Whether every object key in `json` was written as a key in `text`, so none was made up from prose. */
function keysAreFromText(json: string, text: string): boolean {
  const keys = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(keys)
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, item]) => [key, ...keys(item)])
        : [];
  try {
    const written = writtenKeysIn(text);
    return keys(JSON.parse(json)).every((key) => written.has(key));
  } catch {
    return false;
  }
}

/** Return a valid JSON string after applying the same conservative repair waterfall everywhere. */
export function repairJsonText(raw: string): string | null {
  let repaired: string | null = null;
  try {
    repaired = jsonrepair(raw);
  } catch {
    // Fall through to the conservative container-closing recovery.
  }

  // jsonrepair "repairs" dialogue quotes inside a value by cutting the text off at the first one and turning the rest
  // into a key of its own ("The librarian smiles."). Its reading is trusted only when every key in it was written as a
  // key in the model's text (quoted or not); otherwise the dialogue escape below goes first. Dialogue that itself holds `, "key": "value"`
  // (or `, key: "value"`) reads exactly like another property, so there jsonrepair's reading stands.
  const trustedRepair = repaired && keysAreFromText(repaired, raw) ? repaired : null;
  // Only lines that aren't valid on their own change, so valid JSON is never touched.
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
    trustedRepair,
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
