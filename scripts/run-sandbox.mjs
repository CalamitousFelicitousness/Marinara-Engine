#!/usr/bin/env node
// Runs the app from source on sandbox data (scripts/make-sandbox-data.mjs), apart from the real install.
//
//   node scripts/run-sandbox.mjs [--data <sandbox dir>] [--env <env file>] [--check | --stop]
//
// The repo .env can set FILE_STORAGE_DIR, which the server reads before DATA_DIR, and a second server
// on the same storage takes the running one over. The storage location therefore comes only from
// --data: the folder must carry the scrubber's marker and lie clear of the real install, and it is
// exported to the server, where an exported value beats any env file.
//
// The server runs without a file watcher. A watcher outlives a killed launcher and restarts its
// server later with the environment it was started with, and one watching a data folder outside
// packages/server/data restarts on every runtime file the server writes there. Restart the sandbox
// to pick up server changes; the Vite client reloads on its own.
//
// --check prints what would start and exits. --stop shuts the running sandbox down.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";
import {
  DEFAULT_SANDBOX_DATA_DIR,
  DEFAULT_SANDBOX_ENV_FILE,
  DEFAULT_SANDBOX_PORTS,
  SANDBOX_MARKER,
  foldersOverlap,
  isSandboxData,
  readEnvFile,
  repoRoot,
  resolveFromServerRoot,
  resolveRealInstall,
  samePath,
} from "./sandbox-paths.mjs";

const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

/** Ports from the sandbox env file, which holds nothing the launcher has to trust. */
export function sandboxPorts(env) {
  return {
    server: Number.parseInt(env.PORT ?? "", 10) || DEFAULT_SANDBOX_PORTS.server,
    client: Number.parseInt(env.VITE_PORT ?? "", 10) || DEFAULT_SANDBOX_PORTS.client,
  };
}

/** Every reason not to start. Empty means the sandbox is its own instance on scrubbed data. */
export function findSandboxProblems({ dataDir, envFile, real }) {
  const problems = [];
  const storageDir = path.join(dataDir, "storage");
  if (!isSandboxData(dataDir)) {
    problems.push(`${dataDir} has no ${SANDBOX_MARKER}: build it with scripts/make-sandbox-data.mjs`);
  }
  for (const [label, dir] of [
    ["data", real.dataDir],
    ["storage", real.storageDir],
  ]) {
    if (foldersOverlap(dataDir, dir)) problems.push(`${dataDir} overlaps the real install's ${label} folder (${dir})`);
  }
  if (samePath(envFile, real.envFile)) problems.push("the sandbox env file is the real install's .env");
  const env = readEnvFile(envFile);
  for (const [key, expected] of [
    ["DATA_DIR", dataDir],
    ["FILE_STORAGE_DIR", storageDir],
    ["MARINARA_FILE_STORAGE_DIR", storageDir],
  ]) {
    const value = env[key]?.trim();
    if (value && !samePath(resolveFromServerRoot(value), expected)) {
      problems.push(`${envFile} sets ${key} to a folder other than the sandbox's`);
    }
  }
  const ports = sandboxPorts(env);
  if (ports.server === ports.client) problems.push("the sandbox API and client share one port");
  for (const port of [ports.server, ports.client]) {
    if (port === real.port || port === real.clientPort) problems.push(`port ${port} belongs to the real install`);
  }
  return problems;
}

/** The server's environment: storage, env file, ports and host exported, so no env file can redirect them. */
export function sandboxEnvironment({ dataDir, envFile, ports, ambient = process.env }) {
  const env = {
    ...ambient,
    MARINARA_ENV_FILE: envFile,
    DATA_DIR: dataDir,
    FILE_STORAGE_DIR: path.join(dataDir, "storage"),
    PORT: String(ports.server),
    VITE_PORT: String(ports.client),
    // Loopback only, and the origin the Vite proxy forwards.
    HOST: "127.0.0.1",
    VITE_HOST: "127.0.0.1",
    CORS_ORIGINS: `http://127.0.0.1:${ports.client},http://localhost:${ports.client}`,
    AUTO_OPEN_BROWSER: "false",
    VITE_OPEN_BROWSER: "false",
    AUTO_UPDATE_ENABLED: "false",
    AUTO_CREATE_DEFAULT_CONNECTION: "false",
    UPDATES_APPLY_DISABLED: "true",
  };
  // The alias would be read if FILE_STORAGE_DIR were ever dropped; the real install's secrets stay with it.
  for (const key of ["MARINARA_FILE_STORAGE_DIR", "ENCRYPTION_KEY", "ADMIN_SECRET"]) delete env[key];
  return env;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--data" || flag === "--env") args[flag.slice(2)] = argv[++index];
    else if (flag === "--check" || flag === "--stop") args[flag.slice(2)] = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Asks the server that holds the sandbox storage to exit; a running launcher then stops the client.
 * The shutdown route wants the server's pid, which its writer lease records.
 */
async function stopSandbox(dataDir, ports) {
  let pid = null;
  try {
    pid = JSON.parse(fs.readFileSync(path.join(dataDir, "storage", ".writer-lease", "owner.json"), "utf8")).pid;
  } catch {
    // No lease: no server holds the storage.
  }
  if (pid !== null && (await portAnswers(ports.server))) {
    const origin = `http://127.0.0.1:${ports.server}`;
    const response = await fetch(`${origin}/api/admin/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ confirm: true, pid }),
    });
    if (!response.ok) throw new Error(`the server on port ${ports.server} refused to shut down (${response.status})`);
  }
  const held = [];
  for (const port of [ports.server, ports.client]) {
    if (!(await waitFor(async () => !(await portAnswers(port)), STOP_TIMEOUT_MS))) held.push(port);
  }
  if (held.length > 0) {
    // A launcher that was killed outright leaves its children behind; they are not found from here.
    throw new Error(`port ${held.join(" and ")} still answers: stop the process that holds it`);
  }
  console.log("sandbox: stopped");
}

// Rebuilt in place: deleting the shared output would break a server already running from it.
function buildShared() {
  const runner = resolvePnpmRunner();
  const result = spawnSync(runner.command, [...runner.args, "--filter", "@marinara-engine/shared", "build:preserve"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("the shared package did not build");
}

async function startSandbox(env, ports) {
  for (const port of [ports.server, ports.client]) {
    if (await portAnswers(port)) throw new Error(`port ${port} is in use: run with --stop first`);
  }
  buildShared();

  const serverRoot = path.join(repoRoot, "packages", "server");
  const clientRoot = path.join(repoRoot, "packages", "client");
  const tsx = pathToFileURL(createRequire(path.join(serverRoot, "package.json")).resolve("tsx/esm")).href;
  const vite = path.join(
    path.dirname(createRequire(path.join(clientRoot, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );

  // Both run as direct children of this process, so stopping them needs no process-tree walk.
  let client = null;
  const server = spawn(process.execPath, ["--import", tsx, "src/index.ts"], { cwd: serverRoot, env, stdio: "inherit" });
  const stop = () => {
    client?.kill();
    server.kill();
  };
  server.once("exit", (code) => {
    client?.kill();
    process.exit(code ?? 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);

  if (!(await waitFor(() => portAnswers(ports.server), READY_TIMEOUT_MS))) {
    stop();
    throw new Error(`the server did not answer on port ${ports.server}`);
  }
  client = spawn(process.execPath, [vite], { cwd: clientRoot, env, stdio: "inherit" });
  client.once("exit", () => server.kill());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.data ?? DEFAULT_SANDBOX_DATA_DIR);
  const envFile = path.resolve(args.env ?? DEFAULT_SANDBOX_ENV_FILE);
  const problems = findSandboxProblems({ dataDir, envFile, real: resolveRealInstall() });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`sandbox: ${problem}`);
    process.exit(1);
  }
  const ports = sandboxPorts(readEnvFile(envFile));
  if (args.stop) return stopSandbox(dataDir, ports);
  console.log(`sandbox: data ${dataDir}`);
  console.log(`sandbox: env file ${envFile}`);
  console.log(`sandbox: http://127.0.0.1:${ports.client} (API on ${ports.server})`);
  if (args.check) return;
  await startSandbox(sandboxEnvironment({ dataDir, envFile, ports }), ports);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`sandbox: ${error?.message ?? error}`);
    process.exit(1);
  });
}
