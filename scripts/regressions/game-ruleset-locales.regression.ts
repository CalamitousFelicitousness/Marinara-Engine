/**
 * A ruleset's translations (Capability API 1.798): `locales/<language>.json` beside its ruleset, the
 * package localization catalog's shape with a `ruleset` section of display strings, each keyed by its
 * English word for word.
 *
 *   - Read strictly: the language its name says, strings only, nothing else in the file; one not
 *     translated yet is left out, and a package's own English listing translates nothing.
 *   - A package file carries them only at 1.798; the import keeps them under its version, and importing
 *     the version again with other translations replaces them (they are display only, no part of it).
 *   - The strings route answers the language asked, else the one it is a kind of ("pt" for "pt-BR"),
 *     else nothing, with a validator.
 *   - The fight screen swaps them in as it draws: numbered names and lists too, never an id.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityPackageManifestSchema,
  readRulesetLocaleFile,
  rulesetLocaleOfAssetPath,
  supportedCapabilityApi,
} from "../../packages/shared/src/index.js";
import {
  rulesetTextLookup,
  translateRulesetView,
  RULESET_TEXT_AS_IS,
} from "../../packages/client/src/lib/ruleset-text.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-ruleset-locales-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

assert.ok(supportedCapabilityApi.minor >= 798);

// ── The file, read strictly ──
{
  const ok = readRulesetLocaleFile(
    {
      $schema: "../schema.json",
      _meta: { locale: "ru", direction: "ltr" },
      package: { name: "5e" },
      ruleset: { Prone: "Лежащий", Grappled: "", Fireball: "Огненный шар" },
    },
    "ru",
  );
  assert.ok(ok.ok);
  assert.deepEqual(
    { ...(ok as { strings: Record<string, string> }).strings },
    { Prone: "Лежащий", Fireball: "Огненный шар" },
    "one not translated yet is left out",
  );
  const own = readRulesetLocaleFile({ _meta: { locale: "en" }, package: { name: "5e" } }, "en");
  assert.ok(own.ok && Object.keys(own.strings).length === 0, "a package's own English listing translates nothing");
  const refused = (document: unknown, locale = "ru") => {
    const read = readRulesetLocaleFile(document, locale);
    assert.equal(read.ok, false, JSON.stringify(document));
    return (read as { issue: string }).issue;
  };
  assert.match(refused({ _meta: { locale: "de" }, ruleset: {} }), /_meta.locale is not "ru"/);
  assert.match(refused({ _meta: { locale: "ru" }, ruleset: {}, code: "x" }), /holds "code"/);
  assert.match(refused({ _meta: { locale: "ru" }, ruleset: { Prone: 1 } }), /is not text/);
  assert.match(refused({ _meta: { locale: "ru", direction: "up" }, ruleset: {} }), /direction/);
  assert.match(refused({ _meta: { locale: "ru" }, ruleset: [] }), /not a section of strings/);
  const proto = readRulesetLocaleFile(JSON.parse('{"_meta":{"locale":"ru"},"ruleset":{"__proto__":"x"}}'), "ru");
  assert.ok(proto.ok && proto.strings["__proto__"] === "x" && Object.getPrototypeOf(proto.strings) === null);
  assert.equal(rulesetLocaleOfAssetPath("locales/pt-BR.json"), "pt-BR");
  assert.equal(rulesetLocaleOfAssetPath("locales/zh-Hans.json"), "zh-Hans");
  for (const path of ["locales/RU.json", "locales/../x.json", "locales/ru.txt", "locales/r.json", "ru.json"])
    assert.equal(rulesetLocaleOfAssetPath(path), null, path);
}

// ── A package of the ember-roads example with translations ──
const example = JSON.parse(
  readFileSync(new URL("../../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"),
) as Record<string, any>;
example.id = "ember-roads-tongues";
const english = example.name as string;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const localeFile = (locale: string, strings: Record<string, string>) => ({
  name: `locales/${locale}.json`,
  data: Buffer.from(JSON.stringify({ _meta: { locale }, ruleset: strings })),
});
function packageFile(locales: Array<{ name: string; data: Buffer }>, minor = 798) {
  const files = [{ name: "ruleset.json", data: Buffer.from(JSON.stringify(example)) }, ...locales];
  const manifest = {
    schemaVersion: 2,
    id: "ember-roads-tongues",
    name: "Ember Roads (tongues)",
    version: "1.0.0",
    description: "",
    engine: { min: "2.4.0", maxExclusive: "3.0.0" },
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: files.map((file) => file.name) } },
    files: files.map((file) => ({ path: file.name, sha256: sha256(file.data), bytes: file.data.length })),
    permissions: [],
    restartRequired: false,
    capabilityApi: { major: 1, minor },
    builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
  };
  return {
    format: "marinara-ruleset",
    version: 1,
    manifest,
    files: Object.fromEntries(files.map((file) => [file.name, file.data.toString("base64")])),
  };
}

// The manifest gate: a ruleset's translations need 1.798; another package's locales/ folder is its own.
{
  const early = packageFile([localeFile("ru", { [english]: "Угольные дороги" })], 797).manifest;
  const read = capabilityPackageManifestSchema.safeParse(early);
  assert.equal(read.success, false);
  assert.match(
    JSON.stringify(read.error?.issues),
    /translations \(locales\/<language>.json\) require schemaVersion 2 and capabilityApi 1.798/,
  );
  const notRuleset = {
    ...early,
    kind: ["writer"],
    contributions: { assets: { paths: ["locales/ru.json"] } },
    files: [early.files[1]],
  };
  assert.ok(
    !JSON.stringify(capabilityPackageManifestSchema.safeParse(notRuleset).error?.issues ?? []).includes("1.798"),
  );
}

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { setCustomAgentImportsEnabled } =
  await import("../../packages/server/src/services/agents/custom-agent-import-policy.service.js");
const { gameRulesetsRoutes } = await import("../../packages/server/src/routes/game-rulesets.routes.js");
const { capabilityPackagesRoutes } = await import("../../packages/server/src/routes/capability-packages.routes.js");
const { gameRulesetCatalogs } = await import("../../packages/server/src/db/schema/index.js");
const { readRulesetPackageFile } = await import("../../packages/server/src/services/game/ruleset-package-file.js");

try {
  const db = await getDB();
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  app.decorate("db", db);
  await app.register(gameRulesetsRoutes, { prefix: "/api/game-rulesets" });
  await app.register(capabilityPackagesRoutes, { prefix: "/api/capability-packages" });
  try {
    await setCustomAgentImportsEnabled(db, true);
    const ru = localeFile("ru", { [english]: "Угольные дороги", Goblin: "Гоблин" });
    const pt = localeFile("pt", { [english]: "Estradas de Brasa" });
    const en = {
      name: "locales/en.json",
      data: Buffer.from(JSON.stringify({ _meta: { locale: "en" }, package: { name: english } })),
    };
    const file = packageFile([en, pt, ru]);

    // ── Read: each translation's strings; the English listing is not kept ──
    const read = readRulesetPackageFile(file);
    assert.ok(read.ok, JSON.stringify(read).slice(0, 400));
    assert.deepEqual(Object.keys(read.locales).sort(), ["pt", "ru"]);
    assert.equal(JSON.parse(read.locales.ru!)[english], "Угольные дороги");
    const early = readRulesetPackageFile(packageFile([ru], 797));
    assert.equal(early.ok, false);
    assert.match((early as { issues: string[] }).issues.join(" "), /1.798/);
    const wrong = readRulesetPackageFile(
      packageFile([
        { name: "locales/ru.json", data: Buffer.from(JSON.stringify({ _meta: { locale: "de" }, ruleset: {} })) },
      ]),
    );
    assert.equal(wrong.ok, false);
    assert.match((wrong as { issues: string[] }).issues.join(" "), /_meta.locale is not "ru"/);

    // ── A check names the least API, 1.798 with translations ──
    const checked = await app.inject({ method: "POST", url: "/api/game-rulesets/check", payload: { package: file } });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.deepEqual(checked.json().capabilityApi, { major: 1, minor: 798 });
    assert.deepEqual(checked.json().locales, ["pt", "ru"]);

    // ── Imported, then read in each language ──
    const imported = await app.inject({
      method: "POST",
      url: "/api/game-rulesets/import-package",
      payload: { package: file },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual(imported.json().locales, ["pt", "ru"]);
    const strings = (locale: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: "GET",
        url: `/api/capability-packages/rulesets/strings?rulesetId=local/ember-roads-tongues&version=1&locale=${locale}`,
        headers,
      });
    const inRussian = await strings("ru");
    assert.equal(inRussian.statusCode, 200, inRussian.body);
    assert.equal(inRussian.json().locale, "ru");
    assert.equal(inRussian.json().strings.Goblin, "Гоблин");
    assert.ok(inRussian.headers.etag);
    assert.equal((await strings("ru", { "if-none-match": String(inRussian.headers.etag) })).statusCode, 304);
    const brazil = (await strings("pt-BR")).json();
    assert.equal(brazil.locale, "pt", "a kind of a language reads that language");
    assert.equal(brazil.strings[english], "Estradas de Brasa");
    assert.deepEqual((await strings("de")).json(), {
      rulesetId: "local/ember-roads-tongues",
      version: 1,
      locale: null,
      strings: {},
    });
    assert.equal((await strings("en")).json().locale, null);
    assert.equal((await strings("../x")).statusCode >= 400, true);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/capability-packages/rulesets/strings?rulesetId=local/nothing&locale=ru",
        })
      ).statusCode,
      404,
    );

    // ── The same version again, with a corrected translation: the translation is replaced ──
    const stored = async () => ((await db.select().from(gameRulesetCatalogs)) as unknown[]).length;
    const before = await stored();
    const corrected = packageFile([en, pt, localeFile("ru", { [english]: "Угольные пути" })]);
    const again = await app.inject({
      method: "POST",
      url: "/api/game-rulesets/import-package",
      payload: { package: corrected },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().status, "unchanged", "the same version: translations are no part of it");
    const now = (await strings("ru")).json();
    assert.equal(now.strings[english], "Угольные пути");
    assert.equal(now.strings.Goblin, undefined);
    assert.equal(await stored(), before, "the old translation goes, the new one is kept once");
    // A package of it with no translations leaves those it had.
    const bare = packageFile([], 798);
    bare.manifest.capabilityApi.minor = 79;
    const plain = await app.inject({
      method: "POST",
      url: "/api/game-rulesets/import-package",
      payload: { package: bare },
    });
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal((await strings("ru")).json().strings[english], "Угольные пути");
  } finally {
    await app.close();
    await closeDB();
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

// ── On screen: swapped as it is drawn, ids never ──
{
  const text = rulesetTextLookup({ Goblin: "Гоблин", Prone: "Лежащий", "Fire Bolt": "Огненный снаряд" });
  assert.equal(text("Goblin"), "Гоблин");
  assert.equal(text("Goblin 2"), "Гоблин 2", "a fight's number on a translated name");
  assert.equal(text("Goblin, Prone"), "Гоблин, Лежащий");
  assert.equal(text("Bram"), "Bram");
  assert.equal(text("constructor"), "constructor", "nothing off a prototype");
  assert.equal(rulesetTextLookup({}), RULESET_TEXT_AS_IS);
  const view = {
    combatants: [{ id: "Goblin", name: "Goblin 1", conditions: ["Prone"] }],
    options: [{ id: "spells/fire-bolt", optionId: "Fire Bolt", label: "Fire Bolt" }],
    adjustments: ["Goblin is built from its tier."],
    events: [{ seq: 1, event: { type: "turn", actorId: "Goblin", label: "Fire Bolt" } }],
  } as never;
  const shown = translateRulesetView(view, text) as unknown as typeof view & Record<string, any>;
  assert.equal(shown.combatants[0].name, "Гоблин 1");
  assert.equal(shown.combatants[0].id, "Goblin");
  assert.deepEqual(shown.combatants[0].conditions, ["Prone"], "condition ids stay ids");
  assert.equal(shown.options[0].label, "Огненный снаряд");
  assert.equal(shown.options[0].optionId, "Fire Bolt");
  assert.equal(shown.events[0].event.label, "Огненный снаряд");
  assert.equal(shown.events[0].event.actorId, "Goblin");
  assert.deepEqual(shown.adjustments, ["Goblin is built from its tier."], "notes are read against their English");
  assert.equal(translateRulesetView(view, RULESET_TEXT_AS_IS), view);
}

console.log("Ruleset translations: read strictly, kept beside their version, served by language, swapped in as drawn.");
