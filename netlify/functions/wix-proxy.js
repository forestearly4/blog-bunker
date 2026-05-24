/**
 * netlify/functions/wix-proxy.js
 *
 * Proxies Wix Blog API requests server-side to bypass CORS.
 *
 * API key and Site ID can be supplied in two ways (checked in order):
 *   1. In the request body: { apiKey, siteId, endpoint, method, data }
 *   2. As Netlify env vars: WIX_API_KEY and WIX_SITE_ID (optional fallback)
 *
 * This means users can enter their keys directly in the Blog Bunker UI
 * without needing to configure Netlify environment variables.
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const {
    endpoint,
    method  = "GET",
    data    = null,
    apiKey  = process.env.WIX_API_KEY  || "",
    siteId  = process.env.WIX_SITE_ID  || "",
  } = body;

  if (!apiKey || !siteId) {
    return new Response(
      JSON.stringify({
        error: "Wix API key and Site ID are required.",
        hint:  "Enter them in Blog Bunker → Settings → Wix Integration.",
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }

  if (!endpoint) {
    return new Response(JSON.stringify({ error: "endpoint is required" }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const url = `https://www.wixapis.com${endpoint}`;

  try {
    const fetchOpts = {
      method,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": apiKey,
        "wix-site-id":   siteId,
      },
    };
    if (data && method !== "GET") fetchOpts.body = JSON.stringify(data);

    const upstream = await fetch(url, fetchOpts);
    const result   = await upstream.json();

    return new Response(JSON.stringify(result), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Wix proxy error", detail: err.message }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
};

export const config = { path: "/api/wix" };
