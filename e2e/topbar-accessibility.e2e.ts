import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function openCleanHome(page: Page) {
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: "" } : { success: true } }),
  );
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chibiProfessorMariEnabled: false,
  });
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
  }, version);
  await page.goto("/");
}

test("phone More keeps core navigation visible and retains extension actions", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "The overflow menu is specific to the phone-width layout.");
  await openCleanHome(page);

  const topbar = page.locator('[data-component="TopBar"]');
  const home = topbar.getByTitle("Home");
  const chats = topbar.getByTitle("Chats");
  await expect(home).toBeVisible();
  await expect(chats).toBeVisible();
  await expect(topbar.getByTitle("Characters")).toBeHidden();
  await expect(topbar.getByTitle("Settings")).toBeHidden();
  expect(await home.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(36);
  expect(await chats.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(36);

  await page.evaluate(async () => {
    const { registerPersonalExtensionContribution, setPersonalExtensionContributionDispatcher } = await import(
      "/src/lib/personal-extension-contributions.ts" as string
    );
    const extension = {
      id: "accessibility-fixture",
      name: "Fixture Extension",
      contentHash: "accessibility-fixture-hash",
    };
    if (
      !registerPersonalExtensionContribution(extension, {
        id: "fixture-action",
        kind: "button",
        label: "Fixture action",
        icon: "sparkles",
      })
    ) {
      throw new Error("Could not register the synthetic extension action");
    }
    Object.assign(window, { __fixtureExtensionActivated: false });
    setPersonalExtensionContributionDispatcher(extension, () => {
      Object.assign(window, { __fixtureExtensionActivated: true });
    });
  });

  await page.getByRole("button", { name: "More", exact: true }).click();
  const menu = page.getByRole("menu", { name: "More destinations" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Characters", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
  const extensionAction = menu.getByRole("menuitem", { name: /Fixture action.*Fixture Extension/ });
  await expect(extensionAction).toBeVisible();
  expect(await extensionAction.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
    44,
  );
  await extensionAction.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __fixtureExtensionActivated?: boolean }).__fixtureExtensionActivated),
    )
    .toBe(true);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(topbar.getByTitle("Settings")).toBeHidden();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(home).toBeVisible();
  await expect(chats).toBeVisible();
});

test("stacked dialogs keep focus in the top dialog and IME Escape does not dismiss it", async ({ page }) => {
  await openCleanHome(page);
  await page.locator('[data-component="TopBar"]').getByTitle("Home").focus();

  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    useUIStore.getState().openModal("create-character");
  });
  const parent = page.getByRole("dialog", { name: "Create Character" });
  await expect(parent).toBeVisible();
  await page.evaluate(async () => {
    const { useDialogStore } = await import("/src/stores/dialog.store.ts" as string);
    useDialogStore.getState().openDialog({
      kind: "confirm",
      title: "Fixture confirmation",
      message: "Synthetic confirmation for focus testing.",
    });
  });

  const child = page.getByRole("dialog", { name: "Fixture confirmation" });
  await expect(child).toBeVisible();
  const close = child.getByRole("button", { name: /Close/ });
  const confirm = child.getByRole("button", { name: "Confirm", exact: true });
  await close.focus();
  await page.evaluate(() => {
    Object.assign(window, { __fixtureFocusOwners: [] as Array<string | null> });
    document.addEventListener("focusin", (event) => {
      const owner =
        (event.target as HTMLElement).closest('[data-component="Modal"]')?.getAttribute("aria-label") ?? null;
      (window as unknown as Window & { __fixtureFocusOwners: Array<string | null> }).__fixtureFocusOwners.push(owner);
    });
  });
  await close.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  const focusOwners = await page.evaluate(
    () => (window as unknown as Window & { __fixtureFocusOwners: Array<string | null> }).__fixtureFocusOwners,
  );
  expect(focusOwners).not.toContain("Create Character");

  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    useUIStore.getState().closeModal();
  });
  await expect(parent).not.toBeVisible();
  await expect(child).toBeVisible();
  await expect(confirm).toBeFocused();

  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(event, "isComposing", { value: true });
    document.dispatchEvent(event);
  });
  await expect(child).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(child).not.toBeVisible();
});
