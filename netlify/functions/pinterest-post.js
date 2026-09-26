/**
 * netlify/functions/pinterest-post.js
 * Publishes Pins to a connected Pinterest account via the core v5 REST API.
 *
 * POST /api/pinterest-post
 * { action: "getConfig" }
 * { action: "getAccount", accessToken }
 * { action: "getBoards",  accessToken }
 * { action: "createBoard", accessToken, name, description? }
 * { action: "createPin",  accessToken, boardId, title, description, link, imageUrl }
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: CORS });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS });
  }

  const { action } = body;

  try {
    // ── PUBLIC CLIENT ID (safe to expose — needed client-side to build the
    // OAuth authorize URL without asking every blogger to register their own
    // Pinterest developer app) ────────────────────────────────────────────
    if (action === "getConfig") {
      return new Response(JSON.stringify({ clientId: process.env.PINTEREST_APP_ID || null }), { status: 200, headers: CORS });
    }

    const { accessToken } = body;
    if (!accessToken) return new Response(JSON.stringify({ error: "accessToken required" }), { status: 400, headers: CORS });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // ── ACCOUNT INFO ─────────────────────────────────────────────────────
    if (action === "getAccount") {
      const res  = await fetch("https://api.pinterest.com/v5/user_account", { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Couldn't load account (HTTP ${res.status})`);
      return new Response(JSON.stringify({ success: true, username: data.username, accountType: data.account_type }), { status: 200, headers: CORS });
    }

    // ── LIST BOARDS ──────────────────────────────────────────────────────
    if (action === "getBoards") {
      const res  = await fetch("https://api.pinterest.com/v5/boards?page_size=100", { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Couldn't load boards (HTTP ${res.status})`);
      return new Response(JSON.stringify({ success: true, boards: (data.items || []).map(b => ({ id: b.id, name: b.name })) }), { status: 200, headers: CORS });
    }

    // ── CREATE BOARD ─────────────────────────────────────────────────────
    if (action === "createBoard") {
      const { name, description = "" } = body;
      if (!name) throw new Error("name is required");
      const res  = await fetch("https://api.pinterest.com/v5/boards", {
        method:  "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body:    JSON.stringify({ name, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Board creation failed (HTTP ${res.status})`);
      return new Response(JSON.stringify({ success: true, id: data.id, name: data.name }), { status: 200, headers: CORS });
    }

    // ── CREATE PIN ───────────────────────────────────────────────────────
    if (action === "createPin") {
      const { boardId, title, description, link, imageUrl } = body;
      if (!boardId)  throw new Error("boardId is required — select a board first");
      if (!imageUrl) throw new Error("imageUrl is required — Pinterest pins need an image");

      const payload = {
        board_id: boardId,
        ...(title ? { title: title.slice(0, 100) } : {}),
        ...(description ? { description: description.slice(0, 500) } : {}),
        ...(link ? { link } : {}),
        media_source: { source_type: "image_url", url: imageUrl },
      };

      const res  = await fetch("https://api.pinterest.com/v5/pins", {
        method:  "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Pin creation failed (HTTP ${res.status})`);
      return new Response(JSON.stringify({ success: true, pinId: data.id, url: `https://www.pinterest.com/pin/${data.id}/` }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/pinterest-post" };
