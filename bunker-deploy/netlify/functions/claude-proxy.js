/**
 * netlify/functions/claude-proxy.js
 *
 * Proxies requests to the Anthropic API so the API key never
 * touches the browser. Set ANTHROPIC_API_KEY in your Netlify
 * site's environment variables (Site settings → Environment variables).
 *
 * The frontend calls POST /api/claude with the same body it would
 * send to api.anthropic.com/v1/messages — this function forwards it
 * and streams the response back.
 */

export default async (req) => {
  // Only allow POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured in Netlify environment variables." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.text();

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            apiKey,
        "anthropic-version":    "2023-06-01",
      },
      body,
    });

    const data = await upstream.json();

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Proxy error", detail: err.message }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = { path: "/api/claude" };
