// regression-layout: source-path this is a stylesheet rule, so the stylesheets' text is what is checked.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Chrome restyles every element on any DOM change while a :not(:has(... :focus ...)) selector is
// live, so each keystroke in a message editor recalculated ~9500 elements. Track focus with an
// attribute instead, as GlobalOmnibar does with data-mari-composer-focused.
const stylesDir = fileURLToPath(new URL("../../../packages/client/src/styles/", import.meta.url));

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

const omnibar = readFileSync(
  new URL("../../../packages/client/src/components/layout/GlobalOmnibar.tsx", import.meta.url),
  "utf8",
);
assert.match(omnibar, /data-mari-composer-focused=/u, "GlobalOmnibar must publish the Mari composer focus");

// group-has-[...] and peer-has-[...] compile to a :has() on an unknown ancestor, which restyles the
// whole page on every DOM change.
const clientSrc = fileURLToPath(new URL("../../../packages/client/src/", import.meta.url));
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "localization" ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/u.test(entry.name) ? [path] : [];
  });
}
const ancestorHas = sourceFiles(clientSrc).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/(?:group|peer)-has-\[/gu)].map(() => file),
);
assert.deepEqual(ancestorHas, [], "no client class uses a group-has or peer-has utility");

console.log("CSS :has focus negation regression passed.");
