// On a computer the Tracker Panel is the only place trackers show. Upstream's Trackers window, which takes
// over while the panel is closed, never mounts, and neither does its button, its popped-out drawers or the
// World State banner.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

type PageUiStoreModule = {
  useUIStore: {
    getState: () => {
      trackerPanelEnabled: boolean;
      trackerPanelOpen: boolean;
      trackerPanelOpenByChatId: Record<string, boolean>;
    };
  };
};

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({ reducedMotion: "reduce" });

async function createChat(request: APIRequestContext) {
  const response = await request.post("/api/chats", {
    data: { name: "Tracker Panel only", mode: "roleplay", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: { enableAgents: true, activeAgentIds: ["world-state", "character-tracker"] },
  });
  expect(metadata.ok()).toBeTruthy();
  const state = await request.patch(`/api/chats/${chat.id}/game-state`, {
    data: {
      manual: true,
      location: "Ironhold",
      weather: "Snow",
      presentCharacters: [{ characterId: "thrum", name: "Thrum", emoji: "🧔", mood: "determined" }],
    },
  });
  expect(state.ok()).toBeTruthy();
  return chat;
}

async function openChat(page: Page, chatId: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    chatSettingsMoveTipDismissed: true,
    appAccentPulseMode: false,
    trackerPanelEnabled: false,
    trackerPanelOpen: false,
    trackerPanelSide: "right",
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

test("trackers show only in the Tracker Panel, which the Chat Settings dice opens and closes", async ({
  page,
  request,
}, info) => {
  test.skip(!info.project.name.includes("desktop"), "Phones never had the Trackers window.");
  const chat = await createChat(request);
  try {
    await openChat(page, chat.id);
    // Upstream's window and its button both carry the window id; popped-out drawers carry it as their host.
    const trackersSurfaces = page.locator('[data-window="trackers"], [data-window^="drawer:trackers:"]');
    const panel = page.locator('[data-component="TrackerDataSidebarDesktop.right"]');
    const openPanels = page.locator('[data-component^="TrackerDataSidebar"]:visible');
    const ui = () =>
      page.evaluate(async (chatId) => {
        const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
        const state = module.useUIStore.getState();
        return [state.trackerPanelEnabled, state.trackerPanelOpen, state.trackerPanelOpenByChatId[chatId]];
      }, chat.id);

    await page.locator("[data-chat-settings-button]").click();
    const settings = page.locator('[data-window="chat-settings"]');
    await expect(settings.locator("[data-chat-settings-section]").first()).toBeVisible();
    await expect(trackersSurfaces).toHaveCount(0);
    await expect(openPanels).toHaveCount(0);

    const dice = settings.getByRole("button", { name: "Tracker Panel", exact: true });
    await dice.click();
    await expect(dice).toHaveAttribute("aria-pressed", "true");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Thrum").filter({ visible: true }).first()).toBeVisible();
    expect(await ui()).toEqual([true, true, true]);

    await dice.click();
    await expect(dice).toHaveAttribute("aria-pressed", "false");
    await expect(openPanels).toHaveCount(0);
    expect(await ui()).toEqual([true, false, false]);
    await expect(trackersSurfaces).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
