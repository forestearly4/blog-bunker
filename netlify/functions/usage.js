/**
 * netlify/functions/usage.js
 * Read-only: returns the current calendar month's platform-managed Claude text
 * usage for a user, plus their tier's cap. Used by the Billing & Plan settings
 * panel to show a usage bar. Actual tracking/enforcement happens inside
 * claude-proxy.js, which is the only place that spends platform Claude credits
 * (BYOK calls go straight from the browser and are never tracked here — that's
 * the user's own key and their own cost, not Blog Bunker's).
 *
 * GET /api/usage?userId=abc123 → { period, tokensUsed, wordsUsed, tier, wordCap }
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

// Same caps as TIER_CONFIG in dashboard.jsx — keep in sync if changed there.
const WORD_CAPS  = { scout: 15000, operative: 60000 };
const IMAGE_CAPS = { scout: 20, operative: 100 };
const TOKENS_PER_WORD = 1.333; // rough inverse of the usual ~0.75 words/token

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const store  = getStore("blog-bunker-data");
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Manual reset for the current month's usage — there's no real billing
  // cycle yet to naturally reset this, so this lets a user (or Forest,
  // testing) clear their own counter rather than wait until next month.
  if (req.method === "POST") {
    try {
      const { userId } = await req.json();
      if (!userId) return new Response(JSON.stringify({ error: "userId required" }), { status: 400, headers: CORS });
      await store.setJSON(`${userId}:usage_text_${period}`, { tokens: 0 });
      await store.setJSON(`${userId}:usage_images_${period}`, { images: 0 });
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  const url    = new URL(req.url);
  const userId = url.searchParams.get("userId") || "anonymous";

  try {
    const textUsage  = await store.get(`${userId}:usage_text_${period}`, { type: "json" }) || { tokens: 0 };
    const imageUsage = await store.get(`${userId}:usage_images_${period}`, { type: "json" }) || { images: 0 };
    const tier       = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
    const wordCap    = WORD_CAPS[tier] || WORD_CAPS.scout;
    const imageCap   = IMAGE_CAPS[tier] || IMAGE_CAPS.scout;
    const wordsUsed  = Math.round((textUsage.tokens || 0) / TOKENS_PER_WORD);

    return new Response(JSON.stringify({
      period, tier,
      tokensUsed: textUsage.tokens || 0, wordsUsed, wordCap,
      imagesUsed: imageUsage.images || 0, imageCap,
    }), { status: 200, headers: CORS });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/usage" };
