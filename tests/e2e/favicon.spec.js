import { test, expect } from "@playwright/test";

// The tab icon used to be missing entirely (only an apple-touch-icon was
// declared). Make sure each declared icon is actually served as an image.
test("favicon and app icons are declared and served", async ({ page, request }) => {
  await page.goto("/");
  const hrefs = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', els => els.map(e => e.getAttribute("href")));
  expect(hrefs).toEqual(expect.arrayContaining(["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]));
  for (const href of [...hrefs, "/icon-192.png", "/icon-512.png"]) {
    const res = await request.get(href);
    expect(res.status(), href).toBe(200);
    expect(res.headers()["content-type"], href).toMatch(/^image\//);
  }
});
