import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// 3D Avatars → Get a 3D model → Make 3D model (Tripo, with the user's own key). Tripo is never called: the
// balance and the model run are answered here, the way the server streams them. The full-body neutral sprite
// is picked for the user, the balance and the cost show before starting, each step shows with the credits
// used, errors are plain, Cancel stops the run and says Tripo may still charge for the step it was on, and the
// result is labelled body only and kept through the normal VRM import, after which setup shows the model as
// body only instead of the face picker. Connections has a Tripo provider with its key link and Test.
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const FIRST_LOAD_TIMEOUT_MS = 30_000;
const TRIPO_KEYS_URL = "https://developers.tripo3d.ai/en/keys";

const PACKAGE = {
  id: "3d-avatars",
  version: "1.0.0",
  status: "active",
  readiness: "ready",
  readinessError: null,
  error: null,
  legacy: false,
  installedAt: "2026-10-13T00:00:00.000Z",
  manifest: {
    schemaVersion: 2,
    id: "3d-avatars",
    name: "3D Avatars",
    version: "1.0.0",
    description: "3D avatars.",
    engine: { min: "2.5.0", maxExclusive: "4.0.0" },
    capabilityApi: { major: 1, minor: 73 },
    kind: ["agent"],
    entrypoints: { agents: "agents.json" },
    files: [{ path: "agents.json", sha256: "0".repeat(64), bytes: 1 }],
    permissions: ["ui"],
    restartRequired: false,
  },
};
const AGENT = {
  id: "3d-avatars",
  packageId: "3d-avatars",
  name: "3D Avatars",
  description: "3D avatars for characters and personas.",
  phase: "post_processing",
  enabledByDefault: false,
  category: "misc",
  execution: "host",
  defaultPromptTemplate: "",
};

const REQUIRED_BONES = [
  "hips",
  "spine",
  "head",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
];

/** A body-only VRM 1.0 file like the ones Tripo models become: a humanoid skeleton and no expressions. */
function bodyOnlyVrm(name: string): string {
  const json = {
    asset: { version: "2.0", generator: "e2e" },
    scenes: [{ nodes: REQUIRED_BONES.map((_, index) => index) }],
    nodes: REQUIRED_BONES.map((bone, index) => ({ name: bone, translation: [0, index / 10, 0] })),
    extensionsUsed: ["VRMC_vrm"],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name,
          version: "1",
          authors: ["Tripo AI"],
          licenseUrl: "https://vrm.dev/licenses/1.0/",
          otherLicenseUrl: "https://developers.tripo3d.ai/en/terms",
          avatarPermission: "onlyAuthor",
          commercialUsage: "personalNonProfit",
          creditNotation: "required",
          allowRedistribution: false,
          modification: "allowModification",
        },
        humanoid: { humanBones: Object.fromEntries(REQUIRED_BONES.map((bone, node) => [bone, { node }])) },
      },
    },
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text]).toString("base64");
}

const PICTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function stream(events: unknown[]) {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  };
}

const progress = (step: string, status: "running" | "done", creditsUsed: number, value: number | null = null) => ({
  type: "progress",
  data: { step, status, progress: value, creditsUsed },
});

async function preparePage(page: Page, characterId: string, balance = 710) {
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
  );
  await page.route("**/api/capability-packages/installed", (route) => route.fulfill({ json: [PACKAGE] }));
  await page.route("**/api/capability-packages/agents", (route) => route.fulfill({ json: [AGENT] }));
  await page.route("**/api/avatar-models", async (route) => {
    const response = await route.fetch();
    const owners = (await response.json()) as Array<{ owner: { ownerId: string } }>;
    await route.fulfill({ response, json: owners.filter((summary) => summary.owner.ownerId === characterId) });
  });
  await page.route(`**/api/sprites/${characterId}`, (route) =>
    route.fulfill({
      json: ["neutral", "happy", "full_neutral", "full_happy", "neutral_talk"].map((expression) => ({
        expression,
        filename: `${expression}.png`,
        url: "/sprites/avatar-demo/base.png",
      })),
    }),
  );
  await page.route("**/api/avatar-generation/vrm-model/balance**", (route) =>
    route.fulfill({ json: { balance, frozen: 0, cost: 60 } }),
  );
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    trackerPanelEnabled: false,
    trackerPanelOpen: false,
    agentDetailId: "3d-avatars",
  });
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    localStorage.removeItem("marinara-active-chat-id");
  }, APP_VERSION);
}

test("3D Avatars makes a body-only VRM model from a full-body sprite with Tripo", async ({ page, request }, info) => {
  const characterResponse = await request.post("/api/characters", { data: { data: { name: "Tripo fixture" } } });
  expect(characterResponse.ok(), await characterResponse.text()).toBeTruthy();
  const character = (await characterResponse.json()) as { id: string };
  const connectionResponse = await request.post("/api/connections", {
    data: { name: "My Tripo", provider: "tripo", apiKey: "tsk_e2e_never_shown" },
  });
  expect(connectionResponse.ok(), await connectionResponse.text()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { id: string; apiKeyEncrypted: string };
  expect(connection.apiKeyEncrypted, "the key never comes back to the browser").toBe("••••••••");

  try {
    await preparePage(page, character.id);
    let runs: Array<(route: Route) => Promise<void>> = [];
    const sent: unknown[] = [];
    await page.route("**/api/avatar-generation/vrm-model", async (route) => {
      sent.push(route.request().postDataJSON());
      const next = runs.shift();
      if (next) await next(route);
    });

    await page.goto("/");
    const setup = page.locator('[data-avatar-setup="3d-avatars"]');
    await expect(setup).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await setup.getByLabel("Character or persona").selectOption(`character:${character.id}`);
    const maker = setup.locator("[data-vrm-model-maker]");
    await expect(maker).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await expect(setup.getByRole("heading", { name: "Get a 3D model", exact: true })).toBeVisible();

    // The full-body neutral sprite is picked, talk pictures are never offered, and the cost shows first.
    const sprites = maker.getByRole("group", { name: "Sprite to use", exact: true }).getByRole("button");
    await expect(sprites).toHaveText(["neutral", "happy", "full neutral", "full happy"]);
    await expect(maker.getByRole("button", { name: "full neutral", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(maker.locator("[data-tripo-balance]")).toHaveText(
      "Your Tripo balance is 710 credits. A model costs about 60 credits.",
    );
    await expect(maker.getByText("Use a full-body sprite where the whole character is visible.")).toBeVisible();

    // A plain error, with the credits already used.
    runs.push((route) =>
      route.fulfill(
        stream([
          progress("redraw", "running", 0),
          progress("redraw", "done", 5, 100),
          progress("model", "running", 5),
          {
            type: "error",
            data: { message: "Your Tripo account doesn't have enough credits. Top up at Tripo, then try again." },
          },
        ]),
      ),
    );
    await maker.getByRole("button", { name: "Make 3D model", exact: true }).click();
    await expect(maker.getByRole("alert")).toHaveText(
      "Your Tripo account doesn't have enough credits. Top up at Tripo, then try again.",
    );
    await maker.screenshot({ path: info.outputPath("vrm-model-error.png"), animations: "disabled" });
    await expect(maker.locator('[data-vrm-step="redraw"]')).toHaveAttribute("data-status", "done");
    await expect(maker.locator('[data-vrm-step="rig"]')).toHaveAttribute("data-status", "waiting");
    await expect(maker.locator("[data-tripo-credits-used]")).toHaveText("Tripo credits used: 5");
    expect(sent[0]).toMatchObject({
      owner: { ownerType: "character", ownerId: character.id },
      sourceLabel: "full_neutral",
      connectionId: connection.id,
    });

    // Cancel stops the run at once and says what Tripo may still do.
    let cancelledRequest = false;
    page.on("requestfailed", (failed) => {
      if (new URL(failed.url()).pathname === "/api/avatar-generation/vrm-model") cancelledRequest = true;
    });
    let hung: Route | null = null;
    runs.push(async (route) => {
      hung = route;
    });
    await maker.getByRole("button", { name: "Make 3D model", exact: true }).click();
    const cancel = maker.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeVisible();
    await expect(maker.getByText("Keep this page open until it's done. Leaving it works like Cancel.")).toBeVisible();
    await expect(maker.getByRole("alert")).toHaveCount(0);
    await cancel.click();
    await expect(
      maker.getByText("Stopped. Tripo may still finish the step it was on and charge for it."),
    ).toBeVisible();
    await expect(cancel).toHaveCount(0);
    await expect.poll(() => cancelledRequest).toBe(true);
    await (hung as Route | null)?.abort().catch(() => undefined);

    // A finished run: every step with its credits, the pictures, the body-only label, then Save.
    runs.push((route) =>
      route.fulfill(
        stream([
          progress("redraw", "running", 0, 40),
          progress("redraw", "done", 5, 100),
          progress("model", "running", 5, 60),
          progress("model", "done", 35, 100),
          progress("rig", "running", 35),
          progress("rig", "done", 60, 100),
          progress("convert", "running", 60),
          progress("convert", "done", 60, 100),
          {
            type: "done",
            data: {
              vrm: bodyOnlyVrm("Tripo fixture"),
              fileName: "Tripo fixture.vrm",
              preview: PICTURE,
              tpose: PICTURE,
              creditsUsed: 60,
              warnings: ["This model has no face expressions, so its face doesn't move."],
            },
          },
        ]),
      ),
    );
    await maker.getByRole("button", { name: "Make 3D model", exact: true }).click();
    const draft = maker.locator("[data-vrm-draft]");
    await expect(draft).toBeVisible();
    for (const step of ["redraw", "model", "rig", "convert"]) {
      await expect(maker.locator(`[data-vrm-step="${step}"]`)).toHaveAttribute("data-status", "done");
    }
    await expect(maker.locator("[data-tripo-credits-used]")).toHaveText("Tripo credits used: 60");
    await expect(draft.getByRole("img", { name: "full neutral drawn in a T-pose" })).toBeVisible();
    await expect(draft.getByRole("img", { name: "The new 3D model" })).toBeVisible();
    await expect(draft.getByText("Body only, the face doesn't move.")).toBeVisible();
    await expect(draft.getByText("Your avatar stays the same until you save.")).toBeVisible();
    expect((await request.get(`/api/avatar-models/character/${character.id}`)).status(), "nothing saved yet").toBe(404);
    await maker.screenshot({ path: info.outputPath("vrm-model-draft.png"), animations: "disabled" });

    await draft.getByRole("button", { name: "Save as the VRM model", exact: true }).click();
    await expect(page.getByText("Saved as the VRM model.")).toBeVisible();
    await expect(draft).toHaveCount(0);
    await expect(maker.locator("[data-vrm-step]"), "the finished run's steps go with it").toHaveCount(0);
    // The kept model went through the normal import and shows as body only, with no faces to pick.
    await expect(setup.getByText("Tripo fixture", { exact: true })).toBeVisible();
    await expect(setup.getByText("VRM 1.0 by Tripo AI", { exact: true })).toBeVisible();
    await expect(setup.locator("[data-vrm-body-only]")).toHaveText("Body only, the face doesn't move.");
    await expect(setup.getByLabel("Mouth: A", { exact: true })).toHaveCount(0);
    await expect(setup.getByText("Saving replaces the current VRM model.")).toHaveCount(0);
    const saved = (await (await request.get(`/api/avatar-models/character/${character.id}`)).json()) as {
      activeKind: string;
      kinds: { vrm: { expressionNames: string[]; meta: { title: string } } };
    };
    expect(saved.activeKind).toBe("vrm");
    expect(saved.kinds.vrm.expressionNames).toEqual([]);
    expect(saved.kinds.vrm.meta.title).toBe("Tripo fixture");
    await setup.screenshot({ path: info.outputPath("vrm-model-saved.png"), animations: "disabled" });
  } finally {
    await request.delete(`/api/characters/${character.id}`).catch(() => undefined);
    await request.delete(`/api/connections/${connection.id}`).catch(() => undefined);
  }
});

test("Make 3D model waits until the Tripo balance covers a model", async ({ page, request }) => {
  const characterResponse = await request.post("/api/characters", { data: { data: { name: "Poor fixture" } } });
  expect(characterResponse.ok(), await characterResponse.text()).toBeTruthy();
  const character = (await characterResponse.json()) as { id: string };
  const connectionResponse = await request.post("/api/connections", {
    data: { name: "Poor Tripo", provider: "tripo", apiKey: "tsk_e2e_never_shown" },
  });
  expect(connectionResponse.ok(), await connectionResponse.text()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { id: string };
  try {
    await preparePage(page, character.id, 40);
    let started = false;
    await page.route("**/api/avatar-generation/vrm-model", (route) => {
      started = true;
      return route.abort();
    });
    await page.goto("/");
    const setup = page.locator('[data-avatar-setup="3d-avatars"]');
    await expect(setup).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await setup.getByLabel("Character or persona").selectOption(`character:${character.id}`);
    const maker = setup.locator("[data-vrm-model-maker]");
    await expect(maker.locator("[data-tripo-balance]")).toHaveText(
      "Your Tripo balance is 40 credits. A model costs about 60 credits. That's not enough for a model. Top up at Tripo first.",
    );
    await expect(maker.getByRole("button", { name: "Make 3D model", exact: true })).toBeDisabled();
    expect(started).toBe(false);
  } finally {
    await request.delete(`/api/characters/${character.id}`).catch(() => undefined);
    await request.delete(`/api/connections/${connection.id}`).catch(() => undefined);
  }
});

test("Connections has a Tripo provider with its key page and a credits Test", async ({ page, request }, info) => {
  const response = await request.post("/api/connections", {
    data: { name: "Tripo test", provider: "tripo", apiKey: "tsk_e2e_never_shown" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const connection = (await response.json()) as { id: string };
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.route(`**/api/connections/${connection.id}/test`, (route) =>
      route.fulfill({
        json: { success: true, message: "Connected. Your Tripo account has 710 credits.", latencyMs: 12 },
      }),
    );
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript((appVersion) => {
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      localStorage.removeItem("marinara-active-chat-id");
    }, APP_VERSION);
    await page.goto("/");
    await page.evaluate(async (id) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      useUIStore.getState().openConnectionDetail(id);
    }, connection.id);
    const editor = page.locator(".mari-editor-shell");
    await expect(editor).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await expect(editor.getByRole("button", { name: "Tripo", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(
      editor.getByText(
        "Tripo makes 3D models from full-body sprites for 3D Avatars, using your own Tripo key and credits.",
      ),
    ).toBeVisible();
    await expect(editor.getByRole("link", { name: "Get your Tripo API key" })).toHaveAttribute("href", TRIPO_KEYS_URL);
    // The key goes to Tripo's own address only, and there is no model to pick.
    await expect(editor.getByText("Base URL", { exact: true })).toHaveCount(0);
    await expect(editor.getByText("Model", { exact: true })).toHaveCount(0);
    await editor.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(editor.getByText("Connected. Your Tripo account has 710 credits.")).toBeVisible();
    await page.screenshot({ path: info.outputPath("tripo-connection.png"), animations: "disabled" });
  } finally {
    await request.delete(`/api/connections/${connection.id}`).catch(() => undefined);
  }
});
