/**
 * netlify/functions/gcs.js
 * Google Cloud Storage proxy for Blog Bunker media.
 * Replaces Netlify Blobs for image storage.
 *
 * POST   /api/gcs          { userId, dataUrl, name, tags, notes, source } → { id, url, item }
 * GET    /api/gcs?userId=x → { items: [{id, url, name, tags, ...}] }
 * DELETE /api/gcs?userId=x&id=y → { success }
 * PATCH  /api/gcs          { userId, id, name, tags, notes } → { success }
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const BUCKET  = process.env.GCS_BUCKET || "blogbunker-media";
const GCS_API = "https://storage.googleapis.com";

// Get a GCS access token using the service account credentials
async function getGCSToken() {
  const creds = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON || "{}");
  if (!creds.private_key) throw new Error("GCS_SERVICE_ACCOUNT_JSON not configured");

  const now  = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  // Create JWT
  const header  = btoa(JSON.stringify({ alg:"RS256", typ:"JWT" })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const payload = btoa(JSON.stringify(claim)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const toSign  = `${header}.${payload}`;

  // Sign with RSA-SHA256
  const pemKey = creds.private_key;
  const keyData = pemKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(toSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const jwt = `${toSign}.${signature}`;

  // Exchange JWT for access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`GCS auth: ${data.error_description || data.error}`);
  return data.access_token;
}

// Make a public URL for a GCS object
function publicUrl(objectName) {
  return `${GCS_API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectName)}?alt=media`;
}

// Store metadata in Netlify Blobs (small JSON, not images)
const metaStore = () => getStore("blog-bunker-data");

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);

  try {
    // ── LIST ──────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const userId = url.searchParams.get("userId") || "anonymous";
      const store  = metaStore();
      const meta   = await store.get(`${userId}:media_library`, { type: "json" }) || [];
      return new Response(JSON.stringify({ items: meta }), { status: 200, headers: CORS });
    }

    // ── UPLOAD ────────────────────────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json();
      const { userId = "anonymous", dataUrl, name, tags = [], notes = "", source = "generated" } = body;
      if (!dataUrl) return new Response(JSON.stringify({ error: "dataUrl required" }), { status: 400, headers: CORS });

      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) return new Response(JSON.stringify({ error: "Invalid data URL" }), { status: 400, headers: CORS });

      const mimeType   = match[1];
      const base64Data = match[2];
      const bytes      = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const ext        = mimeType.split("/")[1] || "jpg";
      const id         = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;

      // Upload to GCS
      const token  = await getGCSToken();
      const upload = await fetch(`${GCS_API}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(id)}`, {
        method:  "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": mimeType, "Content-Length": bytes.length },
        body:    bytes,
      });
      if (!upload.ok) {
        const err = await upload.text();
        throw new Error(`GCS upload failed: ${upload.status} — ${err.slice(0,200)}`);
      }

      // Make object public
      await fetch(`${GCS_API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(id)}/iam`, {
        method:  "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }] }),
      });

      const itemUrl = `${GCS_API}/${BUCKET}/${id}`;

      // Save metadata
      const store    = metaStore();
      const existing = await store.get(`${userId}:media_library`, { type: "json" }) || [];
      const newItem  = { id, url: itemUrl, name: name || id.split("/").pop(), type: mimeType, size: bytes.length, tags, notes, source, createdAt: new Date().toISOString() };
      await store.setJSON(`${userId}:media_library`, [newItem, ...existing]);

      return new Response(JSON.stringify({ id, url: itemUrl, item: newItem }), { status: 200, headers: CORS });
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const userId = url.searchParams.get("userId") || "anonymous";
      const id     = url.searchParams.get("id");
      if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: CORS });

      // Delete from GCS
      try {
        const token = await getGCSToken();
        await fetch(`${GCS_API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(id)}`, {
          method: "DELETE", headers: { "Authorization": `Bearer ${token}` },
        });
      } catch {}

      // Remove from metadata
      const store    = metaStore();
      const existing = await store.get(`${userId}:media_library`, { type: "json" }) || [];
      await store.setJSON(`${userId}:media_library`, existing.filter(i => i.id !== id));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    }

    // ── PATCH (update metadata) ───────────────────────────────────────────────
    if (req.method === "PATCH") {
      const body = await req.json();
      const { userId = "anonymous", id, ...patch } = body;
      if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: CORS });
      const store    = metaStore();
      const existing = await store.get(`${userId}:media_library`, { type: "json" }) || [];
      await store.setJSON(`${userId}:media_library`, existing.map(i => i.id === id ? { ...i, ...patch } : i));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });
  } catch(e) {
    console.error("[gcs]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/gcs" };
