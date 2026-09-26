import { defineConfig, devices } from "@playwright/test";

// Runs entirely against the built frontend (`vite preview`) with NO real
// backend — every /api/* call the app makes is mocked per-test via
// page.route() (see tests/e2e/fixtures.js). That's deliberate: this repo's
// real backend needs GCS/Meta/WordPress/Pinterest/Anthropic credentials that
// don't exist in CI or most local dev setups, and the whole point of this
// suite is to catch regressions (stale pipeline state, workspace-scoping
// bugs) without needing any of that — same approach used to manually verify
// fixes throughout this project via seeded localStorage + a plain `vite`
// dev server.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // The app registers a real service worker (public/sw.js) for offline
    // support. Once it activates it can intercept /api/* fetches itself and
    // answer from its own cache/fallback logic, bypassing page.route()
    // mocks entirely with no error surfaced — the app just sees an empty
    // response. Blocking service workers keeps every request on the normal
    // network path this suite's mocks rely on.
    serviceWorkers: "block",
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // This @playwright/test version expects a newer bundled Chromium
        // revision than what's pre-installed in this sandbox at
        // PLAYWRIGHT_BROWSERS_PATH. Point straight at the binary that IS
        // installed instead of relying on playwright-core's revision
        // lookup, which pairs the version with a revision that isn't here.
        launchOptions: {
          executablePath: process.env.PW_CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
        },
      },
    },
  ],
});
