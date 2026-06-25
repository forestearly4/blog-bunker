/**
 * netlify/functions/upload-image.js
 * Accepts a base64 image, stores it in Netlify Blobs, returns a public URL.
 * Used for Instagram posting, which requires a publicly fetchable image URL
 * (blob: URLs from the browser don't work — Instagram's servers can't reach them).
 *
 * POST /api/upload-image  { dataUrl: "data:image/png;base64,..." }
 * Returns: { url: "https://blogbunker.netlify.app/api/get-image?id=xxx" }
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });

  try {
    const { dataUrl } = await req.json();
    if (!dataUrl || !dataUrl.startsWith("data:")) {
      return new Response(JSON.stringify({ error: "dataUrl (base64 data URI) is required" }), { status: 400, headers: CORS });
    }

    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return new Response(JSON.stringify({ error: "Invalid data URL format" }), { status: 400, headers: CORS });

    const mimeType = match[1];
    const base64   = match[2];
    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

    const id    = `img_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const store = getStore("blog-bunker-images");
    await store.set(id, bytes, { metadata: { mimeType } });

    const publicUrl = `https://blogbunker.netlify.app/api/get-image?id=${id}`;
    return new Response(JSON.stringify({ url: publicUrl, id }), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/upload-image" };
