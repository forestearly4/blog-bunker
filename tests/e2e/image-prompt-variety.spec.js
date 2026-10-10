import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard } from "./fixtures.js";

// Image prompts kept coming out nearly identical. Guards: each prompt request
// gets a fresh multi-axis shot plan (subject differs every time), the AI is
// shown the prompts it already wrote, and a near-duplicate result is rewritten.
async function openImageStudio(page) {
  await page.locator("nav").filter({ hasText: "Modules" }).getByText("Marketing").click();
  await page.getByRole("button", { name: /Image Studio/ }).click();
  await page.getByPlaceholder(/dry fly fishing at sunset/).fill("fly fishing in the Smokies");
}

async function generateAndCancel(page) {
  await page.getByRole("button", { name: /Generate Image/ }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
}

const subjectOf = (system) => /subject: ([^;]+);/.exec(system)?.[1];

test("each new image prompt gets a different subject and sees the recent prompts", async ({ page }) => {
  await seedApp(page);
  const systems = [];
  const replies = [
    "Hands tying a fly on a workbench, macro, warm window light, vise and thread spools",
    "Tiny angler dwarfed by a misty valley at dawn, wide shot from the ridge",
    "Empty drift boat tied at a mossy dock after rain, low sun",
    "Flat-lay of leader spools and a worn field notebook on slate, overhead",
  ];
  await page.route("**/api/claude", async (route) => {
    const body = route.request().postDataJSON();
    systems.push(body.system);
    await route.fulfill({ json: { content: [{ type: "text", text: replies[(systems.length - 1) % replies.length] }], usage: { input_tokens: 5, output_tokens: 5 } } });
  });
  await gotoDashboard(page);
  await openImageStudio(page);

  for (let i = 0; i < 4; i++) await generateAndCancel(page);
  expect(systems).toHaveLength(4);

  // Shot plan present each time, and the subject never repeats back-to-back
  const subjects = systems.map(subjectOf);
  expect(subjects.every(Boolean)).toBe(true);
  expect(new Set(subjects).size).toBe(4);

  // The first request has nothing to avoid; later ones are shown earlier prompts
  expect(systems[0]).not.toContain("Recent images already made");
  expect(systems[1]).toContain("Recent images already made");
  expect(systems[1]).toContain("Hands tying a fly on a workbench");
  expect(systems[3]).toContain("Empty drift boat tied at a mossy dock");
});

test("a result that repeats an earlier prompt is rewritten once", async ({ page }) => {
  await seedApp(page);
  const systems = [];
  const same = "An angler casting a fly rod on a misty river beside a bourbon glass on a granite boulder";
  await page.route("**/api/claude", async (route) => {
    systems.push(route.request().postDataJSON().system);
    await route.fulfill({ json: { content: [{ type: "text", text: same }], usage: { input_tokens: 5, output_tokens: 5 } } });
  });
  await gotoDashboard(page);
  await openImageStudio(page);

  await generateAndCancel(page);
  expect(systems).toHaveLength(1);            // nothing recent yet, so no rewrite

  await generateAndCancel(page);
  expect(systems).toHaveLength(3);            // 2nd generation: attempt + one rewrite
  expect(systems[2]).toContain("too close to an earlier image");
  expect(systems[2]).toContain("completely different main subject");
});
