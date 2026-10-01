import { expect, test, type Page } from "@playwright/test";
import { WORLD_STARTER_KITS, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/**
 * Elements in the setting's own words (worldgen W6c), on screen. A wuxia game's fight marks an aura in
 * the colour the kit gives that phase, and a special maneuver tells the Game Master the setting's own
 * five phases to name, never the classic or anyone else's elements.
 */

/** The player's message to the Game Master, captured; the Game Master's answer, when given, is stored
 *  as its turn. */
async function captureSent(page: Page, answer?: () => Promise<unknown>): Promise<() => string | null> {
  let sent: string | null = null;
  await page.route("**/api/generate", async (route) => {
    sent = JSON.stringify(route.request().postDataJSON());
    await answer?.();
    await route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' });
  });
  return () => sent;
}

test("a wuxia fight marks an aura in the phase's own colour and names its five phases to the Game Master", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "wuxia_xianxia")!);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  const created = await request.post("/api/game/create", {
    data: {
      name: "Five phases",
      setupConfig: {
        worldKit: parsed.kit,
        genre: "Wuxia",
        setting: "A river of sects",
        tone: "Adventure",
        difficulty: "normal",
        playerGoals: "Hold the ford",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "classic",
        combatDirector: false,
        gmBossControl: false,
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  try {
    const unit = (id: string, side: "player" | "enemy") => ({
      id,
      name: id,
      side,
      hp: 30,
      maxHp: 30,
      attack: 5,
      defense: 5,
      speed: 5,
      level: 1,
      skills: [],
    });
    const message = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "The river bandit raises his blade. [state: combat]" },
    });
    expect(message.ok()).toBeTruthy();
    const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameActiveState: "combat",
        gameImageAutoGenerationEnabled: false,
        gameStoryboardAutoIllustrationsEnabled: false,
        gameCombatStyle: "classic",
        gameCombatState: {
          party: [unit("Hero", "player")],
          enemies: [{ ...unit("River Bandit", "enemy"), elementAura: { element: "water", gauge: 1, sourceId: "gm" } }],
          itemEffects: [],
          mechanics: [],
          dialogueCues: [],
          startMessageId: (await message.json()).id,
          combatStyle: "classic",
        },
      },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();
    // The Game Master answers with an element in the setting's own word, which the screen reads as
    // that phase (Earth), never the classic alias the word once meant ("geo").
    const sent = await captureSent(page, () =>
      request.post(`/api/chats/${chatId}/messages`, {
        data: {
          role: "assistant",
          content: 'The ford heaves under him. [element_attack: element="Earth" target="Hero"]',
        },
      }),
    );
    await openGame(page, chatId);

    // The aura wears the kit's own colour for Water (#1e90ff), not the generic grey an unknown word gets.
    const aura = page.locator('[title="water aura (gauge: 1)"]').first();
    await expect(aura).toBeVisible({ timeout: 40_000 });
    await expect(aura).toHaveCSS("color", "rgb(30, 144, 255)");
    await page.screenshot({ path: testInfo.outputPath("wuxia-aura.png") });

    // A special maneuver names the setting's five phases to the Game Master.
    await page.getByRole("button", { name: "Special", exact: true }).first().click();
    await page
      .getByPlaceholder("I kick sand into the Ruin Guard's cracked lens, trying to blind it for a round.")
      .fill("I turn the river against him.");
    await page.getByRole("button", { name: "Ask GM", exact: true }).click();
    await expect.poll(sent, { timeout: 30_000 }).toContain("I turn the river against him.");
    expect(sent()).toContain('[element_attack: element=\\"wood|fire|earth|metal|water\\" target=\\"Exact Name\\"]');
    expect(sent()).not.toContain("pyro|hydro");
    const earth = page.locator('[title="earth aura (gauge: 1)"]').first();
    await expect(earth).toBeVisible({ timeout: 30_000 });
    await expect(earth).toHaveCSS("color", "rgb(160, 82, 45)");
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});
