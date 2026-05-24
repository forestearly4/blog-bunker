export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables." }), { status: 500, headers: { "Content-Type": "application/json" } });
  try {
    const body = await req.text();
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body,
    });
    const data = await upstream.json();
    return new Response(JSON.stringify(data), { status: upstream.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy error", detail: err.message }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
};
export const config = { path: "/api/claude" };
