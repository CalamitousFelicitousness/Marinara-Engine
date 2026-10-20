import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const mariCss = readFileSync(new URL("../packages/client/src/styles/mari.css", import.meta.url), "utf8");

// Exercise Mari's production stylesheet without a model, run, shared chat or animation timing fixture.
// Every warning/failure follows the selected base accent, even while the live accent is changing.
for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Mari danger and failure colours follow the steady accent`, async ({ page }) => {
    await page.setContent(`
      <!doctype html><html data-theme="${theme}" data-marinara-accent-animation="pulse"><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          ${mariCss}
          *, *::before, *::after { transition: none !important; animation: none !important; }
        </style>
      </head><body>
        <div id="glow" class="mari-workspace-glow-band" data-glow="broken"></div>
        <div id="edge" class="mari-topbar-edge-glow" data-state="error"></div>
        <div id="pull" class="mari-pull-overlay" data-mari-edge="error"></div>
        <div id="pill" class="mari-topbar-status" data-state="error">Failed</div>
        <div id="portrait" class="mari-workspace-portrait" data-state="warning">Needs attention</div>
        <article class="mari-card" data-variant="danger">
          <div id="media" class="mari-card__media">Delete</div>
          <button id="delete" class="mari-btn mari-btn--danger">Delete</button>
        </article>
        <p id="send" class="mari-send-failed">Could not send</p>
        <p id="status" class="mari-status-shimmer" data-state="error">Failed</p>
        <p id="missed" class="mari-phase__missed">Could not read</p>
        <p id="run" class="mari-run-error__label">Run failed</p>
        <div class="mari-live-work__steps"><ol><li data-status="missed">
          <span id="step" class="mari-step__verb">Could not read</span>
        </li></ol></div>
        <p id="neutral">Details</p>
      </body></html>
    `);
    await page.evaluate((theme) => {
      const root = document.documentElement;
      root.style.setProperty("--background", theme === "dark" ? "#050312" : "#faf8ff");
      root.style.setProperty("--foreground", theme === "dark" ? "#d4d4d4" : "#1a1025");
      root.style.setProperty("--primary-foreground", "#0a0a0a");
      root.style.setProperty("--primary", "#ec4899");
      root.style.setProperty("--destructive", "#ef4444");
      root.style.setProperty("--warning", "#f59e0b");
      root.style.setProperty("--marinara-app-accent-static", "#14b8a6");
    }, theme);

    const samples: Array<[string, string]> = [
      ["glow", "--mari-glow-a"],
      ["glow", "--mari-glow-b"],
      ["glow", "--mari-glow-c"],
      ["edge", "background-color"],
      ["pull", "--mari-edge"],
      ["pill", "--mari-pill-a"],
      ["pill", "--mari-pill-b"],
      ["portrait", "filter"],
      ["media", "color"],
      ["media", "background-color"],
      ["delete", "background-color"],
      ["send", "color"],
      ["status", "color"],
      ["missed", "color"],
      ["run", "color"],
      ["step", "color"],
    ];
    const readColours = () =>
      page.evaluate(
        (samples) =>
          samples.map(([id, property]) => getComputedStyle(document.getElementById(id)!).getPropertyValue(property)),
        samples,
      );
    const first = await readColours();
    for (const colour of first) expect(colour.trim()).not.toBe("");
    await expect(page.locator("#delete")).toHaveCSS("background-color", "rgb(20, 184, 166)");
    const neutral = await page.locator("#neutral").evaluate((node) => getComputedStyle(node).color);

    await page.evaluate(() => document.documentElement.style.setProperty("--marinara-app-accent-static", "#6366f1"));
    const selected = await readColours();
    for (const [index, sample] of samples.entries()) {
      expect(selected[index], `${sample.join(": ")} follows a changed accent`).not.toBe(first[index]);
    }
    await expect(page.locator("#delete")).toHaveCSS("background-color", "rgb(99, 102, 241)");
    await expect(page.locator("#neutral")).toHaveCSS("color", neutral);

    // Accent Pulse updates these live values; warning and error feedback must not pulse with them.
    await page.evaluate(() => {
      for (const variable of ["--primary", "--marinara-app-accent-solid", "--marinara-chat-chrome-accent"]) {
        document.documentElement.style.setProperty(variable, "#22c55e");
      }
    });
    expect(await readColours()).toEqual(selected);
  });
}
