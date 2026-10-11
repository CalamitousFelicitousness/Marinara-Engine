/**
 * Dice a rest spends to heal (Capability API 1.330): 5e's Hit Dice on a short rest, Song of Rest's extra
 * die from whoever in the party has it, and Pell's Teapot's +1 on that die.
 *
 *   - `[sheet: op="rest" rest="short" dice="2"]` spends two hit dice, rolls each (the hit die field's
 *     "d10") plus Constitution, never below 0 a die, heals that, then rests.
 *   - The party's best extra die is added once to everybody who spends any, with its holder's bonus.
 *   - Too few dice, or a rest without dice, is refused and changes nothing.
 *   - The tag is written back with its dice; the GM is told about them; the install gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRulesetSheetOp,
  applySheetCommandTags,
  parseRulesetDefinition,
  parseSheetCommandTagBody,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-rest-dice-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 330);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const document = (dice = true): Record<string, any> => {
    const doc = JSON.parse(fiveEText);
    doc.sheet.fields.push(
      { id: "song_die", label: "Song of Rest die", type: "number", min: 0, max: 12, default: 0, section: "combat" },
      { id: "song_bonus", label: "Song of Rest bonus", type: "number", min: 0, max: 5, default: 0, section: "combat" },
    );
    if (dice)
      doc.rests.find((rest: { id: string }) => rest.id === "short").dice = {
        pool: "hit_dice",
        die: { field: "hit_die" },
        add: { abilityMod: "con" },
        heals: "hp",
        extra: { die: { field: "song_die" }, add: { field: "song_bonus" } },
      };
    return doc;
  };
  const parsed = parseRulesetDefinition(document());
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  const definition: RulesetDefinition = parsed.definition;
  const build = (fields: Record<string, unknown>, con = 14) =>
    rulesetSheetBuildSchema.parse({
      abilities: { str: 10, dex: 10, con, int: 10, wis: 10, cha: 10 },
      fields: { level: 4, ac: 12, speed: 30, hp_max: 40, hit_die: "d10", ...fields },
    });
  const ada = build({});
  // Pell the bard: a d6 Song of Rest and the Teapot's +1.
  const pell = build({ hit_die: "d8", song_die: 6, song_bonus: 1 }, 6);
  const hurt = { pools: { hp: { value: 10 } } };
  const roll = (sides: number) => (sides === 10 ? 7 : sides === 6 ? 4 : 5);

  // ── On one sheet ──
  {
    const rested = applyRulesetSheetOp(definition, ada, hurt, { op: "rest", rest: "short", dice: 2 }, roll);
    assert.ok(rested.ok, JSON.stringify(rested));
    // Two d10s of 7, +2 Constitution each: 18, 10 + 18 = 28 of 40; two of four dice left.
    assert.equal(rested.live.pools?.hp?.value, 28);
    assert.equal(rested.live.pools?.hit_dice?.value, 2);
    assert.ok(rested.now.startsWith("2 spent (7, 7): "), rested.now);
    // Without a roller each die counts its average: 5.5 + 2, twice, is 15.
    const averaged = applyRulesetSheetOp(definition, ada, hurt, { op: "rest", rest: "short", dice: 2 });
    assert.ok(averaged.ok);
    assert.equal(averaged.live.pools?.hp?.value, 25);
    // A Constitution of 6 takes 2 a die, but never below 0: a d8 of 1 heals nothing.
    const frail = applyRulesetSheetOp(
      definition,
      build({ hit_die: "d8" }, 6),
      hurt,
      { op: "rest", rest: "short", dice: 1 },
      () => 1,
    );
    assert.ok(frail.ok);
    assert.equal(frail.live.pools?.hp?.value, 10);
    // Pell on their own sheet gets their own song: d8 of 5 - 2 = 3, + d6 of 4 + 1 = 5: 8.
    const own = applyRulesetSheetOp(definition, pell, hurt, { op: "rest", rest: "short", dice: 1 }, roll);
    assert.ok(own.ok);
    assert.equal(own.live.pools?.hp?.value, 18);
    // Refused, nothing changed.
    const short = applyRulesetSheetOp(definition, ada, hurt, { op: "rest", rest: "short", dice: 5 }, roll);
    assert.deepEqual(short, { ok: false, reason: "insufficient" });
    const longRest = applyRulesetSheetOp(definition, ada, hurt, { op: "rest", rest: "long", dice: 1 }, roll);
    assert.deepEqual(longRest, { ok: false, reason: "bad-amount" }, "a long rest spends no dice");
  }

  // ── The party, with Pell's song ──
  {
    const result = applySheetCommandTags('They rest. [sheet: who="party" op="rest" rest="short" dice="1"]', {
      definition,
      cards: [
        { name: "Ada", build: ada },
        { name: "Pell", build: pell },
      ],
      playerName: "Ada",
      live: { ada: hurt, pell: hurt },
      roll,
    });
    // Ada: d10 of 7 + 2 = 9, + Pell's d6 of 4 + 1 = 5: 24. Pell: 3 + 5 = 18.
    assert.equal(result.live.ada?.pools?.hp?.value, 24, JSON.stringify(result.outcomes));
    assert.equal(result.live.pell?.pools?.hp?.value, 18);
    assert.ok(result.content.includes('dice="1"'), result.content);
  }

  // ── The tag, the GM, the gate ──
  assert.deepEqual(parseSheetCommandTagBody('op="rest" rest="short" dice="3"').op, {
    op: "rest",
    rest: "short",
    dice: 3,
  });
  assert.equal(parseSheetCommandTagBody('op="rest" rest="short" dice="many"').op, null);
  const manifest = (minor: number) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    id: "fivee",
    name: "5e",
    version: "1.0.0",
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: ["ruleset.json"] } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  const gate =
    "A ruleset with a rest that spends dice to heal requires schemaVersion 2 and capabilityApi 1.330 or newer";
  assert.equal(getCapabilityPackageInstallIssue(manifest(329) as never, document()), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(330) as never, document()), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(329) as never, document(false)), gate);

  console.log("Rest dice: hit dice spent on a short rest heal, with the party's Song of Rest and the Teapot's +1.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
