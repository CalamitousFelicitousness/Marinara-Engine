import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Chrome restyles every element on any DOM change while a :not(:has(... :focus ...)) selector is
// live, so each keystroke in a message editor recalculated ~9500 elements. Track focus with an
// attribute instead, as AppShell does with data-mari-composer-focused.
const stylesDir = fileURLToPath(new URL("../../packages/client/src/styles/", import.meta.url));

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const offenders = [];
for (const file of cssFiles(stylesDir)) {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of source.matchAll(/:not\(\s*:has\(([^{}]*?)\)\s*\)/gu)) {
    if (/:focus/u.test(match[1])) offenders.push(`${file}: ${match[0]}`);
  }
}

assert.deepEqual(offenders, [], "no client stylesheet may test :focus inside :not(:has(...))");

const appShell = readFileSync(
  new URL("../../packages/client/src/components/layout/AppShell.tsx", import.meta.url),
  "utf8",
);
assert.match(appShell, /toggleAttribute\(\s*"data-mari-composer-focused"/u, "AppShell must publish the Mari composer focus");
const mariCss = readFileSync(new URL("../../packages/client/src/styles/mari.css", import.meta.url), "utf8");
assert.equal(
  mariCss.match(/html\[data-mari-software-keyboard-open\]:not\(\[data-mari-composer-focused\]\)/gu)?.length ?? 0,
  3,
  "the Mari sheet peeks under the keyboard only while her composer is not focused",
);

console.log("CSS :has focus negation regression passed.");
