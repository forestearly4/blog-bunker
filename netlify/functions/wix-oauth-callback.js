/**
 * netlify/functions/wix-oauth-callback.js
 * Handles the Wix OAuth Authorization Code callback
 * 
 * Flow:
 * 1. User clicks "Connect with Wix" in Blog Bunker
 * 2. Browser opens Wix authorization URL
 * 3. User approves → Wix redirects to this function with ?code=xxx
 * 4. This function exchanges the code for tokens
 * 5. Redirects back to Blog Bunker with the token in the URL hash
 */

export default async (req) => {
  const url  = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";

  const appId     = process.env.WIX_APP_ID     || "";
  const appSecret = process.env.WIX_APP_SECRET || "";

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  try {
    const res = await fetch("https://www.wixapis.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type:    "authorization_code",
        client_id:     appId,
        client_secret: appSecret,
        code,
        redirect_uri:  "https://blogbunker.netlify.app/api/wix-callback",
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      const msg = data.error_description || data.error || "Token exchange failed";
      return new Response(`OAuth error: ${msg}`, { status: 400 });
    }

    const { access_token, refresh_token, expires_in } = data;

    // Redirect back to Blog Bunker with tokens in URL hash
    // Hash is not sent to server — stays client-side only
    const redirectUrl = `https://blogbunker.netlify.app/#wix_token=${access_token}&wix_refresh=${refresh_token || ""}&wix_expires=${expires_in || 3600}`;

    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });

  } catch (err) {
    return new Response(`Server error: ${err.message}`, { status: 500 });
  }
};

export const config = { path: "/api/wix-callback" };
