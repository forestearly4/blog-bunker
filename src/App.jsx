import { useState, useEffect } from "react";
import { AuthProvider, useAuth, LoginScreen } from "./auth";
import OnboardingFlow from "./onboarding";
import Dashboard from "./dashboard";

function AppShell() {
  const { user, isAuthenticated, loading } = useAuth();
  const [onboarded, setOnboarded] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [checking,  setChecking]  = useState(true);

  useEffect(() => {
    if (!user) { setChecking(false); return; }
    try {
      const key   = `bb_onboarded_${user.email || user.id}`;
      const wsKey = `bb_workspace_${user.email || user.id}`;
      const already = localStorage.getItem(key) === "true";
      const saved   = localStorage.getItem(wsKey);
      if (already && saved) {
        setWorkspace(JSON.parse(saved));
        setOnboarded(true);
      }
    } catch(e) { console.error("storage:", e); }
    setChecking(false);
  }, [user]);

  const handleOnboardingComplete = (data) => {
    try {
      const key   = `bb_onboarded_${user.email || user.id}`;
      const wsKey = `bb_workspace_${user.email || user.id}`;
      localStorage.setItem(key,   "true");
      localStorage.setItem(wsKey, JSON.stringify(data));
    } catch {}
    setWorkspace(data);
    setOnboarded(true);
  };

  // Loading state
  if (loading || (isAuthenticated && checking)) return (
    <div style={{ minHeight:"100vh", background:"#0e0f11", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:44, height:44, borderRadius:10, background:"#d4a054", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, fontWeight:900, color:"#0e0f11", animation:"p 1.5s ease-in-out infinite" }}>B</div>
      <style>{`@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}`}</style>
    </div>
  );

  // Not logged in
  if (!isAuthenticated) return <LoginScreen />;

  // Needs onboarding
  if (!onboarded) return <OnboardingFlow userEmail={user?.email} onComplete={handleOnboardingComplete} />;

  // Main app
  return <Dashboard user={user} workspace={workspace} />;
}

export default function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}
