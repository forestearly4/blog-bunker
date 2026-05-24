import { useState, useRef, useEffect } from "react";

// ─── SEED DATA ────────────────────────────────────────────────────────────────

const DEFAULT_POSTS = [
  { id:1, title:"Cast at Dawn, Sip at Dusk: A Philosophy",           status:"published", date:"2026-03-28", views:1843, category:"Culture"      },
  { id:2, title:"Whiskey & Waders: Perfect Pairings for the Stream",  status:"published", date:"2026-03-22", views:1204, category:"Whiskey"      },
  { id:3, title:"Dry Flies & Drams: A Field Guide",                   status:"draft",     date:"2026-03-30", views:0,    category:"Gear"         },
  { id:4, title:"Spring Runoff on the Madison River",                 status:"scheduled", date:"2026-04-03", views:0,    category:"Destinations" },
  { id:5, title:"The Bamboo Rod & Bourbon: Slow Living on the Water", status:"published", date:"2026-03-15", views:967,  category:"Culture"      },
  { id:6, title:"Small Stream Secrets of the Smokies",                status:"draft",     date:"2026-03-29", views:0,    category:"Destinations" },
  { id:7, title:"Best Single Malts for a Day on the River",           status:"published", date:"2026-03-10", views:2104, category:"Whiskey"      },
  { id:8, title:"Matching the Hatch: A Seasonal Primer",              status:"scheduled", date:"2026-04-01", views:0,    category:"Technique"    },
];

const DEFAULT_ANALYTICS = {
  totalViews:6118, viewsTrend:18.4, subscribers:142, subsTrend:12.1,
  avgReadTime:"5:14", bounceRate:31.2,
  weeklyViews:[520,680,590,840,920,1100,1468],
  weekLabels:["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
};

const CALENDAR_EVENTS = [
  { day:1,  title:"Matching the Hatch",           type:"scheduled"  },
  { day:3,  title:"Spring Runoff — Madison",       type:"scheduled"  },
  { day:7,  title:"Newsletter: Cast & Cask Weekly",type:"newsletter" },
  { day:10, title:"Bourbon Comparison Post",       type:"idea"       },
  { day:14, title:"Newsletter: Cast & Cask Weekly",type:"newsletter" },
  { day:18, title:"Smoky Mtns Feature",            type:"draft"      },
  { day:21, title:"Newsletter: Cast & Cask Weekly",type:"newsletter" },
  { day:25, title:"Summer River Preview",          type:"idea"       },
  { day:28, title:"Newsletter: Cast & Cask Weekly",type:"newsletter" },
];

const COMPETITORS = [
  { name:"Hatch Magazine",  url:"hatchmag.com",       da:52, posts:"4/wk", traffic:"120K", strengths:"Strong SEO, video content",   threat:"high"   },
  { name:"MidCurrent",      url:"midcurrent.com",      da:48, posts:"3/wk", traffic:"95K",  strengths:"Expert contributors, guides", threat:"high"   },
  { name:"Gink & Gasoline", url:"ginkandgasoline.com", da:41, posts:"2/wk", traffic:"45K",  strengths:"Community, humor",            threat:"medium" },
  { name:"The Drake",       url:"drakemag.com",        da:38, posts:"1/wk", traffic:"30K",  strengths:"Literary voice, photography", threat:"low"    },
  { name:"Whisky Advocate", url:"whiskyadvocate.com",  da:61, posts:"5/wk", traffic:"310K", strengths:"Authority, reviews",          threat:"medium" },
];

const INSPIRATION = [
  { id:1, source:"Reddit r/flyfishing", title:"What whiskey do you bring on the river?",   type:"thread",  notes:"Direct audience overlap — listicle potential"        },
  { id:2, source:"Hatch Magazine",      title:"Why Euro Nymphing Is Taking Over",           type:"article", notes:"Counter-argument: the dry fly purist's case"         },
  { id:3, source:"Whisky Advocate",     title:"The 10 Best Sherried Single Malts of 2026",  type:"article", notes:"Pair each with a river destination — killer concept" },
  { id:4, source:"Instagram @drakemag", title:"Golden hour on the Madison",                 type:"visual",  notes:""                                                    },
];

const PLANS = [
  { name:"Scout",     price:"Free",   features:["1 Workspace","50 Posts","Basic Analytics","Community Support"] },
  { name:"Operative", price:"$19/mo", features:["3 Workspaces","Unlimited Posts","AI Writing Tools","Advanced Analytics","Email Support"] },
  { name:"Command",   price:"$49/mo", features:["Unlimited Workspaces","Team Collaboration","Priority Support","Custom Integrations","Wix API"] },
];

// ─── AI PROVIDER CONFIG ───────────────────────────────────────────────────────

const AI_PROVIDERS = [
  {
    id: "anthropic",
    name: "Claude",
    company: "Anthropic",
    logo: "◈",
    color: "#d4a054",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"],
    defaultModel: "claude-sonnet-4-20250514",
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com",
    capabilities: ["Blog Writer", "Headlines", "SEO Optimizer"],
    endpoint: "anthropic",
  },
  {
    id: "openai",
    name: "GPT-4",
    company: "OpenAI",
    logo: "◎",
    color: "#10a37f",
    models: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    defaultModel: "gpt-4o",
    keyPrefix: "sk-",
    keyPlaceholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    capabilities: ["Blog Writer", "Headlines", "SEO Optimizer"],
    endpoint: "openai",
  },
  {
    id: "gemini",
    name: "Gemini",
    company: "Google",
    logo: "✦",
    color: "#4285f4",
    models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
    defaultModel: "gemini-1.5-pro",
    keyPrefix: "AIza",
    keyPlaceholder: "AIzaSy...",
    docsUrl: "https://aistudio.google.com/apikey",
    capabilities: ["Blog Writer", "Headlines", "SEO Optimizer"],
    endpoint: "gemini",
  },
  {
    id: "stability",
    name: "Stability AI",
    company: "Stability AI",
    logo: "▣",
    color: "#7c3aed",
    models: ["stable-diffusion-3", "stable-image-core", "stable-image-ultra"],
    defaultModel: "stable-image-core",
    keyPrefix: "sk-",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.stability.ai/account/keys",
    capabilities: ["Image Generation"],
    endpoint: "stability",
  },
];

const KEYS_STORAGE = "bb_api_keys";
const MODEL_STORAGE = "bb_ai_models";
const ACTIVE_PROVIDER_STORAGE = "bb_active_provider";

function loadKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS_STORAGE) || "{}"); } catch { return {}; }
}
function saveKeys(keys) {
  try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys)); } catch {}
}
function loadModels() {
  try { return JSON.parse(localStorage.getItem(MODEL_STORAGE) || "{}"); } catch { return {}; }
}
function saveModels(models) {
  try { localStorage.setItem(MODEL_STORAGE, JSON.stringify(models)); } catch {}
}

// ─── MULTI-PROVIDER AI CALLER ─────────────────────────────────────────────────

async function callAI(providerId, model, system, userMsg, apiKey) {
  if (providerId === "anthropic") {
    // Route through Netlify proxy if no client key, otherwise call directly
    const useProxy = !apiKey;
    const endpoint = useProxy ? "/api/claude" : "https://api.anthropic.com/v1/messages";
    const headers = useProxy
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ model, max_tokens: 1500, system, messages: [{ role:"user", content: userMsg }] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Anthropic error");
    return data.content?.[0]?.text || "";
  }

  if (providerId === "openai") {
    if (!apiKey) throw new Error("OpenAI API key required. Add it in Settings → API Keys.");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role:"system", content: system }, { role:"user", content: userMsg }], max_tokens: 1500 }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "OpenAI error");
    return data.choices?.[0]?.message?.content || "";
  }

  if (providerId === "gemini") {
    if (!apiKey) throw new Error("Gemini API key required. Add it in Settings → API Keys.");
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${system}\n\n${userMsg}` }] }], generationConfig: { maxOutputTokens: 1500 } }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Gemini error");
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  if (providerId === "stability") {
    throw new Error("Image generation UI coming soon. Key saved successfully.");
  }

  throw new Error("Unknown provider");
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────

function Sparkline({ data, color, h=40, w=120 }) {
  const max=Math.max(...data), min=Math.min(...data), range=max-min||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-((v-min)/range)*(h-4)-2}`).join(" ");
  const id=`sp${Math.random().toString(36).slice(2)}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{display:"block"}}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity=".3"/>
        <stop offset="100%" stopColor={color} stopOpacity="0"/>
      </linearGradient></defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#${id})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function BarChart({ data, labels, color, height=120 }) {
  const max=Math.max(...data)||1;
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:6,height,width:"100%"}}>
      {data.map((v,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          <div style={{width:"100%",height:`${(v/max)*100}%`,background:color,borderRadius:"4px 4px 2px 2px",minHeight:4,opacity:0.55+(i/data.length)*0.45}}/>
          <span style={{fontSize:10,opacity:.5}}>{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

const StatusBadge = ({status}) => {
  const c={published:{bg:"var(--green)",l:"Published"},draft:{bg:"var(--muted)",l:"Draft"},scheduled:{bg:"var(--amber)",l:"Scheduled"}};
  const t=c[status]||c.draft;
  return <span style={{fontSize:11,fontWeight:600,padding:"2px 10px",borderRadius:99,background:t.bg+"22",color:t.bg,textTransform:"uppercase",letterSpacing:"0.03em"}}>{t.l}</span>;
};

const ThreatBadge = ({level}) => {
  const c={high:"var(--red)",medium:"var(--amber)",low:"var(--green)"};
  return <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:(c[level]||"var(--muted)")+"22",color:c[level]||"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em"}}>{level}</span>;
};

// ─── PROVIDER PICKER ──────────────────────────────────────────────────────────

function ProviderPicker({ activeProvider, activeModel, onProviderChange, onModelChange, keys }) {
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const hasKey = !!keys[activeProvider];
  const isAnthropic = activeProvider === "anthropic";

  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,flexWrap:"wrap"}}>
      <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>AI Provider</div>
      <div style={{display:"flex",gap:6}}>
        {AI_PROVIDERS.filter(p => p.id !== "stability").map(p => {
          const hasK = !!keys[p.id] || p.id === "anthropic";
          return (
            <button key={p.id} onClick={() => onProviderChange(p.id)}
              style={{padding:"5px 12px",borderRadius:99,border:activeProvider===p.id?`1px solid ${p.color}`:"1px solid var(--border)",background:activeProvider===p.id?p.color+"18":"transparent",color:activeProvider===p.id?p.color:"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:5,opacity:hasK?1:0.5}}>
              <span>{p.logo}</span>{p.name}
              {!hasK && <span style={{fontSize:9,color:"var(--muted)"}}>no key</span>}
            </button>
          );
        })}
      </div>
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>Model</div>
        <select value={activeModel} onChange={e => onModelChange(e.target.value)}
          style={{padding:"5px 10px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:12,fontFamily:"var(--font-body)",outline:"none",cursor:"pointer"}}>
          {provider.models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {!hasKey && !isAnthropic && (
        <div style={{width:"100%",fontSize:11,color:"var(--amber)",padding:"6px 12px",borderRadius:6,background:"var(--amber-glow)",border:"1px solid var(--amber)33"}}>
          ⚠ No API key for {provider.name}. Add one in Settings → API Keys.
        </div>
      )}
    </div>
  );
}

// ─── AI TOOLS ─────────────────────────────────────────────────────────────────

function AIWriter({ wsName, activeProvider, activeModel, apiKeys }) {
  const [topic,   setTopic]   = useState("");
  const [tone,    setTone]    = useState("literary");
  const [length,  setLength]  = useState("800");
  const [loading, setLoading] = useState(false);
  const [output,  setOutput]  = useState("");
  const [error,   setError]   = useState("");

  const TONES   = ["literary","informative","conversational","humorous"];
  const LENGTHS = [{label:"Short (~500w)",value:"500"},{label:"Standard (~800w)",value:"800"},{label:"Long (~1200w)",value:"1200"}];
  const provider = AI_PROVIDERS.find(p=>p.id===activeProvider)||AI_PROVIDERS[0];

  const generate = async () => {
    if (!topic.trim()) return;
    setLoading(true); setOutput(""); setError("");
    try {
      const text = await callAI(
        activeProvider, activeModel,
        `You are a writer for Cask & Stream — a fly fishing and whiskey lifestyle blog. Tagline: "Cast at Dawn. Sip at Dusk." Voice: literary, evocative, unhurried. Write markdown with a # title, ## sections, ~${length} words.`,
        `Write a ${tone} blog post about: ${topic}`,
        apiKeys[activeProvider]
      );
      setOutput(text);
    } catch(e) { setError(e.message || "Generation failed."); }
    setLoading(false);
  };

  const iS={width:"100%",padding:"10px 14px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:13,fontFamily:"var(--font-body)",outline:"none",boxSizing:"border-box"};

  return (
    <div style={{display:"grid",gridTemplateColumns:output?"1fr 1fr":"1fr",gap:24}}>
      <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,padding:24,display:"flex",flexDirection:"column",gap:18}}>
        <div>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Topic or Angle</div>
          <input style={iS} placeholder="e.g. Best bourbons to sip after a day of nymphing…" value={topic} onChange={e=>setTopic(e.target.value)} onKeyDown={e=>e.key==="Enter"&&generate()} />
        </div>
        <div>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>Tone</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {TONES.map(t=><button key={t} onClick={()=>setTone(t)} style={{padding:"6px 14px",borderRadius:99,border:tone===t?"1px solid var(--amber)":"1px solid var(--border)",background:tone===t?"var(--amber-glow)":"transparent",color:tone===t?"var(--amber)":"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",textTransform:"capitalize"}}>{t}</button>)}
          </div>
        </div>
        <div>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>Length</div>
          <div style={{display:"flex",gap:6}}>
            {LENGTHS.map(l=><button key={l.value} onClick={()=>setLength(l.value)} style={{flex:1,padding:"8px 10px",borderRadius:8,border:length===l.value?"1px solid var(--amber)":"1px solid var(--border)",background:length===l.value?"var(--amber-glow)":"transparent",color:length===l.value?"var(--amber)":"var(--text-secondary)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)"}}>{l.label}</button>)}
          </div>
        </div>
        <button onClick={generate} disabled={!topic.trim()||loading}
          style={{padding:11,borderRadius:8,border:"none",background:topic.trim()&&!loading?provider.color:"var(--bg-elevated)",color:topic.trim()&&!loading?"#0e0f11":"var(--muted)",fontSize:13,fontWeight:700,cursor:topic.trim()&&!loading?"pointer":"not-allowed",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"background 0.2s"}}>
          {loading?<><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Writing…</>:<>{provider.logo} Generate with {provider.name}</>}
        </button>
        {error&&<div style={{fontSize:12,color:"var(--red)",padding:"8px 12px",borderRadius:6,background:"var(--red)11",border:"1px solid var(--red)33"}}>{error}</div>}
      </div>
      {output&&(
        <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,padding:24,overflow:"auto",maxHeight:520}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--green)"}}>✓ Draft Ready — {provider.name}</div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>navigator.clipboard.writeText(output)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)",fontSize:11,cursor:"pointer",fontFamily:"var(--font-body)"}}>Copy</button>
              <button style={{padding:"5px 12px",borderRadius:6,border:"none",background:"var(--amber)",color:"#0e0f11",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"var(--font-body)"}}>Save as Draft</button>
            </div>
          </div>
          <pre style={{fontFamily:"var(--font-body)",fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap",color:"var(--text)"}}>{output}</pre>
        </div>
      )}
    </div>
  );
}

function HeadlineGenerator({ activeProvider, activeModel, apiKeys }) {
  const [topic,     setTopic]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const [headlines, setHeadlines] = useState([]);
  const [error,     setError]     = useState("");
  const provider = AI_PROVIDERS.find(p=>p.id===activeProvider)||AI_PROVIDERS[0];

  const generate = async () => {
    if (!topic.trim()) return;
    setLoading(true); setHeadlines([]); setError("");
    try {
      const text = await callAI(
        activeProvider, activeModel,
        `You generate headlines for Cask & Stream — a fly fishing and whiskey lifestyle blog. Return ONLY a JSON array of 6 headline strings. No explanation, no markdown fences. Raw JSON array only.`,
        `Topic: ${topic}`,
        apiKeys[activeProvider]
      );
      setHeadlines(JSON.parse(text.replace(/```json|```/g,"").trim()));
    } catch(e) { setError(e.message || "Could not generate headlines. Try again."); }
    setLoading(false);
  };

  const iS={width:"100%",padding:"10px 14px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:13,fontFamily:"var(--font-body)",outline:"none",boxSizing:"border-box"};
  return (
    <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,padding:24,maxWidth:640}}>
      <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Post Topic</div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input style={iS} placeholder="e.g. pairing bourbon with a day on the river…" value={topic} onChange={e=>setTopic(e.target.value)} onKeyDown={e=>e.key==="Enter"&&generate()} />
        <button onClick={generate} disabled={!topic.trim()||loading}
          style={{padding:"10px 18px",borderRadius:8,border:"none",background:provider.color,color:"#0e0f11",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"var(--font-body)",whiteSpace:"nowrap",flexShrink:0}}>
          {loading?"…":"Generate"}
        </button>
      </div>
      {error&&<div style={{fontSize:12,color:"var(--red)",marginBottom:12}}>{error}</div>}
      {headlines.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {headlines.map((h,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderRadius:8,background:"var(--bg-elevated)",border:"1px solid var(--border)",justifyContent:"space-between"}}>
              <span style={{fontSize:13,lineHeight:1.4}}>{h}</span>
              <button onClick={()=>navigator.clipboard.writeText(h)} style={{padding:"4px 10px",borderRadius:6,border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)",fontSize:11,cursor:"pointer",fontFamily:"var(--font-body)",flexShrink:0}}>Copy</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SEOOptimizer({ activeProvider, activeModel, apiKeys }) {
  const [draft,   setDraft]   = useState("");
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState("");
  const provider = AI_PROVIDERS.find(p=>p.id===activeProvider)||AI_PROVIDERS[0];

  const analyze = async () => {
    if (!draft.trim()) return;
    setLoading(true); setResult(null); setError("");
    try {
      const text = await callAI(
        activeProvider, activeModel,
        `You are an SEO expert for Cask & Stream, a fly fishing and whiskey lifestyle blog. Analyze blog drafts and return ONLY valid JSON (no fences) with: {"metaTitle":"...","metaDescription":"...","primaryKeyword":"...","secondaryKeywords":["..."],"suggestions":["..."]}. metaTitle ≤60 chars, metaDescription ≤160 chars.`,
        `Analyze:\n\n${draft.slice(0,1500)}`,
        apiKeys[activeProvider]
      );
      setResult(JSON.parse(text.replace(/```json|```/g,"").trim()));
    } catch(e) { setError(e.message || "Could not parse SEO analysis. Try again."); }
    setLoading(false);
  };

  const iS={width:"100%",padding:"10px 14px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:13,fontFamily:"var(--font-body)",outline:"none",boxSizing:"border-box",resize:"vertical"};
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16,maxWidth:720}}>
      <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,padding:24}}>
        <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Paste Your Draft</div>
        <textarea rows={6} style={iS} placeholder="Paste your blog post draft here…" value={draft} onChange={e=>setDraft(e.target.value)} />
        <button onClick={analyze} disabled={!draft.trim()||loading}
          style={{marginTop:12,padding:"10px 20px",borderRadius:8,border:"none",background:draft.trim()?provider.color:"var(--bg-elevated)",color:draft.trim()?"#0e0f11":"var(--muted)",fontSize:13,fontWeight:700,cursor:draft.trim()?"pointer":"not-allowed",fontFamily:"var(--font-body)"}}>
          {loading?"Analyzing…":`◉ Analyze with ${provider.name}`}
        </button>
        {error&&<div style={{fontSize:12,color:"var(--red)",marginTop:8}}>{error}</div>}
      </div>
      {result&&(
        <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,padding:24,display:"flex",flexDirection:"column",gap:16}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--green)"}}>✓ SEO Analysis Ready — {provider.name}</div>
          {[{label:"Meta Title",value:result.metaTitle},{label:"Meta Description",value:result.metaDescription}].map(f=>(
            <div key={f.label}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:4}}>{f.label}</div>
              <div style={{fontSize:13,padding:"10px 14px",borderRadius:8,background:"var(--bg-elevated)",border:"1px solid var(--border)",fontFamily:"monospace"}}>{f.value}</div>
            </div>
          ))}
          <div>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Keywords</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              <span style={{fontSize:12,fontWeight:600,padding:"4px 10px",borderRadius:99,background:"var(--amber)22",color:"var(--amber)"}}>{result.primaryKeyword}</span>
              {result.secondaryKeywords?.map(k=><span key={k} style={{fontSize:12,padding:"4px 10px",borderRadius:99,background:"var(--bg-elevated)",border:"1px solid var(--border)",color:"var(--text-secondary)"}}>{k}</span>)}
            </div>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Suggestions</div>
            {result.suggestions?.map((s,i)=><div key={i} style={{fontSize:12,color:"var(--text-secondary)",padding:"5px 0",borderBottom:i<result.suggestions.length-1?"1px solid var(--border)":"none"}}>· {s}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS: API KEYS TAB ───────────────────────────────────────────────────

function APIKeysSettings({ apiKeys, onSave }) {
  const [draft,    setDraft]    = useState({ ...apiKeys });
  const [models,   setModels]   = useState(loadModels);
  const [saved,    setSaved]    = useState(false);
  const [testing,  setTesting]  = useState({});
  const [testResult, setTestResult] = useState({});

  const handleSave = () => {
    saveKeys(draft);
    saveModels(models);
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const testKey = async (providerId) => {
    const provider = AI_PROVIDERS.find(p => p.id === providerId);
    const key = draft[providerId];
    if (!key && providerId !== "anthropic") {
      setTestResult(r => ({ ...r, [providerId]: { ok: false, msg: "No key entered" } }));
      return;
    }
    setTesting(t => ({ ...t, [providerId]: true }));
    setTestResult(r => ({ ...r, [providerId]: null }));
    try {
      const model = models[providerId] || provider.defaultModel;
      const text = await callAI(providerId, model, "You are a test assistant.", "Reply with just the word: connected", key || null);
      setTestResult(r => ({ ...r, [providerId]: { ok: true, msg: `Connected — ${provider.name} responded` } }));
    } catch(e) {
      setTestResult(r => ({ ...r, [providerId]: { ok: false, msg: e.message } }));
    }
    setTesting(t => ({ ...t, [providerId]: false }));
  };

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"monospace", outline:"none", boxSizing:"border-box" };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:24}}>
      <div>
        <h3 style={{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,margin:"0 0 4px"}}>API Keys</h3>
        <p style={{fontSize:13,color:"var(--text-secondary)",margin:0,lineHeight:1.6}}>
          Keys are stored locally in your browser. They never leave your device except to call the provider's API directly.
        </p>
      </div>

      {AI_PROVIDERS.map(provider => {
        const hasKey = !!draft[provider.id] || provider.id === "anthropic";
        const tr = testResult[provider.id];
        const isTesting = testing[provider.id];

        return (
          <div key={provider.id} style={{padding:20,borderRadius:12,border:`1px solid ${hasKey ? provider.color+"44" : "var(--border)"}`,background:hasKey?provider.color+"08":"var(--bg-elevated)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
              <div style={{width:36,height:36,borderRadius:10,background:provider.color+"22",border:`1px solid ${provider.color}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:provider.color,flexShrink:0}}>{provider.logo}</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14,display:"flex",alignItems:"center",gap:8}}>
                  {provider.name}
                  <span style={{fontSize:11,color:"var(--text-secondary)",fontWeight:400}}>by {provider.company}</span>
                  {hasKey && <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.08em",padding:"2px 7px",borderRadius:99,background:provider.color+"22",color:provider.color,textTransform:"uppercase"}}>Connected</span>}
                </div>
                <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:2}}>{provider.capabilities.join(" · ")}</div>
              </div>
              <a href={provider.docsUrl} target="_blank" rel="noopener noreferrer"
                style={{fontSize:11,color:"var(--amber)",textDecoration:"none",padding:"4px 10px",borderRadius:6,border:"1px solid var(--amber)44",whiteSpace:"nowrap"}}>
                Get Key ↗
              </a>
            </div>

            {provider.id === "anthropic" ? (
              <div style={{padding:"10px 14px",borderRadius:8,background:"var(--bg-elevated)",border:"1px solid var(--border)",fontSize:12,color:"var(--text-secondary)",lineHeight:1.6}}>
                Claude runs through your Netlify environment variable <code style={{color:"var(--amber)",background:"var(--bg)",padding:"1px 5px",borderRadius:4}}>ANTHROPIC_API_KEY</code> — no browser key needed. You can optionally add a key below to override it.
              </div>
            ) : null}

            <div style={{marginTop:provider.id==="anthropic"?12:0}}>
              <label style={{display:"block",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>
                {provider.id === "anthropic" ? "Override API Key (optional)" : "API Key"}
              </label>
              <input
                type="password"
                placeholder={provider.keyPlaceholder}
                value={draft[provider.id] || ""}
                onChange={e => setDraft(d => ({ ...d, [provider.id]: e.target.value }))}
                style={iS}
                onFocus={e => e.target.style.borderColor = provider.color}
                onBlur={e => e.target.style.borderColor = "var(--border)"}
              />
            </div>

            <div style={{marginTop:12}}>
              <label style={{display:"block",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Default Model</label>
              <select
                value={models[provider.id] || provider.defaultModel}
                onChange={e => setModels(m => ({ ...m, [provider.id]: e.target.value }))}
                style={{padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",cursor:"pointer",width:"100%"}}>
                {provider.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>

            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:14}}>
              <button onClick={() => testKey(provider.id)} disabled={isTesting}
                style={{padding:"7px 16px",borderRadius:7,border:`1px solid ${provider.color}44`,background:"transparent",color:provider.color,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",display:"flex",alignItems:"center",gap:6}}>
                {isTesting ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Testing…</> : "Test Connection"}
              </button>
              {tr && (
                <span style={{fontSize:12,color:tr.ok?"var(--green)":"var(--red)",display:"flex",alignItems:"center",gap:4}}>
                  {tr.ok ? "✓" : "✗"} {tr.msg}
                </span>
              )}
            </div>
          </div>
        );
      })}

      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <button onClick={handleSave}
          style={{padding:"10px 28px",borderRadius:8,border:"none",background:"var(--amber)",color:"#0e0f11",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
          Save API Keys
        </button>
        {saved && <span style={{fontSize:12,color:"var(--green)"}}>✓ Saved to browser storage</span>}
      </div>

      <div style={{padding:"12px 16px",borderRadius:8,background:"var(--bg-elevated)",border:"1px solid var(--border)",fontSize:12,color:"var(--text-secondary)",lineHeight:1.7}}>
        🔒 <strong style={{color:"var(--text)"}}>Privacy note:</strong> API keys are stored in your browser's localStorage and only sent directly to each provider's API. They are never stored on any server.
      </div>
    </div>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────

export default function Dashboard({ user, workspace, onLogout }) {
  const [dark,            setDark]           = useState(true);
  const [activeTab,       setActiveTab]      = useState("posts");
  const [postFilter,      setPostFilter]     = useState("all");
  const [researchTab,     setResearchTab]    = useState("competitors");
  const [aiTool,          setAiTool]         = useState("writer");
  const [settingsSection, setSettingsSection]= useState("general");
  const [showUpgrade,     setShowUpgrade]    = useState(false);
  const [posts,           setPosts]          = useState(DEFAULT_POSTS);
  const [apiKeys,         setApiKeys]        = useState(loadKeys);
  const [activeProvider,  setActiveProvider] = useState(() => localStorage.getItem(ACTIVE_PROVIDER_STORAGE) || "anthropic");
  const [activeModel,     setActiveModel]    = useState(() => { const m = loadModels(); const p = AI_PROVIDERS.find(x=>x.id===(localStorage.getItem(ACTIVE_PROVIDER_STORAGE)||"anthropic"))||AI_PROVIDERS[0]; return m[p.id] || p.defaultModel; });

  const handleProviderChange = (id) => {
    setActiveProvider(id);
    localStorage.setItem(ACTIVE_PROVIDER_STORAGE, id);
    const p = AI_PROVIDERS.find(x => x.id === id);
    const m = loadModels();
    setActiveModel(m[id] || p.defaultModel);
  };

  const handleModelChange = (model) => {
    setActiveModel(model);
    const m = loadModels();
    m[activeProvider] = model;
    saveModels(m);
  };

  const wsName    = workspace?.name      || "Cask & Stream";
  const wsUrl     = workspace?.url       || "caskandstream.com";
  const connected = workspace?.connected || false;
  const plan      = "operative";
  const planLabel = "Operative";
  const isScout   = false;
  const fixedGreen= "#5cba6c";

  const filteredPosts = posts.filter(p => postFilter==="all" ? true : p.status===postFilter);

  const theme = dark ? {
    "--bg":"#0e0f11","--bg-surface":"#16171b","--bg-elevated":"#1c1d22","--bg-hover":"#22232a",
    "--border":"#2a2b33","--text":"#e8e6e1","--text-secondary":"#8a8880",
    "--amber":"#d4a054","--amber-glow":"rgba(212,160,84,0.12)",
    "--green":"#5cba6c","--red":"#c75454","--muted":"#5c5b56",
    "--sidebar-bg":"#111215",
    "--font-display":"'Fraunces',serif","--font-body":"'DM Sans',sans-serif",
  } : {
    "--bg":"#f5f2ec","--bg-surface":"#ffffff","--bg-elevated":"#faf8f4","--bg-hover":"#eeeae2",
    "--border":"#ddd8ce","--text":"#1a1915","--text-secondary":"#6b6860",
    "--amber":"#b8862e","--amber-glow":"rgba(184,134,46,0.1)",
    "--green":"#3d8a4e","--red":"#b84040","--muted":"#9a9590",
    "--sidebar-bg":"#eae6dc",
    "--font-display":"'Fraunces',serif","--font-body":"'DM Sans',sans-serif",
  };

  const card    = { background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 };
  const btnP    = { padding:"8px 18px", border:"none", borderRadius:8, background:"var(--amber)", color:dark?"#0e0f11":"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" };
  const btnS    = { padding:"8px 16px", border:"1px solid var(--border)", borderRadius:8, background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, cursor:"pointer", fontFamily:"var(--font-body)" };
  const inputSt = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const connectedProviders = AI_PROVIDERS.filter(p => p.id === "anthropic" || !!apiKeys[p.id]).length;

  const TABS = [
    { id:"posts",     label:"Posts",     icon:"▤" },
    { id:"analytics", label:"Analytics", icon:"◔" },
    { id:"calendar",  label:"Calendar",  icon:"▦" },
    { id:"research",  label:"Research",  icon:"◎" },
    { id:"ai",        label:"AI Tools",  icon:"✦" },
    { id:"settings",  label:"Settings",  icon:"⚙" },
  ];

  const SETTINGS_SECTIONS = [
    { id:"general",  label:"General"          },
    { id:"apikeys",  label:"API Keys"         },
    { id:"wix",      label:"Wix Integration"  },
    { id:"billing",  label:"Billing & Plan"   },
    { id:"account",  label:"Account"          },
  ];

  return (
    <div style={{...theme,fontFamily:"var(--font-body)",color:"var(--text)",background:"var(--bg)",minHeight:"100vh",display:"flex",fontSize:14,lineHeight:1.5}}>
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* ── SIDEBAR ── */}
      <aside style={{width:220,minWidth:220,background:"var(--sidebar-bg)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"20px 20px 16px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:"var(--amber)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:dark?"#0e0f11":"#fff",fontFamily:"var(--font-display)",flexShrink:0}}>B</div>
          <div>
            <div style={{fontFamily:"var(--font-display)",fontWeight:700,fontSize:14,lineHeight:1.1}}>Blog Bunker</div>
            <div style={{fontSize:9,color:"var(--text-secondary)",letterSpacing:"0.05em",textTransform:"uppercase"}}>Command Center</div>
          </div>
        </div>

        <div style={{margin:"12px 12px 0",padding:"12px 14px",borderRadius:10,background:"var(--amber-glow)",border:"1px solid var(--amber)33"}}>
          <div style={{fontSize:16,marginBottom:2}}>🥃</div>
          <div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{wsName}</div>
          <div style={{fontSize:10,color:"var(--amber)",fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase"}}>{planLabel}</div>
          {wsUrl&&<div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>{wsUrl}</div>}
          <div style={{fontSize:10,marginTop:6,color:connected?fixedGreen:"var(--muted)"}}>
            <span style={{width:6,height:6,borderRadius:99,background:connected?fixedGreen:"var(--muted)",display:"inline-block",marginRight:4}}/>
            {connected?"Wix Connected":"Wix Not Connected"}
          </div>
          <div style={{fontSize:10,marginTop:4,color:"var(--text-secondary)"}}>
            <span style={{color:fixedGreen}}>◈</span> {connectedProviders} AI provider{connectedProviders!==1?"s":""} connected
          </div>
        </div>

        <nav style={{padding:"12px 12px",flex:1}}>
          <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--muted)",padding:"0 8px 6px"}}>Modules</div>
          {TABS.map(t=>(
            <div key={t.id} onClick={()=>setActiveTab(t.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,cursor:"pointer",background:activeTab===t.id?"var(--bg-elevated)":"transparent",color:activeTab===t.id?"var(--amber)":"var(--text-secondary)",fontWeight:activeTab===t.id?600:400,fontSize:13,marginBottom:2,transition:"all 0.15s"}}>
              <span style={{fontSize:15,width:18,textAlign:"center"}}>{t.icon}</span>
              {t.label}
            </div>
          ))}
        </nav>

        <div style={{padding:"12px 16px",borderTop:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
          <div onClick={()=>setDark(!dark)} style={{width:36,height:20,borderRadius:99,background:dark?"var(--amber)":"var(--border)",cursor:"pointer",position:"relative",transition:"background 0.3s",flexShrink:0}}>
            <div style={{width:14,height:14,borderRadius:99,background:dark?"#0e0f11":"#fff",position:"absolute",top:3,left:dark?19:3,transition:"left 0.3s",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8}}>{dark?"🌙":"☀️"}</div>
          </div>
          <div style={{flex:1,overflow:"hidden"}}>
            <div style={{fontSize:11,color:"var(--muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.email}</div>
          </div>
          <button onClick={onLogout} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:16,padding:0,lineHeight:1}} title="Sign out">⎋</button>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <header style={{padding:"16px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--bg-surface)"}}>
          <div>
            <h1 style={{fontFamily:"var(--font-display)",fontSize:22,fontWeight:700,margin:0}}>🥃 {wsName}</h1>
            <p style={{margin:"2px 0 0",fontSize:12,color:"var(--text-secondary)"}}>
              {posts.length} posts · Cast at Dawn. Sip at Dusk.
            </p>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button style={btnS}>Import</button>
            <button style={btnP}>+ New Post</button>
          </div>
        </header>

        <div style={{flex:1,overflow:"auto",padding:28}}>

          {/* ══ POSTS ══ */}
          {activeTab==="posts"&&(
            <div>
              <div style={{display:"flex",gap:8,marginBottom:20}}>
                {["all","published","draft","scheduled"].map(f=>(
                  <button key={f} onClick={()=>setPostFilter(f)} style={{padding:"6px 14px",borderRadius:99,border:postFilter===f?"1px solid var(--amber)":"1px solid var(--border)",background:postFilter===f?"var(--amber-glow)":"transparent",color:postFilter===f?"var(--amber)":"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",textTransform:"capitalize"}}>
                    {f==="all"?`All (${posts.length})`:`${f} (${posts.filter(p=>p.status===f).length})`}
                  </button>
                ))}
              </div>
              <div style={{...card,padding:0,overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{borderBottom:"1px solid var(--border)"}}>
                    {["Title","Status","Category","Date","Views"].map(h=>(
                      <th key={h} style={{textAlign:"left",padding:"12px 16px",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {filteredPosts.map(p=>(
                      <tr key={p.id} style={{borderBottom:"1px solid var(--border)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <td style={{padding:"14px 16px",fontWeight:600,fontSize:13}}>{p.title}</td>
                        <td style={{padding:"14px 16px"}}><StatusBadge status={p.status}/></td>
                        <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{p.category}</td>
                        <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{p.date}</td>
                        <td style={{padding:"14px 16px",fontSize:13,fontWeight:600}}>{p.views>0?p.views.toLocaleString():"—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══ ANALYTICS ══ */}
          {activeTab==="analytics"&&(
            <div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:24}}>
                {[
                  {label:"Total Views",   value:DEFAULT_ANALYTICS.totalViews.toLocaleString(), trend:DEFAULT_ANALYTICS.viewsTrend, spark:DEFAULT_ANALYTICS.weeklyViews},
                  {label:"Subscribers",   value:DEFAULT_ANALYTICS.subscribers,                 trend:DEFAULT_ANALYTICS.subsTrend,  spark:[95,105,112,118,128,136,142]},
                  {label:"Avg Read Time", value:DEFAULT_ANALYTICS.avgReadTime},
                  {label:"Bounce Rate",   value:`${DEFAULT_ANALYTICS.bounceRate}%`,            trend:-3.1},
                ].map((s,i)=>(
                  <div key={i} style={card}>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>{s.label}</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:28,fontWeight:700}}>{s.value}</div>
                    {s.trend!=null&&<span style={{fontSize:12,color:s.trend>0?fixedGreen:"var(--red)",fontWeight:600}}>{s.trend>0?"↑":"↓"} {Math.abs(s.trend)}% <span style={{color:"var(--text-secondary)",fontWeight:400}}>vs last week</span></span>}
                    {s.spark&&<div style={{marginTop:12}}><Sparkline data={s.spark} color={dark?"#d4a054":"#b8862e"}/></div>}
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16}}>
                <div style={card}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:16}}>Weekly Traffic</div>
                  <BarChart data={DEFAULT_ANALYTICS.weeklyViews} labels={DEFAULT_ANALYTICS.weekLabels} color={dark?"#d4a054":"#b8862e"}/>
                </div>
                <div style={card}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:16}}>Top Posts</div>
                  {posts.filter(p=>p.views>0).sort((a,b)=>b.views-a.views).slice(0,4).map((p,i)=>(
                    <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:i<3?"1px solid var(--border)":"none"}}>
                      <div style={{fontSize:12,fontWeight:500,maxWidth:"70%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.title}</div>
                      <div style={{fontSize:12,fontWeight:700,color:"var(--amber)"}}>{p.views.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ══ CALENDAR ══ */}
          {activeTab==="calendar"&&(
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
                <h2 style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,margin:0}}>May 2026</h2>
                <div style={{display:"flex",gap:12}}>
                  {[{color:"var(--amber)",l:"Scheduled"},{color:fixedGreen,l:"Newsletter"},{color:"var(--muted)",l:"Draft"},{color:"var(--text-secondary)",l:"Idea"}].map(x=>(
                    <div key={x.l} style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--text-secondary)"}}>
                      <span style={{width:8,height:8,borderRadius:99,background:x.color,display:"inline-block"}}/>{x.l}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,background:"var(--border)",borderRadius:12,overflow:"hidden",border:"1px solid var(--border)"}}>
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>(
                  <div key={d} style={{background:"var(--bg-elevated)",padding:10,textAlign:"center",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{d}</div>
                ))}
                {Array(4).fill(null).map((_,i)=><div key={`e${i}`} style={{background:"var(--bg-surface)",padding:12,minHeight:80}}/>)}
                {Array(31).fill(null).map((_,i)=>{
                  const day=i+1;
                  const evs=CALENDAR_EVENTS.filter(e=>e.day===day);
                  const tc={scheduled:"var(--amber)",newsletter:fixedGreen,draft:"var(--muted)",idea:"var(--text-secondary)"};
                  return (
                    <div key={day} style={{background:"var(--bg-surface)",padding:"8px 10px",minHeight:80,cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="var(--bg-surface)"}>
                      <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:4}}>{day}</div>
                      {evs.map((ev,ei)=>(
                        <div key={ei} style={{fontSize:10,padding:"2px 6px",borderRadius:4,background:(tc[ev.type]||"var(--muted)")+"22",color:tc[ev.type]||"var(--muted)",fontWeight:600,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ev.title}</div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ══ RESEARCH ══ */}
          {activeTab==="research"&&(
            <div>
              <div style={{display:"flex",gap:4,marginBottom:24,background:"var(--bg-surface)",borderRadius:10,padding:4,border:"1px solid var(--border)",width:"fit-content"}}>
                {[{id:"competitors",label:"Competitors",icon:"⊞"},{id:"inspiration",label:"Inspiration",icon:"◐"}].map(t=>(
                  <button key={t.id} onClick={()=>setResearchTab(t.id)} style={{padding:"8px 16px",borderRadius:8,border:"none",background:researchTab===t.id?"var(--amber)":"transparent",color:researchTab===t.id?(dark?"#0e0f11":"#fff"):"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:6}}>
                    <span>{t.icon}</span>{t.label}
                  </button>
                ))}
              </div>
              {researchTab==="competitors"&&(
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                    <div>
                      <h2 style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,margin:0}}>Competitor Landscape</h2>
                      <p style={{color:"var(--text-secondary)",fontSize:12,margin:"4px 0 0"}}>Track content strategy, authority, and gaps</p>
                    </div>
                    <button style={btnP}>+ Add Competitor</button>
                  </div>
                  <div style={{...card,padding:0,overflow:"hidden"}}>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr style={{borderBottom:"1px solid var(--border)"}}>
                        {["Competitor","DA","Frequency","Est. Traffic","Strengths","Threat"].map(h=>(
                          <th key={h} style={{textAlign:"left",padding:"12px 16px",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {COMPETITORS.map(c=>(
                          <tr key={c.name} style={{borderBottom:"1px solid var(--border)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <td style={{padding:"14px 16px"}}><div style={{fontWeight:600,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:"var(--text-secondary)"}}>{c.url}</div></td>
                            <td style={{padding:"14px 16px",fontWeight:700,fontSize:14,color:"var(--amber)"}}>{c.da}</td>
                            <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.posts}</td>
                            <td style={{padding:"14px 16px",fontSize:12,fontWeight:600}}>{c.traffic}</td>
                            <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.strengths}</td>
                            <td style={{padding:"14px 16px"}}><ThreatBadge level={c.threat}/></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginTop:16}}>
                    {[
                      {title:"Content Gap",             value:"Whiskey + Fishing",    detail:"Zero competitors own this intersection — you do",                color:fixedGreen},
                      {title:"Avg Competitor Frequency", value:"3.0/wk",              detail:"You're at 2/wk — room to increase without diluting quality",    color:"var(--amber)"},
                      {title:"Untapped Format",          value:"Video Pairing Guides", detail:"No competitor is doing video whiskey × fishing content",        color:"var(--amber)"},
                    ].map((ins,i)=>(
                      <div key={i} style={card}>
                        <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>{ins.title}</div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,color:ins.color,marginBottom:4}}>{ins.value}</div>
                        <div style={{fontSize:12,color:"var(--text-secondary)"}}>{ins.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {researchTab==="inspiration"&&(
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                    <h2 style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,margin:0}}>Inspiration Board</h2>
                    <button style={btnP}>+ Save New</button>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    {INSPIRATION.map(item=>{
                      const tc={article:{icon:"📄",color:"var(--amber)"},thread:{icon:"💬",color:fixedGreen},visual:{icon:"📸",color:"#7c8abf"}};
                      const t=tc[item.type]||tc.article;
                      return (
                        <div key={item.id} style={{...card,padding:18,display:"flex",gap:16,alignItems:"flex-start"}}>
                          <div style={{width:40,height:40,borderRadius:10,background:t.color+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{t.icon}</div>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                              <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",color:t.color}}>{item.type}</span>
                              <span style={{fontSize:11,color:"var(--text-secondary)"}}>from {item.source}</span>
                            </div>
                            <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>{item.title}</div>
                            {item.notes&&<div style={{fontSize:12,color:"var(--text-secondary)",fontStyle:"italic"}}>💡 {item.notes}</div>}
                          </div>
                          <button style={{...btnS,fontSize:11,padding:"5px 10px",flexShrink:0}}>→ Draft</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ AI TOOLS ══ */}
          {activeTab==="ai"&&(
            <div>
              <ProviderPicker
                activeProvider={activeProvider}
                activeModel={activeModel}
                onProviderChange={handleProviderChange}
                onModelChange={handleModelChange}
                keys={apiKeys}
              />
              <div style={{display:"flex",gap:4,marginBottom:24,background:"var(--bg-surface)",borderRadius:10,padding:4,border:"1px solid var(--border)",width:"fit-content"}}>
                {[{id:"writer",label:"Blog Writer",icon:"✍"},{id:"headline",label:"Headlines",icon:"✦"},{id:"seo",label:"SEO Optimizer",icon:"◉"}].map(t=>(
                  <button key={t.id} onClick={()=>setAiTool(t.id)} style={{padding:"8px 16px",borderRadius:8,border:"none",background:aiTool===t.id?"var(--amber)":"transparent",color:aiTool===t.id?(dark?"#0e0f11":"#fff"):"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:6}}>
                    <span>{t.icon}</span>{t.label}
                  </button>
                ))}
              </div>
              {aiTool==="writer"  &&<AIWriter   wsName={wsName} activeProvider={activeProvider} activeModel={activeModel} apiKeys={apiKeys}/>}
              {aiTool==="headline"&&<HeadlineGenerator          activeProvider={activeProvider} activeModel={activeModel} apiKeys={apiKeys}/>}
              {aiTool==="seo"     &&<SEOOptimizer               activeProvider={activeProvider} activeModel={activeModel} apiKeys={apiKeys}/>}
            </div>
          )}

          {/* ══ SETTINGS ══ */}
          {activeTab==="settings"&&(
            <div style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:24}}>
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                {SETTINGS_SECTIONS.map(s=>(
                  <button key={s.id} onClick={()=>{setSettingsSection(s.id);setShowUpgrade(false);}}
                    style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:8,border:"none",background:settingsSection===s.id?"var(--bg-elevated)":"transparent",color:settingsSection===s.id?"var(--amber)":"var(--text-secondary)",fontSize:13,fontWeight:settingsSection===s.id?600:400,cursor:"pointer",fontFamily:"var(--font-body)",textAlign:"left"}}>
                    {s.label}
                    {s.id==="apikeys"&&(
                      <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:99,background:"var(--amber)22",color:"var(--amber)"}}>
                        {connectedProviders}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div style={card}>
                {settingsSection==="general"&&(
                  <div style={{display:"flex",flexDirection:"column",gap:20}}>
                    <h3 style={{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,margin:0}}>Workspace Settings</h3>
                    {[{label:"Blog Name",val:wsName},{label:"Blog URL",val:wsUrl||"caskandstream.com"},{label:"Tagline",val:"Cast at Dawn. Sip at Dusk."}].map(f=>(
                      <div key={f.label}>
                        <label style={{display:"block",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>{f.label}</label>
                        <input style={inputSt} defaultValue={f.val}/>
                      </div>
                    ))}
                    <button style={{...btnP,alignSelf:"flex-start"}}>Save Changes</button>
                  </div>
                )}

                {settingsSection==="apikeys"&&(
                  <APIKeysSettings apiKeys={apiKeys} onSave={setApiKeys}/>
                )}

                {settingsSection==="wix"&&(
                  <div>
                    <h3 style={{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,margin:"0 0 8px"}}>Wix Blog Integration</h3>
                    <p style={{fontSize:13,color:"var(--text-secondary)",margin:"0 0 20px"}}>Connect Wix Blog to sync posts, manage drafts, and publish directly.</p>
                    <div style={{padding:20,borderRadius:10,border:`1px solid ${connected?fixedGreen+"44":"var(--red)44"}`,background:connected?fixedGreen+"0a":"var(--red)0a",display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
                      <div style={{display:"flex",alignItems:"center",gap:12}}>
                        <span style={{width:10,height:10,borderRadius:99,background:connected?fixedGreen:"var(--red)",display:"inline-block"}}/>
                        <span style={{fontWeight:600,fontSize:14}}>{connected?"Connected":"Not Connected"}</span>
                      </div>
                      <button style={btnP}>{connected?"Disconnect":"Connect Wix"}</button>
                    </div>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>API Key</div>
                    <input type="password" style={{...inputSt,fontFamily:"monospace"}} placeholder="Paste your Wix API key…"/>
                    <p style={{fontSize:12,color:"var(--text-secondary)",marginTop:10,lineHeight:1.6}}>Wix Dashboard → Settings → Advanced → API Keys → grant <strong style={{color:"var(--amber)"}}>Wix Blog</strong> permissions.</p>
                  </div>
                )}

                {settingsSection==="billing"&&(
                  <div>
                    <h3 style={{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,margin:"0 0 8px"}}>Billing & Plan</h3>
                    <p style={{fontSize:13,color:"var(--text-secondary)",margin:"0 0 20px"}}>Current plan: <span style={{color:"var(--amber)",fontWeight:700}}>Operative</span></p>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                      {PLANS.map(p=>(
                        <div key={p.name} style={{padding:20,borderRadius:10,border:planLabel===p.name?"2px solid var(--amber)":"1px solid var(--border)",background:planLabel===p.name?"var(--amber-glow)":"var(--bg-elevated)",textAlign:"center"}}>
                          <div style={{fontFamily:"var(--font-display)",fontSize:16,fontWeight:700,marginBottom:4}}>{p.name}</div>
                          <div style={{fontSize:22,fontWeight:700,color:"var(--amber)",fontFamily:"var(--font-display)",marginBottom:12}}>{p.price}</div>
                          {p.features.map((f,i)=><div key={i} style={{fontSize:12,color:"var(--text-secondary)",padding:"3px 0"}}>{f}</div>)}
                          <button style={{...(planLabel===p.name?btnP:btnS),marginTop:14,width:"100%"}}>{planLabel===p.name?"Current Plan":"Upgrade"}</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {settingsSection==="account"&&(
                  <div style={{display:"flex",flexDirection:"column",gap:20}}>
                    <h3 style={{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,margin:0}}>Account</h3>
                    <div>
                      <label style={{display:"block",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Email</label>
                      <input style={inputSt} defaultValue={user?.email} disabled/>
                    </div>
                    <div style={{paddingTop:20,borderTop:"1px solid var(--border)"}}>
                      <button onClick={onLogout} style={{padding:"10px 20px",borderRadius:8,border:"1px solid var(--red)44",background:"var(--red)0a",color:"var(--red)",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)"}}>Sign Out</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
