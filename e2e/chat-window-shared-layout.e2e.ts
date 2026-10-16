// One shared button layout per chat mode, off by default, and copying a layout into every chat.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openChatSettings } from "./chat-settings-tools.js";
import { seedUIState } from "./ui-state-fixture.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const SHARED_PATH = "/api/app-settings/chat-window-shared-roleplay";
const BUTTON = "chat-settings-button";

type Point = { x: number; y: number };
const layoutAt = (point: Point) => ({ version: 1, windows: {}, bubbles: { [BUTTON]: point } });

async function savedPoint(request: APIRequestContext, chatId: string): Promise<Point | undefined> {
  const chat = (await (await request.get(`/api/chats/${chatId}`)).json()) as { metadata: unknown };
  const metadata = (typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata) as {
    windowLayout?: { bubbles?: Record<string, Point> } | null;
  };
  return metadata.windowLayout?.bubbles?.[BUTTON];
}

async function sharedPoint(request: APIRequestContext): Promise<Point | undefined> {
  const { value } = (await (await request.get(SHARED_PATH)).json()) as { value: string | null };
  return value ? (JSON.parse(value) as { bubbles?: Record<string, Point> } | null)?.bubbles?.[BUTTON] : undefined;
}

async function switchChat(page: Page, chatId: string) {
  await page.evaluate(async (id) => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    useChatStore.getState().setActiveChatId(id);
  }, chatId);
}

async function setShared(page: Page, value: boolean) {
  await page.evaluate(async (next) => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    useUIStore.getState().setSharedChatWindowLayout(next);
  }, value);
}

async function expectButtonAt(page: Page, point: Point) {
  const button = page.locator(".mari-window-bubble[data-chat-settings-button]");
  await expect
    .poll(async () => {
      const box = await button.boundingBox();
      return box ? Math.abs(box.x - point.x) + Math.abs(box.y - point.y) : Infinity;
    })
    .toBeLessThan(4);
}

test("a shared layout moves buttons in every chat of a mode, and Apply copies one into each chat", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "phone bubbles keep their own row");
  const own = { a: { x: 300, y: 200 }, b: { x: 600, y: 250 } };
  const chatIds: string[] = [];
  const create = async (name: string, point: Point) => {
    const response = await request.post("/api/chats", { data: { name, mode: "roleplay", characterIds: [] } });
    expect(response.ok()).toBeTruthy();
    const { id } = (await response.json()) as { id: string };
    chatIds.push(id);
    const patched = await request.patch(`/api/chats/${id}/metadata`, { data: { windowLayout: layoutAt(point) } });
    expect(patched.ok()).toBeTruthy();
    return id;
  };
  try {
    expect((await request.put(SHARED_PATH, { data: { value: "null" } })).ok()).toBeTruthy();
    const a = await create("Shared layout A", own.a);
    const b = await create("Shared layout B", own.b);
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
      { chatId: a, version: APP_VERSION },
    );
    await page.goto("/");

    // Off by default: each chat shows its own place.
    await expectButtonAt(page, own.a);
    await switchChat(page, b);
    await expectButtonAt(page, own.b);

    // On, with nothing shared yet: the open chat's place stays, and a move saves to the shared layout.
    const sharedLoaded = page.waitForResponse(
      (response) => response.url().endsWith(SHARED_PATH) && response.request().method() === "GET",
    );
    await setShared(page, true);
    await sharedLoaded;
    await expectButtonAt(page, own.b);
    const button = page.locator(".mari-window-bubble[data-chat-settings-button]");
    const start = (await button.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x - 120, start.y + 90, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => sharedPoint(request)).toBeTruthy();
    const moved = (await sharedPoint(request))!;
    expect(Math.abs(moved.x - own.b.x) + Math.abs(moved.y - own.b.y)).toBeGreaterThan(50);
    await switchChat(page, a);
    await expectButtonAt(page, moved);
    expect(await savedPoint(request, a)).toEqual(own.a);
    expect(await savedPoint(request, b)).toEqual(own.b);

    // Off again: every chat has its own layout back.
    await setShared(page, false);
    await expectButtonAt(page, own.a);

    // Apply copies this chat's layout into every roleplay chat after a confirmation.
    const settings = await openChatSettings(page);
    await settings.locator('[data-chat-settings-control="apply-layout-to-all"]').click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => savedPoint(request, b)).toEqual(await savedPoint(request, a));
  } finally {
    await request.put(SHARED_PATH, { data: { value: "null" } });
    for (const id of chatIds) await request.delete(`/api/chats/${id}`);
  }
});
