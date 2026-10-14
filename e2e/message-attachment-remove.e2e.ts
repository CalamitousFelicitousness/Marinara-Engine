import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const textFile = (name: string) => ({
  type: "text/plain",
  data: `data:text/plain;base64,${Buffer.from(name).toString("base64")}`,
  filename: name,
  name,
});

async function attachmentNames(request: APIRequestContext, chatId: string, messageId: string) {
  const response = await request.get(`/api/chats/${chatId}/messages`);
  expect(response.ok()).toBeTruthy();
  const message = ((await response.json()) as Array<{ id: string; extra: unknown }>).find(
    (entry) => entry.id === messageId,
  );
  const extra = typeof message?.extra === "string" ? JSON.parse(message.extra) : message?.extra;
  return ((extra?.attachments ?? []) as Array<{ name?: string }>).map((attachment) => attachment.name);
}

for (const mode of ["conversation", "roleplay"] as const) {
  test(`${mode} removes one attachment and keeps one saved after the page loaded`, async ({ page, request }) => {
    const chatResponse = await request.post("/api/chats", {
      data: { name: `Attachment removal ${mode}`, mode, characterIds: [] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chatId = ((await chatResponse.json()) as { id: string }).id;
    const messageResponse = await request.post(`/api/chats/${chatId}/messages`, {
      data: {
        role: "user",
        content: "Two files here.",
        extra: { attachments: [textFile("keep.txt"), textFile("drop.txt")] },
      },
    });
    expect(messageResponse.ok()).toBeTruthy();
    const messageId = ((await messageResponse.json()) as { id: string }).id;

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chatId, version },
    );
    await page.goto("/");
    const chip = (name: string) => page.getByText(name, { exact: true }).locator("..");
    await expect(chip("drop.txt")).toBeVisible();

    // Saved behind the page's back, as an illustration finishing after the last refetch would be.
    const unseen = await request.post(`/api/chats/${chatId}/messages/${messageId}/attachments`, {
      data: { attachments: [textFile("unseen.txt")] },
    });
    expect(unseen.ok()).toBeTruthy();

    await chip("drop.txt").hover();
    await chip("drop.txt")
      .getByRole("button", { name: /Remove (file )?from message/ })
      .click();
    await expect.poll(() => attachmentNames(request, chatId, messageId)).toEqual(["keep.txt", "unseen.txt"]);
    await expect(chip("unseen.txt")).toBeVisible();
    await expect(page.getByText("drop.txt", { exact: true })).toHaveCount(0);
  });
}
