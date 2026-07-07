/**
 * netlify/functions/meta-post.js
 * Posts to Facebook Page and/or Instagram Business account.
 * Automatically converts data: URLs to hosted Netlify Blobs URLs for Instagram.
 */

import { getStore } from "@netlify/blobs";

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

  // Convert data: or blob: URLs to a real hosted https:// URL via Netlify Blobs
  async function ensurePublicUrl(url) {
    if (!url) return null;
    if (url.startsWith("https://")) return url; // already public
    
    // Extract base64 data from data: URL
    let dataUrl = url;
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) throw new Error(`Cannot convert URL to public format: ${url.slice(0, 60)}`);
    
    const mimeType = match[1];
    const base64   = match[2];
    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const id       = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const store = getStore("blog-bunker-images");
    await store.set(id, bytes, { metadata: { mimeType } });
    
    return `https://blogbunker.netlify.app/api/get-image?id=${id}`;
  }

  // ── POST TO FACEBOOK PAGE ──────────────────────────────────────────────────
  if (platforms.includes("facebook") && pageId && pageToken) {
    try {
      if (imageUrl) {
        const publicUrl = await ensurePublicUrl(imageUrl);
        const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: publicUrl, caption: message, access_token: pageToken }),
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
      if (instagramId === pageId) throw new Error("instagramId appears to be the same as pageId — check Settings → Facebook & Instagram.");

      const publicUrl = await ensurePublicUrl(imageUrl);
      console.log("Instagram posting with URL:", publicUrl?.slice(0, 80));

      // Step 1: Create media container
      const containerRes = await fetch(`https://graph.facebook.com/v19.0/${instagramId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: publicUrl, caption: message, access_token: pageToken }),
      });
      const containerData = await containerRes.json();
      if (containerData.error) {
        throw new Error(`Instagram container: ${containerData.error.message} (code ${containerData.error.code})`);
      }

      // Step 2: Publish
      const publishRes = await fetch(`https://graph.facebook.com/v19.0/${instagramId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: containerData.id, access_token: pageToken }),
      });
      const publishData = await publishRes.json();
      if (publishData.error) {
        throw new Error(`Instagram publish: ${publishData.error.message} (code ${publishData.error.code})`);
      }
      results.instagram = { success: true, id: publishData.id };

    } catch(e) {
      results.instagram = { success: false, error: e.message };
    }
  }

  return new Response(JSON.stringify(results), { status: 200, headers: CORS });
};

export const config = { path: "/api/meta-post" };
