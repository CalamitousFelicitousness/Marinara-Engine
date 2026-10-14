// Making a 2D avatar from a sprite, end to end against the real server with local image and vision models
// that hold their answers: Cancel aborts the picture or mesh avatar being made (the model's request closes)
// and leaves the panel idle with only finished pictures, and a sprite drawn on a flat background comes out
// as a cut-out, in the blink picture and in the saved mesh avatar.
import { expect, test, type Page } from "@playwright/test";
import AdmZip from "adm-zip";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sharp } from "../scripts/regressions/fixtures/avatar-2d-fixtures.js";
import { seedUIState } from "./ui-state-fixture.js";
import { prepareViteFixtureDependencies } from "./vite-fixture-dependencies.js";

const LAYOUT = {
  headBox: [110, 40, 490, 470],
  faceBox: [170, 140, 430, 460],
  eyes: [
    { opening: [321, 272, 379, 298], region: [310, 255, 390, 308] },
    { opening: [221, 272, 279, 298], region: [210, 255, 290, 308] },
  ],
  brows: [
    [318, 238, 380, 250],
    [220, 238, 282, 250],
  ],
  nose: [300, 340],
  mouth: { left: [275, 395], right: [325, 395], box: [272, 388, 328, 402] },
  neck: [300, 490],
};

/** A front-facing bust on a flat white background, 600 x 720. */
function bust() {
  const eye = (cx: number) =>
    `<ellipse cx="${cx}" cy="285" rx="30" ry="14" fill="#fff"/><circle cx="${cx}" cy="285" r="11" fill="#3b6db3"/><circle cx="${cx}" cy="285" r="5" fill="#111"/>` +
    `<path d="M${cx - 34} 284 Q${cx} 260 ${cx + 34} 284" stroke="#222" stroke-width="4" fill="none"/>`;
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720"><rect width="600" height="720" fill="#fff"/>
      <rect x="120" y="540" width="360" height="200" rx="60" fill="#3a5fa0"/><rect x="262" y="440" width="76" height="130" fill="#f2c9a8"/>
      <ellipse cx="300" cy="250" rx="190" ry="210" fill="#5a3a22"/><ellipse cx="300" cy="300" rx="130" ry="160" fill="#f2c9a8"/>
      <rect x="220" y="240" width="62" height="8" rx="4" fill="#4a2f1c"/><rect x="318" y="240" width="62" height="8" rx="4" fill="#4a2f1c"/>
      ${eye(250)}${eye(350)}<path d="M275 395 Q300 400 325 395" stroke="#a04848" stroke-width="3" fill="none"/></svg>`),
  )
    .png()
    .toBuffer();
}

async function alphaAt(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
}

/** Image and vision models on one local server. While `hold` is on, a request waits for Cancel. */
function fakeModels() {
  const state = { hold: true, held: [] as string[], closed: [] as string[], open: [] as ServerResponse[] };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = req.url ?? "";
    if (!/\/(?:images\/edits|chat\/completions)$/u.test(url)) {
      // Model lists and other lookups the app makes for a connection.
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.on("close", () => {
      if (!res.writableFinished) state.closed.push(url);
    });
    if (state.hold) {
      state.held.push(url);
      state.open.push(res);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.endsWith("/chat/completions")) {
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(LAYOUT) } }] }));
      return;
    }
    // An edit that keeps the picture in place on the canvas GPT Image 1 is asked for, with the background
    // filled in white as most image models do.
    const body = Buffer.concat(chunks);
    const start = body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sent = body.subarray(start, body.indexOf(Buffer.from("IEND"), start) + 8);
    const picture = await sharp(sent)
      .resize(1024, 1536, { fit: "cover" })
      .flatten({ background: "#fff" })
      .png()
      .toBuffer();
    res.end(JSON.stringify({ data: [{ b64_json: picture.toString("base64") }] }));
  });
  return { server, state };
}

async function mountGenerationPanel(page: Page, ownerId: string) {
  await prepareViteFixtureDependencies(page);
  await page.evaluate(async (ownerId) => {
    const url = window.__viteFixtureDependencyUrl;
    const { default: React } = await import(url("react"));
    const { default: ReactDOM } = await import(url("react-dom_client"));
    const { QueryClient, QueryClientProvider } = await import(url("@tanstack_react-query"));
    const { AvatarGenerationPanel } = (await import(
      "/src/features/avatars/generation/AvatarGenerationPanel.tsx" as string
    )) as { AvatarGenerationPanel: unknown };
    const mount = document.createElement("div");
    mount.dataset.avatarGeneration = "true";
    mount.style.cssText =
      "position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--background);color:var(--foreground);padding:12px";
    document.body.append(mount);
    ReactDOM.createRoot(mount).render(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        React.createElement(AvatarGenerationPanel as never, {
          owner: { ownerType: "character", ownerId },
          config: null,
          onChanged: () => {},
        }),
      ),
    );
  }, ownerId);
  return page.locator("[data-avatar-generation]");
}

test("Cancel stops the picture being made, and avatars made from a sprite have no background", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const models = fakeModels();
  await new Promise<void>((resolve) => models.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(models.server.address() as { port: number }).port}/v1`;
  const created: string[] = [];
  let characterId = "";
  try {
    const character = await request.post("/api/characters", { data: { data: { name: "Cutout fixture" } } });
    expect(character.ok(), await character.text()).toBeTruthy();
    characterId = ((await character.json()) as { id: string }).id;
    const sprite = await request.post(`/api/sprites/${characterId}`, {
      data: { expression: "neutral", image: `data:image/png;base64,${(await bust()).toString("base64")}` },
    });
    expect(sprite.ok(), await sprite.text()).toBeTruthy();
    const connection = async (data: Record<string, unknown>) => {
      const response = await request.post("/api/connections", { data: { apiKey: "fixture", baseUrl, ...data } });
      expect(response.ok(), await response.text()).toBeTruthy();
      const { id } = (await response.json()) as { id: string };
      created.push(id);
      return id;
    };
    const imageId = await connection({
      name: `Held image ${testInfo.project.name}`,
      provider: "image_generation",
      imageGenerationSource: "openai",
      imageService: "openai",
      model: "gpt-image-1",
    });
    const visionId = await connection({
      name: `Held vision ${testInfo.project.name}`,
      provider: "custom",
      model: "vision",
    });

    await page.route("**/api/app-settings/ui", (route) =>
      route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
    );
    await seedUIState(page, { hasCompletedOnboarding: true, reviewImagePromptsBeforeSend: false });
    await page.goto("/");
    const panel = await mountGenerationPanel(page, characterId);
    await panel.getByLabel("Image connection").selectOption(imageId);

    // ── Cancel while a blink picture is being drawn ──
    await panel.getByRole("group", { name: "Sprites", exact: true }).getByRole("button", { name: "neutral" }).click();
    await panel.getByRole("button", { name: "Make 2 pictures" }).click();
    await expect.poll(() => models.state.held.length).toBe(1);
    expect(models.state.held[0]).toMatch(/\/images\/edits$/u);
    await expect(panel.getByRole("status")).toHaveText("Making picture 1 of 2…");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(() => models.state.closed, { message: "the image request in flight is aborted" })
      .toEqual([models.state.held[0]]);
    await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(panel.getByText("Waiting", { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Make 2 pictures" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("cancelled.png"), animations: "disabled" });

    // ── The next picture is made at once (the avatar isn't stuck "already being made"), without a background ──
    models.state.hold = false;
    await panel.getByRole("checkbox", { name: "Mouth open" }).uncheck();
    await panel.getByRole("button", { name: "Make 1 picture" }).click();
    const drawn = panel.getByRole("img", { name: "New picture: neutral: Eyes closed" });
    await expect(drawn).toBeVisible({ timeout: 30_000 });
    const src = await drawn.getAttribute("src");
    const picture = Buffer.from(src!.slice(src!.indexOf(",") + 1), "base64");
    expect(await alphaAt(picture, 3, 3), "the white background is gone").toBe(0);
    expect(await alphaAt(picture, 300, 330), "the face stays").toBe(255);
    await page.screenshot({ path: testInfo.outputPath("pngtuber-picture.png"), animations: "disabled" });

    // ── Cancel while the vision model looks at the sprite for the mesh avatar ──
    models.state.hold = true;
    await panel.getByLabel("Chat connection that can see pictures").selectOption(visionId);
    // The neutral sprite is picked for a mesh avatar until the user picks another.
    await expect(
      panel.getByRole("group", { name: "Sprite to use" }).getByRole("button", { name: "neutral" }),
    ).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Make mesh avatar" }).click();
    await expect.poll(() => models.state.held.length).toBe(2);
    expect(models.state.held[1]).toMatch(/\/chat\/completions$/u);
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => models.state.closed.length, { message: "the vision request is aborted" }).toBe(2);
    await expect(panel.getByText("Building the mesh avatar…")).toHaveCount(0);
    await expect(panel.getByRole("alert")).toHaveCount(0);

    // ── The mesh avatar is built from the sprite's cut-out ──
    models.state.hold = false;
    await panel.getByRole("button", { name: "Make mesh avatar" }).click();
    await panel.getByRole("button", { name: "Save as mesh avatar" }).click({ timeout: 30_000 });
    let file = "";
    await expect
      .poll(async () => {
        const config = await request.get(`/api/avatar-models/character/${characterId}`);
        file = config.ok() ? (((await config.json()).kinds?.["mesh-avatar"]?.file as string | undefined) ?? "") : "";
        return file;
      })
      .toMatch(/^mesh-avatar\/.+\.mavatar$/u);
    const archive = await request.get(`/api/avatar-models/character/${characterId}/files/${file}`);
    const base = new AdmZip(Buffer.from(await archive.body())).getEntry("built/base.png")!.getData();
    expect(await alphaAt(base, 3, 3), "the mesh avatar has no background").toBe(0);
    expect(await alphaAt(base, 300, 600), "its body stays").toBe(255);
  } finally {
    for (const response of models.state.open) response.destroy();
    models.server.closeAllConnections();
    await new Promise<void>((resolve) => models.server.close(() => resolve()));
    for (const id of created) await request.delete(`/api/connections/${id}`);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});
