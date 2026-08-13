import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeChatMessageCss, scopeChatMessageCss } from "../../packages/client/src/lib/chat-message-css.js";

const importedCss = sanitizeChatMessageCss(`
  @import/* separator */url("https://example.invalid/theme.css");
  @import url("data:text/css;charset=utf-8,a;b");
  .safe { background-image: url("https://example.invalid/image.png"); }
`);
assert.doesNotMatch(importedCss, /@import/iu, "shared-message CSS cannot retain imported stylesheets");
assert.match(
  importedCss,
  /background-image:\s*url\("https:\/\/example\.invalid\/image\.png"\)/u,
  "ordinary HTTPS image styling remains available",
);

const positionedCss = sanitizeChatMessageCss(`
  .indirect { --message-position: fixed; position: var(--message-position); }
  .fixed { position: sticky !important; }
  .safe { position: relative; background-position: fixed; }
`);
assert.match(positionedCss, /\.indirect\s*\{[^}]*position:static/u, "indirect position values are neutralized");
assert.match(
  positionedCss,
  /\.fixed\s*\{[^}]*position:absolute/u,
  "viewport positions remain usable inside the message box",
);
assert.match(positionedCss, /\.safe\s*\{[^}]*position:relative/u, "safe positioning remains available");
assert.match(positionedCss, /background-position:\s*fixed/u, "unrelated position properties are not rewritten");

const quotedComment = sanitizeChatMessageCss('[data-label="/* literal */"] { color: red; }');
assert.match(quotedComment, /"\/\* literal \*\/"/u, "comment-like text inside strings remains intact");

const reconstructedStyleTag = sanitizeChatMessageCss("<sty<style>le>.safe { color: red; }</sty</style>le>");
assert.doesNotMatch(reconstructedStyleTag, /</u, "tag-like text cannot reconstruct an HTML style element");
assert.match(reconstructedStyleTag, /\\3c /u, "literal angle brackets retain their CSS meaning through escaping");

const scopedCss = scopeChatMessageCss(
  '@namespace svg url("https://example.invalid/ns"); .safe { color: red; }',
  ".message-scope",
);
assert.doesNotMatch(scopedCss, /@namespace/iu, "shared-message CSS cannot retain external namespaces");
assert.match(scopedCss, /\.message-scope \.safe\s*\{/u, "ordinary message selectors remain scoped");

const chatMessageSource = readFileSync(
  new URL("../../packages/client/src/components/chat/ChatMessage.tsx", import.meta.url),
  "utf8",
);
assert.match(
  chatMessageSource,
  /relative !overflow-hidden !contain-paint/u,
  "the rendered message box enforces clipping and a fixed-position containing block",
);

console.info("Chat message CSS security regressions passed.");
