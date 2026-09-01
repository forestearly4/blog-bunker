import { useState, useRef } from "react";

const PLANS = [
  { id:"scout",     name:"Scout",     price:"$19/mo", byokPrice:"$16/mo", color:"#8a8880", features:["1 workspace","15,000 AI words/mo","20 AI images/mo","Meta (Facebook & Instagram) posting","Bring your own AI key","Community support"] },
  { id:"operative", name:"Operative", price:"$45/mo", byokPrice:"$40/mo", color:"#a67c52", popular:true, features:["3 workspaces included, then +$5/mo per additional workspace","60,000 AI words/mo","100 AI images/mo","Buffer (TikTok, X, Pinterest, Reddit)","Bring your own AI key","Email support"] },
];

const BLOG_TYPES = [
  { id:"outdoors",  label:"Outdoors & Nature",  icon:"◎" },
  { id:"food",      label:"Food & Recipe",       icon:"◈" },
  { id:"lifestyle", label:"Lifestyle",           icon:"◉" },
  { id:"tech",      label:"Tech & Tutorials",    icon:"⊞" },
  { id:"travel",    label:"Travel & Adventure",  icon:"✦" },
  { id:"finance",   label:"Finance & Business",  icon:"◆" },
  { id:"health",    label:"Health & Wellness",   icon:"◐" },
  { id:"other",     label:"Other",               icon:"▤" },
];

const STEPS = ["Welcome","Your Blog","Platform","Choose Plan","All Set"];

const DARK = { "--bg":"#2b2620","--bg-surface":"#3a332a","--bg-elevated":"#443c30","--border":"#4a4234","--text":"#e8dfc9","--text-secondary":"#a89a80","--amber":"#a67c52","--amber-glow":"rgba(166,124,82,0.14)","--green":"#7a9166","--red":"#b3543a","--muted":"#6b5f4d" };
const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box", transition:"border-color 0.2s" };

function ProgressBar({ step }) {
  return (
    <div style={{ padding:"28px 40px 0", display:"flex", alignItems:"center" }}>
      {STEPS.map((s,i) => (
        <div key={s} style={{ display:"contents" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
            <div style={{ width:28, height:28, borderRadius:99, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, background:i<=step?"var(--amber)":"var(--bg-elevated)", border:i<=step?"none":"1px solid var(--border)", color:i<=step?"#0e0f11":"var(--muted)", transition:"all 0.3s" }}>{i<step?"✓":i+1}</div>
            <div style={{ fontSize:10, fontWeight:i===step?700:400, color:i===step?"var(--amber)":i<step?"var(--text-secondary)":"var(--muted)", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{s}</div>
          </div>
          {i<STEPS.length-1 && <div style={{ flex:1, height:1, background:i<step?"var(--amber)":"var(--border)", margin:"0 8px", marginBottom:22, transition:"background 0.4s" }} />}
        </div>
      ))}
    </div>
  );
}

function NavBtns({ onBack, onNext, nextLabel="Continue →", nextDisabled=false, loading=false }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", marginTop:28 }}>
      {onBack ? <button onClick={onBack} style={{ padding:"10px 20px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>← Back</button> : <div />}
      <button onClick={onNext} disabled={nextDisabled||loading} style={{ padding:"10px 28px", borderRadius:8, border:"none", background:nextDisabled||loading?"var(--bg-elevated)":"var(--amber)", color:nextDisabled||loading?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:nextDisabled||loading?"not-allowed":"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8 }}>
        {loading?<><span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>Connecting…</>:nextLabel}
      </button>
    </div>
  );
}

function StepWelcome({ userEmail, onNext }) {
  return (
    <div style={{ textAlign:"center", padding:"40px 40px 32px" }}>
      <div style={{ width:64, height:64, borderRadius:16, background:"var(--amber)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, fontWeight:900, color:"#0e0f11", fontFamily:"'Fraunces',serif", margin:"0 auto 24px", boxShadow:"0 0 40px rgba(212,160,84,0.25)" }}>B</div>
      <h1 style={{ fontFamily:"'Fraunces',serif", fontSize:28, fontWeight:700, marginBottom:12, lineHeight:1.2 }}>Welcome to The Blog Bunker</h1>
      {userEmail && <p style={{ fontSize:12, color:"var(--muted)", marginBottom:8 }}>Signed in as <span style={{ color:"var(--text-secondary)" }}>{userEmail}</span></p>}
      <p style={{ fontSize:14, color:"var(--text-secondary)", maxWidth:420, margin:"0 auto 32px", lineHeight:1.7 }}>Your command center for blogging. Let's get your workspace set up in under 2 minutes.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:10, maxWidth:360, margin:"0 auto 36px" }}>
        {[["✦","Manage all your blogs from one dashboard"],["◈","AI writing tools built right in"],["◉","Connect to WordPress, publish with one click"]].map(([icon,text]) => (
          <div key={text} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 14px", borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)", textAlign:"left" }}>
            <span style={{ color:"var(--amber)", fontSize:16 }}>{icon}</span>
            <span style={{ fontSize:13 }}>{text}</span>
          </div>
        ))}
      </div>
      <button onClick={onNext} style={{ padding:"12px 36px", borderRadius:10, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:14, fontWeight:700, fontFamily:"'DM Sans',sans-serif", cursor:"pointer" }}>Get Started →</button>
    </div>
  );
}

function StepWorkspace({ data, onChange, onNext, onBack }) {
  const valid = data.name.trim().length > 0;
  return (
    <div style={{ padding:"32px 40px" }}>
      <h2 style={{ fontFamily:"'Fraunces',serif", fontSize:22, fontWeight:700, marginBottom:6 }}>Tell us about your blog</h2>
      <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:28 }}>This becomes your first workspace.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Blog Name *</label>
          <input style={iS} placeholder="e.g. Cask & Stream…" value={data.name} onChange={e=>onChange({...data,name:e.target.value})} autoFocus onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Blog URL (optional)</label>
          <input style={iS} placeholder="caskandstream.com" value={data.url} onChange={e=>onChange({...data,url:e.target.value})} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Blog Type</label>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
            {BLOG_TYPES.map(bt => (
              <button key={bt.id} onClick={()=>onChange({...data,type:bt.id})} style={{ padding:"10px 8px", borderRadius:8, border:data.type===bt.id?"1px solid var(--amber)":"1px solid var(--border)", background:data.type===bt.id?"var(--amber-glow)":"var(--bg-elevated)", color:data.type===bt.id?"var(--amber)":"var(--text-secondary)", fontSize:11, fontWeight:600, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4, fontFamily:"'DM Sans',sans-serif" }}>
                <span style={{ fontSize:16 }}>{bt.icon}</span>{bt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Short Description (optional)</label>
          <textarea rows={2} style={{ ...iS, resize:"none" }} placeholder="What's your blog about?" value={data.desc} onChange={e=>onChange({...data,desc:e.target.value})} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        </div>
      </div>
      <NavBtns onBack={onBack} onNext={onNext} nextDisabled={!valid} />
    </div>
  );
}

function StepPlatform({ data, onChange, onNext, onBack }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const handleConnect = async () => {
    if (!data.siteUrl.trim() || !data.username.trim() || !data.appPassword.trim()) return;
    setConnecting(true); setError("");
    try {
      const res = await fetch("/api/wordpress-post", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action:"testConnection", siteUrl: data.siteUrl.trim(), username: data.username.trim(), appPassword: data.appPassword.trim() }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      onChange({ ...data, connected:true });
    } catch(e) {
      setError(e.message);
    }
    setConnecting(false);
  };
  return (
    <div style={{ padding:"32px 40px" }}>
      <h2 style={{ fontFamily:"'Fraunces',serif", fontSize:22, fontWeight:700, marginBottom:6 }}>Connect your platform</h2>
      <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:28 }}>Link your WordPress site to publish directly, no copy-paste needed.</p>
      <div style={{ display:"flex", gap:10, marginBottom:24 }}>
        {[{id:"wordpress",label:"WordPress",icon:"W"},{id:"other",label:"Other / Later",icon:"◎"}].map(p => (
          <button key={p.id} onClick={()=>onChange({...data,platform:p.id,connected:false,siteUrl:"",username:"",appPassword:""})} style={{ flex:1, padding:14, borderRadius:10, border:data.platform===p.id?"1px solid var(--amber)":"1px solid var(--border)", background:data.platform===p.id?"var(--amber-glow)":"var(--bg-elevated)", color:data.platform===p.id?"var(--amber)":"var(--text-secondary)", fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
            <span style={{ fontSize:15, fontWeight:700 }}>{p.icon}</span>{p.label}
          </button>
        ))}
      </div>
      {data.platform==="wordpress" && (data.connected
        ? <div style={{ padding:16, borderRadius:10, border:"1px solid rgba(92,186,108,0.4)", background:"rgba(92,186,108,0.08)", display:"flex", alignItems:"center", gap:12 }}><span style={{ width:10, height:10, borderRadius:99, background:"#7a9166", display:"inline-block", boxShadow:"0 0 8px rgba(92,186,108,0.5)" }}/><span style={{ fontWeight:600, fontSize:13 }}>WordPress Connected!</span></div>
        : <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ fontSize:11, color:"var(--text-secondary)", padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", lineHeight:1.6 }}>
              In your WordPress admin: <strong style={{ color:"var(--amber)" }}>Users → Profile → Application Passwords</strong> — name it "Blog Bunker" and generate one. No plugin needed, it's built into WordPress.
            </div>
            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Site URL</label>
              <input style={iS} placeholder="yourblog.com" value={data.siteUrl} onChange={e=>onChange({...data,siteUrl:e.target.value})} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            </div>
            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>WordPress Username</label>
              <input style={iS} placeholder="your-username" value={data.username} onChange={e=>onChange({...data,username:e.target.value})} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            </div>
            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Application Password</label>
              <input type="password" style={iS} placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" value={data.appPassword} onChange={e=>onChange({...data,appPassword:e.target.value})} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            </div>
            {error && <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33" }}>{error}</div>}
            <button onClick={handleConnect} disabled={!data.siteUrl.trim()||!data.username.trim()||!data.appPassword.trim()||connecting} style={{ padding:10, borderRadius:8, border:"none", background:data.siteUrl.trim()?"var(--amber)":"var(--bg-elevated)", color:data.siteUrl.trim()?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:data.siteUrl.trim()?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              {connecting?<><span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>Connecting…</>:"Connect WordPress"}
            </button>
          </div>
      )}
      {data.platform==="other" && <div style={{ padding:20, borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)", textAlign:"center", fontSize:13, color:"var(--text-secondary)" }}>No problem — connect a platform later from Settings.</div>}
      <NavBtns onBack={onBack} onNext={onNext} />
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function StepPlan({ data, onChange, onNext, onBack }) {
  return (
    <div style={{ padding:"32px 40px" }}>
      <h2 style={{ fontFamily:"'Fraunces',serif", fontSize:22, fontWeight:700, marginBottom:6 }}>Choose your plan</h2>
      <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:24 }}>Your first month is free on us, no credit card required. Switch anytime.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {PLANS.map(plan => (
          <button key={plan.id} onClick={()=>onChange({...data,plan:plan.id})} style={{ padding:"16px 20px", borderRadius:12, cursor:"pointer", border:data.plan===plan.id?`1px solid ${plan.color}`:"1px solid var(--border)", background:data.plan===plan.id?plan.color+"12":"var(--bg-elevated)", textAlign:"left", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:16 }}>
            <div style={{ width:20, height:20, borderRadius:99, flexShrink:0, border:data.plan===plan.id?`5px solid ${plan.color}`:"1px solid var(--border)", background:data.plan===plan.id?plan.color:"transparent", transition:"all 0.2s" }} />
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                <span style={{ fontFamily:"'Fraunces',serif", fontSize:15, fontWeight:700, color:data.plan===plan.id?plan.color:"var(--text)" }}>{plan.name}</span>
                {plan.popular && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.1em", padding:"2px 7px", borderRadius:99, background:"var(--amber)22", color:"var(--amber)", textTransform:"uppercase" }}>Most Popular</span>}
                <span style={{ marginLeft:"auto", fontSize:15, fontWeight:700, color:data.plan===plan.id?plan.color:"var(--text-secondary)", fontFamily:"'Fraunces',serif" }}>{plan.price}</span>
              </div>
              {plan.byokPrice && (
                <div style={{ fontSize:10, color:"#7a9166", marginBottom:4 }}>
                  or {plan.byokPrice} with your own AI key
                </div>
              )}
              <div style={{ display:"flex", flexWrap:"wrap", gap:"4px 16px" }}>{plan.features.map(f=><span key={f} style={{ fontSize:11, color:"var(--text-secondary)" }}>· {f}</span>)}</div>
            </div>
          </button>
        ))}
      </div>
      <NavBtns onBack={onBack} onNext={onNext} nextLabel="Finish Setup →" />
    </div>
  );
}

// Generates one genuinely personalized first-post idea from what the user
// just told us about their blog — this is the actual "payoff" moment, kicked
// off in the background during Platform/Plan so it's ready by the time they
// reach the final screen rather than making them wait on a loading spinner.
async function generateFirstIdea(blogName, blogTypeLabel, desc, userEmail) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      system: `You are a blog content strategist. Given a blog's name, niche, and description, suggest ONE compelling first post idea tailored specifically to it. Respond with ONLY valid JSON, no fences, no other text: {"title":"a specific, compelling post title","hook":"one sentence on why this angle works for this particular blog","keyword":"a realistic SEO keyword phrase this post could target"}`,
      messages: [{ role: "user", content: `Blog name: ${blogName}\nNiche: ${blogTypeLabel}\nDescription: ${desc || "(not provided — infer from the name and niche)"}` }],
      userId: userEmail || null,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || data.error);
  const text = (data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

function StepDone({ wsData, platformData, planData, ideaData, onComplete }) {
  const plan = PLANS.find(p=>p.id===planData.plan)||PLANS[0];
  const blogType = BLOG_TYPES.find(b=>b.id===wsData.type);
  const handleGo = () => onComplete({ ...wsData, ...platformData, plan:planData.plan, firstIdea: ideaData?.title ? ideaData : null });
  return (
    <div style={{ padding:40, textAlign:"center" }}>
      <div style={{ width:64, height:64, borderRadius:99, background:"rgba(92,186,108,0.15)", border:"2px solid #7a9166", display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, margin:"0 auto 20px" }}>✓</div>
      <h2 style={{ fontFamily:"'Fraunces',serif", fontSize:24, fontWeight:700, marginBottom:8 }}>You're in the Bunker.</h2>
      <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:24 }}>Your workspace is ready. Here's what we set up:</p>
      <div style={{ display:"flex", flexDirection:"column", gap:10, maxWidth:400, margin:"0 auto 24px", textAlign:"left" }}>
        {[
          { icon:"▤", label:"Workspace", value:wsData.name||"My Blog", sub:blogType?`${blogType.icon} ${blogType.label}`:null, color:null },
          { icon:"◉", label:"Platform", value:platformData.platform==="wordpress"&&platformData.connected?"WordPress — Connected":platformData.platform==="wordpress"?"WordPress — Not connected":"No platform yet", color:platformData.connected?"#7a9166":null },
          { icon:"✦", label:"Plan", value:`${plan.name} — first month free`, color:plan.color },
        ].map(row=>(
          <div key={row.label} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
            <span style={{ color:"var(--amber)", fontSize:16 }}>{row.icon}</span>
            <span style={{ fontSize:12, color:"var(--muted)", width:72, flexShrink:0 }}>{row.label}</span>
            <div><span style={{ fontSize:13, fontWeight:600, color:row.color||"var(--text)" }}>{row.value}</span>{row.sub&&<span style={{ fontSize:11, color:"var(--text-secondary)", marginLeft:8 }}>{row.sub}</span>}</div>
          </div>
        ))}
      </div>

      {/* The real payoff — a genuinely personalized first post idea, ready to write */}
      <div style={{ maxWidth:400, margin:"0 auto 32px", padding:18, borderRadius:12, background:"linear-gradient(135deg, var(--amber-glow), transparent)", border:"1px solid var(--amber)44", textAlign:"left" }}>
        <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)", marginBottom:8 }}>✦ We already wrote you an idea</div>
        {ideaData?.loading ? (
          <div style={{ fontSize:13, color:"var(--text-secondary)", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span> Still thinking of the perfect angle for {wsData.name || "your blog"}…
          </div>
        ) : ideaData?.title ? (
          <>
            <div style={{ fontFamily:"'Fraunces',serif", fontSize:16, fontWeight:700, marginBottom:6, lineHeight:1.3 }}>{ideaData.title}</div>
            <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.6 }}>{ideaData.hook}</div>
          </>
        ) : (
          <div style={{ fontSize:12, color:"var(--text-secondary)" }}>Head to the Article Pipeline whenever you're ready — Claude will help you brainstorm your first post.</div>
        )}
      </div>

      <button onClick={handleGo} style={{ padding:"13px 40px", borderRadius:10, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:14, fontWeight:700, fontFamily:"'DM Sans',sans-serif", cursor:"pointer", boxShadow:"0 0 24px rgba(212,160,84,0.25)" }}>
        {ideaData?.title ? "Start Writing This Post →" : "Go to Dashboard →"}
      </button>
    </div>
  );
}

export default function OnboardingFlow({ userEmail="", onComplete }) {
  const [step, setStep] = useState(0);
  const [wsData, setWsData] = useState({ name:"", url:"", type:"outdoors", desc:"" });
  const [platformData, setPlatformData] = useState({ platform:"wordpress", siteUrl:"", username:"", appPassword:"", connected:false });
  const [planData, setPlanData] = useState({ plan:"scout" });
  const [ideaData, setIdeaData] = useState(null);
  const ideaRequestedRef = useRef(false);
  const next = () => {
    // Kick off idea generation in the background the moment they leave the
    // workspace-details step (name/type/desc) — by the time they finish
    // Platform + Plan, the result is usually ready instead of a dead wait.
    if (step === 1 && wsData.name.trim() && !ideaRequestedRef.current) {
      ideaRequestedRef.current = true;
      setIdeaData({ loading:true });
      const typeLabel = BLOG_TYPES.find(b=>b.id===wsData.type)?.label || wsData.type;
      generateFirstIdea(wsData.name, typeLabel, wsData.desc, userEmail)
        .then(idea => setIdeaData({ loading:false, ...idea }))
        .catch(() => setIdeaData({ loading:false })); // fall back to the generic CTA — never block onboarding on this
    }
    setStep(s=>Math.min(s+1,4));
  };
  const back = () => setStep(s=>Math.max(s-1,0));
  return (
    <div style={{ ...DARK, minHeight:"100vh", background:"var(--bg)", fontFamily:"'DM Sans',sans-serif", color:"var(--text)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", backgroundImage:"radial-gradient(circle at 1px 1px, #2a2b3320 1px, transparent 0)", backgroundSize:"32px 32px" }} />
      <div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:620, background:"var(--bg-surface)", borderRadius:16, border:"1px solid var(--border)", overflow:"hidden", boxShadow:"0 32px 80px rgba(0,0,0,0.5)" }}>
        {step>0&&step<4&&<ProgressBar step={step} />}
        {step===0&&<StepWelcome userEmail={userEmail} onNext={next} />}
        {step===1&&<StepWorkspace data={wsData} onChange={setWsData} onNext={next} onBack={back} />}
        {step===2&&<StepPlatform data={platformData} onChange={setPlatformData} onNext={next} onBack={back} />}
        {step===3&&<StepPlan data={planData} onChange={setPlanData} onNext={next} onBack={back} />}
        {step===4&&<StepDone wsData={wsData} platformData={platformData} planData={planData} ideaData={ideaData} onComplete={onComplete} />}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
