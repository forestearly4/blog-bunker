import { useState, useEffect } from "react";
import { AuthProvider, useAuth, LoginScreen } from "./auth";
import OnboardingFlow from "./onboarding";
import Dashboard from "./dashboard";

// Use a stable key regardless of which user field is present
function userKey(user) {
  return user?.email || user?.id || user?.sub || "default";
}

function AppShell() {
  const { user, isAuthenticated, loading } = useAuth();
  const [onboarded, setOnboarded] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [checking,  setChecking]  = useState(true);

  useEffect(() => {
    if (!user) { setChecking(false); return; }

    const uk    = userKey(user);
    const key   = `bb_onboarded_${uk}`;
    const wsKey = `bb_workspace_${uk}`;

    // Also check the legacy generic keys (pre-Google-auth sessions)
    const legacyOnboarded = localStorage.getItem("bb_onboarded") === "true";
    const legacyWs        = localStorage.getItem("bb_workspace");

    try {
      const already = localStorage.getItem(key) === "true" || legacyOnboarded;
      const saved   = localStorage.getItem(wsKey) || legacyWs;

      if (already && saved) {
        // Migrate legacy keys to user-specific keys if needed
        if (legacyOnboarded && !localStorage.getItem(key)) {
          localStorage.setItem(key, "true");
          if (legacyWs) localStorage.setItem(wsKey, legacyWs);
        }
        setWorkspace(JSON.parse(saved));
        setOnboarded(true);
      } else if (already && !saved) {
        // Onboarded but no workspace data — go to onboarding to recollect
        setOnboarded(false);
      }
    } catch(e) {
      console.error("onboarding check error:", e);
    }
    setChecking(false);
  }, [user?.email, user?.id]);

  const handleOnboardingComplete = (data) => {
    const uk    = userKey(user);
    const key   = `bb_onboarded_${uk}`;
    const wsKey = `bb_workspace_${uk}`;
    try {
      localStorage.setItem(key,   "true");
      localStorage.setItem(wsKey, JSON.stringify(data));
      // Also write generic keys for compatibility
      localStorage.setItem("bb_onboarded", "true");
      localStorage.setItem("bb_workspace",  JSON.stringify(data));
    } catch {}
    setWorkspace(data);
    setOnboarded(true);
  };

  // Loading spinner
  if (loading || (isAuthenticated && checking)) return (
    <div style={{ minHeight:"100vh", background:"#0e0f11", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:44, height:44, borderRadius:10, background:"#d4a054", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, fontWeight:900, color:"#0e0f11", animation:"p 1.5s ease-in-out infinite" }}>B</div>
      <style>{`@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}`}</style>
    </div>
  );

  if (!isAuthenticated) return <LoginScreen />;
  if (!onboarded)       return <OnboardingFlow userEmail={user?.email} onComplete={handleOnboardingComplete} />;

  return <Dashboard user={user} workspace={workspace} />;
}

export default function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}
