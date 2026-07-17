/**
 * netlify/functions/gsc-oauth-callback.js
 * Handles Google OAuth callback for Search Console.
 * Exchanges the authorization code for access + refresh tokens,
 * then returns a success page that posts the tokens back to the parent window.
 */

const REDIRECT_URI = "https://blogbunker.netlify.app/api/gsc-callback";

export default async (req) => {
  const url  = new URL(req.url);
  const code = url.searchParams.get("code");
  const error= url.searchParams.get("error");

  if (error || !code) {
    return new Response(successPage(null, error || "No authorization code received"), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response(successPage(null, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in Netlify environment variables."), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  REDIRECT_URI,
        grant_type:    "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(`${tokens.error}: ${tokens.error_description}`);

    return new Response(successPage({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry: Date.now() + (tokens.expires_in * 1000) }, null), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  } catch(e) {
    return new Response(successPage(null, e.message), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
};

function successPage(tokens, error) {
  if (error) {
    return `<!DOCTYPE html><html><head><title>GSC Connection</title></head><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#fff;">
      <h2 style="color:#e55">Connection Failed</h2>
      <p style="color:#aaa">${error}</p>
      <script>
        window.opener?.postMessage({ type: "gsc-auth-error", error: ${JSON.stringify(error)} }, "*");
        setTimeout(() => window.close(), 3000);
      </script>
    </body></html>`;
  }

  return `<!DOCTYPE html><html><head><title>GSC Connected</title></head><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#fff;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px">✓</div>
    <h2 style="color:#5cba6c">Search Console Connected!</h2>
    <p style="color:#aaa">This window will close automatically…</p>
    <script>
      window.opener?.postMessage({ type: "gsc-auth-success", tokens: ${JSON.stringify(tokens)} }, "*");
      setTimeout(() => window.close(), 1500);
    </script>
  </body></html>`;
}

export const config = { path: "/api/gsc-callback" };
