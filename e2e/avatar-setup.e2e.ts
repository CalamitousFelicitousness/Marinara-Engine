import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// #7537 (base lane): a character with expression sprites already has a PNGTuber avatar in a Roleplay chat
// with 2D Avatars on, before anything is saved. The 2D Avatars agent page shows one set of controls (the
// base switches above the 2D lane's PNGTuber panel), saves the sprites with `_talk` sprites as open mouths,
// and the faces can be changed by hand. On phones the chat stays mounted under the agent's page, and its
// avatars stop drawing while covered.
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const FIRST_LOAD_TIMEOUT_MS = 30_000;

const PACKAGE = {
  id: "2d-avatars",
  version: "1.0.0",
  status: "active",
  readiness: "ready",
  readinessError: null,
  error: null,
  legacy: false,
  installedAt: "2026-10-13T00:00:00.000Z",
  manifest: {
    schemaVersion: 2,
    id: "2d-avatars",
    name: "2D Avatars",
    version: "1.0.0",
    description: "Animated 2D avatars.",
    engine: { min: "2.5.0", maxExclusive: "4.0.0" },
    capabilityApi: { major: 1, minor: 73 },
    kind: ["agent"],
    entrypoints: { agents: "agents.json" },
    files: [{ path: "agents.json", sha256: "0".repeat(64), bytes: 1 }],
    permissions: ["ui"],
    restartRequired: false,
  },
};
const AGENT = {
  id: "2d-avatars",
  packageId: "2d-avatars",
  name: "2D Avatars",
  description: "Animated 2D avatars for characters and personas.",
  phase: "post_processing",
  enabledByDefault: false,
  category: "misc",
  execution: "host",
  defaultPromptTemplate: "",
};

async function preparePage(page: Page, characterId: string, ui: Record<string, unknown>, chatId?: string) {
  await page.route("**/api/capability-packages/installed", (route) => route.fulfill({ json: [PACKAGE] }));
  await page.route("**/api/capability-packages/agents", (route) => route.fulfill({ json: [AGENT] }));
  // The real list, without avatars other workers save on the same server (the setup page would open on one).
  await page.route("**/api/avatar-models", async (route) => {
    const response = await route.fetch();
    const owners = (await response.json()) as Array<{ owner: { ownerId: string } }>;
    await route.fulfill({ response, json: owners.filter((summary) => summary.owner.ownerId === characterId) });
  });
  await page.route(`**/api/sprites/${characterId}`, (route) =>
    route.fulfill({
      json: ["neutral", "neutral_talk", "happy", "happy_talk", "crying", "full_idle"].map((expression) => ({
        expression,
        filename: `${expression}.png`,
        url: "/sprites/avatar-demo/base.png",
      })),
    }),
  );
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["roleplay"],
    trackerPanelEnabled: false,
    trackerPanelOpen: false,
    ...ui,
  });
  await page.addInitScript(
    ({ appVersion, activeChatId }) => {
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      if (activeChatId) localStorage.setItem("marinara-active-chat-id", activeChatId);
    },
    { appVersion: APP_VERSION, activeChatId: chatId ?? null },
  );
}

test("2D Avatars shows a character's sprites as its avatar and saves them as a PNGTuber", async ({
  page,
  request,
}, info) => {
  const characterResponse = await request.post("/api/characters", { data: { data: { name: "Avatar fixture" } } });
  expect(characterResponse.ok(), await characterResponse.text()).toBeTruthy();
  const character = (await characterResponse.json()) as { id: string };
  const chatResponse = await request.post("/api/chats", {
    data: { name: "Avatar chat", mode: "roleplay", characterIds: [character.id] },
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()) as { id: string };
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: { enableAgents: true, activeAgentIds: ["2d-avatars"] },
      })
    ).ok(),
  ).toBeTruthy();

  try {
    // ── With nothing saved, the chat already shows the character's sprites as its avatar ──
    const chatPage = await page.context().newPage();
    await preparePage(chatPage, character.id, {}, chat.id);
    await chatPage.goto("/");
    const avatar = chatPage.locator(`[data-avatar-stage] [data-avatar-owner="${character.id}"]`);
    await expect(avatar).toHaveAttribute("data-avatar-kind", "pngtuber", { timeout: FIRST_LOAD_TIMEOUT_MS });
    await expect(avatar.getByRole("img", { name: "Avatar fixture's avatar" })).toBeVisible();
    await expect(chatPage.locator("[data-avatar-stage]")).not.toHaveAttribute("data-avatar-paused", "true");
    expect((await request.get(`/api/avatar-models/character/${character.id}`)).status()).toBe(404);
    await chatPage.close();

    // ── The setup on the agent's page (on phones it covers the chat, which stays mounted under it) ──
    await preparePage(page, character.id, { agentDetailId: "2d-avatars" }, chat.id);
    await page.goto("/");
    const setup = page.locator('[data-avatar-setup="2d-avatars"]');
    // The first load also compiles the lazy setup chunk on the dev server.
    await expect(setup).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await expect(setup.getByText("Choose a character or persona to set up its avatar.")).toBeVisible();
    await setup.getByLabel("Character or persona").selectOption(`character:${character.id}`);
    // Wait for the lazy PNGTuber panel, then check the page has one set of controls.
    await expect(setup.locator("[data-avatar-pngtuber-status]")).toHaveText(
      "Shows your expression sprites until you change something here.",
      { timeout: FIRST_LOAD_TIMEOUT_MS },
    );
    await expect(setup.getByRole("button", { name: "Use my sprites", exact: true })).toHaveCount(1);
    await expect(setup.getByRole("button", { name: "Import PNGTuber Plus save", exact: true })).toHaveCount(1);
    await expect(setup.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    await expect(setup.getByText("Shown in chats")).toBeVisible();
    await expect(setup.getByText("An example avatar. Set one up to see yours.")).toHaveCount(0);
    await expect(setup.getByRole("img", { name: "Preview" })).toBeVisible();
    await expect(setup.getByRole("checkbox", { name: /Show this avatar in chats/u })).toBeChecked();
    await page.screenshot({ path: info.outputPath("avatar-setup-sprites.png"), animations: "disabled" });
    if (info.project.name.startsWith("mobile")) {
      // Only the preview draws: the covered chat's avatars stop.
      await expect(page.locator(`[data-avatar-stage]:has([data-avatar-owner="${character.id}"])`)).toHaveAttribute(
        "data-avatar-paused",
        "true",
        { timeout: FIRST_LOAD_TIMEOUT_MS },
      );
    }

    await setup.getByRole("button", { name: "Use my sprites", exact: true }).click();
    await expect(setup.locator("[data-avatar-pngtuber-status]")).not.toHaveText(
      "Shows your expression sprites until you change something here.",
    );
    await expect(setup.getByRole("button", { name: "Remove", exact: true })).toHaveCount(1);
    await expect(setup.locator('[data-avatar-feeling="sad"]')).toHaveValue("crying");
    await expect(setup.locator('[data-avatar-feeling="angry"]')).toHaveValue("");
    await setup.locator('[data-avatar-feeling="angry"]').selectOption("happy");
    await expect
      .poll(async () => {
        const saved = (await (await request.get(`/api/avatar-models/character/${character.id}`)).json()) as {
          kinds: { pngtuber: { expressionMap: Record<string, unknown> } };
        };
        return saved.kinds.pngtuber.expressionMap.angry;
      })
      .toEqual({ target: "happy", source: "user", confidence: 1 });
    await page.screenshot({ path: info.outputPath("avatar-setup.png"), animations: "disabled", fullPage: true });

    const saved = (await (await request.get(`/api/avatar-models/character/${character.id}`)).json()) as {
      activeKind: string;
      kinds: { pngtuber: { layers: Record<string, { mouthOpen?: unknown }> } };
    };
    expect(saved.activeKind).toBe("pngtuber");
    expect(Object.keys(saved.kinds.pngtuber.layers).sort()).toEqual(["crying", "happy", "neutral"]);
    expect(saved.kinds.pngtuber.layers.happy?.mouthOpen).toEqual({ source: "sprite", label: "happy_talk" });

    // ── The chat shows the saved avatar ──
    const savedChatPage = await page.context().newPage();
    await preparePage(savedChatPage, character.id, {}, chat.id);
    await savedChatPage.goto("/");
    const savedAvatar = savedChatPage.locator(`[data-avatar-stage] [data-avatar-owner="${character.id}"]`);
    await expect(savedAvatar).toHaveAttribute("data-avatar-kind", "pngtuber", { timeout: FIRST_LOAD_TIMEOUT_MS });
    await expect(savedAvatar.getByRole("img", { name: "Avatar fixture's avatar" })).toBeVisible();
    await savedChatPage.bringToFront();
    await expect(savedChatPage.locator("[data-avatar-stage]")).not.toHaveAttribute("data-avatar-paused", "true");
    await savedChatPage.close();

    // ── Removing the character removes its avatar ──
    expect((await request.delete(`/api/characters/${character.id}`)).status()).toBe(204);
    expect((await request.get(`/api/avatar-models/character/${character.id}`)).status()).toBe(404);
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`).catch(() => undefined);
    await request.delete(`/api/characters/${character.id}`).catch(() => undefined);
  }
});
