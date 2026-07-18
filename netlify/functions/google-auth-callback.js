/**
 * netlify/functions/google-auth-callback.js
 * Handles Google OAuth callback — exchanges code for tokens,
 * fetches user profile, returns success page that posts back to opener.
 *
 * Scopes requested:
 *   - openid email profile (identity)
 *   - devstorage.read_write (GCS)
 *   - webmasters.readonly (Search Console)
 */

const REDIRECT_URI = "https://blogbunker.netlify.app/api/google-callback";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/devstorage.read_write",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

export default async (req) => {
  const url   = new URL(req.url);
  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    return htmlResponse(null, error || "Authorization was cancelled.");
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return htmlResponse(null, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in Netlify environment variables.");
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

    // Fetch user profile
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { "Authorization": `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();

    return htmlResponse({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiry:       Date.now() + ((tokens.expires_in || 3600) * 1000),
      idToken:      tokens.id_token,
      user: {
        id:      profile.id,
        email:   profile.email,
        name:    profile.name,
        picture: profile.picture,
      },
    }, null);

  } catch(e) {
    return htmlResponse(null, e.message);
  }
};

function htmlResponse(data, error) {
  if (error) {
    return new Response(`<!DOCTYPE html><html><head><title>Sign In</title></head>
<body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;text-align:center">
  <h2 style="color:#e55">Sign in failed</h2>
  <p style="color:#aaa">${error}</p>
  <script>window.opener?.postMessage({type:"google-auth-error",error:${JSON.stringify(error)}},"*");setTimeout(()=>window.close(),3000)</script>
</body></html>`, { status: 200, headers: { "Content-Type": "text/html" } });
  }

  return new Response(`<!DOCTYPE html><html><head><title>Signed In</title></head>
<body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;text-align:center">
  <div style="font-size:48px;margin-bottom:16px">✓</div>
  <h2 style="color:#5cba6c">Signed in as ${data.user.name}</h2>
  <p style="color:#aaa">This window will close automatically…</p>
  <script>window.opener?.postMessage({type:"google-auth-success",data:${JSON.stringify(data)}},"*");setTimeout(()=>window.close(),1500)</script>
</body></html>`, { status: 200, headers: { "Content-Type": "text/html" } });
}

export const config = { path: "/api/google-callback" };
