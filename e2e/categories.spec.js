import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, scopedKey } from "./fixtures.js";

// Regression test for: post categories used to be one hardcoded Cask &
// Stream list (Culture/Whiskey/Gear/...) shared by every workspace. Each
// workspace should see only its own saved list.
test.describe("workspace-specific categories", () => {
  test("The Blog Bunker workspace shows Field Manual / Dispatches, not Cask & Stream's list", async ({ page }) => {
    const wsId = "ws-blog-bunker";
    await seedApp(page, {
      activeWorkspaceId: wsId,
      data: {
        [scopedKey("bb_categories", wsId)]: ["Field Manual", "Dispatches"],
      },
    });
    await gotoDashboard(page);
    await page.locator("text=Settings").first().click();
    await page.waitForTimeout(500);

    const categoriesInput = page.locator('h3:has-text("Post Categories")').locator("xpath=following::input[1]");
    await expect(categoriesInput).toHaveValue("Field Manual, Dispatches");
    await expect(page.locator("text=Culture, Whiskey")).toHaveCount(0);
  });

  test("Cask & Stream workspace keeps its own list independently", async ({ page }) => {
    const wsId = "ws-cask-stream";
    await seedApp(page, {
      activeWorkspaceId: wsId,
      data: {
        [scopedKey("bb_categories", wsId)]: ["Culture", "Whiskey", "Gear", "Destinations"],
      },
    });
    await gotoDashboard(page);
    await page.locator("text=Settings").first().click();
    await page.waitForTimeout(500);

    const categoriesInput = page.locator('h3:has-text("Post Categories")').locator("xpath=following::input[1]");
    await expect(categoriesInput).toHaveValue("Culture, Whiskey, Gear, Destinations");
    await expect(page.locator("text=Field Manual, Dispatches")).toHaveCount(0);
  });
});
