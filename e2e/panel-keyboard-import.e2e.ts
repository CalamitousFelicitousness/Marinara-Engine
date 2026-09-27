import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("shell panel focus returns to its opener and profile import is keyboard reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "This proof covers the desktop top-bar panel toggles.");
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    professorMariNavigationEnabled: false,
  });
  await page.addInitScript((v) => localStorage.setItem("marinara:whats-new:seen-version", v), version);
  await page.goto("/");

  const settingsToggle = page.locator('[data-tour="panel-settings"]');
  await settingsToggle.click();
  const panel = page.locator('[data-component="RightPanel"]');
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate((element) => document.activeElement === element)).toBe(true);

  await page.getByRole("tab", { name: "Imports", exact: true }).click();
  const importProfile = page.getByRole("button", { name: "Import Profile (JSON/ZIP)", exact: true });
  await expect(importProfile).toBeVisible();
  const hiddenInput = page.locator('input[type="file"][accept=".json,.zip,application/json,application/zip"]');
  await expect(hiddenInput).toHaveAttribute("aria-hidden", "true");
  await expect(hiddenInput).toHaveAttribute("tabindex", "-1");
  await expect(importProfile).toBeEnabled();
  await importProfile.focus();
  await expect.poll(() => importProfile.evaluate((element) => document.activeElement === element)).toBe(true);
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const fileChooser = await fileChooserPromise;
  expect(fileChooser.isMultiple()).toBe(false);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect.poll(() => settingsToggle.evaluate((element) => document.activeElement === element)).toBe(true);
});
