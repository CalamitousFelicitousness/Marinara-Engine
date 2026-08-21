// Fork feature: multiswipe. Covers the browser wiring the server-side lanes
// cannot reach: the count menu appearing from the setting, the chosen count
// reaching the generate request, and appended silent swipes becoming visible
// on the swipe control.
import { expect, test, type Page } from "@playwright/test";

const ACTIVE_CHAT_KEY = "marinara-active-chat-id";

async function seedClient(page: Page, chatId: string, multiSwipeMax: number) {
  await page.addInitScript(
    ({ chatId: id, multiSwipeMax: max, activeChatKey }) => {
      localStorage.setItem(activeChatKey, id);
      localStorage.setItem(
        "marinara-engine-ui",
        JSON.stringify({ state: { multiSwipeMax: max }, version: 95 }),
      );
    },
    { chatId, multiSwipeMax, activeChatKey: ACTIVE_CHAT_KEY },
  );
}

test("multiswipe reroll menu requests candidates and reveals the appended swipes", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "The reroll menu is a right-click gesture.");

  const chatResponse = await request.post("/api/chats", {
    data: { name: "Multiswipe reroll menu", mode: "roleplay", characterIds: [] },
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()) as { id: string };

  try {
    const messageResponse = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "Original response." },
    });
    expect(messageResponse.ok()).toBeTruthy();
    const message = (await messageResponse.json()) as { id: string };

    // A second, active swipe so the swipe control is rendered and sits on the newest entry.
    const swipeResponse = await request.post(`/api/chats/${chat.id}/messages/${message.id}/swipes`, {
      data: { content: "Candidate body 1.", silent: false },
    });
    expect(swipeResponse.ok()).toBeTruthy();

    // Stand in for the server's candidate loop: announce two extra silent swipes.
    const generateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/generate", async (route) => {
      generateBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
      const events = [
        { type: "multi_swipe_progress", data: { messageId: message.id, current: 2, total: 3, status: "generating" } },
        { type: "swipe_appended", data: { messageId: message.id, index: 2, swipeCount: 3 } },
        { type: "swipe_appended", data: { messageId: message.id, index: 3, swipeCount: 4 } },
        { type: "done", data: "" },
      ];
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      });
    });

    await seedClient(page, chat.id, 3);
    await page.goto("/");

    const messageRow = page.locator(`[data-message-id="${message.id}"]`);
    await expect(messageRow).toContainText("Candidate body 1.");

    const swipeControl = messageRow.locator(".mari-message-swipes").first();
    await expect(swipeControl).toContainText("/2");

    // Right-click the create-next chevron for the count menu.
    await swipeControl.locator("button").last().click({ button: "right" });
    const rerollThree = page.getByText("Reroll 3 alternatives", { exact: true });
    await expect(rerollThree).toBeVisible();
    await rerollThree.click();

    await expect
      .poll(() => generateBodies.length, { message: "the menu selection must start a generation" })
      .toBeGreaterThan(0);
    expect(generateBodies[0]?.candidateCount, "the chosen count must reach the server").toBe(3);
    expect(generateBodies[0]?.regenerateMessageId).toBe(message.id);

    // The appended silent swipes never move the active index, so only the
    // swipe_appended events can reveal them.
    await expect(swipeControl).toContainText("/4");
  } finally {
    await page.unroute("**/api/generate");
    await request.delete(`/api/chats/${chat.id}`);
  }
});

// Per-swipe lifecycle: a candidate the user never committed to keeps its
// deferred agents, and the badge is the primary way to run them. Runs on both
// projects because nothing here depends on a right-click gesture.
test("an unchosen multiswipe version keeps its agents pending and the badge runs them", async ({ page, request }) => {
  const chatResponse = await request.post("/api/chats", {
    data: { name: "Multiswipe pending badge", mode: "roleplay", characterIds: [] },
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()) as { id: string };

  try {
    const messageResponse = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "Original response." },
    });
    expect(messageResponse.ok()).toBeTruthy();
    const message = (await messageResponse.json()) as { id: string };
    const swipeResponse = await request.post(`/api/chats/${chat.id}/messages/${message.id}/swipes`, {
      data: { content: "Candidate body 1.", silent: false },
    });
    expect(swipeResponse.ok()).toBeTruthy();

    // Stand in for a multiswipe run that deferred its agents. The extra patch
    // merges onto the message and mirrors to the active swipe, which is the same
    // shape the candidate loop writes.
    const extraResponse = await request.patch(`/api/chats/${chat.id}/messages/${message.id}/extra`, {
      data: { multiSwipe: { pendingAgents: ["trackers"], candidateCount: 2, createdAt: Date.now() } },
    });
    expect(extraResponse.ok()).toBeTruthy();

    const retryBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/generate/retry-agents", async (route) => {
      retryBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        body: `data: ${JSON.stringify({ type: "done", data: "" })}\n\n`,
      });
    });

    await seedClient(page, chat.id, 3);
    await page.goto("/");

    const messageRow = page.locator(`[data-message-id="${message.id}"]`);
    await expect(messageRow).toContainText("Candidate body 1.");

    // The chat list overlays the transcript on mobile, so nothing in a message
    // is tappable until it is dismissed.
    const closeChatList = page.getByRole("button", { name: "Close chats" });
    if (await closeChatList.isVisible().catch(() => false)) {
      await closeChatList.click();
      await expect(closeChatList).toBeHidden();
    }

    const pendingBadge = messageRow.getByRole("button", { name: "Agents pending" }).first();
    await expect(pendingBadge, "an un-agented swipe must announce itself").toBeVisible();
    await pendingBadge.click();

    await expect
      .poll(() => retryBodies.length, { message: "the badge must replay the deferred agents" })
      .toBeGreaterThan(0);
    expect(retryBodies[0]?.agentTypes).toEqual(["trackers"]);
    expect(retryBodies[0]?.forMessageId, "agents must anchor to the swipe the user is on").toBe(message.id);

    // The real finalize route cleared the marker, so the state is gone for good.
    await expect(pendingBadge).toHaveCount(0);
  } finally {
    await page.unroute("**/api/generate/retry-agents");
    await request.delete(`/api/chats/${chat.id}`);
  }
});

// The setting itself syncs to the server, so it outlives a browser context and
// cannot be asserted per test. What matters behaviorally is that arming the menu
// never changes what a plain click does.
test("a plain swipe click stays a single reroll while multiswipe is armed", async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Pairs with the desktop-only reroll menu.");

  const chatResponse = await request.post("/api/chats", {
    data: { name: "Multiswipe plain click", mode: "roleplay", characterIds: [] },
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()) as { id: string };

  try {
    const messageResponse = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "Original response." },
    });
    expect(messageResponse.ok()).toBeTruthy();
    const message = (await messageResponse.json()) as { id: string };
    const swipeResponse = await request.post(`/api/chats/${chat.id}/messages/${message.id}/swipes`, {
      data: { content: "Second swipe.", silent: false },
    });
    expect(swipeResponse.ok()).toBeTruthy();

    const generateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/generate", async (route) => {
      generateBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        body: `data: ${JSON.stringify({ type: "done", data: "" })}\n\n`,
      });
    });

    await seedClient(page, chat.id, 3);
    await page.goto("/");

    const messageRow = page.locator(`[data-message-id="${message.id}"]`);
    await expect(messageRow).toContainText("Second swipe.");
    const swipeControl = messageRow.locator(".mari-message-swipes").first();
    await expect(swipeControl).toContainText("/2");

    await swipeControl.locator("button").last().click();

    await expect
      .poll(() => generateBodies.length, { message: "a plain click must still reroll" })
      .toBeGreaterThan(0);
    expect(generateBodies[0]?.candidateCount ?? 1, "a plain click must not fan out").toBe(1);
    await expect(page.getByText("Reroll 3 alternatives", { exact: true })).toHaveCount(0);
  } finally {
    await page.unroute("**/api/generate");
    await request.delete(`/api/chats/${chat.id}`);
  }
});
