import { getStore } from "@netlify/blobs";

// Same word caps as TIER_CONFIG in dashboard.jsx — keep in sync if changed there.
const WORD_CAPS = { scout: 15000, operative: 60000 };
const TOKENS_PER_WORD = 1.333; // rough inverse of the usual ~0.75 words/token

export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status: 405, headers: CORS });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500, headers: CORS });

  try {
    const parsed = JSON.parse(await req.text());
    // userId travels alongside the normal Anthropic request body so this proxy
    // can check/track platform-managed usage — stripped out before forwarding
    // to Anthropic, which doesn't expect it.
    const { userId, ...anthropicBody } = parsed;
    const store  = getStore("blog-bunker-data");
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM

    // ── Check usage against the caller's tier cap BEFORE spending a real call ──
    // Only meaningful for logged-in users going through this platform-managed
    // path — BYOK calls never reach this function at all (they go straight from
    // the browser to Anthropic with the user's own key), so this only ever caps
    // Blog Bunker's own Claude spend, never a user's own key usage.
    if (userId) {
      const tier    = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
      const cap     = WORD_CAPS[tier] || WORD_CAPS.scout;
      const capTokens = Math.round(cap * TOKENS_PER_WORD);
      const usage   = await store.get(`${userId}:usage_text_${period}`, { type: "json" }) || { tokens: 0 };
      if ((usage.tokens || 0) >= capTokens) {
        return new Response(JSON.stringify({
          error: `Monthly AI word limit reached (${cap.toLocaleString()} words on your current plan). Upgrade your plan for more, add your own API key in Settings → API Keys, or wait until next month.`,
        }), { status: 429, headers: CORS });
      }
    }

    // Detect if web_search tool is requested — needs beta header
    const hasWebSearch = (anthropicBody.tools || []).some(t => t.type?.includes("web_search") || t.name === "web_search");

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        ...(hasWebSearch ? { "anthropic-beta": "web-search-2025-03-05" } : {}),
      },
      body: JSON.stringify(anthropicBody),
    });

    const text = await upstream.text();

    // ── Record real usage from Anthropic's own response (accurate token counts,
    // not an estimate) — only on a successful call, and only for tracked users.
    if (userId && upstream.ok) {
      try {
        const data = JSON.parse(text);
        const spentTokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
        if (spentTokens > 0) {
          const usage = await store.get(`${userId}:usage_text_${period}`, { type: "json" }) || { tokens: 0 };
          await store.setJSON(`${userId}:usage_text_${period}`, { tokens: (usage.tokens || 0) + spentTokens });
        }
      } catch { /* don't fail the actual response over a tracking hiccup */ }
    }

    // Return raw text — let client parse it
    return new Response(text, {
      status:  upstream.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch(err) {
    return new Response(JSON.stringify({ error:"Proxy error", detail: err.message }), { status: 502, headers: CORS });
  }
};

export const config = { path: "/api/claude" };
