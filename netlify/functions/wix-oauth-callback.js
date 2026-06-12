/**
 * netlify/functions/wix-oauth-callback.js
 * Handles Wix Headless OAuth Authorization Code callback
 * Headless Web clients don't use a client_secret
 */

export default async (req) => {
  const url  = new URL(req.url);
  const code = url.searchParams.get("code");

  const clientId   = "c6500272-f2ac-4fad-aeef-6cd500382297";
  const redirectUri = "https://blogbunker.netlify.app/api/wix-callback";

  if (!code) {
    return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff">
      <h2 style="color:#c47c2b">Missing authorization code</h2>
      <p>Close this window and try again.</p>
    </body></html>`, { status: 400, headers: { "Content-Type": "text/html" } });
  }

  try {
    // Wix Headless Web client token exchange — no client_secret needed
    const res = await fetch("https://www.wixapis.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type:   "authorization_code",
        client_id:    clientId,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.access_token) {
      const msg = data.error_description || data.error || JSON.stringify(data);
      return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff">
        <h2 style="color:#c47c2b">Token exchange failed</h2>
        <p style="color:#aaa">${msg}</p>
        <p>Close this window and try again.</p>
      </body></html>`, { status: 400, headers: { "Content-Type": "text/html" } });
    }

    const { access_token, refresh_token, expires_in } = data;

    return new Response(`<!DOCTYPE html>
    <html>
    <head><title>Blog Bunker — Connected!</title></head>
    <body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff;text-align:center">
      <div style="max-width:400px;margin:60px auto">
        <div style="font-size:56px;margin-bottom:16px">✓</div>
        <h2 style="color:#5cba6c;margin-bottom:8px">Wix Connected!</h2>
        <p style="color:#aaa">Blog Bunker now has full access to your Wix Blog.</p>
        <p style="color:#555;font-size:12px;margin-top:24px">Closing automatically…</p>
      </div>
      <script>
        const payload = {
          type:          "wix_oauth_success",
          access_token:  ${JSON.stringify(access_token)},
          refresh_token: ${JSON.stringify(refresh_token || "")},
          expires_in:    ${expires_in || 3600},
        };
        if (window.opener) {
          window.opener.postMessage(payload, "https://blogbunker.netlify.app");
          setTimeout(() => window.close(), 2000);
        } else {
          window.location.href = "https://blogbunker.netlify.app/#wix_token="
            + encodeURIComponent(payload.access_token)
            + "&wix_refresh=" + encodeURIComponent(payload.refresh_token);
        }
      </script>
    </body>
    </html>`, { status: 200, headers: { "Content-Type": "text/html" } });

  } catch (err) {
    return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#0e0f11;color:#fff">
      <h2 style="color:#c47c2b">Server error</h2>
      <p>${err.message}</p>
    </body></html>`, { status: 500, headers: { "Content-Type": "text/html" } });
  }
};

export const config = { path: "/api/wix-callback" };
