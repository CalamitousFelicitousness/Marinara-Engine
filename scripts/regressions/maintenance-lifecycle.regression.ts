import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rememberBoundedSetValue } from "../../packages/client/src/lib/bounded-set.js";
import playwrightConfig from "../../playwright.config.js";

const boundedValues = new Set(["first", "second"]);
rememberBoundedSetValue(boundedValues, "third", 2);
assert.deepEqual([...boundedValues], ["second", "third"]);

rememberBoundedSetValue(boundedValues, "second", 2);
assert.deepEqual([...boundedValues], ["third", "second"]);

const playwrightWebServer = Array.isArray(playwrightConfig.webServer)
  ? playwrightConfig.webServer[0]
  : playwrightConfig.webServer;
assert.deepEqual(playwrightWebServer?.gracefulShutdown, { signal: "SIGTERM", timeout: 10_000 });

const generateRouteSource = readFileSync(
  new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(generateRouteSource, /encryptedReasoningCache/u);
assert.match(
  generateRouteSource,
  /commandOnly: true,[\s\S]*?encryptedReasoning: encryptedReasoningItems\?\.length[\s\S]*?return \{/u,
);
