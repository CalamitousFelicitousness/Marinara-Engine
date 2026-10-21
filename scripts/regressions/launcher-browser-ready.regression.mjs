import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "marinara-browser-ready-"));
const fixture = join(scratch, "server.mjs");
const preload = join(scratch, "capture-browser.mjs");
const capture = join(scratch, "browser.jsonl");
const counter = join(scratch, "boots");
const argumentsFile = join(scratch, "arguments.json");

// Intercept only the OS browser opener. The supervisor and its server remain
// real processes; the opener checks the HTTP listener instead of starting a GUI.
writeFileSync(
  preload,
  `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
const original = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (!["open", "xdg-open", "explorer.exe", "termux-open-url"].includes(command)) {
    return original.call(this, command, args, options);
  }
  const child = new EventEmitter();
  child.unref = () => {};
  const record = { command, args, shell: options?.shell ?? false, at: Date.now() };
  if (process.env.BROWSER_FIXTURE_OPENER_FAIL === "true") {
    appendFileSync(${JSON.stringify(capture)}, JSON.stringify(record) + "\\n");
    queueMicrotask(() => child.emit("error", new Error("browser opener fixture failed")));
  } else {
    fetch(args[0]).then(async response => {
      record.status = response.status;
      record.body = await response.text();
    }).catch(error => { record.error = error.message; }).finally(() => {
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify(record) + "\\n");
    });
  }
  return child;
};
syncBuiltinESMExports();
`,
);

writeFileSync(
  fixture,
  `
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));
const boot = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1 : 1;
writeFileSync(${JSON.stringify(counter)}, String(boot));
process.send?.({ type: "unrelated-message" });
if (process.env.BROWSER_FIXTURE_EARLY_EXIT === "true") process.exit(19);
// Slower than both removed launcher timers (3 and 4 seconds).
await sleep(boot === 1 ? Number(process.env.BROWSER_FIXTURE_DELAY ?? 4500) : 20);
const server = createServer((_request, response) => response.end("ready boot " + boot));
await new Promise(done => server.listen(Number(process.env.BROWSER_FIXTURE_PORT), "127.0.0.1", done));
// Report readiness twice to exercise duplicate notifications.
process.send?.({ type: "marinara:ready" });
process.send?.({ type: "marinara:ready" });
await sleep(250);
await new Promise(done => server.close(done));
process.exit(process.env.BROWSER_FIXTURE_RESTART === "true" && boot === 1 ? 75 : 0);
`,
);

async function run({ open = true, env = {}, browserUrl } = {}) {
  rmSync(capture, { force: true });
  rmSync(counter, { force: true });
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      join(root, "scripts/run-server.mjs"),
      fixture,
      "--kept-argument",
      "value with spaces & punctuation",
      ...(open
        ? ["--open-browser", browserUrl ?? `http://127.0.0.1:${port}/android-login?source=launcher&ready=true`]
        : []),
    ],
    {
      env: { ...process.env, BROWSER_FIXTURE_PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const status = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  clearTimeout(timeout);
  let records = [];
  try {
    records = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { status, stdout, stderr, records, started };
}

try {
  const delayed = await run({ env: { BROWSER_FIXTURE_RESTART: "true" } });
  assert.equal(delayed.status, 0, delayed.stderr);
  assert.equal(delayed.records.length, 1, "Duplicate readiness and supervised restart must open only one browser tab");
  assert.ok(
    delayed.records[0].at - delayed.started >= 4500,
    "Browser must wait through startup longer than the old timer",
  );
  assert.equal(delayed.records[0].status, 200, JSON.stringify(delayed.records));
  assert.equal(delayed.records[0].body, "ready boot 1");
  assert.equal(delayed.records[0].shell, false, "The browser URL must never be interpolated into a shell command");
  assert.match(delayed.records[0].args[0], /\/android-login\?source=launcher&ready=true$/u);
  assert.equal(readFileSync(counter, "utf8"), "2", "Exit code 75 must still start a replacement child");
  assert.deepEqual(JSON.parse(readFileSync(argumentsFile, "utf8")), [
    "--kept-argument",
    "value with spaces & punctuation",
  ]);

  const failed = await run({ env: { BROWSER_FIXTURE_EARLY_EXIT: "true" } });
  assert.equal(failed.status, 19);
  assert.deepEqual(failed.records, [], "A child that exits before readiness must never open the browser");

  const disabled = await run({ open: false, env: { BROWSER_FIXTURE_DELAY: "0" } });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(disabled.records, [], "pnpm start and disabled auto-open must not start a browser");

  const openerFailed = await run({ env: { BROWSER_FIXTURE_DELAY: "0", BROWSER_FIXTURE_OPENER_FAIL: "true" } });
  assert.equal(openerFailed.status, 0, "A missing browser opener must not stop the server");
  assert.match(openerFailed.stderr, /Could not open the browser.*Open http/u);

  const invalid = await run({ browserUrl: "file:///etc/passwd" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /requires one HTTP or HTTPS URL/u);
  assert.deepEqual(invalid.records, []);

  const entry = readFileSync(join(root, "packages/server/src/index.ts"), "utf8");
  assert.ok(
    entry.indexOf('type: "marinara:ready"') > entry.indexOf('startup.phase("http.listen"'),
    "The real server entry must notify its launcher after awaiting the HTTP listener",
  );
  for (const launcher of ["start.bat", "start-local.bat", "start.sh", "start-termux.sh"]) {
    const source = readFileSync(join(root, launcher), "utf8");
    assert.match(source, /--open-browser/u, `${launcher} must use supervisor readiness`);
    assert.doesNotMatch(source, /sleep 3 &&|timeout \/t 4/u, `${launcher} must not use a startup timer`);
  }
  console.log(
    "Launcher browser readiness, startup failure, restart, disabled auto-open and safe URL arguments passed.",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
