import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// A character's own dialogue color must outrank Apply preset colors (#7167).
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const ADA = { name: "Ada Quill", color: "#ff5500", rgb: "rgb(255, 85, 0)" };
const BRAM = { name: "Bram Holt", color: "#22c55e", rgb: "rgb(34, 197, 94)" };
const CORA = { name: "Cora Lin" };
const GRADIENT_TEXT = "linear-gradient(90deg, #6c5ce7, #00cec9)";
type Theme = "dark" | "light";

async function createFixture(request: APIRequestContext, mode: "roleplay" | "game") {
  const ids: { characters: string[]; chat?: string } = { characters: [] };
  const remove = async () => {
    if (ids.chat) await request.delete(`/api/chats/${ids.chat}?force=true`).catch(() => undefined);
    await Promise.all(ids.characters.map((id) => request.delete(`/api/characters/${id}`).catch(() => undefined)));
  };
  try {
    const character = async (name: string, dialogueColor?: string) => {
      const response = await request.post("/api/characters", {
        data: { data: { name, ...(dialogueColor ? { extensions: { dialogueColor } } : {}) } },
      });
      expect(response.ok()).toBeTruthy();
      const id = ((await response.json()) as { id: string }).id;
      ids.characters.push(id);
      return id;
    };
    const ada = await character(ADA.name, ADA.color);
    const bram = await character(BRAM.name, BRAM.color);
    const cora = await character(CORA.name);
    const response = await request.post("/api/chats", {
      data: { name: `Dialogue colors ${mode}`, mode, characterIds: [ada, bram, cora] },
    });
    expect(response.ok()).toBeTruthy();
    ids.chat = ((await response.json()) as { id: string }).id;
    const metadata =
      mode === "roleplay"
        ? { groupChatMode: "individual" }
        : {
            gameId: ids.chat,
            gameSessionStatus: "active",
            gameSessionNumber: 1,
            gameIntroPresented: true,
            gameActiveState: "exploration",
            gameImageAutoGenerationEnabled: false,
            gamePartyCharacterIds: [ada, bram, cora],
          };
    expect(
      (
        await request.patch(`/api/chats/${ids.chat}/metadata`, {
          data: { windowLayout: null, chatSettingsHintDismissed: true, enableAgents: false, ...metadata },
        })
      ).ok(),
    ).toBeTruthy();
    const post = async (characterId: string | null, content: string) => {
      const posted = await request.post(`/api/chats/${ids.chat}/messages`, {
        data: { role: "assistant", characterId, content },
      });
      expect(posted.ok()).toBeTruthy();
      return ((await posted.json()) as { id: string }).id;
    };
    const messages =
      mode === "roleplay"
        ? {
            uncolored: await post(cora, `${CORA.name} shrugs. "No color here."`),
            html: await post(ada, `<div class="note">${ADA.name} lifts the lamp. "Follow *me* now."</div>`),
            speaker: await post(ada, `<speaker="${BRAM.name}">"Bram keeps his own color."</speaker>`),
            plain: await post(ada, `${ADA.name} leans in. "Keep *this* close," she whispers.`),
          }
        : {
            game: await post(
              null,
              [
                "A lamp burns.",
                `[${ADA.name}] [main] [calm]: "Keep *this* close."`,
                `[${CORA.name}] [main] [calm]: "No color here."`,
                `[${ADA.name}] [side]: "Watch the ridge."`,
              ].join("\n\n"),
            ),
          };
    return { chatId: ids.chat, messages, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

async function open(page: Page, chatId: string, theme: Theme) {
  // Isolate preference sync from the disposable server shared with other specs.
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await page.route("**/api/game-assets/manifest", (route) =>
    route.fulfill({ json: { scannedAt: "2026-07-16T00:00:00.000Z", count: 0, assets: {}, byCategory: {} } }),
  );
  await seedUIState(
    page,
    {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatSettingsMoveTipDismissed: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      appAccentPulseMode: false,
      appAccentRgbMode: false,
      gameInstantTextReveal: true,
      theme,
    },
    // Keep the chosen preset across the visual-novel reload.
    "if-missing",
  );
  await page.addInitScript(
    ({ chatId, version }) => {
      localStorage.setItem("marinara-active-chat-id", chatId);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { chatId, version: APP_VERSION },
  );
  await page.goto("/");
}

async function setStore(page: Page, updates: Record<string, string | boolean>) {
  await page.evaluate(async (values) => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    const state = useUIStore.getState() as unknown as Record<string, (value: string | boolean) => void>;
    for (const [setter, value] of Object.entries(values)) state[setter]!(value);
  }, updates);
}

async function paint(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fill: style.webkitTextFillColor, image: style.backgroundImage };
  });
}

/** Both the color and the painted fill are the character's color, with no preset gradient on top. */
async function expectOwnColor(target: Locator, rgb: string, label: string) {
  await expect(target, label).toHaveCount(1);
  expect(await paint(target), label).toEqual({ color: rgb, fill: rgb, image: "none" });
}

async function setPreset(page: Page, preset: "default" | "mari" | "dottore", applyColors: boolean) {
  await setStore(page, { setChatWidgetPreset: preset, setChatWidgetApplyColors: applyColors });
  if (preset === "default") await expect(page.locator("html")).not.toHaveAttribute("data-chat-widget-preset");
  else await expect(page.locator("html")).toHaveAttribute("data-chat-widget-preset", preset);
  if (applyColors) await expect(page.locator("html")).toHaveAttribute("data-chat-widget-apply-colors", "true");
  else await expect(page.locator("html")).not.toHaveAttribute("data-chat-widget-apply-colors");
}

for (const theme of ["dark", "light"] as const) {
  test(`Roleplay dialogue keeps each character's color under Apply preset colors (${theme})`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(120_000);
    const fixture = await createFixture(request, "roleplay");
    try {
      await open(page, fixture.chatId, theme);
      const content = (id: string) => page.locator(`[data-message-id="${id}"] .mari-message-content`).first();
      const plain = content(fixture.messages.plain!).locator("strong").filter({ hasText: "Keep" });
      const html = content(fixture.messages.html!).locator("strong").filter({ hasText: "Follow" });
      const speaker = content(fixture.messages.speaker!).locator("strong").filter({ hasText: "Bram keeps" });
      const uncolored = content(fixture.messages.uncolored!).locator("strong").filter({ hasText: "No color" });
      const bubble = page.locator(`[data-message-id="${fixture.messages.uncolored}"] .mari-rp-bubble`).first();
      await expect(plain).toBeVisible({ timeout: 30_000 });

      const expectCharacterColors = async (label: string) => {
        await expectOwnColor(plain, ADA.rgb, `${label}: plain dialogue`);
        await expectOwnColor(plain.locator("em"), ADA.rgb, `${label}: italics inside plain dialogue`);
        await expectOwnColor(html, ADA.rgb, `${label}: HTML dialogue`);
        await expectOwnColor(html.locator("em"), ADA.rgb, `${label}: italics inside HTML dialogue`);
        await expectOwnColor(speaker, BRAM.rgb, `${label}: group speaker dialogue`);
      };

      // Apply preset colors off: the existing look.
      await expectCharacterColors("switch off");
      const baseline = await paint(uncolored);
      expect(baseline.fill).toBe(baseline.color);

      for (const preset of ["mari", "dottore"] as const) {
        await setPreset(page, preset, true);
        await expectCharacterColors(preset);
        // Dialogue without a character color keeps following the preset text.
        const surface = await paint(bubble);
        expect((await paint(uncolored)).fill, `${preset}: uncolored dialogue follows the preset`).toBe(surface.fill);
        await page.screenshot({ path: info.outputPath(`roleplay-${preset}-${theme}.png`), animations: "disabled" });

        // A custom gradient text color paints text leaves, but not character dialogue.
        await setStore(page, { setChatWidgetTextColor: GRADIENT_TEXT });
        await expect(page.locator("html")).toHaveAttribute("data-chat-widget-colors", /\btext\b/);
        await expectCharacterColors(`${preset} with gradient text`);
        expect((await paint(uncolored)).image, `${preset}: uncolored dialogue keeps the gradient`).toContain(
          "linear-gradient",
        );
        await setStore(page, { setChatWidgetTextColor: "" });
      }

      // Nothing changes with the switch off again.
      await setPreset(page, "mari", false);
      await expectCharacterColors("switch off again");
      expect(await paint(uncolored)).toEqual(baseline);

      // Visual-novel display renders the latest paragraph through the same path.
      await setPreset(page, "mari", true);
      expect(
        (
          await request.patch(`/api/chats/${fixture.chatId}/metadata`, {
            data: { roleplayDisplayStyle: "visual-novel" },
          })
        ).ok(),
      ).toBeTruthy();
      await page.reload();
      const novel = page.locator("[data-roleplay-vn]");
      await expect(novel).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("html")).toHaveAttribute("data-chat-widget-apply-colors", "true");
      const novelDialogue = novel.locator("strong").filter({ hasText: "Keep" });
      await expectOwnColor(novelDialogue, ADA.rgb, "visual novel dialogue");
      await expectOwnColor(novelDialogue.locator("em"), ADA.rgb, "italics inside visual novel dialogue");
      await page.screenshot({ path: info.outputPath(`roleplay-vn-mari-${theme}.png`), animations: "disabled" });
    } finally {
      try {
        await page.close();
      } finally {
        await fixture.remove();
      }
    }
  });

  test(`Game dialogue keeps each character's color under Apply preset colors (${theme})`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(120_000);
    const fixture = await createFixture(request, "game");
    try {
      await open(page, fixture.chatId, theme);
      const panel = page.locator('[data-component="GameNarration.ActivePanel"]');
      await expect(panel).toContainText("A lamp burns.", { timeout: 30_000 });
      const next = panel.getByRole("button", { name: "Next", exact: true });
      const box = panel.locator(".game-narration-prose > div");
      const side = page.locator(".experience-side-line").filter({ hasText: "Watch the ridge." }).locator("p");

      // Ada's line and its italics paint exactly as they do without the preset colors.
      await next.click();
      await expect(box).toContainText("Keep this close.");
      const ada = { line: await paint(box), em: await paint(box.locator("em")) };
      expect(ada.line).toEqual({ color: ADA.rgb, fill: ADA.rgb, image: "none" });
      for (const preset of ["mari", "dottore"] as const) {
        await setPreset(page, preset, true);
        expect(await paint(box), `${preset}: Game dialogue`).toEqual(ada.line);
        expect(await paint(box.locator("em")), `${preset}: italics inside Game dialogue`).toEqual(ada.em);
        await page.screenshot({ path: info.outputPath(`game-${preset}-${theme}.png`), animations: "disabled" });
      }
      await setPreset(page, "default", false);

      // Cora has no dialogue color, so her line follows the preset text.
      await next.click();
      await expect(box).toContainText("No color here.");
      const cora = await paint(box);
      await expect(side).toBeVisible();
      await expectOwnColor(side, ADA.rgb, "switch off: side remark");
      const stacked = page.locator(".mari-game-stacked-log").getByText("Keep this close.");
      for (const preset of ["mari", "dottore"] as const) {
        await setPreset(page, preset, true);
        expect((await paint(box)).fill, `${preset}: uncolored Game dialogue follows the preset`).toBe(
          (await paint(panel)).fill,
        );
        await expectOwnColor(side, ADA.rgb, `${preset}: side remark`);
        // The stacked display keeps earlier lines in its own log surface.
        await setStore(page, { setGameDialogueDisplayMode: "stacked" });
        await expect(stacked).toBeVisible();
        await expectOwnColor(stacked, ADA.rgb, `${preset}: stacked Game dialogue`);
        await setStore(page, { setGameDialogueDisplayMode: "classic" });
      }

      await setPreset(page, "default", false);
      expect(await paint(box)).toEqual(cora);
    } finally {
      try {
        await page.close();
      } finally {
        await fixture.remove();
      }
    }
  });
}
