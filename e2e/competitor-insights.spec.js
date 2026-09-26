import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, scopedKey, goToBlogTab } from "./fixtures.js";

// Regression test for: the Competitor Landscape's three insight cards
// (Content Gap / Avg Competitor Frequency / Untapped Format) used to be one
// hardcoded Cask & Stream placeholder set ("Whiskey + Fishing", "3.0/wk",
// "Video Pairing Guides") shown identically to every workspace regardless of
// its actual competitors.
test("Competitor Landscape reflects this workspace's own data, not the old hardcoded placeholders", async ({ page }) => {
  const wsId = "ws-regression-check";
  await seedApp(page, {
    activeWorkspaceId: wsId,
    data: {
      [scopedKey("bb_competitors", wsId)]: [
        { name: "TestCompetitor Blog", url: "https://testcompetitor.example.com", posts: "5/wk", strengths: "gear reviews", threat: "medium" },
      ],
      // Deliberately no bb_competitor_insights cached for this workspace —
      // Content Gap / Untapped Format must show an honest "not generated"
      // state, never a hardcoded value.
    },
  });
  await gotoDashboard(page);

  // Research → Competitors lives under the Blog tab, not Marketing.
  await goToBlogTab(page);
  await page.locator("text=Research").first().click();
  await page.waitForTimeout(300);
  await page.locator("text=Competitors").first().click();
  await page.waitForTimeout(500);

  // Avg frequency is computed from THIS workspace's own competitor (5/wk),
  // never the old hardcoded "3.0/wk".
  await expect(page.locator("text=5.0/wk")).toBeVisible();
  await expect(page.locator("text=3.0/wk")).toHaveCount(0);

  // Content Gap / Untapped Format must not show the old hardcoded values —
  // with nothing generated yet for this workspace, they should say so.
  await expect(page.locator("text=Whiskey + Fishing")).toHaveCount(0);
  await expect(page.locator("text=Video Pairing Guides")).toHaveCount(0);
  await expect(page.locator("text=Not generated yet — see below")).toHaveCount(2);
});
