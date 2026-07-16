/**
 * netlify/functions/media.js
 * Media Library storage backed by Netlify Blobs.
 * Stores image binary data + metadata separately so images survive
 * across devices without hitting localStorage size limits.
 *
 * POST   /api/media           { userId, dataUrl, name, tags, notes } → { id, url }
 * GET    /api/media?userId=x  → { items: [{id, url, name, tags, ...}] }
 * DELETE /api/media?userId=x&id=y → { success }
 * PATCH  /api/media           { userId, id, name, tags, notes } → { success }
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const BASE_URL = "https://blogbunker.netlify.app";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url      = new URL(req.url);
  const imgStore = getStore("blog-bunker-images");
  const metaStore= getStore("blog-bunker-data");

  try {
    // ── LIST: GET /api/media?userId=x ──────────────────────────────────────
    if (req.method === "GET") {
      const userId = url.searchParams.get("userId") || "anonymous";
      const meta = await metaStore.get(`${userId}:media_library`, { type: "json" });
      const items = (meta || []).map(item => ({
        ...item,
        url: `${BASE_URL}/api/get-image?id=${item.id}`,
      }));
      return new Response(JSON.stringify({ items }), { status: 200, headers: CORS });
    }

    // ── SAVE: POST /api/media ───────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json();
      const { userId = "anonymous", dataUrl, name, tags = [], notes = "", source = "generated" } = body;

      if (!dataUrl) return new Response(JSON.stringify({ error: "dataUrl required" }), { status: 400, headers: CORS });

      // Parse base64
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) return new Response(JSON.stringify({ error: "Invalid data URL" }), { status: 400, headers: CORS });

      const mimeType = match[1];
      const base64   = match[2];
      const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

      // Store binary image
      const id = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await imgStore.set(id, bytes, { metadata: { mimeType } });

      // Update metadata list
      const existing = await metaStore.get(`${userId}:media_library`, { type: "json" }) || [];
      const newItem = {
        id,
        name:      name || `image-${Date.now()}`,
        type:      mimeType,
        size:      bytes.length,
        tags,
        notes,
        source,
        createdAt: new Date().toISOString(),
      };
      await metaStore.setJSON(`${userId}:media_library`, [newItem, ...existing]);

      return new Response(JSON.stringify({
        id,
        url: `${BASE_URL}/api/get-image?id=${id}`,
        item: { ...newItem, url: `${BASE_URL}/api/get-image?id=${id}` },
      }), { status: 200, headers: CORS });
    }

    // ── DELETE: DELETE /api/media?userId=x&id=y ─────────────────────────────
    if (req.method === "DELETE") {
      const userId = url.searchParams.get("userId") || "anonymous";
      const id     = url.searchParams.get("id");
      if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: CORS });

      // Delete binary
      try { await imgStore.delete(id); } catch {}

      // Remove from metadata list
      const existing = await metaStore.get(`${userId}:media_library`, { type: "json" }) || [];
      await metaStore.setJSON(`${userId}:media_library`, existing.filter(i => i.id !== id));

      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    }

    // ── UPDATE METADATA: PATCH /api/media ───────────────────────────────────
    if (req.method === "PATCH") {
      const body = await req.json();
      const { userId = "anonymous", id, ...patch } = body;
      if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: CORS });

      const existing = await metaStore.get(`${userId}:media_library`, { type: "json" }) || [];
      const updated  = existing.map(item => item.id === id ? { ...item, ...patch } : item);
      await metaStore.setJSON(`${userId}:media_library`, updated);

      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });
  } catch(e) {
    console.error("[media]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/media" };
