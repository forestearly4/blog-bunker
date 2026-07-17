/**
 * netlify/functions/gsc-refresh.js
 * Exchanges a refresh token for a new access token.
 * POST /api/gsc-refresh { refreshToken }
 */

export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const { refreshToken } = await req.json();
  if (!refreshToken) return new Response(JSON.stringify({ error: "refreshToken required" }), { status: 400, headers: CORS });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    "refresh_token",
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`${data.error}: ${data.error_description}`);
    return new Response(JSON.stringify({
      access_token: data.access_token,
      expiry: Date.now() + (data.expires_in * 1000),
    }), { status: 200, headers: CORS });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/gsc-refresh" };
