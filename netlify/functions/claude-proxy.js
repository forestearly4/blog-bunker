export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status: 405, headers: CORS });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500, headers: CORS });

  try {
    const body   = await req.text();
    const parsed = JSON.parse(body);

    // Detect if web_search tool is requested — needs beta header
    const hasWebSearch = (parsed.tools || []).some(t => t.type?.includes("web_search") || t.name === "web_search");

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        ...(hasWebSearch ? { "anthropic-beta": "web-search-2025-03-05" } : {}),
      },
      body,
    });

    const text = await upstream.text();
    // Return raw text — let client parse it
    return new Response(text, {
      status:  upstream.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch(err) {
    return new Response(JSON.stringify({ error:"Proxy error", detail: err.message }), { status: 502, headers: CORS });
  }
};

export const config = { path: "/api/claude" };
