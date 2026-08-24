/**
 * netlify/functions/buffer-post.js
 * Posts to Buffer's GraphQL API — single endpoint covers X, TikTok,
 * Pinterest, Instagram, Facebook, Reddit, Threads, Bluesky, YouTube.
 *
 * POST /api/buffer-post
 * { apiKey, channels: [{channelId, text, imageUrl?, scheduledAt?}] }
 */

import { getStore } from "@netlify/blobs";
import { Jimp } from "jimp";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const BUFFER_GQL = "https://api.buffer.com";

// TikTok caps images at this total pixel count (width × height) — the
// equivalent of 1920×1080, but enforced as a pixel BUDGET rather than a
// fixed shape, so any aspect ratio is fine as long as it fits under this.
// Confirmed via the actual error TikTok/Buffer returns when it's exceeded.
const TIKTOK_MAX_PIXELS = 2073600;

// Downscales an image to fit TikTok's pixel budget if it's over, preserving
// aspect ratio, and re-hosts it via the same image-hosting mechanism already
// used elsewhere in the app (get-image.js) so Buffer gets a real, fetchable
// URL back. Leaves the image untouched (and returns the original URL) if it's
// already within budget — this only ever downscales, never upscales.
async function resizeForTikTokIfNeeded(imageUrl) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return imageUrl; // can't check it — let Buffer/TikTok's own validation catch it
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;
    const pixelCount = width * height;
    if (pixelCount <= TIKTOK_MAX_PIXELS) return imageUrl; // already fits

    const scale = Math.sqrt(TIKTOK_MAX_PIXELS / pixelCount);
    const newWidth  = Math.floor(width * scale);
    const newHeight = Math.floor(height * scale);
    image.resize({ w: newWidth, h: newHeight });

    const resizedBuffer = await image.getBuffer("image/jpeg");
    const id = `tiktok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const store = getStore("blog-bunker-images");
    await store.set(id, resizedBuffer, { metadata: { mimeType: "image/jpeg" } });

    console.log(`[buffer-post] resized image for TikTok: ${width}x${height} (${pixelCount} px) → ${newWidth}x${newHeight}`);
    return `https://blogbunker.netlify.app/api/get-image?id=${id}`;
  } catch(e) {
    console.error("[buffer-post] TikTok resize failed, using original image:", e.message);
    return imageUrl; // fail open — better to try the original than block the whole post
  }
}

async function bufferQuery(apiKey, query, variables = {}) {
  const res = await fetch(BUFFER_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body:    JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

// Get account + org ID
const GET_ACCOUNT = `
  query GetAccount {
    account {
      id
      email
      name
      organizations {
        id
        name
      }
    }
  }
`;

// Fetch channels for an org
const GET_CHANNELS = `
  query GetChannels($input: ChannelsInput!) {
    channels(input: $input) {
      id
      name
      service
      serviceId
      avatar
    }
  }
`;

// Fetch a Pinterest channel's boards (required to publish a pin)
const GET_PINTEREST_BOARDS = `
  query GetChannelBoards($input: ChannelInput!) {
    channel(input: $input) {
      metadata {
        ... on PinterestMetadata {
          boards { serviceId name }
        }
      }
    }
  }
`;

// Create a post on a specific channel
const CREATE_POST = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id dueAt } }
      ... on MutationError { message }
    }
  }
`;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status: 405, headers: CORS });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error:"Invalid JSON" }), { status: 400, headers: CORS }); }

  const { apiKey, action, channelId, text, imageUrl, mediaType = "image", platform, scheduledAt, organizationId, pinterestBoardId } = body;

  if (!apiKey) return new Response(JSON.stringify({ error:"apiKey required" }), { status: 400, headers: CORS });

  try {
    // ── GET CHANNELS ────────────────────────────────────────────────────────
    if (action === "getChannels") {
      // Step 1: get org ID
      const accountData = await bufferQuery(apiKey, GET_ACCOUNT);
      const orgId = accountData?.account?.organizations?.[0]?.id;
      if (!orgId) throw new Error("No organization found on this Buffer account. Make sure you are the org owner.");
      // Step 2: get channels for that org
      const data = await bufferQuery(apiKey, GET_CHANNELS, { input: { organizationId: orgId } });
      return new Response(JSON.stringify({
        channels: data.channels || [],
        orgId,
        account: accountData.account,
      }), { status: 200, headers: CORS });
    }

    // ── GET PINTEREST BOARDS (needed before a Pinterest post can publish) ──────
    if (action === "getPinterestBoards") {
      if (!channelId) return new Response(JSON.stringify({ error:"channelId required" }), { status: 400, headers: CORS });
      const data = await bufferQuery(apiKey, GET_PINTEREST_BOARDS, { input: { id: channelId } });
      return new Response(JSON.stringify({ boards: data.channel?.metadata?.boards || [] }), { status: 200, headers: CORS });
    }

    // ── CREATE POST ─────────────────────────────────────────────────────────
    if (action === "createPost") {
      if (!channelId || !text) return new Response(JSON.stringify({ error:"channelId and text required" }), { status: 400, headers: CORS });

      // TikTok rejects images over its pixel-count budget outright — resize
      // proportionally before it ever reaches Buffer/TikTok's own validation.
      // Only applies to images (video has separate, different constraints
      // and isn't what this specific error is about).
      let finalImageUrl = imageUrl;
      if (platform === "tiktok" && imageUrl?.startsWith("https://") && mediaType !== "video") {
        finalImageUrl = await resizeForTikTokIfNeeded(imageUrl);
      }

      // Per Buffer schema (May 2026): assets is required, even if empty
      const assets = finalImageUrl?.startsWith("https://")
        ? [mediaType === "video" ? { video: { url: finalImageUrl } } : { image: { url: finalImageUrl } }]
        : [];
      const input = {
        channelId,
        text,
        schedulingType: "automatic",
        mode: scheduledAt ? "customScheduled" : "addToQueue",
        ...(scheduledAt ? { dueAt: new Date(scheduledAt).toISOString() } : {}),
        assets,
        // Pinterest requires a board — without this, Buffer accepts the post but
        // fails to actually publish it ("no Pinterest board was selected")
        ...(pinterestBoardId ? { metadata: { pinterest: { boardServiceId: pinterestBoardId } } } : {}),
      };

      const data = await bufferQuery(apiKey, CREATE_POST, { input });
      const result = data.createPost;
      if (result?.message) throw new Error(result.message); // MutationError
      return new Response(JSON.stringify({ success: true, post: result?.post }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error:`Unknown action: ${action}` }), { status: 400, headers: CORS });

  } catch(e) {
    console.error("[buffer-post]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/buffer-post" };
