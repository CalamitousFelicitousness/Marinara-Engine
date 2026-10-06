import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");

// #7178: pnpm 10 reads supportedArchitectures only from pnpm-workspace.yaml, package.json or the
// --os/--cpu/--libc flags. The .npmrc lines start-termux.sh used to append never applied, and
// Termux installs with pnpm's default target (android/<arch>), which is the one it needs.
for (const path of ["start-termux.sh", ".npmrc"]) {
  assert.doesNotMatch(
    read(path),
    /supportedArchitectures|TERMUX_FORCE_INSTALL/u,
    `${path} must not carry pnpm architecture settings that pnpm ignores in .npmrc`,
  );
}

// Every native loader Termux runs picks its binary by process.platform ("android"), so the
// default target must keep an android/arm64 build of each one. Linux builds are never loaded.
const lock = read("pnpm-lock.yaml");
const [packagesSection, snapshotsSection] = lock.split("\npackages:\n")[1].split("\nsnapshots:\n");
const blocks = (section) =>
  new Map(
    section.split("\n\n").map((block) => {
      const [header, ...body] = block.trim().split("\n");
      return [header.replace(/:( \{\})?$/u, "").replace(/^'|'$/gu, ""), body.join("\n")];
    }),
  );
const packages = blocks(packagesSection);
const snapshots = blocks(snapshotsSection);
const runsOnAndroidArm64 = (key) => {
  const metadata = packages.get(key) ?? "";
  return /^ {4}os: \[[^\]]*\bandroid\b/mu.test(metadata) && /^ {4}cpu: \[[^\]]*\barm64\b/mu.test(metadata);
};

for (const loader of ["esbuild", "rollup", "lightningcss", "@tailwindcss/oxide", "@napi-rs/canvas"]) {
  const versions = [...snapshots].filter(([key]) => key.startsWith(`${loader}@`));
  assert.ok(versions.length > 0, `${loader} must be in the lockfile`);
  for (const [key, body] of versions) {
    const optional = body.split("optionalDependencies:\n")[1] ?? "";
    const androidBuild = [...optional.matchAll(/^ {6}'?([^':\s]+)'?: (\S+)/gmu)]
      .map(([, name, version]) => `${name}@${version.replace(/\(.*$/u, "")}`)
      .find(runsOnAndroidArm64);
    assert.ok(androidBuild, `${key} needs an android/arm64 optional build for Termux installs`);
  }
}

console.info("Termux installs use pnpm's Android target, and every native loader has an android/arm64 build.");
