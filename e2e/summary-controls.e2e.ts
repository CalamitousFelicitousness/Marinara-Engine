import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createChatSummaryEntry } from "@marinara-engine/shared";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("summary toggles keep other entries usable and toggle all in one save", async ({ page, request }, info) => {
  const created = await request.post("/api/chats", { data: { name: "Summary controls", mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const entries = Array.from({ length: 19 }, (_, index) =>
    createChatSummaryEntry({
      id: `summary-${index}`,
      title: `Summary ${index + 1}`,
      content: "Historical facts. ".repeat(1800),
      enabled: true,
      sourceMode: "range",
      rangeStartIndex: index * 50 + 1,
      rangeEndIndex: (index + 1) * 50,
    }),
  );
  expect((await request.patch(`/api/chats/${id}/metadata`, { data: { summaryEntries: entries } })).ok()).toBeTruthy();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saves: Array<{ operation: string; entryIds?: string[] }> = [];
  await page.route(`**/api/chats/${id}/summary-entries`, async (route) => {
    saves.push(route.request().postDataJSON());
    if (saves.length === 1) await gate;
    await route.continue();
  });
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id, version },
    );
    await page.goto("/");
    if (info.project.name.includes("mobile"))
      await page.getByRole("button", { name: "More options", exact: true }).click();
    await page
      .getByRole("button", { name: "Chat Summary (19 active summaries)", exact: true })
      .filter({ visible: true })
      .click();
    const panel = page.locator("[data-chat-floating-panel]").filter({ hasText: "Chat Summary" });
    const toggles = panel.getByRole("button", { name: "Disable summary", exact: true });
    await expect(toggles).toHaveCount(19);
    await toggles.nth(0).click();
    await expect.poll(() => saves.length).toBe(1);
    await expect(toggles.nth(0)).toBeDisabled();
    await expect(toggles.nth(1)).toBeEnabled();
    await panel.getByRole("button", { name: "Expand summary entry", exact: true }).nth(1).click();
    await expect(panel.getByRole("button", { name: "Collapse summary entry", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("summary-toggle-other-rows-usable.png") });
    release!();
    await expect(toggles).toHaveCount(18);
    await panel.getByRole("button", { name: "Deactivate All", exact: true }).click();
    await expect.poll(() => saves.length).toBe(2);
    expect(saves[1]!.entryIds).toHaveLength(18);
    await expect(panel.getByRole("button", { name: "Activate All", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Activate All", exact: true }).click();
    await expect(toggles).toHaveCount(19);
    expect(saves).toHaveLength(3);
    expect(saves[2]!.entryIds).toHaveLength(19);
    const metadata = (await (await request.get(`/api/chats/${id}`)).json()).metadata;
    expect(metadata.summaryEntries.every((entry: { enabled: boolean }) => entry.enabled)).toBe(true);
  } finally {
    release?.();
    await request.delete(`/api/chats/${id}?force=true`);
  }
});

/** Playwright has no software keyboard. iPhone Safari shrinks only the visual viewport for it. */
async function installIphoneKeyboard(page: Page) {
  await page.addInitScript(() => {
    let keyboardTop: number | null = null;
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => keyboardTop ?? window.innerHeight },
      width: { get: () => window.innerWidth },
      offsetTop: { get: () => 0 },
      pageTop: { get: () => 0 },
      offsetLeft: { get: () => 0 },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "__setKeyboardTop", {
      value: (top: number | null) => {
        keyboardTop = top;
        viewport.dispatchEvent(new Event("resize"));
      },
    });
  });
}

test("Chat Summary keeps the field being edited above the phone keyboard", async ({ page, request }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "Only phones have an on-screen keyboard.");
  const iPhone = info.project.name === "mobile-webkit";
  const created = await request.post("/api/chats", { data: { name: "Summary keyboard", mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const entries = Array.from({ length: 4 }, (_, index) =>
    createChatSummaryEntry({
      id: `keyboard-summary-${index}`,
      title: `Summary ${index + 1}`,
      content: "The caravan crossed the dunes at dusk. ".repeat(12),
      enabled: true,
      sourceMode: "range",
      rangeStartIndex: index * 10 + 1,
      rangeEndIndex: (index + 1) * 10,
    }),
  );
  expect((await request.patch(`/api/chats/${id}/metadata`, { data: { summaryEntries: entries } })).ok()).toBeTruthy();
  for (let index = 0; index < 5; index += 1) {
    const message = { role: index % 2 ? "assistant" : "user", content: `Line ${index + 1}` };
    expect((await request.post(`/api/chats/${id}/messages`, { data: message })).ok()).toBeTruthy();
  }
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id, version },
    );
    if (iPhone) await installIphoneKeyboard(page);
    await page.goto("/");
    await page.getByRole("button", { name: "More options", exact: true }).click();
    await page
      .getByRole("button", { name: "Chat Summary (4 active summaries)", exact: true })
      .filter({ visible: true })
      .click();
    const panel = page.locator("[data-chat-floating-panel]").filter({ hasText: "Chat Summary" });
    await expect(panel).toBeVisible();

    const phone = page.viewportSize()!;
    const keyboardTop = Math.round(phone.height * 0.6);
    // Android shrinks the page for the keyboard; iPhone shrinks only what is visible.
    const setKeyboard = async (open: boolean) => {
      if (iPhone) {
        await page.evaluate(
          (top) => (window as typeof window & { __setKeyboardTop: (top: number | null) => void }).__setKeyboardTop(top),
          open ? keyboardTop : null,
        );
      } else {
        await page.setViewportSize(open ? { width: phone.width, height: keyboardTop } : phone);
      }
      const html = page.locator("html");
      if (open) await expect(html).toHaveAttribute("data-mari-software-keyboard-open", "");
      else await expect(html).not.toHaveAttribute("data-mari-software-keyboard-open");
    };
    // The field's first lines show above the keyboard, not scrolled out of the window around them.
    const showsAboveKeyboard = (field: Locator) =>
      field.evaluate((element, top) => {
        const box = element.getBoundingClientRect();
        return [box.top + 8, box.top + Math.min(box.height - 8, 56)].every((y) => {
          const hit = y > 0 && y < top && document.elementFromPoint(box.left + box.width / 2, y);
          return !!hit && (hit === element || element.contains(hit));
        });
      }, keyboardTop);
    // Focus a field low on the screen, where the keyboard will appear, then open the keyboard.
    const typeIn = async (name: string, field: Locator) => {
      await field.evaluate((element) => element.scrollIntoView({ block: "end" }));
      await field.focus();
      const before = (await field.boundingBox())!;
      expect(before.y + before.height, "the keyboard would cover the field").toBeGreaterThan(keyboardTop);
      await setKeyboard(true);
      await expect.poll(() => showsAboveKeyboard(field)).toBe(true);
      await page.screenshot({ path: info.outputPath(`keyboard-${name}.png`) });
      // The window fits above the keyboard, and scrolling it away from the field is not undone
      // by the next viewport update, so everything else is still a scroll away.
      const frame = (await panel.boundingBox())!;
      expect(frame.y + frame.height).toBeLessThanOrEqual(keyboardTop + 1);
      const scrollTopAfterUpdate = await panel.evaluate(async (element) => {
        // The window's own scroll area is the first one inside it.
        const area = [...element.querySelectorAll("*")].find(
          (node) => node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY),
        )!;
        area.scrollTop = 0;
        window.dispatchEvent(new Event("resize"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        return area.scrollTop;
      });
      expect(scrollTopAfterUpdate).toBe(0);
      await setKeyboard(false);
    };

    await panel.getByRole("button", { name: "Edit summary entry", exact: true }).last().click();
    const summaryField = panel.getByRole("textbox", { name: "Write or paste a summary of this chat...", exact: true });
    await expect(summaryField).toBeFocused();
    await typeIn("summary", summaryField);
    await typeIn("title", panel.getByPlaceholder("Summary title", { exact: true }));
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();

    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await typeIn(
      "prompt",
      panel.getByRole("textbox", { name: "Prompt instructions for summary generation...", exact: true }),
    );

    // Message ranges stay listed under the summaries after a run, and with several of them those
    // controls alone are taller than the room the keyboard leaves. They are hidden while you type.
    await panel.getByRole("button", { name: "Range", exact: true }).click();
    await panel.getByRole("spinbutton", { name: "Range 1 to message", exact: true }).fill("1");
    for (let added = 0; added < 4; added += 1) {
      await panel.getByRole("button", { name: "Add range", exact: true }).click();
    }
    await panel.getByRole("button", { name: "Edit summary entry", exact: true }).last().click();
    await expect(summaryField).toBeFocused();
    await setKeyboard(true);
    await expect.poll(() => showsAboveKeyboard(summaryField)).toBe(true);
    await page.screenshot({ path: info.outputPath("keyboard-summary-ranges.png") });
    // A field in those controls keeps them in view.
    await setKeyboard(false);
    const lastRangeEnd = panel.getByRole("spinbutton", { name: "Range 5 to message", exact: true });
    await lastRangeEnd.focus();
    await setKeyboard(true);
    await expect(lastRangeEnd).toBeFocused();
    await expect.poll(() => showsAboveKeyboard(lastRangeEnd)).toBe(true);
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
  }
});
