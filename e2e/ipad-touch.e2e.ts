import { devices, expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
// The browser comes from the mobile-webkit project; this file only swaps the phone for an iPad.
const { defaultBrowserType: _browser, ...iPad } = devices["iPad Pro 11"];

test.use(iPad);

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "iPad Safari checks run in WebKit.");
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
  }, version);
});

async function seedShell(page: Page, state: Parameters<typeof seedUIState>[1]) {
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    sidebarOpen: false,
    rightPanelOpen: false,
    ...state,
  });
}

test("tapping a roleplay in the iPad chat list opens it", async ({ page, request }) => {
  const created = await request.post("/api/chats", {
    data: { name: "iPad scene tap", mode: "roleplay", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as { id: string };
  try {
    const message = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "The tavern door creaks open." },
    });
    expect(message.ok()).toBeTruthy();
    await seedShell(page, { sidebarOpen: true });
    await page.goto("/");

    const chatList = page.locator('[data-component="ChatSidebarPanel"]');
    await expect(chatList).toBeVisible();
    await chatList.locator('[data-tour="chat-mode-roleplay"]').tap();
    await chatList.locator(`[data-chat-id="${chat.id}"]`).tap();

    await expect(chatList).toHaveCount(0);
    await expect(page.getByText("The tavern door creaks open.")).toBeInViewport();
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
