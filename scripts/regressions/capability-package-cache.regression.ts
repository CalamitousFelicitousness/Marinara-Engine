// ──────────────────────────────────────────────
// Regression: capability-package delivery cache validators (#5082)
// ──────────────────────────────────────────────
// Pins the HTTP caching contract for /api/capability-packages/:id/client and
// /:id/assets/*: a strong ETag derived from the manifest-recorded sha256,
// 304 on a matching If-None-Match, a DIFFERENT validator after an update,
// `no-cache` (never immutable) on the client bundle, and immutable asset
// responses only when the request pins the installed version with ?v=.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-capability-cache-"));
process.env.DATA_DIR = dataDir;

const packagesRoot = join(dataDir, "capability-packages");
const registryPath = join(packagesRoot, "installed.json");

const CLIENT_V1 = "// cache regression client v1\nexport {};\n";
const CLIENT_V2 = "// cache regression client v2 — different bytes\nexport {};\n";
// A 1×1 PNG; the asset route only serves manifest-declared image files.
const ICON = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function writeFixture(version: string, clientSource: string) {
  const versionRoot = join(packagesRoot, "versions", "cache-probe", version);
  mkdirSync(versionRoot, { recursive: true });
  writeFileSync(join(versionRoot, "client.js"), clientSource);
  writeFileSync(join(versionRoot, "icon.png"), ICON);
  const manifest = {
    schemaVersion: 1,
    id: "cache-probe",
    name: "Cache Probe",
    version,
    description: "Capability package cache-validator regression fixture.",
    engine: { min: "2.3.0", maxExclusive: "3.0.0" },
    kind: ["agent"],
    entrypoints: { client: "client.js" },
    contributions: {
      slots: ["home-browser-tab"],
      homeBrowserTab: { label: "Cache Probe", iconPaths: ["icon.png"] },
    },
    files: [
      { path: "client.js", sha256: sha256(clientSource), bytes: Buffer.byteLength(clientSource) },
      { path: "icon.png", sha256: sha256(ICON), bytes: ICON.byteLength },
    ],
    permissions: [],
    restartRequired: false,
  };
  writeFileSync(join(versionRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  const record = {
    id: "cache-probe",
    version,
    manifest,
    installedAt: "2026-08-15T00:00:00.000Z",
    status: "active",
    error: null,
    readiness: "ready",
    readinessError: null,
    legacy: false,
  };
  mkdirSync(packagesRoot, { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, packages: [record] }, null, 2));
  return manifest;
}

async function main() {
  const manifestV1 = writeFixture("1.0.0", CLIENT_V1);

  // fastify is a server-workspace dependency; under pnpm's strict layout it is
  // not resolvable from scripts/, so resolve it from the server package.
  const { createRequire } = await import("node:module");
  const serverRequire = createRequire(
    new URL("../../packages/server/src/routes/capability-packages.routes.ts", import.meta.url),
  );
  const fastify = serverRequire("fastify") as typeof import("fastify").default;
  const { capabilityPackagesRoutes } = await import(
    "../../packages/server/src/routes/capability-packages.routes.js"
  );
  const app = fastify({ logger: false });
  await app.register(capabilityPackagesRoutes, { prefix: "/api/capability-packages" });

  const clientEtag = `"${manifestV1.files[0]!.sha256}"`;
  const iconEtag = `"${manifestV1.files[1]!.sha256}"`;

  // ── /client: 200 with a strong manifest-hash ETag, always-revalidate ──
  const first = await app.inject({ method: "GET", url: "/api/capability-packages/cache-probe/client?v=1.0.0" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers.etag, clientEtag, "client ETag must be the manifest sha256");
  assert.equal(first.headers["cache-control"], "no-cache, must-revalidate", "client bundle must never be immutable");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  assert.equal(first.body, CLIENT_V1);

  // ── /client: matching If-None-Match answers 304 with no body ──
  for (const candidate of [clientEtag, `W/${clientEtag}`, `"other", ${clientEtag}`]) {
    const revalidated = await app.inject({
      method: "GET",
      url: "/api/capability-packages/cache-probe/client?v=1.0.0",
      headers: { "if-none-match": candidate },
    });
    assert.equal(revalidated.statusCode, 304, `304 expected for If-None-Match: ${candidate}`);
    assert.equal(revalidated.body, "");
    assert.equal(revalidated.headers.etag, clientEtag);
  }

  // ── /client: a non-matching validator still gets the full body ──
  const mismatched = await app.inject({
    method: "GET",
    url: "/api/capability-packages/cache-probe/client",
    headers: { "if-none-match": `"${"0".repeat(64)}"` },
  });
  assert.equal(mismatched.statusCode, 200);
  assert.equal(mismatched.body, CLIENT_V1);

  // ── assets: always-revalidate without ?v=, immutable only when ?v= matches ──
  const assetPlain = await app.inject({ method: "GET", url: "/api/capability-packages/cache-probe/assets/icon.png" });
  assert.equal(assetPlain.statusCode, 200);
  assert.equal(assetPlain.headers["cache-control"], "private, no-cache, must-revalidate");
  assert.equal(assetPlain.headers.etag, iconEtag);

  const assetPinned = await app.inject({
    method: "GET",
    url: "/api/capability-packages/cache-probe/assets/icon.png?v=1.0.0",
  });
  assert.equal(assetPinned.statusCode, 200);
  assert.equal(
    assetPinned.headers["cache-control"],
    "public, max-age=31536000, immutable",
    "a version-pinned asset request is content-addressed and may cache forever",
  );

  const assetWrongPin = await app.inject({
    method: "GET",
    url: "/api/capability-packages/cache-probe/assets/icon.png?v=9.9.9",
  });
  assert.equal(assetWrongPin.headers["cache-control"], "private, no-cache, must-revalidate");

  const assetRevalidated = await app.inject({
    method: "GET",
    url: "/api/capability-packages/cache-probe/assets/icon.png",
    headers: { "if-none-match": iconEtag },
  });
  assert.equal(assetRevalidated.statusCode, 304);

  // ── update: new bytes under a new version yield a NEW validator, and the
  //    old validator no longer short-circuits to 304 ──
  const manifestV2 = writeFixture("1.0.1", CLIENT_V2);
  const updatedEtag = `"${manifestV2.files[0]!.sha256}"`;
  assert.notEqual(updatedEtag, clientEtag);
  const afterUpdate = await app.inject({
    method: "GET",
    url: "/api/capability-packages/cache-probe/client?v=1.0.1",
    headers: { "if-none-match": clientEtag },
  });
  assert.equal(afterUpdate.statusCode, 200, "a stale validator must not mask an updated bundle");
  assert.equal(afterUpdate.headers.etag, updatedEtag);
  assert.equal(afterUpdate.body, CLIENT_V2);

  // ── existing failure modes preserved ──
  const unknown = await app.inject({ method: "GET", url: "/api/capability-packages/nope/client" });
  assert.equal(unknown.statusCode, 404);
  const undeclared = await app.inject({
    method: "GET",
    url: "/api/capability-packages/cache-probe/assets/manifest.json",
  });
  assert.equal(undeclared.statusCode, 404, "only declared image assets are servable");

  await app.close();
  console.log("capability-package-cache regression passed");
}

main()
  .then(() => {
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
