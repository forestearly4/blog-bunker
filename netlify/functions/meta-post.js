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

  const { pageId, pageToken, instagramId, message, imageUrl, imageUrls, mediaType = "image", link, platforms = ["facebook"] } = body;
  const results = {};
  const isCarousel = Array.isArray(imageUrls) && imageUrls.length > 1;

  // Convert data: or blob: URLs to a real hosted https:// URL via Netlify Blobs
  async function ensurePublicUrl(url) {
    if (!url) return null;
    if (url.startsWith("https://")) return url; // already public
    
    // Extract base64 data from data: URL
    let dataUrl = url;
    const match = dataUrl.match(/^data:(image\/\w+|video\/\w+);base64,(.+)$/);
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
      if (isCarousel) {
        // Facebook's multi-photo mechanism is different from Instagram's:
        // upload each photo as unpublished first (published:false gives back
        // a photo id without posting it standalone), then create one feed
        // post that references all of them via attached_media.
        const photoIds = [];
        for (const url of imageUrls) {
          const publicUrl = await ensurePublicUrl(url);
          const res = await fetch(`https://graph.facebook.com/v25.0/${pageId}/photos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: publicUrl, published: false, access_token: pageToken }),
          });
          const data = await res.json();
          if (data.error) throw new Error(`Facebook (carousel photo): ${data.error.message} (code ${data.error.code})`);
          photoIds.push(data.id);
        }
        const attached_media = photoIds.map(id => ({ media_fbid: id }));
        const res = await fetch(`https://graph.facebook.com/v25.0/${pageId}/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, attached_media, access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook (carousel post): ${data.error.message} (code ${data.error.code})`);
        results.facebook = { success: true, id: data.id };
      } else if (imageUrl && mediaType === "video") {
        // Video posts use the /videos endpoint with file_url (Facebook fetches
        // and processes the video server-side after accepting the post — this
        // doesn't block the API response the way Instagram's container model
        // does, so no polling needed here).
        const publicUrl = await ensurePublicUrl(imageUrl);
        const res = await fetch(`https://graph.facebook.com/v25.0/${pageId}/videos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_url: publicUrl, description: message, access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook: ${data.error.message} (code ${data.error.code})`);
        results.facebook = { success: true, id: data.id };
      } else if (imageUrl) {
        const publicUrl = await ensurePublicUrl(imageUrl);
        const res = await fetch(`https://graph.facebook.com/v25.0/${pageId}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: publicUrl, caption: message, access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook: ${data.error.message} (code ${data.error.code})`);
        results.facebook = { success: true, id: data.id };
      } else {
        const res = await fetch(`https://graph.facebook.com/v25.0/${pageId}/feed`, {
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
      if (!imageUrl && !isCarousel) throw new Error("Instagram requires an image or video — generate/select one first.");
      if (instagramId === pageId) throw new Error("instagramId appears to be the same as pageId — check Settings → Facebook & Instagram.");
      if (mediaType === "video") throw new Error("Video posts to Instagram should use /api/meta-video-post (video processing takes too long for this endpoint) — this is a client-side routing bug if you're seeing this.");

      let creationId;

      if (isCarousel) {
        if (imageUrls.length > 10) throw new Error("Instagram carousels support a maximum of 10 images.");

        // Step 1: create one child item container per image. Each is flagged
        // is_carousel_item — no caption on these, the caption goes on the
        // parent container in step 2.
        const childIds = [];
        for (const url of imageUrls) {
          const publicUrl = await ensurePublicUrl(url);
          const res = await fetch(`https://graph.facebook.com/v25.0/${instagramId}/media`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_url: publicUrl, is_carousel_item: true, access_token: pageToken }),
          });
          const data = await res.json();
          if (data.error) throw new Error(`Instagram (carousel item): ${data.error.message} (code ${data.error.code})`);
          childIds.push(data.id);
        }

        // Step 2: create the parent carousel container referencing all child
        // IDs. Retry on the same transient "not ready" error as publishing
        // below — a child container can still be processing when we try to
        // reference it here, exactly like the final publish step can hit.
        let parentData;
        for (let attempt = 1; attempt <= 4; attempt++) {
          const res = await fetch(`https://graph.facebook.com/v25.0/${instagramId}/media`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ media_type: "CAROUSEL", children: childIds, caption: message, access_token: pageToken }),
          });
          parentData = await res.json();
          if (!parentData.error) break;
          if (parentData.error.code === 9007 && attempt < 4) {
            await new Promise(r => setTimeout(r, 1500 * attempt));
            continue;
          }
          throw new Error(`Instagram (carousel container): ${parentData.error.message} (code ${parentData.error.code})`);
        }
        creationId = parentData.id;

      } else {
        const publicUrl = await ensurePublicUrl(imageUrl);
        console.log("Instagram posting with URL:", publicUrl?.slice(0, 80));

        // Step 1: Create media container
        const containerRes = await fetch(`https://graph.facebook.com/v25.0/${instagramId}/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: publicUrl, caption: message, access_token: pageToken }),
        });
        const containerData = await containerRes.json();
        if (containerData.error) {
          throw new Error(`Instagram container: ${containerData.error.message} (code ${containerData.error.code})`);
        }
        creationId = containerData.id;
      }

      // Step 2/3: Publish — retry on the well-documented transient "Media ID is
      // not available" (code 9007 / subcode 2207027) error, which just means
      // Instagram hasn't finished processing the container yet. Every major
      // social tool (Buffer, Agorapulse, Statusbrew, etc.) handles this the
      // same way: wait a moment and try again — it almost always succeeds
      // within a few attempts. Kept short (this is a sync function with a
      // ~10-26s ceiling) — image containers process fast, unlike video.
      let publishData;
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const publishRes = await fetch(`https://graph.facebook.com/v25.0/${instagramId}/media_publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creation_id: creationId, access_token: pageToken }),
        });
        publishData = await publishRes.json();

        const isMediaNotReady = publishData.error?.code === 9007;
        if (!publishData.error) break; // success
        if (isMediaNotReady && attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1500 * attempt)); // 1.5s, 3s, 4.5s backoff
          continue;
        }
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
