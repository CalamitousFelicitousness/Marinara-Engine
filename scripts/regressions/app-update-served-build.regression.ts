/**
 * A waiting service worker prompts a refresh only when the page runs a build the server no longer
 * serves: a page loaded after a restart already runs the new build (playtest 2026-10-23).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { formatRuntimeBuild, runningBuildIsServed } from "../../packages/client/src/lib/runtime-build.js";

const client = formatRuntimeBuild("2.4.6", "abc1234");
const answer =
  (body: unknown, ok = true) =>
  async () =>
    ({ ok, json: async () => body }) as Response;

assert.equal(await runningBuildIsServed("2.4.6", client, answer({ version: "2.4.6", build: client })), true);
assert.equal(
  await runningBuildIsServed("2.4.6", client, answer({ version: "2.4.6", build: "2.4.6+def5678" })),
  false,
  "a newer build is served",
);
assert.equal(await runningBuildIsServed("2.4.6", client, answer({ status: "ok" })), false, "unknown prompts");
assert.equal(await runningBuildIsServed("2.4.6", client, answer({}, false)), false, "no answer prompts");
assert.equal(
  await runningBuildIsServed("2.4.6", client, async () => {
    throw new TypeError("Failed to fetch");
  }),
  false,
);
// A server that takes the connection and never answers reads as unknown once the probe gives up.
assert.equal(
  await runningBuildIsServed(
    "2.4.6",
    client,
    (_input, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
      ),
    20,
  ),
  false,
  "a silent server prompts",
);
// The quiet takeover must not reload. vite-plugin-pwa's prompt mode ignores updateSW's reloadPage argument and calls
// onNeedReload (or reloads itself) whenever a new worker takes control, so main.tsx gates the reload on the prompt.
const pluginRequire = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const register = readFileSync(
  join(dirname(pluginRequire.resolve("vite-plugin-pwa/package.json")), "dist/client/build/register.js"),
  "utf8",
);
assert.match(register, /const updateServiceWorker = async \(_reloadPage = true\)/u, "the plugin ignores reloadPage");
assert.match(register, /if \(onNeedReload\)\s*onNeedReload\(\);\s*else\s*window\.location\.reload\(\);/u);
const main = readFileSync(new URL("../../packages/client/src/main.tsx", import.meta.url), "utf8");
assert.match(main, /onNeedReload\(\) \{\s*if \(reloadOnTakeover\) window\.location\.reload\(\);/u);
assert.match(main, /reloadOnTakeover = true;\s*return updateSW\(true\);/u, "only an accepted prompt reloads");
console.info("App update: a waiting worker prompts only when the server serves another build.");
