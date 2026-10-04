// #7034: on a computer the chat's top controls (Game's Session, Volume, Assets and Game controls, the
// connected chat, Roleplay's package toolbars) are windows that minimize to buttons ("bubbles") you can
// place anywhere. Bubbles snap into line with each other, and their places save with the chat.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { openChatSettings } from "./chat-settings-tools.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const GAME_CONTROLS = "control:game";
const SESSION = "control:session";
const VOLUME = "control:volume";
const ASSETS = "control:assets";
const CONNECTED = "control:connected-chat";

async function createGameWithConnectedChat(request: APIRequestContext) {
  const created = await request.post("/api/chats", {
    data: { name: "Control windows game", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const game = (await created.json()) as { id: string };
  expect(
    (
      await request.patch(`/api/chats/${game.id}/metadata`, {
        data: {
          gameId: "control-windows-game",
          gameSessionStatus: "active",
          gameSessionNumber: 1,
          gameIntroPresented: true,
        },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post(`/api/chats/${game.id}/messages`, { data: { role: "assistant", content: "The game begins." } })
    ).ok(),
  ).toBeTruthy();
  const other = await request.post("/api/chats", {
    data: { name: "Control windows partner", mode: "conversation", characterIds: [] },
  });
  expect(other.ok()).toBeTruthy();
  const partner = (await other.json()) as { id: string };
  expect(
    (await request.post(`/api/chats/${game.id}/connect`, { data: { targetChatId: partner.id } })).ok(),
  ).toBeTruthy();
  return { gameId: game.id, partnerId: partner.id };
}

async function prepare(page: Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
  });
  await page.addInitScript(
    ({ chatId, version }) => {
      localStorage.setItem("marinara:whats-new:seen-version", version);
      localStorage.setItem("marinara-active-chat-id", chatId);
    },
    { chatId, version: APP_VERSION },
  );
}

function bubble(page: Page, id: string) {
  return page.locator(`.mari-window-bubble[data-window="${id}"]`);
}

function controlWindow(page: Page, id: string) {
  return page.locator(`.mari-window[data-window="${id}"]`);
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

/** Drags a bubble by its centre so its top-left lands at `to`; `hold` keeps the button down at the end. */
async function dragBubble(page: Page, target: Locator, to: { x: number; y: number }, options: { hold?: boolean } = {}) {
  const from = await box(target);
  const grab = { x: from.width / 2, y: from.height / 2 };
  await page.mouse.move(from.x + grab.x, from.y + grab.y);
  await page.mouse.down();
  await page.mouse.move(from.x + grab.x + 12, from.y + grab.y + 12, { steps: 3 });
  await page.mouse.move(to.x + grab.x, to.y + grab.y, { steps: 8 });
  // Let the last position paint (moves are applied on the next frame).
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (!options.hold) await page.mouse.up();
}

async function savedWindowLayout(request: APIRequestContext, chatId: string) {
  const chat = (await (await request.get(`/api/chats/${chatId}`)).json()) as { metadata?: unknown };
  const metadata =
    typeof chat.metadata === "string" ? (JSON.parse(chat.metadata) as Record<string, unknown>) : chat.metadata;
  return ((metadata as Record<string, unknown> | undefined)?.windowLayout ?? null) as {
    windows: Record<string, { minimized?: boolean; bubble?: { x: number; y: number } }>;
  } | null;
}

test.describe("chat control windows on desktop", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("desktop"), "Phones keep the chat's menus for these controls.");
  });

  test("controls minimize to bubbles that drag, snap, restore and stay with the chat", async ({
    page,
    request,
  }, testInfo) => {
    const { gameId, partnerId } = await createGameWithConnectedChat(request);
    try {
      await prepare(page, gameId);
      await page.goto("/");
      const game = page.locator('[data-chat-mode="game"]');
      await expect(game).toBeVisible({ timeout: 30_000 });

      // Every control starts as a bubble in a row at the top right, where its button was.
      const ids = [GAME_CONTROLS, SESSION, VOLUME, ASSETS, CONNECTED];
      for (const id of ids) {
        await expect(bubble(page, id)).toBeVisible();
        await expect(bubble(page, id)).toHaveAttribute("data-minimized", "true");
      }
      const row = await Promise.all(ids.map((id) => box(bubble(page, id))));
      for (const rect of row) expect(Math.abs(rect.y - row[0]!.y)).toBeLessThanOrEqual(1);
      expect(row.map((rect) => rect.x)).toEqual([...row.map((rect) => rect.x)].sort((a, b) => a - b));
      // The old buttons are gone from the chat's top right.
      await expect(game.locator('[data-tour="game-controls"] button').filter({ visible: true })).toHaveCount(0);
      await expect(bubble(page, VOLUME)).toHaveAccessibleName("Open Volume");
      await expect(bubble(page, VOLUME)).toHaveAttribute("title", "Click to open Volume, or drag to move this button.");

      // Custom themes restyle bubbles through the shared class and --mari-window-bubble-* variables.
      await page.addStyleTag({ content: ":root { --mari-window-bubble-bg: rgb(255, 0, 0); }" });
      await expect(bubble(page, VOLUME)).toHaveCSS("background-color", "rgb(255, 0, 0)");

      // Clicking a bubble opens its window beside it; minimize sends it back, with focus on the bubble.
      await bubble(page, VOLUME).click();
      const volume = controlWindow(page, VOLUME);
      await expect(volume).toBeVisible();
      await expect(volume.getByRole("slider").first()).toBeVisible();
      await expect(bubble(page, VOLUME)).toHaveCount(0);
      const controls = await volume
        .locator("[data-window-control]")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-window-control")));
      expect(controls).toEqual(["minimize", "pin", "lock", "close"]);
      await volume.locator('[data-window-control="minimize"]').click();
      await expect(volume).toHaveCount(0);
      await expect(bubble(page, VOLUME)).toBeFocused();
      // Enter opens it again; an unpinned window goes back to its bubble on a press elsewhere.
      await page.keyboard.press("Enter");
      await expect(volume).toBeVisible();
      await page.locator("[data-chat-mode='game']").click({ position: { x: 300, y: 400 } });
      await expect(volume).toHaveCount(0);
      await expect(bubble(page, VOLUME)).toBeVisible();

      // Dragging places a bubble anywhere; a short press still opens it.
      const start = await box(bubble(page, VOLUME));
      const placed = { x: start.x - 400, y: start.y + 260 };
      await dragBubble(page, bubble(page, VOLUME), placed);
      await expect(controlWindow(page, VOLUME)).toHaveCount(0);
      let moved = await box(bubble(page, VOLUME));
      expect(Math.abs(moved.x - placed.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(moved.y - placed.y)).toBeLessThanOrEqual(1);

      // Near another bubble it snaps: centres in line (a guide shows while it holds), and side by side a
      // steady 8px gap.
      await dragBubble(page, bubble(page, SESSION), { x: moved.x + 5, y: moved.y + 120 }, { hold: true });
      await expect(page.locator('.mari-window-snap-guide[data-axis="x"]')).toBeVisible();
      await page.mouse.up();
      await expect(page.locator(".mari-window-snap-guide")).toHaveCount(0);
      const session = await box(bubble(page, SESSION));
      expect(session.x).toBeCloseTo(moved.x, 0);
      expect(session.y).toBeCloseTo(moved.y + 120, 0);

      await dragBubble(page, bubble(page, ASSETS), { x: moved.x + moved.width + 3, y: moved.y - 4 });
      const assets = await box(bubble(page, ASSETS));
      expect(assets.x).toBeCloseTo(moved.x + moved.width + 8, 0);
      expect(assets.y).toBeCloseTo(moved.y, 0);

      // Holding Alt places it freely.
      await page.keyboard.down("Alt");
      await dragBubble(page, bubble(page, ASSETS), { x: moved.x + moved.width + 3, y: moved.y - 4 });
      await page.keyboard.up("Alt");
      const free = await box(bubble(page, ASSETS));
      expect(free.x).toBeCloseTo(moved.x + moved.width + 3, 0);
      expect(free.y).toBeCloseTo(moved.y - 4, 0);

      // Arrow keys move a focused bubble too (no snapping).
      await bubble(page, VOLUME).focus();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(async () => (await box(bubble(page, VOLUME))).x).toBeCloseTo(moved.x - 10, 0);
      moved = await box(bubble(page, VOLUME));
      await page.screenshot({ path: testInfo.outputPath("bubbles-placed.png"), animations: "disabled" });

      // Move Game controls and open the connected chat's window; both save with this chat.
      const gameControlsPlace = { x: moved.x, y: moved.y + 220 };
      await dragBubble(page, bubble(page, GAME_CONTROLS), gameControlsPlace);
      const gameControls = await box(bubble(page, GAME_CONTROLS));
      await bubble(page, CONNECTED).click();
      const connected = controlWindow(page, CONNECTED);
      await expect(connected.getByRole("button", { name: /^Switch to/u })).toBeVisible();
      await expect
        .poll(async () => {
          const layout = await savedWindowLayout(request, gameId);
          return [layout?.windows[GAME_CONTROLS]?.bubble ?? null, layout?.windows[CONNECTED]?.minimized ?? null];
        })
        .toEqual([{ x: gameControls.x, y: gameControls.y }, false]);

      await page.reload();
      await expect(page.locator('[data-chat-mode="game"]')).toBeVisible({ timeout: 30_000 });
      await expect(controlWindow(page, CONNECTED)).toBeVisible();
      const reloaded = await box(bubble(page, GAME_CONTROLS));
      expect(reloaded.x).toBeCloseTo(gameControls.x, 0);
      expect(reloaded.y).toBeCloseTo(gameControls.y, 0);
      await bubble(page, GAME_CONTROLS).click();
      await expect(controlWindow(page, GAME_CONTROLS).getByRole("button", { name: "Retry Turn" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("game-controls-window.png"), animations: "disabled" });

      // Reset View puts every bubble back in its row, minimized.
      const settings = await openChatSettings(page);
      await settings.locator('[data-chat-help="reset-view"]').click();
      for (const id of ids) await expect(bubble(page, id)).toBeVisible();
      const reset = await box(bubble(page, GAME_CONTROLS));
      expect(Math.abs(reset.y - row[0]!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(reset.x - row[0]!.x)).toBeLessThanOrEqual(1);
    } finally {
      await request.delete(`/api/chats/${gameId}?force=true`);
      await request.delete(`/api/chats/${partnerId}?force=true`);
    }
  });
});
