import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { clickTopbarPanel } from "./topbar-navigation.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("lorebook tools lint, preview scans, and bulk-enable selected books", async ({ page, request }) => {
  const book = await (
    await request.post("/api/lorebooks", {
      data: { name: "Synthetic tools proof book", enabled: false },
    })
  ).json();
  try {
    await request.post(`/api/lorebooks/${book.id}/entries`, {
      data: { name: "Keyless sample entry", content: "A note for the synthetic proof." },
    });
    await request.post(`/api/lorebooks/${book.id}/entries`, {
      data: { name: "Lantern watcher", content: "A watcher near the lanterns.", keys: ["lantern"] },
    });

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript(
      (appVersion) => localStorage.setItem("marinara:whats-new:seen-version", appVersion),
      version,
    );
    await page.goto("/");
    await clickTopbarPanel(page, "lorebooks");

    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: "Select lorebook", exact: true }).click();
    await page.getByRole("button", { name: "Enable the selected lorebooks", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/lorebooks/${book.id}`)).json()).enabled).toBe(true);

    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByText(book.name, { exact: true }).click();
    await page.getByRole("button", { name: "Check lorebook", exact: true }).click();
    await expect(page.getByText("Keyless sample entry", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Keyword test", exact: true }).click();
    await page.getByPlaceholder("Paste a paragraph or sample messages here…", { exact: true }).fill("A lantern glows.");
    await page.getByRole("button", { name: "Run scanner", exact: true }).click();
    await expect(page.getByText("Lantern watcher", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Import entries from Markdown or CSV", exact: true }).click();
    const importDialog = page.getByRole("dialog", { name: "Import entries", exact: true });
    await importDialog
      .getByRole("textbox", { name: "Markdown or CSV text", exact: true })
      .fill("## River sentinel\nKeys: river\nFolder: Places\n\nGuards the river.");
    await expect(importDialog.getByText("River sentinel", { exact: true })).toBeVisible();
    await importDialog.getByRole("button", { name: "Import 1 entry", exact: true }).click();
    await expect(importDialog).not.toBeVisible();
    await expect
      .poll(async () => (await (await request.get(`/api/lorebooks/${book.id}/entries`)).json()).length)
      .toBe(3);

    const entrySection = page.locator('[data-editor-section="entries"]');
    await entrySection.getByRole("button", { name: "Select", exact: true }).click();
    await entrySection.getByRole("button", { name: "Select all", exact: true }).click();
    await page.getByRole("button", { name: "Bulk edit 3 entries", exact: true }).click();
    await page.getByRole("button", { name: "Constant on", exact: true }).click();
    await expect
      .poll(async () => {
        const entries = await (await request.get(`/api/lorebooks/${book.id}/entries`)).json();
        return entries.every((entry: { constant: boolean }) => entry.constant);
      })
      .toBe(true);
  } finally {
    await page.close();
    await request.delete(`/api/lorebooks/${book.id}`).catch(() => undefined);
  }
});
