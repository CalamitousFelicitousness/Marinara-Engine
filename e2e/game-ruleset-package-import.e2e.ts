import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { expect, test } from "@playwright/test";
import { clickTopbarPanel } from "./topbar-navigation.js";
import { seedUIState } from "./ui-state-fixture.js";

/**
 * A ruleset package zip (RM), imported from the Agents panel: the review shows its catalogs and their
 * entries, the import keeps it, and a zip holding anything else is refused with the reason.
 */

/** A zip of stored entries. */
function zipOf(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name: text, data } of files) {
    const name = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const appVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const example = JSON.parse(
  readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"),
) as Record<string, any>;
const ruleset = structuredClone(example);
ruleset.id = "ember-roads-zip";
ruleset.name = "Ember Roads (zip)";
const first = (ruleset.catalogs as Array<Record<string, any>>)[0]!;
const catalog = { schemaVersion: 1, catalog: first.id, entries: first.entries as unknown[] };
delete first.entries;
first.asset = `catalogs/${first.id}.json`;
const files = [
  { name: "ruleset.json", data: Buffer.from(JSON.stringify(ruleset)) },
  { name: first.asset as string, data: Buffer.from(JSON.stringify(catalog)) },
];
const manifestOf = (contents: typeof files) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      id: "ember-roads-zip",
      name: "Ember Roads (zip)",
      version: "1.0.0",
      description: "",
      engine: { min: "2.4.0", maxExclusive: "3.0.0" },
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: contents.map((file) => file.name) } },
      files: contents.map((file) => ({
        path: file.name,
        sha256: createHash("sha256").update(file.data).digest("hex"),
        bytes: file.data.length,
      })),
      permissions: [],
      restartRequired: false,
      capabilityApi: { major: 1, minor: 78 },
      builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
    }),
  );

test("a ruleset package zip is reviewed with its catalogs and imported; one holding more is refused", async ({
  page,
  request,
}, testInfo) => {
  const before = ((await (await request.get("/api/agents/import-policy")).json()) as { enabled: boolean }).enabled;
  const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
  expect(policy.ok()).toBeTruthy();
  try {
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: testInfo.project.name === "desktop-chromium" ? "light" : "dark",
    });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), appVersion);
    await page.goto("/");
    await clickTopbarPanel(page, "agents");
    const rulesetInput = page
      .getByRole("region", { name: "Agents" })
      .locator('input[type="file"][accept=".json,.zip"]');

    // Anything but a ruleset's files refuses the zip, with the reason.
    await rulesetInput.setInputFiles({
      name: "ember-roads-zip.zip",
      mimeType: "application/zip",
      buffer: zipOf([
        { name: "manifest.json", data: manifestOf(files) },
        ...files,
        { name: "payload.js", data: Buffer.from("alert(1)") },
      ]),
    });
    await expect(page.getByText(/"payload\.js" is not a file a ruleset package has/)).toBeVisible();

    // The zip as a ruleset editor makes it: reviewed with its catalog and entries, then imported.
    await rulesetInput.setInputFiles({
      name: "ember-roads-zip.zip",
      mimeType: "application/zip",
      buffer: zipOf([{ name: "manifest.json", data: manifestOf(files) }, ...files]),
    });
    const review = page.getByRole("dialog", { name: "Import a Game Mode ruleset" });
    await expect(review).toBeVisible();
    await expect(review).toContainText(`${first.label} (${catalog.entries.length} entries)`);
    await review.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("Imported Ember Roads (zip), version 1.")).toBeVisible();
    const listed = (await (await request.get("/api/capability-packages/rulesets")).json()) as Array<{
      definition: { id: string };
    }>;
    expect(listed.some((entry) => entry.definition.id === "local/ember-roads-zip")).toBe(true);
  } finally {
    await request.delete("/api/game-rulesets?rulesetId=local/ember-roads-zip&force=true").catch(() => undefined);
    await request.patch("/api/agents/import-policy", { data: { enabled: before } }).catch(() => undefined);
  }
});
