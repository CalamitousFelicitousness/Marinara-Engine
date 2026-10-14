import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// A Game turn is stored with its macros filled in, as a Roleplay or Conversation send is (#7585).
// Left raw, the Game log rolled {{random}} with one seed and the model's prompt with another.
test("a Game turn stores its macros resolved, and the log and the model read that text", async ({ page, request }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const prompts: string[][] = [];
  const provider = createServer(async (incoming, response) => {
    if (incoming.method !== "POST") {
      incoming.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    prompts.push((body.messages ?? []).map((message: { content?: unknown }) => String(message.content ?? "")));
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The gate creaks open." }, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const cleanup: string[] = [];
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Game fixture did not bind");
    const create = async (path: string, data: unknown) => {
      const response = await request.post(path, { data });
      expect(response.ok(), await response.text()).toBeTruthy();
      const value = await response.json();
      cleanup.unshift(`${path}/${value.id}`);
      return value as { id: string };
    };
    const connection = await create("/api/connections", {
      name: "Game macro fixture",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "synthetic-test-key",
      model: "game-macro-fixture",
      maxContext: 32768,
      treatAsLocalEndpoint: true,
    });
    const persona = await create("/api/characters/personas", { name: "Pat Persona" });
    const chat = await create("/api/chats", {
      name: "Game turn macros",
      mode: "game",
      characterIds: [],
      connectionId: connection.id,
      personaId: persona.id,
    });
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
      },
    });
    expect(metadata.ok(), await metadata.text()).toBeTruthy();
    const opening = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "A gate blocks the path." },
    });
    expect(opening.ok(), await opening.text()).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    // Hold the persona list, as on a slow first load: the turn must wait for it, not store "User" for {{user}}.
    let releasePersonas = () => {};
    const personasHeld = new Promise<void>((resolve) => (releasePersonas = resolve));
    await page.route("**/api/characters/personas/list", async (route) => {
      await personasHeld;
      await route.continue();
    });
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
      debugMode: false,
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );
    await page.goto("/");
    const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(narration).toContainText("A gate blocks the path.");
    await page
      .getByPlaceholder("What do you do?", { exact: true })
      .fill("I shout {{random::red::green}}, I am {{user}}.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    releasePersonas();

    const storedTurn = async () =>
      ((await (await request.get(`/api/chats/${chat.id}/messages`)).json()) as Array<{ role: string; content: string }>)
        .filter((message) => message.role === "user")
        .map((message) => message.content);
    await expect.poll(storedTurn).toEqual([expect.stringMatching(/^I shout (red|green), I am Pat Persona\.$/u)]);
    const [turn] = await storedTurn();
    await expect.poll(() => prompts.length).toBeGreaterThan(0);
    expect(prompts[0]!.some((content) => content.includes(turn!))).toBe(true);
    expect(prompts[0]!.join("\n")).not.toContain("{{random");

    await expect(narration).toContainText(/The gate creaks open\.|I shout/u);
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    const logs = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Session Logs" }) });
    await expect(logs).toContainText(turn!);
  } finally {
    for (const path of cleanup) await request.delete(path);
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
