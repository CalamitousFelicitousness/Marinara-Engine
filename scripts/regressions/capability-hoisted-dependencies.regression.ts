import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "marinara-hoisted-dependencies-"));
process.env.DATA_DIR = join(directory, "external-data");
process.env.FILE_STORAGE_DIR = join(directory, "external-storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
const { linkCapabilitySnapshotDependencies } =
  await import("../../packages/server/src/services/capability-packages/capability-native-dependencies.service.js");
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const names = ["zod", "zod-v3", "nanoid", "adm-zip", "@fastify/cors"] as const;
const targets = Object.fromEntries(names.map((name) => [name, dirname(requireServer.resolve(`${name}/package.json`))]));
const dependencies = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [name, JSON.parse(await readFile(join(targets[name]!, "package.json"), "utf8")).version]),
  ),
);
const linkType = process.platform === "win32" ? "junction" : "dir";
async function link(modules: string, name: (typeof names)[number]) {
  const path = join(modules, name);
  await mkdir(dirname(path), { recursive: true });
  await symlink(targets[name]!, path, linkType);
}

try {
  await test("native Engine Zod 4 reproduces the package's missing innerType API", () => {
    const zod = requireServer("zod");
    assert.equal(Number(requireServer("zod/package.json").version.split(".")[0]), 4);
    const schema = zod.object({}).superRefine(() => {});
    assert.throws(() => schema.innerType(), /innerType is not a function/);
    assert.equal(
      typeof requireServer("zod-v3")
        .object({})
        .superRefine(() => {}).innerType,
      "function",
    );
  });
  for (const location of ["inside-engine", "external-data"] as const) {
    for (const layout of ["pnpm-direct", "no-server-modules", "partial-server-modules", "native-zod-only"] as const) {
      await test(`${location}: ${layout} links every declared dependency and the legacy Zod alias`, async () => {
        const root = join(directory, location, layout);
        const engine = join(root, "engine");
        const server = join(engine, "packages", "server");
        const serverModules = join(server, "node_modules");
        const hoistedModules = join(engine, "node_modules");
        const data = location === "inside-engine" ? join(engine, "data") : join(root, "external-data");
        const snapshot = join(data, "capability-runtime-snapshots", "probe");
        await mkdir(server, { recursive: true });
        await mkdir(snapshot, { recursive: true });
        await writeFile(join(server, "package.json"), JSON.stringify({ name: "fixture-server", dependencies }));
        for (const name of names) await link(hoistedModules, name);
        if (layout === "pnpm-direct") {
          for (const name of names) await link(serverModules, name);
        } else if (layout === "partial-server-modules") {
          await link(serverModules, "adm-zip");
        } else if (layout === "native-zod-only") {
          await link(serverModules, "zod");
        }

        // The logical server base resolves the same installed dependencies in every layout.
        const hostRequire = createRequire(join(server, "package.json"));
        for (const name of names) {
          assert.equal(
            await realpath(dirname(hostRequire.resolve(`${name}/package.json`))),
            await realpath(targets[name]!),
          );
        }
        await linkCapabilitySnapshotDependencies(snapshot, serverModules);
        for (const name of names) {
          assert.equal(
            await realpath(join(snapshot, "node_modules", name)),
            await realpath(targets[name === "zod" ? "zod-v3" : name]!),
            `${name} links to the Engine-resolved package, with only Zod remapped`,
          );
        }
        const entry = join(snapshot, "server.mjs");
        await writeFile(
          entry,
          `import { z } from "zod";
import { nanoid } from "nanoid";
import AdmZip from "adm-zip";
import cors from "@fastify/cors";
const schema = z.object({}).superRefine(() => {});
export const parsed = schema.innerType().parse({});
export const legacyMethod = typeof schema.innerType;
export const generatedId = nanoid(8);
export const zipEntries = new AdmZip().getEntries().length;
export const scopedExport = typeof cors;
`,
        );
        const loaded = await import(pathToFileURL(entry).href);
        assert.deepEqual(loaded.parsed, {});
        assert.equal(loaded.legacyMethod, "function");
        assert.equal(loaded.generatedId.length, 8);
        assert.equal(loaded.zipEntries, 0);
        assert.equal(loaded.scopedExport, "function");
        assert.equal(Number(hostRequire("zod/package.json").version.split(".")[0]), 4, "the host keeps native Zod 4");
      });
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
