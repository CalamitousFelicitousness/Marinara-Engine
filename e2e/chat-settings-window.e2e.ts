// #7036: Chat Settings is a movable window opened from the centre of the topbar, built on the shared
// FloatingWindow / Drawer components that custom themes can restyle.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

type ChatMode = "conversation" | "roleplay" | "game";
type Box = { x: number; y: number; width: number; height: number };

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const MARGIN = 8;

async function createChat(request: APIRequestContext, mode: ChatMode, metadata: Record<string, unknown> = {}) {
  const response = await request.post("/api/chats", {
    data: { name: `${mode} Chat Settings window`, mode, characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  const gameMetadata =
    mode === "game"
      ? {
          gameId: "chat-settings-window-game",
          gameSessionStatus: "active",
          gameSessionNumber: 1,
          gameIntroPresented: true,
        }
      : {};
  if (mode === "game" || Object.keys(metadata).length > 0) {
    const patched = await request.patch(`/api/chats/${chat.id}/metadata`, { data: { ...gameMetadata, ...metadata } });
    expect(patched.ok()).toBeTruthy();
  }
  if (mode === "game") {
    const message = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "The window test game begins." },
    });
    expect(message.ok()).toBeTruthy();
  }
  return { id: chat.id, mode };
}

async function prepare(page: Page, chatId: string | null, ui: Record<string, unknown> = {}) {
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
      if (chatId) localStorage.setItem("marinara-active-chat-id", chatId);
      else localStorage.removeItem("marinara-active-chat-id");
    },
    { chatId, version: APP_VERSION },
  );
}

/** The window layout the chat saved (#7034 step 4: layouts belong to the chat). */
async function readSavedLayout(request: APIRequestContext, chatId: string) {
  const chat = (await (await request.get(`/api/chats/${chatId}`)).json()) as { metadata: unknown };
  const metadata = (typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata) as {
    windowLayout?: { windows?: Record<string, { x: number; y: number; width: number; height: number }> } | null;
  };
  return metadata.windowLayout ?? null;
}

async function setActiveChat(page: Page, chatId: string | null) {
  await page.evaluate(async (nextChatId) => {
    const module = (await import("/src/stores/chat.store.ts" as string)) as PageChatStoreModule;
    module.useChatStore.getState().setActiveChatId(nextChatId);
  }, chatId);
}

function topbarSettings(page: Page) {
  return page.locator('[data-component="TopBar"]').getByRole("button", { name: "Chat Settings", exact: true });
}

function settingsWindow(page: Page) {
  return page.locator('[data-window="chat-settings"]');
}

async function openSettingsWindow(page: Page) {
  await topbarSettings(page).click();
  const settings = settingsWindow(page);
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("data-presentation", "window");
  // The loading placeholder shares the window; wait for the real settings.
  await expect(settings.locator("[data-chat-settings-section]").first()).toBeVisible();
  // Measure after the opening animation settles.
  await settings.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
  );
  return settings;
}

async function box(locator: Locator): Promise<Box> {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

async function expectInsideViewport(page: Page, settings: Locator) {
  const viewport = page.viewportSize()!;
  const topbar = await box(page.locator('[data-component="TopBar"]'));
  const rect = await box(settings);
  expect(rect.x).toBeGreaterThanOrEqual(MARGIN - 1);
  expect(rect.y).toBeGreaterThanOrEqual(topbar.y + topbar.height + MARGIN - 1);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width - MARGIN + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - MARGIN + 1);
}

function expectSameBox(actual: Box, expected: Box, label: string) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${label} ${key}`).toBeLessThanOrEqual(1.5);
  }
}

test.describe("Chat Settings window on desktop", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("desktop"), "The movable window is the desktop presentation.");
  });

  test("the topbar Chat Settings button shows only in chats and replaces the old top buttons", async ({
    page,
    request,
  }) => {
    const chats = [
      await createChat(request, "roleplay", { enableAgents: true }),
      await createChat(request, "conversation"),
      await createChat(request, "game"),
    ];
    try {
      await prepare(page, null, { trackerPanelEnabled: true, trackerPanelOpen: false });
      await page.goto("/");
      await expect(page.locator('[data-component="TopBar"]')).toBeVisible();
      await expect(topbarSettings(page)).toHaveCount(0);

      for (const chat of chats) {
        await setActiveChat(page, chat.id);
        const root = page.locator(`[data-chat-mode="${chat.mode}"]`);
        await expect(root).toBeVisible();
        const button = topbarSettings(page);
        await expect(button).toBeVisible();
        await expect(button).toHaveAttribute("aria-expanded", "false");
        const [topbar, buttonBox] = [await box(page.locator('[data-component="TopBar"]')), await box(button)];
        expect(Math.abs(buttonBox.x + buttonBox.width / 2 - (topbar.x + topbar.width / 2))).toBeLessThanOrEqual(2);

        // Settings, Help layout and the Tracker Panel launcher no longer sit among the chat's top buttons.
        await expect(root.locator('[data-chat-toolbar-panel-action="settings"]').filter({ visible: true })).toHaveCount(
          0,
        );
        await expect(root.locator('[data-chat-help="help"]').filter({ visible: true })).toHaveCount(0);
        await expect(root.getByRole("button", { name: "Help", exact: true }).filter({ visible: true })).toHaveCount(0);
        await expect(page.locator('[data-tracker-panel-toggle="roleplay-hud"]').filter({ visible: true })).toHaveCount(
          0,
        );
      }

      // A detail editor takes the chat's place, so the button leaves with it.
      await page.evaluate(async () => {
        const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
        module.useUIStore.getState().openAgentCatalog();
      });
      await expect(topbarSettings(page)).toHaveCount(0);
      await page.evaluate(async () => {
        const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
        module.useUIStore.getState().closeAgentCatalog();
      });
      await expect(topbarSettings(page)).toBeVisible();

      await page.locator('[data-component="TopBar"]').getByRole("button", { name: "Home", exact: true }).click();
      await expect(topbarSettings(page)).toHaveCount(0);
    } finally {
      await Promise.all(chats.map((chat) => request.delete(`/api/chats/${chat.id}?force=true`)));
    }
  });

  test("Chat Settings opens as a window that moves, resizes, locks, pins, closes and resets", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request, "roleplay");
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();

      const settings = await openSettingsWindow(page);
      const button = topbarSettings(page);
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("dialog", { name: "Chat Settings", exact: true })).toHaveAttribute(
        "aria-modal",
        "false",
      );
      await expect.poll(() => settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await expect(settings).toHaveAttribute("data-pinned", "false");
      await expect(settings).toHaveAttribute("data-locked", "false");
      await expectInsideViewport(page, settings);
      const defaultBox = await box(settings);
      const composer = await box(page.locator("[data-chat-composer]").first());
      expect(defaultBox.y + defaultBox.height, "the window opens above the message box").toBeLessThanOrEqual(
        composer.y,
      );
      // The per-mode description is gone; the drag-and-drop hint stays.
      await expect(settings.getByText("Classic roleplay mode", { exact: false })).toHaveCount(0);
      await expect(settings.getByText("You can drag and drop", { exact: false })).toBeVisible();

      // Move by the title bar.
      const header = settings.locator(".mari-window__header");
      const headerBox = await box(header);
      await drag(page, { x: headerBox.x + headerBox.width / 2, y: headerBox.y + headerBox.height / 2 }, -220, 30);
      const moved = await box(settings);
      expectSameBox(moved, { ...defaultBox, x: defaultBox.x - 220, y: defaultBox.y + 30 }, "moved");

      // Resize from the bottom-right corner and from the left edge.
      const corner = await box(settings.locator('.mari-window__resize-handle[data-edge="se"]'));
      await drag(page, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, 40, -60);
      const cornerResized = await box(settings);
      expectSameBox(cornerResized, { ...moved, width: moved.width + 40, height: moved.height - 60 }, "corner resize");
      const leftEdge = await box(settings.locator('.mari-window__resize-handle[data-edge="w"]'));
      await drag(page, { x: leftEdge.x + leftEdge.width / 2, y: leftEdge.y + leftEdge.height / 2 }, -50, 0);
      const edgeResized = await box(settings);
      expectSameBox(
        edgeResized,
        { ...cornerResized, x: cornerResized.x - 50, width: cornerResized.width + 50 },
        "left edge resize",
      );

      // Arrow keys move the focused title bar and resize from the focused corner.
      await settings.getByRole("group", { name: "Move window with the arrow keys", exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Shift+ArrowDown");
      const keyMoved = await box(settings);
      expectSameBox(keyMoved, { ...edgeResized, x: edgeResized.x - 10, y: edgeResized.y + 50 }, "keyboard move");
      await settings.getByRole("button", { name: "Resize window with the arrow keys", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowUp");
      const keyResized = await box(settings);
      expectSameBox(
        keyResized,
        { ...keyMoved, width: keyMoved.width + 10, height: keyMoved.height - 10 },
        "keyboard resize",
      );

      // The layout is remembered with the chat.
      await expect
        .poll(async () => (await readSavedLayout(request, chat.id))?.windows?.["chat-settings"]?.width)
        .toBeCloseTo(keyResized.width, 0);
      await page.reload();
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
      await openSettingsWindow(page);
      expectSameBox(await box(settings), keyResized, "remembered after reload");

      // Locked: no handles, and neither the pointer nor the keyboard moves it.
      const lock = settings.getByRole("button", { name: "Lock window", exact: true });
      await lock.click();
      await expect(lock).toHaveAttribute("aria-pressed", "true");
      await expect(settings).toHaveAttribute("data-locked", "true");
      await expect(settings.locator(".mari-window__resize-handle")).toHaveCount(0);
      await expect(settings.getByRole("group", { name: "Move window with the arrow keys", exact: true })).toHaveCount(
        0,
      );
      const lockedHeader = await box(header);
      await drag(
        page,
        { x: lockedHeader.x + lockedHeader.width / 2, y: lockedHeader.y + lockedHeader.height / 2 },
        -120,
        60,
      );
      await header.press("ArrowLeft");
      expectSameBox(await box(settings), keyResized, "locked");
      await lock.click();
      await expect(settings).toHaveAttribute("data-locked", "false");

      // Unpinned: a press elsewhere closes it.
      await page.locator("[data-chat-scroll]").click({ position: { x: 40, y: 200 } });
      await expect(settings).toHaveCount(0);
      await expect(button).toHaveAttribute("aria-expanded", "false");

      // Pinned: it stays through presses elsewhere, other chat panels and Escape.
      await openSettingsWindow(page);
      const pin = settings.getByRole("button", { name: "Pin window", exact: true });
      await pin.click();
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect(settings).toHaveAttribute("data-pinned", "true");
      await page.locator("[data-chat-scroll]").click({ position: { x: 40, y: 200 } });
      await expect(settings).toBeVisible();
      // Another chat panel opening announces itself the way a toolbar button does.
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("mari-chat-toolbar-action", { detail: { panelAction: null } })),
      );
      await expect(settings).toBeVisible();
      await settings.focus();
      await page.keyboard.press("Escape");
      await expect(settings).toBeVisible();
      await pin.click();
      await expect(settings).toHaveAttribute("data-pinned", "false");

      // Escape and the close button close an unpinned window and return focus to the topbar button.
      await settings.focus();
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
      await expect(button).toBeFocused();
      await openSettingsWindow(page);
      await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();
      await expect(settings).toHaveCount(0);
      await expect(button).toBeFocused();

      // Escape in a text field belongs to the field; anywhere else in a section it closes the window.
      await openSettingsWindow(page);
      const chatName = settings.locator('[data-chat-settings-section="chat-name"]');
      const chatNameHeader = chatName.locator('> [role="button"]');
      if ((await chatNameHeader.getAttribute("aria-expanded")) !== "true") await chatNameHeader.click();
      await chatName.locator(".mari-drawer__body button").first().click();
      await expect(chatName.locator("input")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "Copy chat ID", exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
      await expect(button).toBeFocused();

      // Reset View puts the window back where it started, unpinned and unlocked.
      await openSettingsWindow(page);
      await settings.getByRole("button", { name: "Pin window", exact: true }).click();
      await settings.getByRole("button", { name: "Lock window", exact: true }).click();
      await settings.getByRole("button", { name: "Reset View", exact: true }).click();
      await expect(settings).toHaveAttribute("data-pinned", "false");
      await expect(settings).toHaveAttribute("data-locked", "false");
      expectSameBox(await box(settings), defaultBox, "reset view");
      await expect.poll(() => readSavedLayout(request, chat.id)).toBeNull();
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("the window stays on screen when the viewport shrinks or the saved layout is bad", async ({ page, request }) => {
    const chat = await createChat(request, "conversation");
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="conversation"]')).toBeVisible();
      const settings = await openSettingsWindow(page);
      const handle = await box(settings.locator('.mari-window__resize-handle[data-edge="se"]'));
      await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, 400, 400);
      await expectInsideViewport(page, settings);
      const beforeShrink = await box(settings);

      for (const size of [
        { width: 900, height: 600 },
        { width: 800, height: 420 },
      ]) {
        await page.setViewportSize(size);
        await expect
          .poll(async () => (await box(settings)).x + (await box(settings)).width)
          .toBeLessThanOrEqual(size.width - MARGIN + 1);
        await expectInsideViewport(page, settings);
        await expect(settings.getByRole("button", { name: "Close chat settings", exact: true })).toBeInViewport();
      }
      // Pinning while squeezed keeps the saved place, so the window returns there when the viewport grows.
      const pin = settings.getByRole("button", { name: "Pin window", exact: true });
      await pin.click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(async () => (await box(settings)).height).toBeGreaterThan(beforeShrink.height - 2);
      expectSameBox(await box(settings), beforeShrink, "back in place after pinning while squeezed");
      await pin.click();
      await expect
        .poll(async () => (await readSavedLayout(request, chat.id))?.windows?.["chat-settings"])
        .toMatchObject({
          pinned: false,
        });

      const badLayouts = [
        "{not json",
        JSON.stringify({ version: 0, windows: { "chat-settings": { x: 5000, y: 5000, width: 9, height: 9 } } }),
        JSON.stringify({
          version: 1,
          windows: { "chat-settings": { x: null, y: "NaN", width: -10, height: 1e9, pinned: "yes", locked: 1 } },
        }),
        JSON.stringify({
          version: 1,
          windows: {
            "chat-settings": { x: 99999, y: -99999, width: 99999, height: 99999, pinned: false, locked: false },
          },
        }),
      ];
      for (const raw of badLayouts) {
        const windowLayout = raw.startsWith("{not") ? raw : JSON.parse(raw);
        expect((await request.patch(`/api/chats/${chat.id}/metadata`, { data: { windowLayout } })).ok()).toBeTruthy();
        await page.reload();
        await expect(page.locator('[data-chat-mode="conversation"]')).toBeVisible();
        await openSettingsWindow(page);
        await expectInsideViewport(page, settings);
        await expect(settings).toHaveAttribute("data-pinned", "false");
        await expect(settings).toHaveAttribute("data-locked", "false");
        await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();
      }
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("the Tracker Panel switch in Chat Settings replaces the Roleplay HUD launcher", async ({ page, request }) => {
    const chats = [
      await createChat(request, "roleplay", { enableAgents: true }),
      await createChat(request, "conversation", { enableAgents: true }),
      await createChat(request, "game"),
    ];
    try {
      // The panel's default side is the right, where the window opens too.
      await prepare(page, chats[0]!.id, {
        trackerPanelEnabled: true,
        trackerPanelOpen: false,
        trackerPanelSide: "right",
      });
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
      const settings = await openSettingsWindow(page);
      const defaultBox = await box(settings);
      const toggle = settings.locator('[data-tracker-panel-toggle="chat-settings"]');
      const trackerSwitch = toggle.getByRole("checkbox", { name: "Tracker Panel", exact: true });
      await expect(trackerSwitch).not.toBeChecked();
      await toggle.getByText("Tracker Panel", { exact: true }).click();
      await expect(trackerSwitch).toBeChecked();
      const tracker = page.locator('[data-component="TrackerDataSidebarDesktop.right"]');
      await expect(tracker).toBeVisible();
      await expect(settings).toBeVisible();
      // A window the user has not moved makes room for the panel instead of covering it.
      const trackerLeft = async () => tracker.evaluate((element) => (element as HTMLElement).offsetLeft);
      await expect
        .poll(async () => (await box(settings)).x + (await box(settings)).width)
        .toBeLessThanOrEqual(await trackerLeft());
      const covered = await tracker.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest(".mari-window") !==
          null
        );
      });
      expect(covered, "the Tracker Panel is not under the window").toBe(false);
      await toggle.getByText("Tracker Panel", { exact: true }).click();
      await expect(trackerSwitch).not.toBeChecked();
      await expect(page.locator('[data-component="TrackerDataSidebar"]:visible')).toHaveCount(0);
      await expect.poll(async () => (await box(settings)).x).toBeCloseTo(defaultBox.x, 0);

      for (const chat of chats.slice(1)) {
        await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();
        await setActiveChat(page, chat.id);
        await expect(page.locator(`[data-chat-mode="${chat.mode}"]`)).toBeVisible();
        await openSettingsWindow(page);
        await expect(settings.getByRole("button", { name: "Reset View", exact: true })).toBeVisible();
        await expect(settings.locator('[data-tracker-panel-toggle="chat-settings"]')).toHaveCount(0);
      }
    } finally {
      await Promise.all(chats.map((chat) => request.delete(`/api/chats/${chat.id}?force=true`)));
    }
  });

  test("Help Layout opens beside the Chat Settings title and labels visible controls in every mode", async ({
    page,
    request,
  }) => {
    const chats = [
      await createChat(request, "roleplay", { enableAgents: true }),
      await createChat(request, "conversation"),
      await createChat(request, "game"),
    ];
    try {
      await prepare(page, chats[0]!.id, { trackerPanelEnabled: true, trackerPanelOpen: false });
      await page.goto("/");
      for (const [index, chat] of chats.entries()) {
        if (index > 0) await setActiveChat(page, chat.id);
        await expect(page.locator(`[data-chat-mode="${chat.mode}"]`)).toBeVisible();
        const settings = await openSettingsWindow(page);
        const help = settings.locator(".mari-window__header").getByRole("button", { name: "Help", exact: true });
        await help.hover();
        await expect(page.getByText("Show what each part of this chat does.", { exact: true })).toBeVisible();
        await help.click();
        const overlay = page.locator(`[data-chat-help-overlay="${chat.mode}"]`);
        await expect(overlay).toBeVisible();
        await expect(overlay).toBeFocused();
        await expect(settings).toBeVisible();

        const expected = [
          "settings",
          "help",
          "window-title",
          "window-pin",
          "window-lock",
          "window-close",
          "reset-view",
        ];
        if (chat.mode === "roleplay") expected.push("tracker-panel");
        for (const id of expected) await expect(overlay.locator(`[data-chat-help-highlight="${id}"]`)).toBeVisible();

        // Every callout sits on its control, and nothing else covers that control.
        const misplaced = await overlay.evaluate((overlayElement) => {
          const highlights = Array.from(overlayElement.querySelectorAll<HTMLElement>("[data-chat-help-highlight]"));
          const centres = highlights.map((highlight) => {
            const rect = highlight.getBoundingClientRect();
            return {
              id: highlight.dataset.chatHelpHighlight!,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          });
          const sourceSelectors: Record<string, string> = {
            messages: "[data-chat-scroll]",
            composer: "[data-chat-resource-drop-exclude], [data-chat-composer]",
            map: '[data-tour="game-map"]',
            party: '[data-tour="game-party"]',
            dialogue: '[data-tour="game-dialogue"]',
            widgets: "[data-game-widget-rail]",
            "window-title": '[data-window="chat-settings"] .mari-window__title',
            "window-pin": '[data-window="chat-settings"] [data-window-control="pin"]',
            "window-lock": '[data-window="chat-settings"] [data-window-control="lock"]',
            "window-close": '[data-window="chat-settings"] [data-window-control="close"]',
            "tracker-panel": '[data-tracker-panel-toggle="chat-settings"]',
          };
          overlayElement.style.visibility = "hidden";
          try {
            return centres.flatMap(({ id, x, y }) => {
              const hit = document.elementFromPoint(x, y);
              const selector = sourceSelectors[id] ?? `[data-chat-help="${id}"]`;
              return hit?.closest(selector) ? [] : [`${id} → ${hit?.outerHTML.slice(0, 120) ?? "nothing"}`];
            });
          } finally {
            overlayElement.style.visibility = "";
          }
        });
        expect(misplaced, `${chat.mode} callouts without a visible control`).toEqual([]);

        // Number badges sit beside small controls, so their icons stay readable.
        for (const control of ["pin", "lock", "close"]) {
          const badge = await box(overlay.locator(`[data-chat-help-highlight="window-${control}"] > span`));
          const icon = await box(settings.locator(`[data-window-control="${control}"] svg`));
          const overlapX = Math.min(badge.x + badge.width, icon.x + icon.width) - Math.max(badge.x, icon.x);
          const overlapY = Math.min(badge.y + badge.height, icon.y + icon.height) - Math.max(badge.y, icon.y);
          expect(overlapX <= 0 || overlapY <= 0, `${chat.mode} ${control} badge clear of its icon`).toBe(true);
        }

        // Escape closes only the overlay: the unpinned window stays open and the ? gets focus back.
        await page.keyboard.press("Escape");
        await expect(overlay).toHaveCount(0);
        await expect(settings).toBeVisible();
        await expect(help).toBeFocused();

        // With the window closed, the Chat Settings callout points at the topbar button.
        await settings.getByRole("button", { name: "Close chat settings", exact: true }).click();
        await expect(settings).toHaveCount(0);
        await page.evaluate((mode) => {
          window.dispatchEvent(new CustomEvent("mari-chat-help-open-request", { detail: { mode } }));
        }, chat.mode);
        await expect(overlay).toBeVisible();
        expectSameBox(
          await box(overlay.locator('[data-chat-help-highlight="settings"]')),
          await box(topbarSettings(page)),
          `${chat.mode} topbar callout`,
        );
        await expect(overlay.locator('[data-chat-help-highlight="window-pin"]')).toHaveCount(0);
        await overlay.dispatchEvent("pointerdown");
        await expect(overlay).toHaveCount(0);
      }
    } finally {
      await Promise.all(chats.map((chat) => request.delete(`/api/chats/${chat.id}?force=true`)));
    }
  });

  test("windows and drawers carry the theming contract and follow custom theme variables", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request, "roleplay");
    const themeResponse = await request.post("/api/themes", {
      data: {
        name: "Window theming contract",
        css: ":root { --mari-window-border: rgb(255, 0, 0); --mari-window-radius: 3px; } [data-drawer] { --mari-drawer-border: rgb(0, 128, 0); }",
      },
    });
    expect(themeResponse.ok()).toBeTruthy();
    const theme = (await themeResponse.json()) as { id: string };
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
      const settings = await openSettingsWindow(page);
      for (const part of ["header", "title", "controls", "body", "resize-handle"]) {
        await expect(settings.locator(`.mari-window__${part}`).first()).toBeAttached();
      }
      await expect(settings).toHaveClass(/\bmari-window\b/u);
      await expect(settings).toHaveAttribute("data-detached", "false");
      const drawer = settings.locator('[data-drawer="chat-name"]');
      await expect(drawer).toHaveClass(/\bmari-drawer\b/u);
      await expect(drawer).toHaveAttribute("data-chat-settings-section", "chat-name");
      await expect(drawer).toHaveAttribute("data-detached", "false");
      await expect(drawer.locator(".mari-drawer__header")).toHaveAttribute("role", "button");
      await expect(drawer.locator(".mari-drawer__title")).toHaveText("Chat Name");
      const sectionsOutsideDrawers = await settings.evaluate((element) =>
        Array.from(element.querySelectorAll("[data-chat-settings-section]"))
          .filter((section) => !section.matches(".mari-drawer"))
          .map((section) => section.getAttribute("data-chat-settings-section")),
      );
      expect(sectionsOutsideDrawers, "every Chat Settings section renders through the shared drawer").toEqual([]);
      await expect(settings.locator('.mari-drawer[data-drawer="advanced-parameters"]')).toHaveCount(1);
      const defaultBorder = await settings.evaluate((element) => getComputedStyle(element).borderTopColor);
      const defaultDrawerBorder = await drawer.evaluate((element) => getComputedStyle(element).borderBottomColor);
      expect(defaultBorder).not.toBe("rgb(255, 0, 0)");

      const activated = await request.put("/api/themes/active", { data: { id: theme.id } });
      expect(activated.ok()).toBeTruthy();
      await page.reload();
      await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
      await openSettingsWindow(page);
      await expect(settings).toHaveCSS("border-top-color", "rgb(255, 0, 0)");
      await expect(settings).toHaveCSS("border-top-left-radius", "3px");
      await expect(drawer).toHaveCSS("border-bottom-color", "rgb(0, 128, 0)");
      expect(defaultDrawerBorder).not.toBe("rgb(0, 128, 0)");
    } finally {
      await request.put("/api/themes/active", { data: { id: null } });
      await request.delete(`/api/themes/${theme.id}`);
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("the topbar button sends an open control window back to its button, as it closed popovers", async ({
    page,
    request,
  }) => {
    const chat = await createChat(request, "game");
    try {
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="game"]')).toBeVisible();
      const sessionBubble = page.locator('.mari-window-bubble[data-window="control:session"]');
      const sessionWindow = page.locator('.mari-window[data-window="control:session"]');
      await sessionBubble.click();
      await expect(sessionWindow).toBeVisible();
      await topbarSettings(page).click();
      await expect(settingsWindow(page)).toBeVisible();
      await expect(sessionWindow).toHaveCount(0);
      await expect(sessionBubble).toBeVisible();
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });

  test("the window opens without motion when motion is reduced", async ({ page, request }) => {
    const chat = await createChat(request, "conversation");
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await prepare(page, chat.id);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="conversation"]')).toBeVisible();
      const settings = await openSettingsWindow(page);
      await expect(settings).toHaveCSS("animation-name", "none");
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });
});

test("phones keep Chat Settings, Help and the Tracker Panel launcher in the chat toolbar", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phones keep today's toolbar presentation.");
  const chat = await createChat(request, "roleplay", { enableAgents: true });
  try {
    await prepare(page, chat.id, { trackerPanelEnabled: true, trackerPanelOpen: false });
    await page.goto("/");
    await expect(page.locator('[data-chat-mode="roleplay"]')).toBeVisible();
    await expect(topbarSettings(page).filter({ visible: true })).toHaveCount(0);
    await expect(page.locator('[data-tracker-panel-toggle="roleplay-hud"]').filter({ visible: true })).toHaveCount(1);

    await page.getByRole("button", { name: "More options", exact: true }).click();
    const menu = page.locator("[data-chat-toolbar-overflow-menu]");
    await expect(menu.getByRole("button").first()).toHaveAccessibleName("Help");
    await menu.getByRole("button", { name: "Chat Settings", exact: true }).click();
    const sheet = settingsWindow(page);
    await expect(sheet).toBeVisible();
    // The loading placeholder shares the sheet; measure the real settings, not the one being replaced.
    await expect(sheet.locator("[data-chat-settings-section]").first()).toBeVisible();
    await expect(sheet).toHaveAttribute("data-presentation", "sheet");
    await expect(sheet.locator("[data-window-control]")).toHaveCount(1);
    await expect(sheet.getByRole("button", { name: "Help", exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Reset View", exact: true })).toHaveCount(0);
    const sheetBox = await box(sheet);
    const viewport = page.viewportSize()!;
    expect(sheetBox.x).toBeGreaterThanOrEqual(0);
    expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(viewport.width);
    await sheet.getByRole("button", { name: "Close chat settings", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
