import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard, goToBlogTab } from "./fixtures.js";

// Regression: a post published on computer A kept showing as "still needs to
// be published" on computer B. B held its own stale copy of the draft in
// localStorage and re-uploaded it, undoing the cloud clear. Publishing now
// leaves a timestamped tombstone that B must honor (and must not overwrite).
const draft = (savedAt) => ({
  stage: "publish",
  completed: ["brief", "draft", "enhance"],
  pipelinePostId: null,
  savedAt,
  brief: { topic: "Stale Published Topic", angle: "", audience: "", keywords: "", inspiration: null },
  draft: { title: "Stale Published Title", body: "body", category: "Gear", tone: "literary", headlineImageUrl: "" },
  enhance: { metaTitle: "", metaDescription: "", primaryKeyword: "", suggestions: [], headlines: [] },
  social: { posts: {}, images: {} },
  schedule: { publishDate: "2026-10-05", publishTime: "09:00", publishToWix: false, addToCalendar: false, status: "published" },
});

test("stale local draft is discarded when another device already published it", async ({ page }) => {
  const writes = [];
  await page.route("**/api/data**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") {
      writes.push(JSON.parse(req.postData() || "{}"));
      return route.fulfill({ json: { success: true } });
    }
    const tomb = url.searchParams.get("key") === "pipeline_draft";
    return route.fulfill({ json: { value: tomb ? { completed: ["publish"], tombstone: true, savedAt: new Date().toISOString() } : null } });
  });
  await seedApp(page, { data: { bb_pipeline_draft: draft("2026-10-04T10:00:00.000Z") } });
  await gotoDashboard(page);
  await goToBlogTab(page);
  await page.waitForTimeout(3500); // longer than the autosave debounce

  await expect(page.getByText("Stale Published Title")).toHaveCount(0);
  const local = await page.evaluate(() => localStorage.getItem("bb_pipeline_draft"));
  expect(local).toBeNull();
  const resurrected = writes.filter(w => w.key === "pipeline_draft" && w.value && !w.value.tombstone);
  expect(resurrected).toHaveLength(0);
});
