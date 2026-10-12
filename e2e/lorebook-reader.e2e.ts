// #7464: the Lorebook Reader reads a chat's lorebook entries from the chat tools (a bubble on a computer,
// the Chat tools menu on a phone): grouped entries, OFF marks, Markdown with macros as names, Back to the
// same scroll position, search on the displayed text, and pins saved with the chat without bumping it.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { openChatTool } from "./chat-settings-tools.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const READER = "control:lorebook-reader";

async function chatState(request: APIRequestContext, id: string) {
  const chat = await (await request.get(`/api/chats/${id}`)).json();
  const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
  return { updatedAt: chat.updatedAt as string, metadata: metadata as Record<string, unknown> };
}

for (const mode of ["roleplay", "conversation"] as const) {
  test(`${mode}: the Lorebook Reader lists, opens, searches and pins entries`, async ({ page, request }, testInfo) => {
    const created: Array<() => Promise<unknown>> = [];
    const post = async (url: string, data: unknown) => {
      const response = await request.post(url, { data });
      expect(response.ok(), url).toBeTruthy();
      return response.json();
    };
    try {
      const character = await post("/api/characters", { data: { name: "Mira", first_mes: "" } });
      created.push(() => request.delete(`/api/characters/${character.id}`));
      const persona = await post("/api/characters/personas", { name: "Jem" });
      created.push(() => request.delete(`/api/characters/personas/${persona.id}`));
      const chat = await post("/api/chats", {
        name: "Lorebook Reader",
        mode,
        characterIds: [character.id],
        personaId: persona.id,
      });
      created.push(() => request.delete(`/api/chats/${chat.id}?force=true`));
      const book = await post("/api/lorebooks", { name: "Campus Notes" });
      created.push(() => request.delete(`/api/lorebooks/${book.id}`));
      const schedule = await post(`/api/lorebooks/${book.id}/entries`, {
        name: "Class schedule",
        content: "## Fall semester\n{{user}} has **History** with {{char}}.",
        order: 0,
      });
      const rumor = await post(`/api/lorebooks/${book.id}/entries`, {
        name: "Old rumor",
        content: "Nobody remembers.",
        enabled: false,
        order: 1,
      });
      const notes = [];
      for (let index = 1; index <= 24; index++) {
        notes.push(
          await post(`/api/lorebooks/${book.id}/entries`, { name: `Note ${index}`, content: "", order: index + 1 }),
        );
      }
      expect(
        (await request.patch(`/api/chats/${chat.id}/metadata`, { data: { activeLorebookIds: [book.id] } })).ok(),
      ).toBeTruthy();
      await post(`/api/chats/${chat.id}/messages`, { role: "assistant", content: "Welcome back." });

      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: [mode],
      });
      await page.addInitScript(
        ({ id, version }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { id: chat.id, version },
      );
      await page.goto("/");
      // A cold first load can land on Home before restoring the chat; open it directly.
      await page.evaluate(async (id) => {
        const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
        if (useChatStore.getState().activeChatId !== id) useChatStore.getState().setActiveChatId(id);
      }, chat.id);

      const reader = await openChatTool(page, READER);
      const row = (id: string) => reader.locator(`[data-lorebook-reader-entry="${id}"]`);
      await expect(reader.getByRole("region", { name: "Campus Notes" })).toBeVisible();
      await expect(row(schedule.id)).toHaveText(/Class schedule/);
      await expect(row(rumor.id)).toHaveAttribute("data-off", "true");
      await expect(row(rumor.id)).toContainText("OFF");

      // An entry renders as Markdown, with macros shown as the chat's names.
      await row(schedule.id).click();
      await expect(reader.getByRole("heading", { name: "Fall semester" })).toBeVisible();
      await expect(reader.locator(".mari-message-content")).toContainText("Jem has History with Mira.");
      await expect(reader.locator(".mari-message-content")).not.toContainText("{{");
      await reader.screenshot({ path: testInfo.outputPath(`lorebook-reader-${mode}-entry.png`) });

      // Pinning saves with the chat as a view preference: the chat's recency stays put.
      const before = await chatState(request, chat.id);
      await reader.getByRole("button", { name: "Pin entry", exact: true }).click();
      await expect
        .poll(async () => (await chatState(request, chat.id)).metadata.lorebookPinnedEntryIds)
        .toEqual([schedule.id]);
      expect((await chatState(request, chat.id)).updatedAt).toBe(before.updatedAt);
      await expect(reader.getByRole("button", { name: "Unpin entry", exact: true })).toBeVisible();
      await reader.getByRole("button", { name: "Back to entries", exact: true }).click();
      await expect(reader.getByRole("region", { name: "Pinned" }).locator(`[data-lorebook-reader-entry]`)).toHaveText([
        /Class schedule/,
      ]);
      await reader.screenshot({ path: testInfo.outputPath(`lorebook-reader-${mode}-list.png`) });

      // Search matches the text as shown (Jem), not the raw macro.
      const search = reader.getByRole("searchbox", { name: "Search entries" });
      await search.fill("jem");
      await expect(reader.locator("[data-lorebook-reader-entry]")).toHaveCount(1);
      await search.fill("{{user}}");
      await expect(reader.getByText("No entries match your search.")).toBeVisible();
      await search.fill("");

      // Back returns to the same place in a long list.
      const last = row(notes.at(-1).id);
      await last.scrollIntoViewIfNeeded();
      const list = reader.locator('[data-lorebook-reader="list"] > div').last();
      const scrolled = await list.evaluate((element) => element.scrollTop);
      expect(scrolled).toBeGreaterThan(0);
      await last.click();
      await reader.getByRole("button", { name: "Back to entries", exact: true }).click();
      await expect(last).toBeFocused();
      expect(await list.evaluate((element) => element.scrollTop)).toBe(scrolled);
    } finally {
      for (const remove of created.reverse()) await remove().catch(() => undefined);
    }
  });
}
