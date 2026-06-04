/**
 * Blog Bunker — Wix API Proxy (Netlify Edge Function)
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default async (request, context) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body = {};
  try { body = await request.json(); } catch {}

  const apiKey    = Deno.env.get("WIX_API_KEY")    || Deno.env.get("wix_api_key")    || body.apiKey    || "";
  const siteId    = Deno.env.get("WIX_SITE_ID")    || Deno.env.get("wix_site_id")    || body.siteId    || "";
  const accountId = Deno.env.get("WIX_ACCOUNT_ID") || Deno.env.get("wix_account_id") || body.accountId || "8ac069ef-24ac-441a-9b21-0108361be0d7";

  const { endpoint, method = "GET", data = null } = body;

  if (!apiKey)                     return json({ error: "WIX_API_KEY not configured." }, 500);
  if (!siteId)                     return json({ error: "WIX_SITE_ID not configured." }, 500);
  if (!endpoint?.startsWith("/"))  return json({ error: "endpoint must start with /" }, 400);

  const url = `https://www.wixapis.com${endpoint}`;

  const headers = {
    "Content-Type":    "application/json",
    "Authorization":   apiKey,
    "wix-site-id":     siteId,
    "wix-account-id":  accountId,
  };

  const fetchOpts = { method, headers };
  if (data && method !== "GET") fetchOpts.body = JSON.stringify(data);

  try {
    const upstream = await fetch(url, fetchOpts);
    const text = await upstream.text();

    let result;
    try { result = JSON.parse(text); }
    catch {
      return json({ error: `Wix returned non-JSON (${upstream.status})`, urlCalled: url, preview: text.slice(0, 400) }, 502);
    }

    if (!upstream.ok) {
      const msg = result?.message || result?.error?.message || JSON.stringify(result);
      return json({ error: `Wix API ${upstream.status}: ${msg}`, urlCalled: url, wixResponse: result }, upstream.status);
    }

    return json(result, 200);
  } catch (err) {
    return json({ error: "Proxy error", detail: err.message, urlCalled: url }, 502);
  }
};

export const config = { path: "/api/wix" };
