// Shared helpers for the Playwright e2e suite.
//
// This suite runs against a plain `vite preview` build with NO real backend —
// every /api/* call is mocked per-test via page.route(). That's deliberate:
// the real Netlify functions need GCS/Meta/WordPress/Pinterest/Anthropic
// credentials that don't exist in CI or most local setups, and the point of
// these tests is to catch the specific regressions this project has actually
// had (stale pipeline state leaking between posts, features that forgot to
// be workspace-scoped) without needing any of that.
//
// Everything the app reads from localStorage is JSON.stringify'd (see
// createPersistedStore in dashboard.jsx), including plain strings — so
// `bb_active_workspace` is stored as the JSON string `"ws-a"`, not the bare
// text `ws-a`. seedApp() below handles that for you.

export const DEFAULT_AUTH = {
  user: { email: "demo@blogbunker.app", name: "Demo User" },
  accessToken: "demo-access-token",
  expiry: Date.now() + 1000 * 60 * 60 * 24,
};

export const DEFAULT_WORKSPACE = {
  name: "Cask & Stream",
  url: "caskandstream.com",
  tagline: "Cast at dawn. Sip at dusk.",
};

// Mirrors scopedKey(key, "workspace") in dashboard.jsx: unscoped for
// "default"/undefined, otherwise suffixed with __ws_<id>.
export function scopedKey(key, workspaceId) {
  if (!workspaceId || workspaceId === "default") return key;
  return `${key}__ws_${workspaceId}`;
}

/**
 * Seeds localStorage (auth, onboarding, workspace, active workspace id, and
 * any app data) via addInitScript, so it's in place before the app's first
 * render — the same technique used throughout this project to bypass
 * login/onboarding and drive the app into a specific state deterministically.
 *
 * `data` is a map of { localStorageKey: value }. Each value is JSON-stringified
 * for you. Pass already-scoped keys (use scopedKey() above) when a workspaceId
 * other than "default" is in play.
 */
export async function seedApp(page, { auth = DEFAULT_AUTH, workspace = DEFAULT_WORKSPACE, activeWorkspaceId = null, data = {} } = {}) {
  await page.addInitScript(({ auth, workspace, activeWorkspaceId, data }) => {
    localStorage.setItem("bb_google_auth", JSON.stringify(auth));
    localStorage.setItem("bb_onboarded", "true");
    localStorage.setItem("bb_onboarded_" + auth.user.email, "true");
    localStorage.setItem("bb_workspace", JSON.stringify(workspace));
    localStorage.setItem("bb_workspace_" + auth.user.email, JSON.stringify(workspace));
    if (activeWorkspaceId) localStorage.setItem("bb_active_workspace", JSON.stringify(activeWorkspaceId));
    for (const [key, value] of Object.entries(data)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }, { auth, workspace, activeWorkspaceId, data });
}

export async function gotoDashboard(page) {
  await page.goto("/");
  await page.waitForSelector("text=Blog Bunker", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800); // let the initial render/effects settle
}

/**
 * Clicks the "Blog" item in the left Modules nav. A plain `text=Blog`
 * locator also matches the "Blog Bunker" brand text in the sidebar header
 * (which sits earlier in the DOM and isn't clickable), so this scopes the
 * click to the <nav> landmark that holds the actual module list. The
 * default top-level tab on load is "posts" (a stale value matching no nav
 * item), so this click is required before any Blog-tab content is visible.
 */
export async function goToBlogTab(page) {
  await page.locator("nav").getByText("Blog", { exact: false }).first().click();
  await page.waitForTimeout(400);
}

/**
 * Mocks netlify/functions/wordpress-post.js. Returns a `calls` array that
 * fills in as the app makes requests — tests assert against calls.at(-1)
 * (or whichever call matters) instead of needing a real WordPress site.
 *
 * IMPORTANT: call this AFTER seedApp() (and before goto/gotoDashboard).
 * Registering page.route() before page.addInitScript() silently fails to
 * intercept anything in this Playwright version — the request goes to the
 * real (non-existent, in `vite preview`) endpoint and comes back 404
 * instead of hitting this mock, with no error surfaced anywhere.
 */
export async function mockWordPress(page, { categories = [{ id: 1, name: "Field Manual" }] } = {}) {
  const calls = [];
  await page.route("**/api/wordpress-post", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === "testConnection") {
      return route.fulfill({ json: { success: true, name: "Demo User", id: 1 } });
    }
    if (body.action === "getCategories") {
      return route.fulfill({ json: { success: true, categories } });
    }
    if (body.action === "uploadMedia") {
      return route.fulfill({ json: { success: true, mediaId: 4242, url: "https://example.com/wp-content/uploads/headline.jpg" } });
    }
    if (body.action === "createPost" || body.action === "updatePost") {
      return route.fulfill({ json: { success: true, postId: 99, url: "https://example.com/?p=99" } });
    }
    return route.fulfill({ json: { error: `unmocked action: ${body.action}` } });
  });
  return calls;
}
