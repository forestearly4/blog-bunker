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
    models: ["gemini-2.5-flash-preview-05-20", "gemini-2.5-pro-preview-06-05", "gemini-1.5-pro", "gemini-1.5-flash"],
    defaultModel: "gemini-2.5-flash-preview-05-20",
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
    throw new Error("Stability AI is used for image generation only — use the Image panel in the Social tab.");
  }

  throw new Error("Unknown provider");
}

// ─── SOCIAL PLATFORMS CONFIG ─────────────────────────────────────────────────

const SOCIAL_PLATFORMS = [
  {
    id: "instagram",
    name: "Instagram",
    icon: "📸",
    color: "#e1306c",
    charLimit: 2200,
    hashtagLimit: 30,
    tone: "visual, aspirational, lifestyle-focused",
    format: "Hook line, 3-4 short paragraphs, line breaks between each, 10-15 relevant hashtags at end",
    placeholder: "Share to Instagram feed",
    urlNote: "Links don't work in captions — mention 'link in bio'",
  },
  {
    id: "facebook",
    name: "Facebook",
    icon: "📘",
    color: "#1877f2",
    charLimit: 63206,
    hashtagLimit: 5,
    tone: "conversational, community-friendly, story-driven",
    format: "Engaging opening question or statement, 2-3 paragraphs, call to action, 2-3 hashtags optional",
    placeholder: "Share to Facebook page",
    urlNote: "Include full URL — Facebook shows link preview automatically",
  },
  {
    id: "tiktok",
    name: "TikTok",
    icon: "🎵",
    color: "#fe2c55",
    charLimit: 2200,
    hashtagLimit: 10,
    tone: "punchy, energetic, trend-aware, Gen Z/Millennial",
    format: "Hook in first line (no more than 8 words), ultra-short sentences, 3-5 trending hashtags",
    placeholder: "Write TikTok caption",
    urlNote: "No clickable links in captions — direct to bio link",
  },
  {
    id: "reddit",
    name: "Reddit",
    icon: "🔴",
    color: "#ff4500",
    charLimit: 40000,
    hashtagLimit: 0,
    tone: "authentic, community-first, no marketing speak, conversational",
    format: "Title line, then body as genuine post. No hashtags. No salesy language. Share value first, mention the blog naturally if relevant.",
    placeholder: "Write Reddit post",
    urlNote: "Choose the right subreddit — r/flyfishing, r/whiskey, r/bourbon, r/scotch",
  },
  {
    id: "twitter",
    name: "X (Twitter)",
    icon: "𝕏",
    color: "#000000",
    charLimit: 280,
    hashtagLimit: 2,
    tone: "sharp, witty, opinionated, punchy",
    format: "Single punchy statement or question. Max 280 chars. 1-2 hashtags max. No filler.",
    placeholder: "Write a tweet",
    urlNote: "URLs count as ~23 chars — account for that in length",
  },
];

const SOCIAL_KEYS_STORAGE = "bb_social_connections";

function loadSocialConnections() {
  try { return JSON.parse(localStorage.getItem(SOCIAL_KEYS_STORAGE) || "{}"); } catch { return {}; }
}
function saveSocialConnections(data) {
  try { localStorage.setItem(SOCIAL_KEYS_STORAGE, JSON.stringify(data)); } catch {}
}

// ─── STABILITY AI IMAGE GENERATOR ────────────────────────────────────────────

// Platform image specs for Stability AI
const PLATFORM_IMAGE_SPECS = {
  instagram: { w:1024, h:1024,  ratio:"1:1",   label:"Square (1:1)",        style:"cinematic lifestyle photography" },
  facebook:  { w:1216, h:832,   ratio:"3:2",   label:"Landscape (3:2)",     style:"editorial photography"           },
  tiktok:    { w:832,  h:1216,  ratio:"2:3",   label:"Portrait (2:3)",      style:"vibrant lifestyle photography"   },
  reddit:    { w:1024, h:1024,  ratio:"1:1",   label:"Square (1:1)",        style:"documentary photography"         },
  twitter:   { w:1216, h:832,   ratio:"16:9",  label:"Widescreen (16:9)",   style:"editorial photography"           },
};

async function generateStabilityImage(prompt, platId, apiKey) {
  if (!apiKey) throw new Error("Stability AI API key required. Add it in Settings → API Keys.");
  const spec = PLATFORM_IMAGE_SPECS[platId] || PLATFORM_IMAGE_SPECS.instagram;

  // Use Stability AI's stable-image-core endpoint
  const formData = new FormData();
  formData.append("prompt", prompt);
  formData.append("output_format", "webp");
  formData.append("aspect_ratio", spec.ratio);

  const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "image/*",
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message || `Stability AI error: ${res.status}`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Generate an image prompt from the topic using the text AI
async function generateImagePrompt(topic, platId, activeProvider, activeModel, apiKey) {
  const spec = PLATFORM_IMAGE_SPECS[platId] || PLATFORM_IMAGE_SPECS.instagram;
  const text = await callAI(
    activeProvider, activeModel,
    `You generate Stable Diffusion image prompts for Cask & Stream — a fly fishing and whiskey lifestyle brand. Style: ${spec.style}, golden hour lighting, moody and cinematic, Pacific Northwest or Appalachian wilderness, amber tones. Format: a single prompt string, no explanation, no quotes, no labels. Make it photorealistic and evocative.`,
    `Write an image prompt for a ${platId} post (${spec.label}) about: ${topic}`,
    apiKey
  );
  return text.trim();
}

// ─── IMAGE PANEL (per platform) ───────────────────────────────────────────────

function ImagePanel({ platId, topic, activeProvider, activeModel, apiKeys, platColor }) {
  const [imgPrompt,   setImgPrompt]   = useState("");
  const [imageUrl,    setImageUrl]    = useState(null);
  const [genLoading,  setGenLoading]  = useState(false);
  const [promptLoad,  setPromptLoad]  = useState(false);
  const [error,       setError]       = useState("");
  const [showPrompt,  setShowPrompt]  = useState(false);

  const hasStabilityKey = !!apiKeys["stability"];
  const spec = PLATFORM_IMAGE_SPECS[platId] || PLATFORM_IMAGE_SPECS.instagram;

  const generatePrompt = async () => {
    if (!topic.trim()) return;
    setPromptLoad(true); setError("");
    try {
      const p = await generateImagePrompt(topic, platId, activeProvider, activeModel, apiKeys[activeProvider]);
      setImgPrompt(p);
      setShowPrompt(true);
    } catch(e) { setError(e.message); }
    setPromptLoad(false);
  };

  const generateImage = async () => {
    if (!imgPrompt.trim()) return;
    setGenLoading(true); setError(""); setImageUrl(null);
    try {
      const url = await generateStabilityImage(imgPrompt, platId, apiKeys["stability"]);
      setImageUrl(url);
    } catch(e) { setError(e.message); }
    setGenLoading(false);
  };

  const handleGenerate = async () => {
    if (!imgPrompt) {
      // auto-generate prompt then image
      setPromptLoad(true); setError("");
      try {
        const p = await generateImagePrompt(topic, platId, activeProvider, activeModel, apiKeys[activeProvider]);
        setImgPrompt(p);
        setPromptLoad(false);
        setGenLoading(true);
        const url = await generateStabilityImage(p, platId, apiKeys["stability"]);
        setImageUrl(url);
      } catch(e) { setError(e.message); }
      setPromptLoad(false); setGenLoading(false);
    } else {
      await generateImage();
    }
  };

  const handleDownload = () => {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `cask-stream-${platId}-${Date.now()}.webp`;
    a.click();
  };

  const isLoading = genLoading || promptLoad;

  return (
    <div style={{ marginTop:20, paddingTop:20, borderTop:"1px solid var(--border)" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:13, fontWeight:700 }}>▣ Image</span>
          <span style={{ fontSize:10, color:"var(--muted)", padding:"1px 7px", borderRadius:99, border:"1px solid var(--border)" }}>{spec.label}</span>
          {!hasStabilityKey && (
            <span style={{ fontSize:10, color:"var(--amber)", padding:"1px 7px", borderRadius:99, background:"var(--amber-glow)", border:"1px solid var(--amber)44" }}>
              Add Stability AI key in Settings
            </span>
          )}
        </div>
        <div style={{ display:"flex", gap:6 }}>
          {imgPrompt && !imageUrl && (
            <button onClick={()=>setShowPrompt(s=>!s)}
              style={{ padding:"4px 10px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {showPrompt ? "Hide" : "Edit"} Prompt
            </button>
          )}
          <button onClick={handleGenerate} disabled={isLoading || !topic.trim()}
            style={{ padding:"5px 14px", borderRadius:6, border:"none", background:isLoading||!topic.trim()?"var(--bg-elevated)":"#7c3aed", color:isLoading||!topic.trim()?"var(--muted)":"#fff", fontSize:11, fontWeight:700, cursor:isLoading||!topic.trim()?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
            {isLoading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{promptLoad?"Writing prompt…":"Generating…"}</> : imageUrl ? "Regenerate" : "▣ Generate Image"}
          </button>
        </div>
      </div>

      {/* Editable prompt */}
      {showPrompt && imgPrompt && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:4 }}>Image Prompt (editable)</div>
          <div style={{ display:"flex", gap:8 }}>
            <textarea
              value={imgPrompt}
              onChange={e=>setImgPrompt(e.target.value)}
              rows={2}
              style={{ flex:1, padding:"8px 12px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", outline:"none", resize:"vertical", lineHeight:1.5 }}
            />
            <button onClick={generateImage} disabled={genLoading}
              style={{ padding:"8px 14px", borderRadius:8, border:"none", background:"#7c3aed", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", alignSelf:"flex-start", whiteSpace:"nowrap" }}>
              {genLoading ? "…" : "Run →"}
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize:12, color:"var(--red)", marginBottom:10, padding:"6px 10px", borderRadius:6, background:"var(--red)11", border:"1px solid var(--red)33" }}>{error}</div>}

      {/* Image output */}
      {imageUrl ? (
        <div style={{ position:"relative", borderRadius:10, overflow:"hidden", border:`1px solid ${platColor}33` }}>
          <img src={imageUrl} alt="Generated" style={{ width:"100%", display:"block", borderRadius:10 }} />
          <div style={{ position:"absolute", bottom:10, right:10, display:"flex", gap:6 }}>
            <button onClick={handleDownload}
              style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.7)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
              ↓ Download
            </button>
            <button onClick={handleGenerate}
              style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.7)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
              ↻ New
            </button>
          </div>
        </div>
      ) : (
        !isLoading && (
          <div style={{ height:120, borderRadius:10, border:"1px dashed var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8 }}>
            <span style={{ fontSize:28, opacity:0.3 }}>▣</span>
            <span style={{ fontSize:11, color:"var(--muted)" }}>Click Generate Image to create a {spec.label} image</span>
          </div>
        )
      )}

      {isLoading && !imageUrl && (
        <div style={{ height:120, borderRadius:10, border:"1px solid var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
          <span style={{ animation:"spin 1s linear infinite", display:"inline-block", fontSize:20, opacity:0.5 }}>◌</span>
          <span style={{ fontSize:12, color:"var(--muted)" }}>{promptLoad ? "Writing image prompt…" : "Generating image with Stability AI…"}</span>
        </div>
      )}
    </div>
  );
}

// ─── SOCIAL POST GENERATOR ────────────────────────────────────────────────────

function SocialPostTab({ activeProvider, activeModel, apiKeys, dark }) {
  const [input,       setInput]       = useState("");
  const [inputMode,   setInputMode]   = useState("topic");
  const [loading,     setLoading]     = useState(false);
  const [posts,       setPosts]       = useState({});
  const [error,       setError]       = useState("");
  const [selected,    setSelected]    = useState({ instagram:true, facebook:true, tiktok:true, reddit:true, twitter:true });
  const [copied,      setCopied]      = useState({});
  const [activePlat,  setActivePlat]  = useState("instagram");

  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const hasStability = !!apiKeys["stability"];

  const generate = async () => {
    if (!input.trim()) return;
    const targets = SOCIAL_PLATFORMS.filter(p => selected[p.id]);
    if (!targets.length) { setError("Select at least one platform."); return; }
    setLoading(true); setPosts({}); setError("");
    try {
      const results = {};
      for (const plat of targets) {
        const system = `You are a social media manager for Cask & Stream — a fly fishing and whiskey lifestyle blog. Tagline: "Cast at Dawn. Sip at Dusk." Voice: ${plat.tone}. Write ONLY the post content — no labels, no explanations, no "Here is your post:". Format: ${plat.format}. ${plat.urlNote}.`;
        const userMsg = inputMode === "topic"
          ? `Write a ${plat.name} post for Cask & Stream about: ${input}`
          : `Adapt this blog post content into a ${plat.name} post for Cask & Stream:\n\n${input.slice(0, 1500)}`;
        results[plat.id] = await callAI(activeProvider, activeModel, system, userMsg, apiKeys[activeProvider]);
      }
      setPosts(results);
      setActivePlat(targets[0].id);
    } catch(e) { setError(e.message || "Generation failed."); }
    setLoading(false);
  };

  const handleCopy = (platId, text) => {
    navigator.clipboard.writeText(text);
    setCopied(c => ({ ...c, [platId]: true }));
    setTimeout(() => setCopied(c => ({ ...c, [platId]: false })), 2000);
  };

  const charCount = (platId) => (posts[platId] || "").length;
  const charLimit = (platId) => SOCIAL_PLATFORMS.find(p => p.id === platId)?.charLimit || 9999;
  const isOver    = (platId) => charCount(platId) > charLimit(platId);

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };
  const hasPosts = Object.keys(posts).length > 0;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {/* Input panel */}
      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:10 }}>
          <div style={{ display:"flex", gap:4, background:"var(--bg-elevated)", borderRadius:8, padding:3 }}>
            {[{id:"topic",label:"From Topic"},{id:"blogpost",label:"From Blog Post"}].map(m=>(
              <button key={m.id} onClick={()=>setInputMode(m.id)}
                style={{ padding:"6px 14px", borderRadius:6, border:"none", background:inputMode===m.id?"var(--amber)":"transparent", color:inputMode===m.id?(dark?"#0e0f11":"#fff"):"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                {m.label}
              </button>
            ))}
          </div>
          {/* Stability AI status badge */}
          <div style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 12px", borderRadius:99, border:`1px solid ${hasStability?"#7c3aed44":"var(--border)"}`, background:hasStability?"#7c3aed0a":"transparent", fontSize:11, color:hasStability?"#a78bfa":"var(--muted)" }}>
            <span>▣</span>
            {hasStability ? "Stability AI connected — images ready" : "Add Stability AI key for images"}
          </div>
        </div>

        {inputMode === "topic"
          ? <input style={iS} placeholder="e.g. pairing Islay scotch with a day of dry fly fishing…" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&generate()} />
          : <textarea rows={4} style={{...iS, resize:"vertical"}} placeholder="Paste your blog post text here to adapt it for social…" value={input} onChange={e=>setInput(e.target.value)} />
        }

        {/* Platform selector */}
        <div style={{ marginTop:16 }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Generate for</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {SOCIAL_PLATFORMS.map(plat => (
              <button key={plat.id} onClick={()=>setSelected(s=>({...s,[plat.id]:!s[plat.id]}))}
                style={{ padding:"6px 14px", borderRadius:99, border:`1px solid ${selected[plat.id]?plat.color:"var(--border)"}`, background:selected[plat.id]?plat.color+"18":"transparent", color:selected[plat.id]?plat.color:"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
                <span>{plat.icon}</span>{plat.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:12, marginTop:16 }}>
          <button onClick={generate} disabled={!input.trim()||loading}
            style={{ padding:"10px 24px", borderRadius:8, border:"none", background:input.trim()&&!loading?provider.color:"var(--bg-elevated)", color:input.trim()&&!loading?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:input.trim()&&!loading?"pointer":"not-allowed", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8, transition:"background 0.2s" }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Generating…</> : <>{provider.logo} Generate Captions</>}
          </button>
          {loading && <span style={{fontSize:12,color:"var(--muted)"}}>Writing for {SOCIAL_PLATFORMS.filter(p=>selected[p.id]).length} platform{SOCIAL_PLATFORMS.filter(p=>selected[p.id]).length!==1?"s":""}…</span>}
          {error && <span style={{fontSize:12,color:"var(--red)"}}>{error}</span>}
        </div>
      </div>

      {/* Results */}
      {hasPosts && (
        <div style={{ display:"grid", gridTemplateColumns:"160px 1fr", gap:16 }}>
          {/* Platform tabs */}
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {SOCIAL_PLATFORMS.filter(p => posts[p.id]).map(plat => (
              <button key={plat.id} onClick={()=>setActivePlat(plat.id)}
                style={{ padding:"10px 12px", borderRadius:8, border:activePlat===plat.id?`1px solid ${plat.color}`:"1px solid var(--border)", background:activePlat===plat.id?plat.color+"12":"var(--bg-elevated)", color:activePlat===plat.id?plat.color:"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", textAlign:"left", display:"flex", alignItems:"center", gap:8, transition:"all 0.15s" }}>
                <span style={{fontSize:16}}>{plat.icon}</span>
                <div>
                  <div>{plat.name}</div>
                  <div style={{fontSize:10,fontWeight:400,color:isOver(plat.id)?"var(--red)":activePlat===plat.id?plat.color+"bb":"var(--muted)"}}>
                    {charCount(plat.id)}/{plat.charLimit === 40000 ? "∞" : plat.charLimit}
                    {isOver(plat.id) ? " ⚠" : ""}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Active post editor */}
          {SOCIAL_PLATFORMS.filter(p => posts[p.id]).map(plat => activePlat === plat.id && (
            <div key={plat.id} style={{ background:"var(--bg-surface)", border:`1px solid ${plat.color}44`, borderRadius:12, padding:24 }}>
              {/* Caption header */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:20 }}>{plat.icon}</span>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14, color:plat.color }}>{plat.name}</div>
                    <div style={{ fontSize:11, color:"var(--text-secondary)" }}>{plat.urlNote}</div>
                  </div>
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <span style={{ fontSize:11, color:isOver(plat.id)?"var(--red)":"var(--muted)" }}>
                    {charCount(plat.id)}{plat.charLimit < 40000 ? ` / ${plat.charLimit}` : ""} chars
                  </span>
                  <button onClick={generate}
                    style={{ padding:"4px 12px", borderRadius:6, border:`1px solid ${plat.color}44`, background:"transparent", color:plat.color, fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    Regenerate
                  </button>
                  <button onClick={()=>handleCopy(plat.id, posts[plat.id])}
                    style={{ padding:"4px 12px", borderRadius:6, border:"none", background:copied[plat.id]?"var(--green)":plat.color, color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", transition:"background 0.2s" }}>
                    {copied[plat.id] ? "✓ Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Caption textarea */}
              <textarea
                value={posts[plat.id] || ""}
                onChange={e => setPosts(p => ({...p, [plat.id]: e.target.value}))}
                rows={plat.id === "twitter" ? 4 : 9}
                style={{ width:"100%", padding:"14px", borderRadius:8, border:`1px solid ${isOver(plat.id)?"var(--red)":"var(--border)"}`, background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box", resize:"vertical", lineHeight:1.7 }}
              />

              {/* Image panel — shown for visual platforms */}
              {plat.id !== "reddit" && (
                <ImagePanel
                  platId={plat.id}
                  topic={input}
                  activeProvider={activeProvider}
                  activeModel={activeModel}
                  apiKeys={apiKeys}
                  platColor={plat.color}
                />
              )}

              {/* Action buttons */}
              <div style={{ display:"flex", gap:8, marginTop:16 }}>
                <button style={{ padding:"7px 16px", borderRadius:7, border:"none", background:plat.color, color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  Schedule Post
                </button>
                <button style={{ padding:"7px 16px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  Save as Draft
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS: SOCIAL CONNECTIONS ─────────────────────────────────────────────

function SocialSettings() {
  const [connections, setConnections] = useState(loadSocialConnections);
  const [saved, setSaved] = useState(false);

  const handleToggle = (platId) => {
    const updated = { ...connections, [platId]: { ...connections[platId], enabled: !connections[platId]?.enabled } };
    setConnections(updated);
    saveSocialConnections(updated);
  };

  const handleNote = (platId, note) => {
    setConnections(c => ({ ...c, [platId]: { ...c[platId], note } }));
  };

  const handleSave = () => {
    saveSocialConnections(connections);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      <div>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Social Media</h3>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
          Mark which platforms you're active on. Direct API publishing is on the roadmap — for now, use the Social tab to generate and copy posts.
        </p>
      </div>

      {SOCIAL_PLATFORMS.map(plat => {
        const conn = connections[plat.id] || {};
        return (
          <div key={plat.id} style={{ padding:20, borderRadius:12, border:`1px solid ${conn.enabled?plat.color+"44":"var(--border)"}`, background:conn.enabled?plat.color+"06":"var(--bg-elevated)", transition:"all 0.2s" }}>
            <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom: conn.enabled ? 16 : 0 }}>
              <div style={{ width:40, height:40, borderRadius:10, background:plat.color+"22", border:`1px solid ${plat.color}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{plat.icon}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, fontSize:14 }}>{plat.name}</div>
                <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:2 }}>{plat.urlNote}</div>
              </div>
              {/* Toggle */}
              <div onClick={()=>handleToggle(plat.id)} style={{ width:44, height:24, borderRadius:99, background:conn.enabled?plat.color:"var(--border)", cursor:"pointer", position:"relative", transition:"background 0.3s", flexShrink:0 }}>
                <div style={{ width:18, height:18, borderRadius:99, background:"#fff", position:"absolute", top:3, left:conn.enabled?23:3, transition:"left 0.3s", boxShadow:"0 1px 4px rgba(0,0,0,0.3)" }} />
              </div>
            </div>

            {conn.enabled && (
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
                  Your {plat.name} handle / page (optional)
                </label>
                <input
                  placeholder={`@caskandstream`}
                  value={conn.note || ""}
                  onChange={e=>handleNote(plat.id, e.target.value)}
                  style={{ width:"100%", padding:"8px 12px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" }}
                  onFocus={e=>e.target.style.borderColor=plat.color}
                  onBlur={e=>e.target.style.borderColor="var(--border)"}
                />
                <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:8, padding:"8px 12px", borderRadius:6, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                  ✦ Direct publishing via {plat.name} API coming soon. For now, generate posts in the Social tab and copy them across.
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={handleSave} style={{ padding:"10px 28px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
          Save
        </button>
        {saved && <span style={{ fontSize:12, color:"var(--green)" }}>✓ Saved</span>}
      </div>
    </div>
  );
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

// ─── WIX BLOG SYNC ───────────────────────────────────────────────────────────

const WIX_STORAGE = "bb_wix_config";

function loadWixConfig() {
  try { return JSON.parse(localStorage.getItem(WIX_STORAGE) || "{}"); } catch { return {}; }
}
function saveWixConfig(cfg) {
  try { localStorage.setItem(WIX_STORAGE, JSON.stringify(cfg)); } catch {}
}

// Map Wix post → Blog Bunker post format
function mapWixPost(wp) {
  return {
    id:         wp.id || wp._id || String(Date.now() + Math.random()),
    wixId:      wp.id || wp._id,
    title:      wp.title || "Untitled",
    body:       wp.richContent?.nodes?.map(n => n.textData?.text || "").join("\n") || wp.excerpt || "",
    excerpt:    wp.excerpt || "",
    status:     wp.status === "PUBLISHED" ? "published" : wp.status === "SCHEDULED" ? "scheduled" : "draft",
    date:       wp.firstPublishedDate
                  ? new Date(wp.firstPublishedDate).toISOString().split("T")[0]
                  : wp.lastPublishedDate
                  ? new Date(wp.lastPublishedDate).toISOString().split("T")[0]
                  : new Date().toISOString().split("T")[0],
    views:      wp.stats?.views || 0,
    category:   wp.tagIds?.length ? "Wix" : "Culture",
    slug:       wp.slug || "",
    coverImage: wp.media?.wixMedia?.image?.imageInfo?.url || wp.coverMedia?.wixMedia?.image?.imageInfo?.url || "",
    url:        wp.url || "",
    fromWix:    true,
  };
}

async function wixFetch(endpoint, method = "GET", data = null) {
  const res = await fetch("/api/wix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, method, data }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error + (json.detail ? `: ${json.detail}` : "") + (json.setup ? `\n\n${json.setup}` : ""));
  return json;
}

function WixSyncPanel({ onSync, onDisconnect, currentPostCount }) {
  const [cfg,        setCfg]        = useState(loadWixConfig);
  const [siteId,     setSiteId]     = useState(cfg.siteId || "");
  const [status,     setStatus]     = useState(cfg.connected ? "connected" : "idle");
  const [syncing,    setSyncing]    = useState(false);
  const [testing,    setTesting]    = useState(false);
  const [log,        setLog]        = useState([]);
  const [lastSync,   setLastSync]   = useState(cfg.lastSync || null);
  const [pullCount,  setPullCount]  = useState(0);

  const addLog = (msg, type="info") => setLog(l => [...l, { msg, type, ts: new Date().toLocaleTimeString() }]);

  const testConnection = async () => {
    if (!siteId.trim()) { addLog("Enter your Wix Site ID first", "error"); return; }
    setTesting(true);
    addLog("Testing Wix connection…");
    try {
      const data = await wixFetch(`/v3/blog/posts?fieldsets=CONTENT_TEXT&limit=1`, "GET");
      if (data.posts !== undefined || data.blogPosts !== undefined) {
        const newCfg = { siteId, connected: true, lastSync: null };
        saveWixConfig(newCfg);
        setCfg(newCfg);
        setStatus("connected");
        addLog("✓ Connected to Wix Blog successfully!", "success");
      } else {
        addLog("Unexpected response from Wix. Check your Site ID and API key.", "error");
      }
    } catch(e) {
      addLog(`Connection failed: ${e.message}`, "error");
      setStatus("error");
    }
    setTesting(false);
  };

  const pullPosts = async () => {
    setSyncing(true);
    addLog("Pulling posts from Wix Blog…");
    try {
      let allPosts = [];
      let cursor = null;
      let page = 1;

      do {
        addLog(`Fetching page ${page}…`);
        const endpoint = `/v3/blog/posts?fieldsets=CONTENT_TEXT,URL,TAGS&limit=50${cursor ? `&pagingCursor.cursor=${cursor}` : ""}`;
        const data = await wixFetch(endpoint);
        const posts = data.posts || data.blogPosts || [];
        allPosts = [...allPosts, ...posts];
        cursor = data.pagingMetadata?.cursors?.next || null;
        page++;
        if (posts.length < 50) break;
      } while (cursor && page < 10);

      addLog(`Found ${allPosts.length} posts on Wix`);

      const mapped = allPosts.map(mapWixPost);
      const now = new Date().toISOString();
      const newCfg = { ...cfg, siteId, connected: true, lastSync: now };
      saveWixConfig(newCfg);
      setCfg(newCfg);
      setLastSync(now);
      setPullCount(mapped.length);
      onSync(mapped);
      addLog(`✓ Synced ${mapped.length} posts into Blog Bunker`, "success");
    } catch(e) {
      addLog(`Sync failed: ${e.message}`, "error");
    }
    setSyncing(false);
  };

  const disconnect = () => {
    saveWixConfig({});
    setCfg({});
    setStatus("idle");
    setSiteId("");
    setLog([]);
    setLastSync(null);
    onDisconnect();
    addLog("Disconnected from Wix", "info");
  };

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const isConnected = status === "connected" || cfg.connected;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Wix Blog Integration</h3>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
          Pull your Cask & Stream posts from Wix into Blog Bunker. Two-way sync (push) coming in the next update.
        </p>
      </div>

      {/* Connection status banner */}
      <div style={{ padding:16, borderRadius:10, border:`1px solid ${isConnected?"#5cba6c44":"var(--border)"}`, background:isConnected?"#5cba6c0a":"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ width:10, height:10, borderRadius:99, background:isConnected?"#5cba6c":"var(--muted)", display:"inline-block", boxShadow:isConnected?"0 0 8px #5cba6c66":"none" }}/>
          <div>
            <div style={{ fontWeight:600, fontSize:14 }}>{isConnected ? "Wix Blog Connected" : "Not Connected"}</div>
            {lastSync && <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:2 }}>Last sync: {new Date(lastSync).toLocaleString()}</div>}
            {isConnected && pullCount > 0 && <div style={{ fontSize:11, color:"#5cba6c", marginTop:2 }}>{pullCount} posts pulled</div>}
          </div>
        </div>
        {isConnected && (
          <button onClick={disconnect} style={{ padding:"6px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
            Disconnect
          </button>
        )}
      </div>

      {/* Setup fields */}
      {!isConnected && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
              Wix Site ID
            </label>
            <input style={iS} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={siteId} onChange={e=>setSiteId(e.target.value)}
              onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            <p style={{ fontSize:11, color:"var(--text-secondary)", marginTop:6, lineHeight:1.5 }}>
              Wix Dashboard → Settings → General → Site ID (copy the UUID)
            </p>
          </div>
          <div style={{ padding:"12px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:12, color:"var(--text-secondary)", lineHeight:1.7 }}>
            <strong style={{ color:"var(--text)" }}>API Key</strong> is set as a Netlify environment variable (<code style={{ color:"var(--amber)", background:"var(--bg)", padding:"1px 5px", borderRadius:4 }}>WIX_API_KEY</code>).
            Add it in Netlify → Site configuration → Environment variables if you haven't already.
            Your key needs <strong style={{ color:"var(--text)" }}>Wix Blog</strong> read permissions.
          </div>
          <button onClick={testConnection} disabled={!siteId.trim() || testing}
            style={{ padding:"10px 24px", borderRadius:8, border:"none", background:siteId.trim()&&!testing?"var(--amber)":"var(--bg-elevated)", color:siteId.trim()&&!testing?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:siteId.trim()&&!testing?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8, alignSelf:"flex-start" }}>
            {testing ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Testing…</> : "Test Connection"}
          </button>
        </div>
      )}

      {/* Sync controls (shown when connected) */}
      {isConnected && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div style={{ padding:16, borderRadius:10, border:"1px solid var(--border)", background:"var(--bg-elevated)" }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Pull from Wix</div>
              <div style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:12, lineHeight:1.5 }}>Import all your Wix Blog posts into Blog Bunker. Existing Blog Bunker posts are preserved.</div>
              <button onClick={pullPosts} disabled={syncing}
                style={{ padding:"9px 20px", borderRadius:8, border:"none", background:syncing?"var(--bg)":"#5cba6c", color:"#fff", fontSize:12, fontWeight:700, cursor:syncing?"not-allowed":"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8 }}>
                {syncing ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Syncing…</> : "↓ Pull Posts from Wix"}
              </button>
            </div>
            <div style={{ padding:16, borderRadius:10, border:"1px solid var(--border)", background:"var(--bg-elevated)", opacity:0.6 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Push to Wix</div>
              <div style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:12, lineHeight:1.5 }}>Publish Blog Bunker drafts directly to your Wix Blog. Coming in the next release.</div>
              <button disabled style={{ padding:"9px 20px", borderRadius:8, border:"none", background:"var(--bg)", color:"var(--muted)", fontSize:12, fontWeight:700, cursor:"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
                ↑ Push to Wix — Coming Soon
              </button>
            </div>
          </div>

          {currentPostCount > 0 && (
            <div style={{ fontSize:12, color:"var(--text-secondary)", padding:"8px 12px", borderRadius:6, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
              ▤ Blog Bunker currently has <strong style={{color:"var(--text)"}}>{currentPostCount} posts</strong>. Pulling from Wix will add any posts not already present.
            </div>
          )}
        </div>
      )}

      {/* Activity log */}
      {log.length > 0 && (
        <div style={{ borderRadius:10, border:"1px solid var(--border)", overflow:"hidden" }}>
          <div style={{ padding:"8px 14px", background:"var(--bg-elevated)", borderBottom:"1px solid var(--border)", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", display:"flex", justifyContent:"space-between" }}>
            Sync Log
            <button onClick={()=>setLog([])} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--muted)", fontSize:11 }}>Clear</button>
          </div>
          <div style={{ maxHeight:180, overflow:"auto", padding:"10px 14px", display:"flex", flexDirection:"column", gap:4 }}>
            {log.map((l, i) => (
              <div key={i} style={{ fontSize:12, display:"flex", gap:10, alignItems:"baseline" }}>
                <span style={{ color:"var(--muted)", flexShrink:0, fontFamily:"monospace", fontSize:10 }}>{l.ts}</span>
                <span style={{ color: l.type==="success"?"#5cba6c":l.type==="error"?"var(--red)":"var(--text-secondary)" }}>{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding:"12px 16px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:12, color:"var(--text-secondary)", lineHeight:1.7 }}>
        <strong style={{color:"var(--text)"}}>How it works:</strong> Blog Bunker calls the Wix Blog API through a secure server-side proxy — your API key never touches the browser. Posts are cached in your browser's localStorage. Pull whenever you publish new content on Wix to keep Blog Bunker in sync.
      </div>
    </div>
  );
}

// ─── SETTINGS: GENERAL ───────────────────────────────────────────────────────

function GeneralSettings({ wsName, wsUrl, wsTagline, onSave, btnP, inputSt }) {
  const [form,  setForm]  = useState({ name:wsName, url:wsUrl, tagline:wsTagline });
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    onSave(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:0 }}>Workspace Settings</h3>
      {[{label:"Blog Name",key:"name"},{label:"Blog URL",key:"url"},{label:"Tagline",key:"tagline"}].map(f => (
        <div key={f.label}>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>{f.label}</label>
          <input style={inputSt} value={form[f.key]} onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))} />
        </div>
      ))}
      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={handleSave} style={{ ...btnP, alignSelf:"flex-start" }}>Save Changes</button>
        {saved && <span style={{ fontSize:12, color:"var(--green)" }}>✓ Saved</span>}
      </div>
    </div>
  );
}

// ─── MODAL SHELL ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:16, padding:28, width:"100%", maxWidth: wide ? 720 : 520, maxHeight:"90vh", overflow:"auto", boxShadow:"0 32px 80px rgba(0,0,0,0.6)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:0 }}>{title}</h2>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--muted)", fontSize:20, lineHeight:1, padding:4 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── POST EDITOR MODAL ────────────────────────────────────────────────────────

const CATEGORIES = ["Culture", "Whiskey", "Gear", "Destinations", "Technique", "Lifestyle", "Reviews", "News"];

function PostEditor({ post, onSave, onClose, onDelete }) {
  const isNew = !post?.id;
  const [form, setForm] = useState({
    title:    post?.title    || "",
    body:     post?.body     || "",
    category: post?.category || "Culture",
    status:   post?.status   || "draft",
    date:     post?.date     || new Date().toISOString().split("T")[0],
  });
  const [saved, setSaved] = useState(false);

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };

  const handleSave = () => {
    if (!form.title.trim()) return;
    onSave({ ...post, ...form, id: post?.id || Date.now() });
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 600);
  };

  return (
    <Modal title={isNew ? "New Post" : "Edit Post"} onClose={onClose} wide>
      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Title *</label>
          <input style={iS} placeholder="Post title…" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} autoFocus />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Category</label>
            <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={{ ...iS, cursor:"pointer" }}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Status</label>
            <select value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))} style={{ ...iS, cursor:"pointer" }}>
              {["draft","published","scheduled"].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Date</label>
            <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={iS} />
          </div>
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Body</label>
          <textarea rows={12} value={form.body} onChange={e=>setForm(f=>({...f,body:e.target.value}))} placeholder="Write your post here…" style={{ ...iS, resize:"vertical", lineHeight:1.7 }} />
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", gap:8 }}>
            {!isNew && (
              <button onClick={() => { onDelete(post.id); onClose(); }}
                style={{ padding:"9px 18px", borderRadius:8, border:"1px solid var(--red)44", background:"var(--red)0a", color:"var(--red)", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                Delete
              </button>
            )}
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            {saved && <span style={{ fontSize:12, color:"var(--green)" }}>✓ Saved</span>}
            <button onClick={onClose} style={{ padding:"9px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>Cancel</button>
            <button onClick={handleSave} disabled={!form.title.trim()}
              style={{ padding:"9px 24px", borderRadius:8, border:"none", background:form.title.trim()?"var(--amber)":"var(--bg-elevated)", color:form.title.trim()?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:form.title.trim()?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
              {isNew ? "Create Post" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── ADD COMPETITOR MODAL ─────────────────────────────────────────────────────

function AddCompetitorModal({ onSave, onClose }) {
  const [form, setForm] = useState({ name:"", url:"", da:"", posts:"", traffic:"", strengths:"", threat:"medium" });
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const valid = form.name.trim() && form.url.trim();
  return (
    <Modal title="Add Competitor" onClose={onClose}>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Name *</label>
            <input style={iS} placeholder="Hatch Magazine" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} autoFocus />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>URL *</label>
            <input style={iS} placeholder="hatchmag.com" value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} />
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Domain Authority</label>
            <input style={iS} type="number" placeholder="45" value={form.da} onChange={e=>setForm(f=>({...f,da:e.target.value}))} />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Post Freq</label>
            <input style={iS} placeholder="3/wk" value={form.posts} onChange={e=>setForm(f=>({...f,posts:e.target.value}))} />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Est. Traffic</label>
            <input style={iS} placeholder="50K" value={form.traffic} onChange={e=>setForm(f=>({...f,traffic:e.target.value}))} />
          </div>
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Strengths</label>
          <input style={iS} placeholder="Strong SEO, video content…" value={form.strengths} onChange={e=>setForm(f=>({...f,strengths:e.target.value}))} />
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Threat Level</label>
          <div style={{ display:"flex", gap:8 }}>
            {["low","medium","high"].map(t => (
              <button key={t} onClick={()=>setForm(f=>({...f,threat:t}))}
                style={{ flex:1, padding:"8px", borderRadius:8, border:form.threat===t?`1px solid ${t==="high"?"var(--red)":t==="medium"?"var(--amber)":"var(--green)"}`:"1px solid var(--border)", background:form.threat===t?(t==="high"?"var(--red)":t==="medium"?"var(--amber)":"var(--green)")+"18":"var(--bg-elevated)", color:form.threat===t?(t==="high"?"var(--red)":t==="medium"?"var(--amber)":"var(--green)"):"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", textTransform:"capitalize" }}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:4 }}>
          <button onClick={onClose} style={{ padding:"9px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>Cancel</button>
          <button onClick={()=>{ if(valid){ onSave({...form, da:Number(form.da)||0, id:Date.now()}); onClose(); }}} disabled={!valid}
            style={{ padding:"9px 24px", borderRadius:8, border:"none", background:valid?"var(--amber)":"var(--bg-elevated)", color:valid?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:valid?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
            Add Competitor
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── ADD INSPIRATION MODAL ────────────────────────────────────────────────────

function AddInspirationModal({ onSave, onClose }) {
  const [form, setForm] = useState({ title:"", source:"", type:"article", notes:"" });
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const valid = form.title.trim();
  return (
    <Modal title="Save Inspiration" onClose={onClose}>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Title / Headline *</label>
          <input style={iS} placeholder="What caught your eye?" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} autoFocus />
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Source</label>
          <input style={iS} placeholder="Reddit r/flyfishing, Hatch Magazine…" value={form.source} onChange={e=>setForm(f=>({...f,source:e.target.value}))} />
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Type</label>
          <div style={{ display:"flex", gap:6 }}>
            {["article","thread","visual","video","podcast"].map(t => (
              <button key={t} onClick={()=>setForm(f=>({...f,type:t}))}
                style={{ padding:"6px 12px", borderRadius:99, border:form.type===t?"1px solid var(--amber)":"1px solid var(--border)", background:form.type===t?"var(--amber-glow)":"transparent", color:form.type===t?"var(--amber)":"var(--text-secondary)", fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", textTransform:"capitalize" }}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Notes / Angle Idea</label>
          <textarea rows={3} style={{ ...iS, resize:"none" }} placeholder="Why does this matter? What angle could you take?" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
          <button onClick={onClose} style={{ padding:"9px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>Cancel</button>
          <button onClick={()=>{ if(valid){ onSave({...form, id:Date.now()}); onClose(); }}} disabled={!valid}
            style={{ padding:"9px 24px", borderRadius:8, border:"none", background:valid?"var(--amber)":"var(--bg-elevated)", color:valid?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:valid?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── ADD CALENDAR EVENT MODAL ─────────────────────────────────────────────────

function AddCalendarEventModal({ day, onSave, onClose }) {
  const [form, setForm] = useState({ title:"", type:"idea", day: day || 1 });
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const valid = form.title.trim();
  return (
    <Modal title={day ? `Add Event — May ${day}` : "Add Calendar Event"} onClose={onClose}>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Event Title *</label>
          <input style={iS} placeholder="Post title, newsletter, idea…" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} autoFocus />
        </div>
        {!day && (
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Day of Month</label>
            <input style={iS} type="number" min={1} max={31} value={form.day} onChange={e=>setForm(f=>({...f,day:Number(e.target.value)}))} />
          </div>
        )}
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Type</label>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {[{id:"scheduled",color:"var(--amber)"},{id:"newsletter",color:"#5cba6c"},{id:"draft",color:"var(--muted)"},{id:"idea",color:"var(--text-secondary)"}].map(t=>(
              <button key={t.id} onClick={()=>setForm(f=>({...f,type:t.id}))}
                style={{ padding:"6px 14px", borderRadius:99, border:form.type===t.id?`1px solid ${t.color}`:"1px solid var(--border)", background:form.type===t.id?t.color+"22":"transparent", color:form.type===t.id?t.color:"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", textTransform:"capitalize" }}>
                {t.id}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:4 }}>
          <button onClick={onClose} style={{ padding:"9px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>Cancel</button>
          <button onClick={()=>{ if(valid){ onSave({...form, day: day || form.day}); onClose(); }}} disabled={!valid}
            style={{ padding:"9px 24px", borderRadius:8, border:"none", background:valid?"var(--amber)":"var(--bg-elevated)", color:valid?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:valid?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
            Add Event
          </button>
        </div>
      </div>
    </Modal>
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
  const [apiKeys,         setApiKeys]        = useState(loadKeys);
  const [activeProvider,  setActiveProvider] = useState(() => localStorage.getItem(ACTIVE_PROVIDER_STORAGE) || "anthropic");
  const [activeModel,     setActiveModel]    = useState(() => { const m = loadModels(); const p = AI_PROVIDERS.find(x=>x.id===(localStorage.getItem(ACTIVE_PROVIDER_STORAGE)||"anthropic"))||AI_PROVIDERS[0]; return m[p.id] || p.defaultModel; });

  // ── Persistent state (localStorage)
  const [posts,       setPosts]       = useState(() => { try { const s = localStorage.getItem("bb_posts"); return s ? JSON.parse(s) : DEFAULT_POSTS; } catch { return DEFAULT_POSTS; } });
  const [competitors, setCompetitors] = useState(() => { try { const s = localStorage.getItem("bb_competitors"); return s ? JSON.parse(s) : COMPETITORS; } catch { return COMPETITORS; } });
  const [inspiration, setInspiration] = useState(() => { try { const s = localStorage.getItem("bb_inspiration"); return s ? JSON.parse(s) : INSPIRATION; } catch { return INSPIRATION; } });
  const [calEvents,   setCalEvents]   = useState(() => { try { const s = localStorage.getItem("bb_cal_events"); return s ? JSON.parse(s) : CALENDAR_EVENTS; } catch { return CALENDAR_EVENTS; } });
  const [wsSettings,  setWsSettings]  = useState(() => { try { const s = localStorage.getItem("bb_ws_settings"); return s ? JSON.parse(s) : null; } catch { return null; } });

  // Persist whenever data changes
  useEffect(() => { try { localStorage.setItem("bb_posts",       JSON.stringify(posts));       } catch {} }, [posts]);
  useEffect(() => { try { localStorage.setItem("bb_competitors", JSON.stringify(competitors)); } catch {} }, [competitors]);
  useEffect(() => { try { localStorage.setItem("bb_inspiration", JSON.stringify(inspiration)); } catch {} }, [inspiration]);
  useEffect(() => { try { localStorage.setItem("bb_cal_events",  JSON.stringify(calEvents));  } catch {} }, [calEvents]);

  // ── Modal state
  const [postEditorOpen,    setPostEditorOpen]    = useState(false);
  const [editingPost,       setEditingPost]       = useState(null);
  const [addCompetitorOpen, setAddCompetitorOpen] = useState(false);
  const [addInspirationOpen,setAddInspirationOpen]= useState(false);
  const [calModalDay,       setCalModalDay]       = useState(null);
  const [calModalOpen,      setCalModalOpen]      = useState(false);

  // ── Handlers
  const openNewPost   = ()  => { setEditingPost(null); setPostEditorOpen(true); };
  const openEditPost  = (p) => { setEditingPost(p);    setPostEditorOpen(true); };

  const savePost = (p) => {
    setPosts(all => all.find(x => x.id === p.id) ? all.map(x => x.id===p.id ? p : x) : [...all, p]);
  };
  const deletePost = (id) => setPosts(all => all.filter(p => p.id !== id));

  const saveCompetitor = (c) => setCompetitors(all => [...all, c]);
  const deleteCompetitor = (name) => setCompetitors(all => all.filter(c => c.name !== name));

  const saveInspiration = (item) => setInspiration(all => [item, ...all]);
  const deleteInspiration = (id) => setInspiration(all => all.filter(i => i.id !== id));
  const inspirationToDraft = (item) => {
    const newPost = { id:Date.now(), title:item.title, body:`Source: ${item.source}\n\nNotes: ${item.notes}\n\n`, category:"Culture", status:"draft", date:new Date().toISOString().split("T")[0], views:0 };
    setPosts(all => [newPost, ...all]);
    setEditingPost(newPost);
    setPostEditorOpen(true);
    setActiveTab("posts");
  };

  const saveCalEvent = (ev) => setCalEvents(all => [...all, ev]);
  const deleteCalEvent = (idx) => setCalEvents(all => all.filter((_, i) => i !== idx));

  const [wixConnected, setWixConnected] = useState(() => !!loadWixConfig().connected);

  const handleWixSync = (wixPosts) => {
    setPosts(current => {
      // Merge: keep existing non-wix posts, replace/add wix posts by wixId
      const nonWix = current.filter(p => !p.fromWix);
      const merged = [...nonWix, ...wixPosts];
      return merged;
    });
    setWixConnected(true);
  };

  const handleWixDisconnect = () => {
    setWixConnected(false);
    // Remove pulled wix posts, keep locally-created ones
    setPosts(current => current.filter(p => !p.fromWix));
  };

  const saveWsSettings = (s) => {
    setWsSettings(s);
    try { localStorage.setItem("bb_ws_settings", JSON.stringify(s)); } catch {}
  };

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

  const wsName    = wsSettings?.name      || workspace?.name      || "Cask & Stream";
  const wsUrl     = wsSettings?.url       || workspace?.url       || "caskandstream.com";
  const wsTagline = wsSettings?.tagline   || "Cast at Dawn. Sip at Dusk.";
  const connected = workspace?.connected  || false;
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
  const connectedSocial    = SOCIAL_PLATFORMS.filter(p => loadSocialConnections()[p.id]?.enabled).length;

  const TABS = [
    { id:"posts",     label:"Posts",     icon:"▤" },
    { id:"analytics", label:"Analytics", icon:"◔" },
    { id:"calendar",  label:"Calendar",  icon:"▦" },
    { id:"research",  label:"Research",  icon:"◎" },
    { id:"ai",        label:"AI Tools",  icon:"✦" },
    { id:"social",    label:"Social",    icon:"◈" },
    { id:"settings",  label:"Settings",  icon:"⚙" },
  ];

  const SETTINGS_SECTIONS = [
    { id:"general",  label:"General"          },
    { id:"apikeys",  label:"API Keys"         },
    { id:"social",   label:"Social Media"     },
    { id:"wix",      label:"Wix Integration"  },
    { id:"billing",  label:"Billing & Plan"   },
    { id:"account",  label:"Account"          },
  ];

  return (
    <div style={{...theme,fontFamily:"var(--font-body)",color:"var(--text)",background:"var(--bg)",minHeight:"100vh",display:"flex",fontSize:14,lineHeight:1.5}}>
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* ── MODALS ── */}
      {postEditorOpen && (
        <PostEditor
          post={editingPost}
          onSave={savePost}
          onClose={() => setPostEditorOpen(false)}
          onDelete={deletePost}
        />
      )}
      {addCompetitorOpen && (
        <AddCompetitorModal
          onSave={saveCompetitor}
          onClose={() => setAddCompetitorOpen(false)}
        />
      )}
      {addInspirationOpen && (
        <AddInspirationModal
          onSave={saveInspiration}
          onClose={() => setAddInspirationOpen(false)}
        />
      )}
      {calModalOpen && (
        <AddCalendarEventModal
          day={calModalDay}
          onSave={saveCalEvent}
          onClose={() => setCalModalOpen(false)}
        />
      )}

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
          <div style={{fontSize:10,marginTop:6,color:wixConnected?fixedGreen:"var(--muted)"}}>
            <span style={{width:6,height:6,borderRadius:99,background:wixConnected?fixedGreen:"var(--muted)",display:"inline-block",marginRight:4}}/>
            {wixConnected?"Wix Connected":"Wix Not Connected"}
          </div>
          <div style={{fontSize:10,marginTop:4,color:"var(--text-secondary)"}}>
            <span style={{color:fixedGreen}}>◈</span> {connectedProviders} AI · {connectedSocial} social
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
              {posts.length} posts · {wsTagline}
            </p>
          </div>
          <div style={{display:"flex",gap:8}}>
            {wixConnected && (
              <button style={btnS} onClick={()=>{setActiveTab("settings");setSettingsSection("wix");}}>↓ Sync Wix</button>
            )}
            <button style={btnS} onClick={()=>{ const input = document.createElement("input"); input.type="file"; input.accept=".md,.txt,.html"; input.onchange = e => { const file = e.target.files[0]; if(!file) return; const reader = new FileReader(); reader.onload = ev => { const newPost = { id:Date.now(), title:file.name.replace(/\.[^/.]+$/,""), body:ev.target.result, category:"Culture", status:"draft", date:new Date().toISOString().split("T")[0], views:0 }; savePost(newPost); setEditingPost(newPost); setPostEditorOpen(true); }; reader.readAsText(file); }; input.click(); }}>Import</button>
            <button style={btnP} onClick={openNewPost}>+ New Post</button>
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
                      <tr key={p.id} onClick={()=>openEditPost(p)} style={{borderBottom:"1px solid var(--border)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
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
                <div style={{display:"flex",gap:12,alignItems:"center"}}>
                  {[{color:"var(--amber)",l:"Scheduled"},{color:fixedGreen,l:"Newsletter"},{color:"var(--muted)",l:"Draft"},{color:"var(--text-secondary)",l:"Idea"}].map(x=>(
                    <div key={x.l} style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--text-secondary)"}}>
                      <span style={{width:8,height:8,borderRadius:99,background:x.color,display:"inline-block"}}/>{x.l}
                    </div>
                  ))}
                  <button onClick={()=>{setCalModalDay(null);setCalModalOpen(true);}} style={{...btnP,padding:"6px 14px",fontSize:12}}>+ Add Event</button>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,background:"var(--border)",borderRadius:12,overflow:"hidden",border:"1px solid var(--border)"}}>
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>(
                  <div key={d} style={{background:"var(--bg-elevated)",padding:10,textAlign:"center",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{d}</div>
                ))}
                {Array(4).fill(null).map((_,i)=><div key={`e${i}`} style={{background:"var(--bg-surface)",padding:12,minHeight:80}}/>)}
                {Array(31).fill(null).map((_,i)=>{
                  const day=i+1;
                  const evs=calEvents.filter(e=>e.day===day);
                  const tc={scheduled:"var(--amber)",newsletter:fixedGreen,draft:"var(--muted)",idea:"var(--text-secondary)"};
                  return (
                    <div key={day} onClick={()=>{setCalModalDay(day);setCalModalOpen(true);}} style={{background:"var(--bg-surface)",padding:"8px 10px",minHeight:80,cursor:"pointer",position:"relative"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="var(--bg-surface)"}>
                      <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:4}}>{day}</div>
                      {evs.map((ev,ei)=>(
                        <div key={ei} onClick={e=>{e.stopPropagation();deleteCalEvent(calEvents.findIndex(c=>c.day===day&&c.title===ev.title));}} title="Click to remove" style={{fontSize:10,padding:"2px 6px",borderRadius:4,background:(tc[ev.type]||"var(--muted)")+"22",color:tc[ev.type]||"var(--muted)",fontWeight:600,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",cursor:"pointer"}}>{ev.title}</div>
                      ))}
                    </div>
                  );
                })}
              </div>
              <p style={{fontSize:11,color:"var(--muted)",marginTop:10}}>Click a day to add an event · Click an event to remove it</p>
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
                    <button onClick={()=>setAddCompetitorOpen(true)} style={btnP}>+ Add Competitor</button>
                  </div>
                  <div style={{...card,padding:0,overflow:"hidden"}}>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr style={{borderBottom:"1px solid var(--border)"}}>
                        {["Competitor","DA","Frequency","Est. Traffic","Strengths","Threat"].map(h=>(
                          <th key={h} style={{textAlign:"left",padding:"12px 16px",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {competitors.map(c=>(
                          <tr key={c.name||c.id} style={{borderBottom:"1px solid var(--border)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <td style={{padding:"14px 16px"}}><div style={{fontWeight:600,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:"var(--text-secondary)"}}>{c.url}</div></td>
                            <td style={{padding:"14px 16px",fontWeight:700,fontSize:14,color:"var(--amber)"}}>{c.da}</td>
                            <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.posts}</td>
                            <td style={{padding:"14px 16px",fontSize:12,fontWeight:600}}>{c.traffic}</td>
                            <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.strengths}</td>
                            <td style={{padding:"14px 16px"}}><ThreatBadge level={c.threat}/></td>
                            <td style={{padding:"14px 16px"}}><button onClick={()=>deleteCompetitor(c.name)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:14}} title="Remove">✕</button></td>
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
                    <button onClick={()=>setAddInspirationOpen(true)} style={btnP}>+ Save New</button>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    {inspiration.map(item=>{
                      const tc={article:{icon:"📄",color:"var(--amber)"},thread:{icon:"💬",color:fixedGreen},visual:{icon:"📸",color:"#7c8abf"},video:{icon:"▶",color:"var(--red)"},podcast:{icon:"🎙",color:"#a78bfa"}};
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
                          <div style={{display:"flex",gap:6,flexShrink:0}}>
                            <button onClick={()=>inspirationToDraft(item)} style={{...btnS,fontSize:11,padding:"5px 10px"}}>→ Draft</button>
                            <button onClick={()=>deleteInspiration(item.id)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:14,padding:"5px"}} title="Remove">✕</button>
                          </div>
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

          {/* ══ SOCIAL ══ */}
          {activeTab==="social"&&(
            <div>
              <div style={{marginBottom:24}}>
                <h2 style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,margin:"0 0 4px"}}>Social Media Posts</h2>
                <p style={{fontSize:13,color:"var(--text-secondary)",margin:0}}>Generate from a topic or blog post — adapted automatically for each platform.</p>
              </div>
              <SocialPostTab
                activeProvider={activeProvider}
                activeModel={activeModel}
                apiKeys={apiKeys}
                dark={dark}
              />
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
                  <GeneralSettings
                    wsName={wsName}
                    wsUrl={wsUrl}
                    wsTagline={wsTagline}
                    onSave={saveWsSettings}
                    btnP={btnP}
                    inputSt={inputSt}
                  />
                )}

                {settingsSection==="apikeys"&&(
                  <APIKeysSettings apiKeys={apiKeys} onSave={setApiKeys}/>
                )}

                {settingsSection==="social"&&(
                  <SocialSettings/>
                )}

                {settingsSection==="wix"&&(
                  <WixSyncPanel
                    onSync={handleWixSync}
                    onDisconnect={handleWixDisconnect}
                    currentPostCount={posts.length}
                  />
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
