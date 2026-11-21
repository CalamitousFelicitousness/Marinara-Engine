// On a computer the Tracker Panel is a floating window (TrackerPanelWindow.tsx): it opens clear of the chat's
// bubbles, moves by its title bar and keeps its place, and its width and the panel width setting stay together.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({ reducedMotion: "reduce" });

type PageUiStoreModule = {
  useUIStore: { getState: () => { trackerPanelWidth: number; setTrackerPanelWidth: (width: number) => void } };
};

async function createChat(request: APIRequestContext) {
  const response = await request.post("/api/chats", {
    data: { name: "Tracker Panel Window", mode: "roleplay", characterIds: [] },
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
    trackerPanelWidth: 340,
  });
  await page.addInitScript(
    ({ chatId: id, version: currentVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", currentVersion);
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

const panelWindow = (page: Page) => page.locator('[data-component="TrackerDataSidebarDesktop.right"]');

const storedWidth = (page: Page) =>
  page.evaluate(async () => {
    const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
    return module.useUIStore.getState().trackerPanelWidth;
  });

async function drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(from.x + (by.x * step) / 8, from.y + (by.y * step) / 8);
  }
  await page.mouse.up();
}

for (const width of [1024, 1440]) {
  test(`an unplaced Tracker window opens clear of the chat's buttons at ${width}px`, async ({
    page,
    request,
  }, info) => {
    test.skip(!info.project.name.includes("desktop"), "Phones show the Tracker Panel as a sheet.");
    const chat = await createChat(request);
    try {
      await openChat(page, chat.id, width);
      const panel = panelWindow(page);
      await expect(panel).toBeVisible();
      await expect(async () => {
        const box = await rect(panel);
        const buttons = page.locator(".mari-window-bubble:visible");
        expect(await buttons.count()).toBeGreaterThan(0);
        for (const button of await buttons.all()) {
          const label = await button.getAttribute("aria-label");
          expect(overlaps(await rect(button), box), `${label} is covered by the Tracker window`).toBe(false);
        }
      }).toPass({ timeout: 10_000 });
    } finally {
      await request.delete(`/api/chats/${chat.id}`);
    }
  });
}

test("the Tracker window moves by its title bar and keeps its place after a reload", async ({
  page,
  request,
}, info) => {
  test.skip(!info.project.name.includes("desktop"), "Phones show the Tracker Panel as a sheet.");
  const chat = await createChat(request);
  try {
    await openChat(page, chat.id, 1440);
    const panel = panelWindow(page);
    await expect(panel).toBeVisible();
    const before = await rect(panel);
    const title = await rect(panel.getByRole("heading", { name: "Trackers", exact: true }));
    await drag(page, { x: title.x + title.width / 2, y: title.y + title.height / 2 }, { x: -320, y: 40 });
    await expect.poll(async () => Math.round((await rect(panel)).x)).toBeLessThan(Math.round(before.x) - 200);
    const moved = await rect(panel);
    // Window layouts save to the chat's metadata a moment after a change (use-chat-window-layout.ts).
    await expect
      .poll(async () => {
        const saved = (await (await request.get(`/api/chats/${chat.id}`)).json()) as { metadata?: unknown };
        const metadata = typeof saved.metadata === "string" ? saved.metadata : JSON.stringify(saved.metadata ?? {});
        return metadata.includes('"tracker-panel"');
      })
      .toBe(true);

    await page.reload();
    await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const after = await rect(panel);
        return Math.abs(after.x - moved.x) + Math.abs(after.y - moved.y);
      })
      .toBeLessThanOrEqual(2);
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
  }
});

test("resizing the Tracker window sets the panel width, and a set width resizes the window", async ({
  page,
  request,
}, info) => {
  test.skip(!info.project.name.includes("desktop"), "Phones show the Tracker Panel as a sheet.");
  const chat = await createChat(request);
  try {
    await openChat(page, chat.id, 1440);
    const panel = panelWindow(page);
    await expect(panel).toBeVisible();
    const west = await rect(panel.locator('.mari-window__resize-handle[data-edge="w"]'));
    await drag(page, { x: west.x + west.width / 2, y: west.y + west.height / 2 }, { x: -120, y: 0 });
    await expect.poll(() => storedWidth(page)).toBeGreaterThanOrEqual(440);
    const resized = await rect(panel);
    expect(Math.abs((await storedWidth(page)) - resized.width)).toBeLessThanOrEqual(2);

    // A preset in Settings or the header sets the width the same way.
    await page.evaluate(async () => {
      const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
      module.useUIStore.getState().setTrackerPanelWidth(280);
    });
    await expect.poll(async () => Math.round((await rect(panel)).width)).toBe(280);
    expect(await storedWidth(page)).toBe(280);
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
  }
});
