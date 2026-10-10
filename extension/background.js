// Runs the summarize request OUTSIDE the popup. Chrome closes a popup the
// instant focus leaves it, which used to kill an in-flight request (words
// still spent, result lost) and forced a rescan on return. Here the request
// finishes regardless, and the result is stored under the page's cache key so
// reopening the popup shows it instantly without another AI call.
const TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_ENTRIES = 40;
const PENDING_STALE_MS = 150000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "summarize") { run(msg).finally(() => { try { sendResponse({ ok: true }); } catch {} }); return true; }
  return false;
});

async function run({ entryKey, base, token, payload, fresh }) {
  const k = "sum:" + entryKey;
  const cur = (await chrome.storage.local.get(k))[k];
  const live = cur && (cur.status === "done" || (cur.status === "pending" && Date.now() - cur.at < PENDING_STALE_MS));
  if (live && !fresh) return;                        // already summarized, or already on its way
  await chrome.storage.local.set({ [k]: { status: "pending", at: Date.now() } });
  try {
    const res = await fetch(base + "/api/ext", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action: "summarize", fresh: !!fresh, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code });
    await chrome.storage.local.set({ [k]: { status: "done", at: Date.now(), summary: data.summary, cached: !!data.cached, meta: { title: payload.title, siteName: payload.siteName } } });
  } catch (e) {
    await chrome.storage.local.set({ [k]: { status: "error", at: Date.now(), error: e.message || "Couldn't summarize this page.", code: e.code } });
  }
  prune();
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([key]) => key.startsWith("sum:")).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const drop = entries.filter(([, v], i) => i >= MAX_ENTRIES || Date.now() - (v.at || 0) > TTL_MS).map(([key]) => key);
  if (drop.length) await chrome.storage.local.remove(drop);
}
