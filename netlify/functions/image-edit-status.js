/**
 * netlify/functions/image-edit-status.js
 * Polled by the client to check on an AI Restyle background job started via image-edit.js.
 *
 * GET /api/image-edit-status?jobId=xxx
 * → { status: "pending" } | { status: "done", b64, mimeType } | { status: "error", error }
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url   = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return new Response(JSON.stringify({ error: "jobId required" }), { status: 400, headers: CORS });

  try {
    const store  = getStore("image-jobs");
    const result = await store.get(jobId, { type: "json" });
    // Not found yet just means the background function hasn't written its first
    // status update — treat as still pending rather than an error.
    if (!result) return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: CORS });
    return new Response(JSON.stringify(result), { status: 200, headers: CORS });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/image-edit-status" };
