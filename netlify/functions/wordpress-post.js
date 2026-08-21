/**
 * netlify/functions/wordpress-post.js
 * Publishes/updates posts on a user's own self-hosted (or WordPress.com)
 * WordPress site via the core REST API, authenticated with an Application
 * Password — a feature built into WordPress core since 5.6 (Dec 2020), so no
 * plugin install is required on the user's end. Uses HTTP Basic Auth with the
 * username + application password (WordPress accepts this specifically for
 * Application Passwords, unlike a normal account password).
 *
 * POST /api/wordpress-post
 * { action: "testConnection", siteUrl, username, appPassword }
 * { action: "createPost"|"updatePost", siteUrl, username, appPassword,
 *   postId?, title, contentHtml, status, categories?, featuredMediaId?, date? }
 * { action: "uploadMedia", siteUrl, username, appPassword, imageUrl, filename }
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

function authHeader(username, appPassword) {
  return "Basic " + btoa(`${username}:${appPassword}`);
}

function normalizeSiteUrl(siteUrl) {
  let url = siteUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status: 405, headers: CORS });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS });
  }

  const { action, siteUrl, username, appPassword } = body;
  if (!siteUrl || !username || !appPassword) {
    return new Response(JSON.stringify({ error: "siteUrl, username, and appPassword are all required" }), { status: 400, headers: CORS });
  }
  const base = normalizeSiteUrl(siteUrl);
  const auth = authHeader(username, appPassword);

  try {
    // ── TEST CONNECTION ────────────────────────────────────────────────────
    if (action === "testConnection") {
      const res  = await fetch(`${base}/wp-json/wp/v2/users/me`, { headers: { Authorization: auth } });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.message ||
          `Couldn't connect (HTTP ${res.status}). Double-check the site URL, and make sure you're using an Application Password, not your regular login password.`
        );
      }
      return new Response(JSON.stringify({ success: true, name: data.name, id: data.id }), { status: 200, headers: CORS });
    }

    // ── UPLOAD MEDIA (for a featured image) ──────────────────────────────────
    if (action === "uploadMedia") {
      const { imageUrl, filename = "image.jpg" } = body;
      if (!imageUrl) throw new Error("imageUrl is required");

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Couldn't fetch the image to upload (HTTP ${imgRes.status})`);
      const imgBlob = await imgRes.blob();

      const res = await fetch(`${base}/wp-json/wp/v2/media`, {
        method:  "POST",
        headers: {
          Authorization: auth,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": imgBlob.type || "image/jpeg",
        },
        body: imgBlob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Media upload failed (HTTP ${res.status})`);
      return new Response(JSON.stringify({ success: true, mediaId: data.id, url: data.source_url }), { status: 200, headers: CORS });
    }

    // ── CREATE / UPDATE POST ─────────────────────────────────────────────────
    if (action === "createPost" || action === "updatePost") {
      const { postId, title, contentHtml, status = "draft", categories, featuredMediaId, date } = body;
      if (!title || !contentHtml) throw new Error("title and contentHtml are required");

      const payload = {
        title,
        content: contentHtml,
        status, // "draft" | "publish" | "future" (scheduled — requires date)
        ...(categories?.length ? { categories } : {}),
        ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
        ...(status === "future" && date ? { date } : {}),
      };

      const isUpdate = action === "updatePost" && postId;
      const url = isUpdate ? `${base}/wp-json/wp/v2/posts/${postId}` : `${base}/wp-json/wp/v2/posts`;
      const res = await fetch(url, {
        method:  "POST", // WordPress's REST API uses POST for both create and update
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        // A stale/deleted postId on update falls back to creating a new post
        // instead of failing outright — better than losing the content.
        if (isUpdate && res.status === 404) {
          const createRes = await fetch(`${base}/wp-json/wp/v2/posts`, {
            method:  "POST",
            headers: { Authorization: auth, "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          });
          const createData = await createRes.json();
          if (!createRes.ok) throw new Error(createData.message || `Post creation failed (HTTP ${createRes.status})`);
          return new Response(JSON.stringify({ success: true, postId: createData.id, url: createData.link, recreated: true }), { status: 200, headers: CORS });
        }
        throw new Error(data.message || `Post ${isUpdate ? "update" : "creation"} failed (HTTP ${res.status})`);
      }
      return new Response(JSON.stringify({ success: true, postId: data.id, url: data.link }), { status: 200, headers: CORS });
    }

    // ── LIST CATEGORIES (for a picker) ───────────────────────────────────────
    if (action === "getCategories") {
      const res  = await fetch(`${base}/wp-json/wp/v2/categories?per_page=100`, { headers: { Authorization: auth } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Couldn't load categories (HTTP ${res.status})`);
      return new Response(JSON.stringify({ success: true, categories: data.map(c => ({ id: c.id, name: c.name })) }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: CORS });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/wordpress-post" };
