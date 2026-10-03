import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("PCM speech format persists through the audio connection editor and reload", async ({ page, request }) => {
  const created = await request.post("/api/connections", {
    data: {
      name: "PCM fixture",
      provider: "audio",
      audioSource: "openai",
      apiKey: "synthetic-test-key",
      baseUrl: "https://audio-fixture.invalid/v1",
    },
  });
  expect(created.ok()).toBeTruthy();
  const connection = await created.json();
  const storedFormat = async () => {
    const stored = (await (await request.get(`/api/connections/${connection.id}`)).json()).audioSettings;
    return (typeof stored === "string" ? JSON.parse(stored) : stored)?.audioFormat;
  };
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    const openFormat = async () => {
      await page.goto("/");
      await page.evaluate(async (id) => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().openConnectionDetail(id);
      }, connection.id);
      await page.getByRole("button", { name: "Synthesis defaults" }).click();
      return page.locator("select").filter({ has: page.locator('option[value="pcm"]') });
    };
    const format = await openFormat();
    await format.selectOption("pcm");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/connections/${connection.id}`,
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect.poll(storedFormat).toBe("pcm");
    const afterReload = await openFormat();
    await expect(afterReload).toHaveValue("pcm");
  } finally {
    await request.delete(`/api/connections/${connection.id}`).catch(() => {});
  }
});
