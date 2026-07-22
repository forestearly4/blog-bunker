/**
 * netlify/functions/scan-competitor.js
 * Searches for real recent posts from a competitor blog using Claude + web search.
 * Runs server-side to avoid browser CORS issues and Netlify's proxy timeout.
 *
 * POST /api/scan-competitor
 * { name, url }
 * → { posts: [{title, date, url, angle, opportunity}] }
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status: 405, headers: CORS });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error:"ANTHROPIC_API_KEY not set" }), { status: 500, headers: CORS });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error:"Invalid JSON" }), { status: 400, headers: CORS }); }

  const { name, url } = body;
  if (!name || !url) return new Response(JSON.stringify({ error:"name and url required" }), { status: 400, headers: CORS });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `You are a content analyst. Search the web and find REAL recent blog posts from the competitor site. 
Return ONLY a JSON array — no prose, no markdown fences.
Format: [{"title":"exact post title","date":"YYYY-MM-DD","url":"full post URL","angle":"their specific angle on the topic","opportunity":"how a fly fishing and whiskey lifestyle blog (Cask & Stream) could cover this topic with a different angle"}]
Rules:
- Only include posts you actually found via web search — never invent titles
- Include the real URL for each post
- If you find no recent posts, return []
- Maximum 8 posts`,
        messages: [{
          role:    "user",
          content: `Search for recent blog posts published by "${name}" at ${url} within the last 90 days. Find their actual published articles. Return only real posts with real URLs.`,
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[scan-competitor] Anthropic error:", res.status, errText.slice(0, 200));
      return new Response(JSON.stringify({ error: `Anthropic API error ${res.status}`, detail: errText.slice(0, 200) }), { status: 502, headers: CORS });
    }

    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message || "API error" }), { status: 502, headers: CORS });
    }

    // Extract text blocks from response
    const fullText = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    console.log("[scan-competitor] Raw response text:", fullText.slice(0, 300));

    // Parse JSON array from text — handle both bare arrays and prose-wrapped arrays
    let posts = [];
    const jsonMatch = fullText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try { posts = JSON.parse(jsonMatch[0]); }
      catch { posts = []; }
    }

    if (!Array.isArray(posts)) posts = [];
    posts = posts.slice(0, 8);

    console.log(`[scan-competitor] Found ${posts.length} posts for ${name}`);
    return new Response(JSON.stringify({ posts, scannedAt: new Date().toISOString() }), { status: 200, headers: CORS });

  } catch(e) {
    console.error("[scan-competitor] Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/scan-competitor" };
