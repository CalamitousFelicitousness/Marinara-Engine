import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { clickTopbarPanel } from "./topbar-navigation.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("character library compares duplicates and bulk tags persist across reload", async ({ page, request }, testInfo) => {
  const suffix = Date.now().toString();
  const name = `E2E Synthetic Library ${suffix}`;
  const createdIds: string[] = [];
  for (const cardName of [name, `${name} (copy)`]) {
    const response = await request.post("/api/characters", {
      data: {
        data: {
          name: cardName,
          description: "Synthetic test card for the character library tools.",
          personality: "Patient and observant.",
          scenario: "A neutral test setting.",
          first_mes: "Hello from the test fixture.",
          tags: ["remove-this-tag"],
          creator: "Synthetic E2E fixture",
          character_version: "1",
        },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    createdIds.push(((await response.json()) as { id: string }).id);
  }

  try {
    await page.route("**/api/app-settings/ui", (route) =>
      route.fulfill({ json: route.request().method() === "GET" ? { value: "" } : { success: true } }),
    );
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      professorMariNavigationEnabled: false,
    });
    await page.addInitScript((appVersion) => {
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    }, version);
    await page.goto("/");
    await clickTopbarPanel(page, "characters");

    await page.getByRole("button", { name: "Possible duplicates", exact: true }).click();
    const duplicateDialog = page.getByRole("dialog", { name: "Possible duplicates" });
    await expect(duplicateDialog.getByText(name, { exact: true })).toBeVisible();
    await expect(duplicateDialog.getByText(`${name} (copy)`, { exact: true })).toBeVisible();
    await duplicateDialog.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(duplicateDialog.getByText(/^First message\s*Same$/i)).toBeVisible();
    await expect(duplicateDialog.getByText(/^Scenario\s*Same$/i)).toBeVisible();
    await expect(duplicateDialog.getByText("Different", { exact: true })).toBeVisible();
    await expect(duplicateDialog.getByText("Same", { exact: true }).first()).toBeVisible();

    const originalCard = duplicateDialog
      .locator("li > div.grid.grid-cols-1")
      .getByText(name, { exact: true })
      .locator("xpath=../../..");
    await originalCard.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Character name", exact: true })).toHaveValue(name);
    await expect(duplicateDialog).toBeHidden();
    // Detail editors return through their explicit Back action on both layouts.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(duplicateDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(duplicateDialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Possible duplicates", exact: true })).toBeFocused();

    if (testInfo.project.name.includes("desktop")) {
      await page.getByRole("button", { name: "Possible duplicates", exact: true }).click();
      const reopenedOriginalCard = duplicateDialog
        .locator("li > div.grid.grid-cols-1")
        .getByText(name, { exact: true })
        .locator("xpath=../../..");
      await reopenedOriginalCard.getByRole("button", { name: "Open", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Character name", exact: true })).toHaveValue(name);
      await clickTopbarPanel(page, "personas");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(duplicateDialog).toBeHidden();
      await clickTopbarPanel(page, "characters");
    }

    await page.getByRole("button", { name: "Select", exact: true }).click();
    for (const id of createdIds) {
      await page
        .locator(`[data-character-id="${id}"]`)
        .getByRole("button", { name: "Select character", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Tags", exact: true }).click();
    const tagDialog = page.getByRole("dialog", { name: "Edit tags of 2 characters" });
    await tagDialog.getByRole("textbox", { name: "Add tags", exact: true }).fill("keep-after-reload");
    await tagDialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await tagDialog.getByRole("button", { name: "Apply to 2 characters", exact: true }).click();
    await expect(tagDialog).toBeHidden();

    for (const id of createdIds) {
      await expect
        .poll(async () => {
          const response = await request.get(`/api/characters/${id}`);
          const character = (await response.json()) as { data: string };
          return (JSON.parse(character.data) as { tags: string[] }).tags;
        })
        .toContain("keep-after-reload");
    }

    await page.getByRole("button", { name: "Select", exact: true }).click();
    for (const id of createdIds) {
      await page
        .locator(`[data-character-id="${id}"]`)
        .getByRole("button", { name: "Select character", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Tags", exact: true }).click();
    const removeDialog = page.getByRole("dialog", { name: "Edit tags of 2 characters" });
    await removeDialog.getByRole("button", { name: /remove-this-tag/i }).click();
    await removeDialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await removeDialog.getByRole("button", { name: "Apply to 2 characters", exact: true }).click();
    await expect(removeDialog).toBeHidden();

    await page.reload();
    for (const id of createdIds) {
      const response = await request.get(`/api/characters/${id}`);
      const character = (await response.json()) as { data: string };
      const tags = (JSON.parse(character.data) as { tags: string[] }).tags;
      expect(tags).toContain("keep-after-reload");
      expect(tags).not.toContain("remove-this-tag");
    }
  } finally {
    for (const id of createdIds) await request.delete(`/api/characters/${id}`).catch(() => undefined);
  }
});
