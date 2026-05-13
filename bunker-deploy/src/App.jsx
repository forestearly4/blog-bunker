import { useState, useEffect } from "react";
import { AuthProvider, AuthGate, useAuth } from "./auth";
import OnboardingFlow from "./onboarding";
import Dashboard from "./dashboard";

function AppShell() {
  const { user, logout } = useAuth();
  const [onboarded, setOnboarded] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!user) return;
    const flagKey = `bb_onboarded_${user.id}`;
    const wsKey   = `bb_workspace_${user.id}`;
    const already = localStorage.getItem(flagKey) === "true";
    const saved   = localStorage.getItem(wsKey);
    if (already && saved) {
      setWorkspace(JSON.parse(saved));
      setOnboarded(true);
    }
    setChecking(false);
  }, [user]);

  const handleOnboardingComplete = (workspaceData) => {
    localStorage.setItem(`bb_onboarded_${user.id}`, "true");
    localStorage.setItem(`bb_workspace_${user.id}`, JSON.stringify(workspaceData));
    setWorkspace(workspaceData);
    setOnboarded(true);
  };

  if (checking) return null;

  if (!onboarded) {
    return (
      <OnboardingFlow
        userEmail={user?.email}
        onComplete={handleOnboardingComplete}
      />
    );
  }

  return (
    <Dashboard
      user={user}
      workspace={workspace}
      onLogout={logout}
    />
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </AuthProvider>
  );
}
