/**
 * netlify/functions/extract-url.js
 * POST /api/extract { url } -> { title, siteName, author, published, text, wordCount, url }
 *
 * Fetches a public article and returns its readable text. It does NOT call any
 * AI — the app summarizes client-side through its normal callAI path so the
 * user's chosen provider, BYOK keys and word allowance all behave exactly as
 * they do everywhere else.
 */
import { safeFetchHtml, extractArticle, trimWords } from "../lib/article.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let url;
  try { ({ url } = await req.json()); } catch { return json({ error: "Invalid request." }, 400); }
  if (!url || typeof url !== "string") return json({ error: "Paste a link to an article.", code: "bad_url" }, 400);
  try {
    const { html, finalUrl } = await safeFetchHtml(url.trim());
    const art = extractArticle(html, finalUrl);
    if (art.wordCount < 120) {
      return json({ error: "Couldn't find enough article text on that page (it may be paywalled, or loaded by script). Paste the text instead.", code: "needs_text", title: art.title, siteName: art.siteName }, 422);
    }
    return json({ ...art, text: trimWords(art.text) });
  } catch (e) {
    return json({ error: e.message || "Couldn't read that page.", code: e.code || "unreachable" }, e.code === "needs_text" ? 422 : 400);
  }
};

export const config = { path: "/api/extract" };
