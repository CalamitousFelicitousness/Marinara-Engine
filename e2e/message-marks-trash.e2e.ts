import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("message marks stay in the chat UI and opted-in trash can restore a message", async ({
  page,
  request,
}, testInfo) => {
  const originalFeaturesResponse = await request.get("/api/app-settings/features");
  expect(originalFeaturesResponse.ok()).toBeTruthy();
  const originalFeatures = await originalFeaturesResponse.json();
  const features = { ...(originalFeatures.settings ?? {}), messageTrash: true };
  const enabledFeaturesResponse = await request.put("/api/app-settings/features", { data: features });
  expect(enabledFeaturesResponse.ok()).toBeTruthy();

  let chatId: string | undefined;
  let messageId: string | undefined;
  let testFailure: unknown;
  try {
    const created = await request.post("/api/chats", { data: { name: "Message marks fixture", mode: "conversation" } });
    expect(created.ok()).toBeTruthy();
    const chat = await created.json();
    chatId = chat.id;
    const messageResponse = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "Synthetic message for marks and restore." },
    });
    expect(messageResponse.ok()).toBeTruthy();
    const message = await messageResponse.json();
    messageId = message.id;

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
    });
    await page.addInitScript(
      ({ chatId, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", chatId);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { chatId: chat.id, appVersion: version },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Chats" }).click();
    if (testInfo.project.name.includes("mobile")) await page.getByRole("button", { name: "Close chats" }).click();

    const messageRow = page.locator(`[data-message-id="${messageId}"]`);
    await expect(messageRow).toContainText("Synthetic message for marks and restore.");
    await messageRow.focus();
    await messageRow.getByRole("button", { name: "Bookmark, pin or note" }).click();
    const marksMenu = page.getByRole("dialog", { name: "Bookmark, pin or note" });
    await marksMenu.getByRole("button", { name: "Bookmark message" }).click();
    await marksMenu.getByRole("button", { name: "Pin to context" }).click();
    await marksMenu.getByRole("textbox", { name: "Private note" }).fill("Synthetic private note.");
    await marksMenu.getByRole("button", { name: "Save note" }).click();

    await expect
      .poll(async () => {
        const result = await request.get(`/api/chats/${chat.id}/messages`);
        const messages = await result.json();
        const saved = messages.find((item: { id: string }) => item.id === messageId);
        return typeof saved?.extra === "string" ? JSON.parse(saved.extra) : saved?.extra;
      })
      .toMatchObject({
        bookmark: expect.any(Object),
        pinnedToContext: true,
        privateNote: "Synthetic private note.",
      });

    // Use the message DELETE route as a deterministic fixture action; restore is exercised through the chat UI.
    const deleted = await request.delete(`/api/chats/${chat.id}/messages/${messageId}`);
    expect(deleted.status()).toBe(200);
    expect(await deleted.json()).toEqual({ trashed: true, trashedCount: 1 });
    await page.reload();
    const trashedRow = page.locator(`[data-message-id="${messageId}"]`);
    await expect(trashedRow).toHaveCount(0);
    if (testInfo.project.name.includes("mobile")) {
      await page.getByRole("button", { name: "More options", exact: true }).click();
    }
    await page.getByRole("button", { name: "Search messages" }).click();
    const searchPanel = page.getByRole("dialog");
    await searchPanel.getByRole("tab", { name: "Trash", exact: true }).click();
    await expect(searchPanel).toContainText("Synthetic message for marks and restore.");
    await searchPanel.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.locator(`[data-message-id="${messageId}"]`)).toContainText(
      "Synthetic message for marks and restore.",
    );
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    const cleanupRequests: Array<Promise<unknown>> = [];
    if (chatId) {
      cleanupRequests.push(
        request.delete(`/api/chats/${chatId}?force=true`).then((response) => {
          if (!response.ok()) throw new Error(`Chat fixture cleanup failed (${response.status()})`);
        }),
      );
    }
    cleanupRequests.push(
      request.put("/api/app-settings/features", { data: originalFeatures.settings ?? {} }).then((response) => {
        if (!response.ok()) throw new Error(`Feature settings cleanup failed (${response.status()})`);
      }),
    );
    const cleanupResults = await Promise.allSettled(cleanupRequests);
    const cleanupFailures = cleanupResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (testFailure === undefined && cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Could not clean up message marks browser fixture");
    }
  }
});
