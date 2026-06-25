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

  let dataUrl;
  try {
    const body = await req.json();
    dataUrl = body.dataUrl;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body", detail: e.message }), { status: 400, headers: CORS });
  }

  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return new Response(JSON.stringify({ error: "dataUrl (base64 data URI) is required" }), { status: 400, headers: CORS });
  }

  // Netlify Functions have a ~6MB request body limit on most plans
  if (dataUrl.length > 5_500_000) {
    return new Response(JSON.stringify({ error: `Image too large (${Math.round(dataUrl.length/1024)}KB encoded) — Netlify Functions cap request bodies around 6MB. Try a smaller/more compressed image.` }), { status: 413, headers: CORS });
  }

  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return new Response(JSON.stringify({ error: "Invalid data URL format" }), { status: 400, headers: CORS });

  const mimeType = match[1];
  const base64   = match[2];

  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  } catch (e) {
    return new Response(JSON.stringify({ error: "Failed to decode base64", detail: e.message }), { status: 400, headers: CORS });
  }

  const id = `img_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  try {
    const store = getStore("blog-bunker-images");
    await store.set(id, bytes, { metadata: { mimeType } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Netlify Blobs write failed", detail: e.message, stack: (e.stack||"").slice(0,500) }), { status: 500, headers: CORS });
  }

  const publicUrl = `https://blogbunker.netlify.app/api/get-image?id=${id}`;
  return new Response(JSON.stringify({ url: publicUrl, id }), { status: 200, headers: CORS });
};

export const config = { path: "/api/upload-image" };
