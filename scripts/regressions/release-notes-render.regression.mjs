import assert from "node:assert/strict";
import { RELEASE_BODY_LIMIT, renderReleaseNotes } from "../render-release-notes.mjs";

const changelog = (entries) =>
  `# Changelog\n\n## [Unreleased]\n\n## [9.9.9]\n\n${entries.join("\n\n")}\n\n## [9.9.8]\n\n- Older entry.\n`;

// Short notes are unchanged: the Android notice plus the whole entry.
const short = renderReleaseNotes(changelog(["- First change.", "- Second change."]), "9.9.9");
assert.match(short, /Android APK notice/u);
assert.match(short, /- First change\.\n\n- Second change\.\n$/u);
assert.doesNotMatch(short, /more changes/u);
assert.doesNotMatch(short, /Older entry/u);

// A release too long for GitHub is cut at a whole bullet and links the full list at the tag.
const entries = Array.from(
  { length: 900 },
  (_, i) => `- Change ${i + 1}: ${"x".repeat(200)}\n  - detail line ${i + 1}`,
);
const long = renderReleaseNotes(changelog(entries), "9.9.9");
assert.ok(long.length <= RELEASE_BODY_LIMIT, `body is ${long.length} characters`);
assert.match(long, /^> \[!IMPORTANT\]/u);
assert.match(long, /- Change 1: x+\n  - detail line 1\n/u);
const kept = long.match(/^- Change \d+:/gmu).length;
assert.ok(kept > 100 && kept < 900);
assert.match(
  long,
  new RegExp(
    `_…and ${900 - kept} more changes\\. The complete list is in \\[CHANGELOG\\.md\\]\\(https://github\\.com/Pasta-Devs/Marinara-Engine/blob/v9\\.9\\.9/CHANGELOG\\.md\\)\\._\\n$`,
    "u",
  ),
);
// The last kept bullet is complete, including its nested detail line.
assert.match(long, new RegExp(`- Change ${kept}: x+\\n  - detail line ${kept}\\n\\n_…and`, "u"));

// The real changelog's newest release renders within the limit.
const { readFile } = await import("node:fs/promises");
const real = await readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
const version = real.match(/^## \[(\d+\.\d+\.\d+)\]/mu)?.[1];
if (version) assert.ok(renderReleaseNotes(real, version).length <= RELEASE_BODY_LIMIT);

console.log("release-notes-render regression passed");
