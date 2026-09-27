import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// The Chat Variables editor builds each patch up front while the requests
// themselves are serialized. A second operation on a row therefore has to
// target the name the first one establishes, or the two writes disagree about
// which name exists. These sequences are only reproducible with a real in-flight
// request, so they live here rather than in the node regressions.
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const record = (value: unknown): Record<string, any> => (typeof value === "string" ? JSON.parse(value) : (value ?? {}));

type Gate = { release: () => void; started: () => boolean };

async function openChatVariables(page: import("@playwright/test").Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["roleplay"],
    chatSettingsExpandedSections: { "roleplay-chat-variables": true },
  });
  await page.addInitScript(
    ({ id, seenVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", seenVersion);
    },
    { id: chatId, seenVersion: version },
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    useChatStore.getState().setShouldOpenSettings(true);
  });
  const drawer = page.locator(".mari-chat-settings-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}

// Holds the first metadata PATCH so a second operation is queued behind it.
async function holdFirstMetadataPatch(page: import("@playwright/test").Page, chatId: string): Promise<Gate> {
  let started = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/api/chats/${chatId}/metadata`, async (route) => {
    if (route.request().method() === "PATCH" && !held) {
      held = true;
      started = true;
      await gate;
    }
    await route.continue();
  });
  return { release: () => release(), started: () => started };
}

const createChat = async (request: import("@playwright/test").APIRequestContext, name: string) => {
  const created = await request.post("/api/chats", { data: { name, mode: "roleplay", characterIds: [] } });
  expect(created.ok()).toBeTruthy();
  return (await created.json()) as { id: string };
};

const storedVariables = async (request: import("@playwright/test").APIRequestContext, chatId: string) =>
  record((await (await request.get(`/api/chats/${chatId}`)).json()).metadata).macroVariables ?? {};

test("a delete queued behind a rename targets the renamed variable", async ({ page, request }) => {
  const chat = await createChat(request, "Queued rename then delete");
  await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
  const drawer = await openChatVariables(page, chat.id);
  const row = drawer.locator('[data-chat-variable-row="char1"]');
  await expect(row).toBeVisible();

  const gate = await holdFirstMetadataPatch(page, chat.id);
  const name = row.getByLabel("Variable name");
  await name.fill("lead");
  await name.press("Enter");
  await expect.poll(gate.started).toBe(true);

  // The rename is still in flight; removing the row must drop `lead`, not `char1`.
  await drawer.locator("[data-chat-variable-row]").first().getByRole("button", { name: "Remove variable" }).click();
  gate.release();

  await expect.poll(async () => await storedVariables(request, chat.id)).toEqual({});
});

test("a second rename queued behind the first drops the intermediate name", async ({ page, request }) => {
  const chat = await createChat(request, "Queued double rename");
  await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
  const drawer = await openChatVariables(page, chat.id);
  const row = drawer.locator('[data-chat-variable-row="char1"]');
  await expect(row).toBeVisible();

  const gate = await holdFirstMetadataPatch(page, chat.id);
  const name = drawer.locator("[data-chat-variable-row]").first().getByLabel("Variable name");
  await name.fill("lead");
  await name.press("Enter");
  await expect.poll(gate.started).toBe(true);
  await name.fill("hero");
  await name.press("Enter");
  gate.release();

  // `lead` must not survive as an orphan alongside `hero`.
  await expect.poll(async () => await storedVariables(request, chat.id)).toEqual({ hero: "Mary" });
});

test("a value edit is sent for a name only {{setvar}} could have created", async ({ page, request }) => {
  const chat = await createChat(request, "Legacy setvar name");
  // The metadata route refuses to *create* a dotted name, because a bare
  // {{story.day}} could never resolve — only {{setvar}} inside a prompt can put
  // one in a chat. So the fixture injects it into the chat the client reads, and
  // the assertion is on the request the editor makes: the server side of this is
  // already covered by scripts/regressions/chat-variables-persistence.
  await page.route(`**/api/chats/${chat.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { metadata?: unknown };
    const metadata = record(body.metadata);
    await route.fulfill({
      response,
      json: { ...body, metadata: { ...metadata, macroVariables: { "story.day": "3" } } },
    });
  });
  // The app patches unrelated metadata (a background, say) on startup, so keep
  // only the writes this section makes.
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/chats/${chat.id}/metadata`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body && Object.prototype.hasOwnProperty.call(body, "macroVariables")) patches.push(body);
    }
    await route.continue();
  });

  const drawer = await openChatVariables(page, chat.id);
  const row = drawer.locator('[data-chat-variable-row="story.day"]');
  await expect(row).toBeVisible();
  await expect(row.getByLabel("Variable name")).toHaveAttribute("aria-invalid", "false");

  const value = row.getByLabel("Variable value");
  await value.fill("4");
  await value.press("Enter");

  await expect.poll(() => patches).toEqual([{ macroVariables: { "story.day": "4" } }]);
});
