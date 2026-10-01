import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { WORLD_GENERATOR_VERSION, WORLD_STARTER_KITS, compileGameWorld, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/** A local model that answers by what the player just said, and keeps every prompt it was sent. */
async function fakeModel(
  replies: Array<[said: string, reply: string]>,
): Promise<{ server: Server; baseUrl: string; prompts: string[] }> {
  const prompts: string[] = [];
  const server = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    if (incoming.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    prompts.push(body);
    let last = body;
    try {
      const messages = (JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
      const said = [...messages].reverse().find((message) => message.role === "user")?.content;
      last = typeof said === "string" ? said : JSON.stringify(said ?? "");
    } catch {
      // Not a chat request: answer from the whole body.
    }
    const reply = replies.find(([said]) => last.includes(said))?.[1] ?? "The road is quiet.";
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const write = (delta: unknown, finishReason: string | null = null) =>
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    write({ content: reply });
    write({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The model fixture did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, prompts };
}

const parsedKit = parseWorldKit(WORLD_STARTER_KITS[0]!);
if (!parsedKit.ok) throw new Error("The high fantasy kit does not read");
const kit = parsedKit.kit;
const brief = {
  briefVersion: 1 as const,
  premise: "The old king is dying and the river provinces quarrel over the succession.",
  places: [
    { name: "Aldmark", layer: "realm", tags: [] },
    { name: "The Fenlands", layer: "province", parent: "Aldmark", tags: [] },
    { name: "Hollin", layer: "settlement", parent: "The Fenlands", size: "village", tags: [], start: true as const },
    {
      name: "Thornmere",
      layer: "settlement",
      parent: "The Fenlands",
      size: "city",
      tags: ["port"],
      note: "A river port of tall houses.",
    },
  ],
  placeNames: [{ culture: kit.cultures[0]!.id, names: ["Ashby", "Wending", "Calder", "Ravel", "Brennock", "Sallow"] }],
};
const gameWorld = { seed: 20261001, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand" as const, brief };

test("the Game Master is told where the party is in its world, and a place it names takes the world's size", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const world = compileGameWorld({ kit, seed: gameWorld.seed, grounding: "expand", brief });
  const thornmere = world.places.find((place) => place.name === "Thornmere")!;
  const neighbour = world.links.find((link) => link.from === thornmere.id || link.to === thornmere.id)!;
  const neighbourName = world.places.find(
    (place) => place.id === (neighbour.from === thornmere.id ? neighbour.to : neighbour.from),
  )!.name;
  const model = await fakeModel([
    // The Game Master writes the wrong size: the world's own wins.
    ["I take the boat to Thornmere.", 'The boat noses into Thornmere. [place: name="thornmere" size="hamlet"]'],
    ["I look around the docks.", "Gulls wheel over the tall houses."],
  ]);
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local world fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "world-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    expect(connection.ok()).toBeTruthy();
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "World", mode: "game", characterIds: [], connectionId },
    });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `world-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld,
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chatId}/messages`, {
          data: { role: "assistant", content: "Mist lies on the reeds around Hollin." },
        })
      ).ok(),
    ).toBeTruthy();
    await openGame(page, chatId);
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "Mist lies on the reeds around Hollin.",
      { timeout: 30_000 },
    );

    // Before the Game Master has said where, the party is where the world starts it.
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I take the boat to Thornmere.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "The boat noses into Thornmere.",
      { timeout: 30_000 },
    );
    const first = model.prompts.find((body) => body.includes("I take the boat to Thornmere."))!;
    expect(first).toContain("<world_places>");
    expect(first).toContain("- Now: The old king is dying and the river provinces quarrel over the succession.");
    expect(first).toContain("<where_you_are>\\nThe party is in Hollin (village, ");
    const saved = (await (await request.get(`/api/chats/${chatId}/messages`)).json()) as Array<{
      role: string;
      content: string;
    }>;
    expect(saved.filter((message) => message.role === "assistant").at(-1)!.content).toContain(
      '[place: name="Thornmere" size="city" result="ok"]',
    );

    // The next turn: the party is where the Game Master said, and can see where it can go.
    const before = model.prompts.length;
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I look around the docks.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "Gulls wheel over the tall houses.",
      { timeout: 30_000 },
    );
    const second = model.prompts.slice(before).find((body) => body.includes("I look around the docks."))!;
    expect(second).toContain("<where_you_are>\\nThe party is in Thornmere (city, ");
    expect(second).toContain("The Fenlands (province), Aldmark (realm).");
    expect(second).toContain("- Known for: port.");
    expect(second).toContain("- A river port of tall houses.");
    expect(second).toContain(`- From here: `);
    expect(second).toContain(`${neighbourName} (`);
    await page.screenshot({ path: testInfo.outputPath("world-turn.png") });
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
