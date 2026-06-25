/**
 * netlify/functions/meta-post.js
 * Posts to Facebook Page and/or Instagram Business account
 * 
 * POST /api/meta-post
 * Body: { pageId, pageToken, instagramId, message, imageUrl, link, platforms }
 */

export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS });
  }

  const { pageId, pageToken, instagramId, message, imageUrl, link, platforms = ["facebook"] } = body;
  const results = {};

  // ── POST TO FACEBOOK PAGE ──────────────────────────────────────────────────
  if (platforms.includes("facebook") && pageId && pageToken) {
    try {
      const fbBody = { access_token: pageToken };
      if (imageUrl) {
        // Photo post
        fbBody.url     = imageUrl;
        fbBody.caption = message;
        const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fbBody),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        results.facebook = { success: true, id: data.id };
      } else {
        // Text/link post
        fbBody.message = message;
        if (link) fbBody.link = link;
        const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fbBody),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        results.facebook = { success: true, id: data.id };
      }
    } catch(e) {
      results.facebook = { success: false, error: e.message };
    }
  }

  // ── POST TO INSTAGRAM ──────────────────────────────────────────────────────
  // Instagram requires an image — text-only not supported
  if (platforms.includes("instagram") && instagramId && pageToken && imageUrl) {
    try {
      // Step 1: Create media container
      const containerRes = await fetch(`https://graph.facebook.com/v19.0/${instagramId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url:   imageUrl,
          caption:     message,
          access_token: pageToken,
        }),
      });
      const containerData = await containerRes.json();
      if (containerData.error) throw new Error(containerData.error.message);

      // Step 2: Publish the container
      const publishRes = await fetch(`https://graph.facebook.com/v19.0/${instagramId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creation_id:  containerData.id,
          access_token: pageToken,
        }),
      });
      const publishData = await publishRes.json();
      if (publishData.error) throw new Error(publishData.error.message);
      results.instagram = { success: true, id: publishData.id };
    } catch(e) {
      results.instagram = { success: false, error: e.message };
    }
  } else if (platforms.includes("instagram") && !imageUrl) {
    results.instagram = { success: false, error: "Instagram requires an image — generate one first." };
  }

  return new Response(JSON.stringify(results), { status: 200, headers: CORS });
};

export const config = { path: "/api/meta-post" };
