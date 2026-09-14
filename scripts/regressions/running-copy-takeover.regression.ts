// A second supervised start stops the running copy over loopback and takes over its data directory.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const serverRequire = createRequire(join(root, "packages/server/package.json"));
const dir = mkdtempSync(join(tmpdir(), "marinara-takeover-"));
const probe = createServer();
await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
const address = probe.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((done) => probe.close(() => done()));
const base = `http://127.0.0.1:${port}`;

type Launch = { child: ChildProcess; output: () => string; exited: Promise<number | null> };

function launch(): Launch {
  const child = spawn(
    process.execPath,
    [
      join(root, "scripts/run-server.mjs"),
      "--import",
      pathToFileURL(serverRequire.resolve("tsx/esm")).href,
      join(root, "packages/server/src/index.ts"),
    ],
    {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DATA_DIR: dir,
        FILE_STORAGE_DIR: join(dir, "storage"),
        NODE_ENV: "production",
        MARINARA_LITE: "true",
        LOG_LEVEL: "info",
        AUTO_CREATE_DEFAULT_CONNECTION: "false",
        AUTO_OPEN_BROWSER: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  return { child, output: () => output, exited };
}

async function listeningPid(run: Launch, previous?: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 20_000 && run.child.exitCode === null) {
    for (const line of run.output().split("\n").slice(0, -1)) {
      if (!line.includes("Marinara Engine server listening")) continue;
      const pid = (JSON.parse(line) as { pid: number }).pid;
      if (pid !== previous) return pid;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`Server did not start listening: ${run.output()}`);
}

const first = launch();
let second: Launch | undefined;
const serverPids: number[] = [];
try {
  const firstPid = await listeningPid(first);
  serverPids.push(firstPid);
  const misdirected = await fetch(`${base}/api/admin/shutdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, pid: firstPid + 1 }),
  });
  assert.equal(misdirected.status, 400, "A shutdown naming another PID must be refused");

  second = launch();
  const secondPid = await listeningPid(second, firstPid);
  serverPids.push(secondPid);
  assert.equal(await first.exited, 0, `The replaced launcher must exit cleanly: ${first.output()}`);
  assert.throws(() => process.kill(firstPid, 0), "The replaced server must be gone");
  assert.match(first.output(), /another launcher can take over/u);
  assert.match(second.output(), /already running as PID/u);
  assert.doesNotMatch(second.output(), /Unhandled error during server bootstrap/u);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);

  const supervisor = readFileSync(join(root, "scripts/run-server.mjs"), "utf8");
  assert.match(
    supervisor,
    /process\.platform !== "win32"\) child\?\.kill\(signal\)/u,
    "Windows kill() terminates outright and must not cut off a console Ctrl+C shutdown",
  );
} finally {
  for (const run of [first, second]) run?.child.kill("SIGKILL");
  for (const pid of serverPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already stopped */
    }
  }
  await Promise.all([first.exited, second?.exited]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log("Running copy takeover regression passed.");
