// The sandbox launcher starts only scrubber output that lies clear of the real install, and it
// exports the storage location, because the repo .env's FILE_STORAGE_DIR beats DATA_DIR and a
// second server on the real storage takes the running one over.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSandboxProblems, sandboxEnvironment } from "../../run-sandbox.mjs";
import { SANDBOX_MARKER, findOutputProblems, foldersOverlap, resolveRealInstall } from "../../sandbox-paths.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "marinara-sandbox-lane-"));
try {
  const realData = path.join(root, "real", "data");
  const realStorage = path.join(root, "elsewhere", "storage");
  const realEnv = path.join(root, "real.env");
  for (const dir of [realData, realStorage]) fs.mkdirSync(dir, { recursive: true });
  // Single quotes keep a Windows path's backslashes literal.
  fs.writeFileSync(realEnv, `PORT=7870\nVITE_PORT=7871\nDATA_DIR='${realData}'\nFILE_STORAGE_DIR='${realStorage}'\n`);

  const real = resolveRealInstall(realEnv);
  assert.equal(real.dataDir, realData);
  assert.equal(real.storageDir, realStorage, "FILE_STORAGE_DIR wins over DATA_DIR/storage, as in runtime-config.ts");
  assert.equal(real.port, 7870);
  assert.equal(resolveRealInstall(path.join(root, "missing.env")).port, 7860, "no .env means the server defaults");

  const sandbox = path.join(root, "sandbox");
  const sandboxEnv = path.join(root, "sandbox.env");
  fs.mkdirSync(path.join(sandbox, "storage"), { recursive: true });
  const problems = (overrides = {}) =>
    findSandboxProblems({ dataDir: sandbox, envFile: sandboxEnv, real, ...overrides }).join("\n");

  assert.match(problems(), /has no \.sandbox-data\.json/u, "a folder the scrubber did not finish never starts");
  fs.writeFileSync(path.join(sandbox, SANDBOX_MARKER), "{}\n");
  assert.equal(problems(), "", "marked data beside the real install starts");

  // A marker does not make real folders a sandbox.
  fs.writeFileSync(path.join(realData, SANDBOX_MARKER), "{}\n");
  assert.match(problems({ dataDir: realData }), /overlaps the real install's data folder/u);
  assert.match(problems({ dataDir: path.dirname(realStorage) }), /overlaps the real install's storage folder/u);
  assert.match(problems({ envFile: realEnv }), /is the real install's \.env/u);

  // The env file may not point storage somewhere else, by either name.
  for (const key of ["DATA_DIR", "FILE_STORAGE_DIR", "MARINARA_FILE_STORAGE_DIR"]) {
    fs.writeFileSync(sandboxEnv, `${key}='${realStorage}'\n`);
    assert.match(problems(), new RegExp(`sets ${key} to a folder other than the sandbox's`, "u"));
  }
  fs.writeFileSync(sandboxEnv, `DATA_DIR='${sandbox}'\nFILE_STORAGE_DIR='${path.join(sandbox, "storage")}'\n`);
  assert.equal(problems(), "", "an env file that names the sandbox's own folders is consistent");
  fs.writeFileSync(sandboxEnv, "PORT=7870\n");
  assert.match(problems(), /port 7870 belongs to the real install/u);
  fs.writeFileSync(sandboxEnv, "PORT=7900\nVITE_PORT=7900\n");
  assert.match(problems(), /share one port/u);
  fs.rmSync(sandboxEnv);

  // What the server is started with: the ambient shell cannot redirect storage or lend the real key.
  const env = sandboxEnvironment({
    dataDir: sandbox,
    envFile: sandboxEnv,
    ports: { server: 7880, client: 7881 },
    ambient: {
      DATA_DIR: realData,
      FILE_STORAGE_DIR: realStorage,
      MARINARA_FILE_STORAGE_DIR: realStorage,
      ENCRYPTION_KEY: "real",
      ADMIN_SECRET: "real",
      HOST: "0.0.0.0",
      PATH: "kept",
    },
  });
  assert.equal(env.DATA_DIR, sandbox);
  assert.equal(env.FILE_STORAGE_DIR, path.join(sandbox, "storage"));
  assert.equal(env.MARINARA_ENV_FILE, sandboxEnv);
  assert.equal(env.PORT, "7880");
  assert.equal(env.VITE_PORT, "7881");
  assert.equal(env.HOST, "127.0.0.1", "the sandbox listens on loopback only");
  assert.match(env.CORS_ORIGINS, /127\.0\.0\.1:7881/u);
  for (const key of ["MARINARA_FILE_STORAGE_DIR", "ENCRYPTION_KEY", "ADMIN_SECRET"]) assert.equal(key in env, false);
  assert.equal(env.PATH, "kept");

  // The scrubber deletes --to before writing, so it only replaces its own earlier output.
  const output = (overrides) => findOutputProblems({ from: realData, to: sandbox, real, ...overrides }).join("\n");
  assert.match(output({ force: false }), /not empty/u);
  assert.equal(output({ force: true }), "", "a marked sandbox is replaced");
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, "keep.txt"), "x");
  assert.match(output({ to: plain, force: true }), /--force will not delete it/u);
  assert.equal(output({ to: path.join(root, "new"), force: false }), "", "a new folder needs no --force");
  assert.match(output({ to: realData, force: true }), /overlaps the real install's data folder/u);
  assert.match(output({ to: realStorage, force: true }), /overlaps the real install's storage folder/u);
  assert.match(output({ to: path.join(realData, "inner"), force: true }), /overlaps its own source/u);

  assert.equal(foldersOverlap(path.join(root, "sandbox-2"), sandbox), false, "a shared name prefix is not overlap");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("sandbox-launcher regression passed.");
