// A Tracker Panel set to float sits over the chat at its own width, wider than the gutter beside the
// column. The Chat Settings button and the chat tool buttons place themselves by the panel's clearance,
// so that clearance has to be the width the panel is drawn at, or the panel covers them.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({ reducedMotion: "reduce" });

async function createChat(request: APIRequestContext) {
  const response = await request.post("/api/chats", {
    data: { name: "Floating Tracker Panel", mode: "roleplay", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  const patched = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: { enableAgents: true, activeAgentIds: ["world-state", "persona-stats"] },
  });
  expect(patched.ok()).toBeTruthy();
  return chat;
}

async function openChat(page: Page, chatId: string, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    chatSettingsMoveTipDismissed: true,
    appAccentPulseMode: false,
    trackerPanelEnabled: true,
    trackerPanelOpen: true,
    trackerPanelOpenByChatId: { [chatId]: true },
    trackerPanelSide: "right",
    trackerPanelWidth: 420,
    trackerPanelPlacement: "float",
  });
  await page.addInitScript(
    ({ chatId, version }) => {
      localStorage.setItem("marinara-active-chat-id", chatId);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { chatId, version },
  );
  await page.goto("/");
  await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
}

const rect = (locator: Locator) =>
  locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

for (const width of [1024, 1440]) {
  test(`a floating Tracker Panel leaves the chat's buttons uncovered at ${width}px`, async ({
    page,
    request,
  }, info) => {
    test.skip(!info.project.name.includes("desktop"), "The floating Tracker Panel is a computer layout.");
    const chat = await createChat(request);
    try {
      await openChat(page, chat.id, width);
      const panel = page.locator('[data-component="TrackerDataSidebarDesktop.right"]');
      await expect(panel).toBeVisible();
      await expect(async () => {
        const box = await rect(panel);
        const buttons = page.locator(".mari-window-bubble:visible");
        expect(await buttons.count()).toBeGreaterThan(0);
        for (const button of await buttons.all()) {
          const label = await button.getAttribute("aria-label");
          expect(overlaps(await rect(button), box), `${label} is covered by the panel`).toBe(false);
        }
      }).toPass({ timeout: 10_000 });
      await page.screenshot({ path: info.outputPath(`floating-${width}.png`), animations: "disabled" });
    } finally {
      await request.delete(`/api/chats/${chat.id}`);
    }
  });
}
