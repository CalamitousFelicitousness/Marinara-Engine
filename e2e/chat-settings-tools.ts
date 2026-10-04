// Chat Branches, Chat Summary, Active Context, Author's Notes, Agent activity and Gallery are Chat Settings
// drawers, and Search messages sits under Profile setup (#7034). These helpers reach them on desktop
// (topbar button, movable window) and on phones (the chat's menu, a sheet).
import { expect, type Locator, type Page } from "@playwright/test";

export type ChatSettingsTool =
  "chat-branches" | "chat-summary" | "active-context" | "author-notes" | "agent-activity" | "gallery";

export function chatSettingsWindow(page: Page) {
  return page.locator('[data-window="chat-settings"]');
}

/** Opens Chat Settings for the open chat, or returns it when it is already open. */
export async function openChatSettings(page: Page): Promise<Locator> {
  const settings = chatSettingsWindow(page);
  if (await settings.isVisible()) return settings;
  const topbar = page.locator('[data-component="TopBar"]').getByRole("button", { name: "Chat Settings", exact: true });
  // Wide screens open it from the topbar; phones from the chat's own menu.
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await topbar.click();
  } else {
    const settingsButton = page.locator('[data-chat-toolbar-panel-action="settings"]').filter({ visible: true });
    if ((await settingsButton.count()) === 0) {
      await page
        .getByRole("button", { name: /^(More options|Game actions)$/u })
        .filter({ visible: true })
        .first()
        .click();
    }
    await settingsButton.first().click();
  }
  await expect(settings.locator("[data-chat-settings-section]").first()).toBeVisible();
  return settings;
}

async function expand(drawer: Locator) {
  const header = drawer.locator(":scope > .mari-drawer__header");
  await expect(header).toBeVisible();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

/** The drawer for a chat tool in Chat Settings (its id starts with the chat mode). */
export function chatSettingsDrawer(page: Page, tool: ChatSettingsTool | "agents") {
  return chatSettingsWindow(page).locator(`[data-drawer$="-${tool}"]`).first();
}

/** Opens Chat Settings, expands a chat tool's drawer and returns it. */
export async function openChatSettingsTool(page: Page, tool: ChatSettingsTool): Promise<Locator> {
  await openChatSettings(page);
  // Agent activity is a section inside the Agents drawer.
  if (tool === "agent-activity") await expand(chatSettingsDrawer(page, "agents"));
  const drawer = chatSettingsDrawer(page, tool);
  await drawer.scrollIntoViewIfNeeded();
  await expand(drawer);
  return drawer;
}

/** The inline Search messages control under Profile setup. */
export async function openChatMessageSearch(page: Page): Promise<Locator> {
  const settings = await openChatSettings(page);
  const search = settings.locator("[data-chat-message-search]");
  await expect(search).toBeVisible();
  return search;
}

/** Closes Chat Settings with its own close control (a pinned window closes too). */
export async function closeChatSettings(page: Page) {
  const settings = chatSettingsWindow(page);
  if (!(await settings.isVisible())) return;
  await settings.locator('[data-window-control="close"]').click();
  await expect(settings).toHaveCount(0);
}
