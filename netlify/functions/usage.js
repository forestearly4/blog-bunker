/**
 * netlify/functions/usage.js
 * Read-only: returns the current calendar month's platform-managed Claude text
 * usage for a user, plus their tier's cap (including any purchased top-up).
 * Used by the Billing & Plan settings panel to show a usage bar. Actual
 * tracking/enforcement happens inside claude-proxy.js/image-generate.js,
 * which are the only places that spend platform Claude/Stability credits
 * (BYOK calls go straight from the browser and are never tracked here —
 * that's the user's own key and their own cost, not Blog Bunker's).
 *
 * GET  /api/usage?userId=abc123
 *   → { period, tokensUsed, wordsUsed, tier, wordCap, imagesUsed, imageCap,
 *       wordTopUp, imageTopUp }
 * POST /api/usage { userId, action: "reset" }        → zero out this month's usage
 * POST /api/usage { userId, action: "topup", type: "words"|"images", amount } → add a top-up
 *   No real payment collection yet — this directly grants the top-up, same
 *   honest "for now, just confirms your choice" pattern as the plan picker.
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

// Top-up pack sizes and their (placeholder, no real payment yet) prices —
// keep in sync with the options shown in dashboard.jsx's Billing & Plan panel.
const TOPUP_PACKS = {
  words:  { amount: 10000, price: "$5" },
  images: { amount: 25,    price: "$5" },
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const store  = getStore("blog-bunker-data");
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const { userId, action } = body;
      if (!userId) return new Response(JSON.stringify({ error: "userId required" }), { status: 400, headers: CORS });

      // Manual reset for the current month's usage — there's no real billing
      // cycle yet to naturally reset this, so this lets a user (or Forest,
      // testing) clear their own counter rather than wait until next month.
      if (!action || action === "reset") {
        await store.setJSON(`${userId}:usage_text_${period}`, { tokens: 0 });
        await store.setJSON(`${userId}:usage_images_${period}`, { images: 0 });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
      }

      if (action === "topup") {
        const { type } = body;
        const pack = TOPUP_PACKS[type];
        if (!pack) return new Response(JSON.stringify({ error: "invalid top-up type" }), { status: 400, headers: CORS });
        const key = `${userId}:topup_${type}_${period}`;
        const current = (await store.get(key, { type: "json" })) || { amount: 0 };
        const updated = { amount: (current.amount || 0) + pack.amount };
        await store.setJSON(key, updated);
        return new Response(JSON.stringify({ success: true, newTopUp: updated.amount }), { status: 200, headers: CORS });
      }

      return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: CORS });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  const url    = new URL(req.url);
  const userId = url.searchParams.get("userId") || "anonymous";

  try {
    const textUsage   = await store.get(`${userId}:usage_text_${period}`, { type: "json" }) || { tokens: 0 };
    const imageUsage  = await store.get(`${userId}:usage_images_${period}`, { type: "json" }) || { images: 0 };
    const tier        = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
    const wordTopUp   = ((await store.get(`${userId}:topup_words_${period}`, { type: "json" })) || { amount: 0 }).amount;
    const imageTopUp  = ((await store.get(`${userId}:topup_images_${period}`, { type: "json" })) || { amount: 0 }).amount;
    const wordCap     = (WORD_CAPS[tier] || WORD_CAPS.scout) + wordTopUp;
    const imageCap    = (IMAGE_CAPS[tier] || IMAGE_CAPS.scout) + imageTopUp;
    const wordsUsed   = Math.round((textUsage.tokens || 0) / TOKENS_PER_WORD);

    return new Response(JSON.stringify({
      period, tier,
      tokensUsed: textUsage.tokens || 0, wordsUsed, wordCap, wordTopUp,
      imagesUsed: imageUsage.images || 0, imageCap, imageTopUp,
      topUpPacks: TOPUP_PACKS,
    }), { status: 200, headers: CORS });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/usage" };
