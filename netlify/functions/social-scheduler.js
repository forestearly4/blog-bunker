/**
 * netlify/functions/social-scheduler.js
 * Runs every 15 minutes via Netlify cron.
 * Checks Netlify Blobs for scheduled social posts that are due,
 * publishes them to Facebook/Instagram, and marks them as published.
 */

import { getStore } from "@netlify/blobs";

// Cron: runs every 15 minutes
export const config = {
  schedule: "*/15 * * * *",
};

export default async () => {
  console.log(`[social-scheduler] Running at ${new Date().toISOString()}`);

  const store = getStore("blog-bunker-data");
  let published = 0;
  let errors = 0;

  try {
    // List all keys to find users with social posts
    const { keys } = await store.list();
    const socialPostKeys = keys.filter(k => k.includes(":social_posts"));

    for (const key of socialPostKeys) {
      const userId = key.replace(":social_posts", "");
      let posts;

      try {
        posts = await store.get(key, { type: "json" });
        if (!posts || !Array.isArray(posts)) continue;
      } catch(e) {
        console.error(`[social-scheduler] Failed to load posts for ${userId}:`, e.message);
        continue;
      }

      // Get Meta credentials for this user
      let metaConfig;
      try {
        metaConfig = await store.get(`${userId}:meta_config`, { type: "json" });
      } catch { metaConfig = null; }

      const now = new Date();
      let updated = false;

      for (const post of posts) {
        if (post.status !== "scheduled") continue;
        if (!post.scheduledAt) continue;

        const scheduledAt = new Date(post.scheduledAt);
        if (scheduledAt > now) continue; // not due yet

        console.log(`[social-scheduler] Publishing post ${post.id} for user ${userId}`);

        const results = {};
        const platforms = post.platforms || [];

        for (const platId of platforms) {
          try {
            const captionRaw = post.captions?.[platId];
            const caption = typeof captionRaw === "string" ? captionRaw : (captionRaw?.text || "");
            const fullMessage = `${caption}\n\n${post.hashtags || ""}`.trim();
            const imageUrl = post.imageUrl?.startsWith("https://") ? post.imageUrl : null;

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
              if (data.error) throw new Error(data.error.message);
              results[platId] = { success: true, id: data.id };
              published++;

            } else if (platId === "instagram" && metaConfig?.pages?.some(p=>p.instagram_id)) {
              if (!imageUrl) { results[platId] = { success: false, error: "No public image URL — skipped" }; continue; }
              const page = metaConfig.pages.find(p => p.instagram_id);
              // Create container
              const cRes = await fetch(`https://graph.facebook.com/v19.0/${page.instagram_id}/media`, {
                method:"POST", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ image_url: imageUrl, caption: fullMessage, access_token: page.access_token })
              });
              const cData = await cRes.json();
              if (cData.error) throw new Error(cData.error.message);
              // Publish
              const pRes = await fetch(`https://graph.facebook.com/v19.0/${page.instagram_id}/media_publish`, {
                method:"POST", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ creation_id: cData.id, access_token: page.access_token })
              });
              const pData = await pRes.json();
              if (pData.error) throw new Error(pData.error.message);
              results[platId] = { success: true, id: pData.id };
              published++;

            } else {
              results[platId] = { success: false, error: "Platform not connected" };
            }
          } catch(e) {
            console.error(`[social-scheduler] Error posting to ${platId}:`, e.message);
            results[platId] = { success: false, error: e.message };
            errors++;
          }
        }

        // Update post status
        const allOk = Object.values(results).some(r => r.success === true);
        post.status = allOk ? "published" : "scheduled"; // keep scheduled if all failed
        post.publishedAt = allOk ? new Date().toISOString() : null;
        post.results = { ...post.results, ...results };
        if (!allOk) {
          // Reschedule 15 min ahead to avoid hammering on persistent errors
          post.scheduledAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
        }
        updated = true;
      }

      // Write updated posts back to Blobs
      if (updated) {
        await store.setJSON(key, posts);
        console.log(`[social-scheduler] Updated posts for user ${userId}`);
      }
    }
  } catch(e) {
    console.error("[social-scheduler] Fatal error:", e.message);
  }

  console.log(`[social-scheduler] Done — published: ${published}, errors: ${errors}`);
};
