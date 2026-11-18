import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openConnectionsPanel, openJobSettings, ttsConfigCard } from "./connections-panel.js";
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

// #7848: an Audio connection can be the voice's source. The setting saves only its ID, never the connection's key,
// and the app says so plainly when the connection is gone.
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
  const { id, accountId } = (await created.json()) as { id: string; accountId: string };
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
    // Since the Voice job (1e4664c38b) the card has no Source list: the voice's Model is picked in the Voice
    // job's "Model for Voice" window, and the Voice settings window reports a missing account.
    const studio = `Voice studio ${testInfo.project.name}`;
    const voiceRow = () =>
      page.locator("[data-connections-panel]").filter({ visible: true }).locator('[data-defaults-role="voice"]');
    const openPicker = async () => {
      await page.goto("/");
      await openConnectionsPanel(page);
      await voiceRow().getByRole("button").first().click();
      const picker = page.getByRole("dialog", { name: "Model for Voice", exact: true });
      await expect(picker).toBeVisible();
      return picker;
    };

    // The card's own request timeout shows while voice uses a direct source; an Audio account keeps its own.
    const cardTimeout = () => ttsConfigCard(page).getByText("Request timeout (seconds)", { exact: true });
    await page.goto("/");
    await openJobSettings(page, "voice");
    await expect(cardTimeout()).toBeVisible();

    let picker = await openPicker();
    // With nothing chosen the picker opens on the starred models or the first account by name, and the shared
    // server can hold other specs' accounts, so open this one first. A phone shows one view at a time: go back to
    // the account list before choosing it.
    if (testInfo.project.name.includes("mobile"))
      await picker.getByRole("button", { name: "All connections", exact: true }).click();
    await picker.locator(`[data-switcher-pane="${accountId}"]`).click();
    await picker.getByRole("button", { name: new RegExp(`^${studio}, Audio\\b`, "u") }).click();
    await expect.poll(async () => (await (await request.get("/api/tts/config")).json()).connectionId).toBe(id);
    const view = await (await request.get("/api/tts/config")).text();
    expect(view).not.toContain("e2e-connection-secret");
    expect(JSON.parse(view)).toMatchObject({ connectionId: id, model: "studio-model" });
    await page.goto("/");
    await openJobSettings(page, "voice");
    await expect(ttsConfigCard(page)).toBeVisible();
    await expect(cardTimeout()).toBeHidden();

    picker = await openPicker();
    // The Model tab names the chosen model on every screen size.
    await expect(picker.getByRole("tab", { name: `Model ${studio}`, exact: true })).toBeVisible();
    await capture("tts-card-audio-connection-source");

    expect((await request.delete(`/api/connections/${id}`)).ok()).toBeTruthy();
    deleted = true;
    // The setting still names the account by its ID; the server fails rather than use another one.
    expect((await (await request.get("/api/tts/config")).json()).connectionId).toBe(id);
    await page.goto("/");
    const settings = await openJobSettings(page, "voice");
    await expect(settings.getByTitle("The voice account is missing", { exact: true })).toBeVisible();
    await capture("tts-card-missing-audio-connection");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (!deleted) await request.delete(`/api/connections/${id}`);
    const restored = await request.put("/api/tts/config", { data: original });
    expect(restored.ok()).toBeTruthy();
  }
});
