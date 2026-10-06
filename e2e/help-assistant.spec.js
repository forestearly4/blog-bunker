import { test, expect } from "@playwright/test";
import { seedApp, gotoDashboard } from "./fixtures.js";

// In-app help assistant: opens from the "?" button, shows the word-allowance
// notice up front, sends a short capped request through the platform proxy
// (/api/claude, which is what meters words), and renders the reply.
test.describe("In-app help assistant", () => {
  test("shows the word-allowance notice, sends a capped request, shows the reply", async ({ page }) => {
    await seedApp(page);
    const requests = [];
    await page.route("**/api/claude", async (route) => {
      requests.push(JSON.parse(route.request().postData() || "{}"));
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ content: [{ type: "text", text: "Go to Settings → Facebook & Instagram and click Connect." }], usage: { input_tokens: 10, output_tokens: 12 } }),
      });
    });

    await gotoDashboard(page);
    await page.getByTitle(/Ask Blog Bunker/).click();

    await expect(page.getByText(/counts against your monthly AI word allowance/)).toBeVisible();

    await page.getByPlaceholder("Ask a question…").fill("How do I connect Instagram?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Go to Settings → Facebook & Instagram and click Connect.")).toBeVisible();
    await expect(page.getByText(/words used in this chat/)).toBeVisible();

    expect(requests).toHaveLength(1);
    expect(requests[0].max_tokens).toBe(350);
    expect(requests[0].userId).toBe("demo@blogbunker.app"); // sent so the proxy meters it
    expect(requests[0].system).toMatch(/Never exceed 80 words/);
    expect(requests[0].messages[0].content).toContain("How do I connect Instagram?");
  });

  test("surfaces the word-limit error from the proxy inside the chat", async ({ page }) => {
    await seedApp(page);
    await page.route("**/api/claude", (route) => route.fulfill({
      status: 429, contentType: "application/json",
      body: JSON.stringify({ error: "Monthly AI word limit reached (15,000 words on your current plan)." }),
    }));
    await gotoDashboard(page);
    await page.getByTitle(/Ask Blog Bunker/).click();
    await page.getByPlaceholder("Ask a question…").fill("hi");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/Monthly AI word limit reached/)).toBeVisible();
  });
});
