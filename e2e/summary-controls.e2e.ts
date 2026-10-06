import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { compileChatSummaryEntries, createChatSummaryEntry, type ChatSummaryEntry } from "@marinara-engine/shared";
import { seedUIState } from "./ui-state-fixture.js";
import { chatSettingsWindow, openChatSettingsTool } from "./chat-settings-tools.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function summaryRow(panel: Locator, entryId: string) {
  return panel.locator(`[data-summary-entry-id="${entryId}"]`);
}

async function expectSummarySelection(panel: Locator, entryIds: string[]) {
  await expect
    .poll(() =>
      panel.locator("[data-summary-entry-id]").evaluateAll((rows) =>
        rows
          .filter((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)
          .map((row) => row.getAttribute("data-summary-entry-id")!)
          .sort(),
      ),
    )
    .toEqual([...entryIds].sort());
}

async function openSummaryFixture(
  page: Page,
  request: APIRequestContext,
  name: string,
  entries: ChatSummaryEntry[],
  withMessage = false,
) {
  const created = await request.post("/api/chats", { data: { name, mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  expect(
    (
      await request.patch(`/api/chats/${id}/metadata`, {
        data: { summaryEntries: entries, summary: compileChatSummaryEntries(entries) },
      })
    ).ok(),
  ).toBeTruthy();
  if (withMessage) {
    expect(
      (await request.post(`/api/chats/${id}/messages`, { data: { role: "user", content: "Synthetic source." } })).ok(),
    ).toBeTruthy();
  }
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
  return { id: id as string, panel: await openChatSettingsTool(page, "chat-summary") };
}

function selectionFixtureEntries() {
  // Persisted order deliberately disagrees with titles, dates and source message numbers.
  return [
    "manual-z",
    "automated-b",
    "duplicate-r",
    "manual-a",
    "combined-x",
    "duplicate-l",
    "legacy-y",
    "manual-q",
  ].map((id, index) =>
    createChatSummaryEntry({
      id,
      title:
        index === 2 || index === 5 ? "The same title" : index === 4 ? "Combined recollection" : "Unnumbered memory",
      content: `Individual fact ${id}.`,
      origin: index === 1 ? "automated" : index === 6 ? "legacy" : "manual",
      sourceMode: index === 1 ? "agent" : "range",
      rangeStartIndex: 900 - index * 50,
      rangeEndIndex: 910 - index * 50,
      createdAt: new Date(Date.UTC(2026, 0, 8 - index)).toISOString(),
      enabled: true,
    }),
  );
}

async function chooseSummaryEndpoint(row: Locator, info: TestInfo) {
  const endpoint = row.getByRole("button", { name: /^Choose (first|last) summary/ });
  if (info.project.name.startsWith("mobile")) await endpoint.tap();
  else await endpoint.click();
}

test("summary Shift selection follows visible IDs and keeps the ordinary anchor", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Shift selection is the desktop interaction.");
  const entries = selectionFixtureEntries();
  const ids = entries.map((entry) => entry.id);
  const { id, panel } = await openSummaryFixture(page, request, "Summary Shift selection", entries);
  const checkbox = (index: number) => summaryRow(panel, ids[index]!).getByRole("checkbox");
  try {
    await checkbox(7).click();
    await checkbox(1).click();
    await checkbox(4).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, [...ids.slice(1, 5), ids[7]!]);
    // A selected target removes the interval while preserving selections beyond it.
    await checkbox(3).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, [ids[4]!, ids[7]!]);
    await checkbox(6).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, ids.slice(1));
    // An ordinary removal establishes a new anchor; the next interval runs backwards.
    await checkbox(4).click();
    await checkbox(1).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, ids.slice(5));
    await checkbox(6).click();
    await checkbox(2).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, ids.slice(2));
    await panel.getByRole("button", { name: "Select all", exact: true }).click();
    await panel.getByRole("button", { name: "Clear selection", exact: true }).click();
    await checkbox(3).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, [ids[3]!]);
    await checkbox(5).click({ modifiers: ["Shift"] });
    await expectSummarySelection(panel, ids.slice(3, 6));
    await checkbox(0).focus();
    await page.keyboard.press("Space");
    await expectSummarySelection(panel, [ids[0]!, ...ids.slice(3, 6)]);
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
  }
});

test("summary endpoint selection toggles complete ranges, stays additive otherwise and handles list changes", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  const entries = selectionFixtureEntries();
  entries[1] = { ...entries[1]!, enabled: false };
  const ids = entries.map((entry) => entry.id);
  const { id, panel } = await openSummaryFixture(page, request, "Summary endpoint selection", entries, true);
  let otherChatId: string | undefined;
  let releaseGeneration: (() => void) | undefined;
  const range = panel.getByRole("button", { name: "Select range", exact: true });
  const status = panel.getByRole("status").filter({ hasText: /^Choose (first|last) summary$/ });
  const begin = async (index: number) => {
    await range.click();
    await expect(range).toHaveAttribute("aria-pressed", "true");
    await expect(status).toHaveText("Choose first summary");
    await chooseSummaryEndpoint(summaryRow(panel, ids[index]!), info);
    await expect(status).toHaveText("Choose last summary");
  };
  let expected = [ids[0]!];
  try {
    const hint = panel.getByRole("tooltip", {
      name: "Shift-click summary checkboxes to select or deselect a range.",
    });
    await range.hover();
    if (info.project.name === "desktop-chromium") {
      // Immediate hover guidance is also available to desktop keyboard users.
      await expect(hint).toBeVisible({ timeout: 250 });
      await expect(range).toHaveAttribute("aria-describedby", new RegExp((await hint.getAttribute("id"))!));
      await hint.hover();
      await expect(hint).toBeVisible();
      await page.screenshot({ path: info.outputPath("summary-range-shift-hint.png") });
      await panel.getByRole("button", { name: "Show Inactive", exact: true }).hover();
      await expect(hint).toHaveCount(0);
      await range.focus();
      await expect(hint).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(hint).toHaveCount(0);
      await expect(chatSettingsWindow(page)).toBeVisible();
      await expect(range).toHaveAttribute("aria-pressed", "false");
    } else {
      await expect(hint).toHaveCount(0);
      await range.tap();
      await expect(range).toHaveAttribute("aria-pressed", "true");
      await expect(hint).toHaveCount(0);
      await panel.getByRole("button", { name: "Cancel range", exact: true }).tap();
      await expectSummarySelection(panel, []);
    }
    await expect(summaryRow(panel, ids[1]!)).toHaveCount(0);
    await panel.getByRole("button", { name: "Show Inactive", exact: true }).click();
    await summaryRow(panel, ids[0]!).getByRole("checkbox").click();
    await begin(5);
    await expect(panel.getByRole("button", { name: "Delete selected (1)", exact: true })).toBeVisible();
    await expect(summaryRow(panel, ids[5]!).getByText("Start here", { exact: true })).toBeVisible();
    await expect(summaryRow(panel, ids[5]!).getByRole("checkbox")).toHaveCount(0);
    await chooseSummaryEndpoint(summaryRow(panel, ids[2]!), info);
    expected = [ids[0]!, ...ids.slice(2, 6)];
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expectSummarySelection(panel, expected);

    // Fully selected intervals are removed, including backwards ranges; outside selections survive.
    await begin(5);
    await expect(panel.getByRole("button", { name: "Delete selected (5)", exact: true })).toBeVisible();
    await chooseSummaryEndpoint(summaryRow(panel, ids[2]!), info);
    await expectSummarySelection(panel, [ids[0]!]);
    await page.screenshot({ path: info.outputPath("summary-range-deselected.png") });
    await begin(2);
    await chooseSummaryEndpoint(summaryRow(panel, ids[5]!), info);
    await expectSummarySelection(panel, expected);
    await begin(2);
    await chooseSummaryEndpoint(summaryRow(panel, ids[5]!), info);
    await expectSummarySelection(panel, [ids[0]!]);
    await begin(5);
    await chooseSummaryEndpoint(summaryRow(panel, ids[2]!), info);
    await expectSummarySelection(panel, expected);
    // Selected endpoints with an unchecked row between them still add the entire interval.
    await summaryRow(panel, ids[3]!).getByRole("checkbox").click();
    await begin(5);
    await chooseSummaryEndpoint(summaryRow(panel, ids[2]!), info);
    await expectSummarySelection(panel, expected);

    await begin(6);
    await panel.getByRole("button", { name: "Cancel range", exact: true }).click();
    await expectSummarySelection(panel, expected);
    await begin(6);
    await summaryRow(panel, ids[6]!)
      .getByRole("button", { name: /^Choose last summary/ })
      .focus();
    await page.keyboard.press("Escape");
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expect(chatSettingsWindow(page)).toBeVisible();
    await expectSummarySelection(panel, expected);

    // Escape in the enclosing title bar also cancels the range before the window can close.
    await begin(6);
    await chatSettingsWindow(page).locator('[data-window-control="close"]').focus();
    await page.keyboard.press("Escape");
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expect(chatSettingsWindow(page)).toBeVisible();
    await expect(range).toBeFocused();
    await expectSummarySelection(panel, expected);

    await begin(7);
    await chooseSummaryEndpoint(summaryRow(panel, ids[7]!), info);
    expected.push(ids[7]!);
    await expectSummarySelection(panel, expected);
    await begin(7);
    await chooseSummaryEndpoint(summaryRow(panel, ids[7]!), info);
    await expectSummarySelection(
      panel,
      expected.filter((entryId) => entryId !== ids[7]),
    );
    await begin(7);
    await chooseSummaryEndpoint(summaryRow(panel, ids[7]!), info);
    await expectSummarySelection(panel, expected);
    // Native buttons support keyboard endpoints and remain in the Tab sequence.
    await range.click();
    await range.focus();
    const first = summaryRow(panel, ids[0]!).getByRole("button", { name: /^Choose first summary/ });
    const beforeFocus = await first.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.outlineStyle, style.outlineWidth, style.boxShadow];
    });
    for (
      let attempts = 0;
      attempts < 20 && !(await first.evaluate((element) => element === document.activeElement));
      attempts += 1
    ) {
      // WebKit on macOS uses Option+Tab to visit every native control.
      await page.keyboard.press(info.project.name === "mobile-webkit" ? "Alt+Tab" : "Tab");
    }
    await expect(first).toBeFocused();
    expect(await first.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    expect(
      await first.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.outlineStyle, style.outlineWidth, style.boxShadow];
      }),
    ).not.toEqual(beforeFocus);
    await page.keyboard.press("Enter");
    await summaryRow(panel, ids[6]!)
      .getByRole("button", { name: /^Choose last summary/ })
      .focus();
    await page.keyboard.press("Space");
    expected = [...ids];
    await expectSummarySelection(panel, expected);
    await begin(0);
    await chooseSummaryEndpoint(summaryRow(panel, ids[7]!), info);
    await expectSummarySelection(panel, []);
    await expect(panel.getByRole("button", { name: /^Delete selected/ })).toHaveCount(0);
    await panel.getByRole("button", { name: "Select all", exact: true }).click();
    await summaryRow(panel, ids[3]!).getByRole("checkbox").click();
    expected = expected.filter((entryId) => entryId !== ids[3]);
    await expectSummarySelection(panel, expected);

    await begin(6);
    await panel.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expectSummarySelection(panel, ids);
    await summaryRow(panel, ids[3]!).getByRole("checkbox").click();
    await expectSummarySelection(panel, expected);

    await begin(6);
    await panel.getByRole("button", { name: "Hide Inactive", exact: true }).click();
    await expect(range).toHaveAttribute("aria-pressed", "false");
    expected = expected.filter((entryId) => entryId !== ids[1]);
    await expectSummarySelection(panel, expected);
    await panel.getByRole("button", { name: "Show Inactive", exact: true }).click();
    await begin(6);
    await summaryRow(panel, ids[2]!).getByRole("button", { name: / up$/ }).click();
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        panel
          .locator("[data-summary-entry-id]")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-summary-entry-id"))),
      )
      .toEqual([ids[0], ids[2], ids[1], ...ids.slice(3)]);
    await expectSummarySelection(panel, expected);

    await begin(6);
    await summaryRow(panel, ids[3]!).getByRole("button", { name: "Delete summary entry", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "Delete summary entry?", exact: true });
    await deletion.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(summaryRow(panel, ids[3]!)).toHaveCount(0);
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expectSummarySelection(panel, expected);
    await summaryRow(panel, ids[4]!).getByRole("button", { name: "Edit summary entry", exact: true }).click();
    await expect(range).toBeDisabled();
    await summaryRow(panel, ids[4]!).getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("button", { name: "Write", exact: true }).click();
    await expect(range).toBeDisabled();
    const draft = panel
      .locator("[data-summary-entry-id]")
      .filter({ has: page.getByRole("textbox", { name: "Write or paste a summary of this chat...", exact: true }) });
    await expect(draft.getByRole("checkbox")).toBeDisabled();
    await draft.getByRole("button", { name: "Cancel", exact: true }).click();

    await begin(6);
    await panel.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(range).toHaveAttribute("aria-pressed", "false");
    await expectSummarySelection(panel, []);
    await panel.getByRole("button", { name: "Select all", exact: true }).click();

    // Delayed synthetic generation changes this fixture only; no provider is contacted.
    const generated = createChatSummaryEntry({
      id: "synthetic-generated-summary",
      title: "Generated fixture",
      content: "A synthetic new fact.",
      origin: "automated",
      sourceMode: "agent",
    });
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let generationRequests = 0;
    await page.route(`**/api/chats/${id}/generate-summary`, async (route) => {
      generationRequests += 1;
      await generationGate;
      const metadata = (await (await request.get(`/api/chats/${id}`)).json()).metadata;
      const generatedEntries = [...metadata.summaryEntries, generated];
      const summary = compileChatSummaryEntries(generatedEntries);
      expect(
        (
          await request.patch(`/api/chats/${id}/metadata`, { data: { summaryEntries: generatedEntries, summary } })
        ).ok(),
      ).toBeTruthy();
      await route.fulfill({
        json: { entries: generatedEntries, entry: generated, summary, messageIds: [], hideMessageIds: [] },
      });
    });
    await begin(6);
    await panel.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => generationRequests).toBe(1);
    await expect(range).toBeDisabled();
    await expect(range).toHaveAttribute("aria-pressed", "false");
    releaseGeneration!();
    await expect(summaryRow(panel, generated.id)).toBeVisible();
    await expect(range).toBeEnabled();
    await expectSummarySelection(
      panel,
      ids.filter((entryId) => entryId !== ids[3]),
    );
    expect(generationRequests).toBe(1);

    // A chat switch uses the live store, without a reload that would mask leaked component state.
    const created = await request.post("/api/chats", { data: { name: "Other summary selection", mode: "roleplay" } });
    expect(created.ok()).toBeTruthy();
    otherChatId = (await created.json()).id;
    expect(
      (await request.patch(`/api/chats/${otherChatId}/metadata`, { data: { summaryEntries: entries } })).ok(),
    ).toBeTruthy();
    await begin(6);
    await page.evaluate(async (nextChatId) => {
      const module = (await import("/src/stores/chat.store.ts" as string)) as PageChatStoreModule;
      module.useChatStore.getState().setActiveChatId(nextChatId);
    }, otherChatId!);
    // ChatArea briefly remounts the window while the other chat loads.
    await expect(chatSettingsWindow(page)).toBeVisible();
    const otherPanel = await openChatSettingsTool(page, "chat-summary");
    await expect(summaryRow(otherPanel, ids[3]!)).toBeVisible();
    await expect(summaryRow(otherPanel, generated.id)).toHaveCount(0);
    await expect(otherPanel.getByRole("button", { name: "Select range", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expectSummarySelection(otherPanel, []);
    await expect(otherPanel.getByRole("button", { name: "Enable selected", exact: true })).toHaveCount(0);
    await expect(otherPanel.getByRole("button", { name: "Disable selected", exact: true })).toHaveCount(0);
  } finally {
    releaseGeneration?.();
    await request.delete(`/api/chats/${id}?force=true`);
    if (otherChatId) await request.delete(`/api/chats/${otherChatId}?force=true`);
  }
});

test("a 100-of-200 summary range saves only changed IDs once and survives failed bulk saves", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  const entries = Array.from({ length: 200 }, (_, index) =>
    createChatSummaryEntry({
      id: `bulk-memory-${(index * 73) % 200}`,
      title:
        index % 3
          ? "An unnumbered shared title"
          : "A very long recollection title that remains readable in the existing summary row without widening the phone toolbar",
      content: `Fact ${index}.`,
      enabled: index % 2 === 0,
      origin: index % 3 === 0 ? "automated" : "manual",
      sourceMode: index % 3 === 0 ? "agent" : "range",
      rangeStartIndex: 2000 - index * 2,
      rangeEndIndex: 2001 - index * 2,
    }),
  );
  const { id, panel } = await openSummaryFixture(page, request, "Summary 200-entry bulk selection", entries);
  const selected = entries.slice(50, 150);
  const selectedIds = selected.map((entry) => entry.id);
  const saves: Array<{ operation: string; entryIds?: string[]; enabled?: boolean }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chats/${id}/summary-entries`, async (route) => {
    saves.push(route.request().postDataJSON());
    if (saves.length === 1) {
      await gate;
      await route.fulfill({ status: 500, json: { error: "Synthetic summary save rejection" } });
    } else await route.continue();
  });
  const assertToolbarFits = async () => {
    const layout = await panel.locator("[data-chat-summary]").evaluate((scope) => {
      const box = scope.getBoundingClientRect();
      const controls = [...scope.querySelectorAll("button")].filter((button) =>
        /^(Select range|Cancel range|Select all|Clear selection|Show Inactive|Hide Inactive|Activate All|Deactivate All|Enable selected|Disable selected|Combine \d+ selected|Delete selected)/.test(
          button.textContent?.trim() ?? "",
        ),
      );
      return {
        fits: scope.scrollWidth <= scope.clientWidth,
        controlsFit: controls.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= box.left - 1 && rect.right <= box.right + 1 && button.scrollWidth <= button.clientWidth;
        }),
        touchHeights: controls.map((button) => button.getBoundingClientRect().height),
      };
    });
    expect(layout.fits).toBe(true);
    expect(layout.controlsFit).toBe(true);
    expect(layout.touchHeights.every((height) => height >= 32)).toBe(true);
  };
  try {
    await panel.getByRole("button", { name: "Show Inactive", exact: true }).click();
    await expect(panel.locator("[data-summary-entry-id]")).toHaveCount(200);
    await panel.getByRole("button", { name: "Select range", exact: true }).click();
    await chooseSummaryEndpoint(summaryRow(panel, selectedIds[0]!), info);
    await expect(panel.getByRole("button", { name: /^Delete selected/ })).toHaveCount(0);
    await chooseSummaryEndpoint(summaryRow(panel, selectedIds[99]!), info);
    await expectSummarySelection(panel, selectedIds);
    const enable = panel.getByRole("button", { name: "Enable selected", exact: true });
    const disable = panel.getByRole("button", { name: "Disable selected", exact: true });
    await expect(enable).toBeVisible();
    await expect(disable).toBeVisible();
    await enable.scrollIntoViewIfNeeded();
    await assertToolbarFits();
    await page.screenshot({ path: info.outputPath("summary-selection-toolbar-dark.png") });
    await page.evaluate(async () => {
      const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
      module.useUIStore.getState().setTheme("light");
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await assertToolbarFits();
    await page.screenshot({ path: info.outputPath("summary-selection-toolbar-light.png") });
    await page.evaluate(async () => {
      const module = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
      module.useUIStore.getState().setVisualTheme("sillytavern");
    });
    await expect(page.locator("html")).toHaveAttribute("data-visual-theme", "sillytavern");
    await assertToolbarFits();
    await page.screenshot({ path: info.outputPath("summary-selection-toolbar-compatibility.png") });
    if (info.project.name.startsWith("mobile")) {
      const portrait = page.viewportSize()!;
      await page.setViewportSize({ width: portrait.height, height: portrait.width });
      await assertToolbarFits();
      await enable.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("summary-selection-toolbar-landscape.png") });
      await page.setViewportSize(portrait);
    }

    await enable.click();
    await expect.poll(() => saves.length).toBe(1);
    const needsEnable = selected.filter((entry) => !entry.enabled).map((entry) => entry.id);
    expect(saves[0]).toEqual({ operation: "toggle", entryIds: needsEnable, enabled: true });
    expect(new Set(saves[0]!.entryIds).size).toBe(50);
    await expect(enable).toBeDisabled();
    await expect(disable).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Select range", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Deactivate All", exact: true })).toBeDisabled();
    for (const entryId of needsEnable)
      await expect(
        summaryRow(panel, entryId).getByRole("button", { name: "Enable summary", exact: true }),
      ).toBeDisabled();
    await summaryRow(panel, entries[0]!.id).getByRole("button", { name: "Expand summary entry", exact: true }).click();
    await expect(
      summaryRow(panel, entries[0]!.id).getByRole("button", { name: "Collapse summary entry", exact: true }),
    ).toBeVisible();
    release();
    await expect(page.getByText("Could not update summary entries.", { exact: true })).toBeVisible();
    await expect(enable).toBeEnabled();
    await expectSummarySelection(panel, selectedIds);
    const failedMetadata = (await (await request.get(`/api/chats/${id}`)).json()).metadata;
    expect(failedMetadata.summaryEntries.map((entry: ChatSummaryEntry) => [entry.id, entry.enabled])).toEqual(
      entries.map((entry) => [entry.id, entry.enabled]),
    );
    await enable.click();
    await expect(disable).toBeEnabled();
    await expect(enable).toHaveCount(0);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual({ operation: "toggle", entryIds: needsEnable, enabled: true });
    await expect(panel.getByRole("button", { name: "Hide Inactive", exact: true })).toBeVisible();
    await expectSummarySelection(panel, selectedIds);
    await disable.click();
    await expect(enable).toBeEnabled();
    await expect(disable).toHaveCount(0);
    expect(saves).toHaveLength(3);
    expect(saves[2]).toEqual({ operation: "toggle", entryIds: selectedIds, enabled: false });
    expect(new Set(saves[2]!.entryIds).size).toBe(100);
    const metadata = (await (await request.get(`/api/chats/${id}`)).json()).metadata;
    expect(metadata.summaryEntries).toHaveLength(200);
    expect(metadata.summaryEntries.map((entry: ChatSummaryEntry) => [entry.id, entry.enabled])).toEqual(
      entries.map((entry) => [entry.id, selectedIds.includes(entry.id) ? false : entry.enabled]),
    );
    await expectSummarySelection(panel, selectedIds);
  } finally {
    release();
    await request.delete(`/api/chats/${id}?force=true`);
  }
});

test("retained Combine originals recover through explicit selected actions without generation", async ({
  page,
  request,
}, info) => {
  const originals = ["retained-b", "retained-a"].map((id) =>
    createChatSummaryEntry({
      id,
      title: "Retained recollection",
      content: `ORIGINAL_${id}`,
      enabled: false,
      origin: id.endsWith("a") ? "automated" : "manual",
    }),
  );
  const combined = createChatSummaryEntry({
    id: "combined-retained",
    title: "Combined recollection",
    content: "COMBINED_OUTPUT",
    enabled: true,
  });
  const entries = [combined, ...originals];
  const { id, panel } = await openSummaryFixture(page, request, "Summary Combine recovery", entries);
  let emptyChatId: string | undefined;
  let generationCalls = 0;
  const saves: Array<{ operation: string; entryIds?: string[]; entryId?: string; enabled?: boolean }> = [];
  await page.route("**/api/chats/*/generate-summary", (route) => {
    generationCalls += 1;
    return route.fulfill({ status: 500, json: { error: "Generation is outside this recovery fixture" } });
  });
  await page.route(`**/api/chats/${id}/summary-entries`, async (route) => {
    saves.push(route.request().postDataJSON());
    await route.continue();
  });
  try {
    await expect(panel.locator("[data-summary-entry-id]")).toHaveCount(1);
    await panel.getByRole("button", { name: "Select range", exact: true }).click();
    await chooseSummaryEndpoint(summaryRow(panel, combined.id), info);
    await chooseSummaryEndpoint(summaryRow(panel, combined.id), info);
    await expectSummarySelection(panel, [combined.id]);
    await panel.getByRole("button", { name: "Clear selection", exact: true }).click();
    await panel.getByRole("button", { name: "Show Inactive", exact: true }).click();
    await panel.getByRole("button", { name: "Select range", exact: true }).click();
    await chooseSummaryEndpoint(summaryRow(panel, originals[1]!.id), info);
    await chooseSummaryEndpoint(summaryRow(panel, originals[0]!.id), info);
    await expectSummarySelection(
      panel,
      originals.map((entry) => entry.id),
    );
    await expect(panel.getByRole("button", { name: "Disable selected", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Combine 2 selected summaries", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Enable selected", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Disable selected", exact: true })).toBeEnabled();
    // A row's toggle remains single-row even with multiple selected originals.
    await summaryRow(panel, combined.id).getByRole("button", { name: "Disable summary", exact: true }).click();
    await expect(
      summaryRow(panel, combined.id).getByRole("button", { name: "Enable summary", exact: true }),
    ).toBeEnabled();
    expect(saves).toEqual([
      { operation: "toggle", entryIds: originals.map((entry) => entry.id), enabled: true },
      { operation: "toggle", entryId: combined.id, enabled: false },
    ]);
    const metadata = (await (await request.get(`/api/chats/${id}`)).json()).metadata;
    expect(metadata.summaryEntries.map((entry: ChatSummaryEntry) => entry.id)).toEqual(
      entries.map((entry) => entry.id),
    );
    expect(metadata.summary).toBe(originals.map((entry) => entry.content).join("\n\n"));
    expect(metadata.summary).not.toContain(combined.content);
    expect(generationCalls).toBe(0);
    await expect(panel.getByRole("button", { name: "Hide Inactive", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Delete selected (2)", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "Delete selected summaries?", exact: true });
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectSummarySelection(
      panel,
      originals.map((entry) => entry.id),
    );
    expect(saves).toHaveLength(2);

    const empty = await request.post("/api/chats", { data: { name: "Empty summary selection", mode: "roleplay" } });
    expect(empty.ok()).toBeTruthy();
    emptyChatId = (await empty.json()).id;
    await page.evaluate(async (nextChatId) => {
      const module = (await import("/src/stores/chat.store.ts" as string)) as PageChatStoreModule;
      module.useChatStore.getState().setActiveChatId(nextChatId);
    }, emptyChatId!);
    await expect(chatSettingsWindow(page)).toBeVisible();
    const emptyPanel = await openChatSettingsTool(page, "chat-summary");
    await expect(emptyPanel.locator("[data-summary-entry-id]")).toHaveCount(0);
    await expect(emptyPanel.getByRole("button", { name: "Enable selected", exact: true })).toHaveCount(0);
    await expect(emptyPanel.getByRole("button", { name: "Disable selected", exact: true })).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
    if (emptyChatId) await request.delete(`/api/chats/${emptyChatId}?force=true`);
  }
});

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
    const panel = await openChatSettingsTool(page, "chat-summary");
    await expect(panel.locator(".mari-drawer__count")).toHaveText("19");
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

// #7029: the range fields showed two or three digits, in half the footer, behind an accent border.
test("Chat Summary range fields fit long message numbers in a quiet box", async ({ page, request }, info) => {
  const created = await request.post("/api/chats", { data: { name: "Summary ranges", mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  for (let index = 0; index < 3; index += 1) {
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
      // Range mode remembers one range for every chat; this one was picked in a longer chat.
      summaryPopoverSettings: {
        sourceMode: "range",
        contextSize: null,
        rangeStart: 559,
        rangeEnd: 679,
        hideSummarisedMessages: false,
        collapseHiddenMessages: false,
      },
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id, version },
    );
    await page.goto("/");
    // Chat Summary is a Chat Settings drawer (#7034).
    const panel = await openChatSettingsTool(page, "chat-summary");
    const range = panel.getByRole("group", { name: "Range 1", exact: true });
    const from = range.getByRole("spinbutton", { name: "Range 1 from message", exact: true });
    const to = range.getByRole("spinbutton", { name: "Range 1 to message", exact: true });
    const outside = range.getByText("This range is outside the chat history.", { exact: true });
    // It opens on this chat's messages, not as an error.
    await expect.soft(from).toHaveValue("1");
    await expect.soft(to).toHaveValue("3");
    await expect.soft(outside).toBeHidden();

    await from.fill("1234");
    await to.fill("12345");
    await expect(outside).toBeVisible();
    // A range outside the chat selects nothing, as the header says for several ranges.
    await expect.soft(panel.getByText("0 messages selected", { exact: true })).toBeVisible();
    for (const field of [from, to]) {
      expect.soft(await field.evaluate((input) => input.scrollWidth <= input.clientWidth)).toBe(true);
    }
    const layout = await range.evaluate((box) => {
      const summary = box.closest("[data-chat-summary]")!;
      const scope = [...summary.querySelectorAll("p")].find(
        (label) => label.textContent === "Summary Scope",
      )!.parentElement!;
      return {
        border: getComputedStyle(box).borderTopColor,
        sectionBorder: getComputedStyle(scope).borderTopColor,
        widthShare: box.getBoundingClientRect().width / summary.getBoundingClientRect().width,
      };
    });
    // The same quiet border as the window's sections, even for a range that needs fixing,
    // and the range spans the summary section instead of its left half.
    expect.soft(layout.border).toBe(layout.sectionBorder);
    expect.soft(layout.widthShare).toBeGreaterThan(0.8);
    await page.screenshot({ path: info.outputPath("summary-range-fields.png") });
    // Escape dismisses the template choices without closing the surrounding settings window.
    const template = panel.getByRole("button", { name: "Summary prompt template", exact: true });
    await template.click();
    const choices = panel.getByRole("listbox");
    await expect(choices).toBeVisible();
    await choices.getByRole("option").first().focus();
    await page.keyboard.press("Escape");
    await expect(choices).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(template).toBeFocused();
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
  }
});

// Until the message count arrives, the chat looks only as long as its loaded messages.
test("Chat Summary keeps a remembered range when the message count arrives late", async ({ page, request }, info) => {
  const created = await request.post("/api/chats", { data: { name: "Summary late count", mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  for (let index = 0; index < 12; index += 1) {
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
      messagesPerPage: 5,
      summaryPopoverSettings: {
        sourceMode: "range",
        contextSize: null,
        rangeStart: 7,
        rangeEnd: 10,
        hideSummarisedMessages: false,
        collapseHiddenMessages: false,
      },
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id, version },
    );
    const openWithLateCount = async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.unroute(`**/api/chats/${id}/message-count`);
      await page.route(`**/api/chats/${id}/message-count`, async (route) => {
        await gate;
        await route.continue();
      });
      await page.goto("/");
      const panel = await openChatSettingsTool(page, "chat-summary");
      const from = panel.getByRole("spinbutton", { name: "Range 1 from message", exact: true });
      const to = panel.getByRole("spinbutton", { name: "Range 1 to message", exact: true });
      await expect(from).toBeVisible();
      return { panel, from, to, release };
    };

    const late = await openWithLateCount();
    late.release();
    await expect.soft(late.from).toHaveValue("7");
    await expect.soft(late.to).toHaveValue("10");

    // A range you already changed stays as you left it.
    const edited = await openWithLateCount();
    await edited.from.fill("2");
    await edited.from.blur();
    const editedTo = await edited.to.inputValue();
    edited.release();
    // The fields take the chat's real length, then any update from it has had a frame to land.
    await expect(edited.from).toHaveAttribute("max", "12");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));
    await expect.soft(edited.from).toHaveValue("2");
    await expect.soft(edited.to).toHaveValue(editedTo);

    // Switching to Range starts on the Last window, the same as when the count is already known.
    const switched = await openWithLateCount();
    await switched.panel.getByRole("button", { name: "Last", exact: true }).click();
    await expect(switched.from).toBeHidden();
    await switched.panel.getByRole("button", { name: "Range", exact: true }).click();
    await expect(switched.from).toBeVisible();
    switched.release();
    await expect(switched.from).toHaveAttribute("max", "12");
    await expect.soft(switched.from).toHaveValue("1");
    await expect.soft(switched.to).toHaveValue("12");

    // Nor is resting in a field: it catches up once you leave it.
    const focused = await openWithLateCount();
    await focused.from.focus();
    focused.release();
    await expect(focused.from).toHaveAttribute("max", "12");
    await focused.from.blur();
    await expect.soft(focused.from).toHaveValue("7");
    await expect.soft(focused.to).toHaveValue("10");
    await page.screenshot({ path: info.outputPath("summary-range-late-count.png") });
  } finally {
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

test("Chat Summary keeps the field being edited above the phone keyboard", ({ page, request }, info) =>
  keepsFieldAboveKeyboard(page, request, info, false));

// Turned sideways, a summary is taller than the room left above the keyboard.
// A sideways phone is wide enough for the Chat Settings window, which fits above the keyboard while you type.
test("Chat Summary keeps the field being edited above the phone keyboard in landscape", ({ page, request }, info) =>
  keepsFieldAboveKeyboard(page, request, info, true));

async function keepsFieldAboveKeyboard(page: Page, request: APIRequestContext, info: TestInfo, landscape: boolean) {
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
    const upright = page.viewportSize()!;
    if (landscape) await page.setViewportSize({ width: upright.height, height: upright.width });
    await page.goto("/");
    // Chat Summary is a drawer in Chat Settings: a sheet upright, a window when the phone is wide enough.
    await openChatSettingsTool(page, "chat-summary");
    const panel = chatSettingsWindow(page);
    await expect(panel).toBeVisible();

    const phone = page.viewportSize()!;
    // The keyboard covers about half of a phone turned sideways.
    const keyboardTop = Math.round(phone.height * (landscape ? 0.5 : 0.6));
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

    const summaryField = panel.getByRole("textbox", { name: "Write or paste a summary of this chat...", exact: true });
    // A finger tap, as a phone sends it, while typing in the controls at the bottom. It lands where
    // the finger is, even when it moves focus out of them. WebKit blurs the field on mousedown and
    // the window leaves its keyboard layout before the click, so there the tap is dropped, but it
    // must not press what moves under the finger.
    const tap = async (target: Locator) => {
      const box = (await target.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(0);
    };
    if (!landscape) {
      // Here the tap moves focus into the summary list, scrolled to its end.
      await panel.getByLabel("Messages", { exact: true }).focus();
      await setKeyboard(true);
      const lastEdit = panel.getByRole("button", { name: "Edit summary entry", exact: true }).last();
      await lastEdit.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await tap(lastEdit);
      if (!iPhone) await expect(summaryField).toBeFocused();
      await setKeyboard(false);
      const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
      if (await cancel.isVisible()) await cancel.click();
    }

    await panel.getByRole("button", { name: "Edit summary entry", exact: true }).last().click();
    await expect(summaryField).toBeFocused();
    await typeIn("summary", summaryField);
    await typeIn("title", panel.getByPlaceholder("Summary title", { exact: true }));
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();

    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await typeIn(
      "prompt",
      panel.getByRole("textbox", { name: "Prompt instructions for summary generation...", exact: true }),
    );

    // Sideways, message ranges fill the window before the keyboard opens, so they are checked upright.
    if (landscape) return;
    // Message ranges stay listed under the summaries after a run, and with several of them those
    // controls alone are taller than the room the keyboard leaves. They scroll with the drawer, so the
    // field being typed in still shows.
    await panel.getByRole("button", { name: "Range", exact: true }).click();
    const addRange = panel.getByRole("button", { name: "Add range", exact: true });
    await panel.getByRole("spinbutton", { name: "Range 1 to message", exact: true }).fill("1");
    await setKeyboard(true);
    // The range controls scroll with the drawer, so the finger finds Add range where it shows.
    await addRange.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await tap(addRange);
    if (!iPhone) await expect(panel.getByRole("spinbutton", { name: "Range 2 to message", exact: true })).toBeVisible();
    await setKeyboard(false);
    const rangeEnds = panel.getByRole("spinbutton", { name: /^Range \d+ to message$/ });
    while ((await rangeEnds.count()) < 5) await addRange.click();
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
}
