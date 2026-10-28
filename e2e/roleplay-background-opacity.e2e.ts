import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { clickTopbarPanel } from "./topbar-navigation.js";
import { isolateSyncedUISettings, seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const characterColor = "rgba(18, 52, 86, 0.25)";
const personaColor = "rgba(86, 52, 18, 0.4)";

async function createFixture(request: APIRequestContext) {
  const created: string[] = [];
  const cleanup = async () => {
    for (const path of created) await request.delete(path).catch(() => undefined);
  };
  const post = async (path: string, data: unknown) => {
    const response = await request.post(path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  try {
    const character = await post("/api/characters", {
      data: { name: "Opacity character", first_mes: "", extensions: { boxColor: characterColor } },
    });
    created.unshift(`/api/characters/${character.id}`);
    const persona = await post("/api/characters/personas", { name: "Opacity persona", boxColor: personaColor });
    created.unshift(`/api/characters/personas/${persona.id}`);
    const chat = await post("/api/chats", {
      name: "Roleplay message opacity proof",
      mode: "roleplay",
      characterIds: [character.id],
      personaId: persona.id,
    });
    created.unshift(`/api/chats/${chat.id}?force=true`);
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: { enableAgents: false, windowLayout: null, chatSettingsHintDismissed: true },
    });
    expect(metadata.ok(), await metadata.text()).toBe(true);
    const user = await post(`/api/chats/${chat.id}/messages`, {
      role: "user",
      content: "My saved persona color should follow the opacity control.",
      extra: { personaSnapshot: { personaId: persona.id, name: persona.name, boxColor: personaColor } },
    });
    const assistant = await post(`/api/chats/${chat.id}/messages`, {
      role: "assistant",
      characterId: character.id,
      content: "My extracted character color should follow the opacity control.",
    });
    return { chat, character, persona, user, assistant, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function openAppearance(page: Page) {
  await clickTopbarPanel(page, "settings");
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("group", { name: "Appearance by chat mode" })
    .getByRole("button", { name: "Roleplay", exact: true })
    .click();
  const slider = page.getByLabel("Roleplay Messages Background Opacity", { exact: true });
  await slider.scrollIntoViewIfNeeded();
  return slider;
}

test("Roleplay opacity reaches transparent for extracted character and saved persona colors", async ({
  page,
  request,
}) => {
  const fixture = await createFixture(request);
  try {
    await isolateSyncedUISettings(page);
    await seedUIState(page, {
      theme: "dark",
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      chatSettingsMoveTipDismissed: true,
      chatFontOpacity: 90,
      chatWidgetApplyColors: false,
      chatWidgetApplyShape: false,
      roleplayReducedPaintEffects: false,
      roleplayAvatarStyle: "circles",
      appAccentPulseMode: false,
    });
    await page.addInitScript(
      ({ chatId, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", chatId);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { chatId: fixture.chat.id, appVersion: version },
    );
    await page.goto("/");
    const characterBubble = page.locator(`[data-message-id="${fixture.assistant.id}"] .mari-rp-bubble`);
    const personaBubble = page.locator(`[data-message-id="${fixture.user.id}"] .mari-rp-bubble`);
    await expect(characterBubble).toHaveCSS("background-color", characterColor);
    await expect(personaBubble).toHaveCSS("background-color", personaColor);

    const slider = await openAppearance(page);
    await slider.press("Home");
    await expect(slider).toHaveValue("0");
    for (const bubble of [characterBubble, personaBubble]) {
      await expect.soft(bubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect.soft(bubble).toHaveCSS("background-image", "none");
    }
  } finally {
    await fixture.cleanup();
  }
});
