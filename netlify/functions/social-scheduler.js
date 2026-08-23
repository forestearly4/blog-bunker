/**
 * netlify/functions/social-scheduler.js
 * Runs every 15 minutes via Netlify cron.
 *
 * RACE CONDITION FIX:
 * Before publishing, immediately writes status="publishing" back to Blobs.
 * Any concurrent scheduler instance will see "publishing" and skip the post.
 * This prevents duplicate posts when Netlify fires the cron multiple times.
 */

import { getStore } from "@netlify/blobs";

export const config = { schedule: "0 * * * *" };

async function ensurePublicImageUrl(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("https://")) return imageUrl;
  if (!imageUrl.startsWith("data:")) return null;
  const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const bytes    = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  const id       = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const imgStore = getStore("blog-bunker-images");
  await imgStore.set(id, bytes, { metadata: { mimeType } });
  return `https://blogbunker.netlify.app/api/get-image?id=${id}`;
}

async function postToFacebook(page, fullMessage, imageUrl, mediaType = "image") {
  const endpoint = imageUrl
    ? `https://graph.facebook.com/v25.0/${page.id}/${mediaType === "video" ? "videos" : "photos"}`
    : `https://graph.facebook.com/v25.0/${page.id}/feed`;
  const body = imageUrl
    ? (mediaType === "video"
        ? { file_url: imageUrl, description: fullMessage, access_token: page.access_token }
        : { url: imageUrl, caption: fullMessage, access_token: page.access_token })
    : { message: fullMessage, access_token: page.access_token };
  const res  = await fetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error.message} (code ${data.error.code})`);
  return data.id;
}

async function postToInstagram(page, fullMessage, imageUrl, mediaType = "image") {
  if (!imageUrl) throw new Error("Instagram requires a public image or video URL");

  if (mediaType === "video") {
    // Video needs the background-job flow (processing can take minutes) —
    // this cron function shouldn't block waiting on it. Fire it off and let
    // it run; the post is marked as "processing" and will need a follow-up
    // check (not yet automated — see meta-video-post-status.js for manual checks).
    const jobId = `vidpost_sched_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await fetch("https://blogbunker.netlify.app/api/meta-video-post", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jobId, instagramId: page.instagram_id, pageToken: page.access_token, message: fullMessage, videoUrl: imageUrl }),
    });
    throw new Error(`Video posting started (job ${jobId}) — Instagram video processing takes a few minutes and isn't fully automated for scheduled posts yet. Check back or post manually if it doesn't appear.`);
  }

  const cRes  = await fetch(`https://graph.facebook.com/v25.0/${page.instagram_id}/media`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ image_url: imageUrl, caption: fullMessage, access_token: page.access_token }),
  });
  const cData = await cRes.json();
  if (cData.error) throw new Error(`Container: ${cData.error.message} (${cData.error.code})`);

  // Retry on the well-documented transient "Media ID is not available" (code
  // 9007) error — the container hasn't finished processing yet. Same fix as
  // meta-post.js's immediate-publish path; kept short since this isn't a
  // background function.
  let pData;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pRes = await fetch(`https://graph.facebook.com/v25.0/${page.instagram_id}/media_publish`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ creation_id: cData.id, access_token: page.access_token }),
    });
    pData = await pRes.json();
    if (!pData.error) break;
    if (pData.error.code === 9007 && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`Publish: ${pData.error.message} (${pData.error.code})`);
  }
  return pData.id;
}

export default async () => {
  const now = new Date();
  console.log(`[scheduler] Running at ${now.toISOString()}`);

  const store = getStore("blog-bunker-data");
  let published = 0, errors = 0, skipped = 0;

  try {
    const listResult  = await store.list();
    const allKeys     = listResult?.blobs?.map(b => b.key) || listResult?.keys || [];
    const postKeys    = allKeys.filter(k => k.endsWith(":social_posts"));
    console.log(`[scheduler] ${postKeys.length} social post key(s)`);

    for (const key of postKeys) {
      const userId = key.replace(/:social_posts$/, "");
      let posts;
      try {
        posts = await store.get(key, { type: "json" });
        if (!Array.isArray(posts)) continue;
      } catch(e) { console.error(`[scheduler] Load failed ${key}:`, e.message); continue; }

      // Find all due posts (status must be exactly "scheduled" — not "publishing" or "published")
      const duePosts = posts
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.status === "scheduled" && p.scheduledAt && new Date(p.scheduledAt) <= now);

      if (duePosts.length === 0) continue;
      console.log(`[scheduler] ${duePosts.length} due post(s) for ${userId}`);

      // ── ATOMIC CLAIM: mark all due posts as "publishing" BEFORE doing anything ──
      // This is the key fix — any other scheduler instance will see "publishing" and skip
      const claimed = [...posts];
      for (const { i } of duePosts) {
        claimed[i] = { ...claimed[i], status: "publishing", claimedAt: now.toISOString() };
      }
      try {
        await store.setJSON(key, claimed);
        console.log(`[scheduler] Claimed ${duePosts.length} post(s) for ${userId}`);
      } catch(e) {
        console.error(`[scheduler] Failed to claim posts:`, e.message);
        continue; // Don't publish if we couldn't claim
      }

      // Get Meta credentials
      let metaConfig = null;
      try { metaConfig = await store.get(`${userId}:meta_config`, { type: "json" }); } catch {}

      // ── PUBLISH each claimed post ──
      const finalPosts = [...claimed];
      for (const { p: post, i } of duePosts) {
        const results = {};
        const platforms = post.platforms || [];

        // Resolve image URL once (shared across platforms)
        let imageUrl = null;
        if (post.imageUrl) {
          try { imageUrl = await ensurePublicImageUrl(post.imageUrl); }
          catch(e) { console.error(`[scheduler] Image URL failed:`, e.message); }
        }

        for (const platId of platforms) {
          try {
            const captionRaw  = post.captions?.[platId];
            const caption     = typeof captionRaw === "string" ? captionRaw : (captionRaw?.text || "");
            // Resolve this platform's hashtags — a manual per-platform override
            // if the user set one, otherwise the shared set. Handles legacy
            // posts saved before per-platform overrides existed (plain string).
            const baseHashtags = typeof post.hashtags === "string"
              ? post.hashtags
              : (post.hashtags?.perPlatform?.[platId] ?? post.hashtags?.selected ?? "");
            // X performs best with far fewer hashtags than other platforms — cap
            // to 2, matching the same limit enforced client-side, UNLESS the
            // user already customized this platform's hashtags specifically
            // (in which case respect their explicit choice).
            const hasCustomOverride = typeof post.hashtags === "object" && post.hashtags?.perPlatform?.[platId] != null;
            const hashtagsForPlat = (platId === "twitter" && !hasCustomOverride)
              ? baseHashtags.split(/\s+/).filter(Boolean).slice(0, 2).join(" ")
              : baseHashtags;
            const fullMessage = [caption, hashtagsForPlat].filter(Boolean).join("\n\n").trim();

            if (platId === "facebook" && metaConfig?.pages?.length > 0) {
              const id = await postToFacebook(metaConfig.pages[0], fullMessage, imageUrl, post.mediaType);
              results[platId] = { success: true, id };
              published++;
              console.log(`[scheduler] ✓ Facebook: ${id}`);

            } else if (platId === "instagram" && metaConfig?.pages?.some(p => p.instagram_id)) {
              const page = metaConfig.pages.find(p => p.instagram_id);
              const id   = await postToInstagram(page, fullMessage, imageUrl, post.mediaType);
              results[platId] = { success: true, id };
              published++;
              console.log(`[scheduler] ✓ Instagram: ${id}`);

            } else if (["twitter","tiktok","pinterest","reddit","threads","bluesky","youtube","linkedin"].includes(platId)) {
              // Buffer platforms — available on Operative and above only
              let userTier = "scout";
              try { userTier = (await store.get(`${userId}:user_tier`, { type:"json" })) || "scout"; } catch {}
              if (userTier !== "operative") {
                results[platId] = { success:false, error:"Buffer integration is available on Operative and above — upgrade in Settings → Billing & Plan" };
                continue;
              }

              // Buffer platforms — load Buffer config from Blobs
              let bufferConfig = null;
              try { bufferConfig = await store.get(`${userId}:buffer_config`, { type:"json" }); } catch {}
              const bufferApiKey = bufferConfig?.apiKey;
              const channelId    = bufferConfig?.mapping?.[platId];

              if (!bufferApiKey) {
                results[platId] = { success:false, error:"Buffer API key not configured — add it in Settings → Buffer" };
                continue;
              }
              if (!channelId) {
                results[platId] = { success:false, error:`No Buffer channel mapped for ${platId} — configure in Settings → Buffer` };
                continue;
              }
              if (platId === "pinterest" && !bufferConfig?.boardMapping?.[channelId]) {
                results[platId] = { success:false, error:"No Pinterest board selected — set one in Settings → Buffer" };
                continue;
              }

              const bufferRes = await fetch("https://blogbunker.netlify.app/api/buffer-post", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({
                  apiKey:   bufferApiKey,
                  action:   "createPost",
                  channelId,
                  text:     fullMessage,
                  imageUrl: imageUrl || "",
                  mediaType: post.mediaType || "image",
                  scheduledAt: post.scheduledAt,
                  pinterestBoardId: platId === "pinterest" ? bufferConfig?.boardMapping?.[channelId] : undefined,
                }),
              });
              const bufferData = await bufferRes.json();
              if (bufferData.error) throw new Error(bufferData.error);
              results[platId] = { success:true, id: bufferData.post?.id || "queued" };
              published++;
              console.log(`[scheduler] ✓ ${platId} via Buffer: ${bufferData.post?.id}`);

            } else {
              results[platId] = { success: false, error: "Platform not connected" };
            }
          } catch(e) {
            console.error(`[scheduler] ${platId} error:`, e.message);
            results[platId] = { success: false, error: e.message };
            errors++;
          }
        }

        const anySuccess = Object.values(results).some(r => r.success === true);
        const allFailed  = Object.values(results).every(r => r.success === false);

        finalPosts[i] = {
          ...post,
          status:      anySuccess ? "published" : allFailed ? "failed" : "partial",
          publishedAt: anySuccess ? now.toISOString() : post.publishedAt,
          results:     { ...(post.results || {}), ...results },
          // On complete failure, push 30 min ahead so it retries (but still won't double-post since status is "failed" not "scheduled")
          scheduledAt: allFailed
            ? new Date(now.getTime() + 30 * 60 * 1000).toISOString()
            : post.scheduledAt,
        };
      }

      // Write final statuses back
      await store.setJSON(key, finalPosts);
      console.log(`[scheduler] Finalized ${duePosts.length} post(s) for ${userId}`);
    }
  } catch(e) {
    console.error("[scheduler] Fatal:", e.message, e.stack?.slice(0, 500));
  }

  console.log(`[scheduler] Done — published: ${published}, errors: ${errors}, skipped: ${skipped}`);
};
