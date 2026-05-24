import { useState, useEffect } from "react";
import { AuthProvider, AuthGate, useAuth } from "./auth";
import OnboardingFlow from "./onboarding";
import Dashboard from "./dashboard";

function AppShell() {
  const { user, logout } = useAuth();
  const [onboarded, setOnboarded] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [checking,  setChecking]  = useState(true);

  useEffect(() => {
    if (!user) return;
    try {
      const already = localStorage.getItem(`bb_onboarded_${user.id}`) === "true";
      const saved   = localStorage.getItem(`bb_workspace_${user.id}`);
      if (already && saved) { setWorkspace(JSON.parse(saved)); setOnboarded(true); }
    } catch(e) { console.error("storage error:", e); }
    setChecking(false);
  }, [user]);

  const handleOnboardingComplete = (data) => {
    try {
      localStorage.setItem(`bb_onboarded_${user.id}`, "true");
      localStorage.setItem(`bb_workspace_${user.id}`, JSON.stringify(data));
    } catch(e) { console.error("save error:", e); }
    setWorkspace(data);
    setOnboarded(true);
  };

  if (checking) return (
    <div style={{ minHeight:"100vh", background:"#0e0f11", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:44, height:44, borderRadius:10, background:"#d4a054", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, fontWeight:900, color:"#0e0f11", animation:"p 1.5s ease-in-out infinite" }}>B</div>
      <style>{`@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}`}</style>
    </div>
  );

  if (!onboarded) return <OnboardingFlow userEmail={user?.email} onComplete={handleOnboardingComplete} />;
  return <Dashboard user={user} workspace={workspace} onLogout={logout} />;
}

export default function App() {
  return <AuthProvider><AuthGate><AppShell /></AuthGate></AuthProvider>;
}
