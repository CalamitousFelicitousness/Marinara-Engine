import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

test.beforeEach(async ({ page }) => {
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
  );
  // The Daily Encounter widget must show its empty state whatever other specs left in the library.
  await page.route("**/api/characters/catalog?**", (route) =>
    route.fulfill({ json: { items: [], limit: 100, offset: 0, hasMore: false, catalogGeneration: 1 } }),
  );
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    localStorage.setItem(
      "marinara:home:widget-visibility:v2",
      JSON.stringify(["professor", "character", "whats-new", "learn", "community", "clock", "discovery"]),
    );
  }, version);
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    professorMariNavigationEnabled: false,
  });
});

async function homeWidgetFit(page: Page) {
  return page.evaluate(() => {
    const inside = (child: DOMRect, parent: DOMRect, inset: number) =>
      child.left >= parent.left + inset - 0.5 &&
      child.right <= parent.right - inset + 0.5 &&
      child.top >= parent.top + inset - 0.5 &&
      child.bottom <= parent.bottom - inset + 0.5;
    // Names the first ancestor up to the widget whose overflow clips the element on an axis it overflows.
    const clippedBy = (element: Element, widget: Element) => {
      const rect = element.getBoundingClientRect();
      for (let node = element.parentElement; node && node !== widget.parentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const overflowsX = rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
        const overflowsY = rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5;
        if ((style.overflowX !== "visible" && overflowsX) || (style.overflowY !== "visible" && overflowsY)) {
          return node.getAttribute("data-component") ?? node.tagName;
        }
      }
      return null;
    };

    const encounter = document.querySelector<HTMLElement>('[data-home-widget-id="character"] > section')!;
    const link = Array.from(encounter.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Open character library",
    )!;
    const message = link.previousElementSibling!;
    link.scrollIntoView({ block: "center" });
    const linkBox = link.getBoundingClientRect();
    const hit = document.elementFromPoint(linkBox.left + linkBox.width / 2, linkBox.top + linkBox.height / 2);

    const guide = document.querySelector<HTMLElement>('[data-home-widget-id="professor"]')!;
    const card = guide.querySelector<HTMLElement>('[data-component="HomeBrowserHub.ProfessorWidget"]')!;
    const mari = guide.querySelector<HTMLElement>('[data-part="sprite"]')!;
    const cardBox = card.getBoundingClientRect();
    const mariBox = mari.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(guide.parentElement!).rowGap) || 0;

    return {
      emptyMessageInside: inside(message.getBoundingClientRect(), encounter.getBoundingClientRect(), 8),
      emptyLinkInside: inside(linkBox, encounter.getBoundingClientRect(), 8),
      emptyLinkReachable: hit === link || link.contains(hit),
      mariClippedBy: clippedBy(mari, guide),
      mariWithinCardSides: mariBox.left >= cardBox.left && mariBox.right <= cardBox.right,
      mariStandsInCard: mariBox.bottom <= cardBox.bottom,
      // She may rise past the top border, but only into the grid gap, never over a neighbour.
      mariRiseWithinGap: mariBox.top >= cardBox.top - gap,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

test("Home widgets: Daily Encounter empty state fits and Professor Mari is shown whole (#7032)", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  await page.goto("/");
  const encounter = page.locator('[data-home-widget-id="character"]');
  const libraryLink = encounter.getByRole("button", { name: "Open character library" });
  await expect(libraryLink).toBeVisible({ timeout: 30_000 });

  // 4, 3 and 2 grid columns on desktop (all at the 13rem minimum row height), one column on phones.
  for (const width of mobile ? [390, 320] : [1920, 1440, 1100, 900]) {
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    await expect
      .poll(() => homeWidgetFit(page), { message: `Home widgets at ${width}px` })
      .toEqual({
        emptyMessageInside: true,
        emptyLinkInside: true,
        emptyLinkReachable: true,
        mariClippedBy: null,
        mariWithinCardSides: true,
        mariStandsInCard: true,
        mariRiseWithinGap: true,
        horizontalScroll: false,
      });
    await encounter.screenshot({ path: testInfo.outputPath(`daily-encounter-${width}.png`) });
    await page
      .locator('[data-home-widget-id="professor"]')
      .screenshot({ path: testInfo.outputPath(`professor-mari-${width}.png`) });
  }

  await libraryLink.click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        return useUIStore.getState().characterLibraryOpen as boolean;
      }),
    )
    .toBe(true);
});

test("Home widgets: the hover glow is a faded box-shadow layer, not an animated drop-shadow filter (#7032)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "Hover feedback only applies to fine pointers.");
  await page.goto("/");
  const widget = page.locator('[data-home-widget-id="character"]');
  await expect(widget).toBeVisible({ timeout: 30_000 });
  const hoverStyles = () =>
    widget.evaluate((element) => {
      const card = getComputedStyle(element.querySelector(":scope > section")!);
      const glow = getComputedStyle(element, "::before");
      return {
        // Chromium's compositor drops a color-mix() drop-shadow while it runs the filter transition.
        cardFilterHasDropShadow: card.filter.includes("drop-shadow"),
        cardLifted: card.transform !== "none",
        glowOpacity: glow.opacity,
        glowHasShadow: glow.boxShadow !== "none",
        glowFollowsCard: glow.transform === card.transform,
      };
    });

  await widget.hover();
  await expect.poll(hoverStyles).toEqual({
    cardFilterHasDropShadow: false,
    cardLifted: true,
    glowOpacity: "1",
    glowHasShadow: true,
    glowFollowsCard: true,
  });

  await page.mouse.move(2, 2);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await widget.hover();
  await expect.poll(hoverStyles).toEqual({
    cardFilterHasDropShadow: false,
    cardLifted: false,
    glowOpacity: "1",
    glowHasShadow: false,
    glowFollowsCard: true,
  });
});
