/**
 * netlify/functions/meta-video-post-status.js
 * Client polls this to check on an Instagram video post started via
 * meta-video-post.js's background job.
 *
 * GET /api/meta-video-post-status?jobId=...
 * → { status: "processing"|"success"|"error", id?, error?, detail? }
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

  const store  = getStore("video-post-jobs");
  const result = await store.get(jobId, { type: "json" });

  if (!result) return new Response(JSON.stringify({ status: "processing" }), { status: 200, headers: CORS });
  return new Response(JSON.stringify(result), { status: 200, headers: CORS });
};

export const config = { path: "/api/meta-video-post-status" };
