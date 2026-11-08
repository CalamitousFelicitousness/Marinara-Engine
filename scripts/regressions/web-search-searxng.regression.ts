// The web_search tool queries a SearXNG instance's JSON API when one is configured, in Settings or as SEARXNG_URL.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The saved setting sits beside the active .env, so point that at a scratch directory before the config loads.
const scratch = mkdtempSync(join(tmpdir(), "marinara-web-search-"));
process.env.MARINARA_ENV_FILE = join(scratch, ".env");
delete process.env.SEARXNG_URL;
const { getWebSearchSettings, saveWebSearchSettings } =
  await import("../../packages/server/src/config/runtime-config.js");
const { executeToolCalls, testWebSearch } = await import("../../packages/server/src/services/tools/tool-executor.js");

const requests: string[] = [];
const authHeaders: Array<string | undefined> = [];
let status = 200;
const server = createServer((req, res) => {
  requests.push(req.url ?? "");
  authHeaders.push(req.headers.authorization);
  if (status !== 200) {
    res.writeHead(status, { "Content-Type": "text/html" }).end("Forbidden");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      query: "marinara",
      results: [
        { title: "  Marinara\n sauce ", url: "https://example.com/a", content: "A tomato\nsauce.", engine: "ddg" },
        { title: "Duplicate", url: "https://example.com/a", content: "same url", engine: "brave" },
        { title: "Not a web link", url: "javascript:alert(1)", content: "", engine: "x" },
        { title: "", url: "https://example.com/untitled", content: "", engine: "x" },
        { title: "Second", url: "http://example.org/b", engine: "x" },
        { title: "Third", url: "https://example.net/c", content: "c", engine: "x" },
      ],
      answers: [],
      suggestions: [],
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const instance = `http://127.0.0.1:${port}`;

async function search(args: Record<string, unknown>) {
  const [outcome] = await executeToolCalls([
    { id: "c1", type: "function", function: { name: "web_search", arguments: JSON.stringify(args) } },
  ]);
  return JSON.parse(outcome?.result ?? "{}") as Record<string, any>;
}

try {
  // SEARXNG_URL applies until a value is saved in Settings. A base path and trailing slash keep the instance root.
  process.env.SEARXNG_URL = `${instance}/searx/`;
  const found = await search({ query: "marinara", limit: 2 });
  assert.equal(found.source, "SearXNG");
  assert.deepEqual(found.results, [
    { title: "Marinara sauce", url: "https://example.com/a", snippet: "A tomato sauce." },
    { title: "Second", url: "http://example.org/b", snippet: "" },
  ]);
  assert.equal(found.count, 2, "limit counts kept results, after dropping duplicates and non-web links");
  const sent = new URL(requests.at(-1)!, "http://x");
  assert.equal(sent.pathname, "/searx/search");
  assert.equal(sent.searchParams.get("q"), "marinara");
  assert.equal(sent.searchParams.get("format"), "json");

  assert.deepEqual(getWebSearchSettings(), { provider: "searxng", searxngUrl: `${instance}/searx` });

  // A saved choice wins over SEARXNG_URL. Choosing DuckDuckGo keeps the address for switching back.
  assert.deepEqual(saveWebSearchSettings({ provider: "searxng", searxngUrl: `${instance}/` }), {
    provider: "searxng",
    searxngUrl: instance,
  });
  await search({ query: "saved" });
  assert.equal(new URL(requests.at(-1)!, "http://x").pathname, "/search");
  saveWebSearchSettings({ provider: "duckduckgo", searxngUrl: instance });
  assert.deepEqual(getWebSearchSettings(), { provider: "duckduckgo", searxngUrl: instance });
  assert.throws(() => saveWebSearchSettings({ provider: "searxng", searxngUrl: null }), /needs an address/u);
  assert.throws(
    () => saveWebSearchSettings({ provider: "searxng", searxngUrl: "ftp://127.0.0.1/" }),
    /http:\/\/ or https:\/\//u,
  );

  // Test searches with the values it is given, whatever is saved.
  const before = requests.length;
  assert.deepEqual(await testWebSearch({ provider: "searxng", searxngUrl: instance }), { ok: true, count: 3 });
  assert.equal(requests.length, before + 1, "the test reached the unsaved instance");
  assert.equal(authHeaders.at(-1), undefined, "no credentials, no Authorization header");

  // Credentials in the address travel as Basic auth, and no error text the model sees repeats them.
  const secret = "s3cr%40t";
  saveWebSearchSettings({ provider: "searxng", searxngUrl: `http://amy:${secret}@127.0.0.1:${port}` });
  assert.equal((await search({ query: "marinara" })).count, 3);
  assert.equal(authHeaders.at(-1), `Basic ${Buffer.from("amy:s3cr@t").toString("base64")}`);

  // A local address follows the connection base-URL switch.
  process.env.PROVIDER_LOCAL_URLS_ENABLED = "false";
  const blocked = await search({ query: "marinara" });
  assert.match(blocked.error, /PROVIDER_LOCAL_URLS_ENABLED/u);
  assert.ok(!blocked.error.includes("s3cr"), "a refused address is reported without its password");
  delete process.env.PROVIDER_LOCAL_URLS_ENABLED;
  saveWebSearchSettings({ provider: "searxng", searxngUrl: instance });

  // An instance without json in search.formats answers 403; the error says what to change.
  status = 403;
  const refused = await search({ query: "marinara" });
  assert.deepEqual(refused.results, []);
  assert.match(refused.error, /SearXNG search failed \(403\).*search\.formats/u);
  const failedTest = await testWebSearch({ provider: "searxng", searxngUrl: instance });
  assert.equal(failedTest.ok, false);
  assert.match(failedTest.error ?? "", /search\.formats/u);

  // A 200 that is not JSON (a reverse proxy's login page, say) is reported, not parsed.
  status = 200;
  const html = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>"));
  await new Promise<void>((resolve) => html.listen(0, "127.0.0.1", resolve));
  saveWebSearchSettings({
    provider: "searxng",
    searxngUrl: `http://amy:hunter2@127.0.0.1:${(html.address() as AddressInfo).port}`,
  });
  const notJson = await search({ query: "marinara" });
  await new Promise((resolve) => html.close(resolve));
  assert.match(notJson.error, /did not answer with SearXNG JSON/u);
  assert.ok(!notJson.error.includes("hunter2"), "the not-JSON error names the instance without its password");
} finally {
  delete process.env.SEARXNG_URL;
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}

console.log("web-search-searxng regression passed.");
