import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { inventoryButton } from "./game-inventory-fixture.js";
import { openGame, savedInventory, withImports } from "./game-ruleset-fight-fixture.js";

/**
 * Markets (#6917), on a real turn. The Game Master says the party is in a market town and buys there:
 * the Engine prices a dear coat and a bed at the watch-house (a service), pays for both out of the
 * purse with change, puts the coat in the bag, refuses a pistol only a city sells, and shows a
 * notification for each purchase. The next turn's prompt carries the MARKET block for that town.
 *
 * A market day (#6934): the smith's stock for the day is one watch pistol, bought once and then sold
 * out, on that turn and the next; a coat sold back for half its fair price out of the town's purse;
 * and a new day the Game Master marks rolls the stock afresh.
 */

function gravewatch(id: string, edit: (doc: Record<string, any>) => void = () => {}): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"));
  doc.id = id;
  edit(doc);
  return JSON.stringify(doc);
}

const smith = (doc: Record<string, any>) =>
  doc.items.market.sellers.find((seller: { id: string }) => seller.id === "smith") as Record<string, any>;

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
        // No stock for the smith: what the day rolls must not sell the pistol this test refuses.
        data: { definition: gravewatch("gravewatch-markets-e2e", (doc) => delete smith(doc).stock) },
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

test("a market day: the smith's stock sells out, a coat is sold back, and a new day restocks", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  const model = await fakeModel([
    [
      "I buy the smith's pistol and sell my coat.",
      'We reach Barrowmere. [place: name="Barrowmere" size="market town"] ' +
        '[inventory: action="buy" item="Watch pistol"] [inventory: action="buy" item="Watch pistol"] ' +
        '[inventory: action="sell" item="Lantern-keeper\'s coat"]',
    ],
    ["I ask the smith for another pistol.", 'The smith shrugs. [inventory: action="buy" item="Watch pistol"]'],
    [
      "We sleep and come back at dawn.",
      'Dawn. [place: name="Barrowmere" size="market town" day="new"] [inventory: action="buy" item="Watch pistol"]',
    ],
  ]);
  let connectionId = "";
  try {
    await withImports(request, async (cleanup) => {
      // The smith's odd lot is one watch pistol a day, whatever the dice say.
      const definition = gravewatch("gravewatch-market-day-e2e", (doc) => {
        doc.items.lootTables.find((table: { id: string }) => table.id === "smiths_odd_lot").entries = [
          { item: "kit/watch-pistol", weight: 1 },
        ];
      });
      const imported = await request.post("/api/game-rulesets/import", { data: { definition } });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      const connection = await request.post("/api/connections", {
        data: {
          name: "Local market day fixture",
          provider: "custom",
          baseUrl: model.baseUrl,
          apiKey: "synthetic-test-key",
          model: "market-day-fixture",
          maxContext: 32768,
          treatAsLocalEndpoint: true,
        },
      });
      expect(connection.ok()).toBeTruthy();
      connectionId = (await connection.json()).id;
      const created = await request.post("/api/chats", {
        data: { name: "Market day", mode: "game", characterIds: [], connectionId },
      });
      expect(created.ok()).toBeTruthy();
      const chatId = ((await created.json()) as { id: string }).id;
      cleanup.push({ chatId, rulesetId, anchor: "" });
      const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameId: `market-day-${chatId}`,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameImageAutoGenerationEnabled: false,
          enableAgents: false,
          enableTools: false,
          gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
          gameInventory: [
            { id: "st-crowns", name: "crowns", item: "coin:crown", quantity: 7 },
            { id: "st-coat", name: "Lantern-keeper's coat", item: "kit/lantern-coat", quantity: 1 },
          ],
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
      // Every notification the turn shows is recorded as it appears: they fade after a few seconds, and
      // whether that is before or after the narration shows depends on how warm the app is.
      const turn = async (said: string, shown: string | RegExp, notices: RegExp[] = []) => {
        const before = model.prompts.length;
        await page.evaluate(() => {
          const seen = new Set<string>();
          (window as unknown as { marketNotices: Set<string> }).marketNotices = seen;
          new MutationObserver(() => {
            for (const line of document.body.innerText.match(/You (?:bought|sold) [^\n]*/g) ?? [])
              seen.add(line.trim());
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await page.getByPlaceholder("What do you do?", { exact: true }).fill(said);
        await page.getByRole("button", { name: "Send game turn", exact: true }).click();
        if (notices.length > 0) {
          await expect
            .poll(() => page.evaluate(() => [...(window as unknown as { marketNotices: Set<string> }).marketNotices]), {
              timeout: 30_000,
            })
            .toEqual(expect.arrayContaining(notices.map((notice) => expect.stringMatching(notice))));
        }
        await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(shown, {
          timeout: 30_000,
        });
        return model.prompts.slice(before).find((body) => body.includes(said));
      };
      const lastReply = async () =>
        (
          (await (await request.get(`/api/chats/${chatId}/messages`)).json()) as Array<{
            role: string;
            content: string;
          }>
        )
          .filter((message) => message.role === "assistant")
          .at(-1)!.content;
      const bag = () =>
        expect.poll(async () =>
          (await savedInventory(request, chatId))
            .map((stack) => `${stack.name} <${stack.item ?? ""}> ${stack.quantity}`)
            .sort(),
        );

      // The pistol from the smith's stock, once; the coat sold back at half of 8 shillings.
      await turn("I buy the smith's pistol and sell my coat.", "We reach Barrowmere.", [
        /^You bought Watch pistol for 3 crowns\.$/,
        /^You sold Lantern-keeper's coat for 4 shillings\.$/,
      ]);
      await page.screenshot({ path: testInfo.outputPath("market-day-sold.png") });
      await bag().toEqual([
        "Watch pistol <kit/watch-pistol> 1",
        "crowns <coin:crown> 4",
        "shillings <coin:shilling> 4",
      ]);
      const first = await lastReply();
      expect(first).toContain('price="3 crowns" stock="true"');
      expect(first).toContain('item="Watch pistol" count="1" result="refused" reason="sold-out"');
      expect(first).toContain('action="sell" item="Lantern-keeper\'s coat" count="1" seller="chandler" result="ok"');

      // The next turn, the same day: the Game Master is shown the smith has nothing left in stock and
      // the purse has 96 shillings left, and another pistol is refused.
      const prompt = await turn("I ask the smith for another pistol.", "The smith shrugs.");
      expect(prompt).toBeTruthy();
      expect(prompt).toContain(
        "Selling: sellers here buy what they sell at ×0.5 of the fair price, up to 100 shillings a day (96 shillings left today).",
      );
      expect(prompt).not.toContain("in stock today");
      expect(await lastReply()).toContain('item="Watch pistol" count="1" result="refused" reason="sold-out"');
      await bag().toEqual([
        "Watch pistol <kit/watch-pistol> 1",
        "crowns <coin:crown> 4",
        "shillings <coin:shilling> 4",
      ]);

      // A new day the Game Master marks: the smith has a pistol again.
      await turn("We sleep and come back at dawn.", "Dawn.");
      await bag().toEqual([
        "Watch pistol <kit/watch-pistol> 2",
        "crowns <coin:crown> 1",
        "shillings <coin:shilling> 4",
      ]);
      expect(await lastReply()).toContain('[place: name="Barrowmere" size="town" day="new" result="ok"]');
    });
  } finally {
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
