/**
 * auth.jsx — Netlify Identity integration
 *
 * SETUP (one-time):
 *   1. Netlify dashboard → Identity → Enable Identity
 *   2. Registration: Open (or Invite Only)
 *   3. Add ANTHROPIC_API_KEY to Site settings → Environment variables
 *
 * Exports: AuthProvider, useAuth, AuthGate
 */

import { useState, useEffect, useContext, createContext, useCallback } from "react";

// ─── CSS VARS ─────────────────────────────────────────────────────────────────

const DARK = {
  "--bg":             "#0e0f11",
  "--bg-surface":     "#16171b",
  "--bg-elevated":    "#1c1d22",
  "--border":         "#2a2b33",
  "--text":           "#e8e6e1",
  "--text-secondary": "#8a8880",
  "--amber":          "#d4a054",
  "--amber-glow":     "rgba(212,160,84,0.12)",
  "--green":          "#5cba6c",
  "--red":            "#c75454",
  "--muted":          "#5c5b56",
};

// ─── IDENTITY HELPERS ─────────────────────────────────────────────────────────

function getIdentity() {
  return typeof window !== "undefined" ? window.netlifyIdentity : null;
}

// ─── CONTEXT ──────────────────────────────────────────────────────────────────

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const identity = getIdentity();
    if (!identity) {
      // Widget script hasn't loaded yet — poll for it
      const iv = setInterval(() => {
        const id = getIdentity();
        if (id) { clearInterval(iv); init(id); }
      }, 100);
      return () => clearInterval(iv);
    }
    init(identity);
  }, []);

  function init(identity) {
    identity.on("init",   u  => { setUser(u || null); setLoading(false); });
    identity.on("login",  u  => { setUser(u); identity.close(); });
    identity.on("logout", () => setUser(null));
    identity.on("error",  err => console.error("Netlify Identity:", err));
    identity.init();
  }

  const login = useCallback((email, password) => {
    const id = getIdentity();
    if (!id) return Promise.reject(new Error("Identity not loaded"));
    return id.gotrue.login(email, password, true);
  }, []);

  const signup = useCallback((email, password) => {
    const id = getIdentity();
    if (!id) return Promise.reject(new Error("Identity not loaded"));
    return id.gotrue.signup(email, password, {});
  }, []);

  const logout = useCallback(() => {
    const id = getIdentity();
    if (id) id.logout();
  }, []);

  const requestPasswordRecovery = useCallback((email) => {
    const id = getIdentity();
    if (!id) return Promise.reject(new Error("Identity not loaded"));
    return id.gotrue.requestPasswordRecovery(email);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, requestPasswordRecovery }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

// ─── SHARED UI ────────────────────────────────────────────────────────────────

function Shell({ children }) {
  return (
    <div style={{
      ...DARK, minHeight: "100vh", background: "var(--bg)",
      fontFamily: "'DM Sans', system-ui, sans-serif",
      color: "var(--text)", display: "flex",
      alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", backgroundImage: "radial-gradient(circle at 1px 1px, #2a2b3318 1px, transparent 0)", backgroundSize: "32px 32px" }} />
      <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 420 }}>
        {children}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Logo() {
  return (
    <div style={{ textAlign: "center", marginBottom: 32 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 900, color: "#0e0f11", fontFamily: "'Fraunces', serif", margin: "0 auto 12px", boxShadow: "0 0 32px rgba(212,160,84,0.2)" }}>B</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700 }}>Blog Bunker</div>
      <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 4 }}>Command Center</div>
    </div>
  );
}

function Card({ children }) {
  return <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "32px 36px", boxShadow: "0 24px 64px rgba(0,0,0,0.4)" }}>{children}</div>;
}

const iStyle = { width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: 14, fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box", transition: "border-color 0.2s" };

function Field({ label, type = "text", placeholder, value, onChange, autoFocus, error }) {
  const [show, setShow] = useState(false);
  const isPass = type === "password";
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          type={isPass && show ? "text" : type}
          placeholder={placeholder} value={value} onChange={onChange} autoFocus={autoFocus}
          style={{ ...iStyle, paddingRight: isPass ? 52 : 14, borderColor: error ? "var(--red)" : "var(--border)" }}
          onFocus={e => e.target.style.borderColor = error ? "var(--red)" : "var(--amber)"}
          onBlur={e => e.target.style.borderColor = error ? "var(--red)" : "var(--border)"}
        />
        {isPass && <button type="button" onClick={() => setShow(s => !s)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}>{show ? "Hide" : "Show"}</button>}
      </div>
      {error && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function StrengthBar({ password }) {
  const score = [password.length >= 8, password.length >= 12, /[A-Z]/.test(password), /[0-9]/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
  const colors = ["", "var(--red)", "var(--red)", "var(--amber)", "var(--amber)", "var(--green)"];
  const labels = ["", "Weak", "Weak", "Fair", "Good", "Strong"];
  if (!password) return null;
  return (
    <div style={{ marginBottom: 16, marginTop: -8 }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        {[1,2,3,4,5].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 99, background: i <= score ? colors[score] : "var(--border)", transition: "background 0.3s" }} />)}
      </div>
      <div style={{ fontSize: 11, color: colors[score], textAlign: "right" }}>{labels[score]}</div>
    </div>
  );
}

function SubmitBtn({ loading, children }) {
  return (
    <button type="submit" disabled={loading} style={{ width: "100%", padding: 12, borderRadius: 9, border: "none", background: loading ? "var(--bg-elevated)" : "var(--amber)", color: loading ? "var(--muted)" : "#0e0f11", fontSize: 14, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: "'DM Sans', sans-serif", marginTop: 8, transition: "all 0.2s" }}>
      {loading ? <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span>Working…</span> : children}
    </button>
  );
}

function Err({ msg }) {
  if (!msg) return null;
  return <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(199,84,84,0.1)", border: "1px solid rgba(199,84,84,0.3)", color: "var(--red)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>{msg}</div>;
}

function Ok({ msg }) {
  if (!msg) return null;
  return <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(92,186,108,0.1)", border: "1px solid rgba(92,186,108,0.3)", color: "var(--green)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>{msg}</div>;
}

function Link({ children, onClick }) {
  return <button onClick={onClick} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--amber)", fontWeight: 600, fontSize: 13, fontFamily: "'DM Sans', sans-serif", padding: 0 }}>{children}</button>;
}

function Divider() {
  return <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0" }}><div style={{ flex: 1, height: 1, background: "var(--border)" }} /><span style={{ fontSize: 11, color: "var(--muted)" }}>or</span><div style={{ flex: 1, height: 1, background: "var(--border)" }} /></div>;
}

// ─── SIGN IN ──────────────────────────────────────────────────────────────────

function SignIn({ onSignUp, onForgot }) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [pass,  setPass]  = useState("");
  const [err,   setErr]   = useState("");
  const [fe,    setFe]    = useState({});
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const e = {};
    if (!email.trim())                              e.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Enter a valid email";
    if (!pass) e.pass = "Password is required";
    setFe(e);
    return !Object.keys(e).length;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setLoading(true); setErr("");
    try {
      await login(email.trim(), pass);
    } catch (e) {
      const m = (e?.message || "").toLowerCase();
      setErr(m.includes("invalid") || m.includes("credential")
        ? "Incorrect email or password."
        : m.includes("confirm")
        ? "Please confirm your email before signing in."
        : "Sign in failed — please try again.");
    }
    setLoading(false);
  };

  return (
    <Shell>
      <Logo />
      <Card>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Welcome back</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 24 }}>Sign in to your Bunker</p>
        <Err msg={err} />
        <form onSubmit={submit} noValidate>
          <Field label="Email" type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setFe(f => ({ ...f, email: "" })); }} autoFocus error={fe.email} />
          <Field label="Password" type="password" placeholder="Your password" value={pass} onChange={e => { setPass(e.target.value); setFe(f => ({ ...f, pass: "" })); }} error={fe.pass} />
          <div style={{ textAlign: "right", marginTop: -8, marginBottom: 16 }}>
            <Link onClick={onForgot}>Forgot password?</Link>
          </div>
          <SubmitBtn loading={loading}>Sign In</SubmitBtn>
        </form>
        <Divider />
        <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-secondary)" }}>Don't have an account? <Link onClick={onSignUp}>Create one free</Link></p>
      </Card>
      <p style={{ textAlign: "center", fontSize: 11, color: "var(--muted)", marginTop: 20 }}>Scout plan is always free · No credit card required</p>
    </Shell>
  );
}

// ─── SIGN UP ──────────────────────────────────────────────────────────────────

function SignUp({ onSignIn }) {
  const { signup } = useAuth();
  const [email,   setEmail]   = useState("");
  const [pass,    setPass]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [ok,      setOk]      = useState("");
  const [fe,      setFe]      = useState({});
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const e = {};
    if (!email.trim())                                  e.email   = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email  = "Enter a valid email";
    if (!pass)                                           e.pass   = "Password is required";
    else if (pass.length < 8)                            e.pass   = "Must be at least 8 characters";
    if (!confirm)                                        e.confirm = "Please confirm your password";
    else if (confirm !== pass)                           e.confirm = "Passwords don't match";
    setFe(e);
    return !Object.keys(e).length;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setLoading(true); setErr("");
    try {
      await signup(email.trim(), pass);
      setOk("Account created! Check your email to confirm, then sign in.");
    } catch (e) {
      const m = (e?.message || "").toLowerCase();
      setErr(m.includes("already") ? "An account with this email already exists." : "Sign up failed — please try again.");
    }
    setLoading(false);
  };

  return (
    <Shell>
      <Logo />
      <Card>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Create your account</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 24 }}>Free forever on Scout · Upgrade when you're ready</p>
        <Ok msg={ok} />
        <Err msg={err} />
        {!ok && (
          <form onSubmit={submit} noValidate>
            <Field label="Email" type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setFe(f => ({ ...f, email: "" })); }} autoFocus error={fe.email} />
            <Field label="Password" type="password" placeholder="Min. 8 characters" value={pass} onChange={e => { setPass(e.target.value); setFe(f => ({ ...f, pass: "" })); }} error={fe.pass} />
            <StrengthBar password={pass} />
            <Field label="Confirm Password" type="password" placeholder="Repeat your password" value={confirm} onChange={e => { setConfirm(e.target.value); setFe(f => ({ ...f, confirm: "" })); }} error={fe.confirm} />
            <SubmitBtn loading={loading}>Create Account</SubmitBtn>
            <p style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", marginTop: 12, lineHeight: 1.5 }}>By creating an account you agree to our Terms and Privacy Policy</p>
          </form>
        )}
        {ok && <button onClick={onSignIn} style={{ width: "100%", padding: 12, borderRadius: 9, border: "none", background: "var(--amber)", color: "#0e0f11", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", marginTop: 8 }}>Go to Sign In</button>}
        <Divider />
        <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-secondary)" }}><Link onClick={onSignIn}>Sign in instead</Link></p>
      </Card>
    </Shell>
  );
}

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

function ForgotPassword({ onSignIn }) {
  const { requestPasswordRecovery } = useAuth();
  const [email,   setEmail]   = useState("");
  const [sent,    setSent]    = useState(false);
  const [err,     setErr]     = useState("");
  const [fe,      setFe]      = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (ev) => {
    ev.preventDefault();
    if (!email.trim()) { setFe("Email is required"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFe("Enter a valid email"); return; }
    setLoading(true); setErr("");
    try {
      await requestPasswordRecovery(email.trim());
      setSent(true);
    } catch {
      setErr("Couldn't send reset email. Check the address and try again.");
    }
    setLoading(false);
  };

  return (
    <Shell>
      <Logo />
      <Card>
        {!sent ? (
          <>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Reset your password</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 24 }}>Enter your email and we'll send a reset link.</p>
            <Err msg={err} />
            <form onSubmit={submit} noValidate>
              <Field label="Email" type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setFe(""); }} autoFocus error={fe} />
              <SubmitBtn loading={loading}>Send Reset Link</SubmitBtn>
            </form>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ width: 52, height: 52, borderRadius: 99, background: "rgba(92,186,108,0.15)", border: "1px solid rgba(92,186,108,0.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 16px" }}>✓</div>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Check your inbox</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: 16 }}>
              We sent a reset link to <strong style={{ color: "var(--text)" }}>{email}</strong>. It expires in 1 hour.
            </p>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>Didn't get it? <Link onClick={() => setSent(false)}>Try again</Link></p>
          </div>
        )}
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)", textAlign: "center" }}>
          <Link onClick={onSignIn}>← Back to sign in</Link>
        </div>
      </Card>
    </Shell>
  );
}

// ─── AUTH GATE ────────────────────────────────────────────────────────────────

export function AuthGate({ children }) {
  const { user, loading } = useAuth();
  const [screen, setScreen] = useState("signin");

  if (loading) {
    return (
      <div style={{ ...DARK, minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@700&family=DM+Sans:wght@400&display=swap" rel="stylesheet" />
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 900, color: "#0e0f11", fontFamily: "'Fraunces', serif", margin: "0 auto 16px" }}>B</div>
          <div style={{ fontSize: 13, color: "var(--muted)", animation: "pulse 1.5s ease-in-out infinite" }}>Loading…</div>
        </div>
        <style>{`@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}`}</style>
      </div>
    );
  }

  if (!user) {
    if (screen === "signup")  return <SignUp onSignIn={() => setScreen("signin")} />;
    if (screen === "forgot")  return <ForgotPassword onSignIn={() => setScreen("signin")} />;
    return <SignIn onSignUp={() => setScreen("signup")} onForgot={() => setScreen("forgot")} />;
  }

  return children;
}
