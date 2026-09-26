import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard } from "./fixtures.js";

const MEDIA_ITEMS = [
  { id: "m1", name: "Madison River Headline", url: "https://example.com/madison.jpg", tags: ["blog headline", "generated"], source: "generated", type: "image/jpeg", size: 1_240_000, createdAt: new Date().toISOString(), notes: "" },
  { id: "m2", name: "Bourbon Barrel Close-up", url: "https://example.com/bourbon.jpg", tags: ["blog headline", "upload"], source: "upload", type: "image/jpeg", size: 2_310_000, createdAt: new Date().toISOString(), notes: "" },
  { id: "m3", name: "Golden Hour Cast IG", url: "https://example.com/goldenhour.jpg", tags: ["instagram", "generated"], source: "generated", type: "image/jpeg", size: 980_000, createdAt: new Date().toISOString(), notes: "" },
];

test.describe("Media Library", () => {
  test.beforeEach(async ({ page }) => {
    // /api/gcs isn't mocked — MediaLibrary's fetchItems() falls back to the
    // localStorage cache on a failed fetch, same as it does today whenever
    // the app runs without Netlify functions available (this is the same
    // fallback path exercised every time this project's screenshots were
    // generated against a plain `vite` dev server).
    await seedApp(page, { data: { bb_media_library_cache: MEDIA_ITEMS } });
    await gotoDashboard(page);
    await page.locator("text=Marketing").first().click();
    await page.waitForTimeout(400);
    await page.locator("text=Media Library").first().click();
    await page.waitForTimeout(800);
  });

  test("renders all cached items and the tag filter narrows them", async ({ page }) => {
    await expect(page.locator("text=3 images")).toBeVisible();
    await expect(page.locator("text=Madison River Headline")).toBeVisible();
    await expect(page.locator("text=Bourbon Barrel Close-up")).toBeVisible();
    await expect(page.locator("text=Golden Hour Cast IG")).toBeVisible();

    await page.getByRole("button", { name: "Instagram" }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("text=Golden Hour Cast IG")).toBeVisible();
    await expect(page.locator("text=Madison River Headline")).toHaveCount(0);
  });

  test("clicking an item opens the detail panel with its metadata", async ({ page }) => {
    await page.locator("text=Madison River Headline").first().click();
    await page.waitForTimeout(300);

    await expect(page.locator("text=NAME")).toBeVisible();
    await expect(page.locator('input[value="Madison River Headline"]')).toBeVisible();
    await expect(page.locator("text=Copy URL")).toBeVisible();
    await expect(page.locator("text=AI Restyle")).toBeVisible();
  });
});
