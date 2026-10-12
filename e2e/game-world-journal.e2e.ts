import { expect, test, type Page } from "@playwright/test";
import { WORLD_GENERATOR_VERSION, WORLD_STARTER_KITS, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";
import { openChatTool } from "./chat-settings-tools.js";

/**
 * The World tab (worldgen W7), on screen: a world game's journal shows where the party is, its standing
 * and its deeds, as the replies have left the world.
 */

const parsedKit = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "high_fantasy")!);
if (!parsedKit.ok) throw new Error("The high fantasy kit does not read");
const kit = parsedKit.kit;
const brief = {
  briefVersion: 1 as const,
  premise: "The old king is dying and the river provinces quarrel over the succession.",
  places: [
    { name: "Aldmark", layer: "realm", tags: [] },
    { name: "The Fenlands", layer: "province", parent: "Aldmark", tags: [] },
    { name: "Hollin", layer: "settlement", parent: "The Fenlands", size: "village", tags: [], start: true as const },
    { name: "Thornmere", layer: "settlement", parent: "The Fenlands", size: "city", tags: ["port"] },
  ],
  placeNames: [{ culture: kit.cultures[0]!.id, names: ["Ashby", "Wending", "Calder", "Ravel", "Brennock", "Sallow"] }],
  groups: [{ name: "The Reed Wardens", kind: kit.groupKinds[0]!.id, seat: "Hollin" }],
  peopleNames: [] as Array<{ culture: string; given: string[]; family: string[]; order: "given-family" }>,
  events: [],
};

/** The Session window's journal, opened from its bubble (or the phone's Chat tools menu). */
async function openJournal(page: Page) {
  await expect(
    page.locator('.mari-window-bubble[data-window="control:session"], [data-chat-tools-menu-button]').first(),
  ).toBeVisible({ timeout: 40_000 });
  const session = await openChatTool(page, "control:session");
  await session.getByRole("button", { name: "Journal", exact: true }).click();
}

test("a world game's journal has a World tab with where the party is, its standing and its deeds", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/chats", { data: { name: "World journal", mode: "game", characterIds: [] } });
  expect(created.ok()).toBeTruthy();
  const chatId = ((await created.json()) as { id: string }).id;
  try {
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `world-journal-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld: { seed: 20261002, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    // The replies as the Engine answered them: the party in Hollin, an alliance there, then a move.
    for (const content of [
      'Mist lies on the reeds around Hollin. [place: name="Hollin" result="ok"]',
      'The wardens cheer. [world: deed="ally" group="The Reed Wardens" result="ok"] [world: deed="improve" place="Hollin" note="mended the dikes" result="ok"]',
      'The boat noses into Thornmere. [place: name="Thornmere" result="ok"]',
    ]) {
      expect((await request.post(`/api/chats/${chatId}/messages`, { data: { role: "assistant", content } })).ok()).toBe(
        true,
      );
    }
    await openGame(page, chatId);
    await openJournal(page);
    await page.getByRole("button", { name: "World", exact: true }).click();

    const where = page.getByRole("heading", { name: "Where you are" });
    await expect(where).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Thornmere › The Fenlands › Aldmark/u)).toBeVisible();
    await expect(page.getByText("The Reed Wardens", { exact: true })).toBeVisible();
    // One alliance while the party is unknown counts for half: on good terms, not yet trusted.
    await expect(page.getByText("On good terms", { exact: true })).toBeVisible();
    await expect(page.getByText(/mended the dikes/u)).toBeVisible();
    await expect(page.getByRole("heading", { name: "The past" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("world-tab.png") });
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

test("a game without a world has no World tab", async ({ page, request }) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/chats", { data: { name: "No world", mode: "game", characterIds: [] } });
  expect(created.ok()).toBeTruthy();
  const chatId = ((await created.json()) as { id: string }).id;
  try {
    await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `no-world-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
      },
    });
    await request.post(`/api/chats/${chatId}/messages`, { data: { role: "assistant", content: "Rain on the road." } });
    await openGame(page, chatId);
    await openJournal(page);
    await expect(page.getByRole("button", { name: "Notes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "World", exact: true })).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});
