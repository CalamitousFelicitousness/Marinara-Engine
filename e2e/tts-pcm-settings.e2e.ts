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

// #7848: an Audio connection can be the card's Source. The card saves only its ID, hides the address, key and
// model the connection keeps, and says so plainly when the connection is gone.
test("An Audio connection chosen as the Source is saved by ID and reported when it is gone", async ({
  page,
  request,
}, testInfo) => {
  const originalResponse = await request.get("/api/tts/config");
  expect(originalResponse.ok()).toBeTruthy();
  const original = await originalResponse.json();
  const created = await request.post("/api/connections", {
    data: {
      name: `Voice studio ${testInfo.project.name}`,
      provider: "audio",
      audioSource: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "e2e-connection-secret",
      model: "studio-model",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  let deleted = false;
  try {
    const saved = await request.put("/api/tts/config", {
      data: { ...original, enabled: false, source: "openai", connectionId: "" },
    });
    expect(saved.ok()).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    const capture = async (name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    const openCard = async () => {
      await page.goto("/");
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().openRightPanel("connections");
      });
      const card = page
        .locator('[data-component="RightPanel"]')
        .getByText("Text to Speech", { exact: true })
        .locator("xpath=../../..");
      await card.getByTitle("Expand").click();
      return card;
    };

    let card = await openCard();
    const sourceSelect = card.getByLabel("Source", { exact: true });
    await expect(card.getByText("API Key", { exact: true })).toBeVisible();
    await sourceSelect.selectOption(`connection:${id}`);
    await expect.poll(async () => (await (await request.get("/api/tts/config")).json()).connectionId).toBe(id);
    await expect(card.getByText("Uses this connection's address, key and model.", { exact: true })).toBeVisible();
    for (const field of ["Base URL", "API Key", "Model", "Request timeout (seconds)"]) {
      await expect(card.getByText(field, { exact: true })).toBeHidden();
    }
    const view = await (await request.get("/api/tts/config")).text();
    expect(view).not.toContain("e2e-connection-secret");
    expect(JSON.parse(view)).toMatchObject({ connectionId: id, model: "studio-model" });

    card = await openCard();
    await expect(card.getByLabel("Source", { exact: true })).toHaveValue(`connection:${id}`);
    await capture("tts-card-audio-connection-source");

    expect((await request.delete(`/api/connections/${id}`)).ok()).toBeTruthy();
    deleted = true;
    card = await openCard();
    await expect(
      card.getByText("Choose another source, because this Audio connection is missing or unavailable.", {
        exact: true,
      }),
    ).toBeVisible();
    // The collapsed header says so too, not only the open card.
    await expect(card.locator("div").filter({ hasText: /^Missing Audio connection$/ })).toBeVisible();
    await expect(card.getByLabel("Source", { exact: true })).toHaveValue(`connection:${id}`);
    await capture("tts-card-missing-audio-connection");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (!deleted) await request.delete(`/api/connections/${id}`);
    const restored = await request.put("/api/tts/config", { data: original });
    expect(restored.ok()).toBeTruthy();
  }
});
