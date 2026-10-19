import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { UI_PERSISTENCE } from "../packages/client/src/lib/ui-persistence.js";
import { seedUIState } from "./ui-state-fixture.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

// Older catalog packages (tic-tac-toe@1.0.5 among them) bundle their own copy of the UI store at version 74. On
// load it rewrites the shared key with only the settings it knows: everything below disappears from the blob.
const DROPPED_BY_V74_COPY = [
  "showHomeBrowserAddressBar",
  "showHomeBrowserDesktopBookmarksOnOtherTabs",
  "showHomeBrowserMobileBookmarksOnOtherTabs",
  "noodleNavigation",
  "libraryManualOrders",
  "trackerPanelOpenByChatId",
  "trackerStatDisplayMode",
  "reduceAmbientEffects",
  "mariPanelSortMode",
  "omnibarAsideEnabled",
  "omnibarAsideConnectionId",
  "omnibarAsideDisclosed",
  "omnibarAsideDelayMs",
  "mariEditViewMode",
  "mariUnlockedPackIds",
  "mariSeasonOptOut",
  "mariConnectionId",
  "conversationBackgroundImageOpacity",
  "chatWidgetPreset",
  "chatWidgetFont",
  "chatWidgetShape",
  "chatWidgetButtonSize",
  "chatWidgetBorderColor",
  "chatWidgetBackgroundColor",
  "chatWidgetTextColor",
  "chatWidgetApplyFont",
  "chatWidgetApplyShape",
  "chatWidgetApplyColors",
  "showPaidAgentConnectionWarning",
  "gameNarrationCollapsed",
  "chatListBackgrounds",
  "autoSaveGeneratedImagesToGalleries",
  "imageGameWidth",
  "imageGameHeight",
  "imageCharacterSheetWidth",
  "imageCharacterSheetHeight",
  "alwaysDisplayConversationSwipeMenu",
  "alwaysDisplayRoleplaySwipeMenu",
  "conversationAvatarShape",
  "showContextUsage",
  "showHistoryTrimNotice",
  "showCharactersInPersonaPickers",
  "keepGuidanceAfterRegenerate",
  "customQuickReplies",
  "chatSettingsExpandedSections",
  "includePrivateNotesInExports",
  "colorInlineNames",
  "disableInlineNameGradients",
  "continueAddsNewline",
  "commandCenterMariEnabled",
  "omnibarSuggestionsEnabled",
  "seasonalThemesDisabled",
  "seasonalGreetingYears",
  "seasonalThemeOffYears",
  "defaultDialogueColor",
  "roleplayReducedPaintEffects",
  "showRoleplayThinkingInMessages",
  "keepRoleplayThinkingExpanded",
  "gameTextEffectsEnabled",
  "roleplayNarratorAvatarCycling",
  "roleplayDisplayStyle",
  "roleplayChatPosition",
  "roleplayVnAutoPlay",
  "roleplayVnAutoPlayDelay",
  "roleplayVnPortraitScale",
  "roleplayVnSpriteScale",
  "enterToSendProfessorMari",
  "chatHelpSeenModes",
  "chatHelpButtonHidden",
  "chatSettingsMoveTipDismissed",
  "chatWindowIntroDismissed",
  "echoChamberSideByChatId",
  "echoChamberSizeByChatId",
  "notificationPosition",
  "chatWizardDefaults",
  "conversationTimeZone",
  "activeImpersonatePromptTemplateId",
  "addCyoaChoicesToMessage",
];

// Browser-only settings the v74 copy drops; the server never holds them, so nothing else can bring them back.
const LOCAL_SETTINGS = { roleplayReducedPaintEffects: true, activeImpersonatePromptTemplateId: "e2e-template" };
const LEGACY_MARI_CONNECTION_KEY = "marinara:home-professor-mari-connection-id";

async function prepare(page: Page) {
  // Keep the proof local: a server copy of the synced settings must not refill what the browser lost.
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), APP_VERSION);
}

/** Arms a rewrite of the key, made before the app loads, the way the bundled v74 store leaves it. */
async function armForeignWrite(page: Page) {
  await page.addInitScript(
    ({ name, dropped }) => {
      if (sessionStorage.getItem("e2e:foreign-write") !== "armed") return;
      sessionStorage.setItem("e2e:foreign-write", "done");
      const state = { ...JSON.parse(localStorage.getItem(name)!).state };
      for (const key of dropped) delete state[key];
      // The v74 copy also writes its own retired settings.
      Object.assign(state, { installedExtensions: [], characterPanelSearch: "" });
      localStorage.setItem(name, JSON.stringify({ state, version: 74 }));
    },
    { name: UI_PERSISTENCE.name, dropped: DROPPED_BY_V74_COPY },
  );
  return () => page.evaluate(() => sessionStorage.setItem("e2e:foreign-write", "armed"));
}

function readPersisted(page: Page) {
  return page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    return useUIStore.persist.getOptions().partialize(useUIStore.getState()) as Record<string, unknown>;
  });
}

function readStored(page: Page) {
  return page.evaluate((name) => JSON.parse(localStorage.getItem(name) ?? "null"), UI_PERSISTENCE.name) as Promise<{
    state: Record<string, unknown>;
    version: number;
  } | null>;
}

function pick(state: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

test.describe("UI settings and an old package's copy of the UI store", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("desktop"), "One browser proves the shared browser-storage path.");
  });

  test("browser-only settings survive the package rewriting the store at v74", async ({ page }) => {
    await prepare(page);
    await seedUIState(page, { hasCompletedOnboarding: true }, "if-missing");
    const armRewrite = await armForeignWrite(page);
    await page.goto("/");
    await page.evaluate(async (settings) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      const ui = useUIStore.getState();
      ui.setRoleplayReducedPaintEffects(settings.roleplayReducedPaintEffects);
      ui.selectImpersonatePromptTemplate({ id: settings.activeImpersonatePromptTemplateId, prompt: "Stay in voice." });
    }, LOCAL_SETTINGS);
    // The package rewrites what the user really saved, so wait for the debounced save first.
    await expect
      .poll(async () => pick((await readStored(page))?.state ?? {}, Object.keys(LOCAL_SETTINGS)))
      .toEqual(LOCAL_SETTINGS);
    const saved = pick(await readPersisted(page), DROPPED_BY_V74_COPY);

    await armRewrite();
    await page.reload();
    expect(await page.evaluate(() => sessionStorage.getItem("e2e:foreign-write"))).toBe("done");
    expect(pick(await readPersisted(page), DROPPED_BY_V74_COPY)).toEqual(saved);
    await expect.poll(async () => (await readStored(page))?.version).toBe(UI_PERSISTENCE.version);

    // The repaired blob is the one the next load reads.
    await page.reload();
    expect(pick(await readPersisted(page), DROPPED_BY_V74_COPY)).toEqual(saved);
    expect(pick((await readStored(page))!.state, Object.keys(LOCAL_SETTINGS))).toEqual(LOCAL_SETTINGS);
  });

  for (const legacy of [
    { release: "v2.4.4", version: 96, sheet: [1536, 1024] },
    { release: "v2.5.0", version: 101, sheet: [1280, 720] },
  ]) {
    test(`an upgrade from ${legacy.release} still migrates its saved settings`, async ({ page }) => {
      await prepare(page);
      await page.addInitScript(
        ({ name, version, mariKey }) => {
          if (sessionStorage.getItem("e2e:legacy-seeded")) return;
          sessionStorage.setItem("e2e:legacy-seeded", "true");
          localStorage.setItem(mariKey, "e2e-legacy-mari");
          localStorage.setItem(
            name,
            JSON.stringify({
              state: {
                hasCompletedOnboarding: true,
                chibiProfessorMariEnabled: false,
                chatWindowIntroDismissed: true,
                seasonalThemesDisabled: true,
                imageBackgroundWidth: 1536,
                imageBackgroundHeight: 1024,
              },
              version,
            }),
          );
        },
        { name: UI_PERSISTENCE.name, version: legacy.version, mariKey: LEGACY_MARI_CONNECTION_KEY },
      );
      await page.goto("/");
      expect(
        pick(await readPersisted(page), [
          "imageCharacterSheetWidth",
          "imageCharacterSheetHeight",
          "mariConnectionId",
          "roleplayReducedPaintEffects",
          "activeImpersonatePromptTemplateId",
        ]),
      ).toEqual({
        imageCharacterSheetWidth: legacy.sheet[0],
        imageCharacterSheetHeight: legacy.sheet[1],
        mariConnectionId: "e2e-legacy-mari",
        roleplayReducedPaintEffects: false,
        activeImpersonatePromptTemplateId: null,
      });
      await expect.poll(async () => (await readStored(page))?.version).toBe(UI_PERSISTENCE.version);
    });
  }

  test("an older blob still migrates the settings the user never changed", async ({ page }) => {
    await prepare(page);
    await seedUIState(page, { hasCompletedOnboarding: true, imageBackgroundWidth: 1536 }, "if-missing");
    await page.addInitScript((name) => {
      if (sessionStorage.getItem("e2e:legacy-rewrite") !== "armed") return;
      sessionStorage.setItem("e2e:legacy-rewrite", "done");
      const stored = JSON.parse(localStorage.getItem(name)!);
      delete stored.state.imageCharacterSheetWidth;
      localStorage.setItem(name, JSON.stringify({ state: stored.state, version: 99 }));
    }, UI_PERSISTENCE.name);
    await page.goto("/");
    await expect.poll(async () => (await readStored(page))?.state.imageCharacterSheetWidth).toBe(1280);
    await page.evaluate(() => sessionStorage.setItem("e2e:legacy-rewrite", "armed"));
    await page.reload();
    expect(await page.evaluate(() => sessionStorage.getItem("e2e:legacy-rewrite"))).toBe("done");
    // The sheet size was never changed, so the v99 migration still derives it from the background size.
    expect((await readPersisted(page)).imageCharacterSheetWidth).toBe(1536);
  });

  test("preferences seeded at the current version win over the saved copy", async ({ page }) => {
    await prepare(page);
    await seedUIState(page, { hasCompletedOnboarding: true }, "if-missing");
    await page.goto("/");
    await page.evaluate(async () => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      useUIStore.getState().setRoleplayReducedPaintEffects(true);
    });
    await expect.poll(async () => (await readStored(page))?.state.roleplayReducedPaintEffects).toBe(true);
    await seedUIState(page, { hasCompletedOnboarding: true, roleplayReducedPaintEffects: false });
    await page.reload();
    expect((await readPersisted(page)).roleplayReducedPaintEffects).toBe(false);
  });
});
