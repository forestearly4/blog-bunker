/**
 * netlify/functions/scan-competitor.js
 * Searches for recent competitor posts using two strategies:
 * 1. Fast: fetch and parse the competitor's RSS feed directly
 * 2. Fallback: Claude web search (slower but works for any site)
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

// Try to fetch RSS feed — most blogs have one
async function tryRSS(url) {
  const base = url.replace(/\/$/, "");
  const feeds = [
    `${base}/feed`,
    `${base}/feed/`,
    `${base}/rss.xml`,
    `${base}/rss`,
    `${base}/atom.xml`,
    `${base}/feed.xml`,
    `${base}/blog/feed`,
    `${base}/blog/rss.xml`,
  ];

  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogBunker/1.0)" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes("<item") && !text.includes("<entry")) continue;

      // Parse RSS/Atom items
      const posts = [];
      const itemRegex = /<item[\s\S]*?<\/item>/gi;
      const entryRegex = /<entry[\s\S]*?<\/entry>/gi;
      const items = [...(text.match(itemRegex) || []), ...(text.match(entryRegex) || [])];

      for (const item of items.slice(0, 8)) {
        const title   = (item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim();
        const link    = (item.match(/<link[^>]*>([^<]+)<\/link>/) || item.match(/<link[^>]+href="([^"]+)"/) || [])[1]?.trim();
        const pubDate = (item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || item.match(/<published[^>]*>([\s\S]*?)<\/published>/) || [])[1]?.trim();
        const desc    = (item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]?.replace(/<[^>]+>/g,"").trim().slice(0,200);

        if (title) {
          posts.push({
            title,
            url:   link || "",
            date:  pubDate ? new Date(pubDate).toISOString().split("T")[0] : "",
            angle: desc || "",
            opportunity: "",
          });
        }
      }

      if (posts.length > 0) return { posts, source: "rss" };
    } catch {}
  }
  return null;
}

// Claude web search fallback
async function tryWebSearch(name, url, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta":    "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001", // faster model = less timeout risk
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "any" }, // force it to search immediately
      system: `Return ONLY a JSON array of real posts found. No prose. Format: [{"title":"...","date":"YYYY-MM-DD","url":"...","angle":"...","opportunity":"how a fly fishing + whiskey lifestyle blog could cover this differently"}]. Max 6 posts. If none found: []`,
      messages: [{ role:"user", content:`Search: site:${new URL(url).hostname} recent blog posts 2025 2026` }],
    }),
    signal: AbortSignal.timeout(22000), // 22s — leave buffer before Netlify's 26s kill
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const fullText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const match = fullText.match(/\[[\s\S]*\]/);
  if (!match) return { posts: [], source: "search" };
  const posts = JSON.parse(match[0]);
  return { posts: Array.isArray(posts) ? posts.slice(0,6) : [], source: "search" };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status:204, headers:CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status:405, headers:CORS });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error:"ANTHROPIC_API_KEY not set" }), { status:500, headers:CORS });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error:"Invalid JSON" }), { status:400, headers:CORS }); }

  const { name, url } = body;
  if (!name || !url) return new Response(JSON.stringify({ error:"name and url required" }), { status:400, headers:CORS });

  // Normalize URL — add https:// if missing
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  // Validate URL
  let parsedUrl;
  try { parsedUrl = new URL(normalizedUrl); }
  catch { return new Response(JSON.stringify({ error:`Invalid URL: "${url}" — make sure it includes the full domain like https://midcurrent.com` }), { status:400, headers:CORS }); }

  try {
    // Strategy 1: RSS feed (instant, most reliable)
    const rssResult = await tryRSS(normalizedUrl);
    if (rssResult?.posts?.length > 0) {
      console.log(`[scan-competitor] RSS found ${rssResult.posts.length} posts for ${name}`);
      return new Response(JSON.stringify({
        posts:      rssResult.posts,
        scannedAt:  new Date().toISOString(),
        source:     "rss",
      }), { status:200, headers:CORS });
    }

    // Strategy 2: Claude web search fallback
    console.log(`[scan-competitor] No RSS for ${name}, trying web search`);
    const searchResult = await tryWebSearch(name, normalizedUrl, apiKey);
    return new Response(JSON.stringify({
      posts:     searchResult.posts,
      scannedAt: new Date().toISOString(),
      source:    "search",
    }), { status:200, headers:CORS });

  } catch(e) {
    console.error("[scan-competitor] Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers:CORS });
  }
};

export const config = { path: "/api/scan-competitor" };
