import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2jX8AAAAASUVORK5CYII=",
  "base64",
);

test("reference uploads, captions, removal and wardrobe keyword preserve entry text", async ({
  page,
  request,
}, info) => {
  const book = await (await request.post("/api/lorebooks", { data: { name: "Wardrobe image editor" } })).json();
  const entry = await (
    await request.post(`/api/lorebooks/${book.id}/entries`, {
      data: { name: "Blue coat", content: "Original coat description" },
    })
  ).json();
  let releaseUpload = () => {};
  const errors: string[] = [];
  const browserDiagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserDiagnostics.push(message.text());
  });
  page.on("requestfailed", (request) => browserDiagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => errors.push(error.message));
  const readEntry = async () => await (await request.get(`/api/lorebooks/${book.id}/entries/${entry.id}`)).json();
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: info.project.name.includes("mobile") ? "dark" : "light",
    });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    await page.goto("/");
    await page.evaluate(async (id) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      useUIStore.getState().openLorebookDetail(id);
    }, book.id);
    const row = page.locator(`[data-lorebook-entry-row-id="${entry.id}"]`);
    await row.getByRole("button", { name: "Expand entry", exact: true }).click();
    const references = row.getByRole("region", { name: "Reference images" });
    await references.scrollIntoViewIfNeeded();
    const disclosure = references.getByRole("button", { name: /^Reference images/ });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeHidden();
    await page.screenshot({ path: info.outputPath("references-collapsed-empty.png") });
    await disclosure.focus();
    await disclosure.press("Space");
    await page.screenshot({ path: info.outputPath("references-empty.png") });
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    await page.route(`**/api/lorebooks/${book.id}/entries/${entry.id}/images`, async (route) => {
      await gate;
      await route.continue();
    });
    await references.locator('input[type="file"]').setInputFiles([
      { name: "coat.png", mimeType: "image/png", buffer: png },
      { name: "boots.png", mimeType: "image/png", buffer: png },
    ]);
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("references-loading.png") });
    releaseUpload();
    await expect(references.getByRole("img")).toHaveCount(2);
    await expect.poll(async () => (await readEntry()).images.length).toBe(2);
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Blue velvet coat with silver buttons");
    await expect(disclosure).toHaveText(/Reference images.*\(2\)/);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await readEntry()).images[0].caption).toBe("Blue velvet coat with silver buttons");
    await page.screenshot({ path: info.outputPath("references-collapsed-populated.png") });
    await disclosure.click();
    await expect(references.getByRole("textbox", { name: "Caption" }).first()).toHaveValue(
      "Blue velvet coat with silver buttons",
    );
    // A caption blur must not swallow the immediately following action.
    await references.getByRole("button", { name: "Add wardrobe key" }).click();
    await expect.poll(async () => (await readEntry()).keys).toContain("wardrobe");
    await expect.poll(async () => (await readEntry()).images[0].caption).toBe("Blue velvet coat with silver buttons");
    expect((await readEntry()).content).toBe("Original coat description");
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Pending caption copied immediately");
    await row.getByRole("button", { name: "Duplicate entry", exact: true }).click();
    await expect
      .poll(async () => {
        const entries = await (await request.get(`/api/lorebooks/${book.id}/entries`)).json();
        return entries.find((candidate: { id: string }) => candidate.id !== entry.id)?.images[0]?.caption;
      })
      .toBe("Pending caption copied immediately");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(async (theme) => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().setTheme(theme);
      }, theme);
      for (const width of info.project.name.includes("desktop") ? [1440, 768, 390] : [390]) {
        await page.setViewportSize({ width, height: 900 });
        await references.scrollIntoViewIfNeeded();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true);
        await page.screenshot({ path: info.outputPath(`references-${theme}-${width}.png`) });
        await disclosure.click();
        await expect(references.getByRole("img")).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`references-collapsed-${theme}-${width}.png`) });
        await disclosure.click();
      }
    }
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Saved while removing boots");
    await references.getByRole("button", { name: "Remove image" }).last().click();
    await expect(references.getByRole("img")).toHaveCount(1);
    await expect.poll(async () => (await readEntry()).images[0].caption).toBe("Saved while removing boots");
    await references
      .locator('input[type="file"]')
      .setInputFiles({ name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(references.getByRole("alert")).toBeVisible();
    await page.screenshot({ path: info.outputPath("references-invalid-file.png") });
    expect((await readEntry()).images).toHaveLength(1);
    await references
      .locator('input[type="file"]')
      .setInputFiles(
        [1, 2, 3].map((number) => ({ name: `reference-${number}.png`, mimeType: "image/png", buffer: png })),
      );
    await expect(references.getByRole("img")).toHaveCount(4);
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("references-limit.png") });
    expect(errors).toEqual([]);
  } finally {
    releaseUpload();
    await info.attach("browser-diagnostics", {
      body: JSON.stringify(browserDiagnostics),
      contentType: "application/json",
    });
    await page.close();
    await request.delete(`/api/lorebooks/${book.id}`);
  }
});

test("activated wardrobe references reach the provider and unsupported models retry with text", async ({
  request,
}, info) => {
  test.skip(!info.project.name.includes("desktop"), "Provider integration uses one isolated desktop fixture.");
  const requests: Array<{ messages: Array<{ content: unknown }> }> = [];
  let rejectImages = false;
  const provider = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      if (rejectImages && JSON.stringify(body.messages).includes("image_url")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "This model does not support image inputs" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The coat is blue." }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture did not bind");
  let bookId = "",
    characterId = "",
    chatId = "",
    connectionId = "",
    fallbackConnectionId = "";
  try {
    const connection = await (
      await request.post("/api/connections", {
        data: {
          name: "Lorebook vision fixture",
          provider: "custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          model: "fixture",
          maxContext: 32768,
        },
      })
    ).json();
    connectionId = connection.id;
    const character = await (
      await request.post("/api/characters", { data: { data: { name: "Tailor", description: "Describe clothes." } } })
    ).json();
    characterId = character.id;
    const book = await (await request.post("/api/lorebooks", { data: { name: "Wardrobe", tokenBudget: 2048 } })).json();
    bookId = book.id;
    const entry = await (
      await request.post(`/api/lorebooks/${bookId}/entries`, {
        data: { name: "Coat", content: "WARDROBE_TEXT: blue velvet coat", keys: ["wardrobe"] },
      })
    ).json();
    const upload = await request.post(`/api/lorebooks/${bookId}/entries/${entry.id}/images`, {
      multipart: { file: { name: "coat.png", mimeType: "image/png", buffer: png } },
    });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    const images = (await upload.json()).images;
    await request.patch(`/api/lorebooks/${bookId}/entries/${entry.id}`, {
      data: { images: [{ ...images[0], caption: "Silver buttons" }] },
    });
    const chat = await (
      await request.post("/api/chats", {
        data: { name: "Vision wardrobe", mode: "roleplay", characterIds: [characterId], connectionId },
      })
    ).json();
    chatId = chat.id;
    await request.patch(`/api/chats/${chatId}/metadata`, {
      data: { activeLorebookIds: [bookId], enableAgents: false },
    });
    await request.post(`/api/chats/${chatId}/messages`, { data: { role: "user", content: "Inspect my wardrobe" } });
    const dry = await request.post("/api/generate/dryRun", {
      data: { chatId, returnPrompt: true, injectLorebook: true },
    });
    expect(dry.ok(), await dry.text()).toBeTruthy();
    const prompt = (await dry.json()).prompt.messages;
    expect(JSON.stringify(prompt)).toContain("WARDROBE_TEXT");
    expect(prompt.flatMap((m: { images?: string[] }) => m.images ?? [])).toEqual([
      `data:image/png;base64,${png.toString("base64")}`,
    ]);
    const generated = await request.post("/api/generate", { data: { chatId } });
    expect(generated.ok(), await generated.text()).toBeTruthy();
    expect(await generated.text()).not.toContain('"type":"error"');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("image_url");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("WARDROBE_TEXT");
    const backupConnection = await (
      await request.post("/api/connections", {
        data: {
          name: "Fallback must not replace chosen text-only model",
          provider: "custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          model: "fallback-fixture",
          fallbackForMain: true,
        },
      })
    ).json();
    fallbackConnectionId = backupConnection.id;
    rejectImages = true;
    const before = requests.length;
    const fallback = await request.post("/api/generate", { data: { chatId } });
    const events = await fallback.text();
    expect(events).toContain("lorebook_image_notice");
    expect(events).toContain("unsupported");
    expect(events).not.toContain('"type":"error"');
    expect(events).not.toContain('"type":"generation_fallback"');
    expect(requests.length - before).toBe(2);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("image_url");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Silver buttons");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("WARDROBE_TEXT");
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`);
    if (bookId) await request.delete(`/api/lorebooks/${bookId}`);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
    if (fallbackConnectionId) await request.delete(`/api/connections/${fallbackConnectionId}`);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`);
    await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
  }
});
