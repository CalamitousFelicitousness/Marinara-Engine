import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { closeChatSettings, openChatSettings } from "./chat-settings-tools.js";
import { clickTopbarPanel } from "./topbar-navigation.js";
import { seedUIState } from "./ui-state-fixture.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const UI_SETTINGS_PATH = "/api/app-settings/ui";
const CHAT_NAME_WINDOW = "drawer:chat-settings:chat-name";
type Preset = "default" | "dottore" | "mari";
const PALETTES = {
  dark: {
    dottore: { background: "oklch(0.205 0.023 224)", accent: "oklch(0.86 0.083 202)", field: "oklch(0.26 0.027 221)" },
    mari: { background: "oklch(0.215 0.022 339)", accent: "oklch(0.81 0.087 13)", field: "oklch(0.26 0.032 351)" },
  },
  light: {
    dottore: { background: "oklch(0.965 0.012 220)", accent: "oklch(0.39 0.077 227)", field: "oklch(0.935 0.017 216)" },
    mari: { background: "oklch(0.975 0.018 76)", accent: "oklch(0.46 0.125 9)", field: "oklch(0.95 0.021 63)" },
  },
} as const;

async function createChat(request: APIRequestContext) {
  const response = await request.post("/api/chats", {
    data: { name: "Widget appearance proof", mode: "conversation", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: { windowLayout: null, chatSettingsHintDismissed: true, enableAgents: false },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post(`/api/chats/${chat.id}/messages`, {
        data: { role: "assistant", content: "Arrange this chat however you like." },
      })
    ).ok(),
  ).toBeTruthy();
  return chat;
}

async function prepare(target: Page | BrowserContext, chatId: string, theme: "dark" | "light") {
  await seedUIState(
    target,
    {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatSettingsMoveTipDismissed: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      appAccentPulseMode: false,
      appAccentRgbMode: false,
      theme,
    },
    "if-missing",
  );
  await target.addInitScript(
    ({ chatId, version }) => {
      localStorage.setItem("marinara:whats-new:seen-version", version);
      localStorage.setItem("marinara-active-chat-id", chatId);
    },
    { chatId, version: APP_VERSION },
  );
}

async function readPreferences(page: Page) {
  return page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    const state = useUIStore.getState();
    return {
      preset: state.chatWidgetPreset,
      font: state.chatWidgetFont,
      shape: state.chatWidgetShape,
      ready: state.settingsSyncReady,
    };
  });
}

async function openAppearance(page: Page) {
  await closeChatSettings(page);
  await clickTopbarPanel(page, "settings");
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("group", { name: "Appearance by chat mode", exact: true })
    .getByRole("button", { name: "App", exact: true })
    .click();
  const controls = page.locator("[data-chat-widget-style-controls]");
  await controls.scrollIntoViewIfNeeded();
  await expect(controls).toBeVisible();
  await expect(controls).toHaveCSS("border-top-width", "0px");
  const cards = controls.locator("[data-chat-widget-preset-option]");
  await expect(cards).toHaveCount(3);
  await expect
    .poll(() =>
      cards.evaluateAll((elements) => Math.min(...elements.map((element) => element.getBoundingClientRect().width))),
    )
    .toBeGreaterThanOrEqual(150);
  for (const preset of ["dottore", "mari"]) {
    const insets = await controls
      .locator(`[data-chat-widget-preset-option="${preset}"] .mari-window`)
      .evaluate((element) => {
        const frame = element.getBoundingClientRect();
        const title = element.querySelector(".mari-window__title")!.getBoundingClientRect();
        const close = element.querySelector(".mari-window__header > svg")!.getBoundingClientRect();
        return { title: title.left - frame.left, close: frame.right - close.right };
      });
    expect(insets.title).toBeGreaterThanOrEqual(12);
    expect(insets.close).toBeGreaterThanOrEqual(12);
  }
  return controls;
}

async function choosePreset(page: Page, preset: Preset) {
  const controls = await openAppearance(page);
  const button = controls.locator(`[data-chat-widget-preset-option="${preset}"]`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => readPreferences(page)).toEqual({ preset, font: "", shape: "preset", ready: true });
  if (preset === "default") await expect(page.locator("html")).not.toHaveAttribute("data-chat-widget-preset");
  else await expect(page.locator("html")).toHaveAttribute("data-chat-widget-preset", preset);
  if (preset !== "default") {
    await page.screenshot({
      path: test.info().outputPath(`chat-widget-preview-${preset}.png`),
      animations: "disabled",
    });
  }
  await clickTopbarPanel(page, "settings");
  await expect(controls).toBeHidden();
}

async function computedAppearance(element: Locator) {
  return element.evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      image: style.backgroundImage,
      color: style.color,
      border: style.borderTopColor,
      radius: style.borderRadius,
      clip: style.clipPath,
      font: style.fontFamily,
    };
  });
}

async function resolvedStyle(page: Page, property: string, value: string) {
  return page.evaluate(
    ({ property, value }) => {
      const probe = document.createElement("span");
      probe.style.setProperty(property, value);
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return resolved;
    },
    { property, value },
  );
}

async function measureWidgets(page: Page) {
  const settings = await openChatSettings(page);
  // Keep hover/focus paint out of the comparison with the unchanged Default style.
  await page.mouse.move(1, 1);
  const drawer = settings.locator('[data-drawer="chat-name"]');
  await expect(drawer).toBeVisible();
  const appearance = {
    window: await computedAppearance(settings),
    frame: await settings.evaluate((element) => {
      const frame = getComputedStyle(element, "::after");
      return {
        background: frame.content === "none" ? getComputedStyle(element).backgroundColor : frame.backgroundColor,
        clip: frame.content === "none" ? "none" : frame.clipPath,
      };
    }),
    header: await computedAppearance(settings.locator(".mari-window__header")),
    title: await computedAppearance(settings.locator(".mari-window__title")),
    drawer: await computedAppearance(drawer.locator(".mari-drawer__header")),
  };
  await closeChatSettings(page);
  return { ...appearance, bubble: await computedAppearance(page.locator("[data-chat-settings-button]")) };
}

async function drag(page: Page, element: Locator, dx: number, dy: number) {
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function expectCustomColorsKeepCutCorners(page: Page) {
  const settings = await openChatSettings(page);
  const frameClip = await settings.evaluate((element) => getComputedStyle(element, "::after").clipPath);
  const customTheme = await page.addStyleTag({
    content: `.mari-window[data-window="chat-settings"] {
    --mari-window-bg: #18324b;
    --mari-window-border: #e4bc70;
    --mari-window-header-bg: #e7faff;
  }`,
  });
  try {
    await expect(settings).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(settings).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(settings).toHaveCSS("clip-path", "none");
    expect(
      await settings.evaluate((element) => ({
        fill: getComputedStyle(element, "::after").backgroundColor,
        border: getComputedStyle(element, "::before").backgroundColor,
        clip: getComputedStyle(element, "::after").clipPath,
      })),
    ).toEqual({ fill: "rgb(24, 50, 75)", border: "rgb(228, 188, 112)", clip: frameClip });
    const header = settings.locator(".mari-window__header");
    await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(
      await header.evaluate((element) => ({
        fill: getComputedStyle(element, "::before").backgroundColor,
        clip: getComputedStyle(element, "::before").clipPath,
      })),
    ).toEqual({ fill: "rgb(231, 250, 255)", clip: expect.stringContaining("polygon(") });
  } finally {
    await customTheme.evaluate((element) => element.parentNode?.removeChild(element));
    await closeChatSettings(page);
  }
}

async function exerciseWindow(page: Page, desktop: boolean) {
  const settings = await openChatSettings(page);
  if (desktop) {
    const before = (await settings.boundingBox())!;
    await drag(page, settings.locator(".mari-window__title"), -100, 0);
    await expect.poll(async () => (await settings.boundingBox())!.x).toBeLessThan(before.x - 80);
    const moved = (await settings.boundingBox())!;
    await drag(page, settings.locator('.mari-window__resize-handle[data-edge="se"]'), 32, -24);
    await expect.poll(async () => (await settings.boundingBox())!.width).toBeGreaterThan(moved.width + 20);
  }
  await settings
    .locator('[data-drawer="chat-name"]')
    .getByRole("button", { name: "Open Chat Name in its own window", exact: true })
    .click();
  if (!desktop) {
    await expect(settings).toBeHidden();
    await page.locator(`.mari-window-bubble[data-window="${CHAT_NAME_WINDOW}"]`).click();
  }
  const popped = page.locator(`.mari-window[data-window="${CHAT_NAME_WINDOW}"]`);
  await expect(popped).toBeVisible();
  await popped.getByRole("button", { name: "Widget appearance proof", exact: true }).click();
  await expect(popped.getByRole("textbox")).toHaveValue("Widget appearance proof");
  await popped.getByRole("textbox").press("Enter");
  await expect(popped.getByRole("button", { name: "Widget appearance proof", exact: true })).toBeVisible();
  await expect(popped.locator('[data-window-control="put-back"]')).toBeInViewport({ ratio: 1 });
  await popped.locator('[data-window-control="put-back"]').click();
  await expect(popped).toHaveCount(0);
  await openChatSettings(page);
  await expect(settings.locator('[data-drawer="chat-name"]')).toBeVisible();
}

async function expectCompactFramedWidgets(page: Page, preset: "dottore" | "mari", theme: string) {
  const settings = await openChatSettings(page);
  const header = settings.locator(".mari-window__header");
  expect(await header.evaluate((element) => getComputedStyle(element, "::before").backgroundImage)).not.toContain(
    "url(",
  );
  expect(await header.evaluate((element) => getComputedStyle(element, "::after").content)).not.toBe("none");
  const name = (await settings.locator('[data-drawer="chat-name"]').boundingBox())!;
  const branches = (await settings.locator('[data-drawer="conversation-chat-branches"]').boundingBox())!;
  expect(Math.abs(branches.y - (name.y + name.height))).toBeLessThanOrEqual(1);

  const body = settings.locator(".mari-window__body");
  const frame = (await settings.boundingBox())!;
  const content = (await body.boundingBox())!;
  expect(frame.y + frame.height - (content.y + content.height)).toBeGreaterThanOrEqual(4);
  const scroller = body.locator(":scope > .overflow-y-auto");
  await scroller.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({
    path: test.info().outputPath(`chat-widgets-${preset}-${theme}-scrolled.png`),
    animations: "disabled",
  });
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });

  if (preset === "mari") {
    const ornament = await page.locator("[data-chat-settings-button]").evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { images: style.backgroundImage, position: style.backgroundPosition };
    });
    expect(ornament.images.match(/url\(/gu)).toHaveLength(1);
    expect(ornament.position).toBe("50% 0%");
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`widget presets preserve Default and keep windows usable in ${theme} mode`, async ({
    page,
    request,
  }, testInfo) => {
    const chat = await createChat(request);
    try {
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await prepare(page, chat.id, theme);
      await page.goto("/");
      await expect(page.locator('[data-chat-mode="conversation"]')).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect
        .poll(() => readPreferences(page))
        .toEqual({ preset: "default", font: "", shape: "preset", ready: true });
      const baseline = await measureWidgets(page);
      // Default keeps the existing theme hooks, including the transparent drawer/title-bar surfaces.
      expect(baseline.window.background).toBe(
        await resolvedStyle(page, "background-color", "var(--marinara-chat-chrome-panel-bg)"),
      );
      expect(baseline.window.border).toBe(
        await resolvedStyle(page, "color", "var(--marinara-chat-chrome-panel-border)"),
      );
      expect(baseline.title.color).toBe(await resolvedStyle(page, "color", "var(--marinara-chat-chrome-panel-title)"));
      expect(baseline.header.background).toBe("rgba(0, 0, 0, 0)");
      expect(baseline.drawer.background).toBe("rgba(0, 0, 0, 0)");
      expect(baseline.bubble.radius).toBe(await resolvedStyle(page, "border-radius", "calc(var(--radius) + 0.125rem)"));
      const appearances: Awaited<ReturnType<typeof measureWidgets>>[] = [];
      for (const preset of ["dottore", "mari"] as const) {
        await choosePreset(page, preset);
        const appearance = await measureWidgets(page);
        appearances.push(appearance);
        const palette = PALETTES[theme][preset];
        expect(
          await page
            .locator("html")
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--mari-widget-bg").trim()),
        ).toBe(palette.background);
        expect(appearance.frame.background).toBe(await resolvedStyle(page, "color", palette.background));
        expect(appearance.title.color).toBe(await resolvedStyle(page, "color", palette.accent));
        expect(appearance.drawer.background).toBe(await resolvedStyle(page, "color", palette.field));
        expect(appearance.title.font).toContain(preset === "dottore" ? "monospace" : "serif");
        expect(appearance.frame.background).not.toBe(baseline.frame.background);
        expect(appearance.window.clip).toBe("none");
        if (preset === "dottore") expect(appearance.frame.clip).toContain("polygon(");
        expect(appearance.header).not.toEqual(baseline.header);
        expect(appearance.drawer).not.toEqual(baseline.drawer);
        expect(appearance.bubble).not.toEqual(baseline.bubble);
        if (preset === "dottore") await expectCustomColorsKeepCutCorners(page);
        await exerciseWindow(page, testInfo.project.name.includes("desktop"));
        await expectCompactFramedWidgets(page, preset, theme);
        await page.screenshot({
          path: testInfo.outputPath(`chat-widgets-${preset}-${theme}.png`),
          animations: "disabled",
        });
        await closeChatSettings(page);
      }
      expect(appearances[0]).not.toEqual(appearances[1]);
      await choosePreset(page, "default");
      expect(await measureWidgets(page)).toEqual(baseline);
    } finally {
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });
}

test("widget font and shape choices survive reload and a fresh browser, and Reset Appearance restores Default", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes("desktop"),
    "One real-server proof covers the shared appearance preferences.",
  );
  const original = (await (await request.get(UI_SETTINGS_PATH)).json()) as { value: string | null };
  const chat = await createChat(request);
  const freshContext = await browser.newContext({ viewport: page.viewportSize()! });
  const readSaved = async () => {
    const saved = (await (await request.get(UI_SETTINGS_PATH)).json()) as { value: string | null };
    return JSON.parse(saved.value || "{}") as Record<string, unknown>;
  };
  try {
    expect((await request.put(UI_SETTINGS_PATH, { data: { value: "" } })).ok()).toBeTruthy();
    await prepare(page, chat.id, "dark");
    await page.goto("/");
    await expect
      .poll(() => readPreferences(page))
      .toEqual({ preset: "default", font: "", shape: "preset", ready: true });
    const baseline = await measureWidgets(page);
    await choosePreset(page, "dottore");
    const preset = await measureWidgets(page);
    let controls = await openAppearance(page);
    await controls.locator("#chat-widget-font").selectOption("@serif");
    await controls.locator("#chat-widget-shape").selectOption("square");
    await clickTopbarPanel(page, "settings");
    const square = await measureWidgets(page);
    expect(square.title.font).toContain("serif");
    expect(square.title.font).not.toBe(preset.title.font);
    expect(square.window.radius).toBe("0px");
    expect(square.bubble.radius).toBe("0px");
    expect(square.frame.background).toBe(preset.frame.background);
    const expected = { preset: "dottore", font: "@serif", shape: "square", ready: true };
    await expect.poll(() => readPreferences(page)).toEqual(expected);
    await expect
      .poll(async () => {
        const saved = await readSaved();
        return { preset: saved.chatWidgetPreset, font: saved.chatWidgetFont, shape: saved.chatWidgetShape };
      })
      .toEqual({ preset: "dottore", font: "@serif", shape: "square" });
    await page.reload();
    await expect.poll(() => readPreferences(page)).toEqual(expected);
    expect(await measureWidgets(page)).toEqual(square);

    await prepare(freshContext, chat.id, "dark");
    const freshPage = await freshContext.newPage();
    await freshPage.goto(new URL("/", page.url()).toString());
    await expect.poll(() => readPreferences(freshPage)).toEqual(expected);
    expect(await measureWidgets(freshPage)).toEqual(square);
    await freshContext.close();

    // Overrides remain independent: changing shape keeps the chosen font and preset colors.
    const shapes = new Map<string, string>();
    for (const shape of ["rounded", "cut-corner", "arched"] as const) {
      controls = await openAppearance(page);
      await controls.locator("#chat-widget-shape").selectOption(shape);
      await clickTopbarPanel(page, "settings");
      const rendered = await measureWidgets(page);
      expect(rendered.title.font).toBe(square.title.font);
      expect(rendered.frame.background).toBe(square.frame.background);
      shapes.set(
        shape,
        JSON.stringify({ radius: rendered.window.radius, clip: rendered.frame.clip, bubble: rendered.bubble.radius }),
      );
    }
    expect(new Set(shapes.values()).size).toBe(3);
    await openAppearance(page);
    await page.getByRole("button", { name: "Reset Appearance", exact: true }).click();
    await expect
      .poll(() => readPreferences(page))
      .toEqual({ preset: "default", font: "", shape: "preset", ready: true });
    await clickTopbarPanel(page, "settings");
    const reset = await measureWidgets(page);
    expect(reset.title.font).toBe(baseline.title.font);
    expect(reset.window.radius).toBe(baseline.window.radius);
    expect(reset.window.clip).toBe(baseline.window.clip);
    await expect
      .poll(async () => {
        const saved = await readSaved();
        return [saved.chatWidgetPreset, saved.chatWidgetFont, saved.chatWidgetShape];
      })
      .toEqual(["default", "", "preset"]);
  } finally {
    await freshContext.close();
    // Stop its debounced persistence before restoring the shared server fixture.
    await page.close();
    await request.put(UI_SETTINGS_PATH, { data: { value: original.value ?? "" } });
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
