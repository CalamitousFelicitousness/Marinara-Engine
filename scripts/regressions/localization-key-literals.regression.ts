import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Every catalog-shaped string literal in client code must resolve to a key in en.json.
//
// localization-key-references checks only the literal right after `localizeUi(`. A key chosen by a
// ternary, passed through `t(`, or held in a constant slips past it and renders as raw text. This
// matches any quoted literal of three or more dot-separated segments whose first segment is one of
// en.json's namespaces, after stripping comments, which name metadata paths in the same shape.

const repoRoot = join(import.meta.dirname, "..", "..");
const en = JSON.parse(
  readFileSync(join(repoRoot, "packages/client/src/localization/locales/en.json"), "utf8"),
) as Record<string, unknown>;
const keys = new Set(Object.keys(en));
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/u;
const pluralBases = new Set(
  [...keys].flatMap((key) => (PLURAL_SUFFIX.test(key) ? [key.replace(PLURAL_SUFFIX, "")] : [])),
);
const namespaces = new Set([...keys].map((key) => key.split(".")[0]));

const KEY_LITERAL = /["'`]([a-zA-Z][\w-]*(?:\.[\w-]+){2,})["'`]/gu;
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*/gu;

export function findMissingKeys(source: string): string[] {
  const code = source.replace(COMMENT, "");
  return [...code.matchAll(KEY_LITERAL)]
    .map((match) => match[1]!)
    .filter((key) => namespaces.has(key.split(".")[0]!) && !keys.has(key) && !pluralBases.has(key));
}

// Guard the guard: it must see keys the other lane cannot, and not read comments.
assert.deepEqual(findMissingKeys('localizeUi(busy ? "ui.missing.ternaryKey" : "ui.missing.otherKey")'), [
  "ui.missing.ternaryKey",
  "ui.missing.otherKey",
]);
assert.deepEqual(findMissingKeys('title={t("chat.missing.viaT")}'), ["chat.missing.viaT"]);
assert.deepEqual(findMissingKeys("// lives in `chat.metadata.windowLayout`\n/* `chat.metadata.gameRuleset` */"), []);
assert.deepEqual(findMissingKeys('const url = "https://example.com/a.b.c";'), []);

const files = execFileSync("git", ["ls-files", "packages/client/src"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.tsx?$/u.test(file));

const missing: string[] = [];
for (const file of files) {
  let source: string;
  try {
    source = readFileSync(join(repoRoot, file), "utf8");
  } catch {
    continue; // deleted-but-tracked during a rename
  }
  for (const key of findMissingKeys(source)) missing.push(`${key}  (${file})`);
}

assert.deepEqual(missing, [], `${missing.length} key literals do not exist in en.json:\n${missing.join("\n")}`);

process.stdout.write("Localization key-literal regression passed.\n");
