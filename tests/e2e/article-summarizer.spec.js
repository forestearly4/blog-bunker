import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, goToBlogTab } from "./fixtures.js";

// Operative feature: summarize an outside article from its link, save it to
// Inspiration; plus collecting items the Chrome extension saved to the inbox.
const SUMMARY = { tldr: "Euro nymphing wins on tight lines.", key_points: ["Stay in contact", "Use a long leader"], angles: ["The dry-fly purist's rebuttal"], tags: ["nymphing"] };

async function openSummarize(page) {
  await goToBlogTab(page);
  await page.getByRole("button", { name: /Research/ }).first().click();
  await page.locator("button:has(span:text-is('✂'))").first().click();
}

test("Operative can summarize a link and save it to Inspiration", async ({ page }) => {
  await seedApp(page, { data: { bb_user_tier: "operative" } });
  const claude = [];
  await page.route("**/api/extract", async (route) => {
    expect(route.request().postDataJSON().url).toBe("https://example.com/euro");
    await route.fulfill({ json: { title: "Why Euro Nymphing", siteName: "Hatch", url: "https://example.com/euro", text: "word ".repeat(300), wordCount: 300 } });
  });
  await page.route("**/api/claude", async (route) => {
    claude.push(route.request().postDataJSON());
    await route.fulfill({ json: { content: [{ type: "text", text: "```json\n" + JSON.stringify(SUMMARY) + "\n```" }], usage: { input_tokens: 400, output_tokens: 120 } } });
  });
  await gotoDashboard(page);
  await openSummarize(page);

  await page.getByLabel("Article link").fill("https://example.com/euro");
  await page.getByTestId("summarize-run").click();
  await expect(page.getByText("Euro nymphing wins on tight lines.")).toBeVisible();
  await expect(page.getByText("The dry-fly purist's rebuttal")).toBeVisible();

  // Page text reached the model as quoted, untrusted data, with a capped reply
  expect(claude).toHaveLength(1);
  expect(claude[0].max_tokens).toBe(600);
  expect(claude[0].userId).toBe("demo@blogbunker.app"); // metered by the proxy
  expect(claude[0].messages[0].content).toContain("<article>");

  await page.getByRole("button", { name: "Save to Inspiration" }).click();
  await expect(page.getByText("✓ Saved to Inspiration")).toBeVisible();

  await page.getByRole("button", { name: /Inspiration/ }).first().click();
  await expect(page.getByText("Why Euro Nymphing", { exact: true })).toBeVisible();
  await expect(page.getByText(/Source: https:\/\/example.com\/euro/)).toBeVisible();
});

test("blocked pages fall back to pasting the text", async ({ page }) => {
  await seedApp(page, { data: { bb_user_tier: "operative" } });
  await page.route("**/api/extract", (route) => route.fulfill({ status: 422, json: { error: "That site blocked automatic reading.", code: "needs_text" } }));
  await page.route("**/api/claude", (route) => route.fulfill({ json: { content: [{ type: "text", text: JSON.stringify(SUMMARY) }], usage: { input_tokens: 1, output_tokens: 1 } } }));
  await gotoDashboard(page);
  await openSummarize(page);

  await page.getByLabel("Article link").fill("https://paywalled.example.com/a");
  await page.getByTestId("summarize-run").click();
  await expect(page.getByRole("alert")).toContainText("blocked automatic reading");
  await page.getByLabel("Article text").fill("tight line ".repeat(60));
  await page.getByTestId("summarize-run").click();
  await expect(page.getByText("Euro nymphing wins on tight lines.")).toBeVisible();
});

test("Scout sees the upgrade notice instead of the summarizer", async ({ page }) => {
  await seedApp(page);
  await gotoDashboard(page);
  await openSummarize(page);
  await expect(page.getByText(/article summarizer is available on Operative/i)).toBeVisible();
  await expect(page.getByLabel("Article link")).toHaveCount(0);
});

test("items saved by the Chrome extension are collected into this workspace's Inspiration", async ({ page }) => {
  await seedApp(page, { data: { bb_user_tier: "operative" } });
  const acks = [];
  await page.route("**/api/ext", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "drain") {
      expect(body.workspaceId).toBe("default");
      return route.fulfill({ json: { items: [{ id: "ext-1", target: "blog", item: { id: "ext-1", title: "Saved from Chrome", source: "Hatch", type: "article", notes: "From the extension", fromExtension: true } }] } });
    }
    if (body.action === "ack") { acks.push(...body.ids); return route.fulfill({ json: { success: true } }); }
    return route.fulfill({ json: {} });
  });
  await gotoDashboard(page);
  await goToBlogTab(page);
  await page.getByRole("button", { name: /Research/ }).first().click();
  await page.getByRole("button", { name: /Inspiration/ }).first().click();
  await expect(page.getByText("Saved from Chrome")).toBeVisible();
  await expect.poll(() => acks).toEqual(["ext-1"]);
});
