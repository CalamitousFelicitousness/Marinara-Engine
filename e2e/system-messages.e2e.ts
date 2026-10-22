import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { isolateSyncedUISettings, seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const mode of ["conversation", "roleplay"] as const) {
  test(`System messages render formatting inside the ${mode} transcript`, async ({ page, request }, info) => {
    const created = await request.post("/api/chats", {
      data: { name: `System formatting ${mode}`, mode, characterIds: [] },
    });
    expect(created.ok()).toBeTruthy();
    const chat = await created.json();
    try {
      const response = await request.post(`/api/chats/${chat.id}/messages`, {
        data: {
          role: "system",
          content: [
            "# System note",
            "First authored line.",
            "Second authored line.",
            "",
            "**Markdown emphasis** and <strong>Allowed HTML</strong>.",
            "",
            "Long system content stays readable. ".repeat(30),
          ].join("\n"),
        },
      });
      expect(response.ok()).toBeTruthy();
      const message = await response.json();
      await isolateSyncedUISettings(page);
      await page.route("**/api/regex-scripts", (route) => route.fulfill({ json: [] }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["conversation", "roleplay"],
        appAccentPulseMode: false,
        theme: "dark",
      });
      await page.addInitScript(
        ({ id, version }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { id: chat.id, version },
      );
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "System note", exact: true })).toBeVisible();
      const row = page.locator(`[data-message-id="${message.id}"]`);
      await expect(row.locator("strong")).toHaveText(["Markdown emphasis", "Allowed HTML"]);
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate(async (theme) => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.getState().setTheme(theme);
        }, theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const bounds = await row.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            left: rect.left,
            right: rect.right,
            viewportWidth: document.documentElement.clientWidth,
          };
        });
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
        expect(bounds.left).toBeGreaterThanOrEqual(-1);
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
        await page.screenshot({ path: info.outputPath(`system-${mode}-${theme}.png`), animations: "disabled" });
      }
    } finally {
      await request.delete(`/api/chats/${chat.id}`);
    }
  });
}
