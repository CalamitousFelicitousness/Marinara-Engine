import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { WORLD_STARTER_KITS, parseWorldKit } from "@marinara-engine/shared";
import { inventoryButton } from "./game-inventory-fixture.js";
import { openGame, savedInventory, withImports } from "./game-ruleset-fight-fixture.js";

/**
 * Markets (#6917), on a real turn. The Game Master says the party is in a market town and buys there:
 * the Engine prices a dear coat and a bed at the watch-house (a service), pays for both out of the
 * purse with change, puts the coat in the bag, refuses a pistol only a city sells, and shows a
 * notification for each purchase. The next turn's prompt carries the MARKET block for that town.
 */

function gravewatch(id: string): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"));
  doc.id = id;
  return JSON.stringify(doc);
}

/** A local model that answers by what the player just said, and keeps every prompt it was sent. No
 *  paid provider is called. */
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
    // Only what the player said last: a later prompt carries the whole history before it.
    let last = body;
    try {
      const messages = (JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
      const said = [...messages].reverse().find((message) => message.role === "user")?.content;
      last = typeof said === "string" ? said : JSON.stringify(said ?? "");
    } catch {
      // Not a chat request: answer from the whole body.
    }
    const reply = replies.find(([said]) => last.includes(said))?.[1] ?? "The night is quiet.";
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

test("the Game Master buys at a market town: priced, paid with change, a service only paid, a city's pistol refused", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const model = await fakeModel([
    [
      "I buy a coat and a bed.",
      'We reach Barrowmere. [place: name="Barrowmere" size="market town"] The chandler drives a hard bargain. ' +
        '[inventory: action="buy" item="Lantern-keeper\'s coat" level="dear"] ' +
        '[inventory: action="buy" item="A bed at the watch-house"] ' +
        '[inventory: action="buy" item="Watch pistol"]',
    ],
    ["I look around the square.", "Stalls and lanterns crowd the square."],
  ]);
  let connectionId = "";
  try {
    await withImports(request, async (cleanup) => {
      const imported = await request.post("/api/game-rulesets/import", {
        data: { definition: gravewatch("gravewatch-markets-e2e") },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      const connection = await request.post("/api/connections", {
        data: {
          name: "Local market fixture",
          provider: "custom",
          baseUrl: model.baseUrl,
          apiKey: "synthetic-test-key",
          model: "market-fixture",
          maxContext: 32768,
          treatAsLocalEndpoint: true,
        },
      });
      expect(connection.ok()).toBeTruthy();
      connectionId = (await connection.json()).id;
      const created = await request.post("/api/chats", {
        data: { name: "Markets", mode: "game", characterIds: [], connectionId },
      });
      expect(created.ok()).toBeTruthy();
      const chatId = ((await created.json()) as { id: string }).id;
      cleanup.push({ chatId, rulesetId, anchor: "" });
      const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameId: `markets-${chatId}`,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameImageAutoGenerationEnabled: false,
          enableAgents: false,
          enableTools: false,
          gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
          gameInventory: [{ id: "st-crowns", name: "crowns", item: "coin:crown", quantity: 3 }],
        },
      });
      expect(meta.ok(), await meta.text()).toBeTruthy();
      expect(
        (
          await request.post(`/api/chats/${chatId}/messages`, {
            data: { role: "assistant", content: "The road bends toward the lights of a town." },
          })
        ).ok(),
      ).toBeTruthy();
      await openGame(page, chatId);
      await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
        "The road bends toward the lights of a town.",
        { timeout: 30_000 },
      );

      await page.getByPlaceholder("What do you do?", { exact: true }).fill("I buy a coat and a bed.");
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      await expect(page.getByText(/^You bought Lantern-keeper's coat for 12 shillings\.$/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/^You bought A bed at the watch-house for 6 pennies\.$/)).toBeVisible();
      await expect(page.getByText(/bought Watch pistol/)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("market-bought.png") });
      // Two crowns and a third broken for the coat, 3 shillings back; a shilling broken for the bed,
      // 6 pennies back. The coat is in the bag; the bed and the pistol are not.
      await expect
        .poll(async () =>
          (await savedInventory(request, chatId))
            .map((stack) => `${stack.name} <${stack.item ?? ""}> ${stack.quantity}`)
            .sort(),
        )
        .toEqual([
          "Lantern-keeper's coat <kit/lantern-coat> 1",
          "pennies <coin:penny> 6",
          "shillings <coin:shilling> 2",
        ]);
      const saved = await (await request.get(`/api/chats/${chatId}/messages`)).json();
      const reply = (saved as Array<{ role: string; content: string }>)
        .filter((message) => message.role === "assistant")
        .at(-1)!;
      expect(reply.content).toContain('[place: name="Barrowmere" size="town" result="ok"]');
      expect(reply.content).toContain('item="Watch pistol" count="1" result="refused" reason="not-here"');

      // The next turn: the place said last turn is still where the party is, and the Game Master
      // is shown what it sells.
      const before = model.prompts.length;
      await page.getByPlaceholder("What do you do?", { exact: true }).fill("I look around the square.");
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
        "Stalls and lanterns crowd the square.",
        { timeout: 30_000 },
      );
      const prompt = model.prompts.slice(before).find((body) => body.includes("I look around the square."));
      expect(prompt).toBeTruthy();
      expect(prompt).toContain("MARKET: Barrowmere, a market town. Prices at fair, the default level");
      expect(prompt).toContain("- smith: Grave spade 3 shillings, Silver coffin nail 2 crowns");

      // The picker never offers a service: a bed at the watch-house is bought, not carried.
      await inventoryButton(page).click();
      await page.getByRole("button", { name: "From the ruleset", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Add items from the ruleset" });
      await expect(picker.getByRole("checkbox", { name: "Lantern-keeper's coat", exact: true })).toBeVisible();
      await expect(picker.getByRole("checkbox", { name: "A bed at the watch-house", exact: true })).toHaveCount(0);
    });
  } finally {
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});

// Money and markets without a ruleset (worldgen W6b): the setting kit's money and shop, through the same
// buy, pay and earn the ruleset market uses.
test("a game with no ruleset buys, pays and earns in its setting kit's money", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "modern_day")!);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  const model = await fakeModel([
    [
      "I shop on Elm Street.",
      'We reach Elm Street. [place: name="Elm Street" size="town"] ' +
        '[inventory: action="buy" item="first-aid kit"] [inventory: action="buy" item="Bicycle"] ' +
        '[inventory: action="earn" amount="5 dollars"] [inventory: action="buy" item="A haircut"]',
    ],
    ["I look in the shop windows.", "Shop windows glow along the street."],
  ]);
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local kit market fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "kit-market-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "Kit market", mode: "game", characterIds: [], connectionId },
    });
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `kit-market-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: parsed.kit,
        gameInventory: [{ id: "st-dollars", name: "dollar", item: "coin:dollar", quantity: 60 }],
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "The bus drops you at the edge of town." },
    });
    await openGame(page, chatId);
    const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(narration).toContainText("The bus drops you at the edge of town.", { timeout: 30_000 });

    const first = model.prompts.length;
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I shop on Elm Street.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(narration).toContainText("We reach Elm Street.", { timeout: 30_000 });
    // The Game Master was taught the setting's money and how to buy.
    const taught = model.prompts.slice(first).find((body) => body.includes("I shop on Elm Street."))!;
    expect(taught).toContain("in the setting's money (");
    expect(taught).toContain('[inventory: action=\\"buy\\" item=\\"Name\\"');
    // 60 dollars, 25 for the kit, 30 for the haircut (a service, only paid), 5 earned; no bicycle.
    await expect
      .poll(async () =>
        (await savedInventory(request, chatId))
          .map((stack) => `${stack.name} <${stack.item ?? ""}> ${stack.quantity}`)
          .sort(),
      )
      .toEqual(["First-Aid Kit <shop/first-aid-kit> 1", "dollar <coin:dollar> 10"]);
    const reply = (
      (await (await request.get(`/api/chats/${chatId}/messages`)).json()) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === "assistant")
      .at(-1)!.content;
    expect(reply).toContain('item="First-Aid Kit" count="1" level="fair" result="ok"');
    expect(reply).toContain('price="25 dollar"');
    expect(reply).toContain('item="Bicycle" count="1" level="fair" result="refused" reason="cannot-afford"');
    expect(reply).toContain('item="A haircut" count="1" level="fair" result="ok"');

    // The next turn shows the Game Master what the town sells, in the setting's own money.
    const before = model.prompts.length;
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I look in the shop windows.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(narration).toContainText("Shop windows glow along the street.", { timeout: 30_000 });
    const prompt = model.prompts.slice(before).find((body) => body.includes("I look in the shop windows."))!;
    expect(prompt).toContain("MARKET: Elm Street, a town. Prices at fair, the default level");
    expect(prompt).toContain("First-Aid Kit 25 dollar");
    // The purse shows the setting's money.
    await inventoryButton(page).click();
    await expect(page.getByText("money: dollar x10 (worth 1000 cent)", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("kit-market.png") });
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
