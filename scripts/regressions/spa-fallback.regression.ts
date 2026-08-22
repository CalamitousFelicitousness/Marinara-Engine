// SPA fallback must not answer asset requests with the app shell.
//
// @fastify/static is registered with `wildcard: false`, so it enumerates dist at
// registration time. Any file written afterwards -- a launcher auto-update, or a
// rebuild under a running server -- has no route and reaches the not-found
// handler. That handler used to return index.html for everything outside /api/,
// so a hashed chunk request got 200 + text/html and the browser reported
// "Expected a JavaScript-or-Wasm module script but the server responded with a
// MIME type of text/html" -- which reads as a broken app rather than a stale tab.
//
// A 404 is the truth, and it is what lets the client's vite:preloadError
// recovery (lib/browser-runtime.ts) clear the service worker and reload.

import assert from "node:assert/strict";

import { isNonSpaRequest } from "../../packages/server/src/config/client-static-config.js";

// ── Asset requests are never navigations ──
assert.equal(isNonSpaRequest("/assets/index-JO7zOKHI.js"), true);
assert.equal(isNonSpaRequest("/assets/AppShell-DyRlQ_PW.js"), true);
assert.equal(isNonSpaRequest("/assets/index-CXsg8H6_.css"), true);
assert.equal(isNonSpaRequest("/assets/font.woff2"), true);
// Query strings and fragments do not smuggle an asset past the check.
assert.equal(isNonSpaRequest("/assets/chunk.js?v=2"), true);

// ── API requests keep their existing JSON 404 ──
assert.equal(isNonSpaRequest("/api/chats"), true);
assert.equal(isNonSpaRequest("/api/health"), true);

// ── Real navigations still get the shell ──
// The app has no URL router, but deep links and reloads land on paths like these.
for (const navigation of ["/", "/marinara/home", "/settings", "/chat/abc123"]) {
  assert.equal(isNonSpaRequest(navigation), false, `${navigation} must still serve the SPA shell`);
}

// Root-level PWA files are enumerated by @fastify/static and never reach the
// handler; if one ever does, the shell is a better answer than a 404.
assert.equal(isNonSpaRequest("/manifest.json"), false);
assert.equal(isNonSpaRequest("/sw.js"), false);

// ── Near misses must not be over-matched ──
// A route that merely starts with the same letters is a navigation.
assert.equal(isNonSpaRequest("/assets"), false, "no trailing slash is not an asset path");
assert.equal(isNonSpaRequest("/assetsmanager"), false);
assert.equal(isNonSpaRequest("/apidocs"), false);

// ── Missing or non-string urls fall through to the shell ──
assert.equal(isNonSpaRequest(undefined), false);
assert.equal(isNonSpaRequest(null), false);
assert.equal(isNonSpaRequest(""), false);

console.log("spa-fallback regression passed.");
