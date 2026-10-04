// #7034 step 4: Chat Settings sections and Trackers window drawers pop out into their own windows (with their
// button or by dragging them out), and each chat saves its window layout, which settings profiles carry too.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { resetChatView } from "./chat-settings-tools.js";

type Box = { x: number; y: number; width: number; height: number };
type SavedLayout = { windows?: Record<string, unknown>; detached?: string[] } | null | undefined;

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const CHAT_NAME_WINDOW = "drawer:chat-settings:chat-name";
const WORLD_WINDOW = "drawer:trackers:tracker-world";

async function createChat(request: APIRequestContext, metadata: Record<string, unknown> = {}) {
  const response = await request.post("/api/chats", {
    data: { name: "Pop-out chat", mode: "roleplay", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  if (Object.keys(metadata).length > 0) {
    expect((await request.patch(`/api/chats/${chat.id}/metadata`, { data: metadata })).ok()).toBeTruthy();
  }
  return chat;
}

async function prepare(page: Page, chatId: string, ui: Record<string, unknown> = {}) {
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

async function setActiveChat(page: Page, chatId: string) {
  await page.evaluate(async (nextChatId) => {
    const module = (await import("/src/stores/chat.store.ts" as string)) as PageChatStoreModule;
    module.useChatStore.getState().setActiveChatId(nextChatId);
  }, chatId);
}

async function readSavedLayout(request: APIRequestContext, chatId: string): Promise<SavedLayout> {
  const chat = (await (await request.get(`/api/chats/${chatId}`)).json()) as { metadata: unknown };
  const metadata = (typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata) as {
    windowLayout?: SavedLayout;
  };
  return metadata.windowLayout;
}

function settingsWindow(page: Page) {
  return page.locator('[data-window="chat-settings"]');
}

/** Waits for a window's opening animation, so it is measured where it rests. */
async function settle(window: Locator) {
  await expect(window).toBeVisible();
  await window.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
  );
}

async function openSettingsWindow(page: Page) {
  await page.locator("[data-chat-settings-button]").click();
  const settings = settingsWindow(page);
  await expect(settings).toBeVisible();
  await expect(settings.locator("[data-chat-settings-section]").first()).toBeVisible();
  await settle(settings);
  return settings;
}

async function box(locator: Locator): Promise<Box> {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

function centre(rect: Box) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function expectSameBox(actual: Box, expected: Box, label: string) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${label} ${key}`).toBeLessThanOrEqual(1.5);
  }
}

test.describe("Pop-out drawers on desktop", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      !testInfo.project.name.includes("desktop"),
      "Phones pop sections out into bubbles (phone-bubbles.e2e.ts).",
    );
  });

  test("a section pops out with its button, starts pinned, stays alone and goes back when closed", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request);
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
      const settings = await openSettingsWindow(page);
      await expect(settings.getByText("give it its own window", { exact: false })).toBeVisible();

      // The button sits between the help tip and the arrow, with a label and a tooltip.
      const drawer = settings.locator('[data-drawer="chat-name"]');
      const button = drawer.getByRole("button", { name: "Open Chat Name in its own window", exact: true });
      await expect(button).toHaveAttribute("title", "Open this section in its own window, or drag it out.");
      await expect(drawer.locator(".mari-drawer__actions [data-drawer-control='pop-out']")).toHaveCount(1);
      expect(
        await drawer.locator(".mari-drawer__header").evaluate((header) => {
          const parts = Array.from(header.children).map((child) => child.getAttribute("class") ?? "");
          return parts.findIndex((part) => part.includes("mari-drawer__actions")) === parts.length - 2;
        }),
        "the pop-out button sits just before the arrow",
      ).toBe(true);
      const settingsBox = await box(settings);
      const drawerBox = await box(drawer);
      await button.click();

      const popped = page.locator(`[data-window="${CHAT_NAME_WINDOW}"]`);
      await settle(popped);
      await expect(page.getByRole("dialog", { name: "Chat Name", exact: true })).toBeVisible();
      await expect(popped).toHaveAttribute("data-detached", "true");
      await expect(popped).toHaveAttribute("data-pinned", "true");
      await expect(popped).toHaveAttribute("data-locked", "false");
      await expect(popped).toHaveClass(/\bmari-window\b/u);
      await expect.poll(() => popped.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      const body = popped.locator('.mari-drawer[data-drawer="chat-name"]');
      await expect(body).toHaveAttribute("data-detached", "true");
      await expect(body.getByRole("button", { name: "Copy chat ID", exact: true })).toBeVisible();
      // It leaves Chat Settings, and opens beside it, level with where it was.
      await expect(settings.locator('[data-drawer="chat-name"]')).toHaveCount(0);
      await expect(page.locator('[data-drawer="chat-name"]')).toHaveCount(1);
      const poppedBox = await box(popped);
      expect(poppedBox.x + poppedBox.width).toBeLessThanOrEqual(settingsBox.x);
      expect(Math.abs(poppedBox.y - drawerBox.y)).toBeLessThanOrEqual(2);

      // Pinned: a press elsewhere closes the unpinned Chat Settings but not the popped-out section.
      await page.locator("[data-chat-scroll]").click({ position: { x: 40, y: 200 } });
      await expect(settings).toBeHidden();
      await expect(popped).toBeVisible();
      // Reopening Chat Settings does not show the section twice.
      await openSettingsWindow(page);
      await expect(settings.locator('[data-drawer="chat-name"]')).toHaveCount(0);
      await expect(page.locator('[data-drawer="chat-name"]')).toHaveCount(1);

      // Lock and pin work as in every window; unpinned, it goes back on a press elsewhere.
      await popped.locator('[data-window-control="lock"]').click();
      await expect(popped).toHaveAttribute("data-locked", "true");
      await popped.locator('[data-window-control="lock"]').click();

      // Put back (beside X) returns it to Chat Settings and focus to its pop-out button.
      await popped.getByRole("button", { name: "Put back in Chat Settings", exact: true }).click();
      await expect(popped).toHaveCount(0);
      const docked = settings.locator('[data-drawer="chat-name"]');
      await expect(docked).toBeVisible();
      await expect(docked.getByRole("button", { name: "Open Chat Name in its own window", exact: true })).toBeFocused();

      // Reset View puts popped-out sections back too, and the chat forgets its layout.
      await docked.getByRole("button", { name: "Open Chat Name in its own window", exact: true }).click();
      await expect(popped).toBeVisible();
      await expect.poll(async () => (await readSavedLayout(request, chat.id))?.detached).toEqual([CHAT_NAME_WINDOW]);
      await resetChatView(page);
      await expect(popped).toHaveCount(0);
      await expect(settings.locator('[data-drawer="chat-name"]')).toBeVisible();
      await expect.poll(() => readSavedLayout(request, chat.id)).toBeNull();
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("a popped-out section minimizes to a button with its icon, and only Put back docks it", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request);
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
      const settings = await openSettingsWindow(page);
      await settings
        .locator('[data-drawer="chat-name"]')
        .getByRole("button", { name: "Open Chat Name in its own window", exact: true })
        .click();
      const popped = page.locator(`.mari-window[data-window="${CHAT_NAME_WINDOW}"]`);
      const bubble = page.locator(`.mari-window-bubble[data-window="${CHAT_NAME_WINDOW}"]`);
      await settle(popped);
      // Put back sits just left of X.
      const controls = await popped
        .locator("[data-window-control]")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-window-control")));
      expect(controls).toEqual(["minimize", "pin", "lock", "put-back", "close"]);
      await expect(popped.locator('[data-window-control="put-back"]')).toHaveAttribute(
        "title",
        "Put back in Chat Settings",
      );
      const titleBar = popped.locator(".mari-window__title");
      await drag(page, centre(await box(titleBar)), { x: centre(await box(titleBar)).x - 140, y: 420 });
      const left = await box(popped);

      // X minimizes it to a button showing the section's icon alone; it stays out of Chat Settings.
      await popped.locator('[data-window-control="close"]').click();
      await expect(popped).toHaveCount(0);
      await expect(bubble).toBeVisible();
      await expect(bubble).toHaveAccessibleName("Open Chat Name");
      await expect(bubble.locator("svg")).toHaveCount(1);
      await expect(bubble).toBeFocused();
      await expect(settings.locator('[data-drawer="chat-name"]')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("drawer-bubble.png"), animations: "disabled" });

      // The button moves on its own; clicking it reopens the window exactly where it was left.
      const start = await box(bubble);
      await drag(page, centre(start), { x: centre(start).x - 200, y: centre(start).y + 300 });
      const moved = await box(bubble);
      expect(moved.x).toBeLessThan(start.x - 150);
      await bubble.click();
      await settle(popped);
      expectSameBox(await box(popped), left, "reopened where it was left");

      // Unpinned, a press elsewhere or Escape only minimizes it again; it never goes back on its own.
      await popped.locator('[data-window-control="pin"]').click();
      await expect(popped).toHaveAttribute("data-pinned", "false");
      await page.locator("[data-chat-scroll]").click({ position: { x: 40, y: 200 } });
      await expect(popped).toHaveCount(0);
      await expect(bubble).toBeVisible();
      await expect.poll(async () => (await readSavedLayout(request, chat.id))?.detached).toEqual([CHAT_NAME_WINDOW]);
      await bubble.click();
      await settle(popped);
      await popped.locator(".mari-window__title").click();
      await page.keyboard.press("Escape");
      await expect(popped).toHaveCount(0);
      await expect(bubble).toBeVisible();
      // Closing Chat Settings leaves it out too.
      await openSettingsWindow(page);
      await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();
      await expect(bubble).toBeVisible();

      // Window, button and minimized state save with the chat and survive a reload.
      await expect
        .poll(async () => {
          const saved = (await readSavedLayout(request, chat.id))?.windows?.[CHAT_NAME_WINDOW] as
            (Box & { minimized?: boolean; bubble?: { x: number; y: number } }) | undefined;
          return saved ? [saved.minimized, saved.bubble, Math.round(saved.x), Math.round(saved.y)] : null;
        })
        .toEqual([true, { x: moved.x, y: moved.y }, Math.round(left.x), Math.round(left.y)]);
      await page.reload();
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
      await expect(bubble).toBeVisible();
      expectSameBox(await box(bubble), moved, "button after reload");

      // Put back returns it to Chat Settings.
      await bubble.click();
      await settle(popped);
      await popped.getByRole("button", { name: "Put back in Chat Settings", exact: true }).click();
      await expect(popped).toHaveCount(0);
      await expect(bubble).toHaveCount(0);
      await expect.poll(async () => (await readSavedLayout(request, chat.id))?.detached ?? []).toEqual([]);
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("dragging a section's title out pops it out where it lands, and dropping it back docks it", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request);
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
      const settings = await openSettingsWindow(page);
      const settingsBox = await box(settings);
      const header = settings.locator('[data-drawer="chat-name"] > .mari-drawer__header');
      const expanded = await header.getAttribute("aria-expanded");

      // A short drag that stays inside the window neither pops it out nor opens or closes it.
      const headerBox = await box(header);
      await drag(page, centre(headerBox), { x: centre(headerBox).x - 40, y: centre(headerBox).y + 30 });
      await expect(page.locator(`[data-window="${CHAT_NAME_WINDOW}"]`)).toHaveCount(0);
      await expect(header).toHaveAttribute("aria-expanded", expanded ?? "false");

      // Past the window's edge it pops out, with its title bar where it was dropped.
      // High enough that the popped-out window fits below its title bar without being moved up.
      const drop = { x: settingsBox.x - 260, y: settingsBox.y + 160 };
      await drag(page, centre(headerBox), drop);
      const popped = page.locator(`[data-window="${CHAT_NAME_WINDOW}"]`);
      await settle(popped);
      await expect(popped).toHaveAttribute("data-pinned", "true");
      await expect(settings.locator('[data-drawer="chat-name"]')).toHaveCount(0);
      const titleBar = await box(popped.locator(".mari-window__header"));
      expect(drop.x).toBeGreaterThanOrEqual(titleBar.x);
      expect(drop.x).toBeLessThanOrEqual(titleBar.x + titleBar.width);
      expect(drop.y).toBeGreaterThanOrEqual(titleBar.y);
      expect(drop.y).toBeLessThanOrEqual(titleBar.y + titleBar.height);
      await expect(page.locator(".mari-drawer-ghost")).toHaveCount(0);

      // Moving it around keeps it out; dropping its title bar on Chat Settings puts it back.
      const title = popped.locator(".mari-window__title");
      await drag(page, centre(await box(title)), { x: drop.x - 100, y: drop.y + 40 });
      await expect(popped).toBeVisible();
      await drag(page, centre(await box(title)), centre(await box(settings)));
      await expect(popped).toHaveCount(0);
      await expect(settings.locator('[data-drawer="chat-name"]')).toBeVisible();
      await expect(settings).not.toHaveAttribute("data-drop-target", "true");
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("a tracker pops out of the Trackers window and stays when that window closes", async ({ page, request }) => {
    const chat = await createChat(request, {
      enableAgents: true,
      activeAgentIds: ["world-state", "custom-tracker"],
    });
    try {
      const state = await request.patch(`/api/chats/${chat.id}/game-state`, {
        data: { manual: true, location: "Harbor market", time: "Evening" },
      });
      expect(state.ok()).toBeTruthy();
      await prepare(page, chat.id, { trackerPanelEnabled: false, trackerPanelOpen: false, trackerWindowOpen: true });
      await page.goto("/");
      const trackerWindow = page.locator('[data-window="trackers"]');
      await expect(trackerWindow).toBeVisible({ timeout: 30_000 });
      const world = trackerWindow.locator('[data-drawer="tracker-world"]');
      await world.getByRole("button", { name: "Open World State in its own window", exact: true }).click();

      const popped = page.locator(`[data-window="${WORLD_WINDOW}"]`);
      await expect(popped).toBeVisible();
      await expect(popped).toHaveAttribute("data-pinned", "true");
      await expect(popped).toHaveAttribute("data-drawer-host", "trackers");
      await expect(popped.getByText("Harbor market", { exact: true })).toBeVisible();
      await expect(trackerWindow.locator('[data-drawer="tracker-world"]')).toHaveCount(0);
      await expect(trackerWindow.locator('[data-drawer="tracker-custom"]')).toBeVisible();

      // The Trackers window closes; the popped-out tracker stays.
      await trackerWindow.getByRole("button", { name: "Close Trackers", exact: true }).click();
      await expect(trackerWindow).toBeHidden();
      await expect(popped).toBeVisible();
      await expect(popped.getByText("Harbor market", { exact: true })).toBeVisible();

      // Put back returns it; turning the Trackers window on shows it there.
      await popped.getByRole("button", { name: "Put back in Trackers", exact: true }).click();
      await expect(popped).toHaveCount(0);
      await expect(trackerWindow).toHaveCount(0);
      const settings = await openSettingsWindow(page);
      await settings.locator('[data-tracker-window-toggle="chat-settings"]').getByText("Tracker window").click();
      await expect(trackerWindow.locator('[data-drawer="tracker-world"]')).toBeVisible();
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("each chat keeps its own layout, after a reload too", async ({ page, request }) => {
    const first = await createChat(request);
    const second = await createChat(request);
    try {
      await prepare(page, first.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
      const settings = await openSettingsWindow(page);
      await settings
        .locator('[data-drawer="chat-name"]')
        .getByRole("button", { name: "Open Chat Name in its own window", exact: true })
        .click();
      const popped = page.locator(`[data-window="${CHAT_NAME_WINDOW}"]`);
      await settle(popped);
      // Move it, so its place is the first chat's own.
      const moved = await box(popped);
      await drag(page, centre(await box(popped.locator(".mari-window__title"))), {
        x: centre(await box(popped.locator(".mari-window__title"))).x - 120,
        y: centre(await box(popped.locator(".mari-window__title"))).y + 60,
      });
      const placed = await box(popped);
      expect(placed.x).toBeLessThan(moved.x - 100);
      await expect
        .poll(async () => {
          const saved = (await readSavedLayout(request, first.id))?.windows?.[CHAT_NAME_WINDOW] as Box | undefined;
          return !!saved && Math.abs(saved.x - placed.x) < 1.5 && Math.abs(saved.y - placed.y) < 1.5;
        })
        .toBe(true);
      await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();

      // The second chat has its own (default) layout: the section is in place there.
      await setActiveChat(page, second.id);
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
      await expect(popped).toHaveCount(0);
      await openSettingsWindow(page);
      await expect(settings.locator('[data-drawer="chat-name"]')).toBeVisible();
      await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();
      expect(await readSavedLayout(request, second.id)).toBeFalsy();

      // Back in the first chat, it is popped out again, where it was left.
      await setActiveChat(page, first.id);
      await settle(popped);
      expectSameBox(await box(popped), placed, "back in the first chat");
      await expect(settings).toBeHidden();

      // And still after a reload.
      await page.reload();
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
      await settle(popped);
      expectSameBox(await box(popped), placed, "after a reload");
      await expect(popped).toHaveAttribute("data-pinned", "true");

      // Old or broken saved layouts load as the defaults.
      for (const bad of ["{broken", { version: 1, windows: [], detached: "all" }, { version: 7 }]) {
        expect(
          (await request.patch(`/api/chats/${first.id}/metadata`, { data: { windowLayout: bad } })).ok(),
        ).toBeTruthy();
        await page.reload();
        await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
        await expect(popped).toHaveCount(0);
        await openSettingsWindow(page);
        await expect(settings.locator('[data-drawer="chat-name"]')).toBeVisible();
      }
    } finally {
      await request.delete(`/api/chats/${first.id}?force=true`);
      await request.delete(`/api/chats/${second.id}?force=true`);
    }
  });

  test("a settings profile saves the layout and applies it; profiles without one leave it alone", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request);
    const profileName = `Pop-out layout ${Date.now()}`;
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
      const settings = await openSettingsWindow(page);
      await settings.getByRole("button", { name: "Pin window", exact: true }).click();
      await settings
        .locator('[data-drawer="chat-name"]')
        .getByRole("button", { name: "Open Chat Name in its own window", exact: true })
        .click();
      const popped = page.locator(`[data-window="${CHAT_NAME_WINDOW}"]`);
      await settle(popped);
      const placed = await box(popped);

      // Save As stores the layout as shown, even before the chat has saved it.
      await settings.locator('button[title="Save current chat settings as a new profile"]').click();
      const dialog = page.getByRole("dialog").filter({ hasText: "Name for the new profile:" });
      await dialog.getByRole("textbox").fill(profileName);
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      const profiles = async () =>
        (await (await request.get("/api/chat-presets?mode=roleplay")).json()) as Array<{
          id: string;
          name: string;
          settings: { metadata?: { windowLayout?: SavedLayout } };
        }>;
      await expect
        .poll(
          async () => (await profiles()).find((entry) => entry.name === profileName)?.settings.metadata?.windowLayout,
        )
        .toMatchObject({ detached: [CHAT_NAME_WINDOW], windows: { "chat-settings": { pinned: true } } });
      const select = settings.getByRole("combobox", { name: "Profile", exact: true });
      await expect(select.locator("option:checked")).toHaveText(profileName);

      // The Default profile has no layout, so applying it leaves the layout as it is.
      await select.selectOption({ label: "Default" });
      await expect(select.locator("option:checked")).toHaveText("Default");
      await expect(popped).toBeVisible();
      expectSameBox(await box(popped), placed, "after the Default profile");
      await expect(settings).toHaveAttribute("data-pinned", "true");

      // Reset View puts everything back; applying the saved profile brings its layout back.
      await resetChatView(page);
      await expect(popped).toHaveCount(0);
      await expect(settings).toHaveAttribute("data-pinned", "false");
      await expect.poll(() => readSavedLayout(request, chat.id)).toBeNull();
      await select.selectOption({ label: profileName });
      await settle(popped);
      expectSameBox(await box(popped), placed, "from the saved profile");
      await expect(settings).toHaveAttribute("data-pinned", "true");
    } finally {
      const created = (
        (await (await request.get("/api/chat-presets?mode=roleplay")).json()) as Array<{
          id: string;
          name: string;
        }>
      ).find((entry) => entry.name === profileName);
      if (created) await request.delete(`/api/chat-presets/${created.id}`);
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });
});

test("a section popped out on a computer is a bubble on a phone, and its sheet puts it back", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phones show popped-out sections as bubbles.");
  const chat = await createChat(request, {
    windowLayout: {
      version: 1,
      windows: { [CHAT_NAME_WINDOW]: { x: 20, y: 80, width: 300, height: 300, pinned: true, locked: false } },
      detached: [CHAT_NAME_WINDOW],
    },
  });
  try {
    await prepare(page, chat.id);
    await page.goto("/");
    await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible({ timeout: 30_000 });
    // The computer's window place is not used: a phone shows the section as a bubble, closed.
    const bubble = page.locator(`.mari-window-bubble[data-window="${CHAT_NAME_WINDOW}"]`);
    await expect(bubble).toBeVisible();
    await expect(page.locator(`.mari-window[data-window="${CHAT_NAME_WINDOW}"]`)).toHaveCount(0);
    await bubble.click();
    const drawerSheet = page.locator(`.mari-window[data-window="${CHAT_NAME_WINDOW}"]`);
    await expect(drawerSheet).toHaveAttribute("data-presentation", "sheet");
    await drawerSheet.getByRole("button", { name: "Put back in Chat Settings" }).click();
    await expect(bubble).toHaveCount(0);
    await page.locator("[data-chat-settings-button]").click();
    const sheet = settingsWindow(page);
    await expect(sheet.locator('[data-drawer="chat-name"]')).toBeVisible();
    await expect(sheet.locator('[data-drawer="chat-name"] [data-drawer-control="pop-out"]')).toHaveCount(1);
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
