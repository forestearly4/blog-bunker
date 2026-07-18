/**
 * netlify/functions/google-refresh.js
 * Refreshes a Google access token using a refresh token.
 * POST /api/google-refresh { refreshToken }
 */

export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const { refreshToken } = await req.json().catch(() => ({}));
  if (!refreshToken) return new Response(JSON.stringify({ error: "refreshToken required" }), { status: 400, headers: CORS });

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type:    "refresh_token",
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`${data.error}: ${data.error_description}`);
    return new Response(JSON.stringify({
      accessToken: data.access_token,
      expiry:      Date.now() + ((data.expires_in || 3600) * 1000),
    }), { status: 200, headers: CORS });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/google-refresh" };
