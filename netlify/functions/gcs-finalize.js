/**
 * netlify/functions/gcs-finalize.js
 * Called after a direct browser upload to GCS completes.
 * Makes the object public and updates metadata status.
 *
 * POST /api/gcs-finalize
 * { userId, objectId }
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
    const { userId = "anonymous", objectId } = await req.json();
    if (!objectId) return new Response(JSON.stringify({ error:"objectId required" }), { status:400, headers:CORS });

    const token = await getGCSToken();

    // Make public
    const iamRes = await fetch(`${GCS_API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectId)}/iam`, {
      method:  "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ bindings: [{ role:"roles/storage.objectViewer", members:["allUsers"] }] }),
    });
    if (!iamRes.ok) console.warn("[gcs-finalize] IAM warning:", await iamRes.text());

    // Update metadata status
    const store    = getStore("blog-bunker-data");
    const existing = await store.get(`${userId}:media_library`, { type:"json" }) || [];
    const updated  = existing.map(item =>
      item.id === objectId ? { ...item, status: "ready" } : item
    );
    await store.setJSON(`${userId}:media_library`, updated);

    return new Response(JSON.stringify({ success: true, url: `${GCS_API}/${BUCKET}/${objectId}` }), { status:200, headers:CORS });

  } catch(e) {
    console.error("[gcs-finalize]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers:CORS });
  }
};

export const config = { path: "/api/gcs-finalize" };
