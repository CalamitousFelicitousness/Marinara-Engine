import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// Home's new-chat buttons wait for the connection list when it is still loading (seconds on Termux, the APK
// and phones), instead of taking a loading list for no connections and asking the user to choose one.
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const FIRST_LOAD_TIMEOUT_MS = 30_000;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
  }, version);
  await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
});

/** Holds every connection list request until `release()`, then answers with `rows` or, without them, the
 *  server's list. */
async function holdConnectionList(page: Page, rows?: unknown[]) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route("**/api/connections", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    held += 1;
    await released;
    // The page may have dropped the request while it was held.
    await (rows ? route.fulfill({ json: rows }) : route.continue()).catch(() => undefined);
  });
  return { release, held: () => held };
}

function isChatCreate(request: Request) {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/chats";
}

test("a new roleplay started before the connection list loads opens the setup, not the connection gate", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const connectionResponse = await request.post("/api/connections", {
    data: {
      name: `Slow Home Start ${suffix}`,
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "slow-home-start-e2e",
      model: "slow-home-start-model",
      maxContext: 32768,
    },
  });
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { id: string };
  const chatIds: string[] = [];
  page.on("response", async (response) => {
    if (isChatCreate(response.request()) && response.ok()) chatIds.push(((await response.json()) as { id: string }).id);
  });
  let releaseChat = () => {};
  const chatReleased = new Promise<void>((resolve) => (releaseChat = resolve));
  await page.route("**/api/chats", async (route) => {
    if (!isChatCreate(route.request())) return route.fallback();
    await chatReleased;
    await route.continue().catch(() => undefined);
  });

  try {
    const list = await holdConnectionList(page);
    await page.goto("/");
    const roleplay = page.getByRole("button", { name: "Start a new roleplay", exact: true });
    await expect(roleplay).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await expect.poll(list.held, { message: "the connection list is still loading" }).toBeGreaterThan(0);
    await roleplay.click();
    // A second tap while it waits must not make a second chat.
    await roleplay.dispatchEvent("click");
    const creatingChat = page.waitForRequest(isChatCreate);
    list.release();
    await creatingChat;
    // Keep the first save pending after the list has loaded: taps must stay ignored until it finishes.
    const duplicate = page.waitForRequest(isChatCreate, { timeout: 1_000 }).catch(() => null);
    await roleplay.dispatchEvent("click");
    expect(await duplicate, "a second tap during chat creation must not send another save").toBeNull();
    releaseChat();

    // The first open also compiles the chat area and the lazy setup wizard on the dev server.
    await expect(page.getByRole("heading", { name: "New Roleplay", exact: true })).toBeVisible({
      timeout: FIRST_LOAD_TIMEOUT_MS,
    });
    await expect(page.locator("[data-new-chat-connection-gate]")).toHaveCount(0);
    await expect.poll(() => chatIds.length, { message: "one chat is made" }).toBe(1);
  } finally {
    releaseChat();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const chatId of chatIds) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    await request.delete(`/api/connections/${connection.id}`).catch(() => undefined);
  }
});

test("with no connections at all, a new roleplay still asks for one first", async ({ page }) => {
  let chatCreated = false;
  page.on("request", (request) => {
    if (isChatCreate(request)) chatCreated = true;
  });
  const list = await holdConnectionList(page, []);
  await page.goto("/");
  const roleplay = page.getByRole("button", { name: "Start a new roleplay", exact: true });
  await expect(roleplay).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
  await expect.poll(list.held, { message: "the connection list is still loading" }).toBeGreaterThan(0);
  await roleplay.click();
  list.release();

  const gate = page.locator('[data-new-chat-connection-gate="roleplay"]');
  await expect(gate).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
  await expect(gate.locator("[data-new-chat-connection-empty]")).toBeVisible();
  expect(chatCreated, "no chat is made without a connection").toBe(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
