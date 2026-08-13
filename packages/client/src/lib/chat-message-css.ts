// Shared-message HTML may include author-supplied inline styles and <style>
// blocks. Keep that CSS useful, but prevent it from escaping the message box.

const CSS_SELECTOR_RE = /(^|[{}])\s*([^@{}][^{]*)\{/g;
const STRING_OR_ESCAPE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\\(?:[0-9a-fA-F]{1,6}\s?|[\s\S])/g;
const SAFE_POSITION_VALUES = new Set([
  "absolute",
  "inherit",
  "initial",
  "relative",
  "revert",
  "revert-layer",
  "static",
  "unset",
]);

/** Remove CSS comments without treating comment-like text inside strings as syntax. */
function stripCssComments(css: string): string {
  let result = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    const next = css[index + 1];
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (char !== "/" || next !== "*") {
      result += char;
      continue;
    }

    // A comment separates CSS tokens, so preserve one space while dropping its
    // contents. This keeps the browser and sanitizer token boundaries aligned.
    result += " ";
    index += 2;
    while (index < css.length && !(css[index] === "*" && css[index + 1] === "/")) index += 1;
    if (index < css.length) index += 1;
  }

  return result;
}

/** Decode CSS escape sequences (`\XX` hex, `\c` literal) to browser-parsed characters. */
function decodeCssEscapes(input: string): string {
  return input.replace(
    /\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g,
    (_match, hex: string | undefined, char: string | undefined) => {
      if (hex) {
        const codePoint = parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      }
      return char ?? "";
    },
  );
}

function canonicalizeKeywordEscapes(css: string): string {
  return css.replace(STRING_OR_ESCAPE, (match: string, stringLiteral: string | undefined) => {
    if (stringLiteral !== undefined) return stringLiteral;
    const decoded = decodeCssEscapes(match);
    return /^[-A-Za-z@]$/.test(decoded) ? decoded : match;
  });
}

function isCssNameCharacter(char: string | undefined): boolean {
  return char !== undefined && /[-_0-9A-Za-z\\\u0080-\uFFFF]/u.test(char);
}

/** Strip statement at-rules through their terminating semicolon, respecting strings and functions. */
function stripForbiddenStatementAtRules(css: string): string {
  let result = "";
  let cursor = 0;
  let index = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let parenthesisDepth = 0;

  while (index < css.length) {
    const char = css[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "(") {
      parenthesisDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")" && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      index += 1;
      continue;
    }

    const lower = parenthesisDepth === 0 ? css.slice(index, index + 10).toLowerCase() : "";
    const keyword = lower.startsWith("@import") ? "@import" : lower.startsWith("@namespace") ? "@namespace" : null;
    if (!keyword || isCssNameCharacter(css[index + keyword.length])) {
      index += 1;
      continue;
    }

    result += css.slice(cursor, index);
    index += keyword.length;
    let depth = 0;
    let statementQuote: '"' | "'" | null = null;
    let statementEscaped = false;
    while (index < css.length) {
      const statementChar = css[index]!;
      if (statementQuote) {
        if (statementEscaped) statementEscaped = false;
        else if (statementChar === "\\") statementEscaped = true;
        else if (statementChar === statementQuote) statementQuote = null;
      } else if (statementChar === '"' || statementChar === "'") {
        statementQuote = statementChar;
      } else if (statementChar === "(") {
        depth += 1;
      } else if (statementChar === ")" && depth > 0) {
        depth -= 1;
      } else if (statementChar === ";" && depth === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
    cursor = index;
  }

  return result + css.slice(cursor);
}

function sanitizePositionDeclarations(css: string): string {
  return css.replace(
    /(^|[;{])(\s*)position\s*:\s*([^;}]*)/gim,
    (_match, boundary: string, spacing: string, rawValue: string) => {
      const value = rawValue
        .replace(/!important/gi, "")
        .trim()
        .toLowerCase();
      const safeValue =
        value === "fixed" || value === "sticky" ? "absolute" : SAFE_POSITION_VALUES.has(value) ? value : "static";
      return `${boundary}${spacing}position:${safeValue}`;
    },
  );
}

export function sanitizeChatMessageCss(css: string): string {
  let sanitized = canonicalizeKeywordEscapes(stripCssComments(css));
  sanitized = stripForbiddenStatementAtRules(sanitized)
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/vbscript\s*:/gi, "")
    .replace(/behavior\s*:/gi, "x-behavior:")
    .replace(/-moz-binding\s*:/gi, "x-moz-binding:")
    .replace(/url\s*\(\s*(?!['"]?(?:data:image\/|https?:\/\/))(['"]?)[^)]+\)/gi, "none")
    .replace(/!important/gi, "")
    .replace(/\bcontent\s*:[^;}]*/gi, "")
    .replace(/</g, "\\3c ");
  return sanitizePositionDeclarations(sanitized).trim();
}

export function scopeChatMessageCss(css: string, scopeSelector: string): string {
  const sanitized = sanitizeChatMessageCss(css);
  if (!sanitized) return "";
  return sanitized.replace(CSS_SELECTOR_RE, (_match, boundary: string, selectors: string) => {
    const scopedSelectors = selectors
      .split(",")
      .map((selector) => {
        const trimmed = selector.trim();
        if (!trimmed) return "";
        if (/^(from|to|\d+(?:\.\d+)?%)$/i.test(trimmed)) return trimmed;
        if (trimmed.startsWith(scopeSelector)) return trimmed;
        if (trimmed === ":root" || trimmed === "html" || trimmed === "body") return scopeSelector;
        return `${scopeSelector} ${trimmed}`;
      })
      .filter(Boolean)
      .join(", ");
    return `${boundary} ${scopedSelectors}{`;
  });
}
