// #7034 step 5: with the Tracker Panel on, a Roleplay chat's trackers live only in the panel; with it off they
// live in a movable Tracker window (one drawer per tracker). Both carry an Agent activity section.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

async function createTrackerChat(request: APIRequestContext) {
  const response = await request.post("/api/chats", {
    data: { name: "Tracker window chat", mode: "roleplay", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: { enableAgents: true, activeAgentIds: ["world-state", "persona-stats", "custom-tracker"] },
  });
  expect(metadata.ok()).toBeTruthy();
  const state = await request.patch(`/api/chats/${chat.id}/game-state`, {
    data: {
      manual: true,
      location: "Harbor market",
      time: "Evening",
      personaStats: [{ name: "Stamina", value: 6, max: 10, color: "#22c55e" }],
      playerStats: {
        stats: [],
        attributes: null,
        skills: {},
        inventory: [],
        activeQuests: [],
        status: "",
        customTrackerFields: [{ name: "Health", value: "Fine" }],
      },
    },
  });
  expect(state.ok()).toBeTruthy();
  return chat;
}

async function prepare(page: Page, chatId: string, ui: Record<string, unknown>) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    ...ui,
  });
  await page.addInitScript(
    ({ chatId, version }) => {
      localStorage.setItem("marinara:whats-new:seen-version", version);
      localStorage.setItem("marinara-active-chat-id", chatId);
    },
    { chatId, version: APP_VERSION },
  );
}

async function openChatSettings(page: Page) {
  await page.locator('[data-component="TopBar"]').getByRole("button", { name: "Chat Settings", exact: true }).click();
  const settings = page.locator('[data-window="chat-settings"]');
  await expect(settings.locator("[data-chat-settings-section]").first()).toBeVisible();
  return settings;
}

test.describe("Roleplay trackers on desktop", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("desktop"), "Phones keep the tracker strip until the mobile step.");
  });

  test("with the Tracker Panel on, trackers show only in the panel, which has Agent activity", async ({
    page,
    request,
  }) => {
    const chat = await createTrackerChat(request);
    try {
      await prepare(page, chat.id, {
        trackerPanelEnabled: true,
        trackerPanelOpen: true,
        trackerPanelOpenByChatId: { [chat.id]: true },
      });
      await page.goto("/");
      const panel = page.locator('[data-component="TrackerDataSidebar"]:visible');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByRole("button", { name: /^Location: Harbor market/ })).toBeVisible();

      // Nothing else on screen repeats the trackers: no Tracker window and no tracker icons in the HUD row.
      await expect(page.locator('[data-window="trackers"]')).toHaveCount(0);
      const hud = page.locator('[data-tracker-panel-anchor="roleplay-hud"]').filter({ visible: true });
      // Agent activity has no button there either: it is in the panel, the Tracker window and Chat Settings.
      await expect(hud.getByRole("button", { name: /^Agents & Actions/ })).toHaveCount(0);
      for (const title of ["World State", "Persona Stats", "Custom Tracker"]) {
        await expect(hud.locator(`[title="${title}"]`).filter({ visible: true })).toHaveCount(0);
      }

      const activity = panel.locator('[data-tracker-section="agent-activity"]');
      const header = activity.getByRole("button", { name: /Agent activity/i });
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(activity.locator('[data-component="AgentActivitySection"]')).toHaveCount(0);
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      const section = activity.locator('[data-component="AgentActivitySection"]');
      await expect(section.getByRole("button", { name: "Clear Trackers", exact: true })).toBeVisible();
      await expect(section.getByRole("button", { name: /^Re-run Trackers/ })).toBeEnabled();
      await header.click();
      await expect(section).toHaveCount(0);

      // Chat Settings offers the Tracker Panel switch, not the Tracker window one.
      const settings = await openChatSettings(page);
      await expect(settings.locator('[data-tracker-panel-toggle="chat-settings"]')).toBeVisible();
      await expect(settings.locator('[data-tracker-window-toggle="chat-settings"]')).toHaveCount(0);
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("with the Tracker Panel off, trackers show in a Tracker window with a drawer each", async ({
    page,
    request,
  }) => {
    const chat = await createTrackerChat(request);
    try {
      await prepare(page, chat.id, { trackerPanelEnabled: false, trackerPanelOpen: false });
      await page.goto("/");
      const trackerWindow = page.locator('[data-window="trackers"]');
      await expect(trackerWindow).toBeVisible({ timeout: 30_000 });
      await expect(trackerWindow).toHaveAttribute("data-pinned", "true");
      await expect(trackerWindow).toHaveAttribute("data-locked", "false");
      // The window opened by itself, so focus stays where it was.
      expect(await trackerWindow.evaluate((element) => element.contains(document.activeElement))).toBe(false);
      await expect(page.locator('[data-component="TrackerDataSidebar"]')).toHaveCount(0);
      const hud = page.locator('[data-tracker-panel-anchor="roleplay-hud"]').filter({ visible: true });
      await expect(hud.locator('[title="Persona Stats"]').filter({ visible: true })).toHaveCount(0);

      // One drawer per tracker, open by default with the full box; collapsed, each shows its miniature.
      const world = trackerWindow.locator('[data-drawer="tracker-world"]');
      const persona = trackerWindow.locator('[data-drawer="tracker-persona"]');
      const custom = trackerWindow.locator('[data-drawer="tracker-custom"]');
      for (const drawer of [world, persona, custom]) await expect(drawer).toBeVisible();
      await expect(world.getByText("Harbor market", { exact: true })).toBeVisible();
      await expect(custom.getByRole("button", { name: "Health", exact: true })).toBeVisible();
      await expect(world.locator(".mari-drawer__summary")).toHaveCount(0);

      await custom.locator(".mari-drawer__header").click();
      await expect(custom.getByRole("button", { name: "Health", exact: true })).toHaveCount(0);
      await expect(custom.locator(".mari-drawer__summary")).toHaveText("Health: Fine");
      await world.locator(".mari-drawer__header").click();
      await expect(world.getByText("Harbor market", { exact: true })).toHaveCount(0);
      await expect(world.locator(".mari-drawer__summary svg").first()).toBeVisible();
      await persona.locator(".mari-drawer__header").click();
      await expect(persona.locator(".mari-drawer__summary .rounded-full").first()).toBeVisible();
      // Pressing the miniature expands its drawer.
      await custom.locator(".mari-drawer__summary").click();
      await expect(custom.getByRole("button", { name: "Health", exact: true })).toBeVisible();

      // Agent activity, with its actions.
      const activity = trackerWindow.locator('[data-drawer="agent-activity"]');
      await activity.locator(".mari-drawer__header").click();
      const section = activity.locator('[data-component="AgentActivitySection"]');
      await expect(section.getByRole("button", { name: /^Re-run Trackers/ })).toBeEnabled();
      await section.getByRole("button", { name: "Clear Trackers", exact: true }).click();
      const dialog = page.getByRole("dialog").filter({ hasText: "Clear all trackers for this chat?" });
      await dialog.getByRole("button", { name: "Clear Trackers", exact: true }).click();
      await expect
        .poll(async () => (await (await request.get(`/api/chats/${chat.id}/game-state`)).json()).location)
        .toBeNull();
      await expect(world.locator(".mari-drawer__summary")).toBeVisible();

      // Lock keeps it in place; pin keeps it open when the user presses elsewhere.
      const lock = trackerWindow.locator('[data-window-control="lock"]');
      await lock.click();
      await expect(trackerWindow).toHaveAttribute("data-locked", "true");
      await expect(trackerWindow.locator(".mari-window__resize-handle")).toHaveCount(0);
      await lock.click();
      await expect(trackerWindow).toHaveAttribute("data-locked", "false");
      await page.locator("[data-chat-composer]").first().click();
      await expect(trackerWindow).toBeVisible();
      await trackerWindow.locator('[data-window-control="pin"]').click();
      await expect(trackerWindow).toHaveAttribute("data-pinned", "false");
      await page.locator("[data-chat-composer]").first().click();
      await expect(trackerWindow).toHaveCount(0);

      // Chat Settings turns it back on; Reset View restores its default place, pinned.
      const settings = await openChatSettings(page);
      const toggle = settings.locator('[data-tracker-window-toggle="chat-settings"]');
      const windowSwitch = toggle.getByRole("checkbox", { name: "Tracker window", exact: true });
      await expect(windowSwitch).not.toBeChecked();
      await toggle.getByText("Tracker window", { exact: true }).click();
      await expect(trackerWindow).toBeVisible();
      await expect(windowSwitch).toBeChecked();
      await expect(trackerWindow).toHaveAttribute("data-pinned", "false");
      await trackerWindow.getByRole("button", { name: "Close Trackers", exact: true }).click();
      await expect(trackerWindow).toHaveCount(0);
      await expect(windowSwitch).not.toBeChecked();
      await settings.getByRole("button", { name: "Reset View", exact: true }).click();
      await expect(trackerWindow).toBeVisible();
      await expect(trackerWindow).toHaveAttribute("data-pinned", "true");
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });
});
