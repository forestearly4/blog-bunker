/**
 * netlify/functions/social-scheduler.js
 * Runs every 15 minutes via Netlify cron.
 * Checks Netlify Blobs for scheduled social posts that are due,
 * publishes them to Facebook/Instagram, and marks them as published.
 */

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "*/15 * * * *",
};

// Convert a data: URL to a public https:// URL via Netlify Blobs
async function ensurePublicImageUrl(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("https://")) return imageUrl;
  if (!imageUrl.startsWith("data:")) return null;

  const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1];
  const base64   = match[2];
  const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const id       = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const imgStore = getStore("blog-bunker-images");
  await imgStore.set(id, bytes, { metadata: { mimeType } });

  return `https://blogbunker.netlify.app/api/get-image?id=${id}`;
}

export default async () => {
  const now = new Date();
  console.log(`[social-scheduler] Running at ${now.toISOString()}`);

  const store = getStore("blog-bunker-data");
  let published = 0;
  let errors = 0;
  let checked = 0;

  try {
    // List all keys to find users with social posts
    const listResult = await store.list();
    const allKeys = listResult?.blobs?.map(b => b.key) || listResult?.keys || [];
    console.log(`[social-scheduler] Found ${allKeys.length} total keys`);

    const socialPostKeys = allKeys.filter(k => k.endsWith(":social_posts") || k.includes(":social_posts"));
    console.log(`[social-scheduler] Found ${socialPostKeys.length} social post key(s):`, socialPostKeys);

    for (const key of socialPostKeys) {
      const userId = key.replace(/:social_posts$/, "");
      let posts;

      try {
        // Use get() with type:"json" — matches how data.js writes with setJSON()
        posts = await store.get(key, { type: "json" });
        if (!posts || !Array.isArray(posts)) {
          console.log(`[social-scheduler] No valid posts array for key ${key}`);
          continue;
        }
        console.log(`[social-scheduler] User ${userId} has ${posts.length} post(s)`);
      } catch(e) {
        console.error(`[social-scheduler] Failed to load posts for ${key}:`, e.message);
        continue;
      }

      // Get Meta credentials for this user
      let metaConfig = null;
      try {
        metaConfig = await store.get(`${userId}:meta_config`, { type: "json" });
        console.log(`[social-scheduler] Meta config for ${userId}: connected=${metaConfig?.connected}, pages=${metaConfig?.pages?.length || 0}`);
      } catch {
        console.log(`[social-scheduler] No meta config for ${userId}`);
      }

      const updatedPosts = [...posts];
      let anyUpdated = false;

      for (let i = 0; i < updatedPosts.length; i++) {
        const post = updatedPosts[i];
        if (post.status !== "scheduled") continue;
        if (!post.scheduledAt) continue;

        const scheduledAt = new Date(post.scheduledAt);
        checked++;
        console.log(`[social-scheduler] Post ${post.id}: scheduledAt=${post.scheduledAt}, due=${scheduledAt <= now}`);

        if (scheduledAt > now) continue;

        console.log(`[social-scheduler] Publishing post ${post.id} to platforms: ${post.platforms?.join(", ")}`);

        const results = {};
        const platforms = post.platforms || [];

        for (const platId of platforms) {
          try {
            const captionRaw = post.captions?.[platId];
            const caption = typeof captionRaw === "string" ? captionRaw : (captionRaw?.text || "");
            const fullMessage = [caption, post.hashtags].filter(Boolean).join("\n\n").trim();

            // Convert data: URLs to public https:// before sending to Meta
            let imageUrl = null;
            if (post.imageUrl) {
              try {
                imageUrl = await ensurePublicImageUrl(post.imageUrl);
                console.log(`[social-scheduler] Image URL resolved: ${imageUrl?.slice(0, 80)}`);
              } catch(e) {
                console.error(`[social-scheduler] Image conversion failed:`, e.message);
              }
            }

            if (platId === "facebook" && metaConfig?.pages?.length > 0) {
              const page = metaConfig.pages[0];
              const endpoint = imageUrl
                ? `https://graph.facebook.com/v19.0/${page.id}/photos`
                : `https://graph.facebook.com/v19.0/${page.id}/feed`;
              const body = imageUrl
                ? { url: imageUrl, caption: fullMessage, access_token: page.access_token }
                : { message: fullMessage, access_token: page.access_token };
              const res = await fetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
              const data = await res.json();
              if (data.error) throw new Error(`${data.error.message} (code ${data.error.code})`);
              results[platId] = { success: true, id: data.id };
              published++;
              console.log(`[social-scheduler] ✓ Posted to Facebook: ${data.id}`);

            } else if (platId === "instagram" && metaConfig?.pages?.some(p=>p.instagram_id)) {
              if (!imageUrl) {
                console.log(`[social-scheduler] Skipping Instagram — no public image URL`);
                results[platId] = { success: false, error: "No public https:// image URL" };
                continue;
              }
              const page = metaConfig.pages.find(p => p.instagram_id);
              const cRes = await fetch(`https://graph.facebook.com/v19.0/${page.instagram_id}/media`, {
                method:"POST", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ image_url: imageUrl, caption: fullMessage, access_token: page.access_token })
              });
              const cData = await cRes.json();
              if (cData.error) throw new Error(`Container: ${cData.error.message} (${cData.error.code})`);
              const pRes = await fetch(`https://graph.facebook.com/v19.0/${page.instagram_id}/media_publish`, {
                method:"POST", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ creation_id: cData.id, access_token: page.access_token })
              });
              const pData = await pRes.json();
              if (pData.error) throw new Error(`Publish: ${pData.error.message} (${pData.error.code})`);
              results[platId] = { success: true, id: pData.id };
              published++;
              console.log(`[social-scheduler] ✓ Posted to Instagram: ${pData.id}`);

            } else {
              console.log(`[social-scheduler] Platform ${platId} not connected — skipping`);
              results[platId] = { success: false, error: "Not connected" };
            }
          } catch(e) {
            console.error(`[social-scheduler] Error posting to ${platId}:`, e.message);
            results[platId] = { success: false, error: e.message };
            errors++;
          }
        }

        // Determine new status
        const anySuccess = Object.values(results).some(r => r.success === true);
        const allFailed  = Object.values(results).every(r => r.success === false);

        updatedPosts[i] = {
          ...post,
          status:      anySuccess ? "published" : allFailed ? "failed" : "scheduled",
          publishedAt: anySuccess ? now.toISOString() : post.publishedAt,
          results:     { ...(post.results || {}), ...results },
          // Reschedule 30 min ahead if all platforms failed (avoid immediate retry loop)
          scheduledAt: allFailed && !anySuccess
            ? new Date(now.getTime() + 30 * 60 * 1000).toISOString()
            : post.scheduledAt,
        };
        anyUpdated = true;
      }

      // Write updated posts back
      if (anyUpdated) {
        await store.setJSON(key, updatedPosts);
        console.log(`[social-scheduler] Updated ${key} in Blobs`);
      }
    }
  } catch(e) {
    console.error("[social-scheduler] Fatal error:", e.message, e.stack?.slice(0,500));
  }

  console.log(`[social-scheduler] Done — checked: ${checked}, published: ${published}, errors: ${errors}`);
};
