/**
 * netlify/functions/meta-video-post.js
 * Background function for posting VIDEO to Instagram (as a Reel — single video
 * posts to Instagram now go through media_type=REELS per Meta's current API).
 *
 * Instagram has to download and process the video before it can publish it —
 * Meta's own docs say this typically takes 30s to 2min but can take several
 * minutes for larger files, and recommend polling for up to 5 minutes. That's
 * far past a regular sync function's ~26s ceiling, so — same as AI Restyle —
 * this runs as a background function (up to 15 min) and the client polls
 * meta-video-post-status.js for the result instead of waiting on this response.
 *
 * POST /api/meta-video-post
 * { jobId, instagramId, pageToken, message, videoUrl }
 * → 202 immediately (body discarded) — result written to the "video-post-jobs"
 *   Blobs store under jobId: { status: "processing"|"success"|"error", ... }
 */

import { getStore } from "@netlify/blobs";

export default async (req) => {
  let body;
  try { body = await req.json(); }
  catch { return; } // nothing to report to — client is polling by jobId, so just bail

  const { jobId, instagramId, pageToken, message, videoUrl } = body;
  if (!jobId) return;

  const store = getStore("video-post-jobs");
  await store.setJSON(jobId, { status: "processing" });

  try {
    if (!videoUrl)     throw new Error("videoUrl is required");
    if (!instagramId)  throw new Error("instagramId is required");
    if (!pageToken)     throw new Error("pageToken is required");

    // Step 1: create the REELS container — single video posts to Instagram's
    // feed now go through media_type=REELS (per Meta's own current docs; a
    // plain media_type=VIDEO container still works for some accounts but
    // REELS is what Meta documents as the correct path today).
    const containerRes = await fetch(`https://graph.facebook.com/v25.0/${instagramId}/media`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url:  videoUrl,
        caption:    message,
        access_token: pageToken,
      }),
    });
    const containerData = await containerRes.json();
    if (containerData.error) {
      throw new Error(`Instagram container: ${containerData.error.message} (code ${containerData.error.code})`);
    }
    const containerId = containerData.id;

    // Step 2: poll until Instagram has finished processing the video. Meta
    // recommends polling for up to 5 minutes — we check every 8s for up to
    // ~13 minutes, leaving headroom under the 15-minute background function
    // ceiling for the publish step itself.
    let statusCode = null;
    const maxPolls = 95; // ~13 minutes at 8s intervals
    for (let i = 0; i < maxPolls; i++) {
      const statusRes = await fetch(
        `https://graph.facebook.com/v25.0/${containerId}?fields=status_code&access_token=${pageToken}`
      );
      const statusData = await statusRes.json();
      if (statusData.error) throw new Error(`Instagram status check: ${statusData.error.message} (code ${statusData.error.code})`);
      statusCode = statusData.status_code;
      if (statusCode === "FINISHED") break;
      if (statusCode === "ERROR") throw new Error("Instagram failed to process the video — check the video format (MP4/MOV, H.264) and that it's under 90 seconds for Reels eligibility.");
      await store.setJSON(jobId, { status: "processing", detail: `Instagram is processing the video (${statusCode || "pending"})…` });
      await new Promise(r => setTimeout(r, 8000));
    }
    if (statusCode !== "FINISHED") {
      throw new Error("Instagram is still processing the video after several minutes — try again shortly, or check the video isn't unusually large.");
    }

    // Step 3: publish
    const publishRes = await fetch(`https://graph.facebook.com/v25.0/${instagramId}/media_publish`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ creation_id: containerId, access_token: pageToken }),
    });
    const publishData = await publishRes.json();
    if (publishData.error) throw new Error(`Instagram publish: ${publishData.error.message} (code ${publishData.error.code})`);

    await store.setJSON(jobId, { status: "success", id: publishData.id });

  } catch(e) {
    await store.setJSON(jobId, { status: "error", error: e.message });
  }
};

export const config = { path: "/api/meta-video-post", background: true };
