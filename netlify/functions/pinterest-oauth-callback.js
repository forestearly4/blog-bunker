/**
 * netlify/functions/pinterest-oauth-callback.js
 * Handles the Pinterest OAuth (v5) callback. Pinterest uses one centrally
 * registered Blog Bunker app (PINTEREST_APP_ID / PINTEREST_APP_SECRET, set
 * once as Netlify env vars) that every workspace authorizes against with
 * their OWN Pinterest account — same shape as the Search Console
 * integration, not the "paste your own developer app" shape Meta uses.
 * Pinterest's app-review model (one app, reviewed once for "standard
 * access") is built for exactly this multi-tenant pattern.
 *
 * Exchanges the authorization code for an access token + refresh token,
 * then returns a small page that posts the tokens back to the parent
 * window, matching the gsc-oauth-callback.js pattern.
 */

const REDIRECT_URI = "https://blogbunker.netlify.app/api/pinterest-callback";

export default async (req) => {
  const url   = new URL(req.url);
  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    return new Response(successPage(null, error || "No authorization code received"), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  const clientId     = process.env.PINTEREST_APP_ID;
  const clientSecret = process.env.PINTEREST_APP_SECRET;

  if (!clientId || !clientSecret) {
    return new Response(successPage(null, "PINTEREST_APP_ID / PINTEREST_APP_SECRET not set in Netlify environment variables."), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      throw new Error(tokens.message || tokens.error_description || tokens.error || `Token exchange failed (HTTP ${tokenRes.status})`);
    }

    // Fetch the connected username for a friendlier "connected as @x" UI
    let username = null;
    try {
      const acctRes = await fetch("https://api.pinterest.com/v5/user_account", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const acctData = await acctRes.json();
      username = acctData?.username || null;
    } catch { /* non-fatal — connection still succeeded without this */ }

    return new Response(successPage({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry:        Date.now() + (tokens.expires_in * 1000),
      username,
    }, null), { status: 200, headers: { "Content-Type": "text/html" } });

  } catch (e) {
    return new Response(successPage(null, e.message), { status: 200, headers: { "Content-Type": "text/html" } });
  }
};

function successPage(tokens, error) {
  if (error) {
    return `<!DOCTYPE html><html><head><title>Pinterest Connection</title></head><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff;">
      <h2 style="color:#e55">Connection Failed</h2>
      <p style="color:#aaa">${error}</p>
      <script>
        window.opener?.postMessage({ type: "pinterest-auth-error", error: ${JSON.stringify(error)} }, "*");
        setTimeout(() => window.close(), 4000);
      </script>
    </body></html>`;
  }

  return `<!DOCTYPE html><html><head><title>Pinterest Connected</title></head><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px">✓</div>
    <h2 style="color:#5cba6c">Pinterest Connected${tokens.username ? ` — @${tokens.username}` : ""}!</h2>
    <p style="color:#aaa">This window will close automatically…</p>
    <script>
      window.opener?.postMessage({ type: "pinterest-auth-success", tokens: ${JSON.stringify(tokens)} }, "*");
      setTimeout(() => window.close(), 1500);
    </script>
  </body></html>`;
}

export const config = { path: "/api/pinterest-callback" };
