// The 2D avatar renderers and setup panels in a real browser, before the base lane mounts them in chats:
// the PNGTuber renderer swaps talk, blink and face pictures, crossfades and hops; mesh avatars draw through
// one shared WebGL2 context and fall back to the owner's sprites; the setup panels save what the user picks.
import { expect, test, type Page } from "@playwright/test";
import { meshAvatarFiles, paintPng, solid, zipFiles } from "../scripts/regressions/fixtures/avatar-2d-fixtures.js";
import { seedUIState } from "./ui-state-fixture.js";
import { prepareViteFixtureDependencies } from "./vite-fixture-dependencies.js";

type Rgb = [number, number, number];
const GRAY: Rgb = [128, 128, 128];
const GREEN: Rgb = [40, 200, 60];
const BLUE: Rgb = [40, 80, 220];
const YELLOW: Rgb = [240, 200, 40];
const FEATURES = { lipSync: true, blink: true, idleMotion: false };

/** Serves an owner's sprite list and pictures (50 x 100 solid colours). */
async function routeSprites(page: Page, ownerId: string, sprites: Record<string, Rgb>) {
  const pictures = new Map<string, Buffer>();
  for (const [expression, [r, g, b]] of Object.entries(sprites))
    pictures.set(expression, await paintPng(50, 100, solid(r, g, b)));
  await page.route(`**/api/sprites/${ownerId}`, (route) =>
    route.fulfill({
      json: [...pictures.keys()].map((expression) => ({
        expression,
        filename: `${expression}.png`,
        url: `/api/sprites/${ownerId}/file/${expression}.png`,
      })),
    }),
  );
  await page.route(`**/api/sprites/${ownerId}/file/*`, (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "").replace(
      /\.png$/u,
      "",
    );
    const picture = pictures.get(name);
    return picture ? route.fulfill({ contentType: "image/png", body: picture }) : route.fulfill({ status: 404 });
  });
}

async function openApp(page: Page) {
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
  );
  await seedUIState(page, { hasCompletedOnboarding: true, chibiProfessorMariEnabled: false });
  await page.goto("/");
}

interface PageAvatar {
  renderers: { update(frame: unknown, dtMs: number): void; resize(w: number, h: number, dpr: number): void }[];
  canvases: HTMLCanvasElement[];
}
declare global {
  interface Window {
    __avatar2d?: PageAvatar;
  }
}

/** Mounts renderers of one kind on fresh canvases (100 x 200 CSS px, ratio 1) and keeps them on window. */
async function mountRenderers(
  page: Page,
  module: string,
  ownerId: string,
  kinds: unknown,
  count = 1,
  reducedMotion = false,
) {
  await page.evaluate(
    async ({ module, ownerId, kinds, count, reducedMotion, features }) => {
      const { createAvatarRenderer } = (await import(module)) as {
        createAvatarRenderer: () => PageAvatar["renderers"][number] & { mount(options: unknown): Promise<void> };
      };
      const owner = { ownerType: "character", ownerId };
      const config = {
        version: 1,
        owner,
        enabled: true,
        activeKind: null,
        features,
        kinds,
        updatedAt: "2026-10-13T12:00:00.000Z",
      };
      const canvases = Array.from({ length: count }, (_, index) => {
        const canvas = document.createElement("canvas");
        canvas.style.cssText = `position:fixed;top:0;left:${index * 110}px;width:100px;height:200px;z-index:99999`;
        document.body.append(canvas);
        return canvas;
      });
      const renderers = canvases.map(() => createAvatarRenderer());
      await Promise.all(
        renderers.map((renderer, index) =>
          renderer.mount({
            owner,
            config,
            canvas: canvases[index],
            resolveImage: () => null,
            reducedMotion,
            signal: new AbortController().signal,
          }),
        ),
      );
      for (const renderer of renderers) renderer.resize(100, 200, 1);
      window.__avatar2d = { renderers, canvases };
    },
    { module, ownerId, kinds, count, reducedMotion, features: FEATURES },
  );
}

const quiet = { emotion: "neutral", emotionWeight: 1, viseme: null, mouthOpen: 0, state: "idle" };
const talking = { ...quiet, mouthOpen: 1, state: "talking" };

/** Runs one frame on every renderer and reads each canvas: the centre colour and the top of the picture. */
async function step(page: Page, frame: unknown, dtMs: number) {
  return page.evaluate(
    ({ frame, dtMs }) => {
      const avatar = window.__avatar2d!;
      for (const renderer of avatar.renderers) renderer.update(frame, dtMs);
      return avatar.canvases.map((canvas) => {
        const context = canvas.getContext("2d")!;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const at = (x: number, y: number) => [
          ...data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4),
        ];
        let top = -1;
        for (let y = 0; y < canvas.height && top < 0; y += 1) if (at(50, y)[3]! > 0) top = y;
        let painted = 0;
        for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) painted += 1;
        return { centre: at(50, 150), top, painted };
      });
    },
    { frame, dtMs },
  );
}

const PNGTUBER_RENDERER = "/src/features/avatars/renderers/pngtuber/pngtuber-renderer.ts";
const MESH_RENDERER = "/src/features/avatars/renderers/mesh-avatar/mesh-avatar-renderer.ts";

/** Until avatars are mounted in the app, Vite first meets mesh-avatar when a test imports the renderer:
 *  it optimizes the library and reloads the page once. Import the module first and wait out that reload. */
async function loadModule(page: Page, path: string) {
  await page.evaluate((module) => import(module), path).catch(() => undefined);
  await expect
    .poll(
      () =>
        page
          .evaluate((module) => import(module).then(() => document.readyState === "complete"), path)
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const near = (actual: number[] | undefined, expected: number[], tolerance = 3) =>
  !!actual && expected.every((value, index) => Math.abs(actual[index]! - value) <= tolerance);

test("PNGTuber avatars talk, blink, change face and hop from the owner's sprites", async ({ page }) => {
  await routeSprites(page, "e2e-pngtuber", { neutral: GRAY, neutral_talk: GREEN, neutral_blink: BLUE, happy: YELLOW });
  await openApp(page);
  await mountRenderers(page, PNGTUBER_RENDERER, "e2e-pngtuber", {});

  // No setup at all: the sprites are the avatar. The 50 x 100 picture fits 94 x 188 under a 6% hop margin.
  await expect.poll(async () => (await step(page, quiet, 16))[0]).toMatchObject({ centre: [...GRAY, 255], top: 12 });
  await expect.poll(async () => near((await step(page, talking, 16))[0]?.centre, GREEN)).toBe(true);
  // Clocks advance at most 100 ms per frame, so longer waits take several frames.
  for (let index = 0; index < 3; index += 1) await step(page, quiet, 100);
  await step(page, talking, 1);
  const hop = (await step(page, talking, 109))[0]!;
  expect(near(hop.centre, GREEN), "the open mouth shows while hopping").toBe(true);
  expect(hop.top, "the avatar hops by its bounce height").toBeLessThanOrEqual(1);
  await step(page, talking, 100);
  expect((await step(page, talking, 100))[0]!.top, "and lands again").toBe(12);

  // A director-driven blink shows the eyes-closed picture.
  await expect.poll(async () => near((await step(page, { ...quiet, blink: 1 }, 16))[0]?.centre, BLUE)).toBe(true);

  // The exact sprite label wins, and the new face fades in over the old one.
  await expect.poll(async () => near((await step(page, quiet, 16))[0]?.centre, GRAY)).toBe(true);
  const happy = { ...quiet, emotion: "happy", label: "happy" };
  let blended: number[] | undefined;
  await expect
    .poll(async () => {
      await step(page, happy, 0);
      blended = (await step(page, happy, 60))[0]?.centre;
      return near(blended, GRAY);
    })
    .toBe(false);
  expect(near(blended, YELLOW), "half way through the fade the faces mix").toBe(false);
  expect(near((await step(page, happy, 100))[0]?.centre, YELLOW)).toBe(true);
});

test("PNGTuber avatars do not hop with reduced motion", async ({ page }) => {
  await routeSprites(page, "e2e-still", { neutral: GRAY, neutral_talk: GREEN });
  await openApp(page);
  await mountRenderers(page, PNGTUBER_RENDERER, "e2e-still", {}, 1, true);
  await expect.poll(async () => (await step(page, quiet, 16))[0]?.top).toBe(0);
  await step(page, talking, 1);
  const frames = [];
  for (let index = 0; index < 6; index += 1) frames.push((await step(page, talking, 40))[0]!);
  expect(
    frames.every((frame) => frame.top === 0),
    "the picture stays on the ground",
  ).toBe(true);
  expect(near(frames.at(-1)!.centre, GREEN), "the mouth still moves").toBe(true);
});

test("mesh avatars share one WebGL2 context and fall back to sprites", async ({ page }) => {
  // Count the canvases that ask for WebGL2.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    const glCanvases = new Set<HTMLCanvasElement>();
    (window as unknown as { __glCanvases: Set<HTMLCanvasElement> }).__glCanvases = glCanvases;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === "webgl2") glCanvases.add(this);
      return (original as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof original;
  });
  const archive = zipFiles(await meshAvatarFiles({ sprites: true }));
  await page.route("**/api/avatar-models/character/e2e-mesh/files/mesh-avatar/avatar-e2e.mavatar", (route) =>
    route.fulfill({ contentType: "application/octet-stream", body: archive }),
  );
  await routeSprites(page, "e2e-mesh", { neutral: GRAY });
  await openApp(page);
  await loadModule(page, MESH_RENDERER);
  const webgl2 = await page.evaluate(() => {
    const probe = document.createElement("canvas").getContext("webgl2");
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
    (window as unknown as { __glCanvases: Set<HTMLCanvasElement> }).__glCanvases.clear();
    return !!probe;
  });
  test.skip(!webgl2, "This browser build has no WebGL2; the fallback test below still covers it.");

  const kinds = {
    "mesh-avatar": { file: "mesh-avatar/avatar-e2e.mavatar", expressionMap: {}, source: "import" },
  };
  await mountRenderers(page, MESH_RENDERER, "e2e-mesh", kinds, 2);
  const talkingHappy = { ...talking, emotion: "happy", viseme: "aa" };
  await expect
    .poll(async () => (await step(page, talkingHappy, 33)).map((canvas) => canvas.painted > 1000))
    .toEqual([true, true]);
  expect(await page.evaluate(() => (window as unknown as { __glCanvases: Set<unknown> }).__glCanvases.size)).toBe(1);
  // The face is drawn in its skin colour (240, 200, 170), shaded by the runtime.
  const [first] = await step(page, quiet, 33);
  expect(first!.centre[3], "the face is opaque in the middle").toBeGreaterThan(200);

  // A lost context turns every mesh avatar into its owner's sprites.
  await page.evaluate(() => {
    for (const canvas of (window as unknown as { __glCanvases: Set<HTMLCanvasElement> }).__glCanvases) {
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    }
  });
  await expect
    .poll(async () => (await step(page, quiet, 16)).map((canvas) => near(canvas.centre, GRAY)))
    .toEqual([true, true]);
});

test("mesh avatars show the owner's sprites without WebGL2", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === "webgl2"
        ? null
        : (original as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof original;
  });
  await routeSprites(page, "e2e-nogl", { neutral: GRAY });
  await openApp(page);
  await loadModule(page, MESH_RENDERER);
  const kinds = { "mesh-avatar": { file: "mesh-avatar/avatar-x.mavatar", expressionMap: {}, source: "import" } };
  await mountRenderers(page, MESH_RENDERER, "e2e-nogl", kinds);
  await expect.poll(async () => near((await step(page, quiet, 16))[0]?.centre, GRAY)).toBe(true);
});

/** Mounts a setup panel with its own query client, the way the 2D agent page shows it. */
async function mountPanel(page: Page, module: string, name: string, ownerId: string, config: unknown) {
  await prepareViteFixtureDependencies(page);
  await page.evaluate(
    async ({ module, name, ownerId, config }) => {
      const url = window.__viteFixtureDependencyUrl;
      const { default: React } = await import(url("react"));
      const { default: ReactDOM } = await import(url("react-dom_client"));
      const { QueryClient, QueryClientProvider } = await import(url("@tanstack_react-query"));
      const panels = (await import(module)) as Record<string, unknown>;
      const mount = document.createElement("div");
      mount.dataset.avatarPanel = "true";
      mount.style.cssText =
        "position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--background);color:var(--foreground);padding:12px";
      document.body.append(mount);
      ReactDOM.createRoot(mount).render(
        React.createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          React.createElement(panels[name], {
            owner: { ownerType: "character", ownerId },
            config,
            onChanged: () => {},
          }),
        ),
      );
    },
    { module, name, ownerId, config },
  );
}

test("the PNGTuber setup saves the owner's sprites, a chosen face and an imported save", async ({ page }) => {
  await routeSprites(page, "e2e-panel", { neutral: GRAY, neutral_talk: GREEN, happy: YELLOW });
  const saved: Record<string, unknown>[] = [];
  await page.route("**/api/avatar-models/character/e2e-panel", (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  let upload = "";
  await page.route("**/api/avatar-models/character/e2e-panel/import", (route) => {
    upload = route.request().postData() ?? "";
    return route.fulfill({
      json: { kind: "pngtuber", config: {}, detected: {}, warnings: ["Animated layers show only their first frame."] },
    });
  });
  await openApp(page);
  await mountPanel(
    page,
    "/src/features/avatars/renderers/pngtuber/PngtuberSetupPanel.tsx",
    "PngtuberSetupPanel",
    "e2e-panel",
    null,
  );
  const panel = page.locator("[data-avatar-panel]");

  await expect(panel.locator("[data-avatar-face]")).toHaveCount(2);
  await expect(panel.locator('[data-avatar-face="neutral"]')).toContainText("Talk");
  await expect(panel.locator('[data-avatar-face="happy"] img')).toHaveJSProperty("naturalWidth", 50);
  await panel.getByRole("button", { name: "Use my sprites" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({
    activeKind: "pngtuber",
    kinds: {
      pngtuber: {
        source: "sprites",
        layers: { neutral: { base: { source: "sprite", label: "neutral" }, mouthOpen: { label: "neutral_talk" } } },
      },
    },
  });

  await panel.locator('[data-avatar-feeling="happy"]').selectOption("neutral");
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toMatchObject({
    kinds: { pngtuber: { expressionMap: { happy: { target: "neutral", source: "user", confidence: 1 } } } },
  });

  await panel.locator('[data-avatar-import="pngtuber"]').setInputFiles({
    name: "avatar.save",
    mimeType: "application/octet-stream",
    buffer: Buffer.from('{"0":{}}'),
  });
  await expect(panel.getByRole("status")).toContainText("Animated layers show only their first frame.");
  expect(upload).toContain('name="kind"');
  expect(upload).toContain('filename="avatar.save"');
});

test("the mesh avatar setup imports a file and saves the look for a feeling", async ({ page }) => {
  const saved: Record<string, unknown>[] = [];
  await page.route("**/api/avatar-models/character/e2e-mesh-panel", (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await openApp(page);
  const config = {
    version: 1,
    owner: { ownerType: "character", ownerId: "e2e-mesh-panel" },
    enabled: true,
    activeKind: "mesh-avatar",
    features: FEATURES,
    kinds: {
      "mesh-avatar": {
        file: "mesh-avatar/avatar-e2e.mavatar",
        expressionMap: { aa: { target: "a", source: "preset", confidence: 1 } },
        source: "import",
      },
    },
    updatedAt: "2026-10-13T12:00:00.000Z",
  };
  await mountPanel(
    page,
    "/src/features/avatars/renderers/mesh-avatar/MeshAvatarSetupPanel.tsx",
    "MeshAvatarSetupPanel",
    "e2e-mesh-panel",
    config,
  );
  const panel = page.locator("[data-avatar-panel]");
  await expect(panel.locator("[data-avatar-mesh-status]")).toHaveText("Ready. It has drawn mouth shapes for talking.");
  await expect(panel.getByRole("button", { name: "Replace file" })).toBeVisible();
  await panel.locator('[data-avatar-feeling="relaxed"]').selectOption({ label: "Shy" });
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({
    kinds: { "mesh-avatar": { expressionMap: { relaxed: { target: "shy", source: "user", confidence: 1 } } } },
  });
});
