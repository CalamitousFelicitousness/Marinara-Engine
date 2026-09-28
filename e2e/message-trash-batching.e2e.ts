import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("restore all batches large selections and keeps partial failures retryable", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const created = await request.post("/api/chats", {
    data: { name: "Large recovery fixture", mode: "conversation" },
  });
  expect(created.ok()).toBeTruthy();
  const chat = await created.json();
  let releaseSecondBatch!: () => void;
  const secondBatch = new Promise<void>((resolve) => {
    releaseSecondBatch = resolve;
  });
  let cleanupFailure: unknown;
  try {
    const timestamp = new Date().toISOString();
    let remaining = Array.from({ length: 5001 }, (_, index) => ({
      id: `recovery-entry-${index}`,
      chatId: chat.id,
      messageId: `recovery-message-${index}`,
      role: "user",
      characterId: null,
      content: `Recovery fixture ${index}`,
      swipeCount: 1,
      messageCreatedAt: timestamp,
      deletedAt: timestamp,
      expiresAt: timestamp,
    }));
    const batches: string[][] = [];
    let trashReads = 0;
    let messageReads = 0;
    page.on("request", (sent) => {
      if (new URL(sent.url()).pathname === `/api/chats/${chat.id}/messages`) messageReads += 1;
    });
    await page.route(`**/api/chats/${chat.id}/trash`, (route) => {
      trashReads += 1;
      return route.fulfill({ json: remaining });
    });
    await page.route(`**/api/chats/${chat.id}/trash/restore`, async (route) => {
      const { entryIds } = route.request().postDataJSON() as { entryIds: string[] };
      batches.push(entryIds);
      if (entryIds.length > 5000) return route.fulfill({ status: 400, json: { error: "entryIds limit exceeded" } });
      if (batches.length === 2) {
        await secondBatch;
        return route.fulfill({ status: 500, json: { error: "Synthetic later-batch failure" } });
      }
      if (batches.length === 3) return route.fulfill({ status: 500, json: { error: "Synthetic retry failure" } });
      const conflictEntryIds = batches.length === 1 ? [entryIds[0]!] : [];
      const requestedIds = new Set(entryIds);
      const restored = remaining.filter((entry) => requestedIds.has(entry.id) && !conflictEntryIds.includes(entry.id));
      const restoredIds = new Set(restored.map((entry) => entry.id));
      remaining = remaining.filter((entry) => !restoredIds.has(entry.id));
      return route.fulfill({
        json: { restoredMessageIds: restored.map((entry) => entry.messageId), conflictEntryIds },
      });
    });
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
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    if (testInfo.project.name.includes("mobile")) {
      await page.getByRole("button", { name: "Close chats" }).click();
      await page.getByRole("button", { name: "More options", exact: true }).click();
    }
    await page.getByRole("button", { name: "Search messages" }).click();
    const panel = page.getByRole("dialog");
    await panel.getByRole("tab", { name: "Trash", exact: true }).click();
    const restoreAll = panel.getByRole("button", { name: "Restore all", exact: true });
    await expect(restoreAll).toBeEnabled();
    const initialTrashReads = trashReads;
    const initialMessageReads = messageReads;
    await restoreAll.click();
    await expect.poll(() => batches.map((batch) => batch.length)).toEqual([5000, 1]);
    await expect(restoreAll).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Empty trash", exact: true })).toBeDisabled();
    expect(trashReads).toBe(initialTrashReads);
    releaseSecondBatch();
    // Replacing 5,001 mocked rows takes longer under development rendering and browser tracing.
    await expect(page.getByText("Synthetic later-batch failure", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("4999 messages restored", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Restore", exact: true })).toHaveCount(2);
    await expect.poll(() => messageReads).toBeGreaterThan(initialMessageReads);
    await expect(restoreAll).toBeEnabled();
    await restoreAll.click();
    await expect(page.getByText("Synthetic retry failure", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Restore", exact: true })).toHaveCount(2);
    await expect(restoreAll).toBeEnabled();
    await restoreAll.click();
    await expect(panel.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
    await expect(page.getByText("2 messages restored", { exact: true })).toBeVisible();
    expect(batches.map((batch) => batch.length)).toEqual([5000, 1, 2, 2]);
    expect(batches[2]).toEqual(["recovery-entry-0", "recovery-entry-5000"]);
    expect(batches[3]).toEqual(batches[2]);
    expect(remaining).toEqual([]);
  } finally {
    releaseSecondBatch();
    await request.delete(`/api/chats/${chat.id}?force=true`).then(
      (response) => {
        if (!response.ok()) cleanupFailure = new Error(`Chat fixture cleanup failed (${response.status()})`);
      },
      (error) => {
        cleanupFailure = error;
      },
    );
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
