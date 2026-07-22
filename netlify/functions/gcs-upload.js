/**
 * netlify/functions/gcs-upload.js
 * Handles file uploads to GCS — both images (base64) and videos (binary).
 * Videos use GCS resumable uploads to handle large files.
 *
 * POST /api/gcs-upload
 *   For images: { userId, dataUrl, name, tags, notes, source }
 *   For videos: multipart/form-data with file field + userId, name, tags, notes
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const BUCKET   = process.env.GCS_BUCKET || "blogbunker-media";
const GCS_API  = "https://storage.googleapis.com";
const BASE_URL = "https://blogbunker.netlify.app";

async function getGCSToken() {
  const creds = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON || "{}");
  if (!creds.private_key) throw new Error("GCS_SERVICE_ACCOUNT_JSON not configured");
  const now  = Math.floor(Date.now() / 1000);
  const claim = { iss: creds.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_write", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };
  const header  = btoa(JSON.stringify({ alg:"RS256", typ:"JWT" })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const payload = btoa(JSON.stringify(claim)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const toSign  = `${header}.${payload}`;
  const pemKey  = creds.private_key;
  const keyData = pemKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(toSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const jwt = `${toSign}.${signature}`;
  const res = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body: new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const data = await res.json();
  if (data.error) throw new Error(`GCS auth: ${data.error_description || data.error}`);
  return data.access_token;
}

async function makePublic(token, objectId) {
  await fetch(`${GCS_API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectId)}/iam`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bindings: [{ role:"roles/storage.objectViewer", members:["allUsers"] }] }),
  });
}

async function saveMetadata(userId, item) {
  const store    = getStore("blog-bunker-data");
  const existing = await store.get(`${userId}:media_library`, { type:"json" }) || [];
  await store.setJSON(`${userId}:media_library`, [item, ...existing]);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status:204, headers:CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status:405, headers:CORS });

  try {
    const contentType = req.headers.get("content-type") || "";

    // ── IMAGE: base64 JSON body ─────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      const body = await req.json();
      const { userId = "anonymous", dataUrl, name, tags = [], notes = "", source = "upload" } = body;
      if (!dataUrl) return new Response(JSON.stringify({ error:"dataUrl required" }), { status:400, headers:CORS });

      const match = dataUrl.match(/^data:([\w/]+);base64,(.+)$/);
      if (!match) return new Response(JSON.stringify({ error:"Invalid data URL" }), { status:400, headers:CORS });

      const mimeType = match[1];
      const bytes    = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
      const ext      = mimeType.split("/")[1]?.split("+")[0] || "bin";
      const id       = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;
      const token    = await getGCSToken();

      const upload = await fetch(`${GCS_API}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": mimeType, "Content-Length": bytes.length },
        body: bytes,
      });
      if (!upload.ok) throw new Error(`GCS upload failed: ${upload.status}`);
      await makePublic(token, id);

      const item = { id, url:`${GCS_API}/${BUCKET}/${id}`, name: name || id.split("/").pop(), type: mimeType, size: bytes.length, tags, notes, source, mediaType: mimeType.startsWith("video/") ? "video" : "image", createdAt: new Date().toISOString() };
      await saveMetadata(userId, item);
      return new Response(JSON.stringify({ id, url: item.url, item }), { status:200, headers:CORS });
    }

    // ── VIDEO: multipart form data ──────────────────────────────────────────
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file     = formData.get("file");
      const userId   = formData.get("userId") || "anonymous";
      const name     = formData.get("name")   || file?.name?.replace(/\.[^.]+$/, "") || "video";
      const tags     = JSON.parse(formData.get("tags") || "[]");
      const notes    = formData.get("notes")  || "";
      const source   = formData.get("source") || "upload";

      if (!file) return new Response(JSON.stringify({ error:"file required" }), { status:400, headers:CORS });

      const mimeType = file.type || "video/mp4";
      const ext      = file.name?.split(".").pop() || "mp4";
      const id       = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;
      const token    = await getGCSToken();
      const buffer   = await file.arrayBuffer();
      const bytes    = new Uint8Array(buffer);

      // Use resumable upload for large files
      const initRes = await fetch(`${GCS_API}/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": bytes.length },
        body: JSON.stringify({ name: id, contentType: mimeType }),
      });
      if (!initRes.ok) throw new Error(`GCS resumable init failed: ${initRes.status}`);
      const uploadUrl = initRes.headers.get("location");
      if (!uploadUrl) throw new Error("No upload URL from GCS");

      const uploadRes = await fetch(uploadUrl, {
        method:  "PUT",
        headers: { "Content-Type": mimeType, "Content-Length": bytes.length },
        body:    bytes,
      });
      if (!uploadRes.ok) throw new Error(`GCS video upload failed: ${uploadRes.status}`);
      await makePublic(token, id);

      const item = { id, url:`${GCS_API}/${BUCKET}/${id}`, name, type: mimeType, size: bytes.length, tags, notes, source, mediaType: "video", createdAt: new Date().toISOString() };
      await saveMetadata(userId, item);
      return new Response(JSON.stringify({ id, url: item.url, item }), { status:200, headers:CORS });
    }

    return new Response(JSON.stringify({ error:"Unsupported content type" }), { status:415, headers:CORS });

  } catch(e) {
    console.error("[gcs-upload]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers:CORS });
  }
};

export const config = { path: "/api/gcs-upload" };
