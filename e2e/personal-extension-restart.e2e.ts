import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

// #7260: when the sandbox stops a client extension's worker, the host must
// remove its dead controls, say so, and start a fresh sandbox on Restart.
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const extensionId = "restart-fixture";
const extensionName = "Restart Fixture";
const contentHash = `sha256:${"a".repeat(64)}`;
const buttonTitle = `Fixture action (${extensionName})`;

// Stands in for the server sandbox bootstrap: it registers one top-bar button
// as soon as it loads, like a real extension does on start-up.
const fixtureSandbox = `<!doctype html><script>
window.parent.postMessage({
  channel: "marinara-personal-extension",
  type: "ui-contribution-register",
  contentHash: ${JSON.stringify(contentHash)},
  contribution: { id: "fixture-action", kind: "button", label: "Fixture action", icon: "sparkles" },
}, "*");
</script>`;

async function openHomeWithFixtureExtension(page: Page) {
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: "" } : { success: true } }),
  );
  await page.route("**/api/personal-extensions/runtime/client", (route) =>
    route.fulfill({
      json: [
        {
          id: extensionId,
          name: extensionName,
          description: "",
          capabilities: [],
          contentHash,
          executionMode: "sandboxed",
          runtimeUrl: `/api/personal-extensions/${extensionId}/sandbox.html?hash=${encodeURIComponent(contentHash)}`,
          styleUrl: null,
        },
      ],
    }),
  );
  await page.route(`**/api/personal-extensions/${extensionId}/sandbox.html*`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureSandbox }),
  );
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chibiProfessorMariEnabled: false,
  });
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
  }, version);
  await page.goto("/");
}

async function postFromSandbox(page: Page, message: Record<string, unknown>) {
  const sandbox = page.frames().find((frame) => frame.url().includes(`/${extensionId}/sandbox.html`));
  if (!sandbox) throw new Error("The fixture extension sandbox is not running");
  await sandbox.evaluate(
    (data) => window.parent.postMessage({ channel: "marinara-personal-extension", ...data }, "*"),
    {
      ...message,
      contentHash,
    },
  );
}

test("a stopped client extension drops its controls and Restart starts a fresh sandbox", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Top-bar extension buttons sit in the More menu on phones.");
  await openHomeWithFixtureExtension(page);

  const sandboxes = page.locator(`iframe[data-personal-extension-sandbox="${extensionId}"]`);
  const action = page.locator('[data-component="TopBar"]').getByTitle(buttonTitle, { exact: true });
  await expect(action).toBeVisible();
  await expect(sandboxes).toHaveCount(1);
  await sandboxes.evaluate((iframe) => iframe.setAttribute("data-fixture-generation", "first"));

  // An ordinary extension error keeps the extension and its controls.
  await postFromSandbox(page, { type: "error", message: "Fixture handler failed" });
  await expect(page.getByText(`${extensionName} stopped working.`)).toHaveCount(0);
  await expect(action).toBeVisible();

  // A sandbox-stopped worker removes the dead controls and shows a notice.
  await postFromSandbox(page, {
    type: "error",
    stopped: true,
    message: "Browser extension was stopped because its sandbox became unresponsive",
  });
  await expect(page.getByText(`${extensionName} stopped working.`)).toBeVisible();
  await expect(page.getByText("Its buttons and panels are hidden until you restart it.")).toBeVisible();
  await expect(action).toHaveCount(0);
  await expect(sandboxes).toHaveCount(0);

  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(sandboxes).toHaveCount(1);
  await expect(sandboxes).not.toHaveAttribute("data-fixture-generation", "first");
  await expect(action).toBeVisible();
});
