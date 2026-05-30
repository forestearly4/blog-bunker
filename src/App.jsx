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
      // Check by user ID first (normal case)
      const idKey    = `bb_onboarded_${user.id}`;
      const idWsKey  = `bb_workspace_${user.id}`;

      // Also check by email (survives password reset which may change session ID)
      const emailKey   = `bb_onboarded_email_${user.email}`;
      const emailWsKey = `bb_workspace_email_${user.email}`;

      const alreadyById    = localStorage.getItem(idKey)    === "true";
      const alreadyByEmail = localStorage.getItem(emailKey) === "true";
      const already        = alreadyById || alreadyByEmail;

      const savedById    = localStorage.getItem(idWsKey);
      const savedByEmail = localStorage.getItem(emailWsKey);
      const saved        = savedById || savedByEmail;

      if (already && saved) {
        // Re-stamp with current user ID so future logins work by ID too
        localStorage.setItem(idKey,   "true");
        localStorage.setItem(idWsKey, saved);
        setWorkspace(JSON.parse(saved));
        setOnboarded(true);
      }
    } catch(e) { console.error("storage error:", e); }
    setChecking(false);
  }, [user]);

  const handleOnboardingComplete = (data) => {
    try {
      const ws = JSON.stringify(data);
      // Save by both user ID and email for resilience
      localStorage.setItem(`bb_onboarded_${user.id}`,          "true");
      localStorage.setItem(`bb_workspace_${user.id}`,           ws);
      localStorage.setItem(`bb_onboarded_email_${user.email}`,  "true");
      localStorage.setItem(`bb_workspace_email_${user.email}`,  ws);
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
