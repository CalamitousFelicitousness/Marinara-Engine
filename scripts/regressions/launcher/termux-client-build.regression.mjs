import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkClientBuild } from "../../check-client-build.mjs";
import { resolveClientBuildHeapMb, splitNodeOptions } from "../../../packages/client/scripts/build-heap.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The client build no longer fits in the 1 GiB heap Termux gives the server: give it 1536 MiB,
// capped at half of device memory, but never less than the 1280 MiB it needs.
const GiB = 1024 ** 3;
const buildHeap = (totalMemoryBytes, env = {}, lowMemory = true) =>
  resolveClientBuildHeapMb({ lowMemory, env, totalMemoryBytes, constrainedMemoryBytes: 0 });
assert.equal(buildHeap(8 * GiB), 1536);
assert.equal(buildHeap(3 * GiB), 1536);
assert.equal(buildHeap(2.75 * GiB), 1408);
assert.equal(buildHeap(2 * GiB), 1280, "a 2 GB phone still gets the heap the build needs");
assert.equal(buildHeap(8 * GiB, { MARINARA_EXPLICIT_NODE_HEAP: "1" }), null, "a heap the user set wins");
// Desktop builds also generate the PWA, which needs 1536 MiB; Node's default is lower on small machines.
assert.equal(buildHeap(8 * GiB, {}, false), 2048);
assert.equal(buildHeap(2 * GiB, {}, false), 1536, "a small desktop still gets the heap the build needs");
for (const NODE_OPTIONS of [
  "--max-old-space-size=4096",
  "--trace-warnings --max_old_space_size=1024",
  '"--max-old-space-size=1024"',
  "--max-old-space-size-percentage=50",
  "--require ./x.cjs --max-old-space-size 1800",
]) {
  assert.equal(
    buildHeap(8 * GiB, { NODE_OPTIONS }, false),
    null,
    `a desktop heap in NODE_OPTIONS is the user's: ${NODE_OPTIONS}`,
  );
}
assert.equal(
  buildHeap(8 * GiB, { NODE_OPTIONS: '--require "./hooks/--max-old-space-size.cjs"' }, false),
  2048,
  "the same words inside another option's value are not a heap",
);
// In a container, half of its memory limit, not of the machine's.
const containerHeap = (constrainedMemoryBytes) =>
  resolveClientBuildHeapMb({ lowMemory: false, env: {}, totalMemoryBytes: 32 * GiB, constrainedMemoryBytes });
assert.equal(containerHeap(3.5 * GiB), 1792);
assert.equal(containerHeap(8 * GiB), 2048);
assert.equal(containerHeap(2 ** 62), 2048, "a limit above the machine's memory is no limit");
// NODE_OPTIONS read as Node reads it: quotes group an option, spaces included, and a backslash inside
// them keeps the next character.
assert.deepEqual(splitNodeOptions('--require "./my hooks/x.cjs"  --max-old-space-size=900'), [
  "--require",
  "./my hooks/x.cjs",
  "--max-old-space-size=900",
]);
assert.deepEqual(splitNodeOptions('"--title=a \\"b\\""'), ['--title=a "b"']);
assert.deepEqual(splitNodeOptions('  ""  '), [""], "an empty quoted option is still one");
assert.deepEqual(splitNodeOptions(""), []);

const fixture = mkdtempSync(join(tmpdir(), "marinara-termux-build-"));
const write = (path, content) => {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), content);
};
// What V8 reports for a given limit, to compare with the heap the fixture's Vite ran under.
const heapLimitFor = (mb) =>
  spawnSync(
    process.execPath,
    [`--max-old-space-size=${mb}`, "-p", 'require("node:v8").getHeapStatistics().heap_size_limit'],
    { encoding: "utf8" },
  ).stdout.trim();
try {
  write("package.json", '{"type":"module"}');
  for (const script of ["build.mjs", "build-heap.mjs"]) {
    write(`scripts/${script}`, readFileSync(join(repositoryRoot, "packages/client/scripts", script), "utf8"));
  }
  // An arm64 phone, whatever this machine is (x86_64 Android is covered further down).
  write(
    "android.mjs",
    'Object.defineProperty(process, "platform", { value: "android" });\nObject.defineProperty(process, "arch", { value: "arm64" });',
  );
  write("node_modules/typescript/package.json", '{"name":"typescript"}');
  write("node_modules/typescript/bin/tsc", 'require("node:fs").appendFileSync("steps", "tsc\\n");');
  write("node_modules/vite/package.json", '{"name":"vite"}');
  // Stands in for `vite build` loading vite.config.ts, whose android-build-heap plugin calls the
  // same helper, and records the heap the build ran with.
  write(
    "node_modules/vite/bin/vite.js",
    `
    import("../../../scripts/build-heap.mjs").then(({ delegateDirectAndroidBuild }) => {
      delegateDirectAndroidBuild();
      const fs = require("node:fs");
      const heap = require("node:v8").getHeapStatistics().heap_size_limit;
      fs.appendFileSync("steps", "vite:" + (process.env.SKIP_PWA ?? "") + ":" + heap + "\\n");
      fs.rmSync("dist", { recursive: true, force: true });
      fs.mkdirSync("dist/.vite", { recursive: true });
      fs.mkdirSync("dist/assets");
      fs.writeFileSync("dist/index.html", '<script src="/assets/index.js"></script>');
      fs.writeFileSync("dist/assets/index.js", "fixture");
      fs.writeFileSync("dist/.vite/manifest.json", JSON.stringify({ "index.html": { isEntry: true, file: "assets/index.js" } }));
    });
  `,
  );
  write(
    "scripts/build-multiplayer-guest.mjs",
    `
    import * as fs from "node:fs";
    fs.appendFileSync("steps", "guest\\n");
    fs.mkdirSync("dist/multiplayer", { recursive: true });
    for (const file of ["guest.js", "guest.css"]) fs.writeFileSync("dist/multiplayer/" + file, "fixture");
  `,
  );
  const launcher = readFileSync(join(repositoryRoot, "start-termux.sh"), "utf8");
  const start = launcher.indexOf("build_termux_client() (");
  const end = launcher.indexOf("\nload_launcher_setting()", start);
  assert(start >= 0 && end > start);
  // Every path starts under the server heap Termux gives most phones.
  const serverHeap = "--max-old-space-size=1024";
  const android = `--import=${pathToFileURL(join(fixture, "android.mjs")).href}`;
  const baseEnv = { ...process.env, MARINARA_LOW_MEMORY_BUILD: "0", NODE_OPTIONS: serverHeap };
  for (const name of ["SKIP_PWA", "MARINARA_EXPLICIT_NODE_HEAP", "MARINARA_CLIENT_BUILD_SCRIPT"]) delete baseEnv[name];
  const raisedHeap = heapLimitFor(resolveClientBuildHeapMb({ lowMemory: true, env: {} }));
  const serverHeapLimit = heapLimitFor(1024);
  const build = (label, command, args, env, expectedSteps) => {
    write("steps", "");
    rmSync(join(fixture, "dist"), { recursive: true, force: true });
    const result = spawnSync(command, args, { cwd: fixture, env: { ...baseEnv, ...env }, encoding: "utf8" });
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(readFileSync(join(fixture, "steps"), "utf8"), expectedSteps, label);
  };
  const termuxLauncherScript = `${launcher.slice(start, end)}
    run_pnpm() {
      if [ "$*" = "--filter @marinara-engine/client build" ]; then node scripts/build.mjs; else return 90; fi
    }
    build_termux_client
  `;

  build("Termux launcher", "bash", ["-c", termuxLauncherScript], {}, `vite:1:${raisedHeap}\nguest\n`);
  assert.doesNotThrow(
    () => checkClientBuild(join(fixture, "dist")),
    "the real Termux helper must produce the complete client, including guest assets",
  );
  build(
    "Termux launcher with a heap the user set",
    "bash",
    ["-c", termuxLauncherScript],
    { MARINARA_EXPLICIT_NODE_HEAP: "1" },
    `vite:1:${serverHeapLimit}\nguest\n`,
  );

  // The in-app updater runs `pnpm --filter @marinara-engine/client build` on Android under the
  // server's environment, so the build script itself must raise the heap.
  const updates = readFileSync(join(repositoryRoot, "packages/server/src/routes/updates.routes.ts"), "utf8");
  assert.match(
    updates,
    /if \(process\.platform === "android"\) \{[\s\S]{0,200}runPinnedPnpm\(root, \["--filter", "@marinara-engine\/client", "build"\]/u,
    "the Android in-app update must build the client through its build script",
  );
  build(
    "in-app update on Android",
    process.execPath,
    ["scripts/build.mjs"],
    { NODE_OPTIONS: `${android} ${serverHeap}` },
    `vite:1:${raisedHeap}\nguest\n`,
  );
  assert.doesNotThrow(() => checkClientBuild(join(fixture, "dist")));

  // The v2.4.6 launcher keeps running after updating itself and runs `vite build` directly.
  const viteConfig = readFileSync(join(repositoryRoot, "packages/client/vite.config.ts"), "utf8");
  assert.match(
    viteConfig,
    /name: "android-build-heap", apply: "build", config: \(\) => delegateDirectAndroidBuild\(\)/u,
  );
  assert.match(viteConfig, /plugins: \[\s*androidBuildHeap\(\),/u);
  build(
    "v2.4.6 Termux launcher after updating",
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build"],
    { NODE_OPTIONS: `${android} ${serverHeap}`, SKIP_PWA: "1" },
    `vite:1:${raisedHeap}\nguest\n`,
  );
  assert.doesNotThrow(
    () => checkClientBuild(join(fixture, "dist")),
    "the old launcher's first build after updating must produce the complete client",
  );

  // Desktop builds keep PWA generation and leave type checking to `pnpm lint`.
  const desktopHeap = heapLimitFor(resolveClientBuildHeapMb({ lowMemory: false, env: {} }));
  build("desktop", process.execPath, ["scripts/build.mjs"], { NODE_OPTIONS: "" }, `vite::${desktopHeap}\nguest\n`);
  assert.doesNotThrow(() => checkClientBuild(join(fixture, "dist")), "desktop retains PWA policy");
  build(
    "desktop with a heap the user set",
    process.execPath,
    ["scripts/build.mjs"],
    {},
    `vite::${serverHeapLimit}\nguest\n`,
  );
  build(
    "desktop direct vite build",
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build"],
    {},
    `vite::${serverHeapLimit}\n`,
  );
  const clientPackage = JSON.parse(readFileSync(join(repositoryRoot, "packages/client/package.json"), "utf8"));
  assert.match(clientPackage.scripts.lint, /&& tsc -b &&/u, "client type checking must run in pnpm lint");
  console.info("Termux, in-app update, old launcher and desktop client build regression passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

// #9482: x86_64 Android (Chromebooks, BlueStacks and other Android on PCs) has no native build of three packages the
// client build loads, so each falls back to WebAssembly there: rolldown (Vite's bundler) and Tailwind's oxide load
// their WASI bindings on their own; lightningcss requires `lightningcss-android-x64`, which the client installs as an
// alias of lightningcss's WebAssembly build. The client installs both missing pieces at their packages' versions.
const clientRequire = createRequire(join(repositoryRoot, "packages/client/package.json"));
const rolldownEntry = createRequire(clientRequire.resolve("vite")).resolve("rolldown");
const tailwindNodeRequire = createRequire(
  createRequire(clientRequire.resolve("@tailwindcss/vite")).resolve("@tailwindcss/node"),
);
const lightningcssEntry = tailwindNodeRequire.resolve("lightningcss");
const oxideEntry = tailwindNodeRequire.resolve("@tailwindcss/oxide");
// A package's version, read from the package.json above its entry (some packages don't export package.json).
const versionFrom = (from, name) => {
  for (let dir = dirname(createRequire(from).resolve(name)); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
      return JSON.parse(readFileSync(manifest, "utf8")).version;
    }
    assert.notEqual(dirname(dir), dir, `no package.json for ${name}`);
  }
};
assert.equal(
  versionFrom(rolldownEntry, "@rolldown/binding-wasm32-wasi"),
  versionFrom(rolldownEntry, "rolldown"),
  "the rolldown WebAssembly binding the client installs must match the rolldown Vite uses",
);
assert.equal(
  versionFrom(createRequire(lightningcssEntry).resolve("lightningcss-android-x64"), "lightningcss-wasm"),
  versionFrom(lightningcssEntry, "lightningcss"),
  "the lightningcss WebAssembly build behind lightningcss-android-x64 must match the lightningcss Tailwind uses",
);
// #9530: no dependency may be a local folder. pnpm copies a folder dependency into .pnpm with hard links and does not
// fall back to copying files when that fails. Android does not let apps create hard links, so on every Termux install the
// whole `pnpm install` stops with "Permission denied". Registry packages install there as normal.
const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
assert.deepEqual(
  lockfile.match(/resolution: \{directory: [^}]*\}/gu) ?? [],
  [],
  "a local folder dependency stops `pnpm install` on Android; publish it or alias a registry package instead",
);
// Runs each package the way x86_64 Termux does: Node reports android/x64, so no native build loads.
const x64Fixture = mkdtempSync(join(tmpdir(), "marinara-android-x64-"));
try {
  writeFileSync(
    join(x64Fixture, "android-x64.mjs"),
    'Object.defineProperty(process, "platform", { value: "android" });\nObject.defineProperty(process, "arch", { value: "x64" });\n',
  );
  writeFileSync(join(x64Fixture, "dep.js"), "export const answer = 6 * 7;\n");
  writeFileSync(join(x64Fixture, "entry.js"), 'import { answer } from "./dep.js";\nconsole.log(answer);\n');
  // One process per tool: each loads its WebAssembly as it does inside the build. Their WebAssembly reaches only files
  // under the folder they start in, as build.mjs arranges below.
  const asX64Android = (label, script) => {
    const result = spawnSync(
      process.execPath,
      [`--import=${pathToFileURL(join(x64Fixture, "android-x64.mjs")).href}`, "-"],
      {
        // CommonJS, as a build calls these from its plugins: oxide's WebAssembly scanner deadlocks when an ES module
        // calls it while still being evaluated, before its worker threads have started.
        input: `(async () => {\n${script}\n})().catch((error) => {\n  console.error(error);\n  process.exit(1);\n});`,
        cwd: x64Fixture,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    assert.equal(result.status, 0, `${label} did not run as on x86_64 Android:\n${result.stderr}`);
    return result.stdout;
  };
  const bundled = asX64Android(
    "rolldown",
    `const { rolldown } = await import(${JSON.stringify(pathToFileURL(rolldownEntry).href)});
    const bundle = await rolldown({ input: ${JSON.stringify(join(x64Fixture, "entry.js"))}, logLevel: "silent" });
    const { output } = await bundle.generate({ format: "esm" });
    await bundle.close();
    process.stdout.write(output[0].code);`,
  );
  // rolldown resolves the import and folds dep.js's 6 * 7 into the entry.
  assert.match(bundled, /console\.log\(42\)/u, "rolldown bundles with its WebAssembly binding");
  const minified = asX64Android(
    "lightningcss",
    `const { code } = require(${JSON.stringify(lightningcssEntry)}).transform({
      filename: "fixture.css",
      code: Buffer.from(".a {\\n  color: #ff0000;\\n}\\n"),
      minify: true,
    });
    process.stdout.write(Buffer.from(code).toString());`,
  );
  assert.equal(minified, ".a{color:red}", "lightningcss minifies with its WebAssembly build");
  const candidates = JSON.parse(
    asX64Android(
      "Tailwind's oxide",
      `const { Scanner } = require(${JSON.stringify(oxideEntry)});
      const found = new Scanner({}).getCandidatesWithPositions({ content: '<div class="flex p-4">', extension: "html" });
      process.stdout.write(JSON.stringify(found.map((candidate) => candidate.candidate)));`,
    ),
  );
  assert.deepEqual(
    candidates.filter((candidate) => ["flex", "p-4"].includes(candidate)).sort(),
    ["flex", "p-4"],
    "Tailwind's oxide finds class names with its WebAssembly binding",
  );
} finally {
  rmSync(x64Fixture, { recursive: true, force: true });
}

// Which is why build.mjs starts Vite and the guest build from the workspace root on x86_64 Android, where the client's
// dependencies (the workspace's .pnpm folder) are inside, and from the package everywhere else.
const workspace = mkdtempSync(join(tmpdir(), "marinara-build-cwd-"));
try {
  const client = join(workspace, "packages/client");
  const put = (path, content) => {
    mkdirSync(dirname(join(client, path)), { recursive: true });
    writeFileSync(join(client, path), content);
  };
  put("package.json", '{"type":"module"}');
  for (const script of ["build.mjs", "build-heap.mjs"]) {
    put(`scripts/${script}`, readFileSync(join(repositoryRoot, "packages/client/scripts", script), "utf8"));
  }
  put("node_modules/typescript/package.json", '{"name":"typescript"}');
  put("node_modules/typescript/bin/tsc", "");
  put("node_modules/vite/package.json", '{"name":"vite"}');
  // Each child records where it started and what it was given.
  const record = (name) =>
    `require("node:fs").appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify({ name: ${JSON.stringify(name)}, cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");`;
  put("node_modules/vite/bin/vite.js", record("vite"));
  put(
    "scripts/build-multiplayer-guest.mjs",
    `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); ${record("guest")}`,
  );
  const runAs = (arch) => {
    const preload = join(workspace, `android-${arch}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process, "platform", { value: "android" });\nObject.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });\n`,
    );
    const recordFile = join(workspace, `record-${arch}`);
    writeFileSync(recordFile, "");
    const env = { ...process.env, FIXTURE_RECORD: recordFile, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    for (const name of ["SKIP_PWA", "MARINARA_EXPLICIT_NODE_HEAP", "MARINARA_CLIENT_BUILD_SCRIPT"]) delete env[name];
    const built = spawnSync(process.execPath, [join(client, "scripts/build.mjs")], {
      cwd: client,
      env,
      encoding: "utf8",
    });
    assert.equal(built.status, 0, `${arch}: ${built.stdout}${built.stderr}`);
    return readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const sameDir = (actual, expected) => assert.equal(realpathSync(actual), realpathSync(expected));
  const [x64Vite, x64Guest] = runAs("x64");
  assert.deepEqual([x64Vite.name, x64Guest.name], ["vite", "guest"]);
  sameDir(x64Vite.cwd, workspace);
  sameDir(x64Guest.cwd, workspace);
  assert.equal(x64Vite.args[0], "build");
  sameDir(x64Vite.args[1], client);
  const [armVite, armGuest] = runAs("arm64");
  sameDir(armVite.cwd, client);
  sameDir(armGuest.cwd, client);
  sameDir(armVite.args[1], client);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
console.info("x86_64 Android client build tools regression passed.");
