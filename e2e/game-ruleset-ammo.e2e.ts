import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { DirectedCombatView } from "../packages/shared/src/features/combat-director.js";
import { inventoryButton } from "./game-inventory-fixture.js";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Ammunition and reloading (#6871), on screen. In an Ember Roads game Juno holds her hunting bow and
 * carries three arrows: the bow's details say what it shoots, a ruleset fight offers it with what is
 * left to shoot, a shot of two drops the moth, and the arrow picked up after the won fight goes back
 * into the saved inventory with the rest of that step. In a Gravewatch game Ada's
 * watch pistol was emptied in an earlier fight: the menu offers a reload instead of a shot, and
 * reloading loads a ball out of her shot and powder, kept on the pistol's stack.
 */

interface Seeded {
  chatId: string;
  rulesetId: string;
  anchor: string;
}

async function seedFight(
  request: APIRequestContext,
  doc: Record<string, any>,
  game: { name: string; genre: string; setting: string; tone: string },
  metadata: Record<string, unknown>,
  live: Record<string, unknown>,
  opening: string,
): Promise<Seeded> {
  const imported = await request.post("/api/game-rulesets/import", { data: { definition: JSON.stringify(doc) } });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  const rulesetId = (await imported.json()).rulesetId as string;
  const created = await request.post("/api/game/create", {
    data: {
      name: game.name,
      setupConfig: {
        genre: game.genre,
        setting: game.setting,
        tone: game.tone,
        difficulty: "normal",
        playerGoals: "Get through",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "classic",
        combatDirector: true,
        gmBossControl: false,
        ruleset: { id: rulesetId, version: doc.version ?? 1, packageId: null, options: {} },
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
    data: {
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameImageAutoGenerationEnabled: false,
      gameStoryboardAutoIllustrationsEnabled: false,
      enableAgents: false,
      ...metadata,
    },
  });
  expect(meta.ok(), await meta.text()).toBeTruthy();
  const seeded = await request.patch(`/api/chats/${chatId}/game-state`, {
    data: { manual: true, location: game.setting, rulesetLive: live },
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const message = await request.post(`/api/chats/${chatId}/messages`, {
    data: { role: "assistant", content: opening },
  });
  expect(message.ok(), await message.text()).toBeTruthy();
  return { chatId, rulesetId, anchor: (await message.json()).id as string };
}

async function startFight(
  request: APIRequestContext,
  seeded: Seeded,
  member: string,
  enemy: { id: string; name: string; creature: string },
): Promise<void> {
  const party = {
    id: member.toLowerCase(),
    name: member,
    side: "player",
    hp: 40,
    maxHp: 40,
    attack: 8,
    defense: 4,
    speed: 5,
    level: 2,
  };
  const foe = { ...enemy, side: "enemy", hp: 12, maxHp: 12, attack: 5, defense: 4, speed: 6, level: 1 };
  const start = await request.post("/api/game/combat/director/start", {
    data: { chatId: seeded.chatId, anchor: seeded.anchor, style: "ruleset", party: [party], enemies: [foe] },
  });
  expect(start.ok(), await start.text()).toBeTruthy();
  const session: DirectedCombatView = (await start.json()).session;
  expect(session.style).toBe("ruleset");
  expect(session.ruleset?.order[0], `${member} acts first, so a turn of theirs is reached`).toBe(party.id);
  const combat = await request.patch(`/api/chats/${seeded.chatId}/metadata`, {
    data: {
      gameActiveState: "combat",
      gameCombatState: {
        party: [party],
        enemies: [foe],
        itemEffects: [],
        mechanics: [],
        dialogueCues: [],
        startMessageId: seeded.anchor,
        combatStyle: "classic",
      },
    },
  });
  expect(combat.ok(), await combat.text()).toBeTruthy();
}

async function openGame(page: Page, chatId: string): Promise<void> {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["game"],
    gameInstantTextReveal: true,
    weatherEffects: false,
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, appVersion: version },
  );
  await page.goto("/");
}

async function savedInventory(request: APIRequestContext, chatId: string) {
  const row = await (await request.get(`/api/chats/${chatId}`)).json();
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  return metadata.gameInventory as Array<{ id: string; quantity: number; loaded?: number }>;
}

/** Imports on for the length of one test, and back to how they were. */
async function withImports(request: APIRequestContext, run: (cleanup: Seeded[]) => Promise<void>): Promise<void> {
  const policyBefore = await request.get("/api/agents/import-policy");
  expect(policyBefore.ok(), await policyBefore.text()).toBeTruthy();
  const importsWereEnabled = (await policyBefore.json()).enabled === true;
  const cleanup: Seeded[] = [];
  try {
    const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
    expect(policy.ok(), await policy.text()).toBeTruthy();
    await run(cleanup);
  } finally {
    for (const seeded of cleanup) {
      await request.delete(`/api/chats/${seeded.chatId}`);
      await request.delete(`/api/game-rulesets?rulesetId=${encodeURIComponent(seeded.rulesetId)}&force=true`);
    }
    const restored = await request.patch("/api/agents/import-policy", { data: { enabled: importsWereEnabled } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
}

test("a bow shoots what its archer carries, and a won fight picks some of it up", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"));
  doc.id = "ember-ammo-e2e";
  // The moth is slow tonight and falls to one hit, so Juno's first shot ends the fight; and this bow
  // looses two arrows at once, so half of what it shot is a whole arrow to pick up.
  const trouble = doc.catalogs.find((catalog: { id: string }) => catalog.id === "road_trouble");
  const moth = trouble.entries.find((entry: { id: string }) => entry.id === "cinder-moth").creature;
  moth.initiativeModifier = -20;
  moth.health = 1;
  const outfitter = doc.catalogs.find((catalog: { holds?: string }) => catalog.holds === "items");
  outfitter.entries.find((entry: { id: string }) => entry.id === "hunting-bow").item.attack.ammo.perAttack = 2;
  await withImports(request, async (cleanup) => {
    const seeded = await seedFight(
      request,
      doc,
      { name: "Arrows", genre: "Fantasy", setting: "The road", tone: "Adventure" },
      {
        gameCharacterCards: [
          {
            name: "Juno",
            rulesetSheet: {
              v: 1,
              build: { abilities: { brawn: 1, wits: 3, heart: 0 }, fields: { toughness: 6 }, lists: {} },
            },
          },
        ],
        gameInventory: [
          { id: "st-bow", name: "Hunting bow", quantity: 1, item: "outfitter/hunting-bow", equipped: true },
          { id: "st-arrows", name: "Arrows", quantity: 3, item: "outfitter/arrows" },
        ],
      },
      { juno: { pools: { grit: { value: 11 } } } },
      "Wings beat in the dark ahead of the lantern.",
    );
    cleanup.push(seeded);
    await openGame(page, seeded.chatId);
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("Wings beat", {
      timeout: 30_000,
    });

    // The bow says what it shoots.
    await inventoryButton(page).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Hunting bow, worn", exact: true }).click();
    await expect(
      page.getByText("Ammunition: Arrow, 2 an attack, 50% picked up after a won fight", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ruleset-ammo-details.png") });

    await startFight(request, seeded, "Juno", {
      id: "moth",
      name: "Cinder-moth",
      creature: "road_trouble/cinder-moth",
    });
    await page.goto("/");
    const bow = page.getByRole("button", { name: /Hunting bow/ });
    await expect(bow).toBeVisible({ timeout: 60_000 });
    await expect(bow).toContainText("3 to shoot");
    await bow.click();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/game/combat/director/command") && r.request().postDataJSON().command.type === "ruleset",
    );
    await page.getByRole("button", { name: /Cinder-moth/ }).click();
    const shot = await response;
    expect(shot.ok(), await shot.text()).toBeTruthy();
    const fight = page.getByRole("region", { name: "Combat decisions" });
    await expect(fight.getByText("Hunting bow: 1 left to shoot.", { exact: true })).toBeVisible();
    await expect(fight.getByText("Juno picks up 1 of their Arrows after the fight.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ruleset-ammo-shot.png"), fullPage: true });
    // Two shot and one picked up, written with the step that shot them.
    await expect
      .poll(
        async () => (await savedInventory(request, seeded.chatId)).find((stack) => stack.id === "st-arrows")?.quantity,
      )
      .toBe(2);
  });
});

test("an empty pistol is reloaded from the fight menu, and stays loaded on its stack", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"));
  doc.id = "gravewatch-ammo-e2e";
  const night = doc.catalogs.find((catalog: { id: string }) => catalog.id === "night");
  night.entries.find((entry: { id: string }) => entry.id === "grave-rats").creature.initiativeModifier = -20;
  await withImports(request, async (cleanup) => {
    const seeded = await seedFight(
      request,
      doc,
      { name: "Shot and powder", genre: "Horror", setting: "The old plots", tone: "Grim" },
      {
        gameCharacterCards: [
          {
            name: "Ada",
            rulesetSheet: { v: 1, build: { abilities: { sinew: 2, nerve: 3, warmth: 2 }, fields: {}, lists: {} } },
          },
        ],
        gameInventory: [
          { id: "st-pistol", name: "Watch pistol", quantity: 1, item: "kit/watch-pistol", equipped: true, loaded: 0 },
          { id: "st-shot", name: "Shot and powder", quantity: 3, item: "kit/shot-and-powder" },
        ],
      },
      {},
      "Something stirs between the graves.",
    );
    cleanup.push(seeded);
    // The pistol's details say it is empty, as its stack keeps it.
    await openGame(page, seeded.chatId);
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("Something stirs", {
      timeout: 30_000,
    });
    await inventoryButton(page).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Watch pistol, worn", exact: true }).click();
    await expect(page.getByText("Holds 1, reload (Act)", { exact: false })).toBeVisible();
    await expect(page.getByText("0 of 1 loaded", { exact: true })).toBeVisible();

    await startFight(request, seeded, "Ada", { id: "rats", name: "Grave-rat swarm", creature: "night/grave-rats" });
    await page.goto("/");

    // Emptied last time: no shot, and a reload that says what it holds.
    const reload = page.getByRole("button", { name: /^Reload Watch pistol/ });
    await expect(reload).toBeVisible({ timeout: 60_000 });
    await expect(reload).toContainText("0 of 1 loaded · 3 to load");
    await expect(page.getByRole("button", { name: /^Watch pistol/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("ruleset-ammo-empty.png"), fullPage: true });
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/game/combat/director/command") && r.request().postDataJSON().command.type === "ruleset",
    );
    await reload.click();
    const loaded = await response;
    expect(loaded.ok(), await loaded.text()).toBeTruthy();
    const fight = page.getByRole("region", { name: "Combat decisions" });
    await expect(fight.getByText("Ada loads 1 into Watch pistol: 1 of 1 loaded.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ruleset-ammo-reload.png"), fullPage: true });
    await expect
      .poll(async () =>
        (await savedInventory(request, seeded.chatId)).map((stack) => [stack.id, stack.quantity, stack.loaded ?? null]),
      )
      .toEqual([
        ["st-pistol", 1, 1],
        ["st-shot", 2, null],
      ]);
  });
});
