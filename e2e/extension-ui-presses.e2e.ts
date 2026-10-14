// Browser extensions such as Grammarly show their suggestion cards in their own elements outside the app:
// a custom element with a shadow root, added to <body> or <html>. Accepting a suggestion there is a press
// outside every chat window, and it used to close Chat Settings, taking the expanded Chat Summary editor
// and the unsaved edit with it. Presses, focus and keys in such extension UI now leave our windows alone.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createChatSummaryEntry, type ChatSummaryEntry } from "@marinara-engine/shared";
import { seedUIState } from "./ui-state-fixture.js";
import { chatSettingsWindow, openChatSettingsTool } from "./chat-settings-tools.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function openSummaryChat(page: Page, request: APIRequestContext, entry: ChatSummaryEntry) {
  const created = await request.post("/api/chats", { data: { name: "Extension suggestions", mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  expect((await request.patch(`/api/chats/${id}/metadata`, { data: { summaryEntries: [entry] } })).ok()).toBeTruthy();
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
    { id, version },
  );
  await page.goto("/");
  return id;
}

/**
 * Adds a suggestion card the way a grammar extension does, under <body> or <html>, and returns its accept
 * button. Accepting puts the fix for the first "teh" into the expanded editor, as the extension would.
 */
async function addExtensionCard(page: Page, parent: "body" | "html") {
  await page.evaluate((parent) => {
    document.querySelector("grammarly-popups")?.remove();
    const host = document.createElement("grammarly-popups");
    host.style.cssText = "position: fixed; left: 1rem; bottom: 1rem; z-index: 2147483647; display: block;";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accept suggestion";
    accept.addEventListener("click", () => {
      const field = document.querySelector<HTMLTextAreaElement>('[data-component="ExpandedMacroEditor"] textarea');
      const start = field?.value.indexOf("teh") ?? -1;
      if (!field || start < 0) return;
      field.focus();
      field.setSelectionRange(start, start + 3);
      document.execCommand("insertText", false, "the");
    });
    host.attachShadow({ mode: "open" }).append(accept);
    (parent === "html" ? document.documentElement : document.body).append(host);
  }, parent);
  return page.locator("grammarly-popups").getByRole("button", { name: "Accept suggestion", exact: true });
}

test("accepting a browser extension's suggestion keeps the expanded summary editor and its edit", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Grammar extensions show their suggestion cards on a computer.");
  const entry = createChatSummaryEntry({
    id: "extension-memory",
    title: "Extension memory",
    content: "Mari found teh key and opened teh door.",
    enabled: true,
    rangeStartIndex: 0,
    rangeEndIndex: 0,
  });
  const id = await openSummaryChat(page, request, entry);
  try {
    const panel = await openChatSettingsTool(page, "chat-summary");
    const settings = chatSettingsWindow(page);
    const row = panel.locator(`[data-summary-entry-id="${entry.id}"]`);
    await row.getByRole("button", { name: "Edit summary entry", exact: true }).click();
    await row.getByRole("button", { name: "Expand editor", exact: true }).click();
    const editor = page.locator('[data-component="ExpandedMacroEditor"]');
    const field = editor.getByRole("textbox");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(entry.content);

    // Accepting the suggestion is a real press on the card, outside Chat Settings.
    const acceptInBody = await addExtensionCard(page, "body");
    await acceptInBody.click();
    await expect(field).toHaveValue("Mari found the key and opened teh door.");
    await expect(editor).toBeVisible();
    await expect(settings).toBeVisible();

    // The card takes focus, the browser window loses it to a desktop app, Escape goes to the card:
    // none of them is the user leaving the editor.
    await acceptInBody.focus();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(settings).toBeVisible();

    const acceptInHtml = await addExtensionCard(page, "html");
    await acceptInHtml.click();
    await expect(field).toHaveValue("Mari found the key and opened the door.");
    await expect(editor).toBeVisible();
    await expect(settings).toBeVisible();

    // Escape in the editor itself still closes it, and the edit is kept.
    await field.press("Escape");
    await expect(editor).toHaveCount(0);
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/chats/${id}`)).json()).metadata.summaryEntries as ChatSummaryEntry[])[0]
            ?.content,
      )
      .toBe("Mari found the key and opened the door.");

    // A press on the chat itself still closes Chat Settings, as before.
    await page.evaluate(() => document.querySelector("grammarly-popups")?.remove());
    await page.locator("[data-chat-scroll]").click({ position: { x: 40, y: 200 } });
    await expect(settings).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
  }
});
