/**
 * netlify/functions/meta-post.js
 * Posts to Facebook Page and/or Instagram Business account
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

  // Validate image URL — must be a real https:// URL, not base64 or blob
  const isValidImageUrl = imageUrl && imageUrl.startsWith("https://");

  // ── POST TO FACEBOOK PAGE ──────────────────────────────────────────────────
  if (platforms.includes("facebook") && pageId && pageToken) {
    try {
      if (imageUrl) {
        if (!isValidImageUrl) throw new Error(`Image URL must be a public https:// URL. Got: ${imageUrl.slice(0,50)}…`);
        const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: imageUrl, caption: message, access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook: ${data.error.message} (code ${data.error.code})`);
        results.facebook = { success: true, id: data.id };
      } else {
        const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, ...(link ? { link } : {}), access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook: ${data.error.message} (code ${data.error.code})`);
        results.facebook = { success: true, id: data.id };
      }
    } catch(e) {
      results.facebook = { success: false, error: e.message };
    }
  }

  // ── POST TO INSTAGRAM ──────────────────────────────────────────────────────
  if (platforms.includes("instagram") && instagramId && pageToken) {
    try {
      if (!imageUrl) throw new Error("Instagram requires an image — generate one first.");
      if (!isValidImageUrl) throw new Error(`Image URL must be a public https:// URL for Instagram. Got: ${imageUrl.slice(0,80)}`);

      // Verify instagramId looks correct (should NOT be same as pageId)
      if (instagramId === pageId) throw new Error("instagramId appears to be the same as pageId — check your Instagram Business Account ID in Settings → Facebook & Instagram.");

      // Step 1: Create media container
      const containerPayload = { image_url: imageUrl, caption: message, access_token: pageToken };
      console.log("Instagram container payload:", JSON.stringify({ ...containerPayload, access_token:"[redacted]", image_url: imageUrl.slice(0,80) }));

      const containerRes = await fetch(`https://graph.facebook.com/v19.0/${instagramId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(containerPayload),
      });
      const containerData = await containerRes.json();
      console.log("Instagram container response:", JSON.stringify(containerData));

      if (containerData.error) {
        throw new Error(`Instagram container error: ${containerData.error.message} (code ${containerData.error.code}, subcode ${containerData.error.error_subcode || "none"})`);
      }

      // Step 2: Publish
      const publishRes = await fetch(`https://graph.facebook.com/v19.0/${instagramId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: containerData.id, access_token: pageToken }),
      });
      const publishData = await publishRes.json();
      console.log("Instagram publish response:", JSON.stringify(publishData));

      if (publishData.error) {
        throw new Error(`Instagram publish error: ${publishData.error.message} (code ${publishData.error.code})`);
      }
      results.instagram = { success: true, id: publishData.id };

    } catch(e) {
      results.instagram = { success: false, error: e.message };
    }
  }

  return new Response(JSON.stringify(results), { status: 200, headers: CORS });
};

export const config = { path: "/api/meta-post" };
