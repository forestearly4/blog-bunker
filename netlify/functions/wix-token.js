/**
 * netlify/functions/wix-token.js
 *
 * Exchanges Wix OAuth credentials for an access token.
 * Called from the browser — keeps the client_secret server-side.
 *
 * POST /api/wix-token
 * Body: { appId, appSecret, instanceId }
 * Returns: { access_token, expires_in }
 */

export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

  const appId      = process.env.WIX_APP_ID     || body.appId;
  const appSecret  = process.env.WIX_APP_SECRET || body.appSecret;
  const instanceId = body.instanceId || "";

  if (!appId || !appSecret) {
    return new Response(JSON.stringify({ error: "appId and appSecret are required" }), { status: 400, headers: CORS });
  }

  try {
    const res = await fetch("https://www.wixapis.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type:    "client_credentials",
        client_id:     appId,
        client_secret: appSecret,
        ...(instanceId ? { instance_id: instanceId } : {}),
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      return new Response(JSON.stringify({ error: data.error_description || data.error || "Token request failed" }), { status: res.status, headers: CORS });
    }

    return new Response(JSON.stringify({
      access_token: data.access_token,
      expires_in:   data.expires_in || 3600,
    }), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Token fetch failed", detail: err.message }), { status: 502, headers: CORS });
  }
};

export const config = { path: "/api/wix-token" };
