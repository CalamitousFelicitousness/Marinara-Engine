import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * The guided builder (Capability API 1.85): a ruleset's `sheet.builder` shows as a Guided view beside
 * All fields in a game's Edit sheet. Picks apply what they grant and unpicking takes it back, the
 * scores are rolled with the Engine's dice or bought, each step counts what it still waits on, and
 * the sheet saved is the build every other part of the Engine reads.
 */
function ruleset(id: string): string {
  const doc = JSON.parse(
    readFileSync(new URL("../docs/development/ruleset-5e-2014.example.json", import.meta.url), "utf8"),
  );
  doc.id = id;
  // A feature whose score choice repeats (1.92): +2 to one score or +1 to two.
  const feats = doc.catalogs.find((catalog: { id: string }) => catalog.id === "feats");
  feats.entries.find((entry: { id: string }) => entry.id === "sly-strike").grants = {
    abilities: { choose: [{ count: 2, amount: 1, repeat: true, upTo: 9 }] },
  };
  // Two features a step keeps one of (1.93): picking one drops the other.
  const sly = feats.entries.find((entry: { id: string }) => entry.id === "sly-strike");
  sly.exclusive = "knack";
  feats.entries.push({
    id: "steady-aim",
    label: "Steady Aim",
    filters: { level: 1 },
    exclusive: "knack",
    rows: [{ list: sly.rows[0].list, values: { name: "Steady Aim", text: "Take a breath before the shot." } }],
  });
  doc.catalogs.push(
    {
      id: "races",
      label: "Races",
      feeds: ["features"],
      filters: [{ id: "parent", label: "Race", type: "text" }],
      entries: [
        {
          id: "dwarf",
          label: "Dwarf",
          summary: "Stout and hardy, at home underground.",
          rows: [{ list: "features", values: { name: "Darkvision", text: "See in the dark." } }],
          grants: {
            abilities: { add: { con: 2 } },
            entries: { choose: [{ catalog: "tongues", count: 1, filters: { type: "standard" } }] },
          },
        },
        {
          id: "hill-dwarf",
          label: "Hill Dwarf",
          filters: { parent: "dwarf" },
          grants: { abilities: { add: { wis: 1 } } },
        },
        {
          id: "half-elf",
          label: "Half-Elf",
          grants: { abilities: { add: { cha: 2 }, choose: [{ count: 2, amount: 1, except: ["cha"] }] } },
        },
      ],
    },
    {
      id: "tongues",
      label: "Languages",
      feeds: ["features"],
      filters: [{ id: "type", label: "Type", type: "text" }],
      entries: [
        {
          id: "elvish",
          label: "Elvish",
          filters: { type: "standard" },
          rows: [{ list: "features", values: { name: "Elvish" } }],
        },
        {
          id: "giant",
          label: "Giant",
          filters: { type: "standard" },
          rows: [{ list: "features", values: { name: "Giant" } }],
        },
        {
          id: "abyssal",
          label: "Abyssal",
          filters: { type: "exotic" },
          rows: [{ list: "features", values: { name: "Abyssal" } }],
        },
      ],
    },
    {
      id: "classes",
      label: "Classes",
      entries: [
        {
          id: "fighter",
          label: "Fighter",
          grants: {
            trained: {
              saves: ["str_save", "con_save"],
              choose: [{ what: "skills", count: 2, from: ["acrobatics", "athletics", "perception", "survival"] }],
            },
            sets: { hit_die: "d10" },
          },
        },
      ],
    },
  );
  doc.sheet.builder = {
    tier: "proficient",
    steps: [
      { id: "race", label: "Race", kind: "catalog", catalog: "races", field: "race" },
      {
        id: "subrace",
        label: "Subrace",
        kind: "catalog",
        catalog: "races",
        min: 0,
        within: { step: "race", filter: "parent" },
      },
      { id: "class", label: "Class", kind: "catalog", catalog: "classes", field: "class" },
      { id: "level", label: "Level", kind: "fields", fields: ["level", "xp", "subclass"], optional: ["subclass"] },
      {
        id: "scores",
        label: "Ability Scores",
        kind: "abilities",
        methods: {
          pointBuy: {
            budget: 27,
            costs: [
              [8, 0],
              [9, 1],
              [10, 2],
              [11, 3],
              [12, 4],
              [13, 5],
              [14, 7],
              [15, 9],
            ],
          },
          standardArray: [15, 14, 13, 12, 10, 8],
          roll: { count: 4, sides: 6, keep: 3 },
          manual: true,
        },
        default: "pointBuy",
      },
      {
        id: "features",
        label: "Features",
        kind: "catalog",
        catalog: "feats",
        min: 0,
        max: 3,
        upTo: { filter: "level", value: { field: "level" } },
        countFrom: { field: "level" },
      },
      { id: "skills", label: "Proficiencies", kind: "trained" },
      { id: "languages", label: "Languages", kind: "choices", catalog: "tongues" },
    ],
  };
  return JSON.stringify(doc);
}

async function seedGame(request: APIRequestContext, rulesetId: string, characterId: string): Promise<string> {
  const created = await request.post("/api/chats", {
    data: { name: "Guided builder", mode: "game", characterIds: [characterId] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as { id: string };
  const sheet = { v: 1, build: {} };
  const meta = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: {
      gameId: `ruleset-builder-${rulesetId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
      gamePartyCharacterIds: [characterId],
      gameCharacterCards: [
        { name: "Ada", rulesetSheet: sheet },
        { name: "Bram", rulesetSheet: sheet },
      ],
      gameInventory: [],
    },
  });
  expect(meta.ok(), await meta.text()).toBeTruthy();
  const saved = await request.post(`/api/chats/${chat.id}/messages`, {
    data: { role: "assistant", content: "The road begins at the inn." },
  });
  expect(saved.ok()).toBeTruthy();
  return chat.id;
}

async function openSheetEditor(page: Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    rightPanelOpen: false,
    sidebarOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    gameInstantTextReveal: true,
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, appVersion: version },
  );
  await page.goto("/");
  const portrait = page.getByTitle("Bram - Click to open character sheet", { exact: true }).filter({ visible: true });
  const members = page.getByRole("button", { name: "Open party members", exact: true }).filter({ visible: true });
  await expect(portrait.or(members).first()).toBeVisible({ timeout: 30000 });
  if (await members.isVisible()) await members.click();
  await portrait.first().click();
  await page.getByRole("button", { name: "Edit sheet", exact: true }).last().click();
}

test("the guided builder applies picks, rolls and buys scores, and saves the sheet", async ({ page, request }) => {
  test.setTimeout(180000);
  const policyBefore = await request.get("/api/agents/import-policy");
  expect(policyBefore.ok(), await policyBefore.text()).toBeTruthy();
  const importsWereEnabled = (await policyBefore.json()).enabled === true;
  let chatId: string | undefined;
  let rulesetId: string | undefined;
  let characterId: string | undefined;
  try {
    const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
    expect(policy.ok(), await policy.text()).toBeTruthy();
    const imported = await request.post("/api/game-rulesets/import", {
      data: { definition: ruleset(`dnd-builder-e2e-${test.info().project.name}`) },
    });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    rulesetId = (await imported.json()).rulesetId as string;
    const character = await request.post("/api/characters", { data: { data: { name: "Bram" } } });
    expect(character.ok(), await character.text()).toBeTruthy();
    characterId = ((await character.json()) as { id: string }).id;
    chatId = await seedGame(request, rulesetId, characterId);
    await openSheetEditor(page, chatId);

    // Guided is where the editor opens, the steps across the top, each with what it waits on.
    await expect(page.getByRole("tab", { name: "Guided", exact: true })).toHaveAttribute("aria-selected", "true");
    const steps = page.getByRole("navigation", { name: "Character builder steps" });
    await expect(steps.getByRole("button", { name: "Race 1 choice left", exact: true })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(steps.getByRole("button", { name: "Subrace Nothing left to choose", exact: true })).toBeVisible();
    const summary = page.getByRole("complementary", { name: "Character" });

    // A new character opens on point buy, and features up to its level.
    await steps.getByRole("button", { name: /^Ability Scores/ }).click();
    await expect(page.getByRole("radio", { name: "Point buy" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("27 of 27 points left")).toBeVisible();
    await steps.getByRole("button", { name: /^Features/ }).click();
    await expect(page.getByRole("button", { name: "Select Sly Strike" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Second Effort" })).toHaveCount(0);
    // As many features as the level says (countFrom).
    await expect(page.getByText("Select one (0 selected)")).toBeVisible();
    await expect(steps.getByRole("button", { name: "Features 1 choice left", exact: true })).toBeVisible();
    // A score choice that repeats: one score twice, a minus takes one back. Then the feature goes again.
    await page.getByRole("button", { name: "Select Sly Strike" }).click();
    await steps.getByRole("button", { name: /^Ability Scores/ }).click();
    const twice = page.getByRole("group", { name: /Sly Strike: choose 2 scores/ });
    await twice.getByRole("button", { name: "Strength", exact: true }).click();
    // The choice stops at 9 (1.95): Strength 8 + 1 takes no more, though the choice has one left.
    await expect(twice.getByRole("button", { name: "Strength", exact: true })).toBeDisabled();
    await twice.getByRole("button", { name: "Dexterity", exact: true }).click();
    await expect(twice.getByRole("button", { name: "Constitution", exact: true })).toBeDisabled();
    await expect(steps.getByRole("button", { name: "Ability Scores 1 choice left", exact: true })).toBeVisible();
    await twice.getByRole("button", { name: "Take back one from Strength", exact: true }).click();
    await expect(twice.getByRole("button", { name: "Strength", exact: true })).toBeEnabled();
    await steps.getByRole("button", { name: /^Features/ }).click();
    // Steady Aim shares Sly Strike's group: picking it replaces Sly Strike, full step or not.
    await page.getByRole("button", { name: "Select Steady Aim", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove Steady Aim", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Sly Strike", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove Steady Aim", exact: true }).click();
    await expect(page.getByText("Select one (0 selected)")).toBeVisible();
    await steps.getByRole("button", { name: /^Race/ }).click();

    // A race: its info, its increase, its field.
    await page.getByRole("button", { name: "Show what Dwarf is" }).click();
    await expect(page.getByText("Stout and hardy, at home underground.")).toBeVisible();
    await page.getByRole("button", { name: "Select Dwarf" }).click();
    await expect(steps.getByRole("button", { name: "Race Nothing left to choose", exact: true })).toBeVisible();
    await expect(summary.getByText("Dwarf", { exact: true })).toBeVisible();
    // The dwarf's language of choice: a standard one, at the Languages step.
    await expect(steps.getByRole("button", { name: "Languages 1 choice left", exact: true })).toBeVisible();
    await steps.getByRole("button", { name: /^Languages/ }).click();
    const tongues = page.getByRole("group", { name: /Dwarf: choose 1/ });
    await expect(tongues.getByRole("button", { name: "Abyssal", exact: true })).toHaveCount(0);
    await tongues.getByRole("button", { name: "Elvish", exact: true }).click();
    await expect(tongues.getByRole("button", { name: "Giant", exact: true })).toBeDisabled();
    await expect(steps.getByRole("button", { name: "Languages Nothing left to choose", exact: true })).toBeVisible();
    await steps.getByRole("button", { name: /^Race/ }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Select Hill Dwarf" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Select Fighter" }).click();
    await expect(summary.getByText("Fighter", { exact: true })).toBeVisible();
    await expect(steps.getByRole("button", { name: "Proficiencies 2 choices left", exact: true })).toBeVisible();
    // A fields step waits on nothing optional, and the summary shows the sheet's own summary numbers.
    await expect(steps.getByRole("button", { name: "Level Nothing left to choose", exact: true })).toBeVisible();
    await expect(summary.getByText("Proficiency bonus", { exact: true })).toBeVisible();
    await expect(summary.getByText("Armor Class", { exact: true })).toBeVisible();
    await expect(summary.getByText("Spell save DC", { exact: true })).toHaveCount(0);

    // Scores: rolled with the Engine's dice and handed out, then bought instead.
    await page.getByRole("button", { name: /^Ability Scores/ }).click();
    await page.getByRole("radio", { name: "Dice roll" }).click();
    let rolls = 0;
    page.on("response", (response) => {
      if (response.url().includes("/api/game/dice/roll")) rolls += 1;
    });
    await page.getByRole("button", { name: "Roll scores (4d6, keep 3)" }).click();
    await expect(page.getByRole("button", { name: "Roll again (4d6, keep 3)" })).toBeVisible();
    await expect.poll(() => rolls).toBe(6);
    const rolled = (await page.getByText(/^Rolled: /).textContent())!.replace("Rolled: ", "").split(", ").map(Number);
    expect(rolled).toHaveLength(6);
    for (const value of rolled) expect(value >= 3 && value <= 18).toBe(true);
    await page.getByRole("combobox", { name: "Base score for Constitution" }).selectOption("0");
    await expect(summary.getByText(String(rolled[0]! + 2), { exact: true }).first()).toBeVisible();
    await expect(steps.getByRole("button", { name: "Ability Scores 5 choices left", exact: true })).toBeVisible();

    await page.getByRole("radio", { name: "Point buy" }).click();
    await expect(page.getByText("27 of 27 points left")).toBeVisible();
    for (let i = 0; i < 7; i++) await page.getByRole("button", { name: "Raise Strength" }).click();
    await expect(page.getByText("18 of 27 points left")).toBeVisible();
    await expect(page.getByRole("button", { name: "Raise Strength" })).toBeDisabled();

    // A different race takes back the dwarf's increases, its row and the subrace, and offers a choice.
    await page.getByRole("button", { name: /^Race/ }).click();
    await page.getByRole("button", { name: "Select Half-Elf" }).click();
    await expect(steps.getByRole("button", { name: "Ability Scores 3 choices left", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Ability Scores/ }).click();
    const choice = page.getByRole("group", { name: /Half-Elf: choose 2 scores, \+1 each/ });
    await choice.getByRole("button", { name: "Dexterity", exact: true }).click();
    await choice.getByRole("button", { name: "Wisdom", exact: true }).click();
    await expect(choice.getByRole("button", { name: "Intelligence", exact: true })).toBeDisabled();
    await expect(choice.getByRole("button", { name: "Charisma", exact: true })).toHaveCount(0);

    // The class's skills, at the Proficiencies step.
    await page.getByRole("button", { name: /^Proficiencies/ }).click();
    const skills = page.getByRole("group", { name: /Fighter: choose 2 skills/ });
    await skills.getByRole("button", { name: "Athletics", exact: true }).click();
    await skills.getByRole("button", { name: "Perception", exact: true }).click();
    await expect(
      steps.getByRole("button", { name: "Proficiencies Nothing left to choose", exact: true }),
    ).toBeVisible();

    // All fields shows the same sheet.
    await page.getByRole("tab", { name: "All fields", exact: true }).click();
    await expect(page.locator('input[aria-label="Strength"]')).toHaveValue("15");
    await expect(page.locator('input[aria-label="Charisma"]')).toHaveValue("10");

    // A level raised in All fields offers a feature; lowered there, it takes the feature back at once.
    const level = page.locator('input[aria-label="Level"]');
    await level.fill("2");
    await level.press("Tab");
    await page.getByRole("tab", { name: "Guided", exact: true }).click();
    await steps.getByRole("button", { name: /^Features/ }).click();
    await expect(page.getByText("Select up to 2 (0 selected)")).toBeVisible();
    await page.getByRole("button", { name: "Select Second Effort" }).click();
    await page.getByRole("tab", { name: "All fields", exact: true }).click();
    const featureName = page.locator('input[aria-label="Features and traits 1: Name"]');
    await expect(featureName).toHaveValue("Second Effort");
    await level.fill("1");
    await level.press("Tab");
    await expect(featureName).toHaveCount(0);

    await page.getByRole("button", { name: "Save sheet", exact: true }).click();
    await expect
      .poll(async () => {
        const row = await (await request.get(`/api/chats/${chatId}`)).json();
        const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
        const bram = (meta.gameCharacterCards as Array<{ name: string; rulesetSheet?: any }>).find(
          (card) => card.name === "Bram",
        );
        const build = bram?.rulesetSheet?.build;
        return build
          ? {
              abilities: build.abilities,
              race: build.fields.race,
              class: build.fields.class,
              hitDie: build.fields.hit_die,
              saves: build.saves,
              skills: build.skills,
              rows: (build.lists.features ?? []).filter((row: { _catalog?: string }) => row._catalog).length,
              method: bram.rulesetSheet.builder?.method,
            }
          : null;
      })
      .toEqual({
        abilities: { str: 15, dex: 9, con: 8, int: 8, wis: 9, cha: 10 },
        race: "Half-Elf",
        class: "Fighter",
        hitDie: "d10",
        saves: { str_save: "proficient", con_save: "proficient" },
        skills: { athletics: "proficient", perception: "proficient" },
        rows: 0,
        method: "pointBuy",
      });
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`);
    if (rulesetId) await request.delete(`/api/game-rulesets?rulesetId=${encodeURIComponent(rulesetId)}&force=true`);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
    const restored = await request.patch("/api/agents/import-policy", { data: { enabled: importsWereEnabled } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});
