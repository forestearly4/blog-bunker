import { useState, useEffect } from "react";
import { AuthProvider, useAuth, LoginScreen } from "./auth";
import OnboardingFlow from "./onboarding";
import Dashboard from "./dashboard";

function userKey(user) {
  return user?.email || user?.id || user?.sub || "default";
}

async function cloudGet(key, userId) {
  try {
    const res  = await fetch(`/api/data?key=${encodeURIComponent(key)}&userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    return data.value;
  } catch { return null; }
}

async function cloudSet(key, userId, value) {
  try {
    await fetch("/api/data", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, userId, value }),
    });
  } catch {}
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

    (async () => {
      // 1. Check localStorage first (fast path — same computer)
      const localOnboarded = localStorage.getItem(key) === "true"
        || localStorage.getItem("bb_onboarded") === "true";
      const localWs = localStorage.getItem(wsKey) || localStorage.getItem("bb_workspace");

      if (localOnboarded && localWs) {
        const ws = JSON.parse(localWs);
        setWorkspace(ws);
        setOnboarded(true);
        setChecking(false);
        // Ensure cloud has it too
        cloudSet("workspace", uk, ws);
        return;
      }

      // 2. Not found locally — try cloud (different computer / cleared localStorage)
      const cloudWs = await cloudGet("workspace", uk);
      if (cloudWs && typeof cloudWs === "object") {
        // Found in cloud — restore locally and proceed
        localStorage.setItem(key,   "true");
        localStorage.setItem(wsKey, JSON.stringify(cloudWs));
        localStorage.setItem("bb_onboarded", "true");
        localStorage.setItem("bb_workspace",  JSON.stringify(cloudWs));
        setWorkspace(cloudWs);
        setOnboarded(true);
      } else {
        // Not in cloud either — needs onboarding
        setOnboarded(false);
      }
      setChecking(false);
    })();
  }, [user?.email, user?.id]);

  const handleOnboardingComplete = (data) => {
    const uk    = userKey(user);
    const key   = `bb_onboarded_${uk}`;
    const wsKey = `bb_workspace_${uk}`;
    try {
      localStorage.setItem(key,   "true");
      localStorage.setItem(wsKey, JSON.stringify(data));
      localStorage.setItem("bb_onboarded", "true");
      localStorage.setItem("bb_workspace",  JSON.stringify(data));
    } catch {}
    // Push to cloud so other devices skip onboarding
    cloudSet("workspace", uk, data);
    setWorkspace(data);
    setOnboarded(true);
  };

  // Loading
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
