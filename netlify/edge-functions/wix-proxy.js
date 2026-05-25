/**
 * Blog Bunker — Wix API Proxy
 * Netlify Function (Edge Function for zero cold start)
 * 
 * Works automatically when deployed via GitHub → Netlify.
 * No Cloudflare account needed.
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (request, context) => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const { endpoint, method = "GET", data = null, apiKey, siteId } = body;

  if (!apiKey || !siteId) {
    return new Response(JSON.stringify({ error: "apiKey and siteId are required." }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  if (!endpoint?.startsWith("/")) {
    return new Response(JSON.stringify({ error: "endpoint must start with /" }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const url = `https://www.wixapis.com${endpoint}`;
  const fetchOpts = {
    method,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": apiKey,
      "wix-site-id":   siteId,
    },
  };
  if (data && method !== "GET") fetchOpts.body = JSON.stringify(data);

  try {
    const upstream = await fetch(url, fetchOpts);
    const text = await upstream.text();
    let result;
    try { result = JSON.parse(text); }
    catch {
      return new Response(JSON.stringify({
        error: `Wix returned non-JSON (${upstream.status}). Check your API key and Site ID.`,
        preview: text.slice(0, 300),
      }), { status: 502, headers: { "Content-Type": "application/json", ...CORS } });
    }

    if (!upstream.ok) {
      const msg = result?.message || result?.error?.message || JSON.stringify(result);
      return new Response(JSON.stringify({ error: `Wix API error ${upstream.status}: ${msg}` }), {
        status: upstream.status, headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { "Content-Type": "application/json", ...CORS },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy error", detail: err.message }), {
      status: 502, headers: { "Content-Type": "application/json", ...CORS },
    });
  }
};

export const config = { path: "/api/wix" };
