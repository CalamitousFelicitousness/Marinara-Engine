import assert from "node:assert/strict";
import { sanitizeAppCss } from "../../packages/client/src/lib/theme-css.js";

const safeTheme = sanitizeAppCss(`
  :root { --background: oklch(0.16 0.02 300); --primary: oklch(0.82 0.09 340); }
  .mari-chat-area { color: var(--primary); background-image: url(data:image/png;base64,AA==); }
  @media (min-width: 48rem) { .mari-chat-area { padding: 1rem; } }
`);
assert.match(safeTheme, /--background:\s*oklch/u, "custom themes can still override application tokens");
assert.match(safeTheme, /url\(data:image\/png;base64,AA==\)/u, "embedded theme images remain available");
assert.match(safeTheme, /@media \(min-width: 48rem\)/u, "ordinary responsive theme CSS remains available");

const externalAsset = sanitizeAppCss(
  '.mari-chat-area { background-image: url("https://example.invalid/tracker.png"); }',
);
assert.doesNotMatch(externalAsset, /example\.invalid/u, "theme CSS cannot make external requests");
assert.match(externalAsset, /url\(about:invalid\)/u, "blocked URLs leave a valid inert declaration");

for (const reconstructingCss of [
  '@imexpression(x)port uexpression(x)rl("https://example.invalid/expression.css"); .safe { color: red; }',
  '@im@import url("https://example.invalid/nested.css");port url("https://example.invalid/outer.css"); .safe { color: red; }',
  '@im@font-face { font-family: Remote; src: url("https://example.invalid/font.woff2"); }port url("https://example.invalid/font.css"); .safe { color: red; }',
  '@im-moz-binding: url("https://example.invalid/binding.xml");port url("https://example.invalid/binding.css"); .safe { color: red; }',
]) {
  const sanitized = sanitizeAppCss(reconstructingCss);
  assert.doesNotMatch(sanitized, /@import\b/iu, "removed syntax cannot concatenate into an import rule");
  assert.doesNotMatch(sanitized, /url\s*\(\s*["']?https?:/iu, "removed syntax cannot expose an external URL");
  assert.match(sanitized, /\.safe\s*\{/u, "safe CSS after rejected syntax remains available");
}

const commentBoundary = sanitizeAppCss(`
  @im/* token separator */port url("https://example.invalid/comment.css");
  [data-label="/* literal text */"] { color: rebeccapurple; }
`);
assert.doesNotMatch(commentBoundary, /@import\b/iu, "CSS comments retain their token boundary");
assert.match(commentBoundary, /"\/\* literal text \*\/"/u, "comment-like text inside strings remains intact");

const unterminatedImport = sanitizeAppCss('@import url("https://example.invalid/no-semicolon.css")');
assert.doesNotMatch(unterminatedImport, /@import|example\.invalid/iu, "an import at end-of-input is rejected");

console.info("Theme CSS security regressions passed.");
