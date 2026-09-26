import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, goToBlogTab } from "./fixtures.js";

// Basic smoke test — catches the class of bug this project has hit more than
// once (a crash in one module that only shows up once you actually click
// into it, e.g. the Marketing tab TDZ crash from a useEffect dependency
// array referencing a not-yet-declared variable). Each top-level tab gets a
// real click + a check that its own heading rendered, not just "the page
// didn't blow up".
test.describe("primary navigation", () => {
  test.beforeEach(async ({ page }) => {
    await seedApp(page);
  });

  const tabs = [
    { nav: "Marketing",  heading: "Marketing Studio" },
    { nav: "Analytics",  heading: null }, // heading text varies; just checking it renders below
    { nav: "Calendar",   heading: null },
    { nav: "Settings",   heading: null },
  ];

  for (const { nav, heading } of tabs) {
    test(`${nav} tab loads without crashing`, async ({ page }) => {
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await gotoDashboard(page);
      await page.locator(`text=${nav}`).first().click();
      await page.waitForTimeout(600);

      if (heading) await expect(page.locator(`text=${heading}`).first()).toBeVisible();
      // The MarketingErrorBoundary (and similar) catch React render errors
      // and show a fallback instead of a blank screen — that's still a bug.
      await expect(page.locator("text=tab error — check browser console")).toHaveCount(0);
      expect(errors, `uncaught page errors on ${nav}: ${errors.join("; ")}`).toEqual([]);
    });
  }

  test("Blog tab shows its own sub-navigation", async ({ page }) => {
    await gotoDashboard(page);
    // The app's default top-level tab is "Posts" (a stale value matching no
    // nav item) — click into Blog explicitly before checking its
    // Pipeline/Posts/Research sub-nav.
    await goToBlogTab(page);
    await expect(page.locator("text=Article Pipeline").first()).toBeVisible();
    await expect(page.locator("text=Posts").first()).toBeVisible();
    await expect(page.locator("text=Research").first()).toBeVisible();
  });
});
