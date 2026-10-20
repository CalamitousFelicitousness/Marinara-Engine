import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = process.argv[2] ? resolve(process.argv[2]) : join(repositoryRoot, "packages/client/src");
// Exact source lines and occurrence counts keep content exceptions from permitting new UI colors.
const exceptions = JSON.parse(
  readFileSync(new URL("./ui-theme-color-exceptions.json", import.meta.url), "utf8"),
).flatMap(({ path, reason, lines }) =>
  Object.entries(lines).map(([source, count]) => ({
    path,
    reason,
    source,
    colors: Array.from({ length: count }, () => fixedRedMatches(source).map((match) => match.color)).flat(),
  })),
);

function hueIsRed(hue) {
  const degrees = ((hue % 360) + 360) % 360;
  return degrees <= 30 || degrees >= 330;
}

function rgbIsRed(components) {
  const [red, green, blue] = components;
  const maximum = Math.max(...components);
  const minimum = Math.min(...components);
  const delta = maximum - minimum;
  if (!delta) return false;
  const hue =
    maximum === red
      ? 60 * ((green - blue) / delta)
      : maximum === green
        ? 60 * ((blue - red) / delta + 2)
        : 60 * ((red - green) / delta + 4);
  return hueIsRed(hue);
}

function fixedRedMatches(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
  const matches = [];
  const add = (match) => matches.push({ index: match.index, color: match[0] });
  for (const match of text.matchAll(
    /\b(?:bg|text|border(?:-[xysetblr])?|ring(?:-offset)?|outline|from|via|to|fill|stroke|shadow|divide|decoration|accent|caret|placeholder)-(?:red|rose|pink)(?:-\d{2,3})?\b/gu,
  ))
    add(match);
  for (const match of text.matchAll(/#[\da-f]{3,8}\b/giu)) {
    const hex = match[0].slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) continue;
    const rgb =
      hex.length <= 4
        ? [...hex.slice(0, 3)].map((part) => parseInt(part + part, 16))
        : [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
    if (rgbIsRed(rgb)) add(match);
  }
  for (const match of text.matchAll(/\b(rgb|rgba|hsl|hsla|oklch|lch)\(([^()]*)\)/giu)) {
    const values = match[2]
      .replaceAll("_", " ")
      .trim()
      .split(/[\s,\/]+/u);
    if (values.length < 3 || values.slice(0, 3).some((value) => !/^[+-]?[\d.]+(?:%|deg|grad|rad|turn)?$/u.test(value)))
      continue;
    const kind = match[1].toLowerCase();
    const numbers = values
      .slice(0, 3)
      .map((value) => (kind.startsWith("rgb") && value.endsWith("%") ? parseFloat(value) * 2.55 : parseFloat(value)));
    const hueIndex = kind.startsWith("hsl") ? 0 : 2;
    if (values[hueIndex].endsWith("turn")) numbers[hueIndex] *= 360;
    else if (values[hueIndex].endsWith("grad")) numbers[hueIndex] *= 0.9;
    else if (values[hueIndex].endsWith("rad")) numbers[hueIndex] *= 180 / Math.PI;
    const red = kind.startsWith("rgb")
      ? rgbIsRed(numbers)
      : kind.startsWith("hsl")
        ? numbers[1] > 0 && hueIsRed(numbers[0])
        : numbers[1] > 0 && hueIsRed(numbers[2]);
    if (red) add(match);
  }
  for (const match of text.matchAll(
    /(?<=[:\[\s])\s*(?:red|darkred|crimson|firebrick|indianred|lightcoral|salmon|darksalmon|maroon|pink|hotpink|deeppink|lightpink|mistyrose|coral|orangered|tomato|brown)(?=\s*(?:!important\s*)?[;}\]])/giu,
  ))
    add(match);
  return matches;
}

function inspect(path, source) {
  const findings = [];
  const collect = (text, offset) => {
    for (const match of fixedRedMatches(text)) {
      const position = offset + match.index;
      const line = source.slice(0, position).split("\n").length;
      findings.push({ path, line, color: match.color, source: source.split("\n")[line - 1].trim() });
    }
  };
  if (path.endsWith(".css")) collect(source, 0);
  else {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        collect(node.getText(file), node.getStart(file));
        if (
          ts.isStringLiteralLike(node) &&
          /^(?:red|darkred|crimson|firebrick|indianred|lightcoral|salmon|darksalmon|maroon|pink|hotpink|deeppink|lightpink|mistyrose|coral|orangered|tomato|brown)$/iu.test(
            node.text,
          ) &&
          (ts.isPropertyAssignment(node.parent) ||
            ts.isVariableDeclaration(node.parent) ||
            ts.isJsxAttribute(node.parent)) &&
          /(?:color|background|foreground|border|outline|fill|stroke|shadow|caret|accent|surface)$/iu.test(
            node.parent.name.getText(file),
          )
        )
          collect(`color:${node.getText(file).slice(1, -1)};`, node.getStart(file) - 6);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return findings;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:tsx?|css)$/u.test(entry.name) ? [path] : [];
  });
}

assert.equal(inspect("control.tsx", 'const css = "hover:bg-red-500 text-rose-300";').length, 2);
assert.equal(inspect("control.tsx", "const css = `text-${state} border-t-red-500 ring-offset-pink-200`;").length, 2);
assert.equal(inspect("control.css", ".danger { color: #ef4444; background: rgb(255 0 0 / 50%); }").length, 2);
assert.equal(inspect("control.css", ".danger { color: hsl(350 70% 50%); background: oklch(0.7 0.2 20); }").length, 2);
assert.equal(inspect("control.css", ".danger { color: #fef2f2; background: hsl(350deg 70% 50%); }").length, 2);
assert.equal(inspect("control.css", ".danger { color: red; background: pink; }").length, 2);
assert.equal(inspect("control.css", ".danger { border: 1px solid red; box-shadow: 0 0 2px red; }").length, 2);
assert.equal(inspect("control.css", ".danger { color: rgb(100% 128 128); }").length, 1);
assert.equal(inspect("control.tsx", '<svg><path fill="red" stroke="pink" /></svg>;').length, 2);
assert.equal(inspect("control.tsx", 'const style = { color: "red" };').length, 1);
assert.equal(inspect("content.ts", 'const searchTerms = ["red", "red heart"];').length, 0);
assert.equal(inspect("content.ts", 'const emojiLabels = ["man: red hair"];').length, 0);
assert.equal(inspect("control.tsx", 'const css = "text-[var(--destructive)] bg-[var(--primary)]";').length, 0);

const files = sourceFiles(sourceRoot);
assert(files.length > 0, "The theme guard must inspect client source files");
const findings = files.flatMap((file) =>
  inspect(relative(sourceRoot, file).replaceAll("\\", "/"), readFileSync(file, "utf8")),
);
const unexpected = findings.filter(
  (finding) =>
    !exceptions.some(
      (exception) =>
        exception.path === finding.path &&
        exception.source === finding.source &&
        exception.colors.includes(finding.color),
    ),
);
assert.equal(
  unexpected.length,
  0,
  `Fixed red UI colors must use theme tokens:\n${unexpected.map((finding) => `${finding.path}:${finding.line} ${finding.color}\n  ${finding.source}`).join("\n")}`,
);
for (const exception of exceptions) {
  const matches = findings.filter((finding) => finding.path === exception.path && finding.source === exception.source);
  assert.deepEqual(
    matches.map((finding) => finding.color).sort(),
    [...exception.colors].sort(),
    `Update the documented exception if its source changes: ${exception.path}: ${exception.reason}`,
  );
}
console.log(`Theme color guard passed (${findings.length} documented content or palette exceptions).`);
