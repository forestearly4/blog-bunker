/**
 * netlify/functions/gcs-signed-url.js
 * Generates a GCS signed upload URL so the browser can upload large files
 * (images, videos) directly to GCS without routing through Netlify's 6MB limit.
 *
 * POST /api/gcs-signed-url
 * { userId, fileName, mimeType, size, name, tags, notes, source }
 * → { uploadUrl, objectId, publicUrl }
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const BUCKET  = process.env.GCS_BUCKET || "blogbunker-media";
const GCS_API = "https://storage.googleapis.com";

async function getGCSToken() {
  const creds = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON || "{}");
  if (!creds.private_key) throw new Error("GCS_SERVICE_ACCOUNT_JSON not configured");
  const now   = Math.floor(Date.now() / 1000);
  const claim = { iss: creds.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_write", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };
  const header  = btoa(JSON.stringify({ alg:"RS256", typ:"JWT" })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const payload = btoa(JSON.stringify(claim)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const toSign  = `${header}.${payload}`;
  const keyData = creds.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g,"");
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(toSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const jwt = `${toSign}.${signature}`;
  const res = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body: new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const data = await res.json();
  if (data.error) throw new Error(`GCS auth: ${data.error_description}`);
  return data.access_token;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status:204, headers:CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status:405, headers:CORS });

  try {
    const body = await req.json();
    const { userId = "anonymous", fileName, mimeType, size, name, tags = [], notes = "", source = "upload" } = body;
    if (!fileName || !mimeType) return new Response(JSON.stringify({ error:"fileName and mimeType required" }), { status:400, headers:CORS });

    const ext      = fileName.split(".").pop() || "bin";
    const objectId = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;
    const token    = await getGCSToken();

    // Initiate a resumable upload session — get back a session URI
    const initRes = await fetch(
      `${GCS_API}/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=${encodeURIComponent(objectId)}`,
      {
        method:  "POST",
        headers: {
          "Authorization":           `Bearer ${token}`,
          "Content-Type":            "application/json",
          "X-Upload-Content-Type":   mimeType,
          "X-Upload-Content-Length": size || 0,
        },
        body: JSON.stringify({ name: objectId, contentType: mimeType }),
      }
    );

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`GCS session init failed (${initRes.status}): ${err.slice(0,200)}`);
    }

    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) throw new Error("No upload session URL returned from GCS");

    const publicUrl = `${GCS_API}/${BUCKET}/${objectId}`;
    const mediaType = mimeType.startsWith("video/") ? "video" : "image";

    // Pre-save metadata stub — will be confirmed after upload completes
    const store    = getStore("blog-bunker-data");
    const existing = await store.get(`${userId}:media_library`, { type:"json" }) || [];
    const item     = {
      id:        objectId,
      url:       publicUrl,
      name:      name || fileName.replace(/\.[^.]+$/, ""),
      type:      mimeType,
      size:      size || 0,
      tags,
      notes,
      source,
      mediaType,
      status:    "uploading",
      createdAt: new Date().toISOString(),
    };
    await store.setJSON(`${userId}:media_library`, [item, ...existing]);

    return new Response(JSON.stringify({ uploadUrl, objectId, publicUrl, item }), { status:200, headers:CORS });

  } catch(e) {
    console.error("[gcs-signed-url]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers:CORS });
  }
};

export const config = { path: "/api/gcs-signed-url" };
