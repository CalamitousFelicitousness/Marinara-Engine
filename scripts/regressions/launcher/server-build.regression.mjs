import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// #6984: one built server file damaged after its build stopped every start, and rebuilds kept the damage.
// A one-module copy of the server package runs through the real launcher, build and metadata scripts.
// It lives under the ignored .tmp folder so the build resolves the repository's TypeScript.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
mkdirSync(join(repo, ".tmp"), { recursive: true });
const root = mkdtempSync(join(repo, ".tmp", "server-build-regression-"));
const server = join(root, "packages", "server");
const put = (file, content) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};
const read = (file) => readFileSync(join(server, file), "utf8");
const damage = (file) => writeFileSync(join(server, file), "if(, raw) { }\n"); // the line from the report
const build = () => spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: server, encoding: "utf8" });
const start = (entry = "dist/index.js") =>
  spawnSync(process.execPath, ["../../scripts/run-server.mjs", entry], { cwd: server, encoding: "utf8" });
const assertBuilt = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

try {
  for (const file of [
    "scripts/run-server.mjs",
    "packages/server/scripts/build.mjs",
    "packages/server/scripts/write-build-meta.mjs",
  ]) {
    put(file, readFileSync(join(repo, file)));
  }
  put("packages/server/package.json", '{ "type": "module" }\n');
  put(
    "packages/server/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        composite: true,
        outDir: "dist",
        rootDir: "src",
        module: "NodeNext",
        target: "ES2022",
        types: [],
      },
      include: ["src/**/*.ts"],
    }),
  );
  put("packages/server/src/db/default-preset.json", "{}\n");
  put("packages/server/src/runtime.ts", "export const ready = (raw: string) => `${raw} started`;\n");
  put("packages/server/src/index.ts", 'import { ready } from "./runtime.js";\nconsole.log(ready("fixture server"));\n');

  assertBuilt(build());
  const runtime = read("dist/runtime.js");
  const entry = read("dist/index.js");

  // The launchers' start: a damaged module is rebuilt, named in the terminal, and the server starts.
  damage("dist/runtime.js");
  let result = start();
  assertBuilt(result);
  assert.match(result.stderr, /\[WARN\].*dist\/runtime\.js/);
  assert.match(result.stdout, /fixture server started/);
  assert.equal(read("dist/runtime.js"), runtime);

  // The Windows installer and in-app updates rebuild without cleaning first. That rebuild must
  // rewrite a damaged file and a deleted one instead of trusting tsc's saved state.
  damage("dist/runtime.js");
  rmSync(join(server, "dist", "index.js"));
  assertBuilt(build());
  assert.equal(read("dist/runtime.js"), runtime);
  assert.equal(read("dist/index.js"), entry);

  // A private build that another tool starts is left alone.
  cpSync(join(server, "dist"), join(server, "dist-private"), { recursive: true });
  damage("dist-private/runtime.js");
  result = start("dist-private/index.js");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError/);
  assert.doesNotMatch(result.stderr, /\[WARN\]/);

  // A build from before hashes were recorded (the reported install) cannot be checked at start,
  // so it starts as before; the next build, such as an update's, writes every file again.
  writeFileSync(join(server, "dist", "config", "build-meta.json"), '{ "commit": null }\n');
  damage("dist/runtime.js");
  result = start();
  assert.match(result.stderr, /SyntaxError/);
  assert.doesNotMatch(result.stderr, /\[WARN\]/);
  assertBuilt(build());
  assert.equal(read("dist/runtime.js"), runtime);
  assertBuilt(start());

  console.info("Damaged server build repair regression passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
  try {
    rmdirSync(join(repo, ".tmp")); // only when nothing else is in it
  } catch {}
}
