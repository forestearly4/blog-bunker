// Blog Bunker extension popup. All server text is rendered with textContent —
// never innerHTML — because summaries are derived from untrusted web pages.
const $ = (id) => document.getElementById(id);
const store = {
  get: () => chrome.storage.local.get(["base", "token", "workspaces", "lastWorkspace", "lastTarget"]),
  set: (v) => chrome.storage.local.set(v),
  clear: () => chrome.storage.local.clear(),
};
let cfg = {}, pageData = null, summary = null;

function say(msg, isError = false) { const el = $("status"); el.textContent = msg || ""; el.className = isError ? "error" : ""; }

async function api(body) {
  let res;
  try {
    res = await fetch(cfg.base + "/api/ext", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: cfg.token, ...body }) });
  } catch { throw new Error("Couldn't reach Blog Bunker. Check your connection."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.code = data.code; throw e; }
  return data;
}

function parsePairing(code) {
  const raw = String(code || "").trim();
  if (!raw.startsWith("bbpair:")) throw new Error("That doesn't look like a pairing code.");
  let obj; try { obj = JSON.parse(atob(raw.slice(7))); } catch { throw new Error("That pairing code is damaged — copy it again."); }
  const u = new URL(obj.u);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) throw new Error("Pairing codes must come from a secure (https) Blog Bunker address.");
  if (!String(obj.t || "").startsWith("bbx_")) throw new Error("That pairing code is invalid.");
  return { base: u.origin, token: obj.t };
}

// Runs inside the page (activeTab grants this for the click only).
function readPage() {
  const sel = String(window.getSelection ? window.getSelection() : "").trim();
  const candidates = [...document.querySelectorAll("article, main, [role=main], .entry-content, .post-content, .article-body")];
  let best = document.body;
  let bestLen = 0;
  for (const el of candidates) { const l = (el.innerText || "").length; if (l > bestLen) { best = el; bestLen = l; } }
  const meta = (n) => (document.querySelector(`meta[property="${n}"],meta[name="${n}"]`) || {}).content || "";
  const wordsIn = (t) => t.split(/\s+/).filter(Boolean).length;
  const usingSelection = wordsIn(sel) >= 60;
  return {
    title: meta("og:title") || document.title || "",
    siteName: meta("og:site_name") || location.hostname.replace(/^www\./, ""),
    url: location.href,
    text: (usingSelection ? sel : best.innerText || "").slice(0, 80000),
    usingSelection,
  };
}

async function loadPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("Open a web article first, then click the icon.");
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
  return result;
}

function fillList(el, items, tag) {
  el.textContent = "";
  for (const t of items) { const n = document.createElement(tag); n.textContent = t; el.appendChild(n); }
}

async function showMain() {
  $("view-connect").hidden = true; $("view-main").hidden = false; $("disconnect").hidden = false;
  const sel = $("workspace"); sel.textContent = "";
  for (const w of cfg.workspaces || []) { const o = document.createElement("option"); o.value = w.id; o.textContent = w.name; sel.appendChild(o); }
  if (cfg.lastWorkspace && (cfg.workspaces || []).some(w => w.id === cfg.lastWorkspace)) sel.value = cfg.lastWorkspace;
  if (cfg.lastTarget) $("target").value = cfg.lastTarget;
  try {
    pageData = await loadPage();
    const box = $("page"); box.textContent = "";
    const b = document.createElement("b"); b.textContent = pageData.title || pageData.url;
    const s = document.createElement("span"); s.textContent = pageData.usingSelection ? `${pageData.siteName} · using your selected text` : pageData.siteName;
    box.append(b, s);
  } catch (e) { say(e.message, true); $("summarize").disabled = true; }
  // Refresh the workspace list in the background (new workspaces appear without re-pairing).
  api({ action: "whoami" }).then(async d => {
    if (JSON.stringify(d.workspaces) !== JSON.stringify(cfg.workspaces)) { cfg.workspaces = d.workspaces; await store.set({ workspaces: d.workspaces }); showMainWorkspaces(); }
  }).catch(e => { if (e.code === "auth") { say(e.message, true); } });
}
function showMainWorkspaces() {
  const sel = $("workspace"), cur = sel.value; sel.textContent = "";
  for (const w of cfg.workspaces || []) { const o = document.createElement("option"); o.value = w.id; o.textContent = w.name; sel.appendChild(o); }
  if (cur) sel.value = cur;
}

$("connect").onclick = async () => {
  say("");
  try {
    const { base, token } = parsePairing($("code").value);
    cfg = { base, token };
    const d = await api({ action: "whoami" });
    cfg.workspaces = d.workspaces;
    await store.set(cfg);
    await showMain();
    say("Connected.");
  } catch (e) { cfg = {}; say(e.message, true); }
};

$("disconnect").onclick = async () => {
  await store.clear(); cfg = {}; summary = null;
  $("view-main").hidden = true; $("result").hidden = true; $("disconnect").hidden = true; $("view-connect").hidden = false; $("code").value = "";
  say("Disconnected from this browser. Use “Disconnect all browsers” in Blog Bunker settings to fully revoke the code.");
};

$("summarize").onclick = async () => {
  if (!pageData) return;
  const btn = $("summarize"); btn.disabled = true; say("Summarizing…"); $("result").hidden = true;
  try {
    const d = await api({ action: "summarize", text: pageData.text, title: pageData.title, siteName: pageData.siteName });
    summary = d.summary;
    $("tldr").textContent = summary.tldr;
    fillList($("points"), summary.key_points, "li");
    $("angles-box").hidden = !summary.angles.length;
    fillList($("angles"), summary.angles.map(a => "→ " + a), "div");
    $("result").hidden = false; say("");
  } catch (e) { say(e.message, true); }
  btn.disabled = false;
};

$("save").onclick = async () => {
  if (!summary) return;
  const btn = $("save"); btn.disabled = true; say("Saving…");
  try {
    const workspaceId = $("workspace").value, target = $("target").value;
    await api({ action: "save", workspaceId, target, title: pageData.title, siteName: pageData.siteName, url: pageData.url, summary });
    await store.set({ lastWorkspace: workspaceId, lastTarget: target });
    say("✓ Saved. It will appear on that workspace's Inspiration board next time Blog Bunker is open.");
  } catch (e) { say(e.message, true); }
  btn.disabled = false;
};

(async function init() {
  cfg = await store.get();
  if (cfg.base && cfg.token) await showMain(); else $("view-connect").hidden = false;
})();
