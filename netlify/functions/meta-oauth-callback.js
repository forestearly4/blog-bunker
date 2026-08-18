/**
 * netlify/functions/meta-oauth-callback.js
 * Handles Meta (Facebook/Instagram) OAuth callback
 * Exchanges code for access token, fetches pages + IG accounts
 */

export default async (req) => {
  const url  = new URL(req.url);
  const code = url.searchParams.get("code");

  const appId     = process.env.META_APP_ID     || "";
  const appSecret = process.env.META_APP_SECRET || "";
  const redirectUri = "https://blogbunker.netlify.app/api/meta-callback";

  if (!code) {
    return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff">
      <h2 style="color:#c47c2b">Missing authorization code</h2>
      <p>Close this window and try again.</p>
    </body></html>`, { status: 400, headers: { "Content-Type": "text/html" } });
  }

  try {
    // Exchange code for short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v25.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error?.message || "Token exchange failed");

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`
    );
    const longData = await longRes.json();
    const userToken = longData.access_token || tokenData.access_token;

    // Fetch user's pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`
    );
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];

    // Build payload
    const payload = {
      type:       "meta_oauth_success",
      user_token: userToken,
      pages:      pages.map(p => ({
        id:           p.id,
        name:         p.name,
        access_token: p.access_token,
        instagram_id: p.instagram_business_account?.id || null,
      })),
    };

    return new Response(`<!DOCTYPE html>
    <html>
    <head><title>Blog Bunker — Meta Connected!</title></head>
    <body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff;text-align:center">
      <div style="max-width:400px;margin:60px auto">
        <div style="font-size:56px;margin-bottom:16px">✓</div>
        <h2 style="color:#5cba6c;margin-bottom:8px">Facebook & Instagram Connected!</h2>
        <p style="color:#aaa">Found ${pages.length} Facebook page${pages.length!==1?"s":""}.${pages.some(p=>p.instagram_business_account) ? " Instagram linked." : ""}</p>
        <p style="color:#555;font-size:12px;margin-top:24px">Closing automatically…</p>
      </div>
      <script>
        const payload = ${JSON.stringify(payload)};
        if (window.opener) {
          window.opener.postMessage(payload, "https://blogbunker.netlify.app");
          setTimeout(() => window.close(), 2000);
        } else {
          window.location.href = "https://blogbunker.netlify.app/#meta_token=" + encodeURIComponent(payload.user_token);
        }
      </script>
    </body>
    </html>`, { status: 200, headers: { "Content-Type": "text/html" } });

  } catch (err) {
    return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff">
      <h2 style="color:#c47c2b">Connection failed</h2>
      <p>${err.message}</p>
    </body></html>`, { status: 500, headers: { "Content-Type": "text/html" } });
  }
};

export const config = { path: "/api/meta-callback" };
