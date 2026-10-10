/**
 * netlify/functions/ext.js  —  POST /api/ext
 * Backend for the Blog Bunker Chrome extension (Operative feature).
 *
 * Extension actions (authenticated with a pairing token in the body):
 *   whoami     -> { workspaces:[{id,name}], expiresAt }
 *   summarize  -> { summary:{tldr,key_points,angles,tags} }   (counts against the word allowance)
 *   save       -> drops the summary in the user's inbox for the chosen workspace
 * App actions (same userId trust model as /api/data):
 *   createToken / revokeTokens / status
 *   drain / ack -> the app moves inbox items into the right Inspiration board
 *
 * Saves go to an INBOX that the app drains, rather than editing the user's
 * Inspiration list here: the app pushes its whole list to the cloud on every
 * change, so a server-side edit would be silently overwritten the next time
 * the app saved.
 */
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";
import { trimWords, SUMMARY_SYSTEM, buildSummaryUser, parseSummary } from "../lib/article.js";
import { checkAllowance, recordUsage } from "../lib/metering.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;
const DAILY_SUMMARY_LIMIT = 60;
const MAX_INBOX = 200;
const SUMMARY_CACHE_MS = 7 * 24 * 3600 * 1000;
const MODEL = "claude-haiku-4-5-20251001";
const sha = (t) => createHash("sha256").update(t).digest("hex");
const clip = (s, n) => String(s ?? "").slice(0, n);

async function callClaude(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("AI isn't configured on the server.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `AI request failed (${res.status})`);
  return { text: data.content?.map(c => c.text || "").join("") || "", tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) };
}

async function workspacesFor(store, userId) {
  const list = (await store.get(`${userId}:workspaces`, { type: "json" })) || [];
  const main = (await store.get(`${userId}:ws_settings`, { type: "json" })) || {};
  return [{ id: "default", name: main.name || "Main workspace" }, ...list.filter(w => w?.id && w.id !== "default").map(w => ({ id: w.id, name: w.name || "Workspace" }))];
}

async function authToken(store, token) {
  if (typeof token !== "string" || !token.startsWith("bbx_")) return null;
  const rec = await store.get(`exttoken:${sha(token)}`, { type: "json" });
  if (!rec || !rec.userId || Date.now() > rec.expiresAt) return null;
  return rec;
}

export async function handle(req, deps = {}) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const store = deps.store || getStore("blog-bunker-data");
  const ai = deps.ai || callClaude;
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const { action } = body;

  try {
    // ── App-side actions ───────────────────────────────────────────────────
    if (["createToken", "revokeTokens", "status", "drain", "ack"].includes(action)) {
      const userId = clip(body.userId, 200);
      if (!userId) return json({ error: "userId required" }, 400);

      if (action === "createToken") {
        const tier = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
        if (!body.operative && tier !== "operative") return json({ error: "The Chrome extension is an Operative feature.", code: "tier" }, 403);
        const token = "bbx_" + randomBytes(32).toString("base64url");
        const hash = sha(token);
        await store.setJSON(`exttoken:${hash}`, { userId, createdAt: Date.now(), expiresAt: Date.now() + TOKEN_TTL_MS });
        const list = ((await store.get(`${userId}:ext_tokens`, { type: "json" })) || []).filter(Boolean);
        await store.setJSON(`${userId}:ext_tokens`, [...list, hash].slice(-5)); // keep a handful of devices
        return json({ token, expiresAt: Date.now() + TOKEN_TTL_MS });
      }
      if (action === "status") {
        const list = (await store.get(`${userId}:ext_tokens`, { type: "json" })) || [];
        let active = 0;
        for (const h of list) { const r = await store.get(`exttoken:${h}`, { type: "json" }); if (r && Date.now() < r.expiresAt) active++; }
        return json({ paired: active });
      }
      if (action === "revokeTokens") {
        const list = (await store.get(`${userId}:ext_tokens`, { type: "json" })) || [];
        for (const h of list) await store.delete(`exttoken:${h}`);
        await store.setJSON(`${userId}:ext_tokens`, []);
        return json({ success: true });
      }
      if (action === "drain") {
        const wsId = clip(body.workspaceId || "default", 100);
        const { blobs = [] } = await store.list({ prefix: `${userId}:extinbox:` });
        const items = [];
        for (const b of blobs.slice(0, MAX_INBOX)) {
          const rec = await store.get(b.key, { type: "json" });
          if (rec && (rec.workspaceId || "default") === wsId) items.push({ id: b.key.slice(`${userId}:extinbox:`.length), target: rec.target, item: rec.item });
        }
        return json({ items });
      }
      if (action === "ack") {
        for (const id of (Array.isArray(body.ids) ? body.ids : []).slice(0, MAX_INBOX)) await store.delete(`${userId}:extinbox:${clip(id, 100).replace(/[^\w.-]/g, "")}`);
        return json({ success: true });
      }
    }

    // ── Extension-side actions (token) ─────────────────────────────────────
    if (["whoami", "summarize", "save"].includes(action)) {
      const rec = await authToken(store, body.token);
      if (!rec) return json({ error: "This extension isn't connected (or its code expired). Generate a new code in Blog Bunker → Settings → Chrome Extension.", code: "auth" }, 401);
      const userId = rec.userId;

      if (action === "whoami") return json({ workspaces: await workspacesFor(store, userId), expiresAt: rec.expiresAt });

      if (action === "summarize") {
        // Same article text already summarized for this user in the last week:
        // hand back the stored summary instead of paying for the AI again
        // (covers re-opening the popup, a second browser, or a second click).
        const textForHash = clip(body.text, 80000);
        const contentKey = `${userId}:ext_sum_${sha(clip(body.title, 300) + "\n" + textForHash.slice(0, 20000)).slice(0, 32)}`;
        if (!body.fresh) {
          const hit = await store.get(contentKey, { type: "json" });
          if (hit && hit.summary && Date.now() - hit.at < SUMMARY_CACHE_MS) return json({ summary: hit.summary, cached: true });
        }
        const day = new Date().toISOString().slice(0, 10);
        const rateKey = `${userId}:ext_rate_${day}`;
        const n = ((await store.get(rateKey, { type: "json" })) || { n: 0 }).n;
        if (n >= DAILY_SUMMARY_LIMIT) return json({ error: `Daily extension limit reached (${DAILY_SUMMARY_LIMIT} summaries). Try again tomorrow.` }, 429);
        const allowance = await checkAllowance(store, userId);
        if (!allowance.ok) return json({ error: `Monthly AI word limit reached (${allowance.cap.toLocaleString()} words). Buy more words in Settings → Billing & Plan, or wait until next month.` }, 429);

        const text = clip(body.text, 80000);
        if (text.split(/\s+/).length < 60) return json({ error: "Not enough text on this page to summarize. Try selecting the article text first.", code: "short" }, 422);
        const { text: raw, tokens } = await ai(SUMMARY_SYSTEM, buildSummaryUser({ title: clip(body.title, 300), siteName: clip(body.siteName, 100), text: trimWords(text) }));
        await recordUsage(store, userId, tokens);
        await store.setJSON(rateKey, { n: n + 1 });
        const summary = parseSummary(raw);
        await store.setJSON(contentKey, { summary, at: Date.now() });
        return json({ summary });
      }

      if (action === "save") {
        const wsId = clip(body.workspaceId || "default", 100);
        const wss = await workspacesFor(store, userId);
        if (!wss.some(w => w.id === wsId)) return json({ error: "Unknown workspace." }, 400);
        const target = body.target === "social" ? "social" : "blog";
        const s = body.summary || {};
        const notes = [
          clip(s.tldr, 900),
          Array.isArray(s.key_points) && s.key_points.length ? "Key points:\n" + s.key_points.slice(0, 6).map(p => `• ${clip(p, 300)}`).join("\n") : "",
          Array.isArray(s.angles) && s.angles.length ? "Angles to try:\n" + s.angles.slice(0, 3).map(p => `→ ${clip(p, 300)}`).join("\n") : "",
          body.url ? `Source: ${clip(body.url, 500)}` : "",
        ].filter(Boolean).join("\n\n");
        const id = `ext-${Date.now()}-${randomBytes(3).toString("hex")}`;
        const { blobs = [] } = await store.list({ prefix: `${userId}:extinbox:` });
        if (blobs.length >= MAX_INBOX) return json({ error: "Your extension inbox is full — open Blog Bunker to collect the saved items first." }, 429);
        await store.setJSON(`${userId}:extinbox:${id}`, {
          workspaceId: wsId, target,
          item: { id, title: clip(body.title, 300) || "Untitled article", source: clip(body.siteName, 100) || "Chrome extension", type: "article", notes, url: clip(body.url, 500), fromExtension: true },
        });
        return json({ success: true });
      }
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
}

export default (req) => handle(req);
export const config = { path: "/api/ext" };
