import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, scopedKey } from "./fixtures.js";

const wsId = "ws-mkt-research";

async function openMarketingResearch(page) {
  await page.locator("nav").filter({ hasText: "Modules" }).getByText("Marketing").click();
  await page.getByRole("button", { name: /^⊕\s*Research$/ }).first().click();
}

test("Marketing Research: import article competitors, save an idea manually", async ({ page }) => {
  await seedApp(page, {
    activeWorkspaceId: wsId,
    data: {
      [scopedKey("bb_competitors", wsId)]: [
        { name: "Hatch Magazine", url: "hatchmag.com", posts: "4/wk", traffic: "120K", strengths: "SEO", threat: "high" },
        { name: "The Drake", url: "drakemag.com", posts: "1/wk", traffic: "30K", strengths: "Voice", threat: "low" },
      ],
    },
  });
  await gotoDashboard(page);
  await openMarketingResearch(page);

  // --- Competitors: import from Article Research ---
  await page.getByRole("button", { name: "Competitors" }).first().click();
  await page.getByRole("button", { name: /Import from Article Research/ }).click();
  await page.getByRole("checkbox", { name: "Import The Drake" }).uncheck();
  await page.getByPlaceholder("@handle").first().fill("@hatchmag");
  await page.getByRole("button", { name: "Import 1" }).click();

  const row = page.locator("tr", { hasText: "Hatch Magazine" });
  await expect(row).toContainText("@hatchmag");
  await expect(row).toContainText("Instagram");
  await expect(page.locator("tr", { hasText: "The Drake" })).toHaveCount(0);

  // Importing again offers only what is left (no duplicates of Hatch).
  await page.getByRole("button", { name: /Import from Article Research/ }).click();
  await expect(page.getByRole("checkbox", { name: "Import Hatch Magazine" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Import The Drake" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // --- Manual idea from the Post Ideas sub-tab ---
  await page.getByRole("button", { name: /Post Ideas/ }).click();
  await page.getByRole("button", { name: "+ Save an Idea" }).click();
  await page.getByPlaceholder("What caught your eye?").fill("Reel: first cast of the season");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("✓ Saved to Inspiration")).toBeVisible();
  await page.getByRole("button", { name: /Inspiration$/ }).click();
  await expect(page.getByText("Reel: first cast of the season")).toBeVisible();

  // --- Workspace scoping: nothing leaked into the unscoped (default) keys ---
  const leaked = await page.evaluate(() => localStorage.getItem("bb_competitors"));
  expect(leaked).toBeNull();
  const social = await page.evaluate((k) => localStorage.getItem(k), scopedKey("bb_social_competitors", wsId));
  expect(JSON.parse(social).map(c => c.name)).toEqual(["Hatch Magazine"]);
});
