/**
 * netlify/functions/pinterest-refresh.js
 * Exchanges a Pinterest refresh token for a new access token.
 * POST /api/pinterest-refresh { refreshToken }
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const { refreshToken } = await req.json();
  if (!refreshToken) return new Response(JSON.stringify({ error: "refreshToken required" }), { status: 400, headers: CORS });

  const clientId     = process.env.PINTEREST_APP_ID;
  const clientSecret = process.env.PINTEREST_APP_SECRET;
  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({ error: "PINTEREST_APP_ID / PINTEREST_APP_SECRET not set in Netlify environment variables." }), { status: 500, headers: CORS });
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(data.message || data.error_description || data.error || `Refresh failed (HTTP ${res.status})`);
    }
    return new Response(JSON.stringify({
      access_token: data.access_token,
      // Pinterest rotates the refresh token on some plans/scopes — pass along
      // a new one if given, otherwise the caller keeps using the one it has.
      refresh_token: data.refresh_token || null,
      expiry: Date.now() + (data.expires_in * 1000),
    }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/pinterest-refresh" };
