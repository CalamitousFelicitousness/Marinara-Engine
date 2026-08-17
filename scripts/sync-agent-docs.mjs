// ──────────────────────────────────────────────
// Agent Doc Sync — CLAUDE.md is the source of truth
// ──────────────────────────────────────────────
//
// AGENTS.md is generated from the shared body of CLAUDE.md (everything from the
// first `## ` heading onward) spliced into the Codex overlay. One hand-edited
// file means a rule added for one agent cannot silently go missing for the
// other, and `pnpm agent-docs:check` inside `pnpm check` turns drift into a
// build failure instead of something a reviewer has to notice.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "CLAUDE.md");
const OVERLAY = resolve(ROOT, ".github/agents/codex-overlay.md");
const TARGET = resolve(ROOT, "AGENTS.md");
const SPLICE_MARKER = "<!-- SHARED BODY -->";

const checkOnly = process.argv.includes("--check");

// Phrases rewritten when the shared body is emitted into AGENTS.md.
const SUBSTITUTIONS = [["Add Claude-specific notes here", "Add Codex-specific notes here"]];

// "Claude" spellings that name a file or a product rather than the agent
// reading the doc, so they must survive into AGENTS.md untouched.
const PRESERVED_SPELLINGS = [
  "CLAUDE.md",
  "Claude Code",
  "Claude/Grok subscription",
  "Claude (Subscription)",
  "claude-agent-sdk",
];

const BANNER = [
  "<!-- GENERATED FILE — DO NOT EDIT. -->",
  "<!-- Source: CLAUDE.md (shared body) + .github/agents/codex-overlay.md (Codex-specific parts). -->",
  "<!-- Regenerate with `pnpm agent-docs:sync`. `pnpm agent-docs:check` fails on drift. -->",
];

function fail(message) {
  process.stderr.write(`[agent-docs] ${message}\n`);
  process.exit(1);
}

function readOrFail(path, label) {
  if (!existsSync(path)) {
    fail(`Missing ${label} at ${relative(ROOT, path)}.`);
  }
  return readFileSync(path, "utf8");
}

/** Everything from the first `## ` heading onward: the part both agents share. */
function sharedBody(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("## "));
  if (start === -1) {
    fail("CLAUDE.md has no `## ` heading, so there is no shared body to copy.");
  }
  return lines.slice(start).join("\n").trimEnd();
}

function applySubstitutions(body) {
  let result = body;
  for (const [from, to] of SUBSTITUTIONS) {
    result = result.split(from).join(to);
  }
  return result;
}

/**
 * Guard against a blind rename. Every remaining "Claude" in the shared body is
 * either a preserved spelling (a filename or product name) or an agent
 * reference that still needs a substitution — the latter would otherwise ship
 * to Codex telling it that it is Claude.
 */
function assertNoUntranslatedClaude(body) {
  let scrubbed = body;
  for (const allowed of PRESERVED_SPELLINGS) {
    scrubbed = scrubbed.split(allowed).join("");
  }

  const offenders = scrubbed.split(/\r?\n/).filter((line) => /claude/i.test(line));
  if (offenders.length === 0) {
    return;
  }

  process.stderr.write("[agent-docs] Untranslated Claude reference in the shared body of CLAUDE.md:\n");
  for (const line of offenders) {
    process.stderr.write(`  ${line.trim()}\n`);
  }
  fail(
    "Add the phrase to SUBSTITUTIONS (an agent reference to rewrite) or PRESERVED_SPELLINGS (a filename or product name) in scripts/sync-agent-docs.mjs.",
  );
}

function render() {
  const overlay = readOrFail(OVERLAY, "Codex overlay");
  if (!overlay.includes(SPLICE_MARKER)) {
    fail(`Codex overlay is missing its ${SPLICE_MARKER} marker.`);
  }

  const body = applySubstitutions(sharedBody(readOrFail(SOURCE, "CLAUDE.md")));
  assertNoUntranslatedClaude(body);

  // Function replacement keeps `$` sequences in the docs from being read as
  // replacement patterns.
  const merged = overlay.split(/\r?\n/).join("\n").replace(SPLICE_MARKER, () => body);
  return `${[...BANNER, "", merged.trimEnd()].join("\n")}\n`;
}

/** Compare without line-ending noise: CI checks out LF, Windows dev gets CRLF. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

function withEol(text, useCrlf) {
  const normalized = text.replace(/\r\n/g, "\n");
  return useCrlf ? normalized.replace(/\n/g, "\r\n") : normalized;
}

const expected = render();

if (checkOnly) {
  if (!existsSync(TARGET)) {
    fail("AGENTS.md is missing. Run `pnpm agent-docs:sync`.");
  }
  if (normalize(readFileSync(TARGET, "utf8")) !== normalize(expected)) {
    fail("AGENTS.md is out of sync with CLAUDE.md. Run `pnpm agent-docs:sync` and commit the result.");
  }
  process.stdout.write("[agent-docs] AGENTS.md matches CLAUDE.md.\n");
  process.exit(0);
}

// Preserve the working tree's line-ending style so a Windows checkout does not
// churn the file on every sync.
const existing = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
const output = withEol(expected, existing ? /\r\n/.test(existing) : /\r\n/.test(readFileSync(SOURCE, "utf8")));

if (existing === output) {
  process.stdout.write("[agent-docs] AGENTS.md already up to date.\n");
  process.exit(0);
}

writeFileSync(TARGET, output);
process.stdout.write("[agent-docs] Wrote AGENTS.md from CLAUDE.md.\n");
