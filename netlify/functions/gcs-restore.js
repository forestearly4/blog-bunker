/**
 * netlify/functions/gcs-restore.js
 * Scans GCS bucket for userId files and rebuilds Netlify Blobs metadata.
 * Supports scanning multiple userId prefixes and merging results.
 *
 * POST /api/gcs-restore { userId, extraUserIds? }
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

async function listObjects(token, prefix) {
  const res  = await fetch(
    `${GCS_API}/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix + "/")}&maxResults=1000`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.items || [];
}

function objectToItem(obj) {
  const name      = obj.name;
  const fileName  = name.split("/").pop();
  const ext       = fileName.split(".").pop()?.toLowerCase() || "jpg";
  const mimeType  = ext === "mp4" || ext === "mov" || ext === "webm"
    ? `video/${ext}`
    : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return {
    id:        name,
    url:       `${GCS_API}/${BUCKET}/${name}`,
    name:      fileName.replace(/\.[^.]+$/, "").replace(/_[a-z0-9]{5}$/, "").replace(/_/g, " "),
    type:      mimeType,
    size:      parseInt(obj.size) || 0,
    tags:      [],
    notes:     "",
    source:    "restored",
    mediaType: mimeType.startsWith("video/") ? "video" : "image",
    createdAt: obj.timeCreated || new Date().toISOString(),
    status:    "ready",
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status:204, headers:CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status:405, headers:CORS });

  try {
    const { userId, extraUserIds = [] } = await req.json();
    if (!userId) return new Response(JSON.stringify({ error:"userId required" }), { status:400, headers:CORS });

    const token = await getGCSToken();

    // Scan all userId prefixes (email + numeric ID + any extras)
    const allPrefixes = [userId, ...extraUserIds].filter(Boolean);
    const allObjects  = [];

    for (const prefix of allPrefixes) {
      const objects = await listObjects(token, prefix);
      console.log(`[gcs-restore] ${prefix}: ${objects.length} objects`);
      allObjects.push(...objects);
    }

    // Deduplicate by filename
    const seen = new Set();
    const unique = allObjects.filter(obj => {
      const key = obj.name.split("/").pop();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Build metadata items — normalize all URLs to use the primary userId
    const items = unique.map(obj => {
      const item = objectToItem(obj);
      // If found under a different prefix, keep original URL (still accessible)
      return item;
    });

    // Save merged metadata under primary userId
    const store = getStore("blog-bunker-data");
    await store.setJSON(`${userId}:media_library`, items);

    console.log(`[gcs-restore] Restored ${items.length} total items for ${userId}`);
    return new Response(JSON.stringify({ success: true, restored: items.length, items }), { status:200, headers:CORS });

  } catch(e) {
    console.error("[gcs-restore]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers:CORS });
  }
};

export const config = { path: "/api/gcs-restore" };
