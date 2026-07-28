/**
 * netlify/functions/buffer-post.js
 * Posts to Buffer's GraphQL API — single endpoint covers X, TikTok,
 * Pinterest, Instagram, Facebook, Reddit, Threads, Bluesky, YouTube.
 *
 * POST /api/buffer-post
 * { apiKey, channels: [{channelId, text, imageUrl?, scheduledAt?}] }
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const BUFFER_GQL = "https://api.buffer.com";

async function bufferQuery(apiKey, query, variables = {}) {
  const res = await fetch(BUFFER_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body:    JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

// Get account + org ID
const GET_ACCOUNT = `
  query GetAccount {
    account {
      id
      email
      name
      organizations {
        id
        name
      }
    }
  }
`;

// Fetch channels for an org
const GET_CHANNELS = `
  query GetChannels($input: ChannelsInput!) {
    channels(input: $input) {
      id
      name
      service
      serviceId
      avatar
    }
  }
`;

// Create a post on a specific channel
const CREATE_POST = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id dueAt } }
      ... on MutationError { message }
    }
  }
`;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error:"POST only" }), { status: 405, headers: CORS });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error:"Invalid JSON" }), { status: 400, headers: CORS }); }

  const { apiKey, action, channelId, text, imageUrl, scheduledAt, organizationId } = body;

  if (!apiKey) return new Response(JSON.stringify({ error:"apiKey required" }), { status: 400, headers: CORS });

  try {
    // ── GET CHANNELS ────────────────────────────────────────────────────────
    if (action === "getChannels") {
      // Step 1: get org ID
      const accountData = await bufferQuery(apiKey, GET_ACCOUNT);
      const orgId = accountData?.account?.organizations?.[0]?.id;
      if (!orgId) throw new Error("No organization found on this Buffer account. Make sure you are the org owner.");
      // Step 2: get channels for that org
      const data = await bufferQuery(apiKey, GET_CHANNELS, { input: { organizationId: orgId } });
      return new Response(JSON.stringify({
        channels: data.channels || [],
        orgId,
        account: accountData.account,
      }), { status: 200, headers: CORS });
    }

    // ── CREATE POST ─────────────────────────────────────────────────────────
    if (action === "createPost") {
      if (!channelId || !text) return new Response(JSON.stringify({ error:"channelId and text required" }), { status: 400, headers: CORS });

      // Per Buffer schema (May 2026): assets is required, even if empty
      const assets = imageUrl?.startsWith("https://")
        ? [{ image: { url: imageUrl } }]
        : [];
      const input = {
        channelId,
        text,
        schedulingType: "automatic",
        mode: scheduledAt ? "customScheduled" : "addToQueue",
        ...(scheduledAt ? { dueAt: new Date(scheduledAt).toISOString() } : {}),
        assets,
      };

      const data = await bufferQuery(apiKey, CREATE_POST, { input });
      const result = data.createPost;
      if (result?.message) throw new Error(result.message); // MutationError
      return new Response(JSON.stringify({ success: true, post: result?.post }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error:`Unknown action: ${action}` }), { status: 400, headers: CORS });

  } catch(e) {
    console.error("[buffer-post]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/buffer-post" };
