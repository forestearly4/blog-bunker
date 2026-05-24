/**
 * netlify/functions/wix-proxy.js
 *
 * Proxies all Wix Blog API requests server-side so the API key
 * never hits the browser and CORS is bypassed.
 *
 * Netlify env vars required:
 *   WIX_API_KEY   — your Wix API key (from Wix Dashboard → Settings → Advanced → API Keys)
 *   WIX_SITE_ID   — your Wix site ID (from Wix Dashboard → Settings → Site ID)
 *
 * The frontend calls:
 *   POST /.netlify/functions/wix-proxy
 *   Body: { endpoint: "/v3/blog/posts", method: "GET", body: null }
 *
 * Supported Wix Blog API endpoints:
 *   GET  /v3/blog/posts              — list posts
 *   GET  /v3/blog/posts/{id}         — get single post
 *   POST /v3/blog/posts              — create post
 *   PATCH /v3/blog/posts/{id}        — update post
 *   POST /v3/blog/posts/{id}/publish — publish post
 */

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey  = process.env.WIX_API_KEY;
  const siteId  = process.env.WIX_SITE_ID;

  if (!apiKey || !siteId) {
    return new Response(
      JSON.stringify({
        error: "WIX_API_KEY and WIX_SITE_ID must be set in Netlify environment variables.",
        setup: "Go to Netlify → Site configuration → Environment variables and add both.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { endpoint, method = "GET", data = null } = body;

  if (!endpoint) {
    return new Response(JSON.stringify({ error: "endpoint is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const wixBase = "https://www.wixapis.com";
  const url     = `${wixBase}${endpoint}`;

  try {
    const fetchOpts = {
      method,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": apiKey,
        "wix-site-id":   siteId,
      },
    };

    if (data && method !== "GET") {
      fetchOpts.body = JSON.stringify(data);
    }

    const upstream = await fetch(url, fetchOpts);
    const result   = await upstream.json();

    return new Response(JSON.stringify(result), {
      status: upstream.status,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Wix API proxy error", detail: err.message }),
      {
        status: 502,
        headers: {
          "Content-Type":                "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};

export const config = { path: "/api/wix" };
