/**
 * netlify/functions/data.js
 * Generic key-value storage API backed by Netlify Blobs.
 * Used to persist Blog Bunker data server-side (survives localStorage clearing).
 *
 * GET    /api/data?key=posts&userId=abc123      → read
 * POST   /api/data  { key, userId, value }      → write
 * DELETE /api/data?key=posts&userId=abc123       → delete
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const store  = getStore("blog-bunker-data");

  try {
    if (req.method === "GET") {
      const key    = url.searchParams.get("key");
      const userId = url.searchParams.get("userId") || "anonymous";
      if (!key) return new Response(JSON.stringify({ error: "key is required" }), { status: 400, headers: CORS });

      const data = await store.get(`${userId}:${key}`, { type: "json" });
      return new Response(JSON.stringify({ value: data ?? null }), { status: 200, headers: CORS });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { key, userId = "anonymous", value } = body;
      if (!key) return new Response(JSON.stringify({ error: "key is required" }), { status: 400, headers: CORS });

      await store.setJSON(`${userId}:${key}`, value);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    }

    if (req.method === "DELETE") {
      const key    = url.searchParams.get("key");
      const userId = url.searchParams.get("userId") || "anonymous";
      if (!key) return new Response(JSON.stringify({ error: "key is required" }), { status: 400, headers: CORS });

      await store.delete(`${userId}:${key}`);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/data" };
