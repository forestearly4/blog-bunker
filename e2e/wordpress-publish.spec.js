import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, mockWordPress, goToBlogTab } from "./fixtures.js";

// Regression coverage for two real bugs Forest reported and we fixed:
//   1. "published to WordPress under the wrong title" — root cause was a
//      stale enhance.metaTitle from a previous post silently winning over
//      the new post's own title (`title: enhance.metaTitle || draft.title`).
//   2. "the headline image is not carrying over from the pipeline to
//      wordpress" — root cause was a silent GCS auto-upload failure that
//      left draft.headlineImageUrl unset with no visible error.
//
// Part A seeds the pipeline directly at the Publish stage and checks the
// exact request body sent to /api/wordpress-post — fast and deterministic,
// exercises the payload-construction code directly.
//
// Part B reproduces the ACTUAL bug scenario end-to-end through the UI: load
// post A into the pipeline, type an SEO title for it (simulating a real
// Enhance session), then hand off post B without publishing A. Before the
// fix, post B could still end up carrying post A's title.

test.describe("WordPress publish — payload correctness", () => {
  test("uses the post's own title and headline image, not stale state", async ({ page }) => {
    await seedApp(page, {
      data: {
        bb_wordpress_config: { siteUrl: "https://blog.example.com", username: "demo", appPassword: "xxxx", connected: true },
        bb_pipeline_draft: {
          stage: "publish",
          completed: ["brief", "draft", "enhance", "social"],
          pipelinePostId: 501,
          brief: { topic: "The Field Manual 03", angle: "", audience: "", keywords: "", inspiration: null },
          draft: {
            title: "The Field Manual 03: One Post, Every Platform",
            body: "Full article body goes here.",
            category: "Field Manual",
            tone: "literary",
            headlineImageUrl: "https://storage.googleapis.com/blogbunker-media/headline-501.jpg",
          },
          enhance: { metaTitle: "The Field Manual 03: One Post, Every Platform", metaDescription: "How to post once and reach every platform.", primaryKeyword: "content multiplier", suggestions: [], headlines: [], improved: "" },
          social: { posts: {}, images: {} },
          schedule: { publishDate: new Date().toISOString().split("T")[0], publishTime: "09:00", publishToWix: false, addToCalendar: false, status: "published" },
        },
      },
    });
    const calls = await mockWordPress(page);

    await gotoDashboard(page);
    await goToBlogTab(page);
    await page.waitForSelector("text=Publish to WordPress", { timeout: 15000 });

    // There are two buttons on this stage: "Publish Now" (the pipeline's own
    // schedule action) and "🌐 Publish to WordPress" (the one under test).
    await page.getByRole("button", { name: "🌐 Publish to WordPress" }).click();

    await page.waitForTimeout(1000);
    const createCall = calls.find(c => c.action === "createPost" || c.action === "updatePost");
    expect(createCall, "no createPost/updatePost request was sent").toBeTruthy();
    expect(createCall.title).toBe("The Field Manual 03: One Post, Every Platform");
    expect(createCall.featuredMediaId).toBe(4242); // from the mocked uploadMedia response
  });
});

test.describe("WordPress publish — pipeline hand-off no longer leaks stale state", () => {
  test("switching from post A to post B clears A's SEO title", async ({ page }) => {
    await seedApp(page, {
      data: {
        bb_posts: [
          { id: 1, title: "Quick Start: Your Blog Bunker Setup", body: "Post A body", category: "Field Manual", status: "draft", date: "2026-09-01", views: 0, headlineImageUrl: "" },
          { id: 2, title: "The Field Manual 03: One Post, Every Platform", body: "Post B body", category: "Field Manual", status: "draft", date: "2026-09-20", views: 0, headlineImageUrl: "" },
        ],
        // Simulates having already run Enhance for post A and picked an SEO
        // title — the exact kind of state that used to leak into post B.
        bb_pipeline_draft: {
          stage: "enhance",
          completed: ["brief", "draft"],
          pipelinePostId: 1,
          brief: { topic: "Quick Start: Your Blog Bunker Setup", angle: "", audience: "", keywords: "", inspiration: null },
          draft: { title: "Quick Start: Your Blog Bunker Setup", body: "Post A body", category: "Field Manual", tone: "literary", headlineImageUrl: "" },
          // `enhance.titles` must be present — the Enhance stage only shows
          // its results panel (title cards + the live Google preview, which
          // is what actually renders `enhance.metaTitle || draft.title`)
          // once titles exist; otherwise it shows the empty "Run SEO
          // Enhance" placeholder regardless of what metaTitle holds.
          enhance: { metaTitle: "Quick Start: Your Blog Bunker Setup", metaDescription: "", primaryKeyword: "setup guide", suggestions: [], headlines: [], overallScore: 60, readabilityScore: 60, titles: [{ text: "Quick Start: Your Blog Bunker Setup", why: "clear and direct", ctrScore: 78, seoScore: 74, combinedScore: 76, charCount: 34 }], descriptions: [] },
          social: { posts: {}, images: {} },
          schedule: { publishDate: new Date().toISOString().split("T")[0], publishTime: "09:00", publishToWix: false, addToCalendar: false, status: "published" },
        },
      },
    });
    await mockWordPress(page);

    await gotoDashboard(page);
    await goToBlogTab(page);

    // Confirm we're looking at post A's stale title before doing anything.
    await expect(page.locator("text=Quick Start: Your Blog Bunker Setup").first()).toBeVisible();

    // Switch away (unmounts ContentPipeline) then hand off post B. A plain
    // `text=Posts` locator also matches the "2 posts · ..." header
    // paragraph (Playwright's text matching is case-insensitive), which
    // sits earlier in the DOM than the actual "▤ Posts" sub-nav button and
    // isn't clickable — so target the button by its accessible name instead.
    await page.getByRole("button", { name: "▤ Posts" }).click();
    await page.waitForTimeout(400);
    await expect(page.locator("text=The Field Manual 03: One Post, Every Platform").first()).toBeVisible();

    const postBRow = page.locator("tr", { hasText: "The Field Manual 03: One Post, Every Platform" });
    await postBRow.getByRole("button", { name: "→ Pipeline" }).click();
    await page.waitForTimeout(600);

    // Post A's stale SEO title must be gone. With enhance state genuinely
    // reset, the Enhance stage shows its empty "Run SEO Enhance" placeholder
    // rather than the old title/Google-preview panel (which is where the
    // stale text used to leak through via `enhance.metaTitle || draft.title`).
    const preview = page.locator("text=Quick Start: Your Blog Bunker Setup");
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole("button", { name: "◈ Run SEO Enhance" })).toBeVisible();

    // Jump back to the Draft stage to confirm the loaded article is
    // actually post B's — its own title, not post A's leftover state.
    await page.locator("text=Draft").first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('input[value="The Field Manual 03: One Post, Every Platform"]')).toBeVisible();

    // "Continue to Enhance" being enabled (title+body non-empty) plus the
    // reset above together confirm the hand-off carried post B's content
    // and none of post A's.
    await expect(page.getByRole("button", { name: "Continue to Enhance →" })).toBeEnabled();
  });
});
