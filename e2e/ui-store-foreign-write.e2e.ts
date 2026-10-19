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
const PACKAGE_ID = "e2e-ui-store-package";

async function prepare(page: Page) {
  // Keep the proof local: a server copy of the synced settings must not refill what the browser lost.
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), APP_VERSION);
}

/** Installs one package whose client module is `body`, and records the stored blob's version as each page starts. */
async function installPackageClient(page: Page, body: string) {
  await page.addInitScript((name) => {
    const versions = JSON.parse(sessionStorage.getItem("e2e:stored-versions") ?? "[]") as unknown[];
    versions.push(JSON.parse(localStorage.getItem(name) ?? "null")?.version ?? null);
    sessionStorage.setItem("e2e:stored-versions", JSON.stringify(versions));
  }, UI_PERSISTENCE.name);
  const manifest = {
    schemaVersion: 1,
    id: PACKAGE_ID,
    name: "UI Store Fixture",
    version: "1.0.0",
    description: "UI store fixture.",
    engine: { min: "2.3.0", maxExclusive: "4.0.0" },
    kind: ["agent"],
    entrypoints: { agents: "agents.json", client: "client.js" },
    files: [{ path: "client.js", sha256: "0".repeat(64), bytes: 1 }],
    permissions: ["ui"],
    restartRequired: false,
  };
  await page.route("**/api/capability-packages/installed", (route) =>
    route.fulfill({
      json: [
        {
          id: PACKAGE_ID,
          version: manifest.version,
          manifest,
          installedAt: "2026-10-01T00:00:00.000Z",
          status: "active",
          error: null,
          readiness: "ready",
          readinessError: null,
          legacy: false,
        },
      ],
    }),
  );
  await page.route(`**/api/capability-packages/${PACKAGE_ID}/client?*`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `${body}
customElements.get("marinara-capability-${PACKAGE_ID}") ||
  customElements.define("marinara-capability-${PACKAGE_ID}", class extends HTMLElement {});
globalThis.__e2ePackageLoads = (globalThis.__e2ePackageLoads ?? 0) + 1;`,
    }),
  );
}

/**
 * A client built before the host bridge: its bundled v74 store reads the key once, keeps only the settings it knows
 * and saves them at v74 (again as the page goes away, after the Engine's own last save).
 */
function oldPackageClient() {
  return `
const name = ${JSON.stringify(UI_PERSISTENCE.name)};
const stored = JSON.parse(localStorage.getItem(name) ?? "null");
if (stored && stored.version !== 74) {
  const state = { ...stored.state };
  for (const key of ${JSON.stringify(DROPPED_BY_V74_COPY)}) delete state[key];
  Object.assign(state, { installedExtensions: [], characterPanelSearch: "" });
  const save = () => localStorage.setItem(name, JSON.stringify({ state, version: 74 }));
  save();
  addEventListener("pagehide", save);
}`;
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

function storedVersionsAtStart(page: Page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("e2e:stored-versions") ?? "[]") as unknown[]);
}

async function waitForPackageClient(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (globalThis as { __e2ePackageLoads?: number }).__e2ePackageLoads))
    .toBe(1);
}

function pick(state: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

test.describe("UI settings and an old package's copy of the UI store", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("desktop"), "One browser proves the shared browser-storage path.");
  });

  test("package clients load after the host UI store bridge and change the live store", async ({ page }) => {
    await prepare(page);
    await seedUIState(page, { hasCompletedOnboarding: true }, "if-missing");
    await installPackageClient(
      page,
      `const bridge = globalThis.__MARINARA_HOST_UI_STORE__;
globalThis.__e2eBridgeAtImport = bridge ? { version: bridge.version, store: bridge.store } : null;
bridge?.store.getState().setRoleplayReducedPaintEffects(true);`,
    );
    await page.goto("/");
    await waitForPackageClient(page);
    expect(
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        const seen = (globalThis as { __e2eBridgeAtImport?: { version: number; store: unknown } | null })
          .__e2eBridgeAtImport;
        return {
          version: seen?.version,
          liveStore: seen?.store === useUIStore,
          changed: useUIStore.getState().roleplayReducedPaintEffects,
        };
      }),
    ).toEqual({ version: 1, liveStore: true, changed: true });
    // The package changed the Engine's own settings, so the Engine saves them.
    await expect.poll(async () => (await readStored(page))?.state.roleplayReducedPaintEffects).toBe(true);
  });

  test("settings survive an old package client saving its v74 copy over them", async ({ page }) => {
    await prepare(page);
    // From a v74 blob, migrations would size the sheet like this background and restore this old Mari connection;
    // the user's saved sheet size and cleared connection must win instead.
    await seedUIState(page, { hasCompletedOnboarding: true, imageBackgroundWidth: 1536 }, "if-missing");
    await page.addInitScript((key) => localStorage.setItem(key, "e2e-legacy-mari"), LEGACY_MARI_CONNECTION_KEY);
    await installPackageClient(page, oldPackageClient());
    await page.goto("/");
    await waitForPackageClient(page);
    // The package saved its copy when it loaded; the user's changes come after it.
    await page.evaluate(async (settings) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      const ui = useUIStore.getState();
      ui.setSidebarWidth(400);
      ui.setRoleplayReducedPaintEffects(settings.roleplayReducedPaintEffects);
      ui.selectImpersonatePromptTemplate({ id: settings.activeImpersonatePromptTemplateId, prompt: "Stay in voice." });
    }, LOCAL_SETTINGS);
    await expect
      .poll(async () => pick((await readStored(page))?.state ?? {}, Object.keys(LOCAL_SETTINGS)))
      .toEqual(LOCAL_SETTINGS);
    const saved = pick(await readPersisted(page), [...DROPPED_BY_V74_COPY, "sidebarWidth"]);
    expect(pick(saved, ["imageCharacterSheetWidth", "mariConnectionId", "sidebarWidth"])).toEqual({
      imageCharacterSheetWidth: 1280,
      mariConnectionId: null,
      sidebarWidth: 400,
    });

    for (let reload = 1; reload <= 2; reload += 1) {
      await page.reload();
      await waitForPackageClient(page);
      // The package's v74 copy, made before the user's changes, is what the first reload finds in the key.
      if (reload === 1) expect(await storedVersionsAtStart(page)).toEqual([UI_PERSISTENCE.version, 74]);
      expect(pick(await readPersisted(page), Object.keys(saved))).toEqual(saved);
    }
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
