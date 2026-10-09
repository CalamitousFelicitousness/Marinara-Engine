import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { openChatSettingsTool } from "./chat-settings-tools.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedChat(request: APIRequestContext, name: string, connectionId: string) {
  const response = await request.post("/api/chats", {
    data: { name, mode: "roleplay", characterIds: [], connectionId },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

async function openNotes(page: Page) {
  const drawer = await openChatSettingsTool(page, "author-notes");
  const input = drawer.getByRole("textbox", { name: "Author's Notes", exact: true });
  await expect(input).toBeVisible();
  return input;
}

/** The panel saves only on its Save button, next to the note box. */
function saveButton(notes: Locator) {
  return notes
    .locator("xpath=ancestor::*[.//button[normalize-space()='Save']][1]")
    .getByRole("button", { name: "Save", exact: true });
}

async function switchChat(page: Page, chatId: string) {
  await page.evaluate(async (id) => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    useChatStore.getState().setActiveChatId(id);
  }, chatId);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
        return useChatStore.getState().activeChat?.id;
      }),
    )
    .toBe(chatId);
}

async function readNotes(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
  const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
  return metadata.authorNotes ?? "";
}

async function readActivePresetIds(request: APIRequestContext, id: string): Promise<string[]> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
  const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
  return [...(metadata.activeAuthorNotePresetIds ?? [])].sort();
}

async function prepare(page: Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
  });
  await page.addInitScript(
    ({ id, version }) => {
      if (!localStorage.getItem("marinara-active-chat-id")) localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { id: chatId, version },
  );
  await page.goto("/");
}

test("Author's Notes saves stay ordered, remain per chat, and finish before generation", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90000);
  const connectionResponse = await request.post("/api/connections", {
    data: {
      name: "Author notes isolation",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture",
      model: "notes-fixture",
      maxContext: 32768,
    },
  });
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = await connectionResponse.json();
  const a = await seedChat(request, "Notes A", connection.id);
  const b = await seedChat(request, "Notes B", connection.id);
  const firstHeld = deferred();
  const releaseFirst = deferred();
  const secondHeld = deferred();
  const releaseSecond = deferred();
  let saves = 0;
  let generated = false;
  let notesAtGenerate: string | undefined;
  const latest = "ONLY_CHAT_A: keep the blue experiment secret.";
  try {
    await prepare(page, a);
    await page.route(`**/api/chats/${a}/metadata`, async (route) => {
      if (route.request().method() !== "PATCH" || !Object.hasOwn(route.request().postDataJSON(), "authorNotes")) {
        return route.continue();
      }
      saves += 1;
      if (saves === 1) {
        firstHeld.resolve();
        await releaseFirst.promise;
      }
      if (saves === 2) {
        secondHeld.resolve();
        await releaseSecond.promise;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    await page.route("**/api/generate", async (route) => {
      notesAtGenerate = await readNotes(request, a);
      await route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' });
      generated = true;
    });
    const notes = await openNotes(page);
    await notes.fill("OLDER_CHAT_A");
    await saveButton(notes).click();
    await firstHeld.promise;
    await notes.fill(latest);
    await expect(saveButton(notes), "A later note save must wait for the first request").toBeDisabled();
    expect(saves).toBe(1);
    releaseFirst.resolve();
    await saveButton(notes).click();
    await secondHeld.promise;
    // Closing Chat Settings waits for the held save. On desktop the composer sits beside the window; the
    // phone sheet covers it, so there the test closes the sheet straight away.
    if (testInfo.project.name.includes("mobile")) {
      await page.evaluate(async () => {
        const { useFloatingWindowStore } = await import("/src/stores/floating-window.store.ts" as string);
        useFloatingWindowStore.getState().closeWindow("chat-settings");
      });
    }
    await page.locator("textarea.mari-chat-input-textarea").fill("Continue the experiment.");
    await page.locator("button.mari-chat-send-btn").click();
    await page.waitForTimeout(300);
    expect(generated, "Generation must wait for pending notes").toBe(false);
    // The originating editor unmounts; a blank destination must not inherit its notes.
    await switchChat(page, b);
    const otherNotes = await openNotes(page);
    await expect(otherNotes).toHaveValue("");
    await otherNotes.fill("ONLY_CHAT_B: tell the red story.");
    await saveButton(otherNotes).click();
    await expect.poll(() => readNotes(request, b)).toBe("ONLY_CHAT_B: tell the red story.");
    releaseSecond.resolve();
    await expect.poll(() => generated).toBe(true);
    expect(notesAtGenerate, "Generation read storage before notes saved").toBe(latest);
    await expect.poll(() => readNotes(request, a)).toBe(latest);
    await switchChat(page, a);
    await expect(await openNotes(page)).toHaveValue(latest);
    await page.screenshot({ path: testInfo.outputPath("notes-a-saved.png"), animations: "disabled" });
    await page.reload();
    await expect(await openNotes(page)).toHaveValue(latest);
    for (const [id, own, other] of [
      [a, "ONLY_CHAT_A", "ONLY_CHAT_B"],
      [b, "ONLY_CHAT_B", "ONLY_CHAT_A"],
    ]) {
      const response = await request.post("/api/generate/dryRun", { data: { chatId: id, returnPrompt: true } });
      expect(response.ok(), await response.text()).toBeTruthy();
      const prompt = JSON.stringify((await response.json()).prompt.messages);
      expect(prompt).toContain(own);
      expect(prompt).not.toContain(other);
    }
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await request.delete(`/api/chats/${a}`);
    await request.delete(`/api/chats/${b}`);
    await request.delete(`/api/connections/${connection.id}`);
  }
});

test("Author's Notes preserves a newer draft when an earlier save fails", async ({ page, request }, testInfo) => {
  const chatId = await seedChat(request, "Notes failure", "fixture-connection");
  const held = deferred();
  const release = deferred();
  let failed = false;
  try {
    await prepare(page, chatId);
    await page.route(`**/api/chats/${chatId}/metadata`, async (route) => {
      if (!failed && route.request().method() === "PATCH") {
        failed = true;
        held.resolve();
        await release.promise;
        return route.fulfill({ status: 500, json: { error: "fixture save failure" } });
      }
      await route.continue();
    });
    const notes = await openNotes(page);
    await notes.fill("Earlier edit");
    await saveButton(notes).click();
    await held.promise;
    await notes.fill("Newer draft must survive");
    const rejected = page.waitForResponse(
      (response) => response.url().endsWith(`/chats/${chatId}/metadata`) && response.status() === 500,
    );
    release.resolve();
    await rejected;
    await page.waitForTimeout(300);
    await expect(notes).toHaveValue("Newer draft must survive");
    await page.screenshot({ path: testInfo.outputPath("notes-draft-after-failed-save.png"), animations: "disabled" });
    await saveButton(notes).click();
    await expect.poll(() => readNotes(request, chatId)).toBe("Newer draft must survive");
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await request.delete(`/api/chats/${chatId}`);
  }
});

test("Author's Notes preset sets replace a chat's presets and stay per chat", async ({ page, request }, testInfo) => {
  test.setTimeout(90000);
  const a = await seedChat(request, "Sets A", "fixture-connection");
  const b = await seedChat(request, "Sets B", "fixture-connection");
  const presetIds: string[] = [];
  const toggle = async (name: string) => {
    await page.getByRole("switch", { name: `Activate ${name}`, exact: true }).click();
    await expect(page.getByRole("switch", { name: `Deactivate ${name}`, exact: true })).toBeVisible();
  };
  // The notes are a Chat Settings drawer; closing the window unmounts them.
  const closeNotes = () =>
    page.evaluate(async () => {
      const { useFloatingWindowStore } = await import("/src/stores/floating-window.store.ts" as string);
      useFloatingWindowStore.getState().closeWindow("chat-settings");
    });
  try {
    for (const name of ["Sets Terse", "Sets Pacing", "Sets Banter"]) {
      const response = await request.post("/api/author-note-presets", {
        data: { name, content: `${name} note`, depth: 4 },
      });
      expect(response.ok()).toBeTruthy();
      presetIds.push(((await response.json()) as { id: string }).id);
    }
    const combatIds = [presetIds[0]!, presetIds[1]!].sort();
    await prepare(page, a);
    await openNotes(page);
    await toggle("Sets Terse");
    await toggle("Sets Pacing");
    await expect.poll(() => readActivePresetIds(request, a)).toEqual(combatIds);

    await page.getByRole("button", { name: "Save enabled presets as a set", exact: true }).click();
    await page.getByPlaceholder("Set name").fill("Sets Combat");
    await page.getByRole("button", { name: "Save set", exact: true }).click();
    const combat = page.getByRole("button", { name: "Enable only the presets in Sets Combat", exact: true });
    await expect(combat, "The set just saved matches the chat").toHaveAttribute("aria-pressed", "true");

    await toggle("Sets Banter");
    await expect(combat, "An extra preset breaks the match").toHaveAttribute("aria-pressed", "false");
    await combat.click();
    await expect(combat).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => readActivePresetIds(request, a), "Applying replaces, not adds").toEqual(combatIds);
    await page.screenshot({ path: testInfo.outputPath("notes-set-applied.png"), animations: "disabled" });

    await closeNotes();
    await switchChat(page, b);
    await openNotes(page);
    await expect(combat).toHaveAttribute("aria-pressed", "false");
    expect(await readActivePresetIds(request, b), "Another chat keeps its own presets").toEqual([]);
    await closeNotes();
    await switchChat(page, a);
    await openNotes(page);
    await expect(combat, "Coming back finds the chat as it was left").toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Manage sets", exact: true }).click();
    await page.getByRole("button", { name: "Change Sets Combat", exact: true }).click();
    await page.getByRole("button", { name: "Delete set", exact: true }).click();
    await expect(combat).toHaveCount(0);
    await expect.poll(async () => (await (await request.get("/api/author-note-presets/sets")).json()).length).toBe(0);
    expect(await readActivePresetIds(request, a), "Deleting a set leaves the chat's presets on").toEqual(combatIds);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await request.put("/api/author-note-presets/sets", { data: [] });
    for (const id of presetIds) await request.delete(`/api/author-note-presets/${id}`);
    await request.delete(`/api/chats/${a}`);
    await request.delete(`/api/chats/${b}`);
  }
});
