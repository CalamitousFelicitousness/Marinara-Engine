import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { clickTopbarPanel } from "./topbar-navigation.js";
import { isolateSyncedUISettings, seedUIState } from "./ui-state-fixture.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;
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
    const updated = await request.patch(`/api/characters/personas/${persona.id}`, { data: { boxColor: "#abcdef" } });
    expect(updated.ok(), await updated.text()).toBe(true);
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
  const slider = page.getByLabel("Roleplay Messages Background Opacity");
  await slider.scrollIntoViewIfNeeded();
  return slider;
}

async function paintPixel(bubble: Locator, pseudo?: string) {
  return bubble.evaluate((element, pseudo) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(element, pseudo).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, pseudo);
}

for (const theme of ["dark", "light"] as const) {
  test(`Roleplay opacity replaces authored character, persona and preset alpha (${theme})`, async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await createFixture(request);
    try {
      await isolateSyncedUISettings(page);
      await seedUIState(
        page,
        {
          theme,
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
        },
        "if-missing",
      );
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
      await expect(characterBubble).toBeAttached();
      const slider = await openAppearance(page);
      await slider.press("Home");
      await expect(slider).toHaveValue("0");
      for (const bubble of [characterBubble, personaBubble]) {
        await expect(bubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(bubble).toHaveCSS("background-image", "none");
      }
      for (const key of ["ArrowRight", "End"]) {
        if (key === "ArrowRight") for (let step = 0; step < 10; step++) await slider.press(key);
        else await slider.press(key);
        const alpha = key === "End" ? 255 : 128;
        await expect(slider).toHaveValue(key === "End" ? "100" : "50");
        for (const [bubble, color] of [
          [characterBubble, [18, 52, 86]],
          [personaBubble, [86, 52, 18]],
        ] as const) {
          await expect.poll(async () => (await paintPixel(bubble))[3]).toBe(alpha);
          const pixel = await paintPixel(bubble);
          color.forEach((channel, i) => expect(Math.abs(pixel[i]! - channel)).toBeLessThanOrEqual(1));
          await expect(bubble).toHaveCSS("opacity", "1");
        }
      }
      // The setting must persist without changing saved card or historical persona colors.
      await page.reload();
      await expect.poll(async () => (await paintPixel(characterBubble))[3]).toBe(255);
      expect(
        (await (await request.get(`/api/characters/${fixture.character.id}`)).json()).data.extensions.boxColor,
      ).toBe(characterColor);
      expect(
        (await (await request.get(`/api/chats/${fixture.chat.id}/messages`)).json()).find(
          (message: { id: string }) => message.id === fixture.user.id,
        ).extra.personaSnapshot.boxColor,
      ).toBe(personaColor);

      // Native preset fills, including all supported gradient types, use the same alpha.
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.setState({
          chatWidgetApplyColors: true,
          chatWidgetBackgroundColor: "rgba(20, 40, 60, 0.1)",
          chatFontOpacity: 50,
          rightPanelOpen: false,
        });
      });
      await expect.poll(async () => (await paintPixel(characterBubble))[3]).toBe(128);
      await expect.poll(async () => (await paintPixel(personaBubble))[3]).toBe(128);
      for (const gradient of [
        "linear-gradient(135deg, rgba(20, 40, 60, 0.1) 0% 10%, #aabbcc88 100%)",
        "radial-gradient(circle at center, rgba(20, 40, 60, 0.1), transparent)",
        "conic-gradient(from 45deg, hsl(20 40% 60% / 0.1), #aabbcc88)",
      ]) {
        await page.evaluate(async (background) => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.setState({ chatWidgetBackgroundColor: background });
        }, gradient);
        await expect
          .poll(() => characterBubble.evaluate((element) => getComputedStyle(element).backgroundImage))
          .toContain("gradient");
        const image = await characterBubble.evaluate((element) => getComputedStyle(element).backgroundImage);
        expect(image).toContain("0.5");
        expect(image).not.toContain("0.1)");
      }
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.setState({
          chatWidgetPreset: "dottore",
          chatWidgetApplyShape: true,
          chatWidgetShape: "cut-corner",
          chatWidgetBackgroundColor: "rgba(20, 40, 60, 0.1)",
        });
      });
      await expect.poll(async () => (await paintPixel(characterBubble, "::after"))[3]).toBe(128);
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.setState({ chatFontOpacity: 0 });
      });
      await expect(characterBubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect.poll(async () => (await paintPixel(characterBubble, "::after"))[3]).toBe(0);
      await expect(characterBubble).toHaveCSS("opacity", "1");
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.setState({ chatFontOpacity: 90, chatWidgetApplyColors: false, chatWidgetApplyShape: false });
      });
      await page.screenshot({ path: testInfo.outputPath(`roleplay-opacity-${theme}.png`) });
    } finally {
      await fixture.cleanup();
    }
  });
}
