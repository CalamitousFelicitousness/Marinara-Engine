// A mode's starred arrangement is a default for future chats, separate from profiles and existing chats.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openChatSettings } from "./chat-settings-tools.js";
import { seedUIState } from "./ui-state-fixture.js";

type Mode = "conversation" | "roleplay" | "game";
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const favoritePath = (mode: Mode) => `/api/app-settings/chat-window-default-${mode}`;

async function readFavorite(request: APIRequestContext, mode: Mode) {
  const response = await request.get(favoritePath(mode));
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { value: string | null }).value;
}

async function readMetadata(request: APIRequestContext, id: string) {
  const chat = (await (await request.get(`/api/chats/${id}`)).json()) as { metadata: unknown };
  return (typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata) as Record<string, unknown>;
}

async function prepare(page: Page, id: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatSettingsMoveTipDismissed: true,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
  });
  await page.addInitScript(
    ({ chatId, version }) => {
      localStorage.setItem("marinara:whats-new:seen-version", version);
      localStorage.setItem("marinara-active-chat-id", chatId);
    },
    { chatId: id, version: APP_VERSION },
  );
}

for (const mode of ["conversation", "roleplay", "game"] as const) {
  test(`${mode}: starring a layout affects new chats only and profiles remain independent`, async ({
    page,
    request,
  }) => {
    const otherMode: Mode = mode === "conversation" ? "roleplay" : "conversation";
    const original = await readFavorite(request, mode);
    const otherOriginal = await readFavorite(request, otherMode);
    const otherFavorite = JSON.stringify({ windowLayout: null, chatSettingsHintDismissed: true });
    const chatIds: string[] = [];
    let profileId: string | undefined;
    const create = async () => {
      const response = await request.post("/api/chats", {
        data: { name: `Favorite layout ${mode}`, mode, characterIds: [] },
      });
      expect(response.ok()).toBeTruthy();
      const { id } = (await response.json()) as { id: string };
      chatIds.push(id);
      return id;
    };
    try {
      expect((await request.put(favoritePath(mode), { data: { value: "null" } })).ok()).toBeTruthy();
      expect((await request.put(favoritePath(otherMode), { data: { value: otherFavorite } })).ok()).toBeTruthy();
      const source = await create();
      const existing = await create();
      const existingBefore = await readMetadata(request, existing);
      const chatName = "drawer:chat-settings:chat-name";
      const layout = {
        version: 1,
        windows: {
          "chat-settings": { x: 180, y: 120, width: 480, height: 520, pinned: true, locked: true, minimized: false },
          [chatName]: { x: 740, y: 160, width: 320, height: 240, pinned: true, locked: true, minimized: true },
          ...(mode === "game"
            ? {
                "control:volume": {
                  x: 900,
                  y: 170,
                  width: 280,
                  height: 270,
                  pinned: true,
                  locked: true,
                  docked: true,
                  minimized: false,
                },
              }
            : {}),
        },
        detached: [chatName],
        bubbles: { "chat-settings-button": { x: 540, y: 70 }, [chatName]: { x: 980, y: 70 } },
        phoneBubbles: { "chat-settings-button": { x: 80, y: 80 }, [chatName]: { x: 280, y: 80 } },
      };
      expect(
        (
          await request.patch(`/api/chats/${source}/metadata`, {
            data: {
              windowLayout: layout,
              chatSettingsHintDismissed: true,
              enableAgents: false,
              ...(mode === "game"
                ? {
                    gameId: "favorite-layout-game",
                    gameSessionStatus: "active",
                    gameSessionNumber: 1,
                    gameIntroPresented: true,
                  }
                : {}),
            },
          })
        ).ok(),
      ).toBeTruthy();
      expect(
        (
          await request.post(`/api/chats/${source}/messages`, {
            data: { role: "assistant", content: "A saved arrangement." },
          })
        ).ok(),
      ).toBeTruthy();
      await prepare(page, source);
      await page.goto("/");
      const settings = await openChatSettings(page);
      const star = settings.locator('[data-chat-settings-control="favorite-layout"]');
      await expect(star).toBeEnabled();
      await expect(star).toHaveAttribute("aria-pressed", "false");
      expect(
        await star.evaluate((element) => element.previousElementSibling?.getAttribute("data-chat-settings-control")),
      ).toBe("reset-view");
      await star.click();
      await expect(star).toHaveAttribute("aria-pressed", "true");
      const favorite = { windowLayout: layout, chatSettingsHintDismissed: true };
      await expect.poll(async () => JSON.parse((await readFavorite(request, mode)) ?? "null")).toEqual(favorite);
      const created = await create();
      const createdMetadata = await readMetadata(request, created);
      expect(createdMetadata.windowLayout).toEqual(layout);
      expect(createdMetadata.chatSettingsHintDismissed).toBe(true);
      expect(await readMetadata(request, existing)).toEqual(existingBefore);

      const profile = await request.post("/api/chat-presets", {
        data: {
          name: `Favorite override ${mode}`,
          mode,
          settings: { metadata: { windowLayout: null, chatSettingsHintDismissed: false } },
        },
      });
      expect(profile.ok()).toBeTruthy();
      profileId = ((await profile.json()) as { id: string }).id;
      expect((await request.post(`/api/chat-presets/${profileId}/apply/${created}`)).ok()).toBeTruthy();
      const applied = await readMetadata(request, created);
      expect(applied.windowLayout).toBeNull();
      expect(applied.chatSettingsHintDismissed).toBe(false);
      expect(JSON.parse((await readFavorite(request, mode)) ?? "null")).toEqual(favorite);

      await star.click();
      await expect(star).toHaveAttribute("aria-pressed", "false");
      await expect.poll(async () => JSON.parse((await readFavorite(request, mode)) ?? "null")).toBeNull();
      expect(await readFavorite(request, otherMode)).toBe(otherFavorite);
      const afterClear = await create();
      const afterClearMetadata = await readMetadata(request, afterClear);
      expect(afterClearMetadata.windowLayout).toBeNull();
      expect(afterClearMetadata.chatSettingsHintDismissed).not.toBe(true);
      expect((await readMetadata(request, source)).windowLayout).toEqual(layout);
    } finally {
      if (profileId) await request.delete(`/api/chat-presets/${profileId}`);
      for (const id of chatIds) await request.delete(`/api/chats/${id}?force=true`);
      await request.put(favoritePath(mode), { data: { value: original ?? "null" } });
      await request.put(favoritePath(otherMode), { data: { value: otherOriginal ?? "null" } });
    }
  });
}
