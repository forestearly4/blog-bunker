/**
 * src/auth.jsx
 * Google OAuth authentication — replaces Netlify Identity.
 * One sign-in gives access to GCS, Search Console, and eventually Gmail.
 */
import { createContext, useContext, useState, useEffect, useCallback } from "react";

const AuthContext = createContext(null);
const STORAGE_KEY = "bb_google_auth";

function loadAuth() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
  catch { return null; }
}

function saveAuth(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch {}
}

function clearAuth() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

export function AuthProvider({ children }) {
  const [authData, setAuthData] = useState(loadAuth);
  const [loading,  setLoading]  = useState(false);

  // Set the global userId SYNCHRONOUSLY on every render (not inside a
  // useEffect) — this must be available before ANY child component's first
  // render, since several parts of the app read window.__bbUserId directly
  // during their own initial render/state setup. Deferring this to an effect
  // created a real race condition: on a fresh page load, effects only run
  // after the full render tree commits, so a child reading this during its
  // own first render could see it unset even though the user is already
  // logged in — intermittently requiring a reload (or two) to "catch up."
  if (authData?.user) {
    window.__bbUserId = authData.user.email || authData.user.id || "anonymous";
  }

  // Auto-refresh token before expiry
  useEffect(() => {
    if (!authData?.refreshToken || !authData?.expiry) return;
    const msLeft  = authData.expiry - Date.now() - 60_000;
    if (msLeft <= 0) { refreshToken(); return; }
    const timer = setTimeout(refreshToken, msLeft);
    return () => clearTimeout(timer);
  }, [authData?.expiry]);

  const refreshToken = useCallback(async () => {
    const current = loadAuth();
    if (!current?.refreshToken) return;
    try {
      const res  = await fetch("/api/google-refresh", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ refreshToken: current.refreshToken }),
      });
      const data = await res.json();
      if (data.error) { logout(); return; }
      const updated = { ...current, accessToken: data.accessToken, expiry: data.expiry };
      saveAuth(updated);
      setAuthData(updated);
    } catch { /* network error — keep existing token */ }
  }, []);

  const loginWithGoogle = useCallback(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || window.__GOOGLE_CLIENT_ID;
    if (!clientId) {
      alert("VITE_GOOGLE_CLIENT_ID not configured. Add it to Netlify environment variables and redeploy.");
      return;
    }
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  `${window.location.origin}/api/google-callback`,
      response_type: "code",
      scope:         SCOPES,
      access_type:   "offline",
      prompt:        "consent",
    });
    const popup = window.open(
      `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "google_auth",
      "width=500,height=650,scrollbars=yes"
    );
    setLoading(true);

    const handler = (e) => {
      if (e.data?.type === "google-auth-success") {
        window.removeEventListener("message", handler);
        const d = e.data.data;
        saveAuth(d);
        setAuthData(d);
        setLoading(false);
        // Set userId globally for components that need it
        window.__bbUserId = d.user?.email || d.user?.id || "anonymous";
      }
      if (e.data?.type === "google-auth-error") {
        window.removeEventListener("message", handler);
        setLoading(false);
      }
    };
    window.addEventListener("message", handler);

    // Cleanup if popup closed without completing
    const check = setInterval(() => {
      if (popup?.closed) { clearInterval(check); setLoading(false); window.removeEventListener("message", handler); }
    }, 500);
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setAuthData(null);
    window.__bbUserId = null;
  }, []);

  // Expose accessToken getter (auto-refreshes if needed)
  const getAccessToken = useCallback(async () => {
    const current = loadAuth();
    if (!current?.accessToken) return null;
    if (current.expiry && Date.now() > current.expiry - 60_000) {
      await refreshToken();
      return loadAuth()?.accessToken;
    }
    return current.accessToken;
  }, [refreshToken]);

  return (
    <AuthContext.Provider value={{
      user:       authData?.user || null,
      authData,
      loading,
      loginWithGoogle,
      logout,
      getAccessToken,
      isAuthenticated: !!authData?.user,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,700;1,400&family=DM+Sans:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:     #0e0f11;
    --card:   #161719;
    --border: #2a2b2e;
    --text:   #f0ece4;
    --muted:  #888;
    --amber:  #d4a054;
    --green:  #5cba6c;
    --red:    #e05555;
    --font-display: 'Fraunces', Georgia, serif;
    --font-body:    'DM Sans', system-ui, sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font-body); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .shell { width: 100%; max-width: 400px; padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 28px; }
  .logo { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--amber); letter-spacing: -0.5px; text-align: center; }
  .logo span { font-style: italic; font-weight: 400; color: var(--muted); font-size: 14px; display: block; margin-top: 4px; }
  .card { width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 32px; display: flex; flex-direction: column; gap: 20px; }
  .google-btn { width: 100%; padding: 13px 20px; border-radius: 10px; border: 1px solid var(--border); background: #fff; color: #3c4043; font-size: 15px; font-weight: 500; cursor: pointer; font-family: var(--font-body); display: flex; align-items: center; justify-content: center; gap: 10px; transition: box-shadow 0.15s; }
  .google-btn:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .google-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .features { display: flex; flex-direction: column; gap: 8px; }
  .feature { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
  .feature-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); flex-shrink: 0; }
  .footer { font-size: 11px; color: var(--muted); text-align: center; line-height: 1.6; }
`;

export function LoginScreen() {
  const { loginWithGoogle, loading } = useAuth();
  return (
    <>
      <style>{css}</style>
      <div className="shell">
        <div className="logo">
          Blog Bunker
          <span>Cast at Dawn. Sip at Dusk.</span>
        </div>
        <div className="card">
          <div>
            <div style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, marginBottom:6 }}>Welcome back</div>
            <div style={{ fontSize:13, color:"var(--muted)" }}>Sign in to your Bunker</div>
          </div>
          <button className="google-btn" onClick={loginWithGoogle} disabled={loading}>
            {loading ? (
              <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
            ) : (
              <svg width="20" height="20" viewBox="0 0 18 18">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.69 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/>
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
              </svg>
            )}
            {loading ? "Signing in…" : "Continue with Google"}
          </button>
          <div className="features">
            {[
              "Blog pipeline, social scheduler, media library",
              "Works on any device — everything synced",
              "Images stored in Google Cloud Storage",
              "Search Console auto-connected",
            ].map((f, i) => (
              <div key={i} className="feature">
                <div className="feature-dot" />
                {f}
              </div>
            ))}
          </div>
        </div>
        <div className="footer">
          By signing in you agree to use Blog Bunker only for your own brand content.
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
