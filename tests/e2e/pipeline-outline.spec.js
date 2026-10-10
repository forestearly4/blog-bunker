import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, goToBlogTab } from "./fixtures.js";

const OUTLINE = "# Sherry Cask Scotch for River Nights\n## Why sherry fits the water\n- Dried fruit against cold river air\n- One example pairing\n## Conclusion\n- Pour slow";
const ARTICLE = "# Sherry Cask Scotch for River Nights\nFull written article body.";

async function openBrief(page, calls) {
  await page.route("**/api/data**", (r) => r.fulfill({ json: r.request().method() === "POST" ? { success: true } : { value: null } }));
  await page.route("**/api/claude", async (route) => {
    const body = JSON.parse(route.request().postData());
    calls.push(body);
    const text = body.max_tokens === 4000 ? ARTICLE : OUTLINE;
    await route.fulfill({ json: { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  });
  await seedApp(page);
  await gotoDashboard(page);
  await goToBlogTab(page);
  await page.getByPlaceholder(/Best bourbon to sip/).fill("Sherry cask scotch");
}

test("outline: generated cheaply, lands editable in the draft stage, can be expanded by AI", async ({ page }) => {
  const calls = [];
  await openBrief(page, calls);
  await page.getByTestId("generate-outline").click();
  await page.getByRole("button", { name: /✓ Generate Outline/ }).click(); // prompt preview confirm
  await expect(page.getByTestId("outline-banner")).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].max_tokens).toBeLessThanOrEqual(700); // ~1/6 of a full draft's allowance
  await expect(page.getByText("Why sherry fits the water").first()).toBeVisible();

  await page.getByTestId("expand-outline").click();
  await expect(page.getByTestId("outline-banner")).toHaveCount(0);
  await expect(page.getByText("Full written article body.")).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1].messages[0].content).toContain("OUTLINE:");
  expect(calls[1].messages[0].content).toContain("Why sherry fits the water");
});

test("outline: 'I'll write it myself' dismisses the banner with no further AI call", async ({ page }) => {
  const calls = [];
  await openBrief(page, calls);
  await page.getByTestId("generate-outline").click();
  await page.getByRole("button", { name: /✓ Generate Outline/ }).click();
  await page.getByRole("button", { name: /write it myself/ }).click();
  await expect(page.getByTestId("outline-banner")).toHaveCount(0);
  expect(calls).toHaveLength(1);
});
