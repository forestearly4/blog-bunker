import React, { useState, useRef, useEffect } from "react";
import { useAuth } from "./auth";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";

// ─── BRAND GUIDE ──────────────────────────────────────────────────────────────
// Stores voice/tone/image style settings that get injected into every AI call.

const BRAND_GUIDE_STORAGE = "bb_brand_guide";

const DEFAULT_BRAND_GUIDE = {
  brandName:      "",
  tagline:        "",
  audience:       "",
  voiceTone:      "",
  writingStyle:   "",
  avoidWords:     "",
  imageStyle:     "",
  colorPalette:   "",
  topics:         "",
  competitors:    "",
};

function loadBrandGuide() {
  try { return { ...DEFAULT_BRAND_GUIDE, ...JSON.parse(localStorage.getItem(BRAND_GUIDE_STORAGE) || "{}") }; }
  catch { return { ...DEFAULT_BRAND_GUIDE }; }
}

function saveBrandGuide(data) {
  try { localStorage.setItem(BRAND_GUIDE_STORAGE, JSON.stringify(data)); } catch {}
}

// Builds a system prompt prefix from the brand guide — injected into every AI call
function buildBrandContext(guide) {
  if (!guide) return "";
  const parts = [];
  if (guide.brandName)    parts.push(`Brand: ${guide.brandName}${guide.tagline ? ` — "${guide.tagline}"` : ""}`);
  if (guide.audience)     parts.push(`Target audience: ${guide.audience}`);
  if (guide.voiceTone)    parts.push(`Voice & tone: ${guide.voiceTone}`);
  if (guide.writingStyle) parts.push(`Writing style: ${guide.writingStyle}`);
  if (guide.avoidWords)   parts.push(`Never use these words/phrases: ${guide.avoidWords}`);
  if (guide.topics)       parts.push(`Core topics: ${guide.topics}`);
  if (!parts.length) return "";
  return `BRAND GUIDE:\n${parts.join("\n")}\n\nAlways follow this brand guide in your response.\n\n`;
}

// Builds an image prompt prefix from the brand guide
function buildBrandImageContext(guide) {
  if (!guide) return "";
  const parts = [];
  if (guide.imageStyle)   parts.push(guide.imageStyle);
  if (guide.colorPalette) parts.push(`color palette: ${guide.colorPalette}`);
  if (guide.brandName)    parts.push(`for ${guide.brandName} brand`);
  return parts.join(", ");
}

// ─── CLOUD SYNC (Netlify Blobs) ──────────────────────────────────────────────
// Syncs key data to server-side storage so it survives localStorage clearing.
// Falls back silently to localStorage-only if the network call fails.

async function cloudGet(key, userId) {
  try {
    const res = await fetch(`/api/data?key=${encodeURIComponent(key)}&userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    return data.value;
  } catch { return null; }
}

async function cloudSet(key, userId, value) {
  try {
    await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, userId, value }),
    });
    return true;
  } catch { return false; }
}

// Debounced cloud save — avoids hammering the API on every keystroke
const cloudSaveTimers = {};
function cloudSaveDebounced(key, userId, value, delay = 1500) {
  clearTimeout(cloudSaveTimers[key]);
  cloudSaveTimers[key] = setTimeout(() => cloudSet(key, userId, value), delay);
}

// ─── ROBUST JSON PARSER ───────────────────────────────────────────────────────
// AI responses sometimes get truncated mid-string (token limits, overload).
// This attempts to repair common truncation issues before giving up.

function parseAIJson(text) {
  let cleaned = text.replace(/```json|```/g, "").trim();

  try { return JSON.parse(cleaned); } catch {}

  // Repair 1 — close unterminated string, trim to last complete element
  try {
    let repaired = cleaned;
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';

    let depth = 0, lastValidEnd = -1, inString = false, escape = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{" || ch === "[") depth++;
      if (ch === "}" || ch === "]") { depth--; if (depth === 0) lastValidEnd = i; }
    }
    if (lastValidEnd > -1 && lastValidEnd < repaired.length - 1) {
      repaired = repaired.slice(0, lastValidEnd + 1);
    }
    return JSON.parse(repaired);
  } catch {}

  // Repair 2 — array truncated mid-object, trim to last complete item
  try {
    if (cleaned.trim().startsWith("[")) {
      const lastComplete = cleaned.lastIndexOf("},");
      if (lastComplete > -1) return JSON.parse(cleaned.slice(0, lastComplete + 1) + "]");
      const lastBrace = cleaned.lastIndexOf("}");
      if (lastBrace > -1) return JSON.parse(cleaned.slice(0, lastBrace + 1) + "]");
    }
  } catch {}

  // Repair 3 — extract individual {...} objects via regex, parse each independently
  // Recovers as many valid objects as possible even if overall structure is broken
  try {
    const objectMatches = cleaned.match(/\{[^{}]*\}/g);
    if (objectMatches && objectMatches.length > 0) {
      const recovered = [];
      for (const m of objectMatches) {
        try { recovered.push(JSON.parse(m)); } catch {}
      }
      if (recovered.length > 0) return recovered;
    }
  } catch {}

  throw new Error("AI response was cut off and couldn't be repaired — try again.");
}

// Plain-text fallback that keeps links VISIBLE as "text (url)" instead of silently
// discarding the URL — for paste destinations that don't accept rich HTML.
function markdownToPlainWithLinks(md) {
  return (md || "")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .trim();
}

// Writes both HTML and plain-text to the clipboard so links survive when pasted into
// a rich-text editor, with a plain-text-only fallback for older browsers/permissions.
// Reuses the app's existing markdownToHtml() converter (defined later in this file,
// used by RichTextEditor — safe to call here due to function hoisting).
// Uploads a file to a GCS resumable-upload session URL, following Google's own
// documented retry protocol: a bare single PUT with no retry logic (the previous
// implementation) turns any transient GCS 500/503 into a permanent user-facing
// failure. Per Google's docs, a 500/503 on a resumable upload is expected/normal
// and the client must check how many bytes were actually received (an empty PUT
// with Content-Range: bytes */total) and resume from that offset rather than
// re-sending the whole file blind.
// A plain fetch() has no timeout at all — if it stalls (mobile connectivity
// blip), the caller just hangs forever with nothing to show the user. Used for
// steps in the upload chain that aren't already XHR-based with their own abort.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch(e) {
    if (e.name === "AbortError") throw new Error(`Request to ${url} stalled — no response after ${timeoutMs/1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function uploadToGCSResumable(uploadUrl, file, onProgress) {
  // Sending the whole remaining file in one PUT (the previous approach) is
  // exactly the pattern that struggles on mobile — one very large request is
  // much more likely to get interrupted (backgrounding, network handoffs, OS-
  // level suspension of long transfers) than several small ones. Explicit
  // fixed-size chunking is what Google's own docs recommend for unreliable
  // connections. Must be a multiple of 256 KiB for all but the final chunk.
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB

  const putChunk = (blob, startByte) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    // xhr.timeout alone isn't reliably honored by every mobile browser for a
    // connection that stalls before any response starts (as opposed to one
    // that's merely slow) — this was the actual cause of uploads sitting at 0%
    // forever with no error ever surfacing. A manual hard-abort guarantees
    // SOMETHING happens within a bounded time no matter what.
    const hardAbort = setTimeout(() => {
      if (settled) return;
      settled = true;
      xhr.abort();
      reject(new Error("Upload stalled — no response from the server after 20s"));
    }, 20000);
    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardAbort);
      fn(...args);
    };
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 25000; // secondary — the manual hardAbort above is the real backstop
    if (blob.size > 0) xhr.setRequestHeader("Content-Type", file.type);
    if (startByte > 0 || blob.size < file.size) {
      xhr.setRequestHeader("Content-Range", `bytes ${startByte}-${startByte + blob.size - 1}/${file.size}`);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round(((startByte + e.loaded) / file.size) * 100));
    };
    xhr.onload    = finish(() => resolve({ status: xhr.status, range: xhr.getResponseHeader("Range"), body: xhr.responseText }));
    xhr.onerror   = finish(() => reject(new Error("Network error during upload")));
    xhr.ontimeout = finish(() => reject(new Error("Chunk upload timed out")));
    xhr.onabort   = finish(() => reject(new Error("Upload was aborted")));
    xhr.send(blob);
  });

  const checkStatus = () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const hardAbort = setTimeout(() => {
      if (settled) return;
      settled = true;
      xhr.abort();
      reject(new Error("Status check stalled — no response after 15s"));
    }, 15000);
    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardAbort);
      fn(...args);
    };
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 12000;
    xhr.setRequestHeader("Content-Range", `bytes */${file.size}`);
    xhr.onload    = finish(() => resolve({ status: xhr.status, range: xhr.getResponseHeader("Range") }));
    xhr.onerror   = finish(() => reject(new Error("Network error checking upload status")));
    xhr.ontimeout = finish(() => reject(new Error("Status check timed out")));
    xhr.onabort   = finish(() => reject(new Error("Status check was aborted")));
    xhr.send(new Blob([]));
  });

  const parseRange = (rangeHeader) => {
    if (!rangeHeader) return null;
    const match = rangeHeader.match(/bytes=0-(\d+)/);
    return match ? parseInt(match[1], 10) + 1 : null;
  };

  return new Promise(async (resolve, reject) => {
    // Google's own client libraries retry near-indefinitely on 500/503 (bounded
    // only by an overall deadline, not a small fixed attempt count).
    const maxErrorAttempts = 8;
    let startByte = 0;
    let lastBody = "";
    let errorAttempts = 0;

    while (startByte < file.size) {
      try {
        const chunkEnd = Math.min(startByte + CHUNK_SIZE, file.size);
        const chunk = file.slice(startByte, chunkEnd);
        console.log(`[gcs-upload] sending bytes ${startByte}-${chunkEnd-1} of ${file.size}…`);
        const result = await putChunk(chunk, startByte);
        console.log(`[gcs-upload] response: status=${result.status} range=${result.range || "(none)"}`);

        if (result.status === 200 || result.status === 201) { console.log("[gcs-upload] COMPLETE"); return resolve(); }

        if (result.status === 308) {
          const confirmedByte = parseRange(result.range);
          if (confirmedByte != null) {
            // GCS explicitly confirmed how many bytes it has — trust it, even
            // if it's less than this chunk's full range (a partial chunk write).
            startByte = confirmedByte;
            errorAttempts = 0; // real confirmed progress
            continue;
          }
          // No Range header on the 308 means GCS is NOT confirming any bytes
          // were persisted for this attempt — previously this blindly assumed
          // success and advanced to chunkEnd anyway, which is exactly what
          // caused "upload offset exceeds already uploaded size" errors (we'd
          // move on to the next chunk while GCS's session still had 0 bytes).
          // Ask GCS directly what it actually has before deciding what to do.
          try {
            const status = await checkStatus();
            const confirmed = parseRange(status.range);
            startByte = confirmed != null ? confirmed : startByte; // never advance without explicit confirmation
          } catch { /* leave startByte where it was — retry this same chunk */ }
          errorAttempts++;
          if (errorAttempts >= maxErrorAttempts) return reject(new Error(`GCS never confirmed receiving the data after ${maxErrorAttempts} attempts — try again, possibly on a different network.`));
          await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, errorAttempts - 1), 8000)));
          continue;
        }

        if (result.status === 500 || result.status === 503) {
          errorAttempts++;
          lastBody = result.body || "";
          if (errorAttempts >= maxErrorAttempts) return reject(new Error(`Upload failed after ${maxErrorAttempts} attempts (${result.status}): ${lastBody.slice(0,300) || "no further detail from GCS"}`));
          await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, errorAttempts - 1), 16000)));
          try {
            const status = await checkStatus();
            if (status.status === 200 || status.status === 201) return resolve();
            const confirmed = parseRange(status.range);
            if (confirmed != null) startByte = confirmed;
          } catch { /* status check failed — retry this same chunk */ }
          continue;
        }

        return reject(new Error(`Upload failed: ${result.status} — ${(result.body || "").slice(0,300)}`));
      } catch(e) {
        // Network error or chunk timeout — retry this same chunk, don't lose
        // progress on already-confirmed earlier chunks.
        errorAttempts++;
        if (errorAttempts >= maxErrorAttempts) return reject(new Error(`The connection kept dropping partway through (last error: ${e.message}). Try again — progress up to ${Math.round((startByte/file.size)*100)}% was made before it failed.`));
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, errorAttempts - 1), 16000)));
      }
    }
    resolve(); // startByte reached file.size without an explicit 200/201 (shouldn't normally happen, but treat as done)
  });
}

// The Hashtags stage produces one shared hashtag string used across every
// selected platform, but some platforms want far fewer than others (X performs
// best with ~1-2 hashtags, unlike Instagram's 20-30). Trims down per-platform
// without touching the underlying hashtags.selected the user actually picked.
function limitHashtagsForPlatform(hashtagString, platformId, maxCounts = { twitter: 2 }) {
  const max = maxCounts[platformId];
  if (max == null || !hashtagString) return hashtagString;
  const tags = hashtagString.split(/\s+/).filter(Boolean);
  return tags.slice(0, max).join(" ");
}

function TierLockedNotice({ feature, requiredTier = "Operative" }) {
  return (
    <div style={{ padding:"24px 20px", borderRadius:12, border:"1px solid var(--amber)33", background:"var(--amber)0a", textAlign:"center" }}>
      <div style={{ fontSize:28, marginBottom:10 }}>🔒</div>
      <div style={{ fontSize:15, fontWeight:700, marginBottom:6 }}>{feature} is available on {requiredTier} and above</div>
      <p style={{ fontSize:13, color:"var(--text-secondary)", margin:"0 0 16px", maxWidth:420, marginLeft:"auto", marginRight:"auto", lineHeight:1.6 }}>
        Upgrade your plan in Settings → Billing & Plan to unlock this.
      </p>
    </div>
  );
}

function UsagePanel({ tierConfig, userId }) {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/usage?userId=${encodeURIComponent(userId)}`);
        const data = await res.json();
        if (!cancelled) setUsage(data);
      } catch { /* fall through to loading:false below */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const wordsUsed  = usage?.wordsUsed ?? 0;
  const wordCap    = tierConfig.wordsPerMonth;
  const wordPct    = Math.min(100, Math.round((wordsUsed / wordCap) * 100));
  const wordColor  = wordPct >= 100 ? "var(--red)" : wordPct >= 80 ? "var(--amber)" : "#5cba6c";

  const imagesUsed = usage?.imagesUsed ?? 0;
  const imageCap   = tierConfig.imagesPerMonth;
  const imagePct   = Math.min(100, Math.round((imagesUsed / imageCap) * 100));
  const imageColor = imagePct >= 100 ? "var(--red)" : imagePct >= 80 ? "var(--amber)" : "#5cba6c";

  return (
    <div style={{ borderTop:"1px solid var(--border)", paddingTop:20 }}>
      <h4 style={{ fontFamily:"var(--font-display)", fontSize:14, fontWeight:700, margin:"0 0 12px" }}>This Month's AI Usage</h4>
      {loading ? (
        <div style={{ fontSize:12, color:"var(--muted)" }}>Loading…</div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:6 }}>
              <span style={{ color:"var(--text-secondary)" }}>AI writing (platform-managed Claude credits)</span>
              <span style={{ fontWeight:700, color: wordPct >= 100 ? "var(--red)" : "var(--text)" }}>{wordsUsed.toLocaleString()} / {wordCap.toLocaleString()} words</span>
            </div>
            <div style={{ height:8, borderRadius:99, background:"var(--bg-elevated)", overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${wordPct}%`, background:wordColor, borderRadius:99, transition:"width 0.3s" }} />
            </div>
            {wordPct >= 100 && (
              <div style={{ fontSize:11, color:"var(--red)", marginTop:6 }}>
                ⚠ Monthly limit reached — add your own API key in Settings → API Keys{tierConfig.byok ? "" : " (upgrade to Operative to unlock this)"}, or wait until next month.
              </div>
            )}
          </div>
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:6 }}>
              <span style={{ color:"var(--text-secondary)" }}>AI images (platform-managed Stability credits)</span>
              <span style={{ fontWeight:700, color: imagePct >= 100 ? "var(--red)" : "var(--text)" }}>{imagesUsed.toLocaleString()} / {imageCap.toLocaleString()} images</span>
            </div>
            <div style={{ height:8, borderRadius:99, background:"var(--bg-elevated)", overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${imagePct}%`, background:imageColor, borderRadius:99, transition:"width 0.3s" }} />
            </div>
            {imagePct >= 100 && (
              <div style={{ fontSize:11, color:"var(--red)", marginTop:6 }}>
                ⚠ Monthly limit reached — add your own OpenAI/Gemini/Stability key in Settings → API Keys{tierConfig.byok ? "" : " (upgrade to Operative to unlock this)"}, or wait until next month.
              </div>
            )}
          </div>
          <div style={{ fontSize:11, color:"var(--muted)", lineHeight:1.6 }}>
            Platform-managed images use Blog Bunker's built-in Stability AI credits — no setup needed. Prefer OpenAI or Gemini instead? Add your own key in Settings → API Keys{tierConfig.byok ? "" : " (Operative and above)"}.
          </div>
        </div>
      )}
    </div>
  );
}

async function copyPostWithLinks(title, body, headlineImageUrl = null) {
  const plainText = `${title}${headlineImageUrl ? `\n[Headline image: ${headlineImageUrl}]` : ""}\n\n${markdownToPlainWithLinks(body)}`;
  const escTitle = (title||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const html = `<p><strong>${escTitle}</strong></p>\n${headlineImageUrl ? `<p><img src="${headlineImageUrl}" alt="${escTitle}"></p>\n` : ""}${markdownToHtml(body)}`;
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([plainText], { type: "text/plain" }),
          "text/html":  new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    }
  } catch {} // fall through to plain-text copy below
  await navigator.clipboard.writeText(plainText);
}

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
  { name:"Hatch Magazine",  url:"hatchmag.com",       posts:"4/wk", traffic:"120K", strengths:"Strong SEO, video content",   threat:"high"   },
  { name:"MidCurrent",      url:"midcurrent.com",      posts:"3/wk", traffic:"95K",  strengths:"Expert contributors, guides", threat:"high"   },
  { name:"Gink & Gasoline", url:"ginkandgasoline.com", posts:"2/wk", traffic:"45K",  strengths:"Community, humor",            threat:"medium" },
  { name:"The Drake",       url:"drakemag.com",        posts:"1/wk", traffic:"30K",  strengths:"Literary voice, photography", threat:"low"    },
  { name:"Whisky Advocate", url:"whiskyadvocate.com",  posts:"5/wk", traffic:"310K", strengths:"Authority, reviews",          threat:"medium" },
];

const INSPIRATION = [
  { id:1, source:"Reddit r/flyfishing", title:"What whiskey do you bring on the river?",   type:"thread",  notes:"Direct audience overlap — listicle potential"        },
  { id:2, source:"Hatch Magazine",      title:"Why Euro Nymphing Is Taking Over",           type:"article", notes:"Counter-argument: the dry fly purist's case"         },
  { id:3, source:"Whisky Advocate",     title:"The 10 Best Sherried Single Malts of 2026",  type:"article", notes:"Pair each with a river destination — killer concept" },
  { id:4, source:"Instagram @drakemag", title:"Golden hour on the Madison",                 type:"visual",  notes:""                                                    },
];

const PLANS = [
  { name:"Scout",     price:"$19/mo", features:["1 Workspace","15,000 AI words/mo","20 AI images/mo","Meta (Facebook & Instagram) posting only","Community Support"] },
  { name:"Operative", price:"$45/mo", features:["3 Workspaces included (+$5/mo each additional)","60,000 AI words/mo","100 AI images/mo","Buffer integration (TikTok, X, Pinterest, Reddit)","Bring your own AI key (BYOK)","Email Support"] },
];
// "Command" is a status, not a purchasable tier — auto-unlocks at 10 workspaces
// on one account (shared API keys across workspaces, priority support).

// Feature gating by tier. Scout is deliberately limited to platform-managed
// Claude text credits and Meta-only posting; Operative unlocks BYOK (own
// OpenAI/Gemini/Anthropic keys), Buffer (TikTok/X/Pinterest/Reddit), and a
// bigger text credit pool. Since OpenAI/Gemini already require the user's own
// key with no platform-managed fallback, Scout has no AI image generation
// until either they upgrade (BYOK) or a platform-managed image path is built.
const TIER_CONFIG = {
  scout:     { label:"Scout",     wordsPerMonth:15000, imagesPerMonth:20,  byok:false, buffer:false, socialPlatforms:["facebook","instagram"] },
  operative: { label:"Operative", wordsPerMonth:60000, imagesPerMonth:100, byok:true,  buffer:true,  socialPlatforms:["facebook","instagram","tiktok","twitter","pinterest","reddit"] },
};
const TIER_STORAGE = "bb_user_tier";
function loadUserTier() { try { return localStorage.getItem(TIER_STORAGE) || "scout"; } catch { return "scout"; } }
function saveUserTier(tier) {
  try { localStorage.setItem(TIER_STORAGE, tier); } catch {}
  const uid = window.__bbUserId;
  if (uid) cloudSet("user_tier", uid, tier);
}

// ─── AI PROVIDER CONFIG ───────────────────────────────────────────────────────

const AI_PROVIDERS = [
  {
    id: "anthropic",
    name: "Claude",
    company: "Anthropic",
    logo: "◈",
    color: "#d4a054",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
    defaultModel: "claude-sonnet-5",
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
    models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "gemini-3.5-flash",
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
  // Push to cloud
  const uid = window.__bbUserId;
  if (uid) cloudSet("api_keys", uid, keys);
}
function loadModels() {
  try {
    const m = JSON.parse(localStorage.getItem(MODEL_STORAGE) || "{}");
    // Migrate deprecated dated model snapshots saved before this fix
    const DEPRECATED_MODEL_MAP = { "claude-sonnet-4-20250514": "claude-sonnet-5", "claude-opus-4-20250514": "claude-opus-4-8" };
    if (m.anthropic && DEPRECATED_MODEL_MAP[m.anthropic]) {
      m.anthropic = DEPRECATED_MODEL_MAP[m.anthropic];
      saveModels(m);
    }
    return m;
  } catch { return {}; }
}
function saveModels(models) {
  try { localStorage.setItem(MODEL_STORAGE, JSON.stringify(models)); } catch {}
}

// ─── MULTI-PROVIDER AI CALLER ─────────────────────────────────────────────────

async function callAI(providerId, model, system, userMsg, apiKey, maxTokens = 1500) {
  if (providerId === "anthropic") {
    // Route through Netlify proxy if no client key, otherwise call directly
    const useProxy = !apiKey;
    const endpoint = useProxy ? "/api/claude" : "https://api.anthropic.com/v1/messages";
    const headers = useProxy
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({
        model, max_tokens: maxTokens, system, messages: [{ role:"user", content: userMsg }],
        ...(useProxy ? { userId: window.__bbUserId || null } : {}),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || data.error || "Anthropic error");
    return data.content?.[0]?.text || "";
  }

  if (providerId === "openai") {
    if (!apiKey) throw new Error("OpenAI API key required. Add it in Settings → API Keys.");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role:"system", content: system }, { role:"user", content: userMsg }], max_tokens: maxTokens }),
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
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${system}\n\n${userMsg}` }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Gemini error: ${data.error.message || JSON.stringify(data.error)}`);
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
    bestTimes: ["Tue–Fri 11am–1pm", "Mon–Fri 7–9pm"],
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
    bestTimes: ["Wed 11am–1pm", "Thu–Fri 1–4pm"],
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
    bestTimes: ["Tue–Thu 7–9pm", "Fri–Sun 6–9pm"],
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
    bestTimes: ["Mon–Fri 9am–12pm", "Sat 10am–12pm"],
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
    bestTimes: ["Mon–Fri 8–10am", "Wed 5–6pm"],
    tone: "sharp, witty, opinionated, punchy",
    format: "Single punchy statement or question. Max 280 chars. 1-2 hashtags max. No filler.",
    placeholder: "Write a tweet",
    urlNote: "URLs count as ~23 chars — account for that in length",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    icon: "📌",
    color: "#e60023",
    charLimit: 500,
    hashtagLimit: 5,
    bestTimes: ["Sat–Sun 2–4pm", "Fri 3–5pm"],
    tone: "inspirational, keyword-rich, search-friendly",
    format: "2-3 sentences with keywords, CTA, 3-5 relevant hashtags",
    placeholder: "Write Pinterest pin description",
    urlNote: "Pin links directly to your blog post for traffic",
  },
];

const SOCIAL_KEYS_STORAGE = "bb_social_connections";

function loadSocialConnections() {
  try { return JSON.parse(localStorage.getItem(SOCIAL_KEYS_STORAGE) || "{}"); } catch { return {}; }
}
function saveSocialConnections(data) {
  try { localStorage.setItem(SOCIAL_KEYS_STORAGE, JSON.stringify(data)); } catch {}
}

// ─── MULTI-PROVIDER IMAGE GENERATOR ──────────────────────────────────────────

const PLATFORM_IMAGE_SPECS = {
  instagram: { ratio:"1:1",  label:"Square (1:1)",     style:"cinematic lifestyle photography, golden hour"     },
  facebook:  { ratio:"3:2",  label:"Landscape (3:2)",  style:"editorial photography, wide scene"                },
  tiktok:    { ratio:"2:3",  label:"Portrait (2:3)",   style:"vibrant lifestyle photography, vertical"          },
  reddit:    { ratio:"1:1",  label:"Square (1:1)",     style:"documentary photography, authentic"               },
  twitter:   { ratio:"16:9", label:"Widescreen (16:9)",style:"editorial photography, wide cinematic"            },
};

// Determine which image provider to use based on available keys — falls back
// to Blog Bunker's own platform-managed Stability credits if the user hasn't
// added their own key for anything, so image generation always works.
function getImageProvider(apiKeys) {
  if (apiKeys["stability"]) return "stability";
  if (apiKeys["openai"])    return "dalle";
  if (apiKeys["gemini"])    return "gemini-image";
  return "stability"; // platform-managed fallback (no key) — see generateImage()
}

function getImageProviderLabel(provider, apiKeys = null) {
  if (provider === "stability" && apiKeys && !apiKeys["stability"]) return "Blog Bunker (built-in Stability AI credits)";
  return { stability:"Stability AI", dalle:"GPT Image (OpenAI)", "gemini-image":"Gemini Image" }[provider] || "No image provider";
}

// Returns list of all image providers that have a key configured
function getAvailableImageProviders(apiKeys) {
  const all = [
    { id:"stability",     label:"Stability AI",        keyName:"stability", logo:"◆" },
    { id:"dalle",         label:"GPT Image (OpenAI)",  keyName:"openai",    logo:"●" },
    { id:"gemini-image",  label:"Gemini Image",        keyName:"gemini",    logo:"✦" },
  ];
  return all.map(p => ({ ...p, available: !!apiKeys[p.keyName] }));
}

async function generateImage(prompt, platId, apiKeys, forceProvider = null) {
  const provider = forceProvider || getImageProvider(apiKeys);
  const spec = PLATFORM_IMAGE_SPECS[platId] || PLATFORM_IMAGE_SPECS.instagram;
  const keyMap = { stability:"stability", dalle:"openai", "gemini-image":"gemini" };
  const apiKey = apiKeys[keyMap[provider]];
  // Stability alone has a platform-managed fallback (no key needed) — every
  // other provider still requires the user's own key with no exception.
  if (!apiKey && provider !== "stability") throw new Error(`${getImageProviderLabel(provider)} key not set. Add it in Settings → API Keys.`);
  const sizeMap = { "1:1":"1024x1024", "3:2":"1536x1024", "2:3":"1024x1536", "16:9":"1536x1024" };
  const size = sizeMap[spec.ratio] || "1024x1024";

  // OpenAI — call directly from browser (avoids Netlify 10s timeout, OpenAI supports CORS for images)
  if (provider === "dalle") {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model:"gpt-image-2", prompt, n:1, size }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image data returned from OpenAI");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type:"image/png" }));
  }

  // Gemini — call directly from browser
  if (provider === "gemini-image") {
    const models = ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"];
    let lastErr = "";
    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }],
              generationConfig: { responseModalities: ["IMAGE","TEXT"] },
            }),
          }
        );
        const data = await res.json();
        if (data.error) { lastErr = data.error.message; continue; }
        const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (!part) { lastErr = "No image data returned"; continue; }
        const bytes = Uint8Array.from(atob(part.inlineData.data), c => c.charCodeAt(0));
        return URL.createObjectURL(new Blob([bytes], { type: part.inlineData.mimeType || "image/png" }));
      } catch(e) { lastErr = e.message; }
    }
    throw new Error(`Gemini image failed: ${lastErr}`);
  }

  // Stability AI — routes through the proxy (no CORS support). "stability" here
  // means straightforward text-to-image, NOT the img2img/restyle case in
  // image-generate.js — this was previously calling that endpoint by mistake,
  // which always failed since img2img requires an existing image to transform.
  const isPlatformManaged = provider === "stability" && !apiKey;
  const res = await fetch("/api/image-generate", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isPlatformManaged
      ? { provider:"stability-platform", prompt, size, userId: window.__bbUserId || null }
      : { provider:"stability-text", prompt, apiKey, size }),
  });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error("Image generation timed out — try again");
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error);
  const bytes = Uint8Array.from(atob(data.b64), c => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type:"image/png" }));
}

function SaveToLibraryButton({ imageUrl, tags = ["generated"], name = "generated", userId, style: extraStyle = {} }) {
  const resolvedUserId = userId || window.__bbUserId || "anonymous";
  const [saved,   setSaved]   = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const handle = async () => {
    if (!imageUrl) return;
    setSaving(true); setSaveErr("");
    try {
      let dataUrl;
      if (imageUrl.startsWith("blob:")) {
        const res  = await fetch(imageUrl);
        if (!res.ok) throw new Error(`Could not read image (${res.status})`);
        const blob = await res.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("FileReader failed"));
          reader.readAsDataURL(blob);
        });
      } else if (imageUrl.startsWith("data:")) {
        dataUrl = imageUrl;
      } else {
        const res  = await fetch(imageUrl);
        const blob = await res.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("FileReader failed"));
          reader.readAsDataURL(blob);
        });
      }
      // Compress if over 4MB
      if (dataUrl.length > 4_000_000) {
        dataUrl = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            const scale = Math.sqrt(4_000_000 / dataUrl.length) * 0.9;
            c.width  = Math.round(img.width  * scale);
            c.height = Math.round(img.height * scale);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.85));
          };
          img.onerror = () => reject(new Error("Compression failed"));
          img.src = dataUrl;
        });
      }
      // Upload to cloud
      const res = await fetch("/api/gcs", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId: resolvedUserId, dataUrl, name: `${name}-${Date.now()}`, tags, source: "generated" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed (${res.status})`);
      }
      window.dispatchEvent(new CustomEvent("bb-media-updated"));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch(e) {
      console.error("Save to library failed:", e);
      setSaveErr(e.message.slice(0, 60));
      setTimeout(() => setSaveErr(""), 4000);
    }
    setSaving(false);
  };

  return (
    <div style={{ display:"inline-flex", flexDirection:"column", gap:3 }}>
      <button onClick={handle} disabled={saving}
        style={{ padding:"6px 14px", borderRadius:6, border:"none", background:saved?"rgba(92,186,108,0.85)":saving?"rgba(0,0,0,0.5)":"rgba(196,124,43,0.85)", color:"#fff", fontSize:11, fontWeight:700, cursor:saving?"not-allowed":"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)", ...extraStyle }}>
        {saved ? "✓ Saved" : saving ? "◌ Saving…" : "🖼 Save"}
      </button>
      {saveErr && <div style={{ fontSize:10, color:"var(--red)", maxWidth:130, lineHeight:1.3 }}>{saveErr}</div>}
    </div>
  );
}

// ─── IMAGE SAVE PANEL ────────────────────────────────────────────────────────
// Shows the generated image with download + save controls and visible status

function ImageSavePanel({ imageUrl, tags = ["generated"], name = "generated" }) {
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [status,  setStatus]  = useState("");

  const saveToLibrary = async () => {
    const userId = window.__bbUserId || "anonymous";
    setSaving(true); setSaved(false);
    setStatus(`Saving… (user: ${userId})`);

    try {
      // Convert blob: URL to base64
      let dataUrl = imageUrl;
      if (imageUrl.startsWith("blob:")) {
        setStatus("Reading image…");
        const res  = await fetch(imageUrl);
        if (!res.ok) throw new Error(`Could not read image blob (${res.status})`);
        const blob = await res.blob();
        setStatus(`Encoding ${Math.round(blob.size/1024)}KB image…`);
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("FileReader failed"));
          reader.readAsDataURL(blob);
        });
      }

      // Compress if over 4MB
      if (dataUrl.length > 4_000_000) {
        setStatus(`Compressing large image (${Math.round(dataUrl.length/1024)}KB)…`);
        dataUrl = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            const scale = Math.sqrt(4_000_000 / dataUrl.length) * 0.9;
            c.width  = Math.round(img.width  * scale);
            c.height = Math.round(img.height * scale);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.85));
          };
          img.onerror = () => reject(new Error("Canvas compression failed"));
          img.src = dataUrl;
        });
      }

      setStatus(`Uploading to cloud (${Math.round(dataUrl.length/1024)}KB)…`);
      const res = await fetch("/api/gcs", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          userId,
          dataUrl,
          name:   `${name}-${Date.now()}`,
          tags,
          source: "generated",
        }),
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0,100)}`); }

      if (!res.ok || data.error) throw new Error(data.error || `Upload failed (${res.status})`);

      window.dispatchEvent(new CustomEvent("bb-media-updated"));
      setSaved(true);
      setStatus(`✓ Saved to library!`);
      setTimeout(() => setStatus(""), 4000);

    } catch(e) {
      setStatus(`✗ ${e.message}`);
    }
    setSaving(false);
  };

  return (
    <div style={{ borderRadius:12, overflow:"hidden", border:"1px solid var(--border)" }}>
      <div style={{ position:"relative" }}>
        <img src={imageUrl} alt="Generated" style={{ width:"100%", display:"block" }} />
        <div style={{ position:"absolute", bottom:10, right:10, display:"flex", gap:6 }}>
          <button onClick={() => { const a=document.createElement("a"); a.href=imageUrl; a.download=`${name}-${Date.now()}.jpg`; a.click(); }}
            style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.75)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
            ↓ Download
          </button>
          <button onClick={saveToLibrary} disabled={saving}
            style={{ padding:"6px 14px", borderRadius:6, border:"none", background:saved?"rgba(92,186,108,0.9)":saving?"rgba(0,0,0,0.5)":"rgba(196,124,43,0.85)", color:"#fff", fontSize:11, fontWeight:700, cursor:saving?"not-allowed":"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
            {saving ? "◌" : saved ? "✓ Saved" : "🖼 Save to Library"}
          </button>
        </div>
      </div>
      {status && (
        <div style={{ padding:"8px 12px", background:status.startsWith("✗")?"var(--red)11":status.startsWith("✓")?"#5cba6c11":"var(--bg-elevated)", fontSize:11, color:status.startsWith("✗")?"var(--red)":status.startsWith("✓")?"#5cba6c":"var(--text-secondary)", borderTop:"1px solid var(--border)" }}>
          {status}
        </div>
      )}
    </div>
  );
}

// ─── IMAGE PROVIDER PREFERENCE ───────────────────────────────────────────────

const IMAGE_PROVIDER_STORAGE = "bb_image_provider";
function loadImageProviderPref() { return localStorage.getItem(IMAGE_PROVIDER_STORAGE) || null; }
function saveImageProviderPref(id) {
  if (id) localStorage.setItem(IMAGE_PROVIDER_STORAGE, id);
  else localStorage.removeItem(IMAGE_PROVIDER_STORAGE);
}

// Returns the provider to actually use: explicit pref if valid, else auto-priority
function resolveImageProvider(apiKeys) {
  const pref = loadImageProviderPref();
  const keyMap = { stability:"stability", dalle:"openai", "gemini-image":"gemini" };
  if (pref && apiKeys[keyMap[pref]]) return pref;
  return getImageProvider(apiKeys);
}

function ImageProviderPicker({ apiKeys, value, onChange, compact = false }) {
  const providers = getAvailableImageProviders(apiKeys);
  const anyAvailable = providers.some(p => p.available);

  if (!anyAvailable) {
    return (
      <div style={{ fontSize:11, color:"var(--amber)", padding:"6px 10px", borderRadius:6, background:"var(--amber-glow)", border:"1px solid var(--amber)33" }}>
        ⚠ Add Stability AI, OpenAI, or Gemini key in Settings → API Keys
      </div>
    );
  }

  return (
    <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
      {!compact && <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>Image AI:</span>}
      {providers.map(p => (
        <button key={p.id} onClick={() => p.available && onChange(p.id)} disabled={!p.available}
          title={p.available ? p.label : `${p.label} — add key in Settings`}
          style={{
            padding: compact ? "4px 10px" : "5px 12px",
            borderRadius:99,
            border: value===p.id ? "1px solid #7c3aed" : "1px solid var(--border)",
            background: value===p.id ? "#7c3aed18" : "transparent",
            color: value===p.id ? "#a78bfa" : p.available ? "var(--text-secondary)" : "var(--muted)",
            fontSize: compact ? 11 : 12,
            fontWeight:600,
            cursor: p.available ? "pointer" : "not-allowed",
            fontFamily:"var(--font-body)",
            display:"flex", alignItems:"center", gap:5,
            opacity: p.available ? 1 : 0.4,
          }}>
          <span>{p.logo}</span>{p.label}
        </button>
      ))}
    </div>
  );
}
async function generateImagePrompt(topic, platId, activeProvider, activeModel, apiKey, brandGuideOverride = null) {
  const spec = PLATFORM_IMAGE_SPECS[platId] || PLATFORM_IMAGE_SPECS.instagram;
  const brandImgCtx = buildBrandImageContext(brandGuideOverride || loadBrandGuide());
  const styleNote = brandImgCtx ? `Brand visual style: ${brandImgCtx}.` : "Style: moody and cinematic, Pacific Northwest or Appalachian wilderness, amber tones.";
  const text = await callAI(
    activeProvider, activeModel,
    `You generate image prompts for Cask & Stream — a fly fishing and whiskey lifestyle brand. ${styleNote} Format: ${spec.style}. Return ONLY a single descriptive prompt string, no explanation, no quotes, no labels. Photorealistic and evocative.`,
    `Write an image prompt for a ${platId} post (${spec.label}) about: ${topic}`,
    apiKey
  );
  return text.trim();
}

// ─── IMAGE PANEL (per platform) ───────────────────────────────────────────────

function ImagePanel({ platId, topic, activeProvider, activeModel, apiKeys, platColor }) {
  const [imgPrompt,  setImgPrompt]  = useState("");
  const [imageUrl,   setImageUrl]   = useState(null);
  const [genLoading, setGenLoading] = useState(false);
  const [promptLoad, setPromptLoad] = useState(false);
  const [error,      setError]      = useState("");
  const [showPrompt, setShowPrompt] = useState(false);

  const [imgProvider, setImgProvider] = useState(() => resolveImageProvider(apiKeys));
  const provider    = imgProvider;
  const providerLabel = getImageProviderLabel(provider, apiKeys);
  const spec        = PLATFORM_IMAGE_SPECS[platId] || PLATFORM_IMAGE_SPECS.instagram;
  const isLoading   = genLoading || promptLoad;

  const handleImgProviderChange = (id) => { setImgProvider(id); saveImageProviderPref(id); };

  const runGenerate = async (prompt) => {
    setGenLoading(true); setError(""); setImageUrl(null);
    try {
      const url = await generateImage(prompt, platId, apiKeys, imgProvider);
      setImageUrl(url);
    } catch(e) { setError(e.message); }
    setGenLoading(false);
  };

  const handleGenerate = async () => {
    setError("");
    if (!imgPrompt) {
      setPromptLoad(true);
      try {
        const p = await generateImagePrompt(topic, platId, activeProvider, activeModel, apiKeys[activeProvider]);
        setImgPrompt(p); setPromptLoad(false);
        await runGenerate(p);
      } catch(e) { setError(e.message); setPromptLoad(false); setGenLoading(false); }
    } else {
      await runGenerate(imgPrompt);
    }
  };

  const handleDownload = () => {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `cask-stream-${platId}-${Date.now()}.jpg`;
    a.click();
  };

  return (
    <div style={{ marginTop:20, paddingTop:20, borderTop:"1px solid var(--border)" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, flexWrap:"wrap", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:13, fontWeight:700 }}>▣ Image</span>
          <span style={{ fontSize:10, color:"var(--muted)", padding:"1px 7px", borderRadius:99, border:"1px solid var(--border)" }}>{spec.label}</span>
        </div>
        <ImageProviderPicker apiKeys={apiKeys} value={imgProvider} onChange={handleImgProviderChange} compact />
      </div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", marginBottom:12 }}>
        <div style={{ display:"flex", gap:6 }}>
          {imgPrompt && !imageUrl && (
            <button onClick={()=>setShowPrompt(s=>!s)}
              style={{ padding:"4px 10px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {showPrompt ? "Hide" : "Edit"} Prompt
            </button>
          )}
          <button onClick={handleGenerate} disabled={isLoading || !topic.trim() || !provider}
            style={{ padding:"5px 14px", borderRadius:6, border:"none", background:isLoading||!topic.trim()||!provider?"var(--bg-elevated)":"#7c3aed", color:isLoading||!topic.trim()||!provider?"var(--muted)":"#fff", fontSize:11, fontWeight:700, cursor:isLoading||!topic.trim()||!provider?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
            {isLoading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{promptLoad?"Writing prompt…":"Generating…"}</> : imageUrl ? "↻ Regenerate" : "▣ Generate Image"}
          </button>
        </div>
      </div>

      {showPrompt && imgPrompt && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:4 }}>Prompt (editable)</div>
          <div style={{ display:"flex", gap:8 }}>
            <textarea value={imgPrompt} onChange={e=>setImgPrompt(e.target.value)} rows={2}
              style={{ flex:1, padding:"8px 12px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", outline:"none", resize:"vertical", lineHeight:1.5 }} />
            <button onClick={()=>runGenerate(imgPrompt)} disabled={genLoading}
              style={{ padding:"8px 14px", borderRadius:8, border:"none", background:"#7c3aed", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", alignSelf:"flex-start", whiteSpace:"nowrap" }}>
              {genLoading ? "…" : "Run →"}
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize:12, color:"var(--red)", marginBottom:10, padding:"6px 10px", borderRadius:6, background:"var(--red)11", border:"1px solid var(--red)33" }}>{error}</div>}

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
            <span style={{ fontSize:11, color:"var(--muted)" }}>
              {provider ? `Click Generate Image — ${providerLabel} will create a ${spec.label} image` : "Add an image provider key in Settings → API Keys"}
            </span>
          </div>
        )
      )}

      {isLoading && !imageUrl && (
        <div style={{ height:120, borderRadius:10, border:"1px solid var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
          <span style={{ animation:"spin 1s linear infinite", display:"inline-block", fontSize:20, opacity:0.5 }}>◌</span>
          <span style={{ fontSize:12, color:"var(--muted)" }}>{promptLoad ? "Writing image prompt…" : `Generating with ${providerLabel}…`}</span>
        </div>
      )}
    </div>
  );
}

// ─── SOCIAL POST GENERATOR ────────────────────────────────────────────────────

function FacebookPostButton({ page, caption }) {
  const [posting, setPosting] = useState(false);
  const [result,  setResult]  = useState("");
  const post = async () => {
    setPosting(true); setResult("");
    try {
      const res = await metaPost({ pageId: page.id, pageToken: page.access_token, message: caption, platforms: ["facebook"] });
      setResult(res.facebook?.success ? "✓ Posted!" : `Error: ${res.facebook?.error}`);
    } catch(e) { setResult(`Error: ${e.message}`); }
    setPosting(false);
  };
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
      <button onClick={post} disabled={posting || !caption}
        style={{ padding:"7px 16px", borderRadius:7, border:"none", background:posting||!caption?"var(--bg-elevated)":"#1877f2", color:posting||!caption?"var(--muted)":"#fff", fontSize:12, fontWeight:700, cursor:posting||!caption?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
        {posting ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Posting…</> : "↑ Post to Facebook"}
      </button>
      {result && <span style={{ fontSize:11, color:result.startsWith("✓")?"var(--green)":"var(--red)" }}>{result}</span>}
    </div>
  );
}

function InstagramPostButton({ page, caption }) {
  const [posting, setPosting] = useState(false);
  const [result,  setResult]  = useState("");
  const post = async () => {
    setResult("Instagram requires an image — generate one first in the ▣ Image section below.");
  };
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
      <button onClick={post} disabled={posting || !caption}
        style={{ padding:"7px 16px", borderRadius:7, border:"none", background:posting||!caption?"var(--bg-elevated)":"#e1306c", color:posting||!caption?"var(--muted)":"#fff", fontSize:12, fontWeight:700, cursor:posting||!caption?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
        {posting ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Posting…</> : "↑ Post to Instagram"}
      </button>
      {result && <span style={{ fontSize:11, color:"var(--amber)" }}>{result}</span>}
    </div>
  );
}

function SocialPostTab({ activeProvider, activeModel, apiKeys, dark, metaConfig = {} }) {
  const [input,       setInput]       = useState("");
  const [inputMode,   setInputMode]   = useState("topic");
  const [loading,     setLoading]     = useState(false);
  const [posts,       setPosts]       = useState({});
  const [error,       setError]       = useState("");
  const [selected,    setSelected]    = useState({ instagram:true, facebook:true, tiktok:true, reddit:true, twitter:true });
  const [copied,      setCopied]      = useState({});
  const [activePlat,  setActivePlat]  = useState("instagram");

  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];

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
          <div style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 12px", borderRadius:99, border:"1px solid #7c3aed44", background:"#7c3aed0a", fontSize:11, color:"#a78bfa" }}>
            <span>▣</span>
            {getImageProviderLabel(getImageProvider(apiKeys), apiKeys)} — images ready
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

              {/* Twitter hard char limit warning */}
              {plat.id === "twitter" && (
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ flex:1, height:4, borderRadius:99, background:"var(--bg-elevated)", overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${Math.min(100,(charCount(plat.id)/280)*100)}%`, background:charCount(plat.id)>280?"var(--red)":charCount(plat.id)>240?"var(--amber)":"#5cba6c", borderRadius:99, transition:"width 0.2s" }} />
                  </div>
                  <span style={{ fontSize:12, fontWeight:700, color:charCount(plat.id)>280?"var(--red)":charCount(plat.id)>240?"var(--amber)":"var(--muted)", flexShrink:0 }}>
                    {280 - charCount(plat.id)} chars left
                  </span>
                </div>
              )}

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
              <div style={{ display:"flex", gap:8, marginTop:16, flexWrap:"wrap" }}>
                {plat.id === "facebook" && metaConfig?.connected && metaConfig?.pages?.length > 0 && (
                  <FacebookPostButton page={metaConfig.pages[0]} caption={posts[plat.id] || ""} />
                )}
                {plat.id === "instagram" && metaConfig?.connected && metaConfig?.pages?.some(p=>p.instagram_id) && (
                  <InstagramPostButton page={metaConfig.pages.find(p=>p.instagram_id)} caption={posts[plat.id] || ""} />
                )}
                {(!metaConfig?.connected || (plat.id !== "facebook" && plat.id !== "instagram")) && (
                  <button onClick={()=>handleCopy(plat.id, posts[plat.id])}
                    style={{ padding:"7px 16px", borderRadius:7, border:`1px solid ${plat.color}44`, background:"transparent", color:plat.color, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    {copied[plat.id] ? "✓ Copied" : `Copy ${plat.name} Post`}
                  </button>
                )}
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
          Mark which platforms you're active on. Facebook and Instagram post directly via <strong style={{color:"var(--text)"}}>Facebook & Instagram</strong> settings, and X, TikTok, Pinterest, and Reddit post directly via <strong style={{color:"var(--text)"}}>Buffer (Social)</strong> settings. For any platform without a direct connection yet, use the Social tab to generate and copy posts.
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
                  {(plat.id === "instagram" || plat.id === "facebook")
                    ? <>✦ Direct posting is live — connect your account under <strong style={{color:"var(--text)"}}>Facebook & Instagram</strong> in Settings.</>
                    : <>✦ Direct posting is live via Buffer — connect your account under <strong style={{color:"var(--text)"}}>Buffer (Social)</strong> in Settings.</>}
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

function ProviderPicker({ activeProvider, activeModel, onProviderChange, onModelChange, keys, compact = false }) {
  const provider  = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const hasKey    = !!keys[activeProvider];
  const isAnthro  = activeProvider === "anthropic";

  if (compact) {
    // Compact inline switcher — just the provider pills, no model
    return (
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:12}}>
        {AI_PROVIDERS.filter(p => p.id !== "stability").map(p => {
          const hasK = !!keys[p.id] || p.id === "anthropic";
          return (
            <button key={p.id} onClick={() => onProviderChange(p.id)} title={hasK ? p.name : `${p.name} — add key in Settings`}
              style={{padding:"4px 10px",borderRadius:99,border:activeProvider===p.id?`1px solid ${p.color}`:"1px solid var(--border)",background:activeProvider===p.id?p.color+"18":"transparent",color:activeProvider===p.id?p.color:"var(--text-secondary)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:4,opacity:hasK?1:0.45}}>
              <span>{p.logo}</span>{p.name}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,flexWrap:"wrap"}}>
      <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>AI</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
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
      {!hasKey && !isAnthro && (
        <div style={{width:"100%",fontSize:11,color:"var(--amber)",padding:"6px 12px",borderRadius:6,background:"var(--amber-glow)",border:"1px solid var(--amber)33"}}>
          ⚠ No API key for {provider.name}. Add one in Settings → API Keys.
        </div>
      )}
    </div>
  );
}

// ─── GLOBAL AI QUICK-SWITCHER ─────────────────────────────────────────────────
// Floating bar for quickly comparing AI outputs across providers

function AIQuickSwitcher({ activeProvider, activeModel, onProviderChange, onModelChange, apiKeys }) {
  const [open,        setOpen]       = useState(false);
  const [imageProvider, setImageProvider] = useState(() => getImageProvider(apiKeys) || "stability");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const imgProviderLabel = getImageProviderLabel(getImageProvider(apiKeys), apiKeys);

  return (
    <div className="bb-ai-switcher" style={{ position:"fixed", bottom:24, right:24, zIndex:999, display:"flex", flexDirection:"column", alignItems:"flex-end", gap:8 }}>
      {open && (
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:14, padding:20, width:320, boxShadow:"0 8px 40px rgba(0,0,0,0.4)", display:"flex", flexDirection:"column", gap:16 }}>
          {/* Text AI */}
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>
              ✦ Text AI — {provider.name}
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
              {AI_PROVIDERS.filter(p => p.id !== "stability").map(p => {
                const hasK = !!apiKeys[p.id] || p.id === "anthropic";
                return (
                  <button key={p.id} onClick={() => onProviderChange(p.id)}
                    style={{ padding:"6px 12px", borderRadius:99, border:activeProvider===p.id?`1px solid ${p.color}`:"1px solid var(--border)", background:activeProvider===p.id?p.color+"22":"transparent", color:activeProvider===p.id?p.color:"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:hasK?"pointer":"not-allowed", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:5, opacity:hasK?1:0.45 }}>
                    <span>{p.logo}</span>{p.name}
                    {!hasK && <span style={{fontSize:9}}>no key</span>}
                  </button>
                );
              })}
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>Model</div>
              <select value={activeModel} onChange={e => onModelChange(e.target.value)}
                style={{ flex:1, padding:"5px 10px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", outline:"none", cursor:"pointer" }}>
                {provider.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          {/* Image AI */}
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
              ▣ Image AI — {imgProviderLabel}
            </div>
            <div style={{ fontSize:11, color:"var(--text-secondary)", lineHeight:1.6 }}>
              {getImageProvider(apiKeys)
                ? `Using ${imgProviderLabel} (priority order: Stability AI → GPT Image → Gemini)`
                : "No image provider — add Stability AI, OpenAI, or Gemini key in Settings → API Keys"}
            </div>
            <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
              {[
                { id:"stability", label:"Stability AI", key:"stability" },
                { id:"dalle",     label:"GPT Image",    key:"openai"    },
                { id:"gemini-image", label:"Gemini",    key:"gemini"    },
              ].map(ip => {
                const hasK = !!apiKeys[ip.key];
                const isActive = getImageProvider(apiKeys) === ip.id;
                return (
                  <div key={ip.id}
                    style={{ padding:"4px 10px", borderRadius:99, border:isActive?`1px solid #7c3aed44`:"1px solid var(--border)", background:isActive?"#7c3aed18":"transparent", color:isActive?"#a78bfa":"var(--text-secondary)", fontSize:11, opacity:hasK?1:0.4 }}>
                    {ip.label}{isActive?" ✓":""}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ fontSize:10, color:"var(--muted)", padding:"8px 12px", borderRadius:6, background:"var(--bg-elevated)", lineHeight:1.6 }}>
            💡 Tip: Generate the same post with different AIs to compare outputs. Switch here and hit Regenerate in the pipeline.
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button onClick={() => setOpen(o => !o)}
        style={{ width:48, height:48, borderRadius:99, background:open?"var(--amber)":"var(--bg-surface)", color:open?"#0e0f11":"var(--amber)", fontSize:20, cursor:"pointer", boxShadow:"0 4px 20px rgba(0,0,0,0.4)", border:`1px solid ${open?"transparent":"var(--amber)44"}`, display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.2s" }}
        title="Switch AI provider">
        {open ? "✕" : "✦"}
      </button>
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
      setHeadlines(parseAIJson(text));
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
      setResult(parseAIJson(text));
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

function APIKeysSettings({ apiKeys, onSave, byokEnabled = true }) {
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
                Claude runs through your Netlify environment variable <code style={{color:"var(--amber)",background:"var(--bg)",padding:"1px 5px",borderRadius:4}}>ANTHROPIC_API_KEY</code> — no browser key needed.{byokEnabled ? " You can optionally add a key below to override it." : ""}
              </div>
            ) : null}

            {(byokEnabled || provider.id === "anthropic") ? (
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
                  disabled={provider.id === "anthropic" && !byokEnabled}
                />
              </div>
            ) : (
              <div style={{marginTop:0,padding:"10px 14px",borderRadius:8,background:"var(--amber)0a",border:"1px solid var(--amber)33",fontSize:12,color:"var(--text-secondary)",lineHeight:1.6}}>
                🔒 Bringing your own {provider.name} key is available on <strong style={{color:"var(--amber)"}}>Operative</strong> and above — upgrade in Settings → Billing & Plan. {provider.name} has no platform-managed option, so this is required to use it at all.
              </div>
            )}

            {provider.id !== "anthropic" && byokEnabled && (
              <div style={{marginTop:10,fontSize:11,color:"var(--text-secondary)",lineHeight:1.5,padding:"8px 12px",borderRadius:6,background:"var(--bg-elevated)",border:"1px solid var(--border)"}}>
                💡 You'll need your own {provider.name} API key from {provider.company}, which is billed separately as pay-as-you-go usage — not included with Blog Bunker. It's usually significantly cheaper than a monthly subscription to {provider.name} directly, since you only pay for what you actually use.
              </div>
            )}

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
  try {
    const cfg = JSON.parse(localStorage.getItem(WIX_STORAGE) || "{}");
    // Ensure correct site member ID is always set
    if (!cfg.memberId) {
      cfg.memberId = "1e9d13fa-cf47-4524-8cf1-78b3193785ec";
    }
    return cfg;
  } catch { return { memberId: "1e9d13fa-cf47-4524-8cf1-78b3193785ec" }; }
}
function saveWixConfig(cfg) {
  try { localStorage.setItem(WIX_STORAGE, JSON.stringify(cfg)); } catch {}
}

// Map Wix post → Blog Bunker post format (handles v2 and v3 response shapes)
function mapWixPost(wp) {
  const publishedDate = wp.firstPublishedDate || wp.publishedDate || wp.lastPublishedDate || wp._updatedDate;
  return {
    id:         wp.id || wp._id || String(Date.now() + Math.random()),
    wixId:      wp.id || wp._id,
    title:      wp.title || "Untitled",
    body:       wp.contentText || wp.richContent?.nodes?.map(n => n.textData?.text || "").join("\n") || wp.excerpt || "",
    excerpt:    wp.excerpt || wp.contentText?.slice(0, 200) || "",
    status:     wp.status === "PUBLISHED" ? "published" : wp.status === "SCHEDULED" ? "scheduled" : "draft",
    date:       publishedDate ? new Date(publishedDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
    views:      wp.stats?.views || 0,
    category:   "Wix",
    slug:       wp.slug || "",
    coverImage: wp.heroImage?.url || wp.media?.wixMedia?.image?.imageInfo?.url || wp.coverMedia?.wixMedia?.image?.imageInfo?.url || "",
    url:        wp.url || "",
    fromWix:    true,
  };
}

/**
 * Calls Wix Blog API through the Netlify Edge Function proxy at /api/wix.
 * Credentials (WIX_API_KEY, WIX_SITE_ID) are read from Netlify environment
 * variables server-side — users don't need to enter them in the UI.
 * User-supplied keys are sent as fallback if env vars aren't set.
 */
async function wixFetch(endpoint, method = "GET", data = null, cfg = {}) {
  const res = await fetch("/api/wix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint, method, data,
      apiKey:    cfg.apiKey    || "",
      siteId:    cfg.siteId    || "",
      accountId: cfg.accountId || cfg.siteId || "", // account ID for owner resolution
    }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error(`Proxy error (${res.status}). Check Netlify Functions tab — edge function may not be deployed.`);
  }

  if (!res.ok || json.error) {
    const detail = json.urlCalled ? `\nURL: ${json.urlCalled}` : "";
    const preview = json.preview ? `\nWix said: ${json.preview.slice(0, 150)}` : "";
    throw new Error((json.error || `API error ${res.status}`) + detail + preview);
  }

  return json;
}

// ─── WIX OAUTH HELPERS ───────────────────────────────────────────────────────

async function getWixOAuthToken(appId, appSecret, instanceId) {
  const res = await fetch("/api/wix-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, appSecret, instanceId }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Token request failed");
  return data.access_token;
}

async function wixFetchOAuth(endpoint, method = "GET", data = null, oauthToken, siteId) {
  const res = await fetch("/api/wix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, method, data, oauthToken, siteId }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Proxy error (${res.status})`); }
  if (!res.ok || json.error) throw new Error(json.error || `API error ${res.status}`);
  return json;
}

// ─── WIX SYNC PANEL ──────────────────────────────────────────────────────────

function WixSyncPanel({ onSync, onDisconnect, currentPostCount, onConnect }) {
  const [cfg,       setCfg]      = useState(loadWixConfig);
  const [status,    setStatus]   = useState(cfg.connected ? "connected" : "idle");
  const [syncing,   setSyncing]  = useState(false);
  const [testing,   setTesting]  = useState(false);
  const [log,       setLog]      = useState([]);
  const [lastSync,  setLastSync] = useState(cfg.lastSync || null);
  const [pullCount, setPullCount]= useState(cfg.pullCount || 0);
  // API key fields
  const [apiKey,    setApiKey]   = useState(cfg.apiKey || "");
  const [siteId,    setSiteId]   = useState(cfg.siteId || "");
  const [showKey,   setShowKey]  = useState(false);
  // OAuth fields
  const [authMode,  setAuthMode] = useState(cfg.oauthToken ? "oauth" : "apikey");
  const [appId,     setAppId]    = useState(cfg.appId || "c6500272-f2ac-4fad-aeef-6cd500382297");
  const [appSecret, setAppSecret]= useState(cfg.appSecret || "");
  const [instanceId,setInstanceId]=useState(cfg.instanceId || "");
  const [oauthToken,setOauthToken]=useState(cfg.oauthToken || "");

  const isConnected = status === "connected" || !!cfg.connected;
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };

  const addLog = (msg, type="info") => setLog(l => [...l, { msg, type, ts: new Date().toLocaleTimeString() }]);

  const testConnection = async () => {
    setTesting(true);
    addLog("Testing Wix connection…");
    const endpoints = ["/v3/posts?paging.limit=1", "/blog/v3/posts?paging.limit=1", "/blog/v3/posts", "/v3/posts"];
    let lastError = "";

    for (const ep of endpoints) {
      try {
        addLog(`Trying ${ep}…`);
        let data;
        if (authMode === "oauth" && oauthToken) {
          data = await wixFetchOAuth(ep, "GET", null, oauthToken, siteId);
        } else {
          data = await wixFetch(ep, "GET", null, { apiKey, siteId });
        }
        if (data.posts !== undefined || data.items !== undefined || Array.isArray(data)) {
          const newCfg = { connected: true, lastSync: null, pullCount: 0, apiKey, siteId, workingEndpoint: ep, appId, appSecret, instanceId, oauthToken };
          saveWixConfig(newCfg); setCfg(newCfg); setStatus("connected");
          addLog(`✓ Connected! Endpoint: ${ep}`, "success");
          if (onConnect) onConnect();
          setTesting(false); return;
        } else {
          addLog(`Response: ${JSON.stringify(data).slice(0,100)}`, "info");
        }
      } catch(e) {
        lastError = e.message;
        addLog(`✗ ${ep}: ${e.message.slice(0,80)}`, "error");
      }
    }
    addLog(`All endpoints failed: ${lastError}`, "error");
    setStatus("error"); setTesting(false);
  };

  const connectOAuth = () => {
    if (!appId) { addLog("App ID / Client ID is required", "error"); return; }
    const redirectUri = "https://blogbunker.netlify.app/api/wix-callback";
    const authUrl = `https://www.wix.com/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=offline_access`;
    addLog("Opening Wix authorization page…");
    const popup = window.open(authUrl, "wix_auth", "width=650,height=750,scrollbars=yes");
    if (!popup) {
      addLog("Popup blocked — allow popups for blogbunker.netlify.app and try again.", "error");
    } else {
      addLog("Complete the authorization in the popup, then come back here.", "info");
    }
  };

  // Handle OAuth token — either via postMessage from popup or URL hash fallback
  useEffect(() => {
    // postMessage handler (popup sends token to parent)
    const handleMessage = (event) => {
      if (event.origin !== "https://blogbunker.netlify.app") return;
      if (event.data?.type !== "wix_oauth_success") return;
      const { access_token, refresh_token } = event.data;
      if (!access_token) return;
      addLog("✓ OAuth token received from Wix!", "success");
      const newCfg = { ...loadWixConfig(), oauthToken: access_token, oauthRefresh: refresh_token || "", connected: true };
      saveWixConfig(newCfg); setCfg(newCfg); setOauthToken(access_token); setStatus("connected");
      if (onConnect) onConnect();
      addLog("✓ Connected! Publishing to Wix should now work.", "success");
    };
    window.addEventListener("message", handleMessage);

    // Hash fallback (if popup was blocked, callback redirects parent)
    const hash = window.location.hash;
    if (hash.includes("wix_token=")) {
      const params = new URLSearchParams(hash.slice(1));
      const token  = params.get("wix_token");
      if (token) {
        addLog("✓ OAuth token received!", "success");
        const newCfg = { ...loadWixConfig(), oauthToken: token, oauthRefresh: params.get("wix_refresh") || "", connected: true };
        saveWixConfig(newCfg); setCfg(newCfg); setOauthToken(token); setStatus("connected");
        if (onConnect) onConnect();
        window.history.replaceState(null, "", window.location.pathname);
      }
    }

    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const pullPosts = async () => {
    setSyncing(true);
    addLog("Pulling posts from Wix Blog…");
    const baseEndpoint = (cfg.workingEndpoint || "/v3/posts").replace(/\?.*/, "");
    try {
      let allPosts = [], cursor = null, page = 1;
      do {
        addLog(`Fetching page ${page}…`);
        const endpoint = `${baseEndpoint}?paging.limit=50${cursor ? `&paging.cursor=${cursor}` : ""}`;
        let data;
        if (cfg.oauthToken) {
          data = await wixFetchOAuth(endpoint, "GET", null, cfg.oauthToken, siteId);
        } else {
          data = await wixFetch(endpoint, "GET", null, { apiKey, siteId });
        }
        const posts = data.posts || data.items || [];
        allPosts = [...allPosts, ...posts];
        cursor = data.pagingMetadata?.cursors?.next || data.next?.cursor || null;
        page++;
        if (posts.length < 50) break;
      } while (cursor && page < 10);

      addLog(`Found ${allPosts.length} posts on Wix`);
      const mapped = allPosts.map(mapWixPost);
      const now = new Date().toISOString();
      const newCfg = { ...cfg, connected: true, lastSync: now, pullCount: mapped.length, apiKey, siteId };
      saveWixConfig(newCfg); setCfg(newCfg); setLastSync(now); setPullCount(mapped.length);
      onSync(mapped);
      addLog(`✓ Synced ${mapped.length} posts`, "success");
    } catch(e) { addLog(`Sync failed: ${e.message}`, "error"); }
    setSyncing(false);
  };

  const disconnect = () => {
    saveWixConfig({});
    setCfg({}); setApiKey(""); setSiteId(""); setAppId(""); setAppSecret(""); setInstanceId(""); setOauthToken("");
    setStatus("idle"); setLog([]); setLastSync(null); setPullCount(0);
    onDisconnect();
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Wix Blog Integration</h3>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
          Connect your Wix site to pull posts and publish directly from Blog Bunker.
        </p>
      </div>

      {/* Connection status */}
      <div style={{ padding:16, borderRadius:10, border:`1px solid ${isConnected?"#5cba6c44":"var(--border)"}`, background:isConnected?"#5cba6c0a":"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ width:10, height:10, borderRadius:99, background:isConnected?"#5cba6c":"var(--muted)", display:"inline-block", boxShadow:isConnected?"0 0 8px #5cba6c66":"none" }}/>
          <div>
            <div style={{ fontWeight:600, fontSize:14 }}>{isConnected ? "Wix Blog Connected" : "Not Connected"}</div>
            {lastSync && <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:2 }}>Last sync: {new Date(lastSync).toLocaleString()}</div>}
            {isConnected && pullCount > 0 && <div style={{ fontSize:11, color:"#5cba6c", marginTop:2 }}>{pullCount} posts pulled</div>}
            {isConnected && cfg.oauthToken && <div style={{ fontSize:11, color:"#5cba6c", marginTop:2 }}>✓ OAuth — full read/write access</div>}
          </div>
        </div>
        {isConnected && <button onClick={disconnect} style={{ padding:"6px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>Disconnect</button>}
      </div>

      {/* Auth mode selector */}
      {!isConnected && (
        <div style={{ display:"flex", gap:4, background:"var(--bg-elevated)", borderRadius:8, padding:3, width:"fit-content" }}>
          {[{id:"apikey",label:"API Key (read only)"},{id:"oauth",label:"OAuth (read + write ✓)"}].map(m=>(
            <button key={m.id} onClick={()=>setAuthMode(m.id)}
              style={{ padding:"7px 16px", borderRadius:6, border:"none", background:authMode===m.id?"var(--amber)":"transparent", color:authMode===m.id?"#0e0f11":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
              {m.label}
            </button>
          ))}
        </div>
      )}

      {/* OAuth fields */}
      {!isConnected && authMode === "oauth" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ padding:"14px 16px", borderRadius:10, background:"var(--amber-glow)", border:"1px solid var(--amber)33", fontSize:12, color:"var(--text-secondary)", lineHeight:1.8 }}>
            <strong style={{color:"var(--amber)"}}>One-time setup:</strong><br/>
            1. Go to <a href="https://dev.wix.com/apps" target="_blank" rel="noopener" style={{color:"var(--amber)"}}>dev.wix.com/apps</a> → your Blog Bunker app<br/>
            2. Make sure <strong style={{color:"var(--text)"}}>Wix Blog</strong> permission is added with read + write<br/>
            3. Add redirect URI: <code style={{background:"var(--bg-elevated)",padding:"1px 6px",borderRadius:4}}>https://blogbunker.netlify.app/api/wix-callback</code><br/>
            4. Paste your App ID below and click Connect
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>App ID</label>
            <input style={{...iS, fontFamily:"monospace"}} placeholder="c6500272-f2ac-4fad-aeef-6cd500382297" value={appId} onChange={e=>setAppId(e.target.value)}
              onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Site ID</label>
            <input style={{...iS, fontFamily:"monospace"}} placeholder="964b56e4-5e8e-48a6-bd1f-2e5dfd11c4c3" value={siteId} onChange={e=>setSiteId(e.target.value)}
              onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          </div>
          <button onClick={connectOAuth} disabled={!appId}
            style={{ padding:"12px 24px", borderRadius:8, border:"none", background:appId?"var(--amber)":"var(--bg-elevated)", color:appId?"#0e0f11":"var(--muted)", fontSize:14, fontWeight:700, cursor:appId?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:10, alignSelf:"flex-start" }}>
            <span style={{fontSize:18}}>⊕</span> Connect with Wix
          </button>
          <p style={{ fontSize:11, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
            A Wix login popup will open. Sign in with your Wix account and approve Blog Bunker. You'll be redirected back automatically.
          </p>
          {log.length > 0 && (
            <div style={{ fontSize:12, color:"var(--text-secondary)", padding:"8px 12px", borderRadius:6, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
              {log[log.length-1]?.msg}
            </div>
          )}
        </div>
      )}

      {/* API key fields */}
      {!isConnected && authMode === "apikey" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:12, color:"var(--text-secondary)", lineHeight:1.6 }}>
            ⚠ API key mode only supports <strong style={{color:"var(--text)"}}>reading</strong> posts. To publish directly to Wix, use the <strong style={{color:"var(--amber)"}}>OAuth</strong> mode instead.
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Wix API Key</label>
            <div style={{ position:"relative" }}>
              <input type={showKey?"text":"password"} style={{...iS, paddingRight:52, fontFamily:"monospace"}} placeholder="IST.eyJ…" value={apiKey} onChange={e=>setApiKey(e.target.value)} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
              <button onClick={()=>setShowKey(s=>!s)} style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:"var(--muted)", fontSize:11 }}>{showKey?"Hide":"Show"}</button>
            </div>
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Wix Site ID</label>
            <input style={{...iS, fontFamily:"monospace"}} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={siteId} onChange={e=>setSiteId(e.target.value)} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          </div>
          <button onClick={testConnection} disabled={!apiKey||!siteId||testing}
            style={{ padding:"10px 20px", borderRadius:8, border:"none", background:apiKey&&siteId&&!testing?"var(--amber)":"var(--bg-elevated)", color:apiKey&&siteId&&!testing?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:apiKey&&siteId&&!testing?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8, alignSelf:"flex-start" }}>
            {testing ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Testing…</> : "Test Connection"}
          </button>
        </div>
      )}

      {/* Connected actions */}
      {isConnected && (
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={pullPosts} disabled={syncing}
            style={{ padding:"10px 20px", borderRadius:8, border:"none", background:syncing?"var(--bg-elevated)":"#5cba6c", color:syncing?"var(--muted)":"#fff", fontSize:13, fontWeight:700, cursor:syncing?"not-allowed":"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8 }}>
            {syncing ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Syncing…</> : "↓ Pull Posts from Wix"}
          </button>
        </div>
      )}

      {/* Notes */}
      {isConnected && currentPostCount > 0 && (
        <div style={{ fontSize:12, color:"var(--text-secondary)", padding:"8px 12px", borderRadius:6, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
          ▤ {currentPostCount} posts in Blog Bunker. Pull from Wix to sync any new posts.
        </div>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div style={{ borderRadius:10, border:"1px solid var(--border)", overflow:"hidden" }}>
          <div style={{ padding:"8px 14px", background:"var(--bg-elevated)", borderBottom:"1px solid var(--border)", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", display:"flex", justifyContent:"space-between" }}>
            Sync Log <button onClick={()=>setLog([])} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--muted)", fontSize:11 }}>Clear</button>
          </div>
          <div style={{ maxHeight:220, overflow:"auto", padding:"10px 14px", display:"flex", flexDirection:"column", gap:4 }}>
            {log.map((l,i)=>(
              <div key={i} style={{ fontSize:11, display:"flex", gap:10, alignItems:"flex-start" }}>
                <span style={{ color:"var(--muted)", flexShrink:0, fontFamily:"monospace", fontSize:10 }}>{l.ts}</span>
                <span style={{ color:l.type==="success"?"#5cba6c":l.type==="error"?"var(--red)":"var(--text-secondary)", whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding:"12px 16px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:12, color:"var(--text-secondary)", lineHeight:1.7 }}>
        🔒 OAuth is the recommended connection method — it gives Blog Bunker full read/write access to your Wix Blog without the memberId limitation that affects API keys.
      </div>
    </div>
  );
}

// ─── SETTINGS: GENERAL ───────────────────────────────────────────────────────

const LOGO_STORAGE = "bb_workspace_logo";
function loadLogo() { try { return localStorage.getItem(LOGO_STORAGE) || null; } catch { return null; } }
function saveLogo(data) { try { localStorage.setItem(LOGO_STORAGE, data); } catch {} }

function GeneralSettings({ wsName, wsUrl, wsTagline, onSave, btnP, inputSt }) {
  const [form,       setForm]       = useState({ name:wsName, url:wsUrl, tagline:wsTagline });
  const [saved,      setSaved]      = useState(false);
  const [logo,       setLogo]       = useState(loadLogo);
  const [logoStatus, setLogoStatus] = useState("");
  const logoInput = useRef(null);

  const handleSave = () => {
    onSave(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleLogoUpload = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setLogoStatus("Only image files supported"); return; }
    if (file.size > 2 * 1024 * 1024) { setLogoStatus("Logo too large — max 2MB"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      // Resize via canvas to max 200px height for sidebar
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxH   = 80;
        const scale  = Math.min(1, maxH / img.height);
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        const resized = canvas.toDataURL("image/png", 0.9);
        saveLogo(resized);
        setLogo(resized);
        // Trigger re-render of sidebar logo
        window.dispatchEvent(new CustomEvent("bb-logo-updated", { detail: resized }));
        setLogoStatus("✓ Logo saved");
        setTimeout(() => setLogoStatus(""), 3000);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => {
    saveLogo("");
    setLogo(null);
    window.dispatchEvent(new CustomEvent("bb-logo-updated", { detail: null }));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {/* Logo Upload */}
      <div>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Brand Logo</h3>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:"0 0 16px" }}>Appears in the sidebar and on exported content. PNG or SVG recommended.</p>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ width:120, height:60, borderRadius:8, border:"2px dashed var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden" }}>
            {logo ? (
              <img src={logo} alt="Logo" style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain" }} />
            ) : (
              <span style={{ fontSize:11, color:"var(--muted)", textAlign:"center", padding:8 }}>No logo yet</span>
            )}
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <button onClick={() => logoInput.current?.click()}
              style={{ padding:"7px 16px", borderRadius:7, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {logo ? "↑ Replace Logo" : "↑ Upload Logo"}
            </button>
            {logo && (
              <button onClick={removeLogo}
                style={{ padding:"7px 16px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                Remove Logo
              </button>
            )}
            {logoStatus && <span style={{ fontSize:11, color:"#5cba6c" }}>{logoStatus}</span>}
          </div>
        </div>
        <input ref={logoInput} type="file" accept="image/*" style={{ display:"none" }} onChange={e => handleLogoUpload(e.target.files[0])} />
      </div>

      <div style={{ borderTop:"1px solid var(--border)", paddingTop:24 }}>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 16px" }}>Workspace Settings</h3>
        {[{label:"Blog Name",key:"name"},{label:"Blog URL",key:"url"},{label:"Tagline",key:"tagline"}].map(f => (
          <div key={f.label} style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>{f.label}</label>
            <input style={inputSt} value={form[f.key]} onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))} />
          </div>
        ))}
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button onClick={handleSave} style={{ ...btnP, alignSelf:"flex-start" }}>Save Changes</button>
          {saved && <span style={{ fontSize:12, color:"var(--green)" }}>✓ Saved</span>}
        </div>
      </div>
    </div>
  );
}

// ─── AI IDEA GENERATOR ───────────────────────────────────────────────────────

function AIIdeaGenerator({ posts, inspiration, onAddIdeas, activeProvider, activeModel, apiKeys, dark, onProviderChange, onModelChange }) {
  const [loading,    setLoading]    = useState(false);
  const [ideas,      setIdeas]      = useState([]);
  const [error,      setError]      = useState("");
  const [saved,      setSaved]      = useState({});
  const [focus,      setFocus]      = useState("mixed");
  const [customTopic,setCustomTopic]= useState("");
  const [ideaCount,  setIdeaCount]  = useState(10);
  const [mode,       setMode]       = useState("category"); // "category" | "custom"
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const FOCUSES = [
    { id:"mixed",      label:"Mixed",          desc:"All angles" },
    { id:"whiskey",    label:"Whiskey",         desc:"Bourbon, scotch, pairings" },
    { id:"flyfishing", label:"Fly Fishing",     desc:"Technique, gear, destinations" },
    { id:"lifestyle",  label:"Lifestyle",       desc:"Culture, slow living, outdoors" },
    { id:"seo",        label:"SEO Gaps",        desc:"High-search, low-competition" },
  ];

  const generate = async () => {
    setLoading(true); setIdeas([]); setError(""); setSaved({});
    try {
      const existingTitles = posts.slice(0, 20).map(p => p.title).join("\n");
      const focusMap = {
        mixed:      "a mix of fly fishing, whiskey/bourbon culture, and lifestyle",
        whiskey:    "whiskey, bourbon, scotch, and spirits — pairings, reviews, culture",
        flyfishing: "fly fishing — technique, gear, destinations, seasonal tips",
        lifestyle:  "outdoor lifestyle, slow living, the culture of fly fishing and whiskey together",
        seo:        "SEO-optimized angles with high search volume and low competition for a fly fishing and whiskey niche blog",
      };

      const promptFocus = mode === "custom" && customTopic.trim()
        ? `the specific topic: "${customTopic.trim()}"`
        : focusMap[focus];

      const text = await callAI(
        activeProvider, activeModel,
        `You are a content strategist for Cask & Stream — a fly fishing and whiskey lifestyle blog. Tagline: "Cast at Dawn. Sip at Dusk." Generate fresh, specific, actionable blog post ideas. Return ONLY valid JSON — no markdown, no fences, no explanation. Format: [{"title":"...","angle":"...","type":"article","notes":"...","outline":["point 1","point 2","point 3"]}] where angle is 1 sentence explaining the unique hook, notes is why this resonates with the audience, outline is 3 talking points. Generate exactly ${ideaCount} ideas.`,
        `Focus: ${promptFocus}\n\nAlready published/drafted (avoid these angles):\n${existingTitles}\n\nGenerate ${ideaCount} fresh, specific content ideas.`,
        apiKeys[activeProvider],
        2000
      );
      const parsed = parseAIJson(text);
      setIdeas(Array.isArray(parsed) ? parsed : []);
    } catch(e) {
      setError(e.message || "Generation failed.");
    }
    setLoading(false);
  };

  const saveIdea = (idea, i) => {
    onAddIdeas({
      id: Date.now() + i,
      title: idea.title,
      source: `AI — ${provider.name}`,
      type: idea.type || "article",
      notes: `${idea.angle}\n\n${idea.notes}`,
    });
    setSaved(s => ({ ...s, [i]: true }));
  };

  const saveAll = () => {
    ideas.forEach((idea, i) => {
      if (!saved[i]) saveIdea(idea, i);
    });
  };

  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>✦ AI Idea Generator</h3>
          <p style={{ fontSize:12, color:"var(--text-secondary)", margin:0 }}>Generate content ideas tailored to Cask & Stream based on what you've already written.</p>
        </div>
      </div>

      <ProviderPicker
        activeProvider={activeProvider}
        activeModel={activeModel}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        keys={apiKeys}
      />

      {/* ── Mode selector ── */}
      <div style={{ display:"flex", gap:6, marginBottom:4 }}>
        <button onClick={() => setMode("custom")}
          style={{ padding:"8px 18px", borderRadius:8, border:`1px solid ${mode==="custom"?"var(--amber)":"var(--border)"}`, background:mode==="custom"?"var(--amber-glow)":"transparent", color:mode==="custom"?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:mode==="custom"?700:400, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
          ✦ Custom Topic
        </button>
        <button onClick={() => setMode("category")}
          style={{ padding:"8px 18px", borderRadius:8, border:`1px solid ${mode==="category"?"var(--amber)":"var(--border)"}`, background:mode==="category"?"var(--amber-glow)":"transparent", color:mode==="category"?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:mode==="category"?700:400, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
          ◈ By Category
        </button>
      </div>

      {/* ── Custom topic input ── */}
      {mode === "custom" && (
        <div style={{ background:"var(--amber-glow)", border:"1px solid var(--amber)44", borderRadius:10, padding:16, display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ fontSize:12, color:"var(--amber)", fontWeight:600 }}>✦ Generate ideas for a specific topic</div>
          <input style={iS} placeholder='e.g. "fly fishing tips and techniques" or "bourbon cocktail recipes for the outdoors" or "best drift boats for beginners"'
            value={customTopic} onChange={e => setCustomTopic(e.target.value)}
            onKeyDown={e => e.key === "Enter" && generate()}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        </div>
      )}

      {/* ── Category focus selector ── */}
      {mode === "category" && (
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Focus Area</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {FOCUSES.map(f => (
              <button key={f.id} onClick={() => setFocus(f.id)}
                style={{ padding:"6px 14px", borderRadius:99, border:focus===f.id?"1px solid var(--amber)":"1px solid var(--border)", background:focus===f.id?"var(--amber-glow)":"transparent", color:focus===f.id?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Count + generate ── */}
      <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:11, color:"var(--muted)" }}>How many:</span>
          {[5, 8, 10, 15].map(n => (
            <button key={n} onClick={() => setIdeaCount(n)}
              style={{ width:32, height:28, borderRadius:6, border:`1px solid ${ideaCount===n?"var(--amber)":"var(--border)"}`, background:ideaCount===n?"var(--amber-glow)":"transparent", color:ideaCount===n?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:ideaCount===n?700:400, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {n}
            </button>
          ))}
        </div>
        <button onClick={generate} disabled={loading || (mode==="custom" && !customTopic.trim())}
          style={{ padding:"10px 24px", borderRadius:8, border:"none", background:loading||(mode==="custom"&&!customTopic.trim())?"var(--bg-elevated)":provider.color, color:loading||(mode==="custom"&&!customTopic.trim())?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:loading||(mode==="custom"&&!customTopic.trim())?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 }}>
          {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Generating {ideaCount} ideas…</> : `${provider.logo} Generate Ideas`}
        </button>
        {ideas.length > 0 && (
          <button onClick={saveAll}
            style={{ padding:"10px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"var(--font-body)" }}>
            Save All to Board
          </button>
        )}
        {error && <span style={{ fontSize:12, color:"var(--red)" }}>{error}</span>}
      </div>

      {/* Ideas list */}
      {ideas.length > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {ideas.map((idea, i) => (
            <div key={i} style={{ display:"flex", gap:12, padding:"14px 16px", borderRadius:10, background:saved[i]?"var(--green)08":"var(--bg-elevated)", border:`1px solid ${saved[i]?"var(--green)44":"var(--border)"}`, alignItems:"flex-start", transition:"all 0.2s" }}>
              <div style={{ width:24, height:24, borderRadius:99, background:"var(--amber)22", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"var(--amber)", flexShrink:0 }}>{i+1}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:600, fontSize:13, marginBottom:4 }}>{idea.title}</div>
                <div style={{ fontSize:12, color:"var(--text-secondary)", marginBottom:4, fontStyle:"italic" }}>{idea.angle}</div>
                {idea.notes && <div style={{ fontSize:11, color:"var(--muted)", marginBottom: idea.outline?.length ? 6 : 0 }}>💡 {idea.notes}</div>}
                {idea.outline?.length > 0 && (
                  <div style={{ display:"flex", flexDirection:"column", gap:2, paddingTop:6, borderTop:"1px solid var(--border)" }}>
                    {idea.outline.map((pt, j) => (
                      <div key={j} style={{ fontSize:11, color:"var(--text-secondary)", display:"flex", gap:6 }}>
                        <span style={{ color:"var(--amber)", flexShrink:0 }}>{j+1}.</span>{pt}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                <button onClick={() => saveIdea(idea, i)} disabled={saved[i]}
                  style={{ padding:"5px 12px", borderRadius:6, border:"none", background:saved[i]?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:saved[i]?"default":"pointer", fontFamily:"var(--font-body)", whiteSpace:"nowrap" }}>
                  {saved[i] ? "✓ Saved" : "+ Board"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── COMPETITOR POST TRACKER ──────────────────────────────────────────────────

const COMP_TRACKER_STORAGE = "bb_comp_tracker";

function loadTrackerData() {
  try { return JSON.parse(localStorage.getItem(COMP_TRACKER_STORAGE) || "{}"); } catch { return {}; }
}
function saveTrackerData(data) {
  try { localStorage.setItem(COMP_TRACKER_STORAGE, JSON.stringify(data)); } catch {} 
}

function CompetitorTracker({ competitors, onAddInspiration, activeProvider, activeModel, apiKeys, dark, onProviderChange, onModelChange }) {
  const [tracking,   setTracking]   = useState(loadTrackerData);
  const [scanning,   setScanning]   = useState(false);
  const [scanTarget, setScanTarget] = useState(null);
  const [error,      setError]      = useState("");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];

  // Scan a competitor's site via AI web search simulation
  const scanCompetitor = async (comp) => {
    setScanTarget(comp.name); setScanning(true); setError("");
    try {
      const response = await fetch("/api/scan-competitor", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name: comp.name, url: comp.url }),
      });

      const text = await response.text();

      // Check if Netlify returned an HTML timeout/error page
      if (text.trimStart().startsWith("<")) {
        throw new Error(`Server timeout — try again in a moment (${response.status})`);
      }

      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error("Invalid response from server — try again"); }

      if (data.error) throw new Error(data.error);

      const posts = Array.isArray(data.posts) ? data.posts : [];

      const updated = {
        ...tracking,
        [comp.name]: {
          posts:     posts.slice(0, 8),
          scannedAt: data.scannedAt || new Date().toISOString(),
          url:       comp.url,
          realData:  true,
        },
      };
      setTracking(updated);
      saveTrackerData(updated);

    } catch(e) {
      setError(`Scan failed for ${comp.name}: ${e.message}`);
    }
    setScanTarget(null); setScanning(false);
  };

  const scanAll = async () => {
    for (const comp of competitors) {
      await scanCompetitor(comp);
    }
  };

  const addToInspiration = (comp, post) => {
    onAddInspiration({
      id: Date.now() + Math.random(),
      title: post.title,
      source: comp,
      type: "article",
      notes: `Counter-opportunity: ${post.opportunity}`,
    });
  };

  const formatScanTime = (iso) => {
    if (!iso) return "Never";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return "Just now";
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs/24)}d ago`;
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>◎ Competitor Post Tracker</h3>
          <p style={{ fontSize:12, color:"var(--text-secondary)", margin:0 }}>Track what competitors are publishing and find counter-opportunities for Cask & Stream.</p>
        </div>
        <button onClick={scanAll} disabled={scanning}
          style={{ padding:"9px 18px", borderRadius:8, border:"none", background:scanning?"var(--bg-elevated)":provider.color, color:scanning?"var(--muted)":"#0e0f11", fontSize:12, fontWeight:700, cursor:scanning?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          {scanning ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Scanning…</> : `${provider.logo} Scan All`}
        </button>
      </div>

      <ProviderPicker
        activeProvider={activeProvider}
        activeModel={activeModel}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        keys={apiKeys}
      />

      {error && <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:6, background:"var(--red)11", border:"1px solid var(--red)33" }}>{error}</div>}

      {/* Competitor cards */}
      {competitors.map(comp => {
        const data = tracking[comp.name];
        const isScanning = scanning && scanTarget === comp.name;
        const threatColor = { high:"var(--red)", medium:"var(--amber)", low:"var(--green)" }[comp.threat] || "var(--muted)";

        return (
          <div key={comp.name} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
            {/* Competitor header */}
            <div style={{ padding:"14px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom: data ? "1px solid var(--border)" : "none" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ width:36, height:36, borderRadius:8, background:threatColor+"18", border:`1px solid ${threatColor}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:threatColor, fontWeight:700 }}>
                  {comp.name[0]}
                </div>
                <div>
                  <div style={{ fontWeight:700, fontSize:14 }}>{comp.name}</div>
                  <div style={{ fontSize:11, color:"var(--text-secondary)" }}>{comp.url} · {comp.posts}</div>
                </div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                {data && (
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                {data.realData && (
                  <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99,
                    background: data.source==="rss" ? "#5cba6c15" : "#7c3aed15",
                    color:      data.source==="rss" ? "#5cba6c"   : "#7c3aed",
                    border:    `1px solid ${data.source==="rss" ? "#5cba6c33" : "#7c3aed33"}`,
                    fontWeight:600 }}>
                    {data.source==="rss" ? "● RSS feed" : "● Web search"}
                  </span>
                )}
                {!data.realData && (
                  <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:"var(--red)11", color:"var(--red)", border:"1px solid var(--red)22" }}>⚠ Estimated</span>
                )}
                <span style={{ fontSize:11, color:"var(--muted)" }}>Scanned {formatScanTime(data.scannedAt)}</span>
              </div>
                )}
                <button onClick={() => scanCompetitor(comp)} disabled={scanning}
                  style={{ padding:"5px 14px", borderRadius:6, border:`1px solid ${threatColor}44`, background:"transparent", color:threatColor, fontSize:11, fontWeight:600, cursor:scanning?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:5 }}>
                  {isScanning ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Searching web…</> : "↻ Scan"}
                </button>
              </div>
            </div>

            {/* Posts */}
            {data?.posts?.length > 0 && (
              <div style={{ padding:"0 0 8px" }}>
                {data.posts.map((post, i) => (
                  <div key={i} style={{ padding:"12px 20px", borderBottom: i < data.posts.length-1 ? "1px solid var(--border)" : "none", display:"flex", gap:12, alignItems:"flex-start" }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600, marginBottom:3 }}>
                        {post.url ? (
                          <a href={post.url} target="_blank" rel="noopener" style={{ color:"var(--text)", textDecoration:"none" }}
                            onMouseEnter={e=>e.target.style.color="var(--amber)"} onMouseLeave={e=>e.target.style.color="var(--text)"}>
                            {post.title} ↗
                          </a>
                        ) : post.title}
                      </div>
                      <div style={{ fontSize:11, color:"var(--text-secondary)", marginBottom:4 }}>{post.date}</div>
                      {post.opportunity && (
                        <div style={{ fontSize:11, color:"var(--amber)", display:"flex", gap:4 }}>
                          <span style={{ flexShrink:0 }}>→</span>
                          <span>{post.opportunity}</span>
                        </div>
                      )}
                    </div>
                    <button onClick={() => addToInspiration(comp.name, post)}
                      style={{ padding:"4px 10px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)", whiteSpace:"nowrap", flexShrink:0 }}>
                      + Board
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!data && !isScanning && (
              <div style={{ padding:"16px 20px", fontSize:12, color:"var(--muted)" }}>
                Not scanned yet — click ↻ Scan to search for their recent posts using live web search.
              </div>
            )}
            {isScanning && (
              <div style={{ padding:"16px 20px", fontSize:12, color:"var(--muted)", display:"flex", alignItems:"center", gap:8 }}>
                <span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>
                Searching the web for recent posts on {comp.name}…
                Analyzing {comp.name} with {provider.name}…
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize:11, color:"var(--muted)", padding:"8px 0", lineHeight:1.6 }}>
        ✦ The tracker uses {provider.name} to analyze competitor content patterns and generate counter-opportunity suggestions. Scan weekly to stay ahead.
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── CONTENT PIPELINE ────────────────────────────────────────────────────────
//
// 5-stage workflow: Brief → Draft → Enhance → Social → Schedule & Publish
//

const PIPELINE_STAGES = [
  { id:"brief",    num:1, label:"Brief",    icon:"◎", desc:"Topic & research"     },
  { id:"draft",    num:2, label:"Draft",    icon:"▤", desc:"Write the post"       },
  { id:"enhance",  num:3, label:"Enhance",  icon:"✦", desc:"SEO + AI polish"      },
  { id:"social",   num:4, label:"Social",   icon:"◈", desc:"Images + captions"    },
  { id:"publish",  num:5, label:"Publish",  icon:"↑", desc:"Schedule & go live"   },
];

function PipelineProgress({ stage, setStage, completed }) {
  return (
    <div style={{ display:"flex", alignItems:"center", marginBottom:28, padding:"20px 28px", background:"var(--bg-surface)", borderRadius:12, border:"1px solid var(--border)" }}>
      {PIPELINE_STAGES.map((s, i) => {
        const isActive    = stage === s.id;
        const isDone      = completed.includes(s.id);
        const isReachable = i === 0 || completed.includes(PIPELINE_STAGES[i-1].id) || isDone || isActive;
        return (
          <div key={s.id} style={{ display:"contents" }}>
            <div onClick={() => isReachable && setStage(s.id)}
              style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:isReachable?"pointer":"default", opacity:isReachable?1:0.4, transition:"opacity 0.2s" }}>
              <div style={{ width:40, height:40, borderRadius:99, display:"flex", alignItems:"center", justifyContent:"center", fontSize:isActive?18:14, fontWeight:700, background:isDone?"var(--green)":isActive?"var(--amber)":"var(--bg-elevated)", border:isDone?"none":isActive?"none":"1px solid var(--border)", color:isDone?"#fff":isActive?"#0e0f11":"var(--muted)", transition:"all 0.3s", boxShadow:isActive?"0 0 20px var(--amber-glow)":"none" }}>
                {isDone ? "✓" : s.icon}
              </div>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:11, fontWeight:isActive?700:500, color:isActive?"var(--amber)":isDone?"var(--green)":"var(--text-secondary)" }}>{s.label}</div>
                <div style={{ fontSize:9, color:"var(--muted)", letterSpacing:"0.04em" }}>{s.desc}</div>
              </div>
            </div>
            {i < PIPELINE_STAGES.length-1 && (
              <div style={{ flex:1, height:2, background:completed.includes(s.id)?"var(--green)":isActive?"var(--amber)33":"var(--border)", margin:"0 12px", marginBottom:24, borderRadius:99, transition:"background 0.4s" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const PIPELINE_STORAGE = "bb_pipeline_draft";

function loadPipelineDraft() {
  try { return JSON.parse(localStorage.getItem(PIPELINE_STORAGE) || "null"); } catch { return null; }
}
function savePipelineDraft(data) {
  try { localStorage.setItem(PIPELINE_STORAGE, JSON.stringify(data)); } catch {}
}
function clearPipelineDraft() {
  try { localStorage.removeItem(PIPELINE_STORAGE); } catch {}
}

function ContentPipeline({ posts, inspiration, competitors, activeProvider, activeModel, apiKeys, dark, wixConnected, onSavePost, onAddInspiration, onAddCalEvent, wsName, wsTagline, onProviderChange, onModelChange, brandGuide = null, initialPost = null, onConsumedInitialPost = null, onSendToSocialPipeline = null }) {
  const brandCtx = buildBrandContext(brandGuide || loadBrandGuide());
  const saved = loadPipelineDraft();
  const [stage,     setStage]    = useState(saved?.stage     || "brief");
  const [completed, setCompleted]= useState(saved?.completed || []);
  const [pipelinePostId, setPipelinePostId] = useState(saved?.pipelinePostId || null); // tracks the original post id when editing an existing article, so re-publishing updates it instead of creating a duplicate
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];

  // Shared pipeline state — restored from localStorage if available
  const [brief, setBrief] = useState(saved?.brief || {
    topic: "", angle: "", audience: "fly fishing and whiskey enthusiasts", keywords: "", inspiration: null,
  });
  const [draft, setDraft] = useState(saved?.draft || {
    title: "", body: "", category: "Culture", tone: "literary",
  });
  const [enhance, setEnhance] = useState(saved?.enhance || {
    metaTitle: "", metaDescription: "", primaryKeyword: "", suggestions: [], headlines: [], improved: "",
  });
  const [linkSuggestions, setLinkSuggestions] = useState({ internal: [], external: [] });
  const [linkSelected,    setLinkSelected]    = useState({});
  const [linkLoading,     setLinkLoading]     = useState({ internal: false, external: false });
  const [linkError,       setLinkError]       = useState("");
  const [linkInserted,    setLinkInserted]    = useState(false);
  const [social, setSocial] = useState(saved?.social || { posts: {}, images: {} });
  const [schedule, setSchedule] = useState(saved?.schedule || {
    publishDate: new Date(Date.now() + 86400000).toISOString().split("T")[0],
    publishTime: "09:00",
    publishToWix: wixConnected,
    addToCalendar: true,
    status: "scheduled",
  });

  const [loading, setLoading]   = useState(false);
  const [loadMsg, setLoadMsg]   = useState("");
  const [error,   setError]     = useState("");
  const [success, setSuccess]   = useState("");
  const [savedAt, setSavedAt]   = useState(saved?.savedAt || null);
  const [saveStatus, setSaveStatus] = useState(""); // "saving" | "saved" | ""
  const autosaveTimer = useRef(null);

  // Debounced auto-save — waits 1.5s after last change before writing
  useEffect(() => {
    if (!brief.topic && !draft.title && !draft.body) return;
    setSaveStatus("saving");
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const data = { stage, completed, brief, draft, enhance, social: { posts: social.posts, images: {} }, schedule, pipelinePostId, savedAt: new Date().toISOString() };
      savePipelineDraft(data);
      setSavedAt(data.savedAt);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(""), 2500);
    }, 1500);
    return () => clearTimeout(autosaveTimer.current);
  }, [stage, completed, brief, draft, enhance, social.posts, schedule, pipelinePostId]);

  // Load an article handed off from the Posts tab ("→ Pipeline" button) — skips
  // straight to the Enhance stage since the brief/draft are already written.
  useEffect(() => {
    if (!initialPost || initialPost.id === pipelinePostId) return;
    const hasUnsavedWork = (brief.topic || draft.title || draft.body) && pipelinePostId !== initialPost.id;
    if (hasUnsavedWork && !window.confirm(`Load "${initialPost.title}" into the Pipeline? This will replace what's currently in progress here (your current work is saved separately and won't be lost, but the Pipeline will switch to this article).`)) {
      if (onConsumedInitialPost) onConsumedInitialPost();
      return;
    }
    setDraft({ title: initialPost.title || "", body: initialPost.body || "", category: initialPost.category || "Culture", tone: "literary", headlineImageUrl: initialPost.headlineImageUrl || "" });
    setBrief(b => ({ ...b, topic: initialPost.title || b.topic }));
    setPipelinePostId(initialPost.id);
    setCompleted(c => [...new Set([...c, "brief", "draft"])]);
    setStage("enhance");
    if (onConsumedInitialPost) onConsumedInitialPost();
  }, [initialPost]);

  const markDone = (id) => setCompleted(c => c.includes(id) ? c : [...c, id]);
  const advanceTo = (next) => { setStage(next); setError(""); setSuccess(""); };

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const btnA = { padding:"10px 24px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8 };
  const btnS = { padding:"10px 20px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" };

  const [promptPreview, setPromptPreview] = useState(null); // { system, user, onConfirm, title, confirmLabel, accentColor }

  // ── STAGE 1: BRIEF ──────────────────────────────────────────────────────────

  const openBriefPromptPreview = () => {
    if (!brief.topic.trim()) return;
    const existingTitles = posts.slice(0,10).map(p=>p.title).join("\n");
    const system = `${brandCtx}You are a writer for Cask & Stream — a fly fishing and whiskey lifestyle blog. Tagline: "${wsTagline}". Write a complete, publication-ready blog post in markdown. Use # for title, ## for sections. Aim for 800+ words. Voice: literary, evocative, specific. Never generic.`;
    const user = `Topic: ${brief.topic}\nAngle: ${brief.angle || "your best judgment"}\nTarget audience: ${brief.audience}\nKeywords to include: ${brief.keywords || "none specified"}\n\nAvoid these already-covered angles:\n${existingTitles}\n\nWrite the full post now.`;
    setPromptPreview({ title:"Review Blog Post Prompt", system, user, confirmLabel:"Generate Draft", accentColor:"var(--amber)", mode:"brief" });
  };

  const generateFromBrief = async (overridePrompt = null) => {
    if (!brief.topic.trim()) return;
    setLoading(true); setLoadMsg("Generating draft from your brief…"); setError(""); setPromptPreview(null);
    try {
      const existingTitles = posts.slice(0,10).map(p=>p.title).join("\n");
      const system = overridePrompt?.system ?? `${brandCtx}You are a writer for Cask & Stream — a fly fishing and whiskey lifestyle blog. Tagline: "${wsTagline}". Write a complete, publication-ready blog post in markdown. Use # for title, ## for sections. Aim for 800+ words. Voice: literary, evocative, specific. Never generic.`;
      const user = overridePrompt?.user ?? `Topic: ${brief.topic}\nAngle: ${brief.angle || "your best judgment"}\nTarget audience: ${brief.audience}\nKeywords to include: ${brief.keywords || "none specified"}\n\nAvoid these already-covered angles:\n${existingTitles}\n\nWrite the full post now.`;
      const text = await callAI(activeProvider, activeModel, system, user, apiKeys[activeProvider], 4000);
      // Extract title from first # line
      const lines  = text.split("\n");
      const titleLine = lines.find(l => l.startsWith("# "));
      const title  = titleLine ? titleLine.slice(2).trim() : brief.topic;
      const body   = text.replace(/^#[^#].*\n/, "").trim();
      setDraft(d => ({ ...d, title, body }));
      markDone("brief");
      advanceTo("draft");
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── STAGE 2: DRAFT ──────────────────────────────────────────────────────────

  const proceedToDraft = () => {
    if (!draft.title.trim() || !draft.body.trim()) return;
    markDone("draft");
    advanceTo("enhance");
  };

  const regenerateDraft = async () => {
    if (!brief.topic.trim()) return;
    setLoading(true); setLoadMsg("Regenerating draft…"); setError("");
    try {
      const text = await callAI(activeProvider, activeModel,
        `${brandCtx}You are a writer for Cask & Stream — a fly fishing and whiskey lifestyle blog. Tagline: "${wsTagline}". Write in markdown. # title, ## sections. 800+ words. Literary, evocative voice.`,
        `Topic: ${brief.topic}\nAngle: ${brief.angle || "your best judgment"}\n\nWrite a fresh version of the full post.`,
        apiKeys[activeProvider],
        4000
      );
      const lines = text.split("\n");
      const titleLine = lines.find(l => l.startsWith("# "));
      const title = titleLine ? titleLine.slice(2).trim() : draft.title;
      const body  = text.replace(/^#[^#].*\n/, "").trim();
      setDraft(d => ({ ...d, title, body }));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── STAGE 3: ENHANCE ────────────────────────────────────────────────────────

  const runEnhancement = async () => {
    setLoading(true); setLoadMsg("Analyzing your post…"); setError("");
    try {
      const brandCtxLocal = buildBrandContext(loadBrandGuide());
      const text = await callAI(activeProvider, activeModel,
        `${brandCtxLocal}You are an SEO expert for Cask & Stream (fly fishing + whiskey lifestyle blog). Return ONLY valid JSON (no fences):
{
  "primaryKeyword": "best target keyword",
  "secondaryKeywords": ["kw1","kw2","kw3"],
  "titles": [
    {"text":"title option 1 (≤60 chars)","score":85,"why":"reason CTR is good","charCount":52},
    {"text":"title option 2 (≤60 chars)","score":78,"why":"reason","charCount":48},
    {"text":"title option 3 (≤60 chars)","score":72,"why":"reason","charCount":55}
  ],
  "descriptions": [
    {"text":"meta description option 1 (≤160 chars)","score":88,"why":"why this converts","charCount":145},
    {"text":"meta description option 2 (≤160 chars)","score":80,"why":"reason","charCount":138},
    {"text":"meta description option 3 (≤160 chars)","score":74,"why":"reason","charCount":152}
  ],
  "readabilityScore": 82,
  "readabilityNotes": "brief note on readability",
  "suggestions": ["actionable tip 1","actionable tip 2","actionable tip 3"],
  "overallScore": 80
}
Titles and descriptions MUST be under their character limits. Score each on: keyword inclusion, CTR potential, length, clarity.`,
        `Title: ${draft.title}\n\nBody excerpt:\n${draft.body.slice(0, 1200)}`,
        apiKeys[activeProvider],
        2000
      );
      const seo = parseAIJson(text);
      // Pick best by default
      const bestTitle = seo.titles?.sort((a,b)=>b.score-a.score)[0]?.text || draft.title;
      const bestDesc  = seo.descriptions?.sort((a,b)=>b.score-a.score)[0]?.text || "";
      setEnhance({
        ...seo,
        metaTitle:       bestTitle,
        metaDescription: bestDesc,
        selectedTitle:   0,
        selectedDesc:    0,
        headlines:       seo.titles?.map(t=>t.text) || [],
      });
      markDone("enhance");
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── LINK FINDER (internal + external links for the draft body) ──────────────
  // Internal: matched against Forest's own known posts — no hallucination risk,
  // since the AI is just pattern-matching against real titles it's given.
  // External: grounded via Anthropic's native web_search tool (server executes
  // the search and returns real URLs) — never asks the model to recall a URL
  // from memory, which is how AI link tools produce dead/hallucinated links.
  const LINK_MAX_BODY_CHARS = 6000;

  const findInternalLinks = async () => {
    setLinkLoading(l => ({ ...l, internal: true })); setLinkError("");
    try {
      const candidates = posts
        .filter(p => p.id !== pipelinePostId && (p.title || "").trim())
        .map(p => ({ id: p.id, title: p.title, category: p.category, hasUrl: !!p.url }));
      if (candidates.length === 0) throw new Error("No other posts to link to yet — write a few more posts first.");

      const text = await callAI(activeProvider, activeModel,
        `You suggest internal links for a blog post. You will get the post's text and a list of the site's OTHER existing posts (title, category, id). Find natural places in the text that would benefit from linking to one of those other posts — ONLY suggest a link when it's genuinely topically relevant, not just because a word matches. Return ONLY valid JSON (no fences): {"links":[{"postId": <id from the list>, "anchorText": "exact short phrase copied VERBATIM from the post text (3-8 words)", "reason": "one short sentence"}]}. Suggest at most 5. anchorText MUST be an exact substring of the post text — do not paraphrase it.`,
        `POST TEXT:\n${draft.body.slice(0, LINK_MAX_BODY_CHARS)}\n\nOTHER POSTS ON THE SITE:\n${JSON.stringify(candidates)}`,
        apiKeys[activeProvider],
        1500
      );
      const parsed = parseAIJson(text);
      const bodyLower = draft.body.toLowerCase();
      const valid = (parsed.links || [])
        .map(l => {
          const post = posts.find(p => p.id === l.postId);
          if (!post) return null;
          if (!l.anchorText || !bodyLower.includes(l.anchorText.toLowerCase())) return null; // reject hallucinated anchors that don't actually appear in the draft
          return { kind: "internal", key: `int-${l.postId}-${l.anchorText}`, anchorText: l.anchorText, url: post.url || "", targetTitle: post.title, reason: l.reason || "" };
        })
        .filter(Boolean);
      setLinkSuggestions(s => ({ ...s, internal: valid }));
      if (valid.length === 0) setLinkError("No confident internal link matches found for this draft.");
    } catch(e) { setLinkError(e.message); }
    setLinkLoading(l => ({ ...l, internal: false }));
  };

  const findExternalLinks = async () => {
    setLinkLoading(l => ({ ...l, external: true })); setLinkError("");
    try {
      const key = apiKeys.anthropic; // web search only available via Anthropic
      const useProxy = !key;
      const endpoint = useProxy ? "/api/claude" : "https://api.anthropic.com/v1/messages";
      const headers = useProxy
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
      const model = activeProvider === "anthropic" ? activeModel : (AI_PROVIDERS.find(p=>p.id==="anthropic")?.defaultModel || "claude-sonnet-5");

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system: `You find real, currently-live, authoritative external sources worth linking to from a blog post — official sites, studies, well-known publications. Use web search to verify each URL is real before suggesting it; never invent a URL. After searching, respond with ONLY valid JSON (no fences, no other text): {"links":[{"anchorText":"exact short phrase copied VERBATIM from the post text (3-8 words)","url":"https://real-verified-url","reason":"one short sentence on why this source is worth citing here"}]}. Suggest at most 4. Only include a link if you actually found and verified a real URL via search.`,
          messages: [{ role: "user", content: `POST TEXT:\n${draft.body.slice(0, LINK_MAX_BODY_CHARS)}` }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          ...(useProxy ? { userId: window.__bbUserId || null } : {}),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || data.error || "Anthropic error");
      const textBlocks = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      const parsed = parseAIJson(textBlocks);
      const bodyLower = draft.body.toLowerCase();
      const valid = (parsed.links || [])
        .map(l => {
          if (!l.anchorText || !l.url || !bodyLower.includes(l.anchorText.toLowerCase())) return null;
          if (!/^https?:\/\//i.test(l.url)) return null;
          let hostname;
          try { hostname = new URL(l.url).hostname.replace(/^www\./,""); } catch { return null; }
          return { kind: "external", key: `ext-${l.url}-${l.anchorText}`, anchorText: l.anchorText, url: l.url, targetTitle: hostname, reason: l.reason || "" };
        })
        .filter(Boolean);
      setLinkSuggestions(s => ({ ...s, external: valid }));
      if (valid.length === 0) setLinkError("No verified external sources found for this draft.");
    } catch(e) { setLinkError(e.message); }
    setLinkLoading(l => ({ ...l, external: false }));
  };

  const insertSelectedLinks = () => {
    const all = [...linkSuggestions.internal, ...linkSuggestions.external].filter(l => linkSelected[l.key]);
    if (all.length === 0) return;
    let body = draft.body;
    for (const l of all) {
      const href = l.url || "PASTE-URL-HERE"; // internal links to unpublished posts get a clear placeholder, never a fake URL
      // Replace only the first occurrence, case-insensitively, preserving the original casing found in the body
      const idx = body.toLowerCase().indexOf(l.anchorText.toLowerCase());
      if (idx === -1) continue;
      const actualText = body.slice(idx, idx + l.anchorText.length);
      body = body.slice(0, idx) + `[${actualText}](${href})` + body.slice(idx + l.anchorText.length);
    }
    setDraft(d => ({ ...d, body }));
    setLinkSuggestions({ internal: [], external: [] });
    setLinkSelected({});
    setLinkInserted(true);
    setTimeout(() => setLinkInserted(false), 3000);
  };

  // ── STAGE 4: SOCIAL ─────────────────────────────────────────────────────────

  const generateSocialPosts = async () => {
    setLoading(true); setError("");
    const targets = SOCIAL_PLATFORMS;
    const results = {};
    try {
      for (const plat of targets) {
        setLoadMsg(`Writing ${plat.name} post…`);
        const system = `${brandCtx}You are a social media manager for Cask & Stream. Tagline: "${wsTagline}". Voice: ${plat.tone}. Format: ${plat.format}. ${plat.urlNote}. Write ONLY the post content.`;
        results[plat.id] = await callAI(activeProvider, activeModel, system,
          `Write a ${plat.name} post based on this blog post:\nTitle: ${draft.title}\n\n${draft.body.slice(0,800)}`,
          apiKeys[activeProvider]
        );
      }
      setSocial(s => ({ ...s, posts: results }));
      markDone("social");
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  const generateSocialImage = async (platId) => {
    const provider = getImageProvider(apiKeys);
    if (!provider) { setError("Add a Stability AI, OpenAI, or Gemini key in Settings → API Keys for image generation."); return; }
    setLoading(true); setLoadMsg(`Generating ${platId} image via ${getImageProviderLabel(provider)}…`); setError("");
    try {
      const prompt = await generateImagePrompt(draft.topic || brief.topic || draft.title, platId, activeProvider, activeModel, apiKeys[activeProvider]);
      const url = await generateImage(prompt, platId, apiKeys);
      setSocial(s => ({ ...s, images: { ...s.images, [platId]: url } }));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── STAGE 5: PUBLISH ────────────────────────────────────────────────────────

  const handlePublish = async () => {
    setLoading(true); setLoadMsg("Publishing…"); setError(""); setSuccess("");
    try {
      const finalPost = {
        id: pipelinePostId || Date.now(),
        title: enhance.metaTitle || draft.title,
        body: draft.body,
        category: draft.category,
        status: schedule.status,
        date: schedule.publishDate,
        views: 0,
        metaTitle: enhance.metaTitle,
        metaDescription: enhance.metaDescription,
        primaryKeyword: enhance.primaryKeyword,
        url: posts.find(p => p.id === pipelinePostId)?.url || "",
        headlineImageUrl: draft.headlineImageUrl || posts.find(p => p.id === pipelinePostId)?.headlineImageUrl || "",
      };

      // Save to Blog Bunker
      onSavePost(finalPost);

      // Add to calendar
      if (schedule.addToCalendar) {
        const day = new Date(schedule.publishDate).getDate();
        onAddCalEvent({ title: finalPost.title, type: schedule.status === "published" ? "scheduled" : "draft", day });
      }

      // Push to Wix via Velo HTTP function
      if (schedule.publishToWix && wixConnected) {
        setLoadMsg("Publishing to Wix via Velo…");
        const wixCfg = loadWixConfig();
        const result = await wixVeloPush(finalPost, schedule.status === "published", wixCfg);
        if (result.postId) { finalPost.wixId = result.postId; finalPost.fromWix = true; }
      }

      markDone("publish");
      clearPipelineDraft();
      setSuccess(`✓ Post ${schedule.status === "published" ? "published" : "scheduled"} successfully!${schedule.publishToWix && wixConnected ? " Live on caskandstream.com." : ""}`);
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  const resetPipeline = () => {
    clearPipelineDraft();
    setStage("brief"); setCompleted([]); setError(""); setSuccess(""); setSavedAt(null);
    setBrief({ topic:"", angle:"", audience:"fly fishing and whiskey enthusiasts", keywords:"", inspiration:null });
    setDraft({ title:"", body:"", category:"Culture", tone:"literary" });
    setEnhance({ metaTitle:"", metaDescription:"", primaryKeyword:"", suggestions:[], headlines:[], improved:"" });
    setSocial({ posts:{}, images:{} });
  };

  // ── RENDER ──────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, margin:"0 0 4px" }}>Content Pipeline</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>
            From idea to published — one seamless workflow.
            {savedAt && <span style={{ color:"var(--green)", marginLeft:8, fontSize:11 }}>✓ Draft auto-saved {new Date(savedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>}
          </p>
        </div>
        {(completed.length > 0 || brief.topic) && (
          <button onClick={resetPipeline} style={{ padding:"9px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>↺ New Post</button>
        )}
      </div>

      {/* Provider picker */}
      <ProviderPicker
        activeProvider={activeProvider}
        activeModel={activeModel}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        keys={apiKeys}
      />

      {/* Progress */}
      <PipelineProgress stage={stage} setStage={setStage} completed={completed} />

      {/* Error / Success */}
      {error   && <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:13 }}>{error}</div>}
      {success && <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:8, background:"#5cba6c11", border:"1px solid #5cba6c33", color:"#5cba6c", fontSize:13 }}>{success}</div>}

      {/* Loading overlay */}
      {loading && (
        <div style={{ marginBottom:16, padding:"12px 16px", borderRadius:8, background:"var(--amber-glow)", border:"1px solid var(--amber)44", display:"flex", alignItems:"center", gap:10, fontSize:13, color:"var(--amber)" }}>
          <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
          {loadMsg || "Working…"}
        </div>
      )}

      {/* ── STAGE 1: BRIEF ── */}
      {stage === "brief" && (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
            <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:"0 0 16px" }}>What are you writing about?</h3>
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Topic or Title *</label>
                <input style={iS} placeholder="e.g. Best bourbon to sip after a day of dry fly fishing on the Madison…" value={brief.topic} onChange={e=>setBrief(b=>({...b,topic:e.target.value}))} autoFocus
                  onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
              </div>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Unique Angle (optional)</label>
                <input style={iS} placeholder="e.g. Focus on sherried scotch that complement the taste of river water…" value={brief.angle} onChange={e=>setBrief(b=>({...b,angle:e.target.value}))}
                  onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <div>
                  <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Target Audience</label>
                  <input style={iS} value={brief.audience} onChange={e=>setBrief(b=>({...b,audience:e.target.value}))}
                    onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                </div>
                <div>
                  <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Target Keywords</label>
                  <input style={iS} placeholder="whiskey fly fishing pairing, bourbon outdoors…" value={brief.keywords} onChange={e=>setBrief(b=>({...b,keywords:e.target.value}))}
                    onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                </div>
              </div>
            </div>
          </div>

          {/* Quick inspiration from board */}
          {inspiration.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>Use from Inspiration Board</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:280, overflow:"auto" }}>
                {inspiration.length === 0 && (
                  <div style={{ fontSize:12, color:"var(--muted)", padding:"8px 0" }}>No inspiration saved yet — use the Research tab to add ideas.</div>
                )}
                {inspiration.map(item => (
                  <button key={item.id} onClick={() => setBrief(b => ({ ...b, topic:item.title, angle:item.notes||"", inspiration:item }))}
                    style={{ padding:"8px 12px", borderRadius:8, border:brief.inspiration?.id===item.id?"1px solid var(--amber)":"1px solid var(--border)", background:brief.inspiration?.id===item.id?"var(--amber-glow)":"var(--bg-elevated)", color:"var(--text)", fontSize:12, cursor:"pointer", textAlign:"left", fontFamily:"'DM Sans',sans-serif" }}>
                    <span style={{ fontWeight:600 }}>{item.title}</span>
                    {item.notes && <span style={{ color:"var(--text-secondary)", marginLeft:8 }}>— {item.notes.slice(0,60)}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={openBriefPromptPreview} disabled={!brief.topic.trim() || loading} style={{ ...btnA, background:brief.topic.trim()&&!loading?provider.color:"var(--bg-elevated)", color:brief.topic.trim()&&!loading?"#0e0f11":"var(--muted)", cursor:brief.topic.trim()&&!loading?"pointer":"not-allowed" }}>
              {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Writing…</> : <>{provider.logo} Generate Draft</>}
            </button>
            <button onClick={() => { markDone("brief"); advanceTo("draft"); }} style={btnS}>Write Manually →</button>
          </div>
        </div>
      )}

      {/* ── STAGE 2: DRAFT ── */}
      {stage === "draft" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
              <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:0 }}>Your Draft</h3>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                {/* Autosave indicator */}
                {saveStatus === "saving" && (
                  <span style={{ fontSize:11, color:"var(--muted)", display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>Saving…
                  </span>
                )}
                {saveStatus === "saved" && (
                  <span style={{ fontSize:11, color:"#5cba6c", display:"flex", alignItems:"center", gap:4 }}>
                    ✓ Saved
                  </span>
                )}
                {!saveStatus && savedAt && (
                  <span style={{ fontSize:11, color:"var(--muted)" }}>
                    Saved {new Date(savedAt).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
                  </span>
                )}
                <span style={{ fontSize:11, color:"var(--muted)" }}>{draft.body.split(" ").filter(Boolean).length} words</span>
                <button onClick={regenerateDraft} disabled={loading} style={{ padding:"5px 12px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                  ↻ Regenerate
                </button>
              </div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Title</label>
              <input style={iS} value={draft.title} onChange={e=>setDraft(d=>({...d,title:e.target.value}))}
                onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Category</label>
                <select style={{ ...iS, cursor:"pointer" }} value={draft.category} onChange={e=>setDraft(d=>({...d,category:e.target.value}))}>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Tone</label>
                <select style={{ ...iS, cursor:"pointer" }} value={draft.tone} onChange={e=>setDraft(d=>({...d,tone:e.target.value}))}>
                  {["literary","informative","conversational","humorous"].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
                Body
              </label>
              <RichTextEditor value={draft.body} onChange={(md)=>setDraft(d=>({...d,body:md}))} minHeight={380} activeProvider={activeProvider} activeModel={activeModel} apiKeys={apiKeys} />
            </div>
          </div>

          {/* Link Finder — shown once the initial article is written */}
          {draft.body.trim().length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:4 }}>
                🔗 Link Finder
              </div>
              <p style={{ fontSize:12, color:"var(--text-secondary)", margin:"0 0 14px", lineHeight:1.6 }}>
                Nothing gets inserted automatically — review and pick which links to add. Links you insert here carry through the rest of the Pipeline into the final copyable post.
              </p>
              <div style={{ display:"flex", gap:8, marginBottom:14 }}>
                <button onClick={findInternalLinks} disabled={linkLoading.internal} style={{ ...btnS, fontSize:11 }}>
                  {linkLoading.internal ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span> Searching your posts…</> : "🔗 Find Internal Links"}
                </button>
                <button onClick={findExternalLinks} disabled={linkLoading.external} style={{ ...btnS, fontSize:11 }}>
                  {linkLoading.external ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span> Searching the web…</> : "🌐 Find External Links"}
                </button>
              </div>

              {linkError && <div style={{ fontSize:12, color:"var(--red)", marginBottom:10 }}>{linkError}</div>}
              {linkInserted && <div style={{ fontSize:12, color:"#5cba6c", marginBottom:10 }}>✓ Links inserted into the draft body.</div>}

              {[...linkSuggestions.internal, ...linkSuggestions.external].length > 0 && (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {[...linkSuggestions.internal, ...linkSuggestions.external].map(l => (
                    <label key={l.key} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", cursor:"pointer" }}>
                      <input type="checkbox" checked={!!linkSelected[l.key]} onChange={e=>setLinkSelected(s=>({...s,[l.key]:e.target.checked}))} style={{ marginTop:3 }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, color:"var(--text)" }}>
                          <span style={{ fontWeight:700 }}>"{l.anchorText}"</span> → {l.targetTitle}
                          <span style={{ marginLeft:6, fontSize:10, padding:"1px 6px", borderRadius:99, background:l.kind==="internal"?"#7c9ce022":"#5cba6c22", color:l.kind==="internal"?"#7c9ce0":"#5cba6c" }}>{l.kind === "internal" ? "internal" : "external"}</span>
                        </div>
                        <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:2 }}>{l.reason}</div>
                        {l.kind === "internal" && !l.url && (
                          <div style={{ fontSize:11, color:"var(--amber)", marginTop:3 }}>⚠ That post has no recorded URL yet — this will insert a placeholder link for you to fill in later.</div>
                        )}
                        {l.url && <div style={{ fontSize:11, color:"var(--muted)", marginTop:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{l.url}</div>}
                      </div>
                    </label>
                  ))}
                  <button onClick={insertSelectedLinks} disabled={![...linkSuggestions.internal, ...linkSuggestions.external].some(l=>linkSelected[l.key])}
                    style={{ ...btnA, alignSelf:"flex-start", fontSize:12, padding:"8px 16px" }}>
                    Insert Selected Links
                  </button>
                </div>
              )}
            </div>
          )}

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={proceedToDraft} disabled={!draft.title.trim()||!draft.body.trim()} style={{ ...btnA, background:draft.title.trim()&&draft.body.trim()?"var(--amber)":"var(--bg-elevated)", color:draft.title.trim()&&draft.body.trim()?"#0e0f11":"var(--muted)", cursor:draft.title.trim()&&draft.body.trim()?"pointer":"not-allowed" }}>
              Continue to Enhance →
            </button>
            <button onClick={() => setStage("brief")} style={btnS}>← Back to Brief</button>
          </div>

          {draft.title && (
            <HeadlineImagePanel
              title={draft.title}
              body={draft.body}
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
              onImageSaved={(url) => setDraft(d => ({ ...d, headlineImageUrl: url }))}
              existingImageUrl={draft.headlineImageUrl || null}
            />
          )}
        </div>
      )}

      {/* ── STAGE 3: ENHANCE ── */}
      {stage === "enhance" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {!enhance.titles ? (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:32, textAlign:"center" }}>
              <div style={{ fontSize:32, marginBottom:12 }}>✦</div>
              <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, marginBottom:8 }}>SEO Enhance</h3>
              <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:8, maxWidth:440, margin:"0 auto 8px", lineHeight:1.7 }}>
                AI generates <strong>3 title options</strong> and <strong>3 meta descriptions</strong>, each scored and explained so you can pick the best one. Plus a live Google preview.
              </p>
              <p style={{ fontSize:12, color:"var(--muted)", marginBottom:24 }}>One click — takes about 10 seconds.</p>
              <button onClick={runEnhancement} disabled={loading} style={btnA}>
                {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : `${provider.logo} Run SEO Enhance`}
              </button>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

              {/* Overall score + keyword */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
                {[
                  { label:"Overall SEO Score", value:`${enhance.overallScore}/100`, color: enhance.overallScore>=80?"#5cba6c":enhance.overallScore>=60?"var(--amber)":"var(--red)" },
                  { label:"Readability Score",  value:`${enhance.readabilityScore}/100`, color:"#7c3aed" },
                  { label:"Primary Keyword",   value:enhance.primaryKeyword, color:"var(--amber)" },
                ].map(s => (
                  <div key={s.label} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:10, padding:"14px 16px" }}>
                    <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>{s.label}</div>
                    <div style={{ fontSize:20, fontWeight:700, color:s.color }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Title options */}
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>
                  Title Options — pick one (Google shows ~60 chars)
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {(enhance.titles || []).map((t, i) => {
                    const selected = enhance.selectedTitle === i;
                    const over = t.charCount > 60 || t.text?.length > 60;
                    const score = t.score || 0;
                    const scoreColor = score >= 80 ? "#5cba6c" : score >= 65 ? "var(--amber)" : "var(--red)";
                    return (
                      <div key={i} onClick={() => setEnhance(e => ({ ...e, selectedTitle:i, metaTitle:t.text }))}
                        style={{ padding:"12px 14px", borderRadius:9, border:`2px solid ${selected?"var(--amber)":"var(--border)"}`, background:selected?"var(--amber-glow)":"var(--bg-elevated)", cursor:"pointer", transition:"all 0.15s" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:13, fontWeight:selected?700:400, color:"var(--text)", marginBottom:4, lineHeight:1.4 }}>{t.text}</div>
                            <div style={{ fontSize:11, color:"var(--text-secondary)", lineHeight:1.5 }}>💡 {t.why}</div>
                          </div>
                          <div style={{ display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
                            <span style={{ fontSize:10, color:over?"var(--red)":"var(--muted)" }}>{t.text?.length || t.charCount}/60</span>
                            <span style={{ fontSize:12, fontWeight:700, color:scoreColor, padding:"2px 8px", borderRadius:6, background:scoreColor+"15" }}>{score}</span>
                            {selected && <span style={{ fontSize:10, fontWeight:700, color:"var(--amber)" }}>✓ Selected</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Editable selected title */}
                <div style={{ marginTop:12 }}>
                  <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:5 }}>Edit selected title</label>
                  <input value={enhance.metaTitle || ""} onChange={e => setEnhance(en => ({ ...en, metaTitle:e.target.value }))}
                    style={{ ...iS, fontSize:13 }}
                    onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                  <div style={{ fontSize:10, color:enhance.metaTitle?.length>60?"var(--red)":"var(--muted)", marginTop:3, textAlign:"right" }}>
                    {enhance.metaTitle?.length || 0}/60 chars {enhance.metaTitle?.length>60?"— too long, Google will cut it off":""}
                  </div>
                </div>
              </div>

              {/* Description options */}
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>
                  Meta Description Options — pick one (Google shows ~160 chars)
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {(enhance.descriptions || []).map((d, i) => {
                    const selected = enhance.selectedDesc === i;
                    const over = d.charCount > 160 || d.text?.length > 160;
                    const score = d.score || 0;
                    const scoreColor = score >= 80 ? "#5cba6c" : score >= 65 ? "var(--amber)" : "var(--red)";
                    return (
                      <div key={i} onClick={() => setEnhance(e => ({ ...e, selectedDesc:i, metaDescription:d.text }))}
                        style={{ padding:"12px 14px", borderRadius:9, border:`2px solid ${selected?"var(--amber)":"var(--border)"}`, background:selected?"var(--amber-glow)":"var(--bg-elevated)", cursor:"pointer", transition:"all 0.15s" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:12, color:"var(--text)", marginBottom:4, lineHeight:1.5 }}>{d.text}</div>
                            <div style={{ fontSize:11, color:"var(--text-secondary)" }}>💡 {d.why}</div>
                          </div>
                          <div style={{ display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
                            <span style={{ fontSize:10, color:over?"var(--red)":"var(--muted)" }}>{d.text?.length || d.charCount}/160</span>
                            <span style={{ fontSize:12, fontWeight:700, color:scoreColor, padding:"2px 8px", borderRadius:6, background:scoreColor+"15" }}>{score}</span>
                            {selected && <span style={{ fontSize:10, fontWeight:700, color:"var(--amber)" }}>✓ Selected</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop:12 }}>
                  <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:5 }}>Edit selected description</label>
                  <textarea value={enhance.metaDescription || ""} onChange={e => setEnhance(en => ({ ...en, metaDescription:e.target.value }))}
                    rows={2} style={{ ...iS, resize:"none", fontSize:12, lineHeight:1.5 }}
                    onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                  <div style={{ fontSize:10, color:enhance.metaDescription?.length>160?"var(--red)":"var(--muted)", marginTop:3, textAlign:"right" }}>
                    {enhance.metaDescription?.length || 0}/160 chars {enhance.metaDescription?.length>160?"— too long":""}
                  </div>
                </div>
              </div>

              {/* Live SERP Preview */}
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>
                  🔍 Google Search Preview
                </div>
                <div style={{ background:"#fff", borderRadius:8, padding:"16px 20px", fontFamily:"Arial, sans-serif" }}>
                  <div style={{ fontSize:12, color:"#202124", marginBottom:2, opacity:0.6 }}>
                    caskandstream.com › blog
                  </div>
                  <div style={{ fontSize:18, color:"#1a0dab", marginBottom:4, lineHeight:1.3, fontWeight:400, maxWidth:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {enhance.metaTitle || draft.title}
                  </div>
                  <div style={{ fontSize:13, color:"#4d5156", lineHeight:1.6, maxWidth:600 }}>
                    {(enhance.metaDescription || "").slice(0,160)}{enhance.metaDescription?.length > 160 ? "…" : ""}
                  </div>
                </div>
                <div style={{ marginTop:8, fontSize:11, color:"var(--muted)" }}>
                  This is exactly how your post appears in Google results. The title {enhance.metaTitle?.length > 60 ? "⚠ is too long and will be cut off" : "✓ fits"} · The description {enhance.metaDescription?.length > 160 ? "⚠ is too long and will be cut off" : "✓ fits"}.
                </div>
              </div>

              {/* Secondary keywords + suggestions */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                {enhance.secondaryKeywords?.length > 0 && (
                  <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:10, padding:16 }}>
                    <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Secondary Keywords</div>
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      {enhance.secondaryKeywords.map((k,i) => (
                        <span key={i} style={{ padding:"3px 10px", borderRadius:99, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:11, color:"var(--text-secondary)" }}>{k}</span>
                      ))}
                    </div>
                  </div>
                )}
                {enhance.suggestions?.length > 0 && (
                  <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:10, padding:16 }}>
                    <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Quick Tips</div>
                    {enhance.suggestions.map((s,i) => (
                      <div key={i} style={{ fontSize:12, color:"var(--text-secondary)", padding:"3px 0", display:"flex", gap:6 }}>
                        <span style={{ color:"var(--amber)", flexShrink:0 }}>→</span>{s}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button onClick={runEnhancement} disabled={loading}
                style={{ ...btnS, fontSize:11, padding:"6px 14px", alignSelf:"flex-start" }}>
                ↻ Re-run Analysis
              </button>
            </div>
          )}

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={()=>{ markDone("enhance"); advanceTo("social"); }} disabled={!enhance.metaTitle}
              style={{ ...btnA, background:enhance.metaTitle?"var(--amber)":"var(--bg-elevated)", color:enhance.metaTitle?"#0e0f11":"var(--muted)", cursor:enhance.metaTitle?"pointer":"not-allowed" }}>
              Continue to Social →
            </button>
            <button onClick={()=>setStage("draft")} style={btnS}>← Back to Draft</button>
          </div>
        </div>
      )}

      {/* ── STAGE 4: SOCIAL ── */}
      {stage === "social" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <div style={{ background:"var(--amber-glow)", border:"1px solid var(--amber)", borderRadius:12, padding:20 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, flexWrap:"wrap" }}>
              <div>
                <h3 style={{ fontFamily:"var(--font-display)", fontSize:16, fontWeight:700, margin:"0 0 4px", color:"var(--amber)" }}>🔗 Use the Social Pipeline</h3>
                <p style={{ fontSize:12, color:"var(--text-secondary)", margin:0, maxWidth:520 }}>
                  For hashtags, per-platform character checks, best-posting-times, and scheduling/publishing, send this article to the full Social Pipeline. The quick generator below is still here for a fast one-off caption.
                </p>
              </div>
              <button onClick={() => onSendToSocialPipeline && onSendToSocialPipeline({ title: draft.title, body: draft.body, headlineImageUrl: draft.headlineImageUrl })}
                disabled={!draft.title.trim()}
                style={{ padding:"10px 20px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:draft.title.trim()?"pointer":"not-allowed", fontFamily:"var(--font-body)", whiteSpace:"nowrap", opacity:draft.title.trim()?1:0.5 }}>
                → Send to Social Pipeline
              </button>
            </div>
          </div>

          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
              <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:0 }}>Quick Social Posts</h3>
              <button onClick={generateSocialPosts} disabled={loading} style={{ ...btnA, padding:"8px 18px", fontSize:12, background:loading?"var(--bg-elevated)":provider.color, color:loading?"var(--muted)":"#0e0f11", cursor:loading?"not-allowed":"pointer" }}>
                {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : `${provider.logo} Generate All Platforms`}
              </button>
            </div>

            {Object.keys(social.posts).length === 0 ? (
              <div style={{ textAlign:"center", padding:"32px 0", color:"var(--muted)", fontSize:13 }}>
                Click "Generate All Platforms" to create platform-specific posts from your draft.
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                {SOCIAL_PLATFORMS.map(plat => social.posts[plat.id] && (
                  <div key={plat.id} style={{ borderRadius:10, border:`1px solid ${plat.color}33`, overflow:"hidden" }}>
                    <div style={{ padding:"10px 16px", background:plat.color+"12", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ fontSize:18 }}>{plat.icon}</span>
                        <span style={{ fontWeight:700, fontSize:13, color:plat.color }}>{plat.name}</span>
                        <span style={{ fontSize:10, color:"var(--muted)" }}>{social.posts[plat.id].length}/{plat.charLimit < 40000 ? plat.charLimit : "∞"} chars</span>
                      </div>
                      <div style={{ display:"flex", gap:6 }}>
                        {plat.id !== "reddit" && (
                          <button onClick={()=>generateSocialImage(plat.id)} disabled={loading}
                            style={{ padding:"4px 10px", borderRadius:6, border:"1px solid #7c3aed44", background:"transparent", color:"#a78bfa", fontSize:11, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                            {social.images[plat.id] ? "↻ New Image" : "▣ Generate Image"}
                          </button>
                        )}
                        <button onClick={()=>navigator.clipboard.writeText(social.posts[plat.id])}
                          style={{ padding:"4px 10px", borderRadius:6, border:"none", background:plat.color, color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                          Copy
                        </button>
                      </div>
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:social.images[plat.id]?"1fr 1fr":"1fr" }}>
                      <textarea value={social.posts[plat.id]} onChange={e=>setSocial(s=>({...s,posts:{...s.posts,[plat.id]:e.target.value}}))} rows={5}
                        style={{ padding:14, border:"none", borderRight:social.images[plat.id]?"1px solid var(--border)":"none", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"'DM Sans',sans-serif", outline:"none", resize:"none", lineHeight:1.6 }} />
                      {social.images[plat.id] && (
                        <div style={{ position:"relative" }}>
                          <img src={social.images[plat.id]} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
                          <button onClick={()=>{ const a=document.createElement("a"); a.href=social.images[plat.id]; a.download=`cask-stream-${plat.id}.jpg`; a.click(); }}
                            style={{ position:"absolute", bottom:8, right:8, padding:"4px 10px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.7)", color:"#fff", fontSize:11, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                            ↓ Download
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={()=>{ markDone("social"); advanceTo("publish"); }} style={btnA}>Continue to Publish →</button>
            <button onClick={()=>setStage("enhance")} style={btnS}>← Back to Enhance</button>
          </div>
        </div>
      )}

      {/* ── STAGE 5: PUBLISH ── */}
      {stage === "publish" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {success ? (
            <div style={{ background:"var(--bg-surface)", border:"1px solid #5cba6c44", borderRadius:12, padding:40, textAlign:"center" }}>
              <div style={{ fontSize:48, marginBottom:16 }}>✓</div>
              <h3 style={{ fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, marginBottom:8 }}>Post Published!</h3>
              <p style={{ fontSize:14, color:"var(--text-secondary)", marginBottom:24 }}>{success}</p>
              <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
                <button onClick={resetPipeline} style={btnA}>Start New Post</button>
                <button onClick={()=>{ resetPipeline(); /* navigate to posts — handled by parent */; document.querySelector('[data-tab="posts"]')?.click(); }} style={btnS}>View in Posts →</button>
                <button onClick={()=>setStage("draft")} style={btnS}>Back to Draft</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
                <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:"0 0 20px" }}>Schedule & Publish</h3>

                {/* Summary */}
                <div style={{ padding:16, borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)", marginBottom:20 }}>
                  <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Post Summary</div>
                  <div style={{ fontFamily:"var(--font-display)", fontSize:16, fontWeight:700, marginBottom:4 }}>{enhance.metaTitle || draft.title}</div>
                  <div style={{ fontSize:12, color:"var(--text-secondary)", marginBottom:8 }}>{enhance.metaDescription}</div>
                  <div style={{ display:"flex", gap:12, fontSize:11, color:"var(--muted)" }}>
                    <span>◈ {draft.category}</span>
                    <span>▤ {draft.body.split(" ").filter(Boolean).length} words</span>
                    {enhance.primaryKeyword && <span>🔑 {enhance.primaryKeyword}</span>}
                    {Object.keys(social.posts).length > 0 && <span>◈ {Object.keys(social.posts).length} social posts ready</span>}
                  </div>
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:20 }}>
                  <div>
                    <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Publish Date</label>
                    <input type="date" style={iS} value={schedule.publishDate} onChange={e=>setSchedule(s=>({...s,publishDate:e.target.value}))} />
                  </div>
                  <div>
                    <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Publish Time</label>
                    <input type="time" style={iS} value={schedule.publishTime} onChange={e=>setSchedule(s=>({...s,publishTime:e.target.value}))} />
                  </div>
                </div>

                <div style={{ marginBottom:20 }}>
                  <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Status</label>
                  <div style={{ display:"flex", gap:8 }}>
                    {["published","draft","scheduled"].map(s=>(
                      <button key={s} onClick={()=>setSchedule(sc=>({...sc,status:s}))}
                        style={{ padding:"7px 16px", borderRadius:8, border:schedule.status===s?"1px solid var(--amber)":"1px solid var(--border)", background:schedule.status===s?"var(--amber-glow)":"transparent", color:schedule.status===s?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", textTransform:"capitalize" }}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {[
                    { key:"addToCalendar", label:"Add to Blog Bunker calendar", always:true },
                  ].map(opt=>(
                    <label key={opt.key} style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer" }}>
                      <div onClick={()=>setSchedule(s=>({...s,[opt.key]:!s[opt.key]}))}
                        style={{ width:20, height:20, borderRadius:5, border:`2px solid ${schedule[opt.key]?"var(--amber)":"var(--border)"}`, background:schedule[opt.key]?"var(--amber)":"transparent", display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.2s", flexShrink:0 }}>
                        {schedule[opt.key]&&<span style={{ fontSize:12, color:"#0e0f11", fontWeight:700 }}>✓</span>}
                      </div>
                      <span style={{ fontSize:13 }}>{opt.label}</span>
                    </label>
                  ))}

                  <div style={{ padding:"14px 16px", borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                    <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>
                      📋 Copy for Your Blog
                    </div>
                    <p style={{ fontSize:12, color:"var(--text-secondary)", margin:"0 0 10px", lineHeight:1.6 }}>
                      Copies with formatting and links intact, then paste it into whichever blog host you publish on. The post is automatically saved to your Posts tab.
                    </p>
                    <div style={{ display:"flex", gap:8 }}>
                      <button onClick={() => {
                        // Auto-save to Posts tab first
                        const finalPost = {
                          id: pipelinePostId || Date.now(),
                          title: enhance.metaTitle || draft.title,
                          body: draft.body,
                          category: draft.category,
                          status: schedule.status || "draft",
                          date: schedule.publishDate || new Date().toISOString().split("T")[0],
                          views: 0,
                          metaTitle: enhance.metaTitle,
                          metaDescription: enhance.metaDescription,
                          primaryKeyword: enhance.primaryKeyword,
                          url: posts.find(p => p.id === pipelinePostId)?.url || "",
                          headlineImageUrl: draft.headlineImageUrl || posts.find(p => p.id === pipelinePostId)?.headlineImageUrl || "",
                        };
                        onSavePost(finalPost);
                        if (schedule.addToCalendar) {
                          const day = new Date(finalPost.date).getDate();
                          onAddCalEvent({ title: finalPost.title, type: finalPost.status, day });
                        }
                        markDone("publish");
                        // Copy with links preserved — rich HTML for editors that accept
                        // it (real clickable hyperlinks), plain text with visible (url)
                        // fallback otherwise. Previously this stripped links to bare text,
                        // silently discarding the URL entirely.
                        copyPostWithLinks(enhance.metaTitle || draft.title, draft.body, draft.headlineImageUrl);
                        setSuccess(`✓ Copied! Post saved to Posts tab as "${finalPost.status}".`);
                      }}
                        style={{ padding:"8px 16px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                        📋 Copy Post Text
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display:"flex", gap:10 }}>
                <button onClick={handlePublish} disabled={loading} style={{ ...btnA, background:loading?"var(--bg-elevated)":"#5cba6c", color:loading?"var(--muted)":"#fff", cursor:loading?"not-allowed":"pointer" }}>
                  {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : schedule.status==="published" ? "↑ Publish Now" : schedule.status==="draft" ? "Save as Draft" : "Schedule Post"}
                </button>
                <button onClick={()=>setStage("social")} style={btnS}>← Back to Social</button>
              </div>
            </>
          )}
        </div>
      )}

      {promptPreview && (
        <PromptPreviewModal
          title={promptPreview.title}
          systemPrompt={promptPreview.system}
          userPrompt={promptPreview.user}
          onSystemChange={(v) => setPromptPreview(p => ({ ...p, system: v }))}
          onUserChange={(v) => setPromptPreview(p => ({ ...p, user: v }))}
          confirmLabel={promptPreview.confirmLabel}
          accentColor={promptPreview.accentColor}
          onCancel={() => setPromptPreview(null)}
          onConfirm={() => generateFromBrief({ system: promptPreview.system, user: promptPreview.user })}
        />
      )}
    </div>
  );
}

// ─── CALENDAR TAB ─────────────────────────────────────────────────────────────

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function CalendarTab({ calEvents, deleteCalEvent, setCalModalDay, setCalModalOpen, btnP, fixedGreen }) {
  const today = new Date();
  const [calYear,  setCalYear]  = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());

  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  const firstDow    = new Date(calYear, calMonth, 1).getDay();
  const isToday     = (d) => d===today.getDate() && calMonth===today.getMonth() && calYear===today.getFullYear();

  const prevMonth = () => calMonth===0 ? (setCalMonth(11), setCalYear(y=>y-1)) : setCalMonth(m=>m-1);
  const nextMonth = () => calMonth===11 ? (setCalMonth(0), setCalYear(y=>y+1)) : setCalMonth(m=>m+1);
  const goToday   = () => { setCalMonth(today.getMonth()); setCalYear(today.getFullYear()); };

  const monthEvs = (day) => calEvents.filter(e =>
    e.day === day && (e.month === undefined || (e.month === calMonth && e.year === calYear))
  );

  const tc = { scheduled:"var(--amber)", newsletter:fixedGreen, draft:"var(--muted)", idea:"var(--text-secondary)" };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button onClick={prevMonth} style={{width:32,height:32,borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>‹</button>
          <h2 style={{fontFamily:"'Fraunces',serif",fontSize:20,fontWeight:700,margin:0,minWidth:180,textAlign:"center"}}>{MONTH_NAMES[calMonth]} {calYear}</h2>
          <button onClick={nextMonth} style={{width:32,height:32,borderRadius:8,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>›</button>
          <button onClick={goToday} style={{padding:"5px 12px",borderRadius:6,border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)",fontSize:11,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Today</button>
        </div>
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
        {Array(firstDow).fill(null).map((_,i)=>(
          <div key={`empty-${i}`} style={{background:"var(--bg-surface)",padding:12,minHeight:80,opacity:0.3}}/>
        ))}
        {Array(daysInMonth).fill(null).map((_,i)=>{
          const day=i+1;
          const evs=monthEvs(day);
          const tod=isToday(day);
          return (
            <div key={day}
              onClick={()=>{setCalModalDay(day);setCalModalOpen(true);}}
              style={{background:"var(--bg-surface)",padding:"8px 10px",minHeight:80,cursor:"pointer",borderTop:tod?"2px solid var(--amber)":"none",boxSizing:"border-box"}}
              onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"}
              onMouseLeave={e=>e.currentTarget.style.background="var(--bg-surface)"}>
              <div style={{fontSize:12,fontWeight:tod?700:400,color:tod?"var(--amber)":"var(--text-secondary)",marginBottom:4,display:"flex",alignItems:"center",gap:5}}>
                {day}
                {tod&&<span style={{fontSize:8,background:"var(--amber)",color:"#0e0f11",borderRadius:99,padding:"1px 5px",fontWeight:700}}>TODAY</span>}
              </div>
              {evs.map((ev,ei)=>(
                <div key={ei}
                  onClick={e=>{e.stopPropagation();deleteCalEvent(calEvents.findIndex(c=>c.day===day&&c.title===ev.title));}}
                  title="Click to remove"
                  style={{fontSize:10,padding:"2px 6px",borderRadius:4,background:(tc[ev.type]||"var(--muted)")+"22",color:tc[ev.type]||"var(--muted)",fontWeight:600,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",cursor:"pointer"}}>
                  {ev.title}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p style={{fontSize:11,color:"var(--muted)",marginTop:10}}>Click a day to add an event · Click an event to remove it</p>
    </div>
  );
}

// ─── GOOGLE SEARCH CONSOLE INTEGRATION ───────────────────────────────────────

const GSC_STORAGE      = "bb_gsc_config";
const GSC_DATA_STORAGE = "bb_gsc_data";

function loadGSCConfig() { try { return JSON.parse(localStorage.getItem(GSC_STORAGE) || "{}"); } catch { return {}; } }
function saveGSCConfig(d) {
  try { localStorage.setItem(GSC_STORAGE, JSON.stringify(d)); } catch {}
  // Also push to cloud if we have a userId
  const uid = window.__bbUserId;
  if (uid && d?.refreshToken) cloudSet("gsc_config", uid, d);
}
function loadGSCData()   { try { return JSON.parse(localStorage.getItem(GSC_DATA_STORAGE) || "null"); } catch { return null; } }
function saveGSCData(d)  { try { localStorage.setItem(GSC_DATA_STORAGE, JSON.stringify(d)); } catch {} }

// Get a valid access token — auto-refreshes if expired
async function getGSCAccessToken(cfg) {
  if (!cfg?.refreshToken) throw new Error("Not connected — please reconnect Search Console.");

  // If token still valid (>5 min left), use it
  if (cfg.accessToken && cfg.expiry && Date.now() < cfg.expiry - 300_000) {
    return cfg.accessToken;
  }

  // Refresh it
  const res  = await fetch("/api/gsc-refresh", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ refreshToken: cfg.refreshToken }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

  // Save updated token
  const updated = { ...cfg, accessToken: data.access_token, expiry: data.expiry };
  saveGSCConfig(updated);
  return data.access_token;
}

// Fetch GSC data using a valid access token
async function fetchGSCData(accessToken, siteUrl, days = 28) {
  const endDate   = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["query","page"], rowLimit: 100 }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `GSC error ${res.status}`);
  }
  return await res.json();
}

function GSCPanel({ onDataLoaded }) {
  const [cfg,      setCfg]      = useState(loadGSCConfig);
  const [siteUrl,  setSiteUrl]  = useState(() => loadGSCConfig().siteUrl || "");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [success,  setSuccess]  = useState("");
  const [sites,    setSites]    = useState([]);
  const [loadingSites, setLoadingSites] = useState(false);

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };

  // Fetch all sites this account has access to
  const fetchSites = async () => {
    setLoadingSites(true); setError("");
    try {
      const accessToken = await getGSCAccessToken(cfg);
      const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const siteList = (data.siteEntry || []).map(s => s.siteUrl);
      setSites(siteList);
      if (siteList.length === 0) setError("No sites found for this account in Search Console.");
      else if (siteList.length === 1) { setSiteUrl(siteList[0]); }
    } catch(e) { setError(e.message); }
    setLoadingSites(false);
  };

  const connectGSC = () => {
    if (!cfg.clientId?.trim()) { setError("Enter your Google OAuth Client ID first."); return; }
    const params = new URLSearchParams({
      client_id:     cfg.clientId.trim(),
      redirect_uri:  "https://blogbunker.netlify.app/api/gsc-callback",
      response_type: "code",
      scope:         "https://www.googleapis.com/auth/webmasters.readonly",
      access_type:   "offline",
      prompt:        "consent",
    });
    window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, "gsc_auth", "width=500,height=650,scrollbars=yes");
    const handler = (e) => {
      if (e.data?.type === "gsc-auth-success") {
        window.removeEventListener("message", handler);
        const tokens = e.data.tokens;
        const newCfg = { ...cfg, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiry: tokens.expiry, siteUrl: siteUrl.trim(), connected: true };
        saveGSCConfig(newCfg); setCfg(newCfg);
        setSuccess("✓ Connected! Click Fetch Data to load your Search Console analytics.");
        setError("");
      }
      if (e.data?.type === "gsc-auth-error") {
        window.removeEventListener("message", handler);
        setError(e.data.error);
      }
    };
    window.addEventListener("message", handler);
  };

  const fetchData = async () => {
    if (!siteUrl.trim()) return;
    setLoading(true); setError("");
    try {
      const accessToken = await getGSCAccessToken(cfg);
      const raw  = await fetchGSCData(accessToken, siteUrl.trim());
      const rows = raw.rows || [];
      const queryMap = {}, pageMap = {};
      let totalClicks = 0, totalImpressions = 0;
      for (const row of rows) {
        const [query, page] = row.keys;
        totalClicks += row.clicks; totalImpressions += row.impressions;
        if (!queryMap[query]) queryMap[query] = { query, clicks:0, impressions:0, position:0, count:0 };
        queryMap[query].clicks += row.clicks; queryMap[query].impressions += row.impressions;
        queryMap[query].position += row.position; queryMap[query].count++;
        if (!pageMap[page]) pageMap[page] = { page, clicks:0, impressions:0 };
        pageMap[page].clicks += row.clicks; pageMap[page].impressions += row.impressions;
      }
      const keywords = Object.values(queryMap)
        .map(k => ({ ...k, ctr: k.impressions>0?k.clicks/k.impressions*100:0, position: k.count>0?k.position/k.count:0 }))
        .sort((a,b) => b.clicks - a.clicks).slice(0,20);
      const topPages = Object.values(pageMap).sort((a,b) => b.clicks - a.clicks).slice(0,10);
      const data = { keywords, topPages, totalClicks, totalImpressions, fetchedAt: new Date().toISOString(), siteUrl: siteUrl.trim(), days: 28 };
      saveGSCData(data);
      const newCfg = { ...cfg, siteUrl: siteUrl.trim(), lastFetch: data.fetchedAt };
      saveGSCConfig(newCfg); setCfg(newCfg);
      onDataLoaded(data);
      setSuccess(`✓ Fetched ${rows.length} rows of data.`);
    } catch(e) {
      setError(e.message);
      if (e.message.includes("refresh") || e.message.includes("401")) {
        const newCfg = { ...cfg, connected: false, accessToken: null, refreshToken: null };
        saveGSCConfig(newCfg); setCfg(newCfg);
      }
    }
    setLoading(false);
  };

  const disconnect = () => { const empty = { siteUrl, clientId: cfg.clientId }; saveGSCConfig(empty); setCfg(empty); setSuccess(""); setError(""); };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Google Search Console</h3>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
          See which keywords drive traffic, your Google rankings, and which posts perform best in search.
        </p>
      </div>

      {success && <div style={{ padding:"10px 14px", borderRadius:8, background:"#5cba6c0a", border:"1px solid #5cba6c44", fontSize:12, color:"#5cba6c" }}>{success}</div>}
      {error   && <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--red)0a", border:"1px solid var(--red)44", fontSize:12, color:"var(--red)" }}>{error}</div>}

      {/* OAuth Client ID input */}
      <div>
        <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
          Google OAuth Client ID
        </label>
        <input style={iS} placeholder="123456789-abc.apps.googleusercontent.com" value={cfg.clientId || ""}
          onChange={e => { const n = {...cfg, clientId: e.target.value}; setCfg(n); saveGSCConfig(n); }}
          onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        <p style={{ fontSize:11, color:"var(--muted)", marginTop:4, lineHeight:1.6 }}>
          From Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client ID.
          Make sure <code>https://blogbunker.netlify.app/api/gsc-callback</code> is added as an Authorized Redirect URI.
        </p>
      </div>

      <div>
        <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
          Property / Site URL
        </label>

        {/* If connected, show a fetch-sites button and dropdown */}
        {cfg.connected ? (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={fetchSites} disabled={loadingSites}
                style={{ padding:"8px 16px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:6 }}>
                {loadingSites ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Loading…</> : "↓ Load my GSC properties"}
              </button>
              {siteUrl && <div style={{ fontSize:12, color:"#5cba6c", alignSelf:"center", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>✓ {siteUrl}</div>}
            </div>
            {sites.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                <div style={{ fontSize:11, color:"var(--muted)" }}>Select your property:</div>
                {sites.map(s => (
                  <button key={s} onClick={() => setSiteUrl(s)}
                    style={{ padding:"9px 14px", borderRadius:8, border:`1px solid ${siteUrl===s?"var(--amber)":"var(--border)"}`, background:siteUrl===s?"var(--amber-glow)":"var(--bg-elevated)", color:siteUrl===s?"var(--amber)":"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", textAlign:"left", fontWeight:siteUrl===s?700:400 }}>
                    {siteUrl===s ? "✓ " : ""}{s}
                  </button>
                ))}
                <div style={{ fontSize:11, color:"var(--muted)", lineHeight:1.6 }}>
                  Tip: If you see both <code>sc-domain:caskandstream.com</code> and <code>https://caskandstream.com/</code> — pick the one that shows data in Search Console. Domain properties (sc-domain:) usually have more complete data.
                </div>
              </div>
            )}
            {!sites.length && !loadingSites && !siteUrl && (
              <input style={iS} placeholder="or type manually: sc-domain:caskandstream.com"
                value={siteUrl} onChange={e => setSiteUrl(e.target.value)}
                onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            )}
          </div>
        ) : (
          <input style={iS} placeholder="Connect first, then load your properties"
            value={siteUrl} onChange={e => setSiteUrl(e.target.value)}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        )}
      </div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
        {!cfg.connected ? (
          <button onClick={connectGSC} disabled={!cfg.clientId?.trim()}
            style={{ padding:"10px 24px", borderRadius:8, border:"none", background:cfg.clientId?.trim()?"#4285f4":"var(--bg-elevated)", color:cfg.clientId?.trim()?"#fff":"var(--muted)", fontSize:13, fontWeight:700, cursor:cfg.clientId?.trim()?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8 }}>
            <svg width="16" height="16" viewBox="0 0 18 18"><path fill="#fff" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#ffffffaa" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#ffffffaa" d="M3.97 10.72A5.41 5.41 0 0 1 3.69 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#ffffffaa" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
            Sign in with Google
          </button>
        ) : (
          <>
            <button onClick={fetchData} disabled={loading}
              style={{ padding:"10px 24px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":"var(--amber)", color:loading?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:loading?"not-allowed":"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:8 }}>
              {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Fetching…</> : "↓ Fetch Analytics Data"}
            </button>
            <button onClick={disconnect}
              style={{ padding:"10px 16px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
              Disconnect
            </button>
            <span style={{ fontSize:12, color:"#5cba6c", alignSelf:"center" }}>● Connected{cfg.lastFetch ? ` · Last synced ${new Date(cfg.lastFetch).toLocaleString()}` : ""}</span>
          </>
        )}
      </div>

      {/* Setup instructions */}
      <div style={{ padding:"14px 16px", borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:12, color:"var(--text-secondary)", lineHeight:1.8 }}>
        <div style={{ fontWeight:700, color:"var(--text)", marginBottom:8 }}>Setup (one-time, 5 minutes):</div>
        1. <a href="https://console.cloud.google.com" target="_blank" rel="noopener" style={{color:"var(--amber)"}}>Google Cloud Console</a> → select your project → <strong>APIs & Services → Library</strong> → enable <strong>Google Search Console API</strong><br/>
        2. <strong>APIs & Services → Credentials → Create Credentials → OAuth Client ID</strong><br/>
        3. Application type: <strong>Web application</strong><br/>
        4. Add Authorized Redirect URI: <code style={{background:"var(--bg-surface)",padding:"1px 4px",borderRadius:3}}>https://blogbunker.netlify.app/api/gsc-callback</code><br/>
        5. Copy the <strong>Client ID</strong> → paste above<br/>
        6. In <strong>Netlify → Environment Variables</strong> add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code><br/>
        7. Redeploy → click <strong>Sign in with Google</strong> above
      </div>
    </div>
  );
}

function GSCAnalyticsView({ data, onRefresh }) {
  if (!data) return (
    <div style={{ textAlign:"center", padding:"40px 20px", color:"var(--muted)", fontSize:13 }}>
      <div style={{ fontSize:32, marginBottom:12 }}>◎</div>
      No Search Console data yet. Go to <strong style={{color:"var(--text)"}}>Settings → API Keys → Search Console</strong> to connect and fetch data.
    </div>
  );

  const { keywords, topPages, totalClicks, totalImpressions, fetchedAt, days } = data;
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(1) : "0";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {/* Summary cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:16 }}>
        {[
          { label:"Total Clicks",       value:totalClicks.toLocaleString(),       sub:`Last ${days} days` },
          { label:"Total Impressions",  value:totalImpressions.toLocaleString(),  sub:"Search appearances" },
          { label:"Avg CTR",            value:`${avgCTR}%`,                        sub:"Click-through rate" },
        ].map(s => (
          <div key={s.label} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>{s.label}</div>
            <div style={{ fontFamily:"var(--font-display)", fontSize:28, fontWeight:700 }}>{s.value}</div>
            <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:4 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        {/* Top Keywords */}
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>Top Keywords</div>
          <table style={{ width:"100%", borderCollapse:"collapse" }}>
            <thead>
              <tr style={{ borderBottom:"1px solid var(--border)" }}>
                {["Query","Clicks","Impr.","Pos."].map(h=>(
                  <th key={h} style={{ textAlign:"left", padding:"6px 8px", fontSize:9, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keywords.slice(0,12).map((k,i) => (
                <tr key={i} style={{ borderBottom:"1px solid var(--border)11" }}>
                  <td style={{ padding:"8px 8px", fontSize:12, maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{k.query}</td>
                  <td style={{ padding:"8px 8px", fontSize:12, fontWeight:700, color:"var(--amber)", fontVariantNumeric:"tabular-nums" }}>{k.clicks}</td>
                  <td style={{ padding:"8px 8px", fontSize:12, color:"var(--text-secondary)", fontVariantNumeric:"tabular-nums" }}>{k.impressions}</td>
                  <td style={{ padding:"8px 8px", fontSize:12, color:"var(--text-secondary)", fontVariantNumeric:"tabular-nums" }}>{k.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Top Pages */}
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>Top Pages by Clicks</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {topPages.slice(0,8).map((p,i) => {
              const maxClicks = topPages[0]?.clicks || 1;
              const slug = p.page.replace(/https?:\/\/[^/]+/, "").replace(/\/$/, "") || "/";
              return (
                <div key={i}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4 }}>
                    <span style={{ fontSize:11, color:"var(--text-secondary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"75%" }}>{slug || "/"}</span>
                    <span style={{ fontSize:12, fontWeight:700, color:"var(--amber)", flexShrink:0, marginLeft:8 }}>{p.clicks}</span>
                  </div>
                  <div style={{ height:4, borderRadius:99, background:"var(--bg-elevated)", overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${(p.clicks/maxClicks)*100}%`, background:"var(--amber)", borderRadius:99, transition:"width 0.5s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:11, color:"var(--muted)", padding:"8px 0" }}>
        <span>Data from Google Search Console · Last {days} days · Fetched {new Date(fetchedAt).toLocaleString()}</span>
        <button onClick={onRefresh} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--amber)", fontSize:11, fontFamily:"'DM Sans',sans-serif" }}>
          ↓ Refresh Data
        </button>
      </div>
    </div>
  );
}

// ─── POSTS TAB ────────────────────────────────────────────────────────────────

function PostsTab({ posts, filteredPosts, postFilter, setPostFilter, setPosts, savePost, openEditPost, onSendToPipeline, card }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const allSelected = filteredPosts.length > 0 && filteredPosts.every(p => selectedIds.includes(p.id));

  const toggleSelect  = (id)  => setSelectedIds(s => s.includes(id) ? s.filter(x=>x!==id) : [...s, id]);
  const toggleAll     = ()    => setSelectedIds(allSelected ? [] : filteredPosts.map(p=>p.id));
  const bulkDelete    = ()    => {
    if (window.confirm(`Delete ${selectedIds.length} post${selectedIds.length>1?"s":""}?`)) {
      setPosts(all => all.filter(p => !selectedIds.includes(p.id)));
      setSelectedIds([]);
    }
  };
  const bulkSetStatus = (status) => {
    setPosts(all => all.map(p => selectedIds.includes(p.id) ? {...p, status} : p));
    setSelectedIds([]);
  };

  const chk = (checked, amber) => ({
    width:16, height:16, borderRadius:4,
    border:`2px solid ${checked ? "var(--amber)" : "var(--border)"}`,
    background: checked ? "var(--amber)" : "transparent",
    cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
  });

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:20,alignItems:"center",flexWrap:"wrap"}}>
        {["all","published","draft","scheduled"].map(f=>(
          <button key={f} onClick={()=>{ setPostFilter(f); setSelectedIds([]); }}
            style={{padding:"6px 14px",borderRadius:99,border:postFilter===f?"1px solid var(--amber)":"1px solid var(--border)",background:postFilter===f?"var(--amber-glow)":"transparent",color:postFilter===f?"var(--amber)":"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",textTransform:"capitalize"}}>
            {f==="all"?`All (${posts.length})`:`${f} (${posts.filter(p=>p.status===f).length})`}
          </button>
        ))}

        {selectedIds.length > 0 && (
          <div style={{display:"flex",gap:6,marginLeft:"auto",alignItems:"center"}}>
            <span style={{fontSize:11,color:"var(--text-secondary)"}}>{selectedIds.length} selected</span>
            <select onChange={e=>{ if(e.target.value){ bulkSetStatus(e.target.value); e.target.value=""; } }} defaultValue=""
              style={{padding:"5px 10px",borderRadius:7,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:12,cursor:"pointer",fontFamily:"var(--font-body)"}}>
              <option value="" disabled>Change status…</option>
              <option value="published">→ Published</option>
              <option value="draft">→ Draft</option>
              <option value="scheduled">→ Scheduled</option>
            </select>
            <button onClick={bulkDelete}
              style={{padding:"5px 12px",borderRadius:7,border:"1px solid var(--red)44",background:"var(--red)0a",color:"var(--red)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)"}}>
              🗑 Delete {selectedIds.length}
            </button>
            <button onClick={()=>setSelectedIds([])}
              style={{padding:"5px 10px",borderRadius:7,border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)",fontSize:12,cursor:"pointer",fontFamily:"var(--font-body)"}}>
              ✕ Clear
            </button>
          </div>
        )}
      </div>

      <div style={{...card, padding:0, overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{borderBottom:"1px solid var(--border)"}}>
              <th style={{padding:"12px 16px",width:36}}>
                <div onClick={toggleAll} style={chk(allSelected)}>
                  {allSelected&&<span style={{fontSize:10,color:"#0e0f11",fontWeight:900}}>✓</span>}
                </div>
              </th>
              {["Title","Category","Status","Date","Views",""].map(h=>(
                <th key={h} style={{textAlign:"left",padding:"12px 16px",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredPosts.map(p => {
              const sel = selectedIds.includes(p.id);
              return (
                <tr key={p.id} style={{borderBottom:"1px solid var(--border)",background:sel?"var(--amber-glow)":"transparent"}}
                  onMouseEnter={e=>{ if(!sel) e.currentTarget.style.background="var(--bg-hover)"; }}
                  onMouseLeave={e=>{ e.currentTarget.style.background=sel?"var(--amber-glow)":"transparent"; }}>
                  <td style={{padding:"12px 16px"}} onClick={e=>{ e.stopPropagation(); toggleSelect(p.id); }}>
                    <div style={chk(sel)}>
                      {sel&&<span style={{fontSize:10,color:"#0e0f11",fontWeight:900}}>✓</span>}
                    </div>
                  </td>
                  <td style={{padding:"14px 16px",fontWeight:600,fontSize:13,cursor:"pointer"}} onClick={()=>openEditPost(p)}>{p.title}</td>
                  <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)",cursor:"pointer"}} onClick={()=>openEditPost(p)}>{p.category}</td>
                  <td style={{padding:"10px 16px"}} onClick={e=>e.stopPropagation()}>
                    <select value={p.status} onChange={e=>savePost({...p,status:e.target.value})}
                      style={{padding:"4px 8px",borderRadius:6,border:"1px solid var(--border)",background:"var(--bg-elevated)",color:"var(--text)",fontSize:11,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                      <option value="draft">Draft</option>
                      <option value="published">Published</option>
                      <option value="scheduled">Scheduled</option>
                    </select>
                  </td>
                  <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)",cursor:"pointer"}} onClick={()=>openEditPost(p)}>{p.date}</td>
                  <td style={{padding:"14px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}} onClick={()=>openEditPost(p)}>{p.views>0?p.views.toLocaleString():"—"}</td>
                  <td style={{padding:"14px 16px"}} onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>onSendToPipeline(p)} title="Continue this article in the Pipeline"
                      style={{padding:"5px 12px",borderRadius:7,border:"1px solid var(--amber)44",background:"transparent",color:"var(--amber)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",whiteSpace:"nowrap"}}>
                      → Pipeline
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── META (FACEBOOK + INSTAGRAM) INTEGRATION ─────────────────────────────────

const META_STORAGE = "bb_meta_config";
function loadMetaConfig() { try { return JSON.parse(localStorage.getItem(META_STORAGE) || "{}"); } catch { return {}; } }
function saveMetaConfig(d) {
  try { localStorage.setItem(META_STORAGE, JSON.stringify(d)); } catch {}
  // Also push to cloud if connected
  const uid = window.__bbUserId;
  if (uid && d?.connected) cloudSet("meta_config", uid, d);
}

// Converts a blob: URL (from generated images) into a publicly fetchable URL.
// Required for Instagram, which needs a real https:// URL it can fetch server-side.
async function ensurePublicImageUrl(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("https://")) return imageUrl; // already public

  let dataUrl;

  if (imageUrl.startsWith("blob:")) {
    // Fetch the blob from browser memory and convert to base64
    const blobRes = await fetch(imageUrl);
    if (!blobRes.ok) throw new Error(`Could not read generated image (${blobRes.status})`);
    const blob = await blobRes.blob();
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to encode image"));
      reader.readAsDataURL(blob);
    });
  } else if (imageUrl.startsWith("data:")) {
    dataUrl = imageUrl; // already base64, use directly
  } else {
    throw new Error(`Cannot convert URL to public format: ${imageUrl.slice(0, 60)}`);
  }

  // If too large for the function's request limit, recompress via canvas
  const MAX_LEN = 4_000_000;
  if (dataUrl.length > MAX_LEN) {
    dataUrl = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let scale = Math.sqrt(MAX_LEN / dataUrl.length) * 0.9;
        canvas.width  = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Failed to load image for compression"));
      img.src = dataUrl;
    });
  }

  // Upload to Netlify Blobs → get back a public https:// URL
  let res;
  try {
    res = await fetch("/api/upload-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
  } catch (e) {
    throw new Error(`Could not reach /api/upload-image — network error: ${e.message}`);
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Image upload failed (${res.status}): ${text.slice(0,150) || "(empty response)"}`); }

  if (!res.ok || data.error) throw new Error(`Image upload failed: ${data.error || res.status}`);
  if (!data.url) throw new Error("Image upload succeeded but no URL was returned");
  return data.url;
}

async function metaPost({ pageId, pageToken, instagramId, message, imageUrl, link, platforms }) {
  let finalImageUrl = imageUrl;
  // Any blob: or data: URL must be uploaded to get a public https:// URL
  // before sending to meta-post.js (server can't fetch browser-local URLs)
  if (imageUrl && (imageUrl.startsWith("blob:") || imageUrl.startsWith("data:"))) {
    finalImageUrl = await ensurePublicImageUrl(imageUrl);
  }
  const res = await fetch("/api/meta-post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, pageToken, instagramId, message, imageUrl: finalImageUrl, link, platforms }),
  });
  return await res.json();
}

function MetaConnectPanel({ onConnected }) {
  const [cfg,      setCfg]     = useState(loadMetaConfig);
  const [appId,    setAppId]   = useState(cfg.appId || "");
  const [loading,  setLoading] = useState(false);
  const [log,      setLog]     = useState("");
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };

  // Listen for OAuth callback postMessage
  useEffect(() => {
    const handleMsg = (e) => {
      if (e.origin !== "https://blogbunker.netlify.app") return;
      if (e.data?.type !== "meta_oauth_success") return;
      const { user_token, pages } = e.data;
      const newCfg = { ...cfg, appId, userToken: user_token, pages, connected: true, connectedAt: new Date().toISOString() };
      saveMetaConfig(newCfg); setCfg(newCfg);
      setLog(`✓ Connected! Found ${pages.length} page${pages.length!==1?"s":""}${pages.some(p=>p.instagram_id)?" + Instagram":""}. Select which page to post to in Social settings.`);
      if (onConnected) onConnected(newCfg);
    };
    window.addEventListener("message", handleMsg);
    return () => window.removeEventListener("message", handleMsg);
  }, [appId, cfg]);

  const connect = () => {
    if (!appId) { setLog("Paste your Meta App ID first."); return; }
    const redirectUri = "https://blogbunker.netlify.app/api/meta-callback";
    // Use only scopes valid for Pages + Instagram content management use cases
    const scope = "pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,business_management";
    const authUrl = `https://www.facebook.com/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code`;
    setLog("Opening Facebook authorization…");
    const popup = window.open(authUrl, "meta_auth", "width=650,height=700,scrollbars=yes");
    if (!popup) setLog("Popup blocked — allow popups for blogbunker.netlify.app and try again.");
  };

  const disconnect = () => {
    saveMetaConfig({}); setCfg({}); setLog("");
    if (onConnected) onConnected({});
  };

  if (cfg.connected && cfg.pages) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ padding:14, borderRadius:10, border:"1px solid #5cba6c44", background:"#5cba6c0a", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14 }}>✓ Facebook & Instagram Connected</div>
            <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:3 }}>
              {cfg.pages.length} page{cfg.pages.length!==1?"s":""} · {cfg.pages.filter(p=>p.instagram_id).length} Instagram linked
            </div>
          </div>
          <button onClick={disconnect} style={{ padding:"6px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>Disconnect</button>
        </div>
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Your Pages</div>
          {cfg.pages.map(p => (
            <div key={p.id} style={{ padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:600, fontSize:13 }}>{p.name}</div>
                <div style={{ fontSize:11, color:"var(--text-secondary)" }}>
                  Facebook Page {p.instagram_id ? "· Instagram linked ✓" : "· No Instagram"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ padding:"14px 16px", borderRadius:10, background:"var(--amber-glow)", border:"1px solid var(--amber)33", fontSize:12, color:"var(--text-secondary)", lineHeight:1.8 }}>
        <strong style={{color:"var(--amber)"}}>Setup (one time):</strong><br/>
        1. Go to <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener" style={{color:"var(--amber)"}}>developers.facebook.com/apps</a> → Create App → Business type<br/>
        2. Add <strong style={{color:"var(--text)"}}>Facebook Login</strong> product → set redirect URI to:<br/>
        <code style={{background:"var(--bg-elevated)",padding:"2px 6px",borderRadius:4,fontSize:11}}>https://blogbunker.netlify.app/api/meta-callback</code><br/>
        3. Add <strong style={{color:"var(--text)"}}>Instagram Graph API</strong> product for Instagram posting<br/>
        4. In Netlify env vars add <code style={{background:"var(--bg-elevated)",padding:"1px 4px",borderRadius:3,fontSize:11}}>META_APP_ID</code> and <code style={{background:"var(--bg-elevated)",padding:"1px 4px",borderRadius:3,fontSize:11}}>META_APP_SECRET</code><br/>
        5. Paste your App ID below and click Connect
      </div>
      <div>
        <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Meta App ID</label>
        <input style={iS} placeholder="1234567890123456" value={appId} onChange={e=>setAppId(e.target.value)}
          onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
      </div>
      <button onClick={connect} disabled={!appId || loading}
        style={{ padding:"11px 24px", borderRadius:8, border:"none", background:appId&&!loading?"#1877f2":"var(--bg-elevated)", color:appId&&!loading?"#fff":"var(--muted)", fontSize:13, fontWeight:700, cursor:appId&&!loading?"pointer":"not-allowed", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:10, alignSelf:"flex-start" }}>
        <span style={{fontSize:16}}>f</span> Connect with Facebook
      </button>
      {log && <div style={{ fontSize:12, color:"var(--text-secondary)", padding:"8px 12px", borderRadius:6, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>{log}</div>}
    </div>
  );
}

// ─── SOCIAL STUDIO ────────────────────────────────────────────────────────────
// Full standalone social media creation studio with sub-tabs

class MarketingErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Marketing tab crash:", error, info?.componentStack?.slice(0,500)); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding:24, borderRadius:12, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:13, lineHeight:1.7 }}>
          <div style={{ fontWeight:700, marginBottom:8 }}>Marketing tab error — check browser console for details</div>
          <div style={{ fontFamily:"monospace", fontSize:11, color:"var(--text-secondary)", background:"var(--bg-elevated)", padding:12, borderRadius:8, whiteSpace:"pre-wrap" }}>
            {this.state.error?.message}
          </div>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop:12, padding:"6px 16px", borderRadius:7, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:12, fontWeight:700, cursor:"pointer" }}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function MarketingStudio({ activeProvider, activeModel, apiKeys, dark, metaConfig, posts, inspiration, competitors, onAddInspiration, handleProviderChange, handleModelChange, brandGuide, socialPosts = [], onSaveSocialPost, onDeleteSocialPost, userId = "anonymous", socialInspiration = [], onAddSocialInspiration, onDeleteSocialInspiration, socialCompetitors = [], onAddSocialCompetitor, onDeleteSocialCompetitor, externalInitialIdea = null, onConsumedExternalInitialIdea = null, tierConfig = TIER_CONFIG.operative }) {
  const [tab, setTab] = useState("pipeline");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const scheduledCount = socialPosts.filter(p => p.status === "scheduled").length;
  const [addSocialInspirationOpen, setAddSocialInspirationOpen] = useState(false);
  const [addSocialCompetitorOpen,  setAddSocialCompetitorOpen]  = useState(false);
  const [pipelineInitialIdea,      setPipelineInitialIdea]      = useState(null);
  const sendInspirationToPipeline = (item) => { setPipelineInitialIdea(item); setTab("pipeline"); };

  // Article Pipeline "→ Send to Social Pipeline" hand-off — routes through the
  // same mechanism as the Inspiration hand-off above.
  useEffect(() => {
    if (!externalInitialIdea) return;
    setPipelineInitialIdea(externalInitialIdea);
    setTab("pipeline");
    if (onConsumedExternalInitialIdea) onConsumedExternalInitialIdea();
  }, [externalInitialIdea]);

  const TABS = [
    { id:"pipeline",   label:"Social Pipeline",  icon:"◈", highlight:true },
    { id:"scheduled",  label:"Social Posts",      icon:"▤", badge: socialPosts.length || null },
    { id:"media",      label:"Media Library",     icon:"🖼" },
    { id:"video",      label:"Video Planning",    icon:"🎬" },
    { id:"email",      label:"Email",             icon:"✉" },
    { id:"seo",        label:"Keyword Research",  icon:"◎" },
    { id:"research",   label:"Research",          icon:"⊕" },
    { id:"image",      label:"Image Studio",      icon:"▣" },
  ];
  const [researchSubTab, setResearchSubTab] = useState("research");

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Marketing Studio</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Social, email, Pinterest, SEO, keyword research, and competitive intelligence — all in one place.</p>
        </div>
        <ProviderPicker activeProvider={activeProvider} activeModel={activeModel} onProviderChange={handleProviderChange} onModelChange={handleModelChange} keys={apiKeys} compact />
      </div>

      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:4, marginBottom:24, flexWrap:"wrap" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding:"7px 14px", borderRadius:8, border:tab===t.id?"1px solid var(--amber)":"1px solid var(--border)", background:tab===t.id?"var(--amber-glow)":"transparent", color:tab===t.id?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:5 }}>
            <span>{t.icon}</span>{t.label}
            {t.highlight && tab !== t.id && <span style={{ fontSize:8, fontWeight:700, padding:"1px 5px", borderRadius:99, background:"var(--amber)", color:"#0e0f11", marginLeft:2 }}>NEW</span>}
            {t.badge > 0 && <span style={{ fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:99, background:tab===t.id?"var(--amber)":"var(--bg-elevated)", color:tab===t.id?"#0e0f11":"var(--text-secondary)", border:"1px solid var(--border)", marginLeft:2 }}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* ── VIDEO PLANNING ── */}
      {tab === "video" && (
        <VideoPlanningStudio
          activeProvider={activeProvider}
          activeModel={activeModel}
          apiKeys={apiKeys}
          posts={posts}
          userId={userId}
        />
      )}

      {/* ── MEDIA LIBRARY ── */}
      {tab === "media" && (
        <MediaLibrary userId={userId} />
      )}

      {/* ── SCHEDULED POSTS ── */}
      {tab === "scheduled" && (
        <SocialPostsManager
          socialPosts={socialPosts}
          metaConfig={metaConfig}
          onSave={onSaveSocialPost}
          onDelete={onDeleteSocialPost}
          tierConfig={tierConfig}
        />
      )}

      {/* ── SOCIAL PIPELINE ── */}
      {tab === "pipeline" && (
        <SocialPipeline
          activeProvider={activeProvider}
          activeModel={activeModel}
          apiKeys={apiKeys}
          dark={dark}
          metaConfig={metaConfig}
          inspiration={inspiration}
          onAddInspiration={onAddInspiration}
          onSaveSocialPost={onSaveSocialPost}
          initialIdea={pipelineInitialIdea}
          onConsumedInitialIdea={() => setPipelineInitialIdea(null)}
          tierConfig={tierConfig}
        />
      )}

      {/* ── EMAIL NEWSLETTER ── */}
      {tab === "email" && (
        <EmailNewsletterStudio
          activeProvider={activeProvider}
          activeModel={activeModel}
          apiKeys={apiKeys}
          posts={posts}
          brandGuide={brandGuide}
        />
      )}

      {/* ── KEYWORD RESEARCH ── */}
      {tab === "seo" && (
        <KeywordResearchStudio
          activeProvider={activeProvider}
          activeModel={activeModel}
          apiKeys={apiKeys}
          posts={posts}
          inspiration={inspiration}
          onAddInspiration={onAddInspiration}
        />
      )}

      {/* ── RESEARCH (Competitors, Research, Inspiration, Post Ideas, Hashtags, Competitor Insights) ── */}
      {tab === "research" && (
        <div>
          <div style={{display:"flex",gap:4,marginBottom:20,background:"var(--bg-surface)",borderRadius:10,padding:4,border:"1px solid var(--border)",width:"fit-content",flexWrap:"wrap"}}>
            {[{id:"socialCompetitors",label:"Competitors",icon:"⊞"},{id:"research",label:"Research",icon:"⊕"},{id:"inspiration",label:"Inspiration",icon:"◐"},{id:"ideas",label:"Post Ideas",icon:"✦"},{id:"hashtags",label:"Hashtags",icon:"#"},{id:"competitor",label:"Competitor Insights",icon:"⊗"}].map(t=>(
              <button key={t.id} onClick={()=>setResearchSubTab(t.id)} style={{padding:"7px 14px",borderRadius:7,border:"none",background:researchSubTab===t.id?"var(--amber)":"transparent",color:researchSubTab===t.id?(dark?"#0e0f11":"#fff"):"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:5}}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>

          {researchSubTab === "socialCompetitors" && (
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <div>
                  <h2 style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,margin:0}}>Social Competitors</h2>
                  <p style={{color:"var(--text-secondary)",fontSize:12,margin:"4px 0 0"}}>Track accounts competing for the same audience</p>
                </div>
                <button onClick={()=>setAddSocialCompetitorOpen(true)} style={{padding:"9px 18px",borderRadius:8,border:"none",background:"var(--amber)",color:dark?"#0e0f11":"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"var(--font-body)"}}>+ Add Competitor</button>
              </div>
              {socialCompetitors.length === 0 ? (
                <div style={{padding:"40px 20px",textAlign:"center",background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,color:"var(--text-secondary)",fontSize:13}}>
                  No social competitors tracked yet — add an account to start.
                </div>
              ) : (
                <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:12,padding:0,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr style={{borderBottom:"1px solid var(--border)"}}>
                      {["Account","Platform","Followers","Post Frequency","Engagement","Threat"].map(h=>(
                        <th key={h} style={{textAlign:"left",padding:"12px 16px",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {socialCompetitors.map(c=>(
                        <tr key={c.name||c.id} style={{borderBottom:"1px solid var(--border)"}}>
                          <td style={{padding:"14px 16px"}}><div style={{fontWeight:600,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:"var(--text-secondary)"}}>{c.handle}</div></td>
                          <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.platform}</td>
                          <td style={{padding:"14px 16px",fontSize:12,fontWeight:600}}>{c.followers}</td>
                          <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.posts}</td>
                          <td style={{padding:"14px 16px",fontSize:12,color:"var(--text-secondary)"}}>{c.engagement}</td>
                          <td style={{padding:"14px 16px"}}><ThreatBadge level={c.threat}/></td>
                          <td style={{padding:"14px 16px"}}><button onClick={()=>onDeleteSocialCompetitor(c.name)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:14}} title="Remove">✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {researchSubTab === "research" && (
            <SocialResearch
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
              posts={posts}
              inspiration={inspiration}
              onAddInspiration={onAddInspiration}
            />
          )}

          {researchSubTab === "inspiration" && (
            <InspirationBoard
              inspiration={socialInspiration}
              onAddNew={()=>setAddSocialInspirationOpen(true)}
              onDelete={onDeleteSocialInspiration}
              onToDraft={sendInspirationToPipeline}
              toDraftLabel="→ Social Pipeline"
              card={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}
              btnS={{ padding:"7px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}
              btnP={{ padding:"9px 18px", borderRadius:8, border:"none", background:"var(--amber)", color:dark?"#0e0f11":"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}
            />
          )}

          {researchSubTab === "ideas" && (
            <SocialPostIdeas
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
              posts={posts}
              inspiration={inspiration}
              onAddInspiration={onAddInspiration}
            />
          )}

          {researchSubTab === "hashtags" && (
            <HashtagOptimizer
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
            />
          )}

          {researchSubTab === "competitor" && (
            <CompetitorMarketingPanel
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
              competitors={competitors}
              posts={posts}
              inspiration={inspiration}
              onAddInspiration={onAddInspiration}
            />
          )}
        </div>
      )}

      {/* ── IMAGE STUDIO ── */}
      {tab === "image" && (
        <SocialImageStudio
          activeProvider={activeProvider}
          activeModel={activeModel}
          apiKeys={apiKeys}
        />
      )}

      {addSocialInspirationOpen && (
        <AddInspirationModal
          onSave={(item) => { onAddSocialInspiration({ ...item, id: Date.now() }); setAddSocialInspirationOpen(false); }}
          onClose={() => setAddSocialInspirationOpen(false)}
        />
      )}
      {addSocialCompetitorOpen && (
        <AddSocialCompetitorModal
          onSave={onAddSocialCompetitor}
          onClose={() => setAddSocialCompetitorOpen(false)}
          dark={dark}
        />
      )}
    </div>
  );
}

// ─── SOCIAL RESEARCH ──────────────────────────────────────────────────────────

function SocialResearch({ activeProvider, activeModel, apiKeys, posts, inspiration, onAddInspiration }) {
  const [topic,      setTopic]      = useState("");
  const [results,    setResults]    = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  // Post ideas generator
  const [ideaTopic,  setIdeaTopic]  = useState("");
  const [ideas,      setIdeas]      = useState(null);
  const [ideaCount,  setIdeaCount]  = useState(5);
  const [ideaType,   setIdeaType]   = useState("mixed"); // blog | social | mixed
  const [loadIdeas,  setLoadIdeas]  = useState(false);
  const [ideaError,  setIdeaError]  = useState("");
  const [saved,      setSaved]      = useState({});

  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const generateIdeas = async () => {
    if (!ideaTopic.trim()) return;
    setLoadIdeas(true); setIdeaError(""); setIdeas(null); setSaved({});
    try {
      const typeLabel = ideaType === "blog" ? "blog post" : ideaType === "social" ? "social media post" : "blog post or social media post";
      const text = await callAI(activeProvider, activeModel,
        `You are a content strategist for Cask & Stream — a fly fishing and whiskey/bourbon lifestyle blog. Generate specific, compelling ${typeLabel} ideas. Return ONLY valid JSON array (no fences, no prose):
[
  {
    "title": "specific post title or hook",
    "type": "blog" or "social",
    "platform": "instagram" or "facebook" or "blog" or "tiktok" or "pinterest",
    "angle": "unique angle or hook in one sentence",
    "why": "why this will resonate with fly fishing / whiskey audience",
    "outline": ["point 1", "point 2", "point 3"]
  }
]
Be specific and actionable. Use real fly fishing and whiskey terminology. Vary the angles — educational, storytelling, tips, gear, recipes, locations, seasonal.`,
        `Generate ${ideaCount} ${typeLabel} ideas for the topic: "${ideaTopic}"\n\nExisting posts to avoid repeating: ${posts.slice(0,8).map(p=>p.title).join("; ")}`,
        apiKeys[activeProvider],
        2000
      );
      const parsed = parseAIJson(text);
      setIdeas(Array.isArray(parsed) ? parsed : []);
    } catch(e) { setIdeaError(e.message); }
    setLoadIdeas(false);
  };

  const saveIdea = (idea, i) => {
    if (onAddInspiration) {
      onAddInspiration({ id: Date.now() + i, title: idea.title, note: `${idea.angle}\n\nWhy: ${idea.why}\n\nOutline: ${idea.outline?.join(", ")}`, type: idea.type, platform: idea.platform });
      setSaved(s => ({ ...s, [i]: true }));
    }
  };

  const research = async () => {
    if (!topic.trim()) return;
    setLoading(true); setError(""); setResults(null);
    try {
      const text = await callAI(activeProvider, activeModel,
        `You are a social media strategist for Cask & Stream — a fly fishing and whiskey lifestyle brand. Research the given topic and return ONLY valid JSON (no fences):
{
  "trending": [{"topic":"...","why":"...","platforms":["instagram","tiktok"]}],
  "angles": [{"angle":"...","hook":"...","platform":"..."}],
  "competitors": [{"account":"...","what_works":"..."}],
  "bestTimes": {"instagram":"...","facebook":"...","tiktok":"..."},
  "contentIdeas": ["...", "..."]
}`,
        `Research social media opportunities for: ${topic}\nExisting posts: ${posts.slice(0,5).map(p=>p.title).join(", ")}`,
        apiKeys[activeProvider]
      );
      setResults(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const IDEA_COUNTS = [3, 5, 8, 10, 15];
  const IDEA_TYPES = [
    { id:"mixed",  label:"Blog + Social", icon:"✦" },
    { id:"blog",   label:"Blog Posts",    icon:"▤" },
    { id:"social", label:"Social Posts",  icon:"▣" },
  ];
  const PLATFORM_COLORS = { blog:"var(--amber)", instagram:"#e1306c", facebook:"#1877f2", tiktok:"#010101", pinterest:"#e60023", twitter:"#1da1f2" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {/* ── POST IDEAS GENERATOR ── */}
      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--amber)44", borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
          <span style={{ fontSize:16 }}>✦</span>
          <div style={{ fontSize:13, fontWeight:700, color:"var(--amber)" }}>Post Ideas Generator</div>
          <div style={{ fontSize:12, color:"var(--text-secondary)" }}>— get specific ideas for any topic</div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <input style={iS} placeholder='e.g. "fly fishing tips and techniques" or "bourbon pairing with wild game" or "best rivers in Georgia"'
            value={ideaTopic} onChange={e=>setIdeaTopic(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&generateIdeas()}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />

          <div style={{ display:"flex", gap:12, alignItems:"center", flexWrap:"wrap" }}>
            {/* Type selector */}
            <div style={{ display:"flex", gap:5 }}>
              {IDEA_TYPES.map(t => (
                <button key={t.id} onClick={()=>setIdeaType(t.id)}
                  style={{ padding:"6px 12px", borderRadius:7, border:`1px solid ${ideaType===t.id?"var(--amber)":"var(--border)"}`, background:ideaType===t.id?"var(--amber-glow)":"transparent", color:ideaType===t.id?"var(--amber)":"var(--text-secondary)", fontSize:11, fontWeight:ideaType===t.id?700:400, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:4 }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {/* Count selector */}
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ fontSize:11, color:"var(--muted)" }}>How many:</span>
              {IDEA_COUNTS.map(n => (
                <button key={n} onClick={()=>setIdeaCount(n)}
                  style={{ width:32, height:28, borderRadius:6, border:`1px solid ${ideaCount===n?"var(--amber)":"var(--border)"}`, background:ideaCount===n?"var(--amber-glow)":"transparent", color:ideaCount===n?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:ideaCount===n?700:400, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  {n}
                </button>
              ))}
            </div>

            <button onClick={generateIdeas} disabled={!ideaTopic.trim()||loadIdeas}
              style={{ padding:"8px 20px", borderRadius:8, border:"none", background:ideaTopic.trim()&&!loadIdeas?"var(--amber)":"var(--bg-elevated)", color:ideaTopic.trim()&&!loadIdeas?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:ideaTopic.trim()&&!loadIdeas?"pointer":"not-allowed", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6, marginLeft:"auto" }}>
              {loadIdeas ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Generating…</> : `${provider.logo} Generate Ideas`}
            </button>
          </div>
        </div>

        {ideaError && <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:6, background:"var(--red)11", border:"1px solid var(--red)33", marginTop:12 }}>{ideaError}</div>}

        {ideas && (
          <div style={{ marginTop:16, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--muted)" }}>{ideas.length} ideas for "{ideaTopic}"</div>
              <button onClick={generateIdeas}
                style={{ fontSize:11, color:"var(--text-secondary)", background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"center", gap:4 }}>
                ↻ Regenerate
              </button>
            </div>
            {ideas.map((idea, i) => (
              <div key={i} style={{ padding:"14px 16px", borderRadius:10, background:"var(--bg-elevated)", border:"1px solid var(--border)", display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:6 }}>
                      <span style={{ fontSize:10, padding:"2px 8px", borderRadius:99, background:(PLATFORM_COLORS[idea.platform]||"var(--amber)")+"15", color:PLATFORM_COLORS[idea.platform]||"var(--amber)", border:`1px solid ${PLATFORM_COLORS[idea.platform]||"var(--amber)"}33`, fontWeight:600, textTransform:"capitalize" }}>
                        {idea.platform || idea.type}
                      </span>
                    </div>
                    <div style={{ fontSize:14, fontWeight:700, marginBottom:4, lineHeight:1.4 }}>{idea.title}</div>
                    <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.6, marginBottom:4 }}>{idea.angle}</div>
                    <div style={{ fontSize:11, color:"var(--muted)", fontStyle:"italic" }}>Why it works: {idea.why}</div>
                  </div>
                  <button onClick={() => saveIdea(idea, i)} disabled={saved[i]}
                    style={{ padding:"6px 14px", borderRadius:7, border:"none", background:saved[i]?"#5cba6c":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:saved[i]?"default":"pointer", fontFamily:"var(--font-body)", flexShrink:0, whiteSpace:"nowrap" }}>
                    {saved[i] ? "✓ Saved" : "+ Save Idea"}
                  </button>
                </div>
                {idea.outline?.length > 0 && (
                  <div style={{ paddingTop:8, borderTop:"1px solid var(--border)" }}>
                    <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--muted)", marginBottom:5 }}>Outline</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      {idea.outline.map((point, j) => (
                        <div key={j} style={{ fontSize:11, color:"var(--text-secondary)", display:"flex", gap:8 }}>
                          <span style={{ color:"var(--amber)", flexShrink:0 }}>{j+1}.</span>{point}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── SOCIAL RESEARCH ── */}
      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Research Topic or Niche</div>
        <div style={{ display:"flex", gap:10 }}>
          <input style={{ ...iS }} placeholder="e.g. dry fly fishing on freestone streams, bourbon cocktails for outdoors…" value={topic} onChange={e=>setTopic(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&research()}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          <button onClick={research} disabled={!topic.trim()||loading}
            style={{ padding:"10px 20px", borderRadius:8, border:"none", background:topic.trim()&&!loading?provider.color:"var(--bg-elevated)", color:topic.trim()&&!loading?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:topic.trim()&&!loading?"pointer":"not-allowed", fontFamily:"var(--font-body)", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:8 }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Researching…</> : `${provider.logo} Research`}
          </button>
        </div>
      </div>

      {error && <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:6, background:"var(--red)11", border:"1px solid var(--red)33" }}>{error}</div>}

      {results && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          {/* Trending */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)", marginBottom:14 }}>🔥 Trending Topics</div>
            {results.trending?.map((t,i) => (
              <div key={i} style={{ padding:"10px 0", borderBottom:"1px solid var(--border)", display:"flex", flexDirection:"column", gap:4 }}>
                <div style={{ fontWeight:600, fontSize:13 }}>{t.topic}</div>
                <div style={{ fontSize:11, color:"var(--text-secondary)" }}>{t.why}</div>
                <div style={{ display:"flex", gap:4, marginTop:2 }}>
                  {t.platforms?.map(p => <span key={p} style={{ fontSize:10, padding:"1px 6px", borderRadius:99, background:"var(--bg-elevated)", color:"var(--muted)", border:"1px solid var(--border)" }}>{p}</span>)}
                </div>
              </div>
            ))}
          </div>

          {/* Angles */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#5cba6c", marginBottom:14 }}>💡 Content Angles</div>
            {results.angles?.map((a,i) => (
              <div key={i} style={{ padding:"10px 0", borderBottom:"1px solid var(--border)" }}>
                <div style={{ fontWeight:600, fontSize:13, marginBottom:3 }}>{a.angle}</div>
                <div style={{ fontSize:11, color:"var(--amber)", marginBottom:3 }}>Hook: {a.hook}</div>
                <div style={{ fontSize:10, color:"var(--muted)" }}>Best for: {a.platform}</div>
              </div>
            ))}
          </div>

          {/* Best times */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#7c3aed", marginBottom:14 }}>⏰ Best Posting Times</div>
            {results.bestTimes && Object.entries(results.bestTimes).map(([plat, time]) => (
              <div key={plat} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                <span style={{ fontSize:12, textTransform:"capitalize", fontWeight:500 }}>{plat}</span>
                <span style={{ fontSize:12, color:"var(--text-secondary)" }}>{time}</span>
              </div>
            ))}
          </div>

          {/* Content ideas */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>📋 Quick Ideas</div>
            {results.contentIdeas?.map((idea,i) => (
              <div key={i} style={{ display:"flex", gap:10, padding:"8px 0", borderBottom:"1px solid var(--border)", alignItems:"flex-start" }}>
                <span style={{ color:"var(--amber)", fontSize:11, flexShrink:0, marginTop:1 }}>→</span>
                <span style={{ fontSize:12 }}>{idea}</span>
                <button onClick={() => onAddInspiration({ id:Date.now()+i, title:idea, source:"Social Research", type:"article", notes:`Topic: ${topic}` })}
                  style={{ marginLeft:"auto", padding:"2px 8px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--muted)", fontSize:10, cursor:"pointer", fontFamily:"var(--font-body)", flexShrink:0 }}>
                  + Board
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── HASHTAG OPTIMIZER ────────────────────────────────────────────────────────

function HashtagOptimizer({ activeProvider, activeModel, apiKeys }) {
  const [topic,    setTopic]    = useState("");
  const [platform, setPlatform] = useState("instagram");
  const [results,  setResults]  = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [copied,   setCopied]   = useState("");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const generate = async () => {
    if (!topic.trim()) return;
    setLoading(true); setError(""); setResults(null);
    try {
      const text = await callAI(activeProvider, activeModel,
        `You are a hashtag strategist for Cask & Stream — a fly fishing and whiskey lifestyle brand. Generate optimized hashtags. Return ONLY valid JSON (no fences):
{
  "primary": ["#tag1","#tag2"],
  "niche": ["#tag1","#tag2"],
  "trending": ["#tag1","#tag2"],
  "branded": ["#CaskAndStream","#CastAtDawn"],
  "sets": {
    "max_reach": "full hashtag string for copy-paste",
    "niche_focus": "niche hashtag string",
    "branded_only": "branded only string"
  }
}
primary = 5 high-volume (100k-1M posts), niche = 8 medium-volume (10k-100k), trending = 5 current trends, branded = 3-4 brand-specific`,
        `Topic: ${topic}\nPlatform: ${platform}`,
        apiKeys[activeProvider]
      );
      setResults(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const copySet = (key, val) => {
    navigator.clipboard.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied(""), 2000);
  };

  const PLATS = [{ id:"instagram", label:"Instagram" },{ id:"tiktok", label:"TikTok" },{ id:"facebook", label:"Facebook" },{ id:"twitter", label:"X/Twitter" }];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", gap:10, marginBottom:14 }}>
          {PLATS.map(p => (
            <button key={p.id} onClick={() => setPlatform(p.id)}
              style={{ padding:"6px 14px", borderRadius:99, border:platform===p.id?"1px solid var(--amber)":"1px solid var(--border)", background:platform===p.id?"var(--amber-glow)":"transparent", color:platform===p.id?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <input style={iS} placeholder="e.g. dry fly fishing, bourbon tasting, fly tying…" value={topic} onChange={e=>setTopic(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&generate()}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          <button onClick={generate} disabled={!topic.trim()||loading}
            style={{ padding:"10px 20px", borderRadius:8, border:"none", background:topic.trim()&&!loading?provider.color:"var(--bg-elevated)", color:topic.trim()&&!loading?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:topic.trim()&&!loading?"pointer":"not-allowed", fontFamily:"var(--font-body)", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:8 }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Generating…</> : "# Generate Hashtags"}
          </button>
        </div>
      </div>

      {error && <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:6, background:"var(--red)11" }}>{error}</div>}

      {results && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Tag groups */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12 }}>
            {[
              { key:"primary",  label:"High Volume",  color:"var(--amber)" },
              { key:"niche",    label:"Niche Focus",  color:"#5cba6c"      },
              { key:"trending", label:"Trending",     color:"#7c3aed"      },
              { key:"branded",  label:"Branded",      color:"var(--amber)", span:3 },
            ].map(g => (
              <div key={g.key} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:10, padding:14, ...(g.span?{gridColumn:`span ${g.span}`}:{}) }}>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:g.color, marginBottom:10 }}>{g.label}</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {results[g.key]?.map((tag,i) => (
                    <span key={i} onClick={() => { navigator.clipboard.writeText(tag); }}
                      style={{ fontSize:12, padding:"4px 10px", borderRadius:99, background:g.color+"15", color:g.color, border:`1px solid ${g.color}33`, cursor:"pointer", fontWeight:500 }}
                      title="Click to copy">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Ready-to-use sets */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>📋 Ready-to-Use Sets</div>
            {results.sets && Object.entries(results.sets).map(([key, val]) => (
              <div key={key} style={{ padding:"12px 0", borderBottom:"1px solid var(--border)" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                  <div style={{ fontSize:12, fontWeight:600, textTransform:"capitalize" }}>{key.replace(/_/g," ")}</div>
                  <button onClick={() => copySet(key, val)}
                    style={{ padding:"4px 12px", borderRadius:6, border:"none", background:copied===key?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    {copied===key ? "✓ Copied!" : "Copy All"}
                  </button>
                </div>
                <div style={{ fontSize:11, color:"var(--text-secondary)", lineHeight:1.7, wordBreak:"break-word" }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SOCIAL IMAGE STUDIO ──────────────────────────────────────────────────────

function SocialImageStudio({ activeProvider, activeModel, apiKeys }) {
  const [topic,    setTopic]    = useState("");
  const [style,    setStyle]    = useState("cinematic");
  const [platform, setPlatform] = useState("instagram");
  const [prompt,   setPrompt]   = useState("");
  const [imageUrl, setImageUrl] = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [imgProvider, setImgProvider] = useState(() => resolveImageProvider(apiKeys));
  const provider = imgProvider;
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const handleImgProviderChange = (id) => { setImgProvider(id); saveImageProviderPref(id); };

  const [previewOpen, setPreviewOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState("");

  const STYLES = [
    { id:"cinematic",   label:"Cinematic"    },
    { id:"editorial",   label:"Editorial"    },
    { id:"lifestyle",   label:"Lifestyle"    },
    { id:"minimal",     label:"Minimal"      },
    { id:"vintage",     label:"Vintage Film" },
    { id:"moody",       label:"Dark & Moody" },
  ];

  const styleMap = {
    cinematic:  "cinematic photography, anamorphic lens, golden hour, film grain",
    editorial:  "editorial photography, clean composition, magazine quality",
    lifestyle:  "lifestyle photography, authentic, natural light, candid",
    minimal:    "minimalist photography, negative space, simple composition",
    vintage:    "vintage film photography, faded colors, grain, retro aesthetic",
    moody:      "dark moody photography, dramatic shadows, rich tones, atmospheric",
  };

  // Step 1 — draft the prompt and show it for review/editing
  const openPromptPreview = async () => {
    if (!topic.trim() || !provider) return;
    setLoading(true); setError("");
    try {
      const aiPrompt = `Generate an image prompt for a Cask & Stream (fly fishing and whiskey lifestyle brand) ${platform} post. Style: ${styleMap[style]}. Topic: ${topic}. Amber and teal color palette. Return ONLY the prompt, no explanation.`;
      const generatedPrompt = await callAI(activeProvider, activeModel, "You generate concise, vivid image prompts. Return only the prompt string.", aiPrompt, apiKeys[activeProvider]);
      setDraftPrompt(generatedPrompt.trim());
      setPreviewOpen(true);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  // Step 2 — actually generate the image from the (possibly edited) prompt
  const generate = async (finalPrompt) => {
    setPreviewOpen(false);
    setLoading(true); setError(""); setImageUrl(null);
    try {
      setPrompt(finalPrompt);
      const url = await generateImage(finalPrompt, platform, apiKeys, imgProvider);
      setImageUrl(url);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const PLATS = ["instagram","facebook","tiktok","twitter"];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:14 }}>
        {/* Platform */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Platform</div>
          <div style={{ display:"flex", gap:6 }}>
            {PLATS.map(p => (
              <button key={p} onClick={() => setPlatform(p)}
                style={{ padding:"5px 14px", borderRadius:99, border:platform===p?"1px solid var(--amber)":"1px solid var(--border)", background:platform===p?"var(--amber-glow)":"transparent", color:platform===p?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", textTransform:"capitalize" }}>
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Style */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Visual Style</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {STYLES.map(s => (
              <button key={s.id} onClick={() => setStyle(s.id)}
                style={{ padding:"5px 14px", borderRadius:99, border:style===s.id?"1px solid #7c3aed":"1px solid var(--border)", background:style===s.id?"#7c3aed18":"transparent", color:style===s.id?"#a78bfa":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Image AI Provider */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Image AI</div>
          <ImageProviderPicker apiKeys={apiKeys} value={imgProvider} onChange={handleImgProviderChange} />
        </div>

        {/* Topic */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Topic / Subject</div>
          <input style={iS} placeholder="e.g. dry fly fishing at sunset, aged bourbon on river rocks, fly tying…" value={topic} onChange={e=>setTopic(e.target.value)}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        </div>

        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          <button onClick={openPromptPreview} disabled={!topic.trim()||loading||!provider}
            style={{ padding:"10px 20px", borderRadius:8, border:"none", background:topic.trim()&&!loading&&provider?"#7c3aed":"var(--bg-elevated)", color:topic.trim()&&!loading&&provider?"#fff":"var(--muted)", fontSize:13, fontWeight:700, cursor:topic.trim()&&!loading&&provider?"pointer":"not-allowed", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Working…</> : "▣ Generate Image"}
          </button>
          {!provider && <span style={{ fontSize:11, color:"var(--amber)" }}>Select an image AI above</span>}
          {error && <span style={{ fontSize:12, color:"var(--red)" }}>{error}</span>}
        </div>
      </div>

      {/* Last used prompt (read-only reference, edit happens in the preview modal) */}
      {prompt && (
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:10, padding:14 }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Last Prompt Used</div>
          <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.6 }}>{prompt}</div>
          <button onClick={() => { setDraftPrompt(prompt); setPreviewOpen(true); }}
            style={{ marginTop:8, padding:"5px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
            View/Edit & Regenerate
          </button>
        </div>
      )}

      {/* Image output */}
      {imageUrl && (
        <ImageSavePanel imageUrl={imageUrl} tags={[platform, "generated"]} name={`${platform}-${topic.slice(0,20)}`} />
      )}

      {previewOpen && (
        <PromptPreviewModal
          title="Review Image Prompt"
          systemPrompt={null}
          userPrompt={draftPrompt}
          onUserChange={setDraftPrompt}
          confirmLabel="Generate Image"
          accentColor="#7c3aed"
          onCancel={() => setPreviewOpen(false)}
          onConfirm={() => generate(draftPrompt)}
        />
      )}
    </div>
  );
}

// ─── SOCIAL POST IDEAS ────────────────────────────────────────────────────────

function SocialPostIdeas({ activeProvider, activeModel, apiKeys, posts, inspiration, onAddInspiration }) {
  const [ideas,   setIdeas]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [saved,   setSaved]   = useState({});
  const [filter,  setFilter]  = useState("all");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];

  const FILTERS = [
    { id:"all",       label:"All Platforms" },
    { id:"instagram", label:"Instagram"     },
    { id:"facebook",  label:"Facebook"      },
    { id:"tiktok",    label:"TikTok"        },
    { id:"twitter",   label:"X/Twitter"     },
  ];

  const generate = async () => {
    setLoading(true); setError(""); setSaved({});
    try {
      const existingTitles = posts.slice(0,8).map(p=>p.title).join(", ");
      const text = await callAI(activeProvider, activeModel,
        `You are a social media strategist for Cask & Stream — a fly fishing and whiskey lifestyle brand. Generate 10 social post ideas. Return ONLY valid JSON array, no markdown fences, no explanation before or after. Keep every field SHORT — one sentence max per field:
[{"platform":"instagram","type":"reel","hook":"short hook","caption_idea":"one sentence","visual":"one sentence","hashtag_theme":"2-3 words"}]
Mix platforms across instagram, tiktok, facebook, twitter. Be concise — brevity matters more than detail here.`,
        `Cask & Stream. Existing: ${existingTitles}. Generate exactly 10 ideas, keep all fields brief.`,
        apiKeys[activeProvider],
        2200
      );
      setIdeas(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const saveIdea = (idea, i) => {
    onAddInspiration({ id:Date.now()+i, title:idea.hook, source:`Social Ideas — ${idea.platform}`, type:"article", notes:`${idea.caption_idea}\n\nVisual: ${idea.visual}\nHashtag theme: ${idea.hashtag_theme}` });
    setSaved(s => ({...s, [i]:true}));
  };

  const filtered = filter === "all" ? ideas : ideas.filter(i => i.platform === filter);
  const platColor = { instagram:"#e1306c", facebook:"#1877f2", tiktok:"#010101", twitter:"#1da1f2" };
  const platIcon  = { instagram:"📸", facebook:"👍", tiktok:"🎵", twitter:"🐦" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:"0 0 4px" }}>Social Post Ideas</h3>
          <p style={{ fontSize:12, color:"var(--text-secondary)", margin:0 }}>AI-generated post ideas tailored to Cask & Stream — save to Inspiration Board.</p>
        </div>
        <button onClick={generate} disabled={loading}
          style={{ padding:"10px 20px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":provider.color, color:loading?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:loading?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 }}>
          {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Generating…</> : `${provider.logo} Generate 10 Ideas`}
        </button>
      </div>

      {error && <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:6, background:"var(--red)11" }}>{error}</div>}

      {ideas.length > 0 && (
        <>
          <div style={{ display:"flex", gap:6 }}>
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                style={{ padding:"5px 12px", borderRadius:99, border:filter===f.id?"1px solid var(--amber)":"1px solid var(--border)", background:filter===f.id?"var(--amber-glow)":"transparent", color:filter===f.id?"var(--amber)":"var(--text-secondary)", fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                {f.label} {f.id!=="all"&&`(${ideas.filter(i=>i.platform===f.id).length})`}
              </button>
            ))}
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {filtered.map((idea, i) => (
              <div key={i} style={{ background:"var(--bg-surface)", border:`1px solid ${saved[ideas.indexOf(idea)]?"var(--green)44":"var(--border)"}`, borderRadius:10, padding:"14px 16px", display:"flex", gap:12, alignItems:"flex-start" }}>
                <div style={{ width:36, height:36, borderRadius:8, background:(platColor[idea.platform]||"var(--amber)")+"15", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0 }}>
                  {platIcon[idea.platform] || "📱"}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                    <span style={{ fontSize:10, fontWeight:700, color:platColor[idea.platform]||"var(--amber)", textTransform:"uppercase" }}>{idea.platform}</span>
                    <span style={{ fontSize:10, padding:"1px 6px", borderRadius:99, background:"var(--bg-elevated)", color:"var(--muted)", border:"1px solid var(--border)" }}>{idea.type}</span>
                  </div>
                  <div style={{ fontWeight:600, fontSize:13, marginBottom:4 }}>{idea.hook}</div>
                  <div style={{ fontSize:11, color:"var(--text-secondary)", marginBottom:3 }}>{idea.caption_idea}</div>
                  <div style={{ fontSize:11, color:"var(--muted)", fontStyle:"italic" }}>🎬 {idea.visual}</div>
                </div>
                <button onClick={() => saveIdea(idea, ideas.indexOf(idea))} disabled={saved[ideas.indexOf(idea)]}
                  style={{ padding:"5px 12px", borderRadius:6, border:"none", background:saved[ideas.indexOf(idea)]?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:saved[ideas.indexOf(idea)]?"default":"pointer", fontFamily:"var(--font-body)", flexShrink:0, whiteSpace:"nowrap" }}>
                  {saved[ideas.indexOf(idea)] ? "✓ Saved" : "+ Board"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {!ideas.length && !loading && (
        <div style={{ textAlign:"center", padding:"48px 20px", color:"var(--muted)", fontSize:13 }}>
          <div style={{ fontSize:32, marginBottom:12 }}>◈</div>
          Click "Generate 10 Ideas" to get platform-specific post ideas for Cask & Stream.
        </div>
      )}
    </div>
  );
}

// ─── SOCIAL PIPELINE ──────────────────────────────────────────────────────────
// 5-stage workflow: Idea → Caption → Hashtags → Image → Publish

const SOCIAL_PIPELINE_STORAGE = "bb_social_pipeline_draft";
function loadSocialPipelineDraft() { try { return JSON.parse(localStorage.getItem(SOCIAL_PIPELINE_STORAGE) || "null"); } catch { return null; } }
function saveSocialPipelineDraft(d) { try { localStorage.setItem(SOCIAL_PIPELINE_STORAGE, JSON.stringify(d)); } catch {} }
function clearSocialPipelineDraft() { try { localStorage.removeItem(SOCIAL_PIPELINE_STORAGE); } catch {} }

// ─── SOCIAL POSTS STORE ───────────────────────────────────────────────────────
const SOCIAL_POSTS_STORAGE = "bb_social_posts";

function loadSocialPosts() {
  try { return JSON.parse(localStorage.getItem(SOCIAL_POSTS_STORAGE) || "[]"); }
  catch { return []; }
}

function saveSocialPostsToStorage(posts) {
  try { localStorage.setItem(SOCIAL_POSTS_STORAGE, JSON.stringify(posts)); } catch {}
}

function createSocialPost({ platforms, captions, hashtags, imageUrl, imagePrompt, scheduledAt, status = "draft" }) {
  return {
    id:          Date.now(),
    platforms,
    captions,       // { instagram: "...", facebook: "..." }
    hashtags,
    imageUrl,
    imagePrompt,
    status,         // "draft" | "scheduled" | "published"
    scheduledAt,    // ISO string or null
    createdAt:   new Date().toISOString(),
    publishedAt: null,
    results:     {},  // { instagram: { success, id }, facebook: { success, id } }
  };
}

const SOCIAL_STAGES = [
  { id:"idea",     num:1, label:"Idea",     icon:"✦", desc:"Pick or write a concept" },
  { id:"caption",  num:2, label:"Caption",  icon:"✎", desc:"Write the post"          },
  { id:"hashtags", num:3, label:"Hashtags", icon:"#", desc:"Optimize for reach"       },
  { id:"image",    num:4, label:"Image",    icon:"▣", desc:"Generate visual"          },
  { id:"publish",  num:5, label:"Publish",  icon:"↑", desc:"Post or schedule"         },
];

function SocialPipelineProgress({ stage, setStage, completed }) {
  return (
    <div style={{ display:"flex", alignItems:"center", marginBottom:28, padding:"20px 28px", background:"var(--bg-surface)", borderRadius:12, border:"1px solid var(--border)" }}>
      {SOCIAL_STAGES.map((s, i) => {
        const isActive    = stage === s.id;
        const isDone      = completed.includes(s.id);
        const isReachable = i === 0 || completed.includes(SOCIAL_STAGES[i-1].id) || isDone || isActive;
        return (
          <div key={s.id} style={{ display:"contents" }}>
            <div onClick={() => isReachable && setStage(s.id)}
              style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:isReachable?"pointer":"default", opacity:isReachable?1:0.4, transition:"opacity 0.2s" }}>
              <div style={{ width:40, height:40, borderRadius:99, display:"flex", alignItems:"center", justifyContent:"center", fontSize:isActive?18:14, fontWeight:700, background:isDone?"var(--green)":isActive?"var(--amber)":"var(--bg-elevated)", border:isDone?"none":isActive?"none":"1px solid var(--border)", color:isDone?"#fff":isActive?"#0e0f11":"var(--muted)", transition:"all 0.3s", boxShadow:isActive?"0 0 20px var(--amber-glow)":"none" }}>
                {isDone ? "✓" : s.icon}
              </div>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:11, fontWeight:isActive?700:500, color:isActive?"var(--amber)":isDone?"var(--green)":"var(--text-secondary)" }}>{s.label}</div>
                <div style={{ fontSize:9, color:"var(--muted)", letterSpacing:"0.04em" }}>{s.desc}</div>
              </div>
            </div>
            {i < SOCIAL_STAGES.length-1 && (
              <div style={{ flex:1, height:2, background:completed.includes(s.id)?"var(--green)":isActive?"var(--amber)33":"var(--border)", margin:"0 12px", marginBottom:24, borderRadius:99, transition:"background 0.4s" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SocialPipeline({ activeProvider, activeModel, apiKeys, dark, metaConfig, inspiration, onAddInspiration, onSaveSocialPost, initialIdea = null, onConsumedInitialIdea = null, tierConfig = TIER_CONFIG.operative }) {
  let saved = loadSocialPipelineDraft();

  // Migrate old single-platform draft schema (idea.platform: string) to new multi-platform (idea.platforms: array)
  if (saved?.idea && !Array.isArray(saved.idea.platforms)) {
    const legacyPlatform = saved.idea.platform || "instagram";
    saved = {
      ...saved,
      idea: { ...saved.idea, platforms: [legacyPlatform] },
      captions: saved.caption?.text ? { [legacyPlatform]: { text: saved.caption.text } } : (saved.captions || {}),
    };
  }
  if (saved && !saved.captions) saved.captions = {};

  const [stage,     setStage]     = useState(saved?.stage || "idea");
  const [completed, setCompleted] = useState(saved?.completed || []);
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];

  // Derived from the module-level SOCIAL_PLATFORMS so bestTimes/charLimit/hashtagLimit/
  // tone/format stay in sync — the old hand-duplicated list here was missing all of
  // those fields, which is why Best Times never showed and captions had no length cap.
  const PLATFORMS = SOCIAL_PLATFORMS.filter(p => ["instagram","facebook","tiktok","twitter","pinterest","reddit"].includes(p.id))
    .map(p => ({ id:p.id, label:p.name.replace(" (Twitter)",""), color:p.color, icon:p.icon, charLimit:p.charLimit, hashtagLimit:p.hashtagLimit, bestTimes:p.bestTimes, tone:p.tone, format:p.format }));

  // idea.platforms is now an ARRAY — supports multi-select
  const [idea, setIdea] = useState(saved?.idea || { topic:"", platforms:["instagram"], type:"photo", inspirationSource:null });

  // Load an idea handed off from Inspiration ("→ Social Pipeline" button)
  useEffect(() => {
    if (!initialIdea) return;
    setIdea(i => ({ ...i, topic: initialIdea.title || i.topic, inspirationSource: initialIdea.source || null }));
    setStage("idea");
    if (onConsumedInitialIdea) onConsumedInitialIdea();
  }, [initialIdea]);

  // captions is keyed by platform id: { instagram: {text}, facebook: {text}, ... }
  const [captions, setCaptions] = useState(saved?.captions || {});
  const [hashtags, setHashtags] = useState(saved?.hashtags || { sets:null, selected:"" });
  const [imageData, setImageData] = useState(saved?.imageData || { prompt:"", url:null, imgProvider: resolveImageProvider(apiKeys) });
  const [schedule, setSchedule] = useState(saved?.schedule || { date:new Date().toISOString().split("T")[0], time:"09:00", status:"now" });
  const [publishResults, setPublishResults] = useState({});

  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error,   setError]   = useState("");
  const [success, setSuccess] = useState("");
  const [savedAt, setSavedAt] = useState(saved?.savedAt || null);

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };
  const btnA = { padding:"10px 24px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 };
  const btnS = { padding:"10px 20px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"var(--font-body)" };

  // Auto-save draft
  useEffect(() => {
    if (!idea.topic && Object.keys(captions).length === 0) return;
    const data = { stage, completed, idea, captions, hashtags, imageData: { ...imageData, url: imageData.url?.startsWith("https://") ? imageData.url : null }, schedule, savedAt:new Date().toISOString() };
    saveSocialPipelineDraft(data);
    setSavedAt(data.savedAt);
  }, [stage, completed, idea, captions, hashtags, imageData.prompt, imageData.imgProvider, schedule]);

  const markDone = (id) => setCompleted(c => c.includes(id) ? c : [...c, id]);
  const advance  = (next) => { setStage(next); setError(""); setSuccess(""); };

  const togglePlatform = (platId) => {
    setIdea(i => {
      const has = i.platforms.includes(platId);
      const next = has ? i.platforms.filter(p => p !== platId) : [...i.platforms, platId];
      return { ...i, platforms: next.length ? next : i.platforms }; // never allow empty
    });
  };

  const selectedPlatforms = PLATFORMS.filter(p => idea.platforms.includes(p.id));

  // ── STAGE 1: IDEA ───────────────────────────────────────────────────────────

  const useInspirationIdea = (item) => {
    setIdea(i => ({ ...i, topic: item.title, inspirationSource: item }));
  };

  const generateIdeaFromScratch = async () => {
    setLoading(true); setLoadMsg("Generating idea…"); setError("");
    try {
      const text = await callAI(activeProvider, activeModel,
        `You are a social strategist for Cask & Stream — a fly fishing and whiskey lifestyle brand. Suggest ONE compelling, specific social post idea. Return ONLY the topic/concept as a single sentence, nothing else.`,
        `Platforms: ${idea.platforms.join(", ")}. Suggest a fresh post idea that works across all of them.`,
        apiKeys[activeProvider]
      );
      setIdea(i => ({ ...i, topic: text.trim() }));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── STAGE 2: CAPTIONS (one per selected platform) ───────────────────────────

  // Strips any hashtags the AI includes despite instructions not to — hashtags
  // are handled entirely in the separate Hashtags stage, never in the caption itself.
  const stripHashtags = (text) => text
    .replace(/(?:^|\n)\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/g, "") // trailing hashtag line(s)
    .replace(/(?<!\S)#[^\s#]+/g, "") // any inline hashtag token
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const captionPromptFor = (plat) =>
    `You are the social voice for Cask & Stream — a fly fishing and whiskey lifestyle brand. Tagline: "Cast at Dawn. Sip at Dusk." Write ONLY the caption text, no explanation, no quotes around it. Tone: ${plat.tone || plat.label}. Format: ${plat.format || ""} Keep the caption itself under ${plat.charLimit} characters. Do NOT include any hashtags — hashtags are added separately in a later step, so the caption must have zero # tags.`;

  const generateCaptionFor = async (platId) => {
    if (!idea.topic.trim()) return;
    const plat = PLATFORMS.find(p => p.id === platId);
    setLoading(true); setLoadMsg(`Writing ${plat?.label} caption…`); setError("");
    try {
      const text = await callAI(activeProvider, activeModel,
        captionPromptFor(plat),
        `Write a ${platId} caption (post type: ${idea.type}) about: ${idea.topic}`,
        apiKeys[activeProvider]
      );
      setCaptions(c => ({ ...c, [platId]: { text: stripHashtags(text.trim()) } }));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  const generateAllCaptions = async () => {
    setLoading(true); setError("");
    for (const plat of selectedPlatforms) {
      setLoadMsg(`Writing ${plat.label} caption…`);
      try {
        const text = await callAI(activeProvider, activeModel,
          captionPromptFor(plat),
          `Write a ${plat.id} caption (post type: ${idea.type}) about: ${idea.topic}`,
          apiKeys[activeProvider]
        );
        setCaptions(c => ({ ...c, [plat.id]: { text: stripHashtags(text.trim()) } }));
      } catch(e) { setError(`${plat.label}: ${e.message}`); }
    }
    setLoading(false); setLoadMsg("");
  };

  // ── STAGE 3: HASHTAGS (shared across platforms) ─────────────────────────────

  const generateHashtagsForPost = async () => {
    setLoading(true); setLoadMsg("Optimizing hashtags…"); setError("");
    try {
      const text = await callAI(activeProvider, activeModel,
        `You are a hashtag strategist for Cask & Stream. Return ONLY valid JSON (no fences): {"primary":[{"tag":"#tag1","score":85}],"niche":[{"tag":"#tag1","score":40}],"branded":[{"tag":"#CaskAndStream","score":20}],"full_set":"all hashtags as one space-separated string"}. primary=5 tags, niche=6 tags, branded=2-3 tags. "score" is your best estimate of reach potential from 1-100 (higher = broader audience but more competition to be seen; lower = smaller but more targeted audience).`,
        `Topic: ${idea.topic}\nPlatforms: ${idea.platforms.join(", ")}`,
        apiKeys[activeProvider]
      );
      const parsed = parseAIJson(text);
      // Normalize to {tag, score} objects — tolerate the AI occasionally returning plain strings
      for (const key of ["primary","niche","branded"]) {
        if (Array.isArray(parsed[key])) {
          parsed[key] = parsed[key].map(t => typeof t === "string" ? { tag: t, score: null } : { tag: t.tag, score: typeof t.score === "number" ? t.score : null });
        }
      }
      setHashtags({ sets: parsed, selected: parsed.full_set || "" });
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // Tolerates both the new {tag,score} shape and legacy plain-string entries from
  // previously-saved in-progress drafts.
  const tagText = (t) => typeof t === "string" ? t : t?.tag;
  const scoreColor = (score) => score == null ? "var(--muted)" : score >= 70 ? "#5cba6c" : score >= 40 ? "var(--amber)" : "#7c9ce0";

  // ── STAGE 4: IMAGE (shared across platforms) ────────────────────────────────

  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imageDraftPrompt, setImageDraftPrompt] = useState("");

  const openImagePromptPreview = async () => {
    setLoading(true); setLoadMsg("Writing image prompt…"); setError("");
    try {
      const aiPrompt = imageData.prompt || await generateImagePrompt(idea.topic, selectedPlatforms[0]?.id || "instagram", activeProvider, activeModel, apiKeys[activeProvider]);
      setImageDraftPrompt(aiPrompt);
      setImagePreviewOpen(true);
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  const generateSocialPipelineImage = async (finalPrompt) => {
    setImagePreviewOpen(false);
    setLoading(true); setLoadMsg(`Generating with ${getImageProviderLabel(imageData.imgProvider)}…`); setError("");
    try {
      setImageData(d => ({ ...d, prompt: finalPrompt }));
      const url = await generateImage(finalPrompt, selectedPlatforms[0]?.id || "instagram", apiKeys, imageData.imgProvider);
      setImageData(d => ({ ...d, prompt: finalPrompt, url }));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  const regenerateImageWithPrompt = async () => {
    setLoading(true); setLoadMsg("Generating image…"); setError("");
    try {
      const url = await generateImage(imageData.prompt, selectedPlatforms[0]?.id || "instagram", apiKeys, imageData.imgProvider);
      setImageData(d => ({ ...d, url }));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── STAGE 5: PUBLISH (one pass per selected platform) ───────────────────────

  const [scheduleMode, setScheduleMode] = useState("now"); // "now" | "schedule" | "draft"
  const [scheduleDate, setScheduleDate] = useState(() => {
    const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0);
    return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM" for datetime-local input
  });

  const buildSocialPostRecord = (status, scheduledAt = null) => createSocialPost({
    platforms: idea.platforms,
    captions,
    hashtags: hashtags.selected,
    imageUrl: imageData.url,
    imagePrompt: imageData.prompt,
    scheduledAt,
    status,
  });

  const handleSaveAsDraft = async () => {
    setLoading(true); setError(""); setLoadMsg("Saving draft…");

    // Same fix as handleSchedule() — blob:/data: URLs only exist in this browser
    // tab and are meaningless once read back later (e.g. from Social Posts, or
    // if this draft later gets scheduled/published). This was the actual bug
    // behind "image doesn't stay with the caption" — Save as Draft never
    // uploaded the image at all, unlike Schedule.
    let finalImageUrl = imageData.url;
    let imageWarning = "";
    if (finalImageUrl?.startsWith("blob:") || finalImageUrl?.startsWith("data:")) {
      setLoadMsg("Uploading image to cloud…");
      try {
        finalImageUrl = await ensurePublicImageUrl(finalImageUrl);
      } catch(e) {
        finalImageUrl = null; // don't save an unusable blob:/data: reference
        imageWarning = ` Note: the image couldn't be uploaded (${e.message}) — this draft was saved without it. Re-add it before scheduling or publishing.`;
      }
    }

    const post = buildSocialPostRecord("draft");
    post.imageUrl = finalImageUrl;
    if (onSaveSocialPost) onSaveSocialPost(post);
    setSuccess(`✓ Saved as draft — find it in Social Posts tab.${imageWarning}`);
    markDone("publish");
    clearSocialPipelineDraft();
    setLoading(false); setLoadMsg("");
  };

  const handleSchedule = async () => {
    setLoading(true); setError(""); setLoadMsg("Preparing post…");

    // Ensure image is on a public https:// URL before scheduling — blob:/data:
    // URLs only exist in this browser tab and are meaningless to the server-side
    // cron job that actually publishes the post later. Uses the same robust
    // helper as immediate Facebook/Instagram publishing (handles size limits,
    // throws real errors instead of silently failing).
    let finalImageUrl = imageData.url;
    if (finalImageUrl?.startsWith("blob:") || finalImageUrl?.startsWith("data:")) {
      setLoadMsg("Uploading image to cloud…");
      try {
        finalImageUrl = await ensurePublicImageUrl(finalImageUrl);
      } catch(e) {
        setError(`Couldn't upload the image, so this post was NOT scheduled (an image-less post would silently fail to attach later): ${e.message}. Try again, or remove the image and schedule without one.`);
        setLoading(false); setLoadMsg("");
        return; // STOP — never save a scheduled post referencing an unusable blob:/data: URL
      }
    }

    const post = buildSocialPostRecord("scheduled", scheduleDate);
    post.imageUrl = finalImageUrl; // use public URL
    if (onSaveSocialPost) onSaveSocialPost(post);
    setSuccess(`✓ Scheduled for ${new Date(scheduleDate).toLocaleString([], {dateStyle:"medium",timeStyle:"short"})}`);
    markDone("publish");
    clearSocialPipelineDraft();
    setLoading(false); setLoadMsg("");
  };

  const handlePublish = async () => {
    setLoading(true); setError(""); setSuccess(""); setPublishResults({});
    const results = {};
    const bufferCfg = loadBufferConfig();

    for (const plat of selectedPlatforms) {
      const captionText = captions[plat.id]?.text || "";
      const fullMessage = [captionText, limitHashtagsForPlatform(hashtags.selected, plat.id)].filter(Boolean).join("\n\n");
      setLoadMsg(`Publishing to ${plat.label}…`);

      try {
        if (plat.id === "facebook" && metaConfig?.connected && metaConfig?.pages?.length > 0) {
          const page = metaConfig.pages[0];
          const res = await metaPost({ pageId: page.id, pageToken: page.access_token, message: fullMessage, imageUrl: imageData.url, platforms: ["facebook"] });
          if (!res.facebook?.success) throw new Error(res.facebook?.error || "Facebook post failed");
          results[plat.id] = { success: true, message: "✓ Posted to Facebook" };

        } else if (plat.id === "instagram" && metaConfig?.connected && metaConfig?.pages?.some(p=>p.instagram_id)) {
          if (!imageData.url) throw new Error("Instagram requires an image");
          const page = metaConfig.pages.find(p => p.instagram_id);
          const res = await metaPost({ pageId: page.id, pageToken: page.access_token, instagramId: page.instagram_id, message: fullMessage, imageUrl: imageData.url, platforms: ["instagram"] });
          if (!res.instagram?.success) throw new Error(res.instagram?.error || "Instagram post failed");
          results[plat.id] = { success: true, message: "✓ Posted to Instagram" };

        } else if (bufferCfg?.connected && bufferCfg?.mapping?.[plat.id]) {
          if (!tierConfig.buffer) {
            throw new Error(`Buffer integration is available on Operative and above — upgrade in Settings → Billing & Plan to post to ${plat.label}.`);
          }
          // Buffer platforms — image must be a public https:// URL
          let publicImageUrl = imageData.url;

          if (publicImageUrl?.startsWith("blob:") || publicImageUrl?.startsWith("data:")) {
            setLoadMsg(`Uploading image to cloud for ${plat.label}…`);
            publicImageUrl = await ensurePublicImageUrl(publicImageUrl); // throws on real failure — caught below, surfaced clearly instead of silently posting without the image
          }

          const channelId = bufferCfg.mapping[plat.id];
          if (plat.id === "pinterest" && !bufferCfg.boardMapping?.[channelId]) {
            throw new Error("No Pinterest board selected — set one in Settings → Buffer before posting to Pinterest.");
          }
          setLoadMsg(`Publishing to ${plat.label} via Buffer…`);
          const res = await fetch("/api/buffer-post", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              apiKey:    bufferCfg.apiKey,
              action:    "createPost",
              channelId,
              text:      fullMessage,
              imageUrl:  publicImageUrl || "",
              scheduledAt: null,
              pinterestBoardId: plat.id === "pinterest" ? bufferCfg.boardMapping?.[channelId] : undefined,
            }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          results[plat.id] = { success: true, message: `✓ Sent to Buffer → ${plat.label}` };

        } else {
          results[plat.id] = { success: "manual", message: `Not connected — copy & paste manually` };
        }
      } catch(e) {
        results[plat.id] = { success: false, message: e.message };
      }
      setPublishResults({ ...results });
    }

    const manualPlat = selectedPlatforms.find(p => results[p.id]?.success === "manual");
    if (manualPlat) navigator.clipboard.writeText(`${captions[manualPlat.id]?.text || ""}\n\n${hashtags.selected}`);

    const allOk = selectedPlatforms.every(p => results[p.id]?.success === true || results[p.id]?.success === "manual");
    if (allOk) {
      const post = buildSocialPostRecord("published");
      post.publishedAt = new Date().toISOString();
      post.results = results;
      if (onSaveSocialPost) onSaveSocialPost(post);
      setSuccess(`Done! ${selectedPlatforms.length > 1 ? `Processed ${selectedPlatforms.length} platforms.` : ""}`);
      markDone("publish");
      clearSocialPipelineDraft();
    } else {
      setError("Some platforms failed — see results below. You can retry.");
    }
    setLoading(false); setLoadMsg("");
  };

  const resetPipeline = () => {
    clearSocialPipelineDraft();
    setStage("idea"); setCompleted([]); setError(""); setSuccess(""); setSavedAt(null); setPublishResults({});
    setIdea({ topic:"", platforms:["instagram"], type:"photo", inspirationSource:null });
    setCaptions({});
    setHashtags({ sets:null, selected:"" });
    setImageData({ prompt:"", url:null, imgProvider: resolveImageProvider(apiKeys) });
  };

  const allCaptionsReady = selectedPlatforms.length > 0 && selectedPlatforms.every(p => captions[p.id]?.text?.trim());

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Social Pipeline</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>
            From idea to published — across as many platforms as you like, at once.
            {savedAt && <span style={{ color:"var(--green)", marginLeft:8, fontSize:11 }}>✓ Draft auto-saved {new Date(savedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>}
          </p>
        </div>
        {(completed.length > 0 || idea.topic) && (
          <button onClick={resetPipeline} style={btnS}>↺ New Post</button>
        )}
      </div>

      <SocialPipelineProgress stage={stage} setStage={setStage} completed={completed} />

      {error   && <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:13 }}>{error}</div>}
      {success && <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:8, background:"#5cba6c11", border:"1px solid #5cba6c33", color:"#5cba6c", fontSize:13 }}>{success}</div>}
      {loading && (
        <div style={{ marginBottom:16, padding:"12px 16px", borderRadius:8, background:"var(--amber-glow)", border:"1px solid var(--amber)44", display:"flex", alignItems:"center", gap:10, fontSize:13, color:"var(--amber)" }}>
          <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
          {loadMsg || "Working…"}
        </div>
      )}

      {/* ── STAGE 1: IDEA ── */}
      {stage === "idea" && (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
            <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:"0 0 16px" }}>What's the post about?</h3>

            <div style={{ marginBottom:16 }}>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                Platforms <span style={{ fontWeight:400, textTransform:"none", letterSpacing:0 }}>— select one or more</span>
              </label>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {PLATFORMS.map(p => {
                  const isSelected = idea.platforms.includes(p.id);
                  const isLocked   = !tierConfig.socialPlatforms.includes(p.id);
                  return (
                    <button key={p.id} onClick={() => !isLocked && togglePlatform(p.id)}
                      disabled={isLocked}
                      title={isLocked ? "Available on Operative and above (via Buffer)" : undefined}
                      style={{ padding:"7px 16px", borderRadius:99, border:isSelected?`1px solid ${p.color}`:"1px solid var(--border)", background:isSelected?p.color+"18":"transparent", color:isLocked?"var(--muted)":(isSelected?p.color:"var(--text-secondary)"), fontSize:12, fontWeight:600, cursor:isLocked?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6, opacity:isLocked?0.5:1 }}>
                      {isLocked ? (
                        <span style={{ fontSize:11 }}>🔒</span>
                      ) : (
                        <span style={{ width:14, height:14, borderRadius:4, border:`2px solid ${isSelected?p.color:"var(--border)"}`, background:isSelected?p.color:"transparent", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:9, color:"#fff" }}>
                          {isSelected ? "✓" : ""}
                        </span>
                      )}
                      <span>{p.icon}</span>{p.label}
                    </button>
                  );
                })}
              </div>
              {!tierConfig.buffer && (
                <div style={{ fontSize:11, color:"var(--muted)", marginTop:8 }}>
                  🔒 TikTok, X, Pinterest, and Reddit need Buffer, available on Operative and above.
                </div>
              )}
              {idea.platforms.length > 1 && (
                <div style={{ fontSize:11, color:"var(--amber)", marginTop:8 }}>
                  ✦ {idea.platforms.length} platforms selected — you'll get a tailored caption for each, one shared image, and a one-click multi-publish at the end.
                </div>
              )}
            </div>

            <div style={{ marginBottom:16 }}>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Post Type</label>
              <div style={{ display:"flex", gap:6 }}>
                {["photo","reel","carousel","story"].map(t => (
                  <button key={t} onClick={() => setIdea(i => ({...i, type:t}))}
                    style={{ padding:"6px 14px", borderRadius:99, border:idea.type===t?"1px solid var(--amber)":"1px solid var(--border)", background:idea.type===t?"var(--amber-glow)":"transparent", color:idea.type===t?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", textTransform:"capitalize" }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Topic / Concept *</label>
              <div style={{ display:"flex", gap:10 }}>
                <input style={iS} placeholder="e.g. golden hour on the river, pouring bourbon by the fire…" value={idea.topic} onChange={e=>setIdea(i=>({...i,topic:e.target.value}))} autoFocus
                  onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                <button onClick={generateIdeaFromScratch} disabled={loading}
                  style={{ padding:"10px 16px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)", whiteSpace:"nowrap" }}>
                  ✦ Surprise Me
                </button>
              </div>
            </div>
          </div>

          {/* Inspiration board quick-select */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>Use from Inspiration Board</div>
            <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:240, overflow:"auto" }}>
              {inspiration.length === 0 && (
                <div style={{ fontSize:12, color:"var(--muted)", padding:"8px 0" }}>No inspiration saved yet — use Research or Post Ideas tabs to add some.</div>
              )}
              {inspiration.map(item => (
                <button key={item.id} onClick={() => useInspirationIdea(item)}
                  style={{ padding:"10px 14px", borderRadius:8, border:idea.inspirationSource?.id===item.id?"1px solid var(--amber)":"1px solid var(--border)", background:idea.inspirationSource?.id===item.id?"var(--amber-glow)":"var(--bg-elevated)", color:"var(--text)", fontSize:12, cursor:"pointer", textAlign:"left", fontFamily:"var(--font-body)" }}>
                  <div style={{ fontWeight:600, marginBottom:2 }}>{item.title}</div>
                  <div style={{ fontSize:10, color:"var(--muted)" }}>{item.source}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={() => { markDone("idea"); advance("caption"); }} disabled={!idea.topic.trim()}
              style={{ ...btnA, background:idea.topic.trim()?"var(--amber)":"var(--bg-elevated)", color:idea.topic.trim()?"#0e0f11":"var(--muted)", cursor:idea.topic.trim()?"pointer":"not-allowed" }}>
              Continue to Caption{idea.platforms.length>1?"s":""} →
            </button>
          </div>
        </div>
      )}

      {/* ── STAGE 2: CAPTIONS ── */}
      {stage === "caption" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {selectedPlatforms.length > 1 && (
            <div style={{ display:"flex", justifyContent:"flex-end" }}>
              <button onClick={generateAllCaptions} disabled={loading}
                style={{ padding:"9px 20px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":provider.color, color:loading?"var(--muted)":"#0e0f11", fontSize:12, fontWeight:700, cursor:loading?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
                {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : `${provider.logo} Write All ${selectedPlatforms.length} Captions`}
              </button>
            </div>
          )}

          {selectedPlatforms.map(plat => (
            <div key={plat.id} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
                <div>
                  <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:plat.color }}>{plat.icon} {plat.label}</div>
                  <div style={{ fontSize:12, color:"var(--text-secondary)", marginTop:2 }}>{idea.topic}</div>
                </div>
                <button onClick={() => generateCaptionFor(plat.id)} disabled={loading}
                  style={{ padding:"9px 20px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":provider.color, color:loading?"var(--muted)":"#0e0f11", fontSize:12, fontWeight:700, cursor:loading?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
                  {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>…</> : captions[plat.id]?.text ? "↻ Regenerate" : `${provider.logo} Write Caption`}
                </button>
              </div>
              <textarea value={captions[plat.id]?.text || ""} onChange={e=>setCaptions(c=>({...c,[plat.id]:{text:e.target.value}}))} rows={5}
                placeholder="Caption will appear here — or write your own…"
                style={{ ...iS, resize:"vertical", lineHeight:1.7, borderColor:(captions[plat.id]?.text||"").length > plat.charLimit ? "var(--red)" : undefined }} />
              {(() => {
                const len = (captions[plat.id]?.text || "").length;
                const over = len > plat.charLimit;
                return (
                  <div style={{ fontSize:11, color: over ? "var(--red)" : "var(--muted)", marginTop:6, textAlign:"right", fontWeight: over ? 700 : 400 }}>
                    {over && "⚠ "}{len}{plat.charLimit < 40000 ? ` / ${plat.charLimit}` : ""} characters{over ? ` — over by ${len - plat.charLimit}` : ""}
                  </div>
                );
              })()}
            </div>
          ))}

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={() => { markDone("caption"); advance("hashtags"); }} disabled={!allCaptionsReady}
              style={{ ...btnA, background:allCaptionsReady?"var(--amber)":"var(--bg-elevated)", color:allCaptionsReady?"#0e0f11":"var(--muted)", cursor:allCaptionsReady?"pointer":"not-allowed" }}>
              Continue to Hashtags →
            </button>
            <button onClick={() => setStage("idea")} style={btnS}>← Back to Idea</button>
          </div>
        </div>
      )}

      {/* ── STAGE 3: HASHTAGS ── */}
      {stage === "hashtags" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {!hashtags.sets ? (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:32, textAlign:"center" }}>
              <div style={{ fontSize:32, marginBottom:12 }}>#</div>
              <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, marginBottom:8 }}>Optimize Your Hashtags</h3>
              <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:24, maxWidth:400, margin:"0 auto 24px" }}>
                One shared hashtag set, generated to work across {selectedPlatforms.map(p=>p.label).join(", ")}.
              </p>
              <button onClick={generateHashtagsForPost} disabled={loading} style={btnA}>
                {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : "# Generate Hashtags"}
              </button>
            </div>
          ) : (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:16 }}>

              {/* Clickable tag groups */}
              {[
                { key:"primary", label:"High Volume",  color:"var(--amber)", hint:"Broad reach" },
                { key:"niche",   label:"Niche",         color:"#5cba6c",      hint:"Targeted audience" },
                { key:"branded", label:"Branded",       color:"#7c3aed",      hint:"Your brand tags" },
              ].map(g => (
                <div key={g.key}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                    <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:g.color }}>{g.label}</span>
                    <span style={{ fontSize:10, color:"var(--muted)" }}>— {g.hint} · click to add/remove</span>
                    <button onClick={() => {
                      // Select all in this group
                      const all = (hashtags.sets[g.key] || []).map(tagText);
                      const current = hashtags.selected.split(/\s+/).filter(Boolean);
                      const allSelected = all.every(t => current.includes(t));
                      const next = allSelected
                        ? current.filter(t => !all.includes(t))
                        : [...new Set([...current, ...all])];
                      setHashtags(h => ({...h, selected: next.join(" ")}));
                    }}
                      style={{ marginLeft:"auto", padding:"2px 8px", borderRadius:6, border:`1px solid ${g.color}44`, background:"transparent", color:g.color, fontSize:10, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      {(() => {
                        const all = (hashtags.sets[g.key] || []).map(tagText);
                        const current = hashtags.selected.split(/\s+/).filter(Boolean);
                        return all.every(t => current.includes(t)) ? "Deselect All" : "Select All";
                      })()}
                    </button>
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    {hashtags.sets[g.key]?.map((entry, i) => {
                      const tag = tagText(entry);
                      const score = typeof entry === "object" ? entry.score : null;
                      const selected = hashtags.selected.split(/\s+/).includes(tag);
                      return (
                        <button key={i} onClick={() => {
                          const current = hashtags.selected.split(/\s+/).filter(Boolean);
                          const next = selected
                            ? current.filter(t => t !== tag)
                            : [...current, tag];
                          setHashtags(h => ({...h, selected: next.join(" ")}));
                        }}
                          title={score != null ? `Reach score: ${score}/100` : undefined}
                          style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:12, padding:"5px 10px 5px 12px", borderRadius:99, border:`1px solid ${selected ? g.color : g.color+"33"}`, background:selected ? g.color+"20" : "transparent", color:selected ? g.color : "var(--text-secondary)", cursor:"pointer", fontFamily:"var(--font-body)", fontWeight:selected ? 700 : 400, transition:"all 0.15s" }}>
                          {selected && <span style={{ fontSize:10 }}>✓</span>}{tag}
                          {score != null && (
                            <span style={{ fontSize:9, fontWeight:700, padding:"1px 5px", borderRadius:99, background:scoreColor(score)+"22", color:scoreColor(score) }}>{score}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Per-platform hashtag limits */}
              {(() => {
                const count = hashtags.selected.split(/\s+/).filter(Boolean).length;
                const warnings = selectedPlatforms
                  .filter(p => p.hashtagLimit > 0 && count > p.hashtagLimit)
                  .map(p => `${p.label}: ${count}/${p.hashtagLimit} (over by ${count - p.hashtagLimit})`);
                const infos = selectedPlatforms
                  .filter(p => p.hashtagLimit > 0 && count <= p.hashtagLimit)
                  .map(p => `${p.label}: ${count}/${p.hashtagLimit}`);
                return (
                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                    {warnings.length > 0 && (
                      <div style={{ padding:"8px 12px", borderRadius:7, background:"var(--red)11", border:"1px solid var(--red)33", fontSize:11, color:"var(--red)" }}>
                        ⚠ Over limit: {warnings.join(" · ")}
                      </div>
                    )}
                    <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                      {selectedPlatforms.filter(p => p.hashtagLimit >= 0).map(p => {
                        const isOver = p.hashtagLimit > 0 && count > p.hashtagLimit;
                        const isNone = p.hashtagLimit === 0;
                        return (
                          <span key={p.id} style={{ fontSize:10, padding:"2px 8px", borderRadius:99, background:isOver?"var(--red)15":isNone?"var(--bg-elevated)":"#5cba6c15", color:isOver?"var(--red)":isNone?"var(--muted)":"#5cba6c", border:`1px solid ${isOver?"var(--red)33":isNone?"var(--border)":"#5cba6c33"}`, fontWeight:600 }}>
                            {p.icon} {p.label}: {isNone ? "no hashtags" : `${count}/${p.hashtagLimit}`}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Selected set count + clear */}
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                <span style={{ fontSize:12, color:"var(--text-secondary)", flex:1 }}>
                  {hashtags.selected.split(/\s+/).filter(Boolean).length} hashtags selected
                </span>
                <button onClick={() => setHashtags(h => ({...h, selected:""}))}
                  style={{ padding:"3px 10px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--muted)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  Clear all
                </button>
                <button onClick={() => {
                  const all = [...(hashtags.sets.primary||[]),...(hashtags.sets.niche||[]),...(hashtags.sets.branded||[])].map(tagText);
                  setHashtags(h => ({...h, selected: [...new Set(all)].join(" ")}));
                }}
                  style={{ padding:"3px 10px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--muted)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  Select all
                </button>
              </div>

              {/* Editable final set */}
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
                  Final Set <span style={{ fontWeight:400, textTransform:"none", letterSpacing:0 }}>— editable, added to every caption</span>
                </label>
                <textarea value={hashtags.selected} onChange={e=>setHashtags(h=>({...h,selected:e.target.value}))} rows={3}
                  style={{ ...iS, resize:"vertical", fontSize:12, lineHeight:1.6 }} />
              </div>

              <button onClick={generateHashtagsForPost} disabled={loading}
                style={{ padding:"5px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)", alignSelf:"flex-start" }}>
                ↻ Re-generate suggestions
              </button>
            </div>
          )}
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={() => { markDone("hashtags"); advance("image"); }} style={btnA}>Continue to Image →</button>
            <button onClick={() => setStage("caption")} style={btnS}>← Back to Captions</button>
          </div>
        </div>
      )}

      {/* ── STAGE 4: IMAGE ── */}
      {stage === "image" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:10 }}>
              <div>
                <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:0 }}>Visual</h3>
                <p style={{ fontSize:11, color:"var(--text-secondary)", margin:"4px 0 0" }}>One shared image for: {selectedPlatforms.map(p=>p.label).join(", ")}</p>
              </div>
              <ImageProviderPicker apiKeys={apiKeys} value={imageData.imgProvider} onChange={(id)=>{ setImageData(d=>({...d,imgProvider:id})); saveImageProviderPref(id); }} compact />
            </div>

            {!imageData.url && !loading && (
              <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:14 }}>
                {/* Generate option */}
                <div style={{ height:130, borderRadius:10, border:"1px dashed var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:10 }}>
                  <span style={{ fontSize:24, opacity:0.3 }}>▣</span>
                  <button onClick={openImagePromptPreview} disabled={!imageData.imgProvider}
                    style={{ padding:"8px 20px", borderRadius:8, border:"none", background:imageData.imgProvider?"#7c3aed":"var(--bg-elevated)", color:imageData.imgProvider?"#fff":"var(--muted)", fontSize:12, fontWeight:700, cursor:imageData.imgProvider?"pointer":"not-allowed", fontFamily:"var(--font-body)" }}>
                    ▣ Generate Image
                  </button>
                </div>

                {/* Library picker */}
                <LibraryImagePicker onSelect={(url) => setImageData(d=>({...d, url, prompt:"from library"}))} />
              </div>
            )}

            {imageData.url && (
              <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:14 }}>
                <div style={{ position:"relative", borderRadius:10, overflow:"hidden", border:"1px solid var(--border)" }}>
                  <img src={imageData.url} alt="" style={{ width:"100%", display:"block" }} />
                  <div style={{ position:"absolute", bottom:10, right:10, display:"flex", gap:6 }}>
                    <button onClick={()=>{ const a=document.createElement("a"); a.href=imageData.url; a.download=`social-post-${Date.now()}.jpg`; a.click(); }}
                      style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.75)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      ↓ Download
                    </button>
                    <button onClick={regenerateImageWithPrompt}
                      style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.75)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      ↻ New
                    </button>
                    <button onClick={() => setImageData(d=>({...d,url:null,prompt:""}))}
                      style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.75)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      ✕ Remove
                    </button>
                    <SaveToLibraryButton imageUrl={imageData.url} tags={[...idea.platforms, "generated"]} name={idea.topic?.slice(0,30) || "social-post"} userId={window.__bbUserId || "anonymous"} />
                  </div>
                </div>
                {/* Allow swapping even with image selected */}
                <LibraryImagePicker onSelect={(url) => setImageData(d=>({...d, url, prompt:"from library"}))} compact />
              </div>
            )}

            {imageData.url && imageData.prompt && imageData.prompt !== "from library" && (
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Prompt (editable)</label>
                <div style={{ display:"flex", gap:8 }}>
                  <textarea value={imageData.prompt} onChange={e=>setImageData(d=>({...d,prompt:e.target.value}))} rows={2}
                    style={{ ...iS, resize:"vertical", fontSize:12 }} />
                  <button onClick={regenerateImageWithPrompt} disabled={loading}
                    style={{ padding:"8px 14px", borderRadius:8, border:"none", background:"#7c3aed", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", alignSelf:"flex-start", whiteSpace:"nowrap" }}>
                    Run →
                  </button>
                </div>
              </div>
            )}
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={() => { markDone("image"); advance("publish"); }} style={btnA}>Continue to Publish →</button>
            <button onClick={() => setStage("hashtags")} style={btnS}>← Back to Hashtags</button>
          </div>
        </div>
      )}

      {imagePreviewOpen && (
        <PromptPreviewModal
          title="Review Image Prompt"
          systemPrompt={null}
          userPrompt={imageDraftPrompt}
          onUserChange={setImageDraftPrompt}
          confirmLabel="Generate Image"
          accentColor="#7c3aed"
          onCancel={() => setImagePreviewOpen(false)}
          onConfirm={() => generateSocialPipelineImage(imageDraftPrompt)}
        />
      )}

      {/* ── STAGE 5: PUBLISH ── */}
      {stage === "publish" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {success ? (
            <div style={{ background:"var(--bg-surface)", border:"1px solid #5cba6c44", borderRadius:12, padding:40, textAlign:"center" }}>
              <div style={{ fontSize:48, marginBottom:16 }}>✓</div>
              <h3 style={{ fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, marginBottom:8 }}>Done!</h3>
              <p style={{ fontSize:14, color:"var(--text-secondary)", marginBottom:20 }}>{success}</p>
              <div style={{ display:"flex", flexDirection:"column", gap:8, maxWidth:380, margin:"0 auto 24px" }}>
                {selectedPlatforms.map(plat => publishResults[plat.id] && (
                  <div key={plat.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", textAlign:"left" }}>
                    <span>{plat.icon}</span>
                    <span style={{ fontSize:12, fontWeight:600, flex:1 }}>{plat.label}</span>
                    <span style={{ fontSize:11, color:publishResults[plat.id].success===true?"#5cba6c":publishResults[plat.id].success==="manual"?"var(--amber)":"var(--red)" }}>
                      {publishResults[plat.id].message}
                    </span>
                  </div>
                ))}
              </div>
              <button onClick={resetPipeline} style={btnA}>Start New Post</button>
            </div>
          ) : (
            <>
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24 }}>
                <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:"0 0 20px" }}>Review & Publish — {selectedPlatforms.length} Platform{selectedPlatforms.length>1?"s":""}</h3>

                <div style={{ display:"flex", flexDirection:"column", gap:14, marginBottom:20 }}>
                  {selectedPlatforms.map(plat => {
                    const bufferCfg = loadBufferConfig();
                    const isMetaConnected = (plat.id==="facebook" && metaConfig?.connected && metaConfig?.pages?.length>0) ||
                                           (plat.id==="instagram" && metaConfig?.connected && metaConfig?.pages?.some(p=>p.instagram_id));
                    const isBufferConnected = bufferCfg?.connected && !!bufferCfg?.mapping?.[plat.id];
                    const isConnected = isMetaConnected || isBufferConnected;
                    const connectionLabel = isMetaConnected ? "● Direct" : isBufferConnected ? "● Buffer" : "Manual";
                    const connectionColor = isMetaConnected ? "#5cba6c" : isBufferConnected ? "#1da1f2" : "var(--muted)";
                    const prevResult = publishResults[plat.id];
                    return (
                      <div key={plat.id} style={{ display:"grid", gridTemplateColumns: imageData.url ? "auto 1fr 120px" : "auto 1fr", gap:14, alignItems:"flex-start", padding:14, borderRadius:10, background:"var(--bg-elevated)", border:`1px solid ${isConnected?"#5cba6c33":"var(--border)"}` }}>
                        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4, width:70 }}>
                          <span style={{ fontSize:20 }}>{plat.icon}</span>
                          <span style={{ fontSize:10, fontWeight:700, color:plat.color }}>{plat.label}</span>
                          <span style={{ fontSize:9, color:connectionColor, fontWeight:600 }}>{connectionLabel}</span>
                        </div>
                        <div style={{ fontSize:12, lineHeight:1.6, whiteSpace:"pre-wrap", color:"var(--text-secondary)" }}>
                          {captions[plat.id]?.text}
                          {hashtags.selected && <div style={{ marginTop:6, color:"var(--amber)" }}>{hashtags.selected}</div>}
                          {prevResult && (
                            <div style={{ marginTop:8, fontSize:11, color:prevResult.success===true?"#5cba6c":prevResult.success==="manual"?"var(--amber)":"var(--red)" }}>
                              {prevResult.message}
                            </div>
                          )}
                        </div>
                        {imageData.url && <img src={imageData.url} alt="" style={{ width:"100%", borderRadius:8, border:"1px solid var(--border)" }} />}
                      </div>
                    );
                  })}
                </div>

                {(() => {
                  const bufferCfg = loadBufferConfig();
                  const hasMetaDirect = selectedPlatforms.some(p => (p.id==="facebook"||p.id==="instagram") && metaConfig?.connected);
                  const hasBuffer = selectedPlatforms.some(p => !["facebook","instagram"].includes(p.id) && bufferCfg?.connected && bufferCfg?.mapping?.[p.id]);
                  const hasManual = selectedPlatforms.some(p => {
                    const isMeta = (p.id==="facebook"&&metaConfig?.connected) || (p.id==="instagram"&&metaConfig?.connected);
                    const isBuffer = bufferCfg?.connected && bufferCfg?.mapping?.[p.id];
                    return !isMeta && !isBuffer;
                  });
                  return (
                    <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:12, color:"var(--text-secondary)", lineHeight:1.7 }}>
                      {hasMetaDirect && <div>● <strong style={{color:"var(--text)"}}>Facebook/Instagram</strong> — posts directly</div>}
                      {hasBuffer     && <div style={{color:"#1da1f2"}}>● <strong>Buffer platforms</strong> — adds to Buffer queue immediately</div>}
                      {hasManual     && <div style={{color:"var(--amber)"}}>⚠ Some platforms not connected — caption copied to clipboard for manual posting. Connect in <strong>Settings → Buffer</strong>.</div>}
                    </div>
                  );
                })()}

                {/* Combined caption + hashtags character limit check */}
                {(() => {
                  const overs = selectedPlatforms
                    .map(p => {
                      const captionText = captions[p.id]?.text || "";
                      const combined = [captionText, limitHashtagsForPlatform(hashtags.selected, p.id)].filter(Boolean).join("\n\n");
                      return { p, len: combined.length };
                    })
                    .filter(({ p, len }) => len > p.charLimit);
                  if (overs.length === 0) return null;
                  return (
                    <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", fontSize:12, color:"var(--red)", fontWeight:600 }}>
                      ⚠ Caption + hashtags together are over the limit for: {overs.map(({p,len}) => `${p.label} (${len}/${p.charLimit})`).join(", ")}. Trim the caption or select fewer hashtags before posting.
                    </div>
                  );
                })()}

                {/* Best post times */}
                <div style={{ background:"var(--bg-elevated)", border:"1px solid #5cba6c33", borderRadius:10, padding:14 }}>
                  <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#5cba6c", marginBottom:10 }}>⏰ Best Times to Post</div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:8 }}>
                    {selectedPlatforms.map(p => (
                      <div key={p.id} style={{ padding:"8px 10px", borderRadius:7, background:"var(--bg-surface)", border:"1px solid var(--border)" }}>
                        <div style={{ fontSize:11, fontWeight:700, color:p.color, marginBottom:3 }}>{p.icon} {p.label}</div>
                        {(p.bestTimes||[]).map((t,i) => (
                          <div key={i} style={{ fontSize:11, color:"var(--text-secondary)" }}>· {t}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:8 }}>
                    These are general best times for lifestyle/outdoor content. Your audience analytics may differ — check Analytics → Social for your specific peak times.
                  </div>
                </div>

                {/* Action mode selector */}
                <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:18 }}>
                  <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>When to post?</div>
                  <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                    {[["now","↑ Publish Now","#5cba6c"],["schedule","⏰ Schedule","var(--amber)"],["draft","📋 Save as Draft","var(--text-secondary)"]].map(([id,label,color]) => (
                      <button key={id} onClick={() => setScheduleMode(id)}
                        style={{ padding:"7px 16px", borderRadius:8, border:scheduleMode===id?`1px solid ${color}`:"1px solid var(--border)", background:scheduleMode===id?color+"18":"transparent", color:scheduleMode===id?color:"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {scheduleMode === "schedule" && (
                    <div style={{ marginBottom:14 }}>
                      <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Schedule Date & Time</label>
                      <input type="datetime-local" value={scheduleDate} onChange={e=>setScheduleDate(e.target.value)}
                        style={{ padding:"8px 12px", borderRadius:8, border:"1px solid var(--amber)44", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none" }} />
                      <p style={{ fontSize:11, color:"var(--text-secondary)", margin:"6px 0 0", lineHeight:1.5 }}>
                        Blog Bunker will remind you when it's time to post. Auto-publishing from the web is coming soon.
                      </p>
                    </div>
                  )}

                  {scheduleMode === "draft" && (
                    <p style={{ fontSize:12, color:"var(--text-secondary)", margin:"0 0 14px", lineHeight:1.5 }}>
                      Save everything — captions, hashtags, image — to Social Posts. Come back and publish anytime.
                    </p>
                  )}

                  <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                    {scheduleMode === "now" && (
                      <button onClick={handlePublish} disabled={loading}
                        style={{ ...btnA, background:loading?"var(--bg-elevated)":"#5cba6c", color:loading?"var(--muted)":"#fff", cursor:loading?"not-allowed":"pointer" }}>
                        {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : `↑ Publish to ${selectedPlatforms.length} Platform${selectedPlatforms.length>1?"s":""}`}
                      </button>
                    )}
                    {scheduleMode === "schedule" && (
                      <button onClick={handleSchedule} disabled={!scheduleDate}
                        style={{ ...btnA, background:!scheduleDate?"var(--bg-elevated)":"var(--amber)", color:!scheduleDate?"var(--muted)":"#0e0f11" }}>
                        ⏰ Schedule Post
                      </button>
                    )}
                    {scheduleMode === "draft" && (
                      <button onClick={handleSaveAsDraft}
                        style={{ ...btnA, background:"var(--bg-elevated)", color:"var(--text-secondary)", border:"1px solid var(--border)" }}>
                        📋 Save as Draft
                      </button>
                    )}
                    <button onClick={() => setStage("image")} style={btnS}>← Back to Image</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── BRAND GUIDE PANEL ───────────────────────────────────────────────────────

function BrandGuidePanel({ onSave }) {
  const [guide, setGuide] = useState(loadBrandGuide);
  const [saved, setSaved] = useState(false);

  const set = (key, val) => setGuide(g => ({ ...g, [key]: val }));

  const handleSave = () => {
    saveBrandGuide(guide);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    if (onSave) onSave(guide);
  };

  const iS = {
    width:"100%", padding:"10px 14px", borderRadius:8,
    border:"1px solid var(--border)", background:"var(--bg-elevated)",
    color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)",
    outline:"none", boxSizing:"border-box",
  };
  const taS = { ...iS, resize:"vertical", lineHeight:1.6 };

  const SECTIONS = [
    {
      title:"Brand Identity",
      icon:"◈",
      fields:[
        { key:"brandName",  label:"Brand Name",    ph:"e.g. Cask & Stream",                   rows:0 },
        { key:"tagline",    label:"Tagline",        ph:'e.g. "Cast at Dawn. Sip at Dusk."',    rows:0 },
        { key:"audience",   label:"Target Audience",ph:"e.g. Fly fishers aged 30-55, whiskey enthusiasts, outdoor lifestyle...", rows:2 },
        { key:"topics",     label:"Core Topics",    ph:"e.g. fly fishing, whiskey/bourbon, outdoor lifestyle, river conservation...", rows:2 },
      ],
    },
    {
      title:"Voice & Writing Style",
      icon:"✎",
      color:"#5cba6c",
      fields:[
        { key:"voiceTone",    label:"Voice & Tone",     ph:"e.g. Warm, knowledgeable, poetic. Like a seasoned guide talking to a friend over a pour of bourbon...", rows:3 },
        { key:"writingStyle", label:"Writing Style",    ph:"e.g. Short punchy sentences. Active voice. Evocative nature descriptions. Avoid corporate jargon...", rows:3 },
        { key:"avoidWords",   label:"Words/Phrases to Avoid", ph:"e.g. 'leverage', 'synergy', 'best-in-class', 'utilize'...", rows:2 },
      ],
    },
    {
      title:"Visual Style",
      icon:"▣",
      color:"#7c3aed",
      fields:[
        { key:"imageStyle",   label:"Image Style",    ph:"e.g. Cinematic photography, golden hour light, moody and atmospheric, authentic outdoor scenes, no stock-photo feel...", rows:3 },
        { key:"colorPalette", label:"Color Palette",  ph:"e.g. Amber, teal, deep forest green, copper, warm shadows. Think bourbon and rivers at dusk...", rows:2 },
      ],
    },
  ];

  const hasContent = Object.values(guide).some(v => v?.trim());

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between" }}>
        <div>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 6px" }}>Brand Guide</h3>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
            Define your brand voice, writing style, and visual identity. Blog Bunker injects this into every AI content and image generation call automatically.
          </p>
        </div>
        {hasContent && (
          <div style={{ fontSize:11, color:"#5cba6c", padding:"4px 10px", borderRadius:99, background:"#5cba6c0a", border:"1px solid #5cba6c33", whiteSpace:"nowrap", marginLeft:16 }}>
            ● Active
          </div>
        )}
      </div>

      {SECTIONS.map(section => (
        <div key={section.title} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:section.color||"var(--amber)", marginBottom:16, display:"flex", alignItems:"center", gap:8 }}>
            <span>{section.icon}</span>{section.title}
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {section.fields.map(f => (
              <div key={f.key}>
                <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>{f.label}</label>
                {f.rows > 0
                  ? <textarea rows={f.rows} style={taS} placeholder={f.ph} value={guide[f.key]} onChange={e=>set(f.key, e.target.value)}
                      onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                  : <input style={iS} placeholder={f.ph} value={guide[f.key]} onChange={e=>set(f.key, e.target.value)}
                      onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                }
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Preview */}
      {hasContent && (
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>AI Context Preview</div>
          <pre style={{ fontSize:11, color:"var(--text-secondary)", lineHeight:1.7, whiteSpace:"pre-wrap", margin:0, fontFamily:"monospace", background:"var(--bg-elevated)", padding:12, borderRadius:8, border:"1px solid var(--border)" }}>
            {buildBrandContext(guide)}
          </pre>
          {guide.imageStyle && (
            <div style={{ marginTop:10 }}>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#7c3aed", marginBottom:6 }}>Image Prompt Prefix</div>
              <pre style={{ fontSize:11, color:"var(--text-secondary)", lineHeight:1.6, whiteSpace:"pre-wrap", margin:0, fontFamily:"monospace", background:"var(--bg-elevated)", padding:12, borderRadius:8, border:"1px solid var(--border)" }}>
                {buildBrandImageContext(guide)}
              </pre>
            </div>
          )}
        </div>
      )}

      <button onClick={handleSave}
        style={{ padding:"11px 28px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", alignSelf:"flex-start", display:"flex", alignItems:"center", gap:8 }}>
        {saved ? "✓ Saved!" : "Save Brand Guide"}
      </button>
    </div>
  );
}

// ─── PROMPT PREVIEW MODAL ─────────────────────────────────────────────────────
// Lets the user see and edit the exact AI prompt before it's sent — used for
// both blog post generation and image generation across the app.

function PromptPreviewModal({ title, systemPrompt, userPrompt, onSystemChange, onUserChange, onConfirm, onCancel, confirmLabel = "Generate", accentColor = "var(--amber)" }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:2000, padding:20 }}
      onClick={onCancel}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:14, padding:28, width:"100%", maxWidth:680, maxHeight:"85vh", overflow:"auto", display:"flex", flexDirection:"column", gap:18 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:0 }}>{title}</h3>
          <button onClick={onCancel} style={{ background:"transparent", border:"none", color:"var(--muted)", fontSize:20, cursor:"pointer", padding:4, lineHeight:1 }}>✕</button>
        </div>

        <p style={{ fontSize:12, color:"var(--text-secondary)", margin:0, lineHeight:1.6 }}>
          This is exactly what will be sent to the AI. Edit either field below before generating — your brand guide context (if any) is already included.
        </p>

        {onSystemChange && (
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
              System Prompt <span style={{ fontWeight:400, textTransform:"none" }}>(instructions/context)</span>
            </label>
            <textarea value={systemPrompt} onChange={e=>onSystemChange(e.target.value)} rows={6}
              style={{ width:"100%", padding:"12px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"monospace", lineHeight:1.6, outline:"none", resize:"vertical", boxSizing:"border-box" }}
              onFocus={e=>e.target.style.borderColor=accentColor} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          </div>
        )}

        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
            {onSystemChange ? "Your Request" : "Prompt"}
          </label>
          <textarea value={userPrompt} onChange={e=>onUserChange(e.target.value)} rows={onSystemChange ? 5 : 4}
            style={{ width:"100%", padding:"12px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", lineHeight:1.6, outline:"none", resize:"vertical", boxSizing:"border-box" }}
            onFocus={e=>e.target.style.borderColor=accentColor} onBlur={e=>e.target.style.borderColor="var(--border)"} />
        </div>

        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onCancel}
            style={{ padding:"10px 20px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:13, cursor:"pointer", fontFamily:"var(--font-body)" }}>
            Cancel
          </button>
          <button onClick={onConfirm}
            style={{ padding:"10px 24px", borderRadius:8, border:"none", background:accentColor, color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
            ✓ {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EMAIL NEWSLETTER STUDIO ─────────────────────────────────────────────────

function EmailNewsletterStudio({ activeProvider, activeModel, apiKeys, posts, brandGuide }) {
  const [mode,     setMode]    = useState("from-post"); // "from-post" | "from-scratch"
  const [postId,   setPostId]  = useState("");
  const [topic,    setTopic]   = useState("");
  const [subject,  setSubject] = useState("");
  const [body,     setBody]    = useState("");
  const [loading,  setLoading] = useState(false);
  const [error,    setError]   = useState("");
  const [copied,   setCopied]  = useState("");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const brandCtx = buildBrandContext(brandGuide || loadBrandGuide());
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const selectedPost = posts.find(p => p.id === Number(postId));

  const generate = async () => {
    setLoading(true); setError("");
    try {
      const context = mode === "from-post" && selectedPost
        ? `Blog post title: "${selectedPost.title}"\nContent excerpt: ${(selectedPost.body || "").slice(0, 600)}`
        : `Topic: ${topic}`;

      const [subjectResult, bodyResult] = await Promise.all([
        callAI(activeProvider, activeModel,
          `${brandCtx}You write compelling email newsletter subject lines for bloggers. Return ONLY the subject line, nothing else. Max 60 characters. No quotes.`,
          `Write an email subject line for this newsletter: ${context}`,
          apiKeys[activeProvider]),
        callAI(activeProvider, activeModel,
          `${brandCtx}You write engaging email newsletters for bloggers. Write in a warm, personal voice — like writing to a friend. Structure: greeting → hook → main content → call to action → sign-off. Include a clear CTA to read the full post. Use plain text formatting only. 200-350 words.`,
          `Write an email newsletter. ${context}${selectedPost ? `\nLink to post: [Read the full post →](https://caskandstream.com/blog/${selectedPost.title?.toLowerCase().replace(/\s+/g,"-")})` : ""}`,
          apiKeys[activeProvider]),
      ]);

      setSubject(subjectResult.trim());
      setBody(bodyResult.trim());
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const copySection = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div>
        <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Email Newsletter</h2>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Turn your blog posts into subscriber emails — your most owned marketing channel.</p>
      </div>

      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", gap:6, marginBottom:16 }}>
          {[["from-post","From a Blog Post"],["from-scratch","From Scratch"]].map(([id,label]) => (
            <button key={id} onClick={() => setMode(id)}
              style={{ padding:"6px 16px", borderRadius:99, border:mode===id?"1px solid var(--amber)":"1px solid var(--border)", background:mode===id?"var(--amber-glow)":"transparent", color:mode===id?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {label}
            </button>
          ))}
        </div>

        {mode === "from-post" ? (
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Select Blog Post</label>
            <select value={postId} onChange={e=>setPostId(e.target.value)} style={{ ...iS }}>
              <option value="">Choose a post…</option>
              {posts.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Newsletter Topic</label>
            <input style={iS} placeholder="e.g. Spring hatch season preview, Top bourbon pairings for river trips…" value={topic} onChange={e=>setTopic(e.target.value)}
              onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          </div>
        )}

        <button onClick={generate} disabled={loading || (mode==="from-post" && !postId) || (mode==="from-scratch" && !topic.trim())}
          style={{ marginTop:14, padding:"10px 24px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":provider.color, color:loading?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 }}>
          {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Writing…</> : `${provider.logo} Generate Newsletter`}
        </button>
        {error && <div style={{ fontSize:12, color:"var(--red)", marginTop:10 }}>{error}</div>}
      </div>

      {(subject || body) && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {/* Subject */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)" }}>Subject Line</div>
              <button onClick={() => copySection("subject", subject)} style={{ padding:"4px 12px", borderRadius:6, border:"none", background:copied==="subject"?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                {copied==="subject" ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <input value={subject} onChange={e=>setSubject(e.target.value)} style={{ ...iS, fontWeight:600 }} />
          </div>

          {/* Body */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)" }}>Email Body</div>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={() => copySection("body", body)} style={{ padding:"4px 12px", borderRadius:6, border:"none", background:copied==="body"?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  {copied==="body" ? "✓ Copied" : "Copy Body"}
                </button>
                <button onClick={() => copySection("all", `Subject: ${subject}\n\n${body}`)} style={{ padding:"4px 12px", borderRadius:6, border:"none", background:copied==="all"?"var(--green)":"var(--bg-elevated)", color:copied==="all"?"#0e0f11":"var(--text-secondary)", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  {copied==="all" ? "✓ Copied" : "Copy All"}
                </button>
              </div>
            </div>
            <textarea value={body} onChange={e=>setBody(e.target.value)} rows={14}
              style={{ ...iS, resize:"vertical", lineHeight:1.7, fontSize:13 }} />
          </div>

          <div style={{ fontSize:11, color:"var(--text-secondary)", padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
            💡 Paste into Mailchimp, ConvertKit, Beehiiv, or any email tool. The subject line and body are formatted for direct paste.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PINTEREST STUDIO ─────────────────────────────────────────────────────────

function PinterestStudio({ activeProvider, activeModel, apiKeys, posts, brandGuide }) {
  const [mode,    setMode]   = useState("from-post");
  const [postId,  setPostId] = useState("");
  const [topic,   setTopic]  = useState("");
  const [pins,    setPins]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]  = useState("");
  const [copied,  setCopied] = useState("");
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const brandCtx = buildBrandContext(brandGuide || loadBrandGuide());
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const selectedPost = posts.find(p => p.id === Number(postId));

  const generate = async () => {
    setLoading(true); setError(""); setPins(null);
    try {
      const context = mode === "from-post" && selectedPost
        ? `Blog post: "${selectedPost.title}". Excerpt: ${(selectedPost.body || "").slice(0, 400)}`
        : `Topic: ${topic}`;

      const text = await callAI(activeProvider, activeModel,
        `${brandCtx}You are a Pinterest strategy expert. Create 3 Pinterest pin ideas for a blog post or topic. Pinterest is a SEARCH ENGINE — optimize for discoverability. Return ONLY valid JSON array (no fences):
[{"title":"pin title under 100 chars","description":"pin description 200-500 chars with keywords","keywords":["keyword1","keyword2","keyword3","keyword4","keyword5"],"board":"suggested board name","imageDescription":"describe the ideal pin image in 1 sentence","type":"standard|idea|video"}]`,
        `Create 3 Pinterest pins for: ${context}`,
        apiKeys[activeProvider]
      );
      setPins(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div>
        <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Pinterest Studio</h2>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Pinterest is a search engine — pins drive traffic for years, not hours. Create SEO-optimized pins for every post.</p>
      </div>

      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", gap:6, marginBottom:16 }}>
          {[["from-post","From a Blog Post"],["from-scratch","From Topic"]].map(([id,label]) => (
            <button key={id} onClick={() => setMode(id)}
              style={{ padding:"6px 16px", borderRadius:99, border:mode===id?"1px solid #e60023":"1px solid var(--border)", background:mode===id?"#e6002310":"transparent", color:mode===id?"#e60023":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              {label}
            </button>
          ))}
        </div>

        {mode === "from-post" ? (
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Select Blog Post</label>
            <select value={postId} onChange={e=>setPostId(e.target.value)} style={iS}>
              <option value="">Choose a post…</option>
              {posts.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Topic</label>
            <input style={iS} placeholder="e.g. dry fly fishing tips, bourbon cocktail recipes, fly tying for beginners…" value={topic} onChange={e=>setTopic(e.target.value)}
              onFocus={e=>e.target.style.borderColor="#e60023"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          </div>
        )}

        <button onClick={generate} disabled={loading || (mode==="from-post" && !postId) || (mode==="from-scratch" && !topic.trim())}
          style={{ marginTop:14, padding:"10px 24px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":"#e60023", color:loading?"var(--muted)":"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 }}>
          {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Creating Pins…</> : "📌 Generate 3 Pin Ideas"}
        </button>
        {error && <div style={{ fontSize:12, color:"var(--red)", marginTop:10 }}>{error}</div>}
      </div>

      {pins && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {pins.map((pin, i) => (
            <div key={i} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:99, background:"#e6002315", color:"#e60023", border:"1px solid #e6002333" }}>📌 Pin {i+1}</span>
                  <span style={{ fontSize:10, padding:"2px 8px", borderRadius:99, background:"var(--bg-elevated)", color:"var(--muted)", border:"1px solid var(--border)", textTransform:"capitalize" }}>{pin.type}</span>
                </div>
                <button onClick={() => { navigator.clipboard.writeText(`${pin.title}\n\n${pin.description}\n\nKeywords: ${pin.keywords?.join(", ")}`); setCopied(`pin-${i}`); setTimeout(()=>setCopied(""),2000); }}
                  style={{ padding:"4px 12px", borderRadius:6, border:"none", background:copied===`pin-${i}`?"var(--green)":"var(--bg-elevated)", color:copied===`pin-${i}`?"#0e0f11":"var(--text-secondary)", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  {copied===`pin-${i}` ? "✓ Copied" : "Copy"}
                </button>
              </div>

              <div style={{ fontWeight:700, fontSize:14, marginBottom:10, color:"var(--text)" }}>{pin.title}</div>
              <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.7, marginBottom:12 }}>{pin.description}</div>

              <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
                {pin.keywords?.map((kw,j) => <span key={j} style={{ fontSize:11, padding:"2px 8px", borderRadius:99, background:"var(--amber-glow)", color:"var(--amber)", border:"1px solid var(--amber)33" }}>{kw}</span>)}
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, fontSize:11, color:"var(--muted)" }}>
                <div><span style={{ color:"var(--amber)", fontWeight:600 }}>Board:</span> {pin.board}</div>
                <div><span style={{ color:"var(--amber)", fontWeight:600 }}>Image:</span> {pin.imageDescription}</div>
              </div>
            </div>
          ))}

          <div style={{ fontSize:11, color:"var(--text-secondary)", padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
            💡 Pinterest tip: Post each pin to a separate board, 3-4 weeks apart. Pin the same blog post multiple times with different images and titles — Pinterest treats them as unique content.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── KEYWORD RESEARCH STUDIO ──────────────────────────────────────────────────

function KeywordResearchStudio({ activeProvider, activeModel, apiKeys, posts, inspiration, onAddInspiration }) {
  const [topic,   setTopic]   = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [saved,   setSaved]   = useState({});
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const existingTopics = posts.map(p => p.title).join(", ");
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const research = async () => {
    setLoading(true); setError(""); setResults(null); setSaved({});
    try {
      const text = await callAI(activeProvider, activeModel,
        `You are an SEO keyword strategist for small niche bloggers. Focus on LONG-TAIL keywords that small sites can realistically rank for. Return ONLY valid JSON (no fences):
{
  "primary": {"keyword":"...","monthly_searches":"est. range","difficulty":"low|medium|high","intent":"informational|commercial|navigational"},
  "long_tail": [{"keyword":"...","why":"why a small blog can rank for this","content_idea":"...","difficulty":"low|medium"}],
  "questions": ["question keyword 1","question keyword 2","question keyword 3","question keyword 4","question keyword 5"],
  "related": ["related term 1","related term 2","related term 3"],
  "avoid": ["too competitive keyword 1","too competitive keyword 2"]
}
long_tail array = 6 keywords. Focus heavily on low-difficulty, high-specificity terms.`,
        `Niche: fly fishing and whiskey lifestyle blog. Research keywords for topic: "${topic}". Already covered: ${existingTopics.slice(0,300)}`,
        apiKeys[activeProvider],
        2000
      );
      setResults(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const saveKeyword = (kw, i) => {
    onAddInspiration({ id:Date.now()+i, title:kw.keyword || kw, source:"Keyword Research", type:"article", notes:kw.content_idea ? `Content idea: ${kw.content_idea}\nDifficulty: ${kw.difficulty}\nWhy rank: ${kw.why}` : "" });
    setSaved(s => ({ ...s, [i]:true }));
  };

  const diffColor = { low:"#5cba6c", medium:"var(--amber)", high:"var(--red)" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div>
        <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Keyword Research</h2>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Find long-tail keywords small blogs can actually rank for. Save the best ones to your Inspiration Board.</p>
      </div>

      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", gap:10 }}>
          <input style={iS} placeholder="e.g. dry fly fishing, bourbon barrel aging, reading trout streams…" value={topic} onChange={e=>setTopic(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&research()}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          <button onClick={research} disabled={!topic.trim()||loading}
            style={{ padding:"10px 20px", borderRadius:8, border:"none", background:topic.trim()&&!loading?provider.color:"var(--bg-elevated)", color:topic.trim()&&!loading?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:topic.trim()&&!loading?"pointer":"not-allowed", fontFamily:"var(--font-body)", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:8 }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Researching…</> : `${provider.logo} Research Keywords`}
          </button>
        </div>
        {error && <div style={{ fontSize:12, color:"var(--red)", marginTop:10 }}>{error}</div>}
      </div>

      {results && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Primary keyword */}
          {results.primary && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--amber)44", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)", marginBottom:10 }}>Primary Keyword</div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontWeight:700, fontSize:16 }}>{results.primary.keyword}</div>
                <div style={{ display:"flex", gap:8 }}>
                  <span style={{ fontSize:11, padding:"2px 8px", borderRadius:99, background:diffColor[results.primary.difficulty]+"15", color:diffColor[results.primary.difficulty], border:`1px solid ${diffColor[results.primary.difficulty]}33` }}>{results.primary.difficulty} difficulty</span>
                  <span style={{ fontSize:11, padding:"2px 8px", borderRadius:99, background:"var(--bg-elevated)", color:"var(--muted)", border:"1px solid var(--border)" }}>{results.primary.monthly_searches}/mo</span>
                </div>
              </div>
            </div>
          )}

          {/* Long-tail keywords */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#5cba6c", marginBottom:14 }}>🎯 Long-Tail Keywords (Rankable for Small Blogs)</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {results.long_tail?.map((kw, i) => (
                <div key={i} style={{ padding:"12px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", display:"flex", gap:12, alignItems:"flex-start" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                      <span style={{ fontWeight:600, fontSize:13 }}>{kw.keyword}</span>
                      <span style={{ fontSize:10, padding:"1px 6px", borderRadius:99, background:diffColor[kw.difficulty]+"15", color:diffColor[kw.difficulty] }}>{kw.difficulty}</span>
                    </div>
                    <div style={{ fontSize:11, color:"var(--text-secondary)", marginBottom:3 }}>💡 {kw.why}</div>
                    {kw.content_idea && <div style={{ fontSize:11, color:"var(--amber)" }}>Post idea: {kw.content_idea}</div>}
                  </div>
                  <button onClick={() => saveKeyword(kw, i)} disabled={saved[i]}
                    style={{ padding:"4px 10px", borderRadius:6, border:"none", background:saved[i]?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:saved[i]?"default":"pointer", fontFamily:"var(--font-body)", flexShrink:0, whiteSpace:"nowrap" }}>
                    {saved[i] ? "✓ Saved" : "+ Board"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Questions */}
          {results.questions?.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#7c3aed", marginBottom:12 }}>❓ Question Keywords (FAQ Content)</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {results.questions.map((q, i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"8px 12px", borderRadius:7, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                    <span style={{ fontSize:12 }}>{q}</span>
                    <button onClick={() => saveKeyword({ keyword:q, why:"Question keyword — great for FAQ sections" }, 100+i)} disabled={saved[100+i]}
                      style={{ padding:"2px 8px", borderRadius:5, border:"none", background:saved[100+i]?"var(--green)":"transparent", color:saved[100+i]?"#0e0f11":"var(--muted)", fontSize:10, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      {saved[100+i] ? "✓" : "+ Board"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Avoid */}
          {results.avoid?.length > 0 && (
            <div style={{ padding:"12px 16px", borderRadius:10, background:"var(--red)08", border:"1px solid var(--red)22", fontSize:12, color:"var(--text-secondary)" }}>
              <strong style={{ color:"var(--red)" }}>⚠ Too Competitive for Small Blogs:</strong> {results.avoid.join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── COMPETITOR MARKETING PANEL ───────────────────────────────────────────────

function CompetitorMarketingPanel({ activeProvider, activeModel, apiKeys, competitors, posts, inspiration, onAddInspiration }) {
  const [selected,  setSelected]  = useState(competitors[0]?.url || "");
  const [analysis,  setAnalysis]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [saved,     setSaved]     = useState({});
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  const selectedCompetitor = competitors.find(c => c.url === selected);

  const analyze = async () => {
    if (!selectedCompetitor) return;
    setLoading(true); setError(""); setAnalysis(null);
    try {
      const text = await callAI(activeProvider, activeModel,
        `You are a competitive marketing analyst for bloggers. Analyze a competitor blog and identify opportunities. Return ONLY valid JSON (no fences):
{
  "strengths": ["what they do well 1","what they do well 2","what they do well 3"],
  "weaknesses": ["gap or weakness 1","gap or weakness 2","gap or weakness 3"],
  "content_gaps": [{"topic":"...","why_opportunity":"...","angle":"how to differentiate"}],
  "keyword_opportunities": ["keyword 1","keyword 2","keyword 3","keyword 4"],
  "social_strategy": {"what_works":"...","what_to_steal":"...","how_to_differentiate":"..."},
  "quick_wins": ["actionable win 1","actionable win 2","actionable win 3"]
}
content_gaps = 4 items. Be specific and actionable.`,
        `Analyze this competitor blog for a fly fishing and whiskey lifestyle blogger (Cask & Stream):
Competitor: ${selectedCompetitor.name} (${selectedCompetitor.url})
Their content focus: ${selectedCompetitor.focus || "general fly fishing blog"}
My existing posts: ${posts.slice(0,8).map(p=>p.title).join(", ")}`,
        apiKeys[activeProvider],
        2000
      );
      setAnalysis(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const saveIdea = (text, i) => {
    onAddInspiration({ id:Date.now()+i, title:text, source:`Competitor Intel — ${selectedCompetitor?.name}`, type:"article", notes:"" });
    setSaved(s => ({ ...s, [i]:true }));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div>
        <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Competitor Intelligence</h2>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Analyze competitor blogs to find content gaps, keyword opportunities, and ways to differentiate.</p>
      </div>

      <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
        {competitors.length === 0 ? (
          <div style={{ textAlign:"center", padding:"20px 0", color:"var(--muted)", fontSize:13 }}>
            No competitors added yet — go to Research tab → Competitors to add some.
          </div>
        ) : (
          <>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>Select Competitor</label>
            <div style={{ display:"flex", gap:10 }}>
              <select value={selected} onChange={e=>{ setSelected(e.target.value); setAnalysis(null); setSaved({}); }} style={iS}>
                {competitors.map(c => <option key={c.url} value={c.url}>{c.name} — {c.url}</option>)}
              </select>
              <button onClick={analyze} disabled={!selected||loading}
                style={{ padding:"10px 20px", borderRadius:8, border:"none", background:selected&&!loading?provider.color:"var(--bg-elevated)", color:selected&&!loading?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:selected&&!loading?"pointer":"not-allowed", fontFamily:"var(--font-body)", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:8 }}>
                {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Analyzing…</> : `${provider.logo} Analyze`}
              </button>
            </div>
          </>
        )}
        {error && <div style={{ fontSize:12, color:"var(--red)", marginTop:10 }}>{error}</div>}
      </div>

      {analysis && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {/* Quick wins */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid #5cba6c44", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#5cba6c", marginBottom:12 }}>⚡ Quick Wins</div>
            {analysis.quick_wins?.map((win,i) => (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                <span style={{ fontSize:13 }}>{win}</span>
                <button onClick={() => saveIdea(win, i)} disabled={saved[i]}
                  style={{ padding:"3px 8px", borderRadius:5, border:"none", background:saved[i]?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", flexShrink:0, marginLeft:10 }}>
                  {saved[i] ? "✓" : "+ Board"}
                </button>
              </div>
            ))}
          </div>

          {/* Content gaps */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)", marginBottom:14 }}>🎯 Content Gaps (Topics They Miss)</div>
            {analysis.content_gaps?.map((gap,i) => (
              <div key={i} style={{ padding:"12px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", marginBottom:8, display:"flex", gap:12, alignItems:"flex-start" }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:600, fontSize:13, marginBottom:3 }}>{gap.topic}</div>
                  <div style={{ fontSize:11, color:"var(--text-secondary)", marginBottom:3 }}>{gap.why_opportunity}</div>
                  <div style={{ fontSize:11, color:"var(--amber)" }}>Your angle: {gap.angle}</div>
                </div>
                <button onClick={() => saveIdea(`${gap.topic} — ${gap.angle}`, 20+i)} disabled={saved[20+i]}
                  style={{ padding:"4px 10px", borderRadius:6, border:"none", background:saved[20+i]?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", flexShrink:0 }}>
                  {saved[20+i] ? "✓" : "+ Board"}
                </button>
              </div>
            ))}
          </div>

          {/* Strengths/Weaknesses */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {[
              { key:"strengths",  label:"Their Strengths",  color:"var(--text-secondary)", icon:"👍" },
              { key:"weaknesses", label:"Their Weaknesses", color:"#5cba6c",               icon:"🎯" },
            ].map(({ key, label, color, icon }) => (
              <div key={key} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:16 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color, marginBottom:10 }}>{icon} {label}</div>
                {analysis[key]?.map((item,i) => (
                  <div key={i} style={{ fontSize:12, padding:"6px 0", borderBottom:"1px solid var(--border)", color:"var(--text-secondary)", lineHeight:1.5 }}>{item}</div>
                ))}
              </div>
            ))}
          </div>

          {/* Keyword opportunities */}
          {analysis.keyword_opportunities?.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:16 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#7c3aed", marginBottom:10 }}>🔑 Keyword Opportunities They Miss</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {analysis.keyword_opportunities.map((kw,i) => (
                  <span key={i} onClick={() => saveIdea(kw, 50+i)}
                    style={{ fontSize:12, padding:"4px 10px", borderRadius:99, background:"#7c3aed15", color:"#a78bfa", border:"1px solid #7c3aed33", cursor:"pointer" }}
                    title="Click to save to Inspiration Board">
                    {kw} {saved[50+i] ? "✓" : "+"}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Social strategy */}
          {analysis.social_strategy && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:16 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>📱 Social Media Analysis</div>
              {Object.entries(analysis.social_strategy).map(([key,val]) => (
                <div key={key} style={{ padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"var(--amber)", textTransform:"capitalize", marginBottom:3 }}>{key.replace(/_/g," ")}</div>
                  <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.5 }}>{val}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SOCIAL POSTS MANAGER ─────────────────────────────────────────────────────

function SocialPostsManager({ socialPosts = [], metaConfig, onSave, onDelete, tierConfig = TIER_CONFIG.operative }) {
  const [filter,   setFilter]   = useState("all");
  const [expanded, setExpanded] = useState(null);
  const [posting,  setPosting]  = useState({});
  const [postResults, setPostResults] = useState({});

  const PLATFORMS = SOCIAL_PLATFORMS.filter(p => ["instagram","facebook","tiktok","twitter","pinterest","reddit"].includes(p.id))
    .map(p => ({ id:p.id, label:p.name.replace(" (Twitter)",""), color:p.color, icon:p.icon }));

  const filtered = filter === "all" ? socialPosts : socialPosts.filter(p => p.status === filter);
  const counts = { all: socialPosts.length, draft: socialPosts.filter(p=>p.status==="draft").length, scheduled: socialPosts.filter(p=>p.status==="scheduled").length, published: socialPosts.filter(p=>p.status==="published").length };

  const statusColor = { draft:"var(--muted)", scheduled:"var(--amber)", published:"#5cba6c" };
  const statusIcon  = { draft:"📋", scheduled:"⏰", published:"✓" };

  const publishNow = async (post) => {
    setPosting(p => ({ ...p, [post.id]: true }));
    const results = {};
    const selectedPlats = PLATFORMS.filter(p => post.platforms?.includes(p.id));
    const bufferCfg = loadBufferConfig();

    // Image must be a public https:// URL for Meta/Buffer to fetch it — if this
    // post was saved before the Save-as-Draft/Schedule image-upload fix, it may
    // still be null or a stale blob: URL. Try to recover it once, upfront.
    let publicImageUrl = post.imageUrl;
    if (publicImageUrl?.startsWith("blob:") || publicImageUrl?.startsWith("data:")) {
      try { publicImageUrl = await ensurePublicImageUrl(publicImageUrl); }
      catch { publicImageUrl = null; }
    }

    for (const plat of selectedPlats) {
      const captionRaw = post.captions?.[plat.id]; const captionText = typeof captionRaw === "string" ? captionRaw : (captionRaw?.text || "");
      const fullMessage = `${captionText}\n\n${limitHashtagsForPlatform(post.hashtags || "", plat.id)}`.trim();
      try {
        if (plat.id === "facebook" && metaConfig?.connected && metaConfig?.pages?.length > 0) {
          const page = metaConfig.pages[0];
          const res = await metaPost({ pageId: page.id, pageToken: page.access_token, message: fullMessage, imageUrl: publicImageUrl, platforms: ["facebook"] });
          results[plat.id] = res.facebook?.success ? "✓ Posted" : `Error: ${res.facebook?.error}`;
        } else if (plat.id === "instagram" && metaConfig?.connected && metaConfig?.pages?.some(p=>p.instagram_id)) {
          const page = metaConfig.pages.find(p => p.instagram_id);
          const res = await metaPost({ pageId: page.id, pageToken: page.access_token, instagramId: page.instagram_id, message: fullMessage, imageUrl: publicImageUrl, platforms: ["instagram"] });
          results[plat.id] = res.instagram?.success ? "✓ Posted" : `Error: ${res.instagram?.error}`;
        } else if (bufferCfg?.connected && bufferCfg?.mapping?.[plat.id]) {
          if (!tierConfig.buffer) {
            throw new Error(`Buffer integration is available on Operative and above — upgrade in Settings → Billing & Plan to post to ${plat.label}.`);
          }
          const channelId = bufferCfg.mapping[plat.id];
          if (plat.id === "pinterest" && !bufferCfg.boardMapping?.[channelId]) {
            throw new Error("No Pinterest board selected — set one in Settings → Buffer before posting to Pinterest.");
          }
          const res = await fetch("/api/buffer-post", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              apiKey:      bufferCfg.apiKey,
              action:      "createPost",
              channelId,
              text:        fullMessage,
              imageUrl:    publicImageUrl || "",
              scheduledAt: null,
              pinterestBoardId: plat.id === "pinterest" ? bufferCfg.boardMapping?.[channelId] : undefined,
            }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          results[plat.id] = `✓ Sent to Buffer → ${plat.label}`;
        } else {
          navigator.clipboard.writeText(fullMessage);
          results[plat.id] = "Not connected — copied to clipboard, paste manually";
        }
      } catch(e) { results[plat.id] = `Error: ${e.message}`; }
    }

    setPostResults(r => ({ ...r, [post.id]: results }));
    // Only mark as actually published if every platform genuinely posted —
    // a manual clipboard copy is not a successful post.
    const allOk = Object.values(results).every(r => r.startsWith("✓"));
    if (allOk) onSave({ ...post, status:"published", publishedAt: new Date().toISOString(), imageUrl: publicImageUrl, results });
    setPosting(p => ({ ...p, [post.id]: false }));
  };

  if (socialPosts.length === 0) {
    return (
      <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--muted)" }}>
        <div style={{ fontSize:40, marginBottom:16 }}>📋</div>
        <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, marginBottom:8, color:"var(--text)" }}>No Social Posts Yet</h3>
        <p style={{ fontSize:13, lineHeight:1.6 }}>Use the Social Pipeline to create posts, then save them as drafts or schedule them for later.</p>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Social Posts</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Manage your saved, scheduled, and published social posts.</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display:"flex", gap:6 }}>
        {Object.entries(counts).map(([key, count]) => (
          <button key={key} onClick={() => setFilter(key)}
            style={{ padding:"5px 14px", borderRadius:99, border:filter===key?"1px solid var(--amber)":"1px solid var(--border)", background:filter===key?"var(--amber-glow)":"transparent", color:filter===key?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", textTransform:"capitalize" }}>
            {key} ({count})
          </button>
        ))}
      </div>

      {/* Post list */}
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {filtered.map(post => {
          const isExpanded = expanded === post.id;
          const platIcons = (post.platforms || []).map(id => PLATFORMS.find(p=>p.id===id)?.icon || "📱").join(" ");
          const scheduledDate = post.scheduledAt ? new Date(post.scheduledAt) : null;
          const isOverdue = scheduledDate && scheduledDate < new Date() && post.status === "scheduled";

          return (
            <div key={post.id} style={{ background:"var(--bg-surface)", border:`1px solid ${isOverdue?"var(--amber)44":"var(--border)"}`, borderRadius:12, overflow:"hidden" }}>
              {/* Post header */}
              <div style={{ padding:"14px 18px", display:"flex", alignItems:"center", gap:12, cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded ? null : post.id)}>
                <div style={{ fontSize:18 }}>{platIcons}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:13, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {(() => { const c = Object.values(post.captions || {})[0]; const t = typeof c === "string" ? c : c?.text || ""; return t.slice(0,80) || "Untitled post"; })()}…
                  </div>
                  <div style={{ fontSize:11, color:"var(--text-secondary)", display:"flex", gap:8 }}>
                    <span style={{ color:statusColor[post.status], fontWeight:600 }}>{statusIcon[post.status]} {post.status}</span>
                    {scheduledDate && <span>{isOverdue ? "⚠ Overdue: " : "🕐 "}{scheduledDate.toLocaleString([], {dateStyle:"medium",timeStyle:"short"})}</span>}
                    <span>{new Date(post.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  {post.status !== "published" && (
                    <button onClick={e=>{ e.stopPropagation(); publishNow(post); }} disabled={posting[post.id]}
                      style={{ padding:"5px 12px", borderRadius:7, border:"none", background:posting[post.id]?"var(--bg-elevated)":"#5cba6c", color:posting[post.id]?"var(--muted)":"#fff", fontSize:11, fontWeight:700, cursor:posting[post.id]?"not-allowed":"pointer", fontFamily:"var(--font-body)" }}>
                      {posting[post.id] ? "◌" : "↑ Post Now"}
                    </button>
                  )}
                  <button onClick={e=>{ e.stopPropagation(); onDelete(post.id); }}
                    style={{ padding:"5px 10px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--muted)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    🗑
                  </button>
                  <span style={{ fontSize:14, color:"var(--muted)", display:"flex", alignItems:"center" }}>{isExpanded ? "▲" : "▼"}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ borderTop:"1px solid var(--border)", padding:"16px 18px", display:"flex", flexDirection:"column", gap:14 }}>
                  {/* Per-platform captions */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    {(post.platforms || []).map(platId => {
                      const plat = PLATFORMS.find(p=>p.id===platId);
                      return (
                        <div key={platId} style={{ background:"var(--bg-elevated)", borderRadius:8, padding:12 }}>
                          <div style={{ fontSize:10, fontWeight:700, color:plat?.color||"var(--amber)", marginBottom:6 }}>{plat?.icon} {plat?.label}</div>
                          <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.6, whiteSpace:"pre-wrap" }}>
                            {(() => { const c = post.captions?.[platId]; return typeof c === "string" ? c : (c?.text || "—"); })()}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Hashtags */}
                  {post.hashtags && (
                    <div style={{ fontSize:12, color:"var(--amber)", lineHeight:1.6 }}>{post.hashtags}</div>
                  )}

                  {/* Image */}
                  {post.imageUrl && (
                    <img src={post.imageUrl} alt="" style={{ maxWidth:300, borderRadius:8, border:"1px solid var(--border)" }} />
                  )}

                  {/* Publish results */}
                  {postResults[post.id] && (
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {Object.entries(postResults[post.id]).map(([platId, result]) => (
                        <div key={platId} style={{ fontSize:11, color:result.startsWith("✓")?"#5cba6c":"var(--red)" }}>
                          {PLATFORMS.find(p=>p.id===platId)?.icon} {result}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Change status */}
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"var(--muted)" }}>Status:</span>
                    <select value={post.status} onChange={e => onSave({ ...post, status: e.target.value })}
                      style={{ padding:"4px 10px", borderRadius:6, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", cursor:"pointer" }}>
                      <option value="draft">Draft</option>
                      <option value="scheduled">Scheduled</option>
                      <option value="published">Published</option>
                    </select>
                    {post.status === "scheduled" && (
                      <input type="datetime-local" value={post.scheduledAt?.slice(0,16) || ""} onChange={e => onSave({ ...post, scheduledAt: e.target.value })}
                        style={{ padding:"4px 10px", borderRadius:6, border:"1px solid var(--amber)44", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)" }} />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── MEDIA LIBRARY ────────────────────────────────────────────────────────────
// Images stored in Netlify Blobs — works across all devices.
// localStorage used only as a cache for offline display.

const MEDIA_STORAGE = "bb_media_library_cache";

function loadMediaLibraryCache() {
  try { return JSON.parse(localStorage.getItem(MEDIA_STORAGE) || "[]"); }
  catch { return []; }
}

function saveMediaLibraryCache(items) {
  try {
    // Strip dataUrl before caching to save localStorage space
    const lite = items.map(({ dataUrl, ...rest }) => rest);
    localStorage.setItem(MEDIA_STORAGE, JSON.stringify(lite));
    window.dispatchEvent(new CustomEvent("bb-media-updated"));
  } catch(e) { /* cache full — ignore */ }
}

// Upload image to Blobs and return the item record with a public URL
async function saveToMediaLibrary(url, name = "generated", tags = ["generated"], userId = "anonymous") {
  let dataUrl = url;

  if (url.startsWith("blob:")) {
    const res  = await fetch(url);
    const blob = await res.blob();
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  const res = await fetch("/api/gcs", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ userId, dataUrl, name, tags, source: "generated" }),
  });
  if (!res.ok) throw new Error(`Media save failed: ${res.status}`);
  const data = await res.json();
  window.dispatchEvent(new CustomEvent("bb-media-updated"));
  return data.item;
}

// localStorage write shim — kept for SaveToLibraryButton compatibility
function saveMediaLibraryToStorage(items) {
  saveMediaLibraryCache(items);
}

// Normalizes arbitrary image bytes (JPEG, WEBP, indexed/palette PNG, CMYK, etc.) into a
// guaranteed-valid RGBA PNG by round-tripping through a canvas. Fixes OpenAI images/edits
// rejecting files with "Invalid image file or mode" when the source isn't a true RGBA PNG.
// Also caps the output size. OpenAI documents a 50MB per-image limit for gpt-image-2, but
// real-world reports (including OpenAI's own community forum) show intermediate gateways
// commonly 413 well below that — the vetted safe practice is keeping uploads under ~1.5MB,
// which is what this targets (with headroom, well under Netlify's own ~4.5MB body cap too).
function normalizeToPngBase64(base64, maxBytes = 1400000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const exportAtScale = (scale) => {
        const canvas = document.createElement("canvas");
        canvas.width  = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL("image/png").split(",")[1];
        const approxBytes = b64.length * 0.75; // base64 -> raw bytes
        if (approxBytes > maxBytes && scale > 0.15) {
          exportAtScale(scale * 0.8);
        } else {
          resolve(b64);
        }
      };
      exportAtScale(1);
    };
    img.onerror = () => reject(new Error("Could not decode image for normalization"));
    img.src = `data:image/*;base64,${base64}`;
  });
}

// Starts an AI Restyle background job (image-edit.js) and polls image-edit-status.js
// until it's done. Background functions get up to 15 minutes of runtime — this
// replaces the old direct sync-function call that could get cut off mid-response
// on slow edits, producing a truncated body the client couldn't parse.
async function runBackgroundImageEdit({ provider, prompt, apiKey, imageBase64, size = "1024x1024", quality = "medium", onWaiting, pollIntervalMs = 3000, maxWaitMs = 180000 }) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const startRes = await fetch("/api/image-edit", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jobId, provider, prompt, apiKey, imageBase64, size, quality }),
  });
  if (!startRes.ok && startRes.status !== 202) {
    if (startRes.status === 413) throw new Error("This image is too large to edit even after compression. Try a smaller source image.");
    throw new Error(`Could not start the image edit (${startRes.status})`);
  }

  const deadline = Date.now() + maxWaitMs;
  let firstPoll = true;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, firstPoll ? 2000 : pollIntervalMs));
    firstPoll = false;
    if (onWaiting) onWaiting();

    let statusRes;
    try {
      statusRes = await fetch(`/api/image-edit-status?jobId=${encodeURIComponent(jobId)}`);
    } catch {
      continue; // transient network hiccup — keep polling
    }
    if (!statusRes.ok) continue;
    const text = await statusRes.text();
    let data;
    try { data = JSON.parse(text); } catch { continue; }

    if (data.status === "done") return { b64: data.b64, mimeType: data.mimeType || "image/png" };
    if (data.status === "error") throw new Error(data.error || "The image edit failed");
    // status === "pending" — keep polling
  }
  throw new Error("The image edit is taking longer than expected (3+ minutes). It may still finish — try again shortly, or check Media Library for the result.");
}

function MediaLibrary({ userId }) {
  const resolvedUserId = userId || window.__bbUserId || "anonymous";
  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState("all");
  const [selected,  setSelected]  = useState(null);
  const [uploading, setUploading] = useState(false);
  const [search,    setSearch]    = useState("");
  const [copied,    setCopied]    = useState("");
  const [dragOver,  setDragOver]  = useState(false);
  // AI restyle state
  const [restylePrompt,  setRestylePrompt]  = useState("");
  const [restyleLoading, setRestyleLoading] = useState(false);
  const [restyleStatus,  setRestyleStatus]  = useState("");
  const [restyleResult,  setRestyleResult]  = useState(null);
  const [restyleError,   setRestyleError]   = useState("");
  const [restyleOpen,    setRestyleOpen]    = useState(false);
  const [restyleStrength,setRestyleStrength]= useState(0.65); // 0=keep original, 1=full restyle
  const fileInput = useRef(null);

  const TAGS = ["blog headline","instagram","facebook","pinterest","tiktok","brand","product","landscape","portrait","other"];

  const STYLE_PRESETS = [
    { label:"Cinematic",      prompt:"cinematic photography, golden hour lighting, professional color grading, shallow depth of field, film grain" },
    { label:"Magazine",       prompt:"professional magazine editorial photography, crisp lighting, vibrant colors, sharp focus" },
    { label:"Oil Painting",   prompt:"oil painting, impressionist brushstrokes, rich textures, painterly style" },
    { label:"Watercolor",     prompt:"watercolor illustration, soft washes, delicate strokes, artistic" },
    { label:"Moody",          prompt:"moody atmospheric photography, dark tones, dramatic shadows, misty, noir style" },
    { label:"Golden Hour",    prompt:"golden hour photography, warm sunlight, glowing atmosphere, sun rays, bokeh" },
    { label:"Foggy Morning",  prompt:"misty morning fog over water, atmospheric haze, soft diffused light, serene" },
    { label:"Vintage Film",   prompt:"vintage film photography, faded colors, grain, light leaks, 35mm aesthetic" },
  ];

  const runRestyle = async () => {
    if (!selected || !restylePrompt.trim()) return;
    setRestyleLoading(true); setRestyleError(""); setRestyleResult(null);
    try {
      const imageUrl = selected.url || selected.dataUrl;
      if (!imageUrl) throw new Error("No image URL found for selected item");
      let base64Image;

      if (imageUrl.startsWith("data:")) {
        base64Image = imageUrl.split(",")[1];
      } else {
        // Fetch from GCS — try with mode cors, fall back to no-cors via proxy
        try {
          const res  = await fetch(imageUrl, { mode:"cors", credentials:"omit" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          base64Image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result.split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch(fetchErr) {
          // If direct fetch fails, try via /api/gcs proxy
          const proxyRes = await fetch(`/api/gcs?proxyUrl=${encodeURIComponent(imageUrl)}`);
          if (!proxyRes.ok) throw new Error("Could not load image for restyle — try downloading and re-uploading it");
          const blob = await proxyRes.blob();
          base64Image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result.split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      }

      if (!base64Image) throw new Error("Could not load image data");

      // Normalize to a guaranteed-valid RGBA PNG — fixes OpenAI's "Invalid image
      // file or mode" error when the source is actually JPEG/WEBP/indexed-color
      // and was being sent mislabeled as PNG.
      base64Image = await normalizeToPngBase64(base64Image);

      const apiKeys = JSON.parse(localStorage.getItem("bb_api_keys") || "{}");
      const provider = apiKeys.openai ? "openai" : apiKeys.gemini ? "gemini" : null;
      if (!provider) throw new Error("Add an OpenAI or Gemini API key in Settings → API Keys to use AI Restyle.");

      setRestyleStatus("Starting the edit…");
      const { b64, mimeType } = await runBackgroundImageEdit({
        provider:    provider === "openai" ? "openai-edit" : "gemini-edit",
        prompt:      provider === "openai"
          ? `${restylePrompt}. Keep the same scene, subjects, and composition. Only change the visual style, lighting, color grading, and atmosphere.`
          : `Transform this image in the following style while keeping the same composition and subjects: ${restylePrompt}`,
        apiKey:      apiKeys[provider],
        imageBase64: base64Image,
        onWaiting:   () => setRestyleStatus("Still working — this can take a minute…"),
      });
      setRestyleResult(`data:${mimeType || "image/png"};base64,${b64}`);
    } catch(e) {
      setRestyleError(e.message);
    }
    setRestyleStatus("");
    setRestyleLoading(false);
  };

  const saveRestyleResult = async () => {
    if (!restyleResult) return;
    try {
      const res = await fetch("/api/gcs", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId:  resolvedUserId,
          dataUrl: restyleResult,
          name:    `${selected?.name || "image"}-restyled`,
          tags:    ["restyled", "generated"],
          notes:   `Restyled from "${selected?.name}" · Prompt: ${restylePrompt.slice(0,80)}`,
          source:  "restyled",
        }),
      });
      const data = await res.json();
      if (data.item) {
        setItems(prev => [data.item, ...prev]);
        setRestyleResult(null);
        setRestyleOpen(false);
        setRestylePrompt("");
        setSelected(data.item);
      }
    } catch(e) { setRestyleError(e.message); }
  };

  // Load from cloud on mount
  const fetchItems = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/gcs?userId=${encodeURIComponent(resolvedUserId)}`);
      const data = await res.json();
      if (data.items) {
        setItems(data.items);
        saveMediaLibraryCache(data.items);
      }
    } catch(e) {
      // Fall back to cache
      setItems(loadMediaLibraryCache());
    }
    setLoading(false);
  };

  useEffect(() => { fetchItems(); }, [userId]);

  // Re-sync when SaveToLibraryButton saves
  useEffect(() => {
    const sync = () => fetchItems();
    window.addEventListener("bb-media-updated", sync);
    return () => window.removeEventListener("bb-media-updated", sync);
  }, [userId]);

  // Delete from cloud + local state
  const deleteItem = async (id) => {
    if (!window.confirm("Delete this image?")) return;
    try {
      await fetch(`/api/gcs?userId=${encodeURIComponent(resolvedUserId)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {}
    setItems(prev => prev.filter(i => i.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  // Update metadata (name, tags, notes)
  const updateItem = async (id, patch) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
    if (selected?.id === id) setSelected(s => ({ ...s, ...patch }));
    try {
      await fetch("/api/gcs", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId, id, ...patch }),
      });
    } catch {}
  };

  const [uploadProgress, setUploadProgress] = useState({}); // { fileName: 0-100 }

  // Upload file directly to GCS — bypasses Netlify's 6MB body limit
  const processFile = async (file) => {
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) { alert("Only image and video files are supported."); return; }
    if (isImage && file.size > 20 * 1024 * 1024) { alert("Image too large — max 20MB."); return; }
    if (isVideo && file.size > 500 * 1024 * 1024) { alert("Video too large — max 500MB."); return; }

    const key = file.name + file.size;
    setUploadProgress(prev => ({ ...prev, [key]: 0 }));
    console.log(`[upload] starting: ${file.name} (${file.size} bytes)`);

    try {
      // Step 1: get a resumable upload session URL from our server
      console.log("[upload] step 1: requesting signed URL…");
      const sessionRes = await fetchWithTimeout("/api/gcs-signed-url", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          userId:   resolvedUserId,
          fileName: file.name,
          mimeType: file.type,
          size:     file.size,
          name:     file.name.replace(/\.[^.]+$/, ""),
          tags:     isVideo ? ["video","upload"] : ["upload"],
          source:   "upload",
        }),
      }, 20000);
      const { uploadUrl, objectId, item, error: sessionErr } = await sessionRes.json();
      if (sessionErr || !uploadUrl) throw new Error(sessionErr || "Failed to get upload URL");
      console.log("[upload] step 1 done — got signed URL, objectId:", objectId);

      // Step 2: upload directly from browser to GCS with progress tracking and
      // automatic retry-with-resume on transient 500/503 (expected/documented
      // GCS behavior, not a bug — previously a single bare PUT with no retry
      // meant any transient hiccup was a permanent user-facing failure)
      console.log("[upload] step 2: uploading to GCS…");
      await uploadToGCSResumable(uploadUrl, file, (pct) => {
        console.log(`[upload] progress: ${pct}%`);
        setUploadProgress(prev => ({ ...prev, [key]: pct }));
      });
      console.log("[upload] step 2 done — GCS upload confirmed complete");

      // Step 3: finalize (make public + update status)
      console.log("[upload] step 3: finalizing…");
      await fetchWithTimeout("/api/gcs-finalize", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId: resolvedUserId, objectId }),
      }, 15000);
      console.log("[upload] step 3 done — finalized");

      // Add to local state immediately (optimistic — instant feedback)
      setItems(prev => [{ ...item, status:"ready" }, ...prev.filter(i => i.id !== objectId)]);
      setUploadProgress(prev => { const next = {...prev}; delete next[key]; return next; });
      console.log("[upload] DONE — added to local state, confirming with a real server refresh…");

      // Also do a real refresh from the server — the optimistic update above was
      // being silently lost in practice (required a tab switch/refresh to actually
      // show up), so this guarantees the UI matches reality without relying on
      // that alone. Small delay to avoid racing ahead of any brief write-
      // propagation lag right after gcs-finalize.js writes the record.
      setTimeout(() => fetchItems(), 800);

    } catch(e) {
      console.error("[upload] FAILED at some step:", e);
      alert(`Upload failed: ${e.message}`);
      setUploadProgress(prev => { const next = {...prev}; delete next[key]; return next; });
    }
  };

  const handleFiles = async (files) => {
    setUploading(true);
    // Upload all files in parallel
    await Promise.all(Array.from(files).map(file => processFile(file)));
    setUploading(false);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); };

  const download = (item) => {
    const a = document.createElement("a");
    a.href     = item.url || item.dataUrl;
    a.download = `${item.name || "image"}.${item.type?.split("/")[1] || "jpg"}`;
    a.click();
  };

  const copyUrl = (item) => {
    navigator.clipboard.writeText(item.url || item.dataUrl || "");
    setCopied(item.id);
    setTimeout(() => setCopied(""), 2000);
  };

  const filteredItems = items.filter(item => {
    if (filter !== "all" && !item.tags?.includes(filter)) return false;
    if (search && !item.name?.toLowerCase().includes(search.toLowerCase()) && !item.tags?.join(" ").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const iS = { padding:"8px 12px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", width:"100%" };
  const formatSize = (b) => b > 1024*1024 ? `${(b/1024/1024).toFixed(1)}MB` : `${Math.round(b/1024)}KB`;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>Media Library</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>
            {loading ? "Loading…" : `${items.length} image${items.length!==1?"s":""} · synced across all devices`}
          </p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={fetchItems} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>↻ Refresh</button>
          <button onClick={() => fileInput.current?.click()} style={{ padding:"9px 20px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>+ Upload Images</button>
        </div>
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple style={{ display:"none" }} onChange={e=>handleFiles(e.target.files)} />
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e=>{ e.preventDefault(); setDragOver(true); }}
        onDragLeave={()=>setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInput.current?.click()}
        style={{ border:`2px dashed ${dragOver?"var(--amber)":"var(--border)"}`, borderRadius:12, padding:"24px 20px", textAlign:"center", cursor:"pointer", background:dragOver?"var(--amber-glow)":"transparent", transition:"all 0.2s" }}>
        {uploading || Object.keys(uploadProgress).length > 0 ? (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {Object.entries(uploadProgress).map(([name, pct]) => (
              <div key={name}>
                <div style={{ fontSize:11, color:"var(--text-secondary)", marginBottom:4, display:"flex", justifyContent:"space-between" }}>
                  <span>{name.length > 40 ? name.slice(0,37)+"…" : name}</span>
                  <span style={{ color:"var(--amber)" }}>{pct}%</span>
                </div>
                <div style={{ height:4, borderRadius:99, background:"var(--bg-elevated)" }}>
                  <div style={{ height:"100%", width:`${pct}%`, background:"var(--amber)", borderRadius:99, transition:"width 0.3s" }} />
                </div>
              </div>
            ))}
            {uploading && Object.keys(uploadProgress).length === 0 && (
              <div style={{ fontSize:13, color:"var(--amber)", display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>Preparing upload…
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ fontSize:24, marginBottom:6 }}>🖼</div>
            <div style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:3 }}>{dragOver ? "Drop to upload" : "Drag & drop images or videos, or click to browse"}</div>
            <div style={{ fontSize:11, color:"var(--muted)" }}>Images: PNG, JPG, WEBP (max 8MB) · Videos: MP4, MOV, WebM (max 200MB)</div>
          </>
        )}
      </div>

      {loading && <div style={{ textAlign:"center", padding:40, color:"var(--muted)", fontSize:13 }}><span style={{ animation:"spin 1s linear infinite", display:"inline-block", marginRight:8 }}>◌</span>Loading from cloud…</div>}

      {!loading && items.length > 0 && (
        <>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
            <input style={{ ...iS, flex:1, minWidth:200 }} placeholder="Search by name or tag…" value={search} onChange={e=>setSearch(e.target.value)}
              onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
            <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
              {["all","generated","upload","blog headline","instagram","facebook","pinterest"].map(tag => (
                <button key={tag} onClick={() => setFilter(tag)}
                  style={{ padding:"5px 12px", borderRadius:99, border:filter===tag?"1px solid var(--amber)":"1px solid var(--border)", background:filter===tag?"var(--amber-glow)":"transparent", color:filter===tag?"var(--amber)":"var(--text-secondary)", fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", textTransform:"capitalize" }}>
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {filteredItems.length === 0 ? (
            <div style={{ textAlign:"center", padding:40, color:"var(--muted)", fontSize:13 }}>No images match your filter.</div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:12 }}>
              {filteredItems.map(item => (
                <div key={item.id}
                  onClick={() => setSelected(selected?.id===item.id ? null : item)}
                  style={{ position:"relative", borderRadius:10, overflow:"hidden", border:`2px solid ${selected?.id===item.id?"var(--amber)":"var(--border)"}`, cursor:"pointer", background:"var(--bg-elevated)", transition:"border-color 0.2s" }}>
                  {item.mediaType === "video" ? (
                    <div style={{ width:"100%", aspectRatio:"1", background:"#000", display:"flex", alignItems:"center", justifyContent:"center", position:"relative" }}>
                      <video src={item.url} style={{ width:"100%", height:"100%", objectFit:"cover" }} preload="metadata" />
                      <div style={{ position:"absolute", fontSize:24, opacity:0.9 }}>▶</div>
                    </div>
                  ) : (
                    <img src={item.url || item.dataUrl} alt={item.name} style={{ width:"100%", aspectRatio:"1", objectFit:"cover", display:"block" }}
                      onError={e => { e.target.style.opacity="0.3"; }} />
                  )}
                  <div style={{ padding:"6px 8px", background:"var(--bg-surface)" }}>
                    <div style={{ fontSize:10, fontWeight:600, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.name || "Untitled"}</div>
                    <div style={{ display:"flex", gap:3, flexWrap:"wrap", marginTop:3 }}>
                      {(item.tags||[]).slice(0,2).map(tag => (
                        <span key={tag} style={{ fontSize:9, padding:"1px 5px", borderRadius:99, background:"var(--amber-glow)", color:"var(--amber)", border:"1px solid var(--amber)33" }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ position:"absolute", top:4, right:4, display:"flex", gap:3 }} onClick={e=>e.stopPropagation()}>
                    <button onClick={() => copyUrl(item)} title="Copy URL"
                      style={{ width:24, height:24, borderRadius:5, border:"none", background:"rgba(0,0,0,0.65)", color:"#fff", fontSize:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {copied===item.id ? "✓" : "⎘"}
                    </button>
                    <button onClick={() => download(item)} title="Download"
                      style={{ width:24, height:24, borderRadius:5, border:"none", background:"rgba(0,0,0,0.65)", color:"#fff", fontSize:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      ↓
                    </button>
                    <button onClick={() => deleteItem(item.id)} title="Delete"
                      style={{ width:24, height:24, borderRadius:5, border:"none", background:"rgba(160,20,20,0.75)", color:"#fff", fontSize:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {selected && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--amber)44", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:16 }}>
              {/* Top: image + metadata */}
              <div style={{ display:"grid", gridTemplateColumns:"220px 1fr", gap:20 }}>
                {selected.mediaType === "video" ? (
                <video src={selected.url} controls style={{ width:"100%", borderRadius:8, border:"1px solid var(--border)", maxHeight:200 }} />
              ) : (
                <img src={selected.url || selected.dataUrl} alt={selected.name} style={{ width:"100%", borderRadius:8, border:"1px solid var(--border)", objectFit:"contain", maxHeight:200 }} />
              )}
                <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                  <div>
                    <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:5 }}>Name</label>
                    <input value={selected.name || ""} onChange={e=>updateItem(selected.id,{name:e.target.value})}
                      style={iS} onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
                  </div>
                  <div>
                    <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:5 }}>Tags</label>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                      {TAGS.map(tag => {
                        const has = selected.tags?.includes(tag);
                        return (
                          <button key={tag} onClick={() => { const next = has ? selected.tags.filter(t=>t!==tag) : [...(selected.tags||[]),tag]; updateItem(selected.id,{tags:next}); }}
                            style={{ padding:"3px 10px", borderRadius:99, border:has?"1px solid var(--amber)":"1px solid var(--border)", background:has?"var(--amber-glow)":"transparent", color:has?"var(--amber)":"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:5 }}>Notes</label>
                    <textarea value={selected.notes||""} onChange={e=>updateItem(selected.id,{notes:e.target.value})}
                      rows={2} style={{ ...iS, resize:"none", lineHeight:1.5, fontSize:12 }} placeholder="e.g. Used for Spring Hatch post…" />
                  </div>
                  <div style={{ fontSize:11, color:"var(--muted)", display:"flex", gap:12, flexWrap:"wrap" }}>
                    {selected.type && <span>📐 {selected.type.split("/")[1]?.toUpperCase()}</span>}
                    {selected.size && <span>💾 {formatSize(selected.size)}</span>}
                    <span>🗓 {new Date(selected.createdAt).toLocaleDateString()}</span>
                    <span style={{ textTransform:"capitalize" }}>📥 {selected.source}</span>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={() => copyUrl(selected)} style={{ padding:"7px 16px", borderRadius:7, border:"none", background:copied===selected.id?"var(--green)":"var(--amber)", color:"#0e0f11", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      {copied===selected.id ? "✓ Copied!" : "⎘ Copy URL"}
                    </button>
                    <button onClick={() => download(selected)} style={{ padding:"7px 16px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      ↓ Download
                    </button>
                  </div>
                </div>
              </div>

            </div>
          )}
        </>
      )}

      {!loading && items.length === 0 && (
        <div style={{ textAlign:"center", padding:40, color:"var(--muted)", fontSize:13, lineHeight:1.7 }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🖼</div>
          No images yet. Upload files above or click <strong>🖼 Save</strong> on any generated image.
        </div>
      )}
    </div>
  );
}

// ─── LIBRARY IMAGE PICKER ─────────────────────────────────────────────────────
// Inline picker for selecting an image from the Media Library.
// Used in Social Pipeline image stage, HeadlineImagePanel, etc.

function LibraryImagePicker({ onSelect, compact = false, userId }) {
  const resolvedUserId = userId || window.__bbUserId || "anonymous";
  const [open,    setOpen]   = useState(false);
  const [filter,  setFilter] = useState("all");
  const [search,  setSearch] = useState("");
  const [items,   setItems]  = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const res  = await fetch(`/api/gcs?userId=${encodeURIComponent(resolvedUserId)}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch {
      setItems(loadMediaLibraryCache());
    }
    setLoading(false);
  };

  useEffect(() => { fetchItems(); }, [resolvedUserId]);
  useEffect(() => {
    const sync = () => fetchItems();
    window.addEventListener("bb-media-updated", sync);
    return () => window.removeEventListener("bb-media-updated", sync);
  }, [resolvedUserId]);

  const filtered = items.filter(item => {
    const typeMatch  = filter === "all" || item.tags?.includes(filter);
    const searchMatch = !search || item.name?.toLowerCase().includes(search.toLowerCase());
    return typeMatch && searchMatch;
  });

  const tags = ["all", ...new Set(items.flatMap(i => i.tags || []))].slice(0, 8);

  if (items.length === 0) return null;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ padding: compact ? "5px 14px" : "8px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
        🖼 {compact ? "Swap from Library" : `Choose from Library (${items.length})`}
      </button>
    );
  }

  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--amber)44", borderRadius:12, padding:16 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"var(--amber)" }}>🖼 Media Library — {items.length} images</div>
        <button onClick={() => setOpen(false)} style={{ background:"transparent", border:"none", color:"var(--muted)", fontSize:16, cursor:"pointer", padding:2, lineHeight:1 }}>✕</button>
      </div>

      {/* Search */}
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
        style={{ width:"100%", padding:"7px 12px", borderRadius:7, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box", marginBottom:10 }} />

      {/* Tag filters */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:12 }}>
        {tags.map(tag => (
          <button key={tag} onClick={() => setFilter(tag)}
            style={{ padding:"3px 10px", borderRadius:99, border:filter===tag?"1px solid var(--amber)":"1px solid var(--border)", background:filter===tag?"var(--amber-glow)":"transparent", color:filter===tag?"var(--amber)":"var(--text-secondary)", fontSize:10, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", textTransform:"capitalize" }}>
            {tag}
          </button>
        ))}
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:"20px", color:"var(--muted)", fontSize:12 }}>No images match.</div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))", gap:8, maxHeight:260, overflow:"auto" }}>
          {filtered.map(item => (
            <div key={item.id} onClick={() => { onSelect(item.url || item.dataUrl); setOpen(false); }}
              style={{ position:"relative", borderRadius:8, overflow:"hidden", border:"1px solid var(--border)", cursor:"pointer", aspectRatio:"1" }}
              onMouseEnter={e=>{ e.currentTarget.style.borderColor="var(--amber)"; e.currentTarget.querySelector(".overlay").style.opacity="1"; }}
              onMouseLeave={e=>{ e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.querySelector(".overlay").style.opacity="0"; }}>
              <img src={item.url || item.dataUrl} alt={item.name} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
              <div className="overlay" style={{ position:"absolute", inset:0, background:"rgba(196,124,43,0.8)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"#0e0f11", opacity:0, transition:"opacity 0.15s" }}>
                Use This
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize:10, color:"var(--muted)", marginTop:10, lineHeight:1.5 }}>
        Click any image to use it. Add more in Marketing → Media Library.
      </div>
    </div>
  );
}

// ─── VIDEO PLANNING STUDIO ───────────────────────────────────────────────────

const VIDEO_PLAN_STORAGE = "bb_video_plans";
function loadVideoPlans() { try { return JSON.parse(localStorage.getItem(VIDEO_PLAN_STORAGE) || "[]"); } catch { return []; } }
function saveVideoPlansToStorage(p) { try { localStorage.setItem(VIDEO_PLAN_STORAGE, JSON.stringify(p)); } catch {} }

function VideoPlanningStudio({ activeProvider, activeModel, apiKeys, posts, userId }) {
  const [plans,     setPlans]     = useState(loadVideoPlans);
  const [activeTab, setActiveTab] = useState("youtube");
  const [selected,  setSelected]  = useState(null);
  const [generating,setGenerating]= useState(false);
  const [genResult, setGenResult] = useState(null);
  const [genType,   setGenType]   = useState("script");
  const [topic,     setTopic]     = useState("");
  const [error,     setError]     = useState("");

  const savePlans = (next) => { setPlans(next); saveVideoPlansToStorage(next); };

  const TABS = [
    { id:"youtube",  label:"YouTube Vlogs",  icon:"▶", color:"#ff0000" },
    { id:"tiktok",   label:"TikTok",         icon:"🎵", color:"#010101" },
    { id:"reels",    label:"Reels",          icon:"📸", color:"#e1306c" },
    { id:"library",  label:"Video Library",  icon:"🎬", color:"var(--amber)" },
  ];

  const GEN_TYPES = [
    { id:"script",    label:"Full Script",      icon:"📄" },
    { id:"outline",   label:"Video Outline",    icon:"▤"  },
    { id:"hook",      label:"Hook & Intro",      icon:"⚡"  },
    { id:"title",     label:"Title Ideas",       icon:"✦"  },
    { id:"desc",      label:"Description & SEO", icon:"◎"  },
    { id:"chapters",  label:"Chapter Timestamps",icon:"⏱"  },
    { id:"shorts",    label:"Short Clips Ideas", icon:"📱"  },
    { id:"thumbnail", label:"Thumbnail Concept", icon:"🖼"  },
  ];

  const platformConfig = {
    youtube: { name:"YouTube",  maxLen:"10-20 min", format:"Talking head or on-location",      tone:"Educational, storytelling, authentic" },
    tiktok:  { name:"TikTok",   maxLen:"15-60 sec", format:"Vertical, fast-paced, trending",    tone:"Casual, entertaining, hook-driven" },
    reels:   { name:"Reels",    maxLen:"15-90 sec", format:"Vertical, cinematic, lifestyle",    tone:"Aspirational, beautiful, lifestyle-focused" },
  };

  const generate = async () => {
    if (!topic.trim()) return;
    setGenerating(true); setError(""); setGenResult(null);
    const platform = platformConfig[activeTab];
    const brand = loadBrandGuide();
    const brandCtx = buildBrandContext(brand);
    try {
      const prompts = {
        script:    `Write a complete ${platform?.name || activeTab} video script for: "${topic}". Include intro hook, main content sections, and outro with CTA. Format with [SECTION] headers, speaker notes, and B-roll suggestions. Target length: ${platform?.maxLen}. Tone: ${platform?.tone}.`,
        outline:   `Create a detailed video outline for a ${platform?.name} video: "${topic}". Include: hook idea, 4-6 main sections with talking points, B-roll suggestions, CTA ideas. Keep it punchy and scannable.`,
        hook:      `Write 5 different opening hooks (first 3-5 seconds) for a ${platform?.name} video about "${topic}". Each hook should immediately grab attention. Include one question hook, one bold statement, one story hook, one shocking fact, one visual hook.`,
        title:     `Generate 10 ${platform?.name} title ideas for "${topic}". Mix: curiosity gaps, how-to, listicles, emotional triggers. Include SEO-friendly versions. For YouTube, include click-worthy titles. For TikTok/Reels, include trending formats.`,
        desc:      `Write a ${platform?.name} video description for "${topic}". Include: engaging summary paragraph, key talking points as bullet list, relevant hashtags (10-15), call to action, and links placeholder. Optimize for search.`,
        chapters:  `Create YouTube chapter timestamps for a video about "${topic}". Assume a 10-15 minute video. Format: 0:00 - Intro, etc. Make chapters interesting and specific enough to make viewers want to jump to each section.`,
        shorts:    `Suggest 5 short-form clip ideas from a video about "${topic}" that would work as YouTube Shorts, TikToks, or Reels. For each: describe the clip, the hook, why it works as a short, and the ideal length.`,
        thumbnail: `Describe a compelling YouTube thumbnail concept for "${topic}". Include: main visual element, text overlay (max 3 words), color scheme, facial expression if applicable, and why it would get high CTR. Also suggest 2 alternatives.`,
      };

      const text = await callAI(activeProvider, activeModel,
        `${brandCtx}You are a content strategist specializing in fly fishing and whiskey lifestyle video content for Cask & Stream. Platform: ${platform?.name || activeTab}. Format: ${platform?.format || ""}. Create engaging, authentic content that resonates with fly fishing enthusiasts and whiskey lovers.`,
        prompts[genType] || prompts.script,
        apiKeys[activeProvider],
        2500
      );

      const plan = {
        id:        Date.now(),
        platform:  activeTab,
        topic:     topic.trim(),
        type:      genType,
        content:   text,
        createdAt: new Date().toISOString(),
        status:    "idea",
      };
      setGenResult(plan);
    } catch(e) { setError(e.message); }
    setGenerating(false);
  };

  const savePlan = () => {
    if (!genResult) return;
    savePlans([genResult, ...plans]);
    setGenResult(null);
    setTopic("");
  };

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {/* Header */}
      <div>
        <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>🎬 Video Planning Studio</h2>
        <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Plan, script, and organize your YouTube vlogs, TikToks, and Reels — all in one place.</p>
      </div>

      {/* Platform tabs */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{ padding:"7px 18px", borderRadius:8, border:`1px solid ${activeTab===t.id?t.color:"var(--border)"}`, background:activeTab===t.id?t.color+"15":"transparent", color:activeTab===t.id?t.color:"var(--text-secondary)", fontSize:12, fontWeight:activeTab===t.id?700:400, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {activeTab === "library" ? (
        /* ── VIDEO LIBRARY ── */
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Videos uploaded to your Media Library appear here for easy access.</p>
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:24, textAlign:"center", color:"var(--muted)", fontSize:13 }}>
            <div style={{ fontSize:32, marginBottom:12 }}>🎬</div>
            Upload videos in the <strong style={{ color:"var(--text)" }}>Media Library</strong> tab — they'll appear here organized by platform tag.
          </div>
          {plans.length > 0 && (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>Saved Plans</div>
              {plans.map(plan => (
                <div key={plan.id} style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:10, padding:16, cursor:"pointer" }}
                  onClick={() => setSelected(selected?.id===plan.id ? null : plan)}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:"var(--amber-glow)", color:"var(--amber)", fontWeight:600, marginRight:8, textTransform:"capitalize" }}>{plan.platform} · {plan.type}</span>
                      <span style={{ fontSize:13, fontWeight:600 }}>{plan.topic}</span>
                    </div>
                    <span style={{ fontSize:11, color:"var(--muted)" }}>{new Date(plan.createdAt).toLocaleDateString()}</span>
                  </div>
                  {selected?.id === plan.id && (
                    <pre style={{ marginTop:12, fontSize:12, lineHeight:1.7, color:"var(--text-secondary)", whiteSpace:"pre-wrap", fontFamily:"var(--font-body)" }}>{plan.content}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ── GENERATOR ── */
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Topic input */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:14 }}>
            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                Video Topic or Idea
              </label>
              <input value={topic} onChange={e=>setTopic(e.target.value)}
                placeholder={`e.g. "Early morning dry fly fishing on the Toccoa River" or "Pairing bourbon with fly fishing — our favorite combos"`}
                style={iS}
                onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"}
                onKeyDown={e=>e.key==="Enter"&&generate()} />
            </div>

            {/* Quick ideas from existing posts */}
            {posts.length > 0 && (
              <div>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Quick ideas from your blog posts</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {posts.filter(p=>p.status==="published").slice(0,5).map(post => (
                    <button key={post.id} onClick={() => setTopic(`Turn blog post into video: "${post.title}"`)}
                      style={{ padding:"4px 10px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                      📄 {post.title?.slice(0,35)}…
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Content type picker */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>What do you need?</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:6 }}>
                {GEN_TYPES.map(g => (
                  <button key={g.id} onClick={() => setGenType(g.id)}
                    style={{ padding:"8px 12px", borderRadius:8, border:`1px solid ${genType===g.id?"var(--amber)":"var(--border)"}`, background:genType===g.id?"var(--amber-glow)":"transparent", color:genType===g.id?"var(--amber)":"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6, textAlign:"left", fontWeight:genType===g.id?600:400 }}>
                    <span>{g.icon}</span>{g.label}
                  </button>
                ))}
              </div>
            </div>

            {error && <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:12 }}>{error}</div>}

            <button onClick={generate} disabled={generating || !topic.trim()}
              style={{ padding:"10px 24px", borderRadius:8, border:"none", background:generating||!topic.trim()?"var(--bg-elevated)":"var(--amber)", color:generating||!topic.trim()?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:generating||!topic.trim()?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8, alignSelf:"flex-start" }}>
              {generating ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Generating…</> : `🎬 Generate ${GEN_TYPES.find(g=>g.id===genType)?.label}`}
            </button>
          </div>

          {/* Generated result */}
          {genResult && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--amber)44", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:14 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:"var(--amber)", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4 }}>
                    {activeTab.toUpperCase()} · {GEN_TYPES.find(g=>g.id===genType)?.label}
                  </div>
                  <div style={{ fontSize:15, fontWeight:600 }}>{genResult.topic}</div>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => navigator.clipboard.writeText(genResult.content)}
                    style={{ padding:"6px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    ⎘ Copy
                  </button>
                  <button onClick={savePlan}
                    style={{ padding:"6px 14px", borderRadius:7, border:"none", background:"#5cba6c", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    ✓ Save Plan
                  </button>
                  <button onClick={generate}
                    style={{ padding:"6px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    ↻ Regenerate
                  </button>
                </div>
              </div>
              <pre style={{ fontSize:13, lineHeight:1.8, color:"var(--text)", whiteSpace:"pre-wrap", fontFamily:"var(--font-body)", background:"var(--bg-elevated)", padding:"16px", borderRadius:8, overflow:"auto", maxHeight:500 }}>
                {genResult.content}
              </pre>
            </div>
          )}

          {/* Saved plans for this platform */}
          {plans.filter(p=>p.platform===activeTab).length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>
                Saved {TABS.find(t=>t.id===activeTab)?.label} Plans ({plans.filter(p=>p.platform===activeTab).length})
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {plans.filter(p=>p.platform===activeTab).slice(0,5).map(plan => (
                  <div key={plan.id} style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", cursor:"pointer" }}
                    onClick={() => setSelected(selected?.id===plan.id ? null : plan)}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                        <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:"var(--bg-surface)", color:"var(--text-secondary)", border:"1px solid var(--border)" }}>{GEN_TYPES.find(g=>g.id===plan.type)?.label || plan.type}</span>
                        <span style={{ fontSize:12, fontWeight:500 }}>{plan.topic}</span>
                      </div>
                      <div style={{ display:"flex", gap:6 }}>
                        <span style={{ fontSize:10, color:"var(--muted)" }}>{new Date(plan.createdAt).toLocaleDateString()}</span>
                        <button onClick={e=>{ e.stopPropagation(); savePlans(plans.filter(p=>p.id!==plan.id)); }}
                          style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:13, padding:0 }}>✕</button>
                      </div>
                    </div>
                    {selected?.id === plan.id && (
                      <pre style={{ marginTop:10, fontSize:12, lineHeight:1.7, color:"var(--text-secondary)", whiteSpace:"pre-wrap", fontFamily:"var(--font-body)", maxHeight:300, overflow:"auto" }}>{plan.content}</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── INSPIRATION BOARD ───────────────────────────────────────────────────────

function InspirationBoard({ inspiration, onAddNew, onDelete, onToDraft, card, btnS, btnP, toDraftLabel = "→ Draft" }) {
  const [inspFilter, setInspFilter] = useState("all");
  const [inspSearch, setInspSearch] = useState("");

  const ALL_TYPES = [
    { id:"all",       label:"All",       icon:"◈" },
    { id:"article",   label:"Article",   icon:"📄" },
    { id:"instagram", label:"Instagram", icon:"📸" },
    { id:"facebook",  label:"Facebook",  icon:"👍" },
    { id:"tiktok",    label:"TikTok",    icon:"🎵" },
    { id:"twitter",   label:"X",         icon:"🐦" },
    { id:"pinterest", label:"Pinterest", icon:"📌" },
    { id:"youtube",   label:"YouTube",   icon:"▶" },
    { id:"podcast",   label:"Podcast",   icon:"🎙" },
    { id:"email",     label:"Email",     icon:"✉" },
    { id:"visual",    label:"Visual",    icon:"🖼" },
    { id:"thread",    label:"Thread",    icon:"💬" },
    { id:"keyword",   label:"Keyword",   icon:"◎" },
    { id:"video",     label:"Video",     icon:"🎬" },
  ];

  const typeConfig = {
    article:{icon:"📄",color:"var(--amber)"},
    instagram:{icon:"📸",color:"#e1306c"},
    facebook:{icon:"👍",color:"#1877f2"},
    tiktok:{icon:"🎵",color:"#010101"},
    twitter:{icon:"🐦",color:"#1da1f2"},
    pinterest:{icon:"📌",color:"#e60023"},
    youtube:{icon:"▶",color:"var(--red)"},
    podcast:{icon:"🎙",color:"#a78bfa"},
    email:{icon:"✉",color:"#5cba6c"},
    visual:{icon:"🖼",color:"#7c8abf"},
    thread:{icon:"💬",color:"#5cba6c"},
    keyword:{icon:"◎",color:"#7c3aed"},
    video:{icon:"🎬",color:"var(--red)"},
  };

  const presentTypes = new Set(inspiration.map(i => i.type || "article"));
  const visibleFilters = ALL_TYPES.filter(t => t.id === "all" || presentTypes.has(t.id));

  const filtered = inspiration.filter(item => {
    const typeMatch  = inspFilter === "all" || (item.type || "article") === inspFilter;
    const searchMatch = !inspSearch || item.title?.toLowerCase().includes(inspSearch.toLowerCase()) || item.source?.toLowerCase().includes(inspSearch.toLowerCase()) || item.notes?.toLowerCase().includes(inspSearch.toLowerCase());
    return typeMatch && searchMatch;
  });

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h2 style={{fontFamily:"var(--font-display)",fontSize:20,fontWeight:700,margin:"0 0 4px"}}>Inspiration Board</h2>
          <p style={{fontSize:12,color:"var(--text-secondary)",margin:0}}>{inspiration.length} idea{inspiration.length!==1?"s":""} saved</p>
        </div>
        <button onClick={onAddNew} style={btnP}>+ Save New</button>
      </div>

      {inspiration.length > 0 && (
        <>
          <input value={inspSearch} onChange={e=>setInspSearch(e.target.value)}
            placeholder="Search ideas…"
            style={{ width:"100%", padding:"9px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box", marginBottom:10 }}
            onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"} />

          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:16}}>
            {visibleFilters.map(f => {
              const count = f.id === "all" ? inspiration.length : inspiration.filter(i=>(i.type||"article")===f.id).length;
              return (
                <button key={f.id} onClick={()=>setInspFilter(f.id)}
                  style={{padding:"5px 12px",borderRadius:99,border:inspFilter===f.id?"1px solid var(--amber)":"1px solid var(--border)",background:inspFilter===f.id?"var(--amber-glow)":"transparent",color:inspFilter===f.id?"var(--amber)":"var(--text-secondary)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:4}}>
                  <span>{f.icon}</span>{f.label}
                  <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99,background:"var(--bg-elevated)",color:"var(--muted)",marginLeft:2}}>{count}</span>
                </button>
              );
            })}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {filtered.map(item => {
              const tc = typeConfig[item.type] || typeConfig.article;
              return (
                <div key={item.id} style={{...card,padding:18,display:"flex",gap:16,alignItems:"flex-start"}}>
                  <div style={{width:40,height:40,borderRadius:10,background:tc.color+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{tc.icon}</div>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                      <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",color:tc.color}}>{item.type||"article"}</span>
                      <span style={{fontSize:11,color:"var(--text-secondary)"}}>from {item.source}</span>
                    </div>
                    <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>{item.title}</div>
                    {item.notes&&<div style={{fontSize:12,color:"var(--text-secondary)",fontStyle:"italic"}}>💡 {item.notes}</div>}
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <button onClick={()=>onToDraft(item)} style={{...btnS,fontSize:11,padding:"5px 10px"}}>{toDraftLabel}</button>
                    <button onClick={()=>onDelete(item.id)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:14,padding:"5px"}} title="Remove">✕</button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{...card,padding:32,textAlign:"center",color:"var(--muted)",fontSize:13}}>
                {inspSearch || inspFilter !== "all" ? "No ideas match your filter — try clearing it." : "No inspiration saved yet."}
              </div>
            )}
          </div>
        </>
      )}

      {inspiration.length === 0 && (
        <div style={{...card,padding:32,textAlign:"center",color:"var(--muted)",fontSize:13}}>
          No inspiration saved yet. Click + Save New or use AI Ideas to generate content ideas.
        </div>
      )}
    </div>
  );
}

// ─── ANALYTICS DASHBOARD ─────────────────────────────────────────────────────

function AnalyticsDashboard({ posts, gscData, metaConfig, socialPosts, dark, userId, onConnectGSC, onGSCDataLoaded, onConnectMeta, activeProvider, activeModel, apiKeys }) {
  const [tab, setTab] = useState("overview");
  const [socialInsights, setSocialInsights] = useState(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [insightError, setInsightError] = useState("");

  const TABS = [
    { id:"overview", label:"Overview",    icon:"◈" },
    { id:"seo",      label:"SEO",         icon:"◎", highlight:true },
    { id:"search",   label:"Search Data", icon:"📊" },
    { id:"connect",  label:"🔌 Fetch Data",icon:"",  highlight: !gscData },
    { id:"social",   label:"Social",      icon:"▣" },
    { id:"content",  label:"Content",     icon:"▤" },
  ];

  // ── FETCH META SOCIAL INSIGHTS ─────────────────────────────────────────────
  const fetchSocialInsights = async () => {
    if (!metaConfig?.connected || !metaConfig?.pages?.length) return;
    setLoadingInsights(true); setInsightError("");
    try {
      const page   = metaConfig.pages[0];
      const token  = page.access_token;
      const pageId = page.id;
      const igId   = page.instagram_id;
      const results = {};

      // Facebook Page insights — use separate calls per metric with correct periods
      // NOTE: page_fans and page_impressions were deprecated by Meta on Nov 15, 2025
      // and now return an "invalid metric" 400 error on every API version. page_fans
      // is covered below via the direct fan_count/followers_count field fetch instead.
      const fbMetrics = [
        { metric: "page_post_engagements", period: "week" },
        { metric: "page_views_total",      period: "week" },
      ];

      results.facebook = {};
      await Promise.all(fbMetrics.map(async ({ metric, period }) => {
        try {
          const res  = await fetch(
            `https://graph.facebook.com/v19.0/${pageId}/insights?metric=${metric}&period=${period}&access_token=${token}`
          );
          const data = await res.json();
          if (!data.error && data.data?.length) {
            const vals = data.data[0]?.values;
            results.facebook[metric] = vals?.[vals.length - 1]?.value ?? null;
          }
        } catch {}
      }));

      // Also get page fan count directly (more reliable)
      try {
        const fanRes  = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=fan_count,followers_count&access_token=${token}`);
        const fanData = await fanRes.json();
        if (!fanData.error) {
          if (fanData.fan_count       != null) results.facebook.page_fans      = fanData.fan_count;
          if (fanData.followers_count != null) results.facebook.followers_count = fanData.followers_count;
        }
      } catch {}

      // Instagram — get follower count from account endpoint, insights from insights
      if (igId) {
        results.instagram = {};

        // Follower count from IG account directly
        try {
          const igAccRes  = await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=followers_count,media_count,name,username&access_token=${token}`);
          const igAccData = await igAccRes.json();
          if (!igAccData.error) {
            if (igAccData.followers_count != null) results.instagram.follower_count = igAccData.followers_count;
            if (igAccData.media_count     != null) results.instagram.media_count    = igAccData.media_count;
          }
        } catch {}

        // IG insights
        try {
          // NOTE: "impressions" was deprecated by Meta in favor of "views"
          const igRes  = await fetch(
            `https://graph.facebook.com/v19.0/${igId}/insights?metric=views,reach,profile_views&period=week&access_token=${token}`
          );
          const igData = await igRes.json();
          if (!igData.error) {
            (igData.data || []).forEach(m => {
              const vals = m.values;
              results.instagram[m.name] = vals?.[vals.length - 1]?.value ?? null;
            });
          }
        } catch {}
      }

      // Only set insights if we got some data
      const hasFBData = Object.values(results.facebook || {}).some(v => v != null);
      const hasIGData = Object.values(results.instagram || {}).some(v => v != null);

      if (!hasFBData && !hasIGData) {
        setInsightError("No data returned — your Facebook Page may need 'Insights' permission or have insufficient activity. Make sure you're connected as a Page Admin.");
      } else {
        setSocialInsights(results);
      }
    } catch(e) { setInsightError(e.message); }
    setLoadingInsights(false);
  };

  useEffect(() => {
    if (tab === "social" && !socialInsights && metaConfig?.connected) {
      fetchSocialInsights();
    }
  }, [tab, metaConfig]);

  // ── DERIVED STATS ──────────────────────────────────────────────────────────
  const publishedPosts    = posts.filter(p => p.status === "published").length;
  const draftPosts        = posts.filter(p => p.status === "draft").length;
  const scheduledPosts    = socialPosts.filter(p => p.status === "scheduled").length;
  const publishedSocial   = socialPosts.filter(p => p.status === "published").length;
  const gscClicks         = gscData?.totalClicks || 0;
  const gscImpressions    = gscData?.totalImpressions || 0;
  const avgPosition       = gscData?.keywords?.length
    ? (gscData.keywords.reduce((s,k) => s + k.position, 0) / gscData.keywords.length).toFixed(1)
    : "—";

  const StatCard = ({ label, value, sub, color = "var(--amber)", icon }) => (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
      <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:8, display:"flex", alignItems:"center", gap:6 }}>
        {icon && <span>{icon}</span>}{label}
      </div>
      <div style={{ fontFamily:"var(--font-display)", fontSize:28, fontWeight:700, color }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:4 }}>{sub}</div>}
    </div>
  );

  const ConnectPrompt = ({ icon, title, desc, action, onAction }) => (
    <div style={{ textAlign:"center", padding:"48px 20px", background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12 }}>
      <div style={{ fontSize:40, marginBottom:16 }}>{icon}</div>
      <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, marginBottom:8 }}>{title}</h3>
      <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:24, maxWidth:400, margin:"0 auto 24px", lineHeight:1.6 }}>{desc}</p>
      <button onClick={onAction}
        style={{ padding:"10px 24px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
        {action} →
      </button>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, margin:"0 0 4px" }}>Analytics</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>Search performance, social reach, and content insights in one place.</p>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {gscData && <span style={{ fontSize:11, color:"#5cba6c", padding:"3px 10px", borderRadius:99, background:"#5cba6c11", border:"1px solid #5cba6c33" }}>● GSC Connected</span>}
          {metaConfig?.connected && <span style={{ fontSize:11, color:"#1877f2", padding:"3px 10px", borderRadius:99, background:"#1877f211", border:"1px solid #1877f233" }}>● Meta Connected</span>}
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding:"7px 18px", borderRadius:8, border:tab===t.id?"1px solid var(--amber)":"1px solid var(--border)", background:tab===t.id?"var(--amber-glow)":"transparent", color:tab===t.id?"var(--amber)":"var(--text-secondary)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
            <span>{t.icon}</span>{t.label}
            {t.highlight && tab!==t.id && <span style={{ fontSize:8, fontWeight:700, padding:"1px 5px", borderRadius:99, background:"var(--amber)", color:"#0e0f11" }}>AI</span>}
          </button>
        ))}
      </div>

      {/* ── FETCH DATA ── */}
      {tab === "connect" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:0 }}>Fetch Analytics Data</h3>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0, lineHeight:1.7 }}>
            Fetch fresh data from Google Search Console right here, without leaving this tab. Use Settings → Search Console only if you need to change or reconnect the account.
          </p>
          <GSCPanel onDataLoaded={(data) => {
            // Save directly and stay on this tab — do NOT navigate to Settings
            if (onGSCDataLoaded) onGSCDataLoaded(data);
          }} />
        </div>
      )}

      {/* ── SEO ── */}
      {tab === "seo" && (
        <SEODashboard
          posts={posts}
          gscData={gscData}
          activeProvider={activeProvider}
          activeModel={activeModel}
          apiKeys={apiKeys}
          onConnectGSC={onConnectGSC}
        />
      )}

      {/* ── OVERVIEW ── */}
      {tab === "overview" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Key numbers */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:12 }}>
            <StatCard label="Blog Posts Published" value={publishedPosts} sub={`${draftPosts} drafts`} icon="📄" />
            <StatCard label="GSC Clicks" value={gscClicks.toLocaleString()} sub={gscData ? `Last ${gscData.days} days` : "Connect GSC"} color={gscData?"var(--amber)":"var(--muted)"} icon="◎" />
            <StatCard label="GSC Impressions" value={gscImpressions.toLocaleString()} sub="Search appearances" color={gscData?"var(--amber)":"var(--muted)"} icon="👁" />
            <StatCard label="Social Posts" value={publishedSocial} sub={`${scheduledPosts} scheduled`} icon="📸" />
          </div>

          {/* Quick status of connected sources */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            {/* GSC quick view */}
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"var(--text)" }}>◎ Search Console</div>
                {gscData ? (
                  <button onClick={onConnectGSC} style={{ fontSize:11, color:"var(--amber)", background:"none", border:"none", cursor:"pointer", fontFamily:"var(--font-body)" }}>Refresh ↻</button>
                ) : (
                  <button onClick={onConnectGSC} style={{ fontSize:11, color:"var(--amber)", background:"none", border:"none", cursor:"pointer", fontFamily:"var(--font-body)" }}>Connect →</button>
                )}
              </div>
              {gscData ? (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {gscData.keywords?.slice(0,5).map((k,i) => (
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12 }}>
                      <span style={{ color:"var(--text-secondary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"60%" }}>{k.query}</span>
                      <div style={{ display:"flex", gap:10, flexShrink:0 }}>
                        <span style={{ fontWeight:700, color:"var(--amber)" }}>{k.clicks}</span>
                        <span style={{ color:"var(--muted)" }}>#{k.position.toFixed(0)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize:12, color:"var(--muted)", lineHeight:1.6 }}>Connect Google Search Console to see which keywords and pages are driving organic traffic to your blog.</div>
              )}
            </div>

            {/* Social quick view */}
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"var(--text)" }}>▣ Social Performance</div>
                {!metaConfig?.connected && (
                  <button onClick={onConnectMeta} style={{ fontSize:11, color:"var(--amber)", background:"none", border:"none", cursor:"pointer", fontFamily:"var(--font-body)" }}>Connect →</button>
                )}
              </div>
              {socialPosts.length > 0 ? (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {socialPosts.filter(p=>p.status==="published").slice(0,4).map((post,i) => {
                    const caption = Object.values(post.captions||{})[0];
                    const text = typeof caption === "string" ? caption : caption?.text || "Post";
                    return (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12 }}>
                        <span style={{ color:"var(--text-secondary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"70%" }}>{text.slice(0,50)}…</span>
                        <span style={{ fontSize:10, color:"#5cba6c", flexShrink:0, marginLeft:8 }}>✓ Published</span>
                      </div>
                    );
                  })}
                  {socialPosts.filter(p=>p.status==="published").length === 0 && (
                    <div style={{ fontSize:12, color:"var(--muted)" }}>No published social posts yet. Use the Marketing → Social Pipeline to create and publish posts.</div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize:12, color:"var(--muted)", lineHeight:1.6 }}>No social posts yet. Create posts in Marketing → Social Pipeline to track performance here.</div>
              )}
            </div>
          </div>

          {/* Top content */}
          {posts.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>Your Blog Posts</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:10 }}>
                {posts.slice(0,6).map(post => {
                  const gscPage = gscData?.topPages?.find(p => p.page.includes(post.title?.toLowerCase().replace(/\s+/g,"-")));
                  return (
                    <div key={post.id} style={{ padding:"12px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                      <div style={{ fontSize:12, fontWeight:600, marginBottom:6, lineHeight:1.4 }}>{post.title}</div>
                      <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                        <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:post.status==="published"?"#5cba6c15":"var(--bg-surface)", color:post.status==="published"?"#5cba6c":"var(--muted)", border:`1px solid ${post.status==="published"?"#5cba6c33":"var(--border)"}`, textTransform:"capitalize" }}>{post.status}</span>
                        {gscPage && <span style={{ fontSize:11, color:"var(--amber)" }}>◎ {gscPage.clicks} clicks</span>}
                        <span style={{ fontSize:10, color:"var(--muted)", marginLeft:"auto" }}>{post.date || post.createdAt?.slice(0,10)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SEARCH (GSC) ── */}
      {tab === "search" && (
        <div>
          {!gscData ? (
            <ConnectPrompt
              icon="◎"
              title="Connect Google Search Console"
              desc="See which keywords drive traffic to your blog, your average search position, click-through rates, and which posts perform best in Google."
              action="Connect Search Console"
              onAction={onConnectGSC}
            />
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {/* Summary */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:12 }}>
                <StatCard label="Total Clicks"      value={gscData.totalClicks.toLocaleString()}       sub={`Last ${gscData.days} days`} />
                <StatCard label="Impressions"        value={gscData.totalImpressions.toLocaleString()} sub="Search appearances" />
                <StatCard label="Avg CTR"            value={`${(gscData.totalClicks/Math.max(gscData.totalImpressions,1)*100).toFixed(1)}%`} sub="Click-through rate" color="#5cba6c" />
                <StatCard label="Avg Position"       value={avgPosition} sub="Google rank" color="#7c3aed" />
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
                {/* Top Keywords */}
                <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                  <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>Top Keywords</div>
                  <table style={{ width:"100%", borderCollapse:"collapse" }}>
                    <thead>
                      <tr style={{ borderBottom:"1px solid var(--border)" }}>
                        {["Query","Clicks","Impr.","Pos.","CTR"].map(h=>(
                          <th key={h} style={{ textAlign:"left", padding:"6px 8px", fontSize:9, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gscData.keywords.slice(0,15).map((k,i) => (
                        <tr key={i} style={{ borderBottom:"1px solid var(--border)11" }}>
                          <td style={{ padding:"7px 8px", fontSize:12 }}>{k.query}</td>
                          <td style={{ padding:"7px 8px", fontSize:12, fontWeight:700, color:"var(--amber)" }}>{k.clicks}</td>
                          <td style={{ padding:"7px 8px", fontSize:11, color:"var(--text-secondary)" }}>{k.impressions}</td>
                          <td style={{ padding:"7px 8px", fontSize:11, color:"var(--text-secondary)" }}>#{k.position.toFixed(1)}</td>
                          <td style={{ padding:"7px 8px", fontSize:11, color:"#5cba6c" }}>{k.impressions>0?(k.clicks/k.impressions*100).toFixed(1):0}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Top Pages */}
                <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                  <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>Top Pages by Clicks</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {gscData.topPages.slice(0,10).map((p,i) => {
                      const slug = p.page.replace(/https?:\/\/[^/]+/, "").replace(/\/$/, "") || "/";
                      const max  = gscData.topPages[0]?.clicks || 1;
                      return (
                        <div key={i}>
                          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                            <span style={{ fontSize:11, color:"var(--text-secondary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"75%" }} title={p.page}>{slug}</span>
                            <div style={{ flexShrink:0, marginLeft:8, display:"flex", gap:10 }}>
                              <span style={{ fontSize:12, fontWeight:700, color:"var(--amber)" }}>{p.clicks}</span>
                              {p.impressions && <span style={{ fontSize:11, color:"var(--muted)" }}>{p.impressions} impr</span>}
                            </div>
                          </div>
                          <div style={{ height:4, borderRadius:99, background:"var(--bg-elevated)" }}>
                            <div style={{ height:"100%", width:`${(p.clicks/max)*100}%`, background:"var(--amber)", borderRadius:99 }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{ fontSize:11, color:"var(--muted)", padding:"8px 0", display:"flex", justifyContent:"space-between" }}>
                <span>Data from Google Search Console · Last {gscData.days} days · Fetched {new Date(gscData.fetchedAt).toLocaleString()}</span>
                <button onClick={onConnectGSC} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--amber)", fontSize:11, fontFamily:"var(--font-body)" }}>↻ Refresh</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SOCIAL ── */}
      {tab === "social" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {!metaConfig?.connected ? (
            <ConnectPrompt
              icon="📊"
              title="Connect Facebook & Instagram"
              desc="See your page impressions, engagement, follower growth, and which posts performed best — pulled directly from Meta's API."
              action="Connect Facebook & Instagram"
              onAction={onConnectMeta}
            />
          ) : (
            <>
              {/* Refresh button */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 2px" }}>Social Analytics</h3>
                  <p style={{ fontSize:12, color:"var(--text-secondary)", margin:0 }}>Last 28 days · pulled from Meta API</p>
                </div>
                <button onClick={fetchSocialInsights} disabled={loadingInsights}
                  style={{ padding:"8px 18px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
                  {loadingInsights ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Loading…</> : "↻ Refresh"}
                </button>
              </div>

              {insightError && (
                <div style={{ padding:"12px 16px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:13 }}>
                  {insightError}
                </div>
              )}

              {loadingInsights && (
                <div style={{ textAlign:"center", padding:40, color:"var(--muted)", fontSize:13 }}>
                  <span style={{ animation:"spin 1s linear infinite", display:"inline-block", marginRight:8 }}>◌</span>
                  Fetching insights from Meta…
                </div>
              )}

              {socialInsights && (
                <>
                  {/* Platform overview cards */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
                    {socialInsights.facebook && (
                      <div style={{ background:"var(--bg-surface)", border:"1px solid #1877f233", borderRadius:12, padding:20 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:"#1877f2", marginBottom:14, display:"flex", alignItems:"center", gap:6 }}>
                          👍 Facebook Page
                        </div>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                          {[
                            { key:"page_fans",             label:"Fans",         icon:"❤" },
                            { key:"page_impressions",      label:"Impressions",   icon:"👁" },
                            { key:"page_post_engagements", label:"Engagements",   icon:"💬" },
                            { key:"page_views_total",      label:"Page Views",    icon:"🔗" },
                          ].map(({ key, label, icon }) => socialInsights.facebook[key] != null && (
                            <div key={key} style={{ padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                              <div style={{ fontSize:9, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:3 }}>{icon} {label}</div>
                              <div style={{ fontSize:22, fontWeight:700, color:"#1877f2" }}>{socialInsights.facebook[key]?.toLocaleString()}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {socialInsights.instagram && (
                      <div style={{ background:"var(--bg-surface)", border:"1px solid #e1306c33", borderRadius:12, padding:20 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:"#e1306c", marginBottom:14, display:"flex", alignItems:"center", gap:6 }}>
                          📸 Instagram
                        </div>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                          {[
                            { key:"follower_count", label:"Followers",     icon:"👤" },
                            { key:"views",          label:"Views",         icon:"👁" },
                            { key:"reach",          label:"Reach",         icon:"📡" },
                            { key:"profile_views",  label:"Profile Views", icon:"🔗" },
                          ].map(({ key, label, icon }) => socialInsights.instagram[key] != null && (
                            <div key={key} style={{ padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                              <div style={{ fontSize:9, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:3 }}>{icon} {label}</div>
                              <div style={{ fontSize:22, fontWeight:700, color:"#e1306c" }}>{socialInsights.instagram[key]?.toLocaleString()}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Engagement rate */}
                  {socialInsights.facebook && (
                    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                      <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>📈 Engagement Breakdown</div>
                      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))", gap:10 }}>
                        {[
                          { key:"page_actions_post_reactions_like_total", label:"Likes",    color:"#1877f2" },
                          { key:"page_actions_post_reactions_love_total", label:"Love",     color:"#e05555" },
                          { key:"page_posts_impressions",                 label:"Post Reach",color:"#5cba6c" },
                          { key:"page_fans_online_per_day",               label:"Online Now",color:"var(--amber)" },
                        ].filter(m => socialInsights.facebook[m.key] != null).map(m => (
                          <div key={m.key} style={{ padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", textAlign:"center" }}>
                            <div style={{ fontSize:9, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>{m.label}</div>
                            <div style={{ fontSize:18, fontWeight:700, color:m.color }}>{socialInsights.facebook[m.key]?.toLocaleString?.() ?? socialInsights.facebook[m.key]}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {!loadingInsights && !socialInsights && !insightError && (
                <div style={{ textAlign:"center", padding:40 }}>
                  <div style={{ fontSize:32, marginBottom:12 }}>📊</div>
                  <p style={{ fontSize:13, color:"var(--muted)", marginBottom:20 }}>Pull live data from your Facebook and Instagram accounts.</p>
                  <button onClick={fetchSocialInsights}
                    style={{ padding:"10px 28px", borderRadius:8, border:"none", background:"#1877f2", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                    Load Social Analytics
                  </button>
                </div>
              )}

              {/* Published posts with engagement */}
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>
                  Published Social Posts ({socialPosts.filter(p=>p.status==="published").length})
                </div>
                {socialPosts.filter(p=>p.status==="published").length === 0 ? (
                  <div style={{ fontSize:13, color:"var(--muted)", textAlign:"center", padding:20 }}>No published posts yet.</div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {socialPosts.filter(p=>p.status==="published").slice(0,10).map((post,i) => {
                      const caption = Object.values(post.captions||{})[0];
                      const text = typeof caption === "string" ? caption : caption?.text || "";
                      return (
                        <div key={i} style={{ display:"flex", gap:12, alignItems:"flex-start", padding:"12px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                          {post.imageUrl && <img src={post.imageUrl} alt="" style={{ width:52, height:52, borderRadius:6, objectFit:"cover", flexShrink:0 }} />}
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:12, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:4 }}>{text.slice(0,100)}</div>
                            <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
                              {post.platforms?.map(p => {
                                const platCfg = SOCIAL_PLATFORMS.find(sp => sp.id === p);
                                return platCfg ? <span key={p} style={{ fontSize:10, padding:"1px 6px", borderRadius:99, background:platCfg.color+"15", color:platCfg.color, border:`1px solid ${platCfg.color}33` }}>{platCfg.icon} {platCfg.name}</span> : null;
                              })}
                              <span style={{ fontSize:10, color:"var(--muted)", marginLeft:"auto" }}>
                                {post.publishedAt ? new Date(post.publishedAt).toLocaleDateString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : ""}
                              </span>
                              {post.results && Object.values(post.results).some(r=>r.success) && (
                                <span style={{ fontSize:10, color:"#5cba6c", fontWeight:600 }}>✓ Published</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CONTENT ── */}
      {tab === "content" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Blog post performance */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:16 }}>Blog Post Performance</div>
            {posts.length === 0 ? (
              <div style={{ fontSize:13, color:"var(--muted)" }}>No posts yet — create your first post in the Pipeline.</div>
            ) : (
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid var(--border)" }}>
                    {["Title","Status","Date","GSC Clicks","GSC Position"].map(h=>(
                      <th key={h} style={{ textAlign:"left", padding:"8px 10px", fontSize:9, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {posts.map((post,i) => {
                    const slug = post.title?.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"");
                    const gscPage = gscData?.topPages?.find(p => p.page.includes(slug));
                    const gscKw   = gscData?.keywords?.filter(k => k.query.includes(post.title?.split(" ")[0]?.toLowerCase() || ""))[0];
                    return (
                      <tr key={post.id} style={{ borderBottom:"1px solid var(--border)11" }}>
                        <td style={{ padding:"10px 10px", fontSize:12, fontWeight:500, maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{post.title}</td>
                        <td style={{ padding:"10px 10px" }}>
                          <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:post.status==="published"?"#5cba6c15":"var(--bg-elevated)", color:post.status==="published"?"#5cba6c":"var(--muted)", border:`1px solid ${post.status==="published"?"#5cba6c33":"var(--border)"}`, textTransform:"capitalize" }}>{post.status}</span>
                        </td>
                        <td style={{ padding:"10px 10px", fontSize:11, color:"var(--text-secondary)" }}>{post.date || post.createdAt?.slice(0,10) || "—"}</td>
                        <td style={{ padding:"10px 10px", fontSize:12, fontWeight:700, color:gscPage?"var(--amber)":"var(--muted)" }}>{gscPage ? gscPage.clicks : "—"}</td>
                        <td style={{ padding:"10px 10px", fontSize:12, color:gscKw?"#7c3aed":"var(--muted)" }}>{gscKw ? `#${gscKw.position.toFixed(0)}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Content gap — posts without GSC data */}
          {gscData && posts.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Ranking Keywords Without Posts</div>
              <p style={{ fontSize:12, color:"var(--text-secondary)", marginBottom:14, lineHeight:1.6 }}>
                These keywords are already sending you traffic but you don't have dedicated posts for them yet — quick wins for new content.
              </p>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {gscData.keywords
                  .filter(k => k.clicks > 0 && k.position < 20)
                  .filter(k => !posts.some(p => p.title?.toLowerCase().includes(k.query.split(" ")[0]?.toLowerCase())))
                  .slice(0, 8)
                  .map((k,i) => (
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px", borderRadius:7, background:"var(--bg-elevated)" }}>
                      <span style={{ fontSize:12 }}>{k.query}</span>
                      <div style={{ display:"flex", gap:12, flexShrink:0 }}>
                        <span style={{ fontSize:11, color:"var(--amber)", fontWeight:700 }}>{k.clicks} clicks</span>
                        <span style={{ fontSize:11, color:"#7c3aed" }}>#{k.position.toFixed(0)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SEO DASHBOARD ───────────────────────────────────────────────────────────

function SEODashboard({ posts, gscData, activeProvider, activeModel, apiKeys, onConnectGSC }) {
  const [analysis,     setAnalysis]     = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [loadMsg,      setLoadMsg]      = useState("");
  const [error,        setError]        = useState("");
  const [activeCard,   setActiveCard]   = useState(null);
  const [postAnalysis, setPostAnalysis] = useState({});
  const [analyzingPost,setAnalyzingPost]= useState(null);
  const provider = AI_PROVIDERS.find(p => p.id === activeProvider) || AI_PROVIDERS[0];

  // ── DERIVE OPPORTUNITIES FROM GSC DATA ─────────────────────────────────────
  const opportunities = gscData ? (() => {
    const kws = gscData.keywords || [];

    // Low-hanging fruit: ranking 5-20, decent impressions
    const lowHanging = kws
      .filter(k => k.position >= 4 && k.position <= 20 && k.impressions >= 10)
      .sort((a,b) => (a.position - b.position))
      .slice(0, 8);

    // High impressions, low CTR (title needs work)
    const lowCTR = kws
      .filter(k => k.impressions >= 20 && (k.clicks / k.impressions) < 0.03 && k.position <= 15)
      .sort((a,b) => b.impressions - a.impressions)
      .slice(0, 6);

    // Already ranking well (top 5)
    const winning = kws
      .filter(k => k.position < 5 && k.clicks > 0)
      .sort((a,b) => b.clicks - a.clicks)
      .slice(0, 6);

    // Keywords with zero clicks despite impressions
    const noClicks = kws
      .filter(k => k.clicks === 0 && k.impressions >= 15 && k.position <= 20)
      .sort((a,b) => b.impressions - a.impressions)
      .slice(0, 6);

    return { lowHanging, lowCTR, winning, noClicks };
  })() : null;

  // ── AI FULL-SITE ANALYSIS ──────────────────────────────────────────────────
  const runFullAnalysis = async () => {
    setLoading(true); setError(""); setLoadMsg("Analyzing your site…");
    try {
      const postTitles   = posts.map(p => p.title).join(", ");
      const topKeywords  = (gscData?.keywords || []).slice(0, 15).map(k => `"${k.query}" (pos ${k.position.toFixed(0)}, ${k.clicks} clicks, ${k.impressions} impr)`).join("; ");
      const topPages     = (gscData?.topPages || []).slice(0, 8).map(p => `${p.page} (${p.clicks} clicks)`).join("; ");
      const totalClicks  = gscData?.totalClicks || 0;
      const totalImpr    = gscData?.totalImpressions || 0;
      const avgCTR       = totalImpr > 0 ? (totalClicks / totalImpr * 100).toFixed(1) : 0;

      const text = await callAI(activeProvider, activeModel,
        `You are an expert SEO consultant specializing in niche lifestyle blogs. Be specific, actionable, and honest. Return ONLY valid JSON (no fences):
{
  "health_score": 0-100,
  "health_label": "one word: Excellent/Good/Fair/Needs Work",
  "summary": "2-3 sentence overall assessment",
  "quick_wins": [{"action":"specific action","impact":"High/Medium/Low","effort":"Easy/Medium/Hard","detail":"why this works"}],
  "title_rewrites": [{"current":"...","suggested":"...","reason":"..."}],
  "content_gaps": [{"topic":"...","why":"...","angle":"..."}],
  "technical_tips": ["tip1","tip2","tip3"],
  "biggest_opportunity": "single most impactful thing to do right now in 1-2 sentences"
}
quick_wins = 5 items. title_rewrites = 3 items using actual post titles provided. content_gaps = 4 items.`,
        `Site: caskandstream.com — fly fishing and whiskey lifestyle blog.
Published posts: ${postTitles || "none yet"}
Top keywords: ${topKeywords || "no GSC data yet"}
Top pages: ${topPages || "no data"}
Total clicks (28 days): ${totalClicks}
Total impressions: ${totalImpr}
Avg CTR: ${avgCTR}%
Site age: relatively new, building domain authority`,
        apiKeys[activeProvider],
        2000
      );

      setLoadMsg("Parsing recommendations…");
      setAnalysis(parseAIJson(text));
    } catch(e) { setError(e.message); }
    setLoading(false); setLoadMsg("");
  };

  // ── AI PER-POST ANALYSIS ───────────────────────────────────────────────────
  const analyzePost = async (post) => {
    setAnalyzingPost(post.id);
    try {
      const gscKw = (gscData?.keywords || []).filter(k =>
        k.query.includes(post.title?.split(" ")[0]?.toLowerCase() || "")
      ).slice(0, 3);
      const gscPage = (gscData?.topPages || []).find(p =>
        p.page.includes(post.title?.toLowerCase().replace(/\s+/g, "-") || "")
      );

      const text = await callAI(activeProvider, activeModel,
        `You are an SEO expert. Analyze this blog post and give specific, actionable recommendations. Return ONLY valid JSON (no fences):
{
  "seo_score": 0-100,
  "title_score": 0-100,
  "title_feedback": "specific feedback on the title for SEO",
  "suggested_title": "improved SEO title under 60 chars",
  "meta_description": "suggested meta description 150-160 chars with primary keyword",
  "primary_keyword": "best target keyword for this post",
  "secondary_keywords": ["kw1","kw2","kw3"],
  "improvements": ["specific improvement 1","specific improvement 2","specific improvement 3"],
  "internal_links": ["suggest a topic to link to from this post","another link opportunity"],
  "verdict": "one sentence on the post's SEO potential"
}`,
        `Blog: caskandstream.com (fly fishing and whiskey lifestyle)
Post title: "${post.title}"
Post status: ${post.status}
GSC data for this post: ${gscKw.length ? JSON.stringify(gscKw) : "no data yet"}
Page clicks: ${gscPage?.clicks || 0}`,
        apiKeys[activeProvider],
        1000
      );
      const result = parseAIJson(text);
      setPostAnalysis(prev => ({ ...prev, [post.id]: result }));
    } catch(e) { console.error(e); }
    setAnalyzingPost(null);
  };

  const scoreColor = (s) => s >= 80 ? "#5cba6c" : s >= 60 ? "var(--amber)" : "var(--red)";
  const impactColor = { High:"#5cba6c", Medium:"var(--amber)", Low:"var(--text-secondary)" };
  const effortColor = { Easy:"#5cba6c", Medium:"var(--amber)", Hard:"var(--red)" };

  if (!gscData) return (
    <div style={{ textAlign:"center", padding:"60px 20px", background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12 }}>
      <div style={{ fontSize:40, marginBottom:16 }}>◎</div>
      <h3 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, marginBottom:8 }}>SEO Analysis Requires Search Console</h3>
      <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:24, maxWidth:400, margin:"0 auto 24px", lineHeight:1.7 }}>
        Connect Google Search Console to unlock AI-powered SEO recommendations, keyword opportunities, and content gap analysis.
      </p>
      <button onClick={onConnectGSC}
        style={{ padding:"10px 24px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
        Connect Search Console →
      </button>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <h2 style={{ fontFamily:"var(--font-display)", fontSize:20, fontWeight:700, margin:"0 0 4px" }}>SEO Dashboard</h2>
          <p style={{ fontSize:13, color:"var(--text-secondary)", margin:0 }}>AI-powered recommendations to grow organic traffic on caskandstream.com</p>
        </div>
        <button onClick={runFullAnalysis} disabled={loading}
          style={{ padding:"9px 20px", borderRadius:8, border:"none", background:loading?"var(--bg-elevated)":provider.color, color:loading?"var(--muted)":"#0e0f11", fontSize:13, fontWeight:700, cursor:loading?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:8 }}>
          {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>{loadMsg}</> : `${provider.logo} Run Full SEO Analysis`}
        </button>
      </div>

      {error && <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:13 }}>{error}</div>}

      {/* ── AI ANALYSIS RESULTS ── */}
      {analysis && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Health score + summary */}
          <div style={{ background:"var(--bg-surface)", border:`1px solid ${scoreColor(analysis.health_score)}44`, borderRadius:12, padding:24, display:"grid", gridTemplateColumns:"140px 1fr", gap:24, alignItems:"center" }}>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:56, fontWeight:900, fontFamily:"var(--font-display)", color:scoreColor(analysis.health_score) }}>{analysis.health_score}</div>
              <div style={{ fontSize:12, fontWeight:700, color:scoreColor(analysis.health_score), textTransform:"uppercase", letterSpacing:"0.08em" }}>{analysis.health_label}</div>
              <div style={{ fontSize:10, color:"var(--muted)", marginTop:4 }}>SEO Health Score</div>
            </div>
            <div>
              <div style={{ fontSize:15, lineHeight:1.7, color:"var(--text)", marginBottom:12 }}>{analysis.summary}</div>
              <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--amber-glow)", border:"1px solid var(--amber)44", fontSize:13, fontWeight:500, color:"var(--amber)", lineHeight:1.6 }}>
                ⚡ Biggest opportunity: {analysis.biggest_opportunity}
              </div>
            </div>
          </div>

          {/* Quick wins */}
          <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>⚡ Quick Wins</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {analysis.quick_wins?.map((w, i) => (
                <div key={i} style={{ padding:"12px 16px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)", display:"flex", gap:16, alignItems:"flex-start" }}>
                  <div style={{ flexShrink:0, width:24, height:24, borderRadius:6, background:"var(--amber-glow)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"var(--amber)" }}>{i+1}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:600, fontSize:13, marginBottom:4 }}>{w.action}</div>
                    <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.5 }}>{w.detail}</div>
                  </div>
                  <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                    <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:impactColor[w.impact]+"15", color:impactColor[w.impact], border:`1px solid ${impactColor[w.impact]}33`, fontWeight:600 }}>{w.impact} impact</span>
                    <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:effortColor[w.effort]+"15", color:effortColor[w.effort], border:`1px solid ${effortColor[w.effort]}33` }}>{w.effort}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            {/* Title rewrites */}
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>✏ Title Rewrites</div>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {analysis.title_rewrites?.map((t, i) => (
                  <div key={i} style={{ padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                    <div style={{ fontSize:11, color:"var(--red)", marginBottom:4, textDecoration:"line-through", opacity:0.7 }}>{t.current}</div>
                    <div style={{ fontSize:12, fontWeight:600, color:"#5cba6c", marginBottom:4 }}>→ {t.suggested}</div>
                    <div style={{ fontSize:11, color:"var(--muted)" }}>{t.reason}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Content gaps */}
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>📝 Content Gaps</div>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {analysis.content_gaps?.map((g, i) => (
                  <div key={i} style={{ padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                    <div style={{ fontSize:12, fontWeight:600, marginBottom:3 }}>{g.topic}</div>
                    <div style={{ fontSize:11, color:"var(--text-secondary)", marginBottom:3 }}>{g.why}</div>
                    <div style={{ fontSize:11, color:"var(--amber)" }}>Angle: {g.angle}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Technical tips */}
          {analysis.technical_tips?.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:12 }}>⚙ Technical Tips</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {analysis.technical_tips.map((t, i) => (
                  <div key={i} style={{ display:"flex", gap:10, padding:"6px 0", borderBottom:"1px solid var(--border)11", fontSize:12, color:"var(--text-secondary)" }}>
                    <span style={{ color:"var(--amber)", flexShrink:0 }}>→</span>{t}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── KEYWORD OPPORTUNITIES (always shown if GSC connected) ── */}
      {opportunities && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:17, fontWeight:700, margin:0 }}>Keyword Opportunities</h3>

          {/* Low-hanging fruit */}
          {opportunities.lowHanging.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid #5cba6c33", borderRadius:12, padding:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#5cba6c" }}>🎯 Low-Hanging Fruit</div>
                <div style={{ fontSize:11, color:"var(--text-secondary)" }}>— Ranking positions 5-20, one good update away from page 1</div>
              </div>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid var(--border)" }}>
                    {["Keyword","Position","Impressions","Clicks","Action"].map(h => (
                      <th key={h} style={{ textAlign:"left", padding:"6px 8px", fontSize:9, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {opportunities.lowHanging.map((k, i) => (
                    <tr key={i} style={{ borderBottom:"1px solid var(--border)11" }}>
                      <td style={{ padding:"8px 8px", fontSize:12 }}>{k.query}</td>
                      <td style={{ padding:"8px 8px", fontSize:13, fontWeight:700, color:"var(--amber)" }}>#{k.position.toFixed(0)}</td>
                      <td style={{ padding:"8px 8px", fontSize:12, color:"var(--text-secondary)" }}>{k.impressions}</td>
                      <td style={{ padding:"8px 8px", fontSize:12 }}>{k.clicks}</td>
                      <td style={{ padding:"8px 8px", fontSize:11, color:"#5cba6c" }}>Update &amp; expand post</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Low CTR */}
          {opportunities.lowCTR.length > 0 && (
            <div style={{ background:"var(--bg-surface)", border:"1px solid var(--amber)33", borderRadius:12, padding:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--amber)" }}>✏ Low Click-Through Rate</div>
                <div style={{ fontSize:11, color:"var(--text-secondary)" }}>— Appearing in search but not getting clicks. Rewrite the title/description.</div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {opportunities.lowCTR.map((k, i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 10px", borderRadius:7, background:"var(--bg-elevated)" }}>
                    <span style={{ fontSize:12 }}>{k.query}</span>
                    <div style={{ display:"flex", gap:12, flexShrink:0 }}>
                      <span style={{ fontSize:11, color:"var(--text-secondary)" }}>{k.impressions} impr</span>
                      <span style={{ fontSize:11, fontWeight:700, color:"var(--red)" }}>{(k.clicks/k.impressions*100).toFixed(1)}% CTR</span>
                      <span style={{ fontSize:11, color:"var(--muted)" }}>#{k.position.toFixed(0)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            {/* Winning keywords */}
            {opportunities.winning.length > 0 && (
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:16 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#5cba6c", marginBottom:10 }}>✓ Already Winning</div>
                {opportunities.winning.map((k, i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid var(--border)11", fontSize:12 }}>
                    <span style={{ color:"var(--text-secondary)" }}>{k.query}</span>
                    <div style={{ display:"flex", gap:8 }}>
                      <span style={{ fontWeight:700, color:"#5cba6c" }}>#{k.position.toFixed(0)}</span>
                      <span style={{ color:"var(--muted)" }}>{k.clicks} clicks</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Zero clicks */}
            {opportunities.noClicks.length > 0 && (
              <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:16 }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--red)", marginBottom:10 }}>⚠ Impressions, Zero Clicks</div>
                {opportunities.noClicks.map((k, i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid var(--border)11", fontSize:12 }}>
                    <span style={{ color:"var(--text-secondary)" }}>{k.query}</span>
                    <div style={{ display:"flex", gap:8 }}>
                      <span style={{ color:"var(--amber)" }}>{k.impressions} impr</span>
                      <span style={{ color:"var(--muted)" }}>#{k.position.toFixed(0)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── PER-POST SEO ANALYSIS ── */}
      {posts.length > 0 && (
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>📄 Post-by-Post SEO Analysis</div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {posts.map(post => {
              const pa = postAnalysis[post.id];
              return (
                <div key={post.id} style={{ borderRadius:8, border:"1px solid var(--border)", overflow:"hidden" }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 14px", background:"var(--bg-elevated)", cursor:"pointer" }}
                    onClick={() => setActiveCard(activeCard===post.id ? null : post.id)}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{post.title}</div>
                      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                        <span style={{ fontSize:10, padding:"1px 6px", borderRadius:99, background:post.status==="published"?"#5cba6c15":"var(--bg-surface)", color:post.status==="published"?"#5cba6c":"var(--muted)", border:`1px solid ${post.status==="published"?"#5cba6c33":"var(--border)"}`, textTransform:"capitalize" }}>{post.status}</span>
                        {pa && <span style={{ fontSize:11, color:scoreColor(pa.seo_score), fontWeight:700 }}>SEO: {pa.seo_score}/100</span>}
                      </div>
                    </div>
                    <div style={{ display:"flex", gap:8, alignItems:"center", flexShrink:0, marginLeft:12 }}>
                      {!pa && (
                        <button onClick={e=>{ e.stopPropagation(); analyzePost(post); }} disabled={analyzingPost===post.id}
                          style={{ padding:"5px 12px", borderRadius:7, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:5 }}>
                          {analyzingPost===post.id ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Analyzing…</> : `${provider.logo} Analyze`}
                        </button>
                      )}
                      <span style={{ fontSize:14, color:"var(--muted)" }}>{activeCard===post.id?"▲":"▼"}</span>
                    </div>
                  </div>

                  {activeCard === post.id && pa && (
                    <div style={{ padding:"16px 14px", display:"flex", flexDirection:"column", gap:12, borderTop:"1px solid var(--border)" }}>
                      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10 }}>
                        {[
                          { label:"SEO Score",   value:`${pa.seo_score}/100`,  color:scoreColor(pa.seo_score) },
                          { label:"Title Score", value:`${pa.title_score}/100`, color:scoreColor(pa.title_score) },
                          { label:"Target Keyword", value:pa.primary_keyword,   color:"var(--amber)" },
                        ].map(s => (
                          <div key={s.label} style={{ padding:"10px 12px", borderRadius:8, background:"var(--bg-elevated)", textAlign:"center" }}>
                            <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--muted)", marginBottom:4 }}>{s.label}</div>
                            <div style={{ fontSize:16, fontWeight:700, color:s.color }}>{s.value}</div>
                          </div>
                        ))}
                      </div>

                      <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--amber)22" }}>
                        <div style={{ fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Title Feedback</div>
                        <div style={{ fontSize:12, color:"var(--text-secondary)", marginBottom:6 }}>{pa.title_feedback}</div>
                        <div style={{ fontSize:12, fontWeight:600, color:"#5cba6c" }}>→ {pa.suggested_title}</div>
                      </div>

                      <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)" }}>
                        <div style={{ fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>Meta Description</div>
                        <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.6 }}>{pa.meta_description}</div>
                      </div>

                      <div>
                        <div style={{ fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>Improvements</div>
                        {pa.improvements?.map((imp, i) => (
                          <div key={i} style={{ fontSize:12, padding:"5px 0", borderBottom:"1px solid var(--border)11", color:"var(--text-secondary)", display:"flex", gap:8 }}>
                            <span style={{ color:"var(--amber)", flexShrink:0 }}>→</span>{imp}
                          </div>
                        ))}
                      </div>

                      <div style={{ fontSize:11, fontStyle:"italic", color:"var(--amber)", lineHeight:1.6, padding:"8px 12px", borderRadius:7, background:"var(--amber-glow)" }}>
                        {pa.verdict}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!analysis && !opportunities?.lowHanging?.length && !opportunities?.lowCTR?.length && (
        <div style={{ textAlign:"center", padding:"48px 20px", color:"var(--muted)", fontSize:13 }}>
          <p style={{ marginBottom:16 }}>Click <strong style={{color:"var(--text)"}}>Run Full SEO Analysis</strong> above to get AI-powered recommendations for your site.</p>
          <p>Or analyze individual posts using the <strong style={{color:"var(--text)"}}>Analyze</strong> button on each post below.</p>
        </div>
      )}
    </div>
  );
}

// ─── MOBILE RESPONSIVE ───────────────────────────────────────────────────────

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return mobile;
}

const MOBILE_CSS = `
  /* ── RESPONSIVE GRID OVERRIDES ── */
  @media (max-width: 767px) {
    /* Collapse all multi-column grids to 1 or 2 cols */
    [style*="repeat(4,1fr)"], [style*="repeat(3,1fr)"],
    [style*="repeat(4, 1fr)"], [style*="repeat(3, 1fr)"] {
      grid-template-columns: 1fr 1fr !important;
    }
    /* Two-column grids that are too tight */
    [style*="gridTemplateColumns:\"1fr 1fr\""],
    [style*="grid-template-columns: 1fr 1fr"] {
      grid-template-columns: 1fr !important;
    }
    /* Horizontal tab bars — allow wrap */
    [style*="display:\"flex\""][style*="gap:4"] {
      flex-wrap: wrap;
    }
    /* Rich text editor min height */
    .ProseMirror { min-height: 200px !important; }
    /* Stage progress text smaller */
    .stage-label { font-size: 9px !important; }
  }

  /* ── MOBILE NAV BAR (bottom) ── */
  .bb-mobile-nav {
    display: none;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    z-index: 900;
    background: var(--sidebar-bg);
    border-top: 1px solid var(--border);
    flex-direction: row;
    align-items: center;
    justify-content: space-around;
    padding: 0 4px;
  }
  .bb-mobile-nav button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 6px 8px;
    border-radius: 8px;
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
  }
  .bb-mobile-nav button.active {
    background: var(--amber-glow);
  }
  .bb-mobile-nav .nav-icon { font-size: 18px; }
  .bb-mobile-nav .nav-label { font-size: 9px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.04em; }
  .bb-mobile-nav button.active .nav-label { color: var(--amber); }

  @media (max-width: 767px) {
    .bb-mobile-nav { display: flex; }
    .bb-sidebar { display: none !important; }
    .bb-main-content { padding: 16px 14px 72px !important; }
    .bb-root { flex-direction: column !important; }
    .bb-ai-switcher { bottom: 72px !important; right: 12px !important; } /* clear the 56px mobile nav — was overlapping the Settings tab */
  }
`;

// ─── BUFFER SETTINGS ─────────────────────────────────────────────────────────

const BUFFER_STORAGE = "bb_buffer_config";
function loadBufferConfig() { try { return JSON.parse(localStorage.getItem(BUFFER_STORAGE) || "{}"); } catch { return {}; } }
function saveBufferConfig(d) {
  try { localStorage.setItem(BUFFER_STORAGE, JSON.stringify(d)); } catch {}
  const uid = window.__bbUserId;
  if (uid) cloudSet("buffer_config", uid, d);
}

function BufferSettings() {
  const [config,   setConfig]   = useState(loadBufferConfig);
  const [apiKey,   setApiKey]   = useState(() => loadBufferConfig().apiKey || "");
  const [channels, setChannels] = useState(() => loadBufferConfig().channels || []);
  const [loading,  setLoading]  = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState("");
  const [mapping,  setMapping]  = useState(() => loadBufferConfig().mapping || {});
  const [boardMapping, setBoardMapping] = useState(() => loadBufferConfig().boardMapping || {});
  const [pinterestBoards, setPinterestBoards] = useState({}); // { channelId: [{serviceId,name}] }
  const [loadingBoards, setLoadingBoards] = useState({}); // { channelId: bool }

  const loadBoardsFor = async (channelId) => {
    setLoadingBoards(b => ({ ...b, [channelId]: true }));
    try {
      const res = await fetch("/api/buffer-post", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey: apiKey.trim(), action: "getPinterestBoards", channelId }),
      });
      const data = await res.json();
      if (!data.error) setPinterestBoards(p => ({ ...p, [channelId]: data.boards || [] }));
    } catch {}
    setLoadingBoards(b => ({ ...b, [channelId]: false }));
  };

  useEffect(() => {
    const pinterestChannelId = mapping.pinterest;
    if (pinterestChannelId && apiKey.trim() && !pinterestBoards[pinterestChannelId]) loadBoardsFor(pinterestChannelId);
  }, [mapping.pinterest]);

  const PLATFORM_NAMES = {
    twitter: "X (Twitter)", tiktok: "TikTok", pinterest: "Pinterest",
    reddit: "Reddit", instagram: "Instagram", facebook: "Facebook",
    threads: "Threads", bluesky: "Bluesky", youtube: "YouTube", linkedin: "LinkedIn",
  };

  const [orgId,    setOrgId]    = useState(() => loadBufferConfig().orgId || "");
  const [account,  setAccount]  = useState(() => loadBufferConfig().account || null);

  const loadChannels = async () => {
    if (!apiKey.trim()) { setError("Enter your Buffer API key first"); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch("/api/buffer-post", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey: apiKey.trim(), action: "getChannels" }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChannels(data.channels || []);
      setOrgId(data.orgId || "");
      setAccount(data.account || null);
      if ((data.channels||[]).length === 0) setError("No channels found — connect social accounts in Buffer first.");
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const save = () => {
    const cfg = { apiKey: apiKey.trim(), channels, mapping, boardMapping, orgId, account, connected: !!apiKey.trim() && channels.length > 0 };
    saveBufferConfig(cfg);
    setConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };
  const SERVICE_ICONS = { twitter:"🐦", tiktok:"🎵", pinterest:"📌", instagram:"📸", facebook:"👍", threads:"🧵", bluesky:"🦋", youtube:"▶", linkedin:"💼", reddit:"🤖", googlebusiness:"📍" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <span style={{ fontSize:28 }}>🟦</span>
        <div>
          <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 2px" }}>Buffer — Extended Reach</h3>
          <div style={{ fontSize:11, color: config.connected ? "#5cba6c" : "var(--muted)", fontWeight: config.connected ? 600 : 400 }}>
            {config.connected ? `● Connected · ${channels.length} channels` : "○ Optional · not connected"}
          </div>
        </div>
      </div>

      {/* Optional framing banner */}
      <div style={{ background:"var(--amber-glow)", border:"1px solid var(--amber)44", borderRadius:10, padding:16 }}>
        <div style={{ fontSize:13, fontWeight:700, color:"var(--amber)", marginBottom:6 }}>
          📸 Facebook & Instagram already work without Buffer
        </div>
        <div style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.7 }}>
          Blog Bunker posts directly to Facebook and Instagram through your existing connection in <strong style={{color:"var(--text)"}}>Settings → Facebook & Instagram</strong>. Buffer is an optional add-on that unlocks posting to <strong style={{color:"var(--text)"}}>X, TikTok, Pinterest, Reddit, Threads, Bluesky, YouTube, and LinkedIn</strong> — all through one connection.
        </div>
      </div>

      {/* Platform coverage */}
      <div style={{ background:"var(--bg-elevated)", border:"1px solid var(--border)", borderRadius:10, padding:16 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>
          What each connection covers
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-surface)", border:"1px solid #5cba6c33" }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#5cba6c", marginBottom:6 }}>✓ Built-in (no Buffer needed)</div>
            <div style={{ fontSize:12, color:"var(--text-secondary)", display:"flex", flexDirection:"column", gap:3 }}>
              <span>📸 Instagram</span>
              <span>👍 Facebook</span>
            </div>
          </div>
          <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--bg-surface)", border:"1px solid var(--amber)33" }}>
            <div style={{ fontSize:11, fontWeight:700, color:"var(--amber)", marginBottom:6 }}>+ Unlocked with Buffer</div>
            <div style={{ fontSize:12, color:"var(--text-secondary)", display:"grid", gridTemplateColumns:"1fr 1fr", gap:3 }}>
              <span>🐦 X (Twitter)</span>
              <span>🎵 TikTok</span>
              <span>📌 Pinterest</span>
              <span>🤖 Reddit</span>
              <span>🧵 Threads</span>
              <span>🦋 Bluesky</span>
              <span>▶ YouTube</span>
              <span>💼 LinkedIn</span>
            </div>
          </div>
        </div>
      </div>

      {/* Setup steps */}
      <div style={{ background:"var(--bg-elevated)", border:"1px solid var(--border)", borderRadius:10, padding:16 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>Setup (2 minutes)</div>
        <ol style={{ paddingLeft:16, display:"flex", flexDirection:"column", gap:8 }}>
          {[
            <>Sign up at <a href="https://buffer.com" target="_blank" rel="noopener" style={{color:"var(--amber)"}}>buffer.com</a> — free plan works</>,
            "Connect your social accounts in Buffer (X, TikTok, Pinterest, etc.) — Buffer handles all the OAuth",
            <>Go to <a href="https://buffer.com/api" target="_blank" rel="noopener" style={{color:"var(--amber)"}}>buffer.com/api</a> → Generate API Key</>,
            "Paste the key below → click Load Channels",
            "Map each Buffer channel to its platform → Save",
          ].map((s, i) => (
            <li key={i} style={{ fontSize:12, color:"var(--text-secondary)", lineHeight:1.6 }}>{s}</li>
          ))}
        </ol>
      </div>

      {/* API Key input */}
      <div>
        <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
          Buffer API Key
        </label>
        <div style={{ display:"flex", gap:8 }}>
          <input style={{ ...iS, flex:1 }} type="password" placeholder="paste your Buffer API key…"
            value={apiKey} onChange={e => setApiKey(e.target.value)}
            onFocus={e=>e.target.style.borderColor="#1da1f2"} onBlur={e=>e.target.style.borderColor="var(--border)"} />
          <button onClick={loadChannels} disabled={loading || !apiKey.trim()}
            style={{ padding:"10px 18px", borderRadius:8, border:"none", background:loading||!apiKey.trim()?"var(--bg-elevated)":"#1da1f2", color:loading||!apiKey.trim()?"var(--muted)":"#fff", fontSize:12, fontWeight:700, cursor:loading||!apiKey.trim()?"not-allowed":"pointer", fontFamily:"var(--font-body)", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:6 }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Loading…</> : "Load Channels"}
          </button>
        </div>
        <p style={{ fontSize:11, color:"var(--muted)", marginTop:4 }}>
          Find your key at <a href="https://buffer.com/api" target="_blank" rel="noopener" style={{ color:"var(--amber)" }}>buffer.com/api</a> → Generate API Key (must be the org owner)
        </p>
      </div>

      {error && <div style={{ padding:"10px 14px", borderRadius:8, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:12 }}>{error}</div>}

      {account && !error && (
        <div style={{ padding:"10px 14px", borderRadius:8, background:"#5cba6c11", border:"1px solid #5cba6c33", fontSize:12, color:"#5cba6c", display:"flex", alignItems:"center", gap:8 }}>
          ✓ Connected as <strong style={{marginLeft:4}}>{account.name || account.email}</strong> · {channels.length} channel{channels.length !== 1 ? "s" : ""} found
        </div>
      )}
      {channels.length > 0 && (
        <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:14 }}>
            Map your Buffer channels
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {channels.map(ch => {
              const mappedPlatform = Object.entries(mapping).find(([,v]) => v === ch.id)?.[0] || "";
              return (
              <div key={ch.id} style={{ display:"flex", flexDirection:"column", gap:8, padding:"10px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <span style={{ fontSize:18 }}>{SERVICE_ICONS[ch.service?.toLowerCase()] || "📱"}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{ch.name}</div>
                  <div style={{ fontSize:11, color:"var(--text-secondary)", textTransform:"capitalize" }}>{ch.service} · {ch.serviceId}</div>
                </div>
                <select
                  value={mappedPlatform}
                  onChange={e => {
                    const platform = e.target.value;
                    const next = Object.fromEntries(Object.entries(mapping).filter(([,v]) => v !== ch.id));
                    if (platform) next[platform] = ch.id;
                    setMapping(next);
                    if (platform === "pinterest" && !pinterestBoards[ch.id]) loadBoardsFor(ch.id);
                  }}
                  style={{ ...iS, width:"auto", minWidth:150, cursor:"pointer" }}>
                  <option value="">— not mapped —</option>
                  {Object.entries(PLATFORM_NAMES).map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
                </div>
                {mappedPlatform === "pinterest" && (
                  <div style={{ display:"flex", alignItems:"center", gap:8, paddingLeft:30 }}>
                    <span style={{ fontSize:11, color:"var(--muted)", whiteSpace:"nowrap" }}>📌 Board:</span>
                    {loadingBoards[ch.id] ? (
                      <span style={{ fontSize:11, color:"var(--muted)" }}>Loading boards…</span>
                    ) : (
                      <select
                        value={boardMapping[ch.id] || ""}
                        onChange={e => setBoardMapping(b => ({ ...b, [ch.id]: e.target.value }))}
                        style={{ ...iS, width:"auto", minWidth:180, cursor:"pointer", padding:"6px 10px", fontSize:12 }}>
                        <option value="">— select a board (required) —</option>
                        {(pinterestBoards[ch.id] || []).map(b => (
                          <option key={b.serviceId} value={b.serviceId}>{b.name}</option>
                        ))}
                      </select>
                    )}
                    {!loadingBoards[ch.id] && (pinterestBoards[ch.id]?.length === 0) && (
                      <span style={{ fontSize:11, color:"var(--red)" }}>No boards found — create one on Pinterest first</span>
                    )}
                    {!boardMapping[ch.id] && !loadingBoards[ch.id] && (
                      <span style={{ fontSize:11, color:"var(--amber)" }}>⚠ Required — Pinterest posts fail without a board</span>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <p style={{ fontSize:11, color:"var(--muted)", marginTop:10, lineHeight:1.6 }}>
            Map each Buffer channel to the platform it represents. When you schedule a post to X in Blog Bunker, it sends to whichever Buffer channel is mapped to X.
          </p>
        </div>
      )}

      {/* Save / disconnect */}
      <div style={{ display:"flex", gap:10, alignItems:"center" }}>
        <button onClick={save}
          style={{ padding:"9px 24px", borderRadius:8, border:"none", background:"#1da1f2", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
          Save Settings
        </button>
        {config.connected && (
          <button onClick={() => { saveBufferConfig({}); setConfig({}); setApiKey(""); setChannels([]); setMapping({}); }}
            style={{ padding:"9px 16px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
            Disconnect Buffer
          </button>
        )}
        {saved && <span style={{ fontSize:12, color:"#5cba6c" }}>✓ Saved</span>}
      </div>
    </div>
  );
}

// Keep old SocialPlatformSettings as a thin wrapper that redirects to Buffer
const SOCIAL_PLATFORM_STORAGE = "bb_social_platforms";
function loadSocialPlatforms() { try { return JSON.parse(localStorage.getItem(SOCIAL_PLATFORM_STORAGE) || "{}"); } catch { return {}; } }
function saveSocialPlatforms(d) {
  try { localStorage.setItem(SOCIAL_PLATFORM_STORAGE, JSON.stringify(d)); } catch {}
  const uid = window.__bbUserId;
  if (uid) cloudSet("social_platforms", uid, d);
}

function SocialPlatformSettings() {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ background:"var(--bg-elevated)", border:"1px solid var(--amber)44", borderRadius:10, padding:16, fontSize:13, color:"var(--text-secondary)", lineHeight:1.7 }}>
        Social platform connections are now managed through <strong style={{color:"var(--text)"}}>Buffer</strong>. Configure your Buffer API key in <strong style={{color:"var(--amber)"}}>Settings → Buffer</strong> to connect X, TikTok, Pinterest, Instagram, Facebook, Reddit, Threads, Bluesky, and YouTube all at once.
      </div>
      <BufferSettings />
    </div>
  );
}

// ─── IMAGE TEXT OVERLAY EDITOR ───────────────────────────────────────────────


// ─── IMAGE TEXT OVERLAY EDITOR ───────────────────────────────────────────────

function ImageTextOverlayEditor({ imageUrl, imageName, userId, onSave }) {
  const [canvasEl, setCanvasEl] = useState(null); // callback ref — know when canvas is mounted
  const canvasRef = useCallback(node => { if (node) setCanvasEl(node); }, []);
  const [dataUrl,  setDataUrl]  = useState(null);
  const [layers,   setLayers]   = useState([{
    id:1, text:"Your text here", x:50, y:85, fontSize:36,
    fontFamily:"Georgia, serif", color:"#ffffff", align:"center",
    shadow:true, shadowColor:"#000000", shadowBlur:6, bold:true, italic:false, bgBox:false, bgColor:"#000000aa",
  }]);
  const [sel,      setSel]      = useState(0);
  const [saving,   setSaving]   = useState(false);
  const [loadErr,  setLoadErr]  = useState("");

  const FONTS = [
    { label:"Georgia (Serif)",  value:"Georgia, serif"           },
    { label:"Times New Roman",  value:"'Times New Roman', serif" },
    { label:"Arial",            value:"Arial, sans-serif"        },
    { label:"Impact",           value:"Impact, sans-serif"       },
    { label:"Courier",          value:"'Courier New', monospace" },
  ];

  // Load image — try fetch first, fall back to img element with crossOrigin
  useEffect(() => {
    setLoadErr("");
    setDataUrl(null);
    (async () => {
      try {
        if (imageUrl.startsWith("data:")) { setDataUrl(imageUrl); return; }

        // Try fetch with no-cors handling
        try {
          const res  = await fetch(imageUrl, { mode: "cors", credentials: "omit" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const reader = new FileReader();
          reader.onload = e => setDataUrl(e.target.result);
          reader.readAsDataURL(blob);
        } catch {
          // Fetch failed (CORS) — load via Image element instead
          // Canvas will be tainted but we can still display it
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
            try {
              canvas.getContext("2d").drawImage(img, 0, 0);
              setDataUrl(canvas.toDataURL("image/png"));
            } catch {
              // Canvas tainted — just use the URL directly for display
              setDataUrl(imageUrl);
            }
          };
          img.onerror = () => setLoadErr("Could not load image — try downloading it first and re-uploading.");
          img.src = imageUrl + "?_=" + Date.now(); // cache bust
        }
      } catch(e) { setLoadErr("Could not load image: " + e.message); }
    })();
  }, [imageUrl]);

  // Draw whenever dataUrl, layers, or canvas element changes
  useEffect(() => {
    if (!dataUrl || !canvasEl) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvasEl.getContext("2d");
      canvasEl.width  = img.width;
      canvasEl.height = img.height;
      ctx.drawImage(img, 0, 0);

      for (const l of layers) {
        if (!l.text.trim()) continue;
        const x = (l.x / 100) * canvasEl.width;
        const y = (l.y / 100) * canvasEl.height;
        ctx.font = `${l.italic?"italic ":""}${l.bold?"bold ":""}${l.fontSize}px ${l.fontFamily}`;
        ctx.textAlign    = l.align;
        ctx.textBaseline = "middle";
        const tw = ctx.measureText(l.text).width;
        if (l.bgBox) {
          const pad = 14;
          const bx  = l.align==="center" ? x-tw/2-pad : l.align==="right" ? x-tw-pad : x-pad;
          ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
          ctx.fillStyle = l.bgColor;
          ctx.fillRect(bx, y-l.fontSize*0.65, tw+pad*2, l.fontSize*1.3);
        }
        ctx.shadowColor   = l.shadow ? l.shadowColor : "transparent";
        ctx.shadowBlur    = l.shadow ? l.shadowBlur  : 0;
        ctx.shadowOffsetX = l.shadow ? 2 : 0;
        ctx.shadowOffsetY = l.shadow ? 2 : 0;
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, x, y);
        ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
    };
    img.src = dataUrl;
  }, [dataUrl, layers, canvasEl]);

  const layer = layers[sel] || layers[0];
  const upd   = (patch) => setLayers(p => p.map((l,i) => i===sel ? {...l,...patch} : l));

  const save = async () => {
    if (!canvasEl) return;
    setSaving(true);
    try {
      const exportUrl = canvasEl.toDataURL("image/png", 0.92);
      const res  = await fetch("/api/gcs", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ userId, dataUrl: exportUrl, name:`${imageName||"image"}-overlay`, tags:["overlay","edited"], source:"edited" }),
      });
      const data = await res.json();
      if (data.item) onSave(data.item);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const iS = { width:"100%", padding:"7px 10px", borderRadius:7, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", outline:"none", boxSizing:"border-box" };

  return (
    <div style={{ borderTop:"1px solid var(--border)", paddingTop:16, display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:14, fontWeight:700, color:"var(--amber)" }}>✎ Text Overlay Editor</span>
        <span style={{ fontSize:11, color:"var(--text-secondary)" }}>Click image to reposition selected text</span>
      </div>

      {loadErr && <div style={{ padding:"8px 12px", borderRadius:7, background:"var(--red)11", border:"1px solid var(--red)33", color:"var(--red)", fontSize:12 }}>{loadErr}</div>}

      {!dataUrl && !loadErr && (
        <div style={{ padding:20, textAlign:"center", color:"var(--muted)", fontSize:12 }}>
          <span style={{ animation:"spin 1s linear infinite", display:"inline-block", marginRight:6 }}>◌</span>Loading image…
        </div>
      )}

      {dataUrl && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:14 }}>
          {/* Canvas preview */}
          <div>
            <canvas ref={canvasRef}
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect();
                upd({ x: Math.round((e.clientX-r.left)/r.width*100), y: Math.round((e.clientY-r.top)/r.height*100) });
              }}
              style={{ width:"100%", borderRadius:8, border:"1px solid var(--border)", cursor:"crosshair", display:"block" }} />
          </div>

          {/* Controls */}
          <div style={{ display:"flex", flexDirection:"column", gap:10, maxHeight:520, overflow:"auto" }}>
            {/* Layers */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:5 }}>Layers</div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                {layers.map((l,i) => (
                  <div key={l.id} style={{ display:"flex", gap:3 }}>
                    <button onClick={() => setSel(i)} style={{ flex:1, padding:"5px 8px", borderRadius:6, border:`1px solid ${sel===i?"var(--amber)":"var(--border)"}`, background:sel===i?"var(--amber-glow)":"transparent", color:sel===i?"var(--amber)":"var(--text-secondary)", fontSize:11, cursor:"pointer", textAlign:"left", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {l.text.slice(0,20)||"Empty"}
                    </button>
                    {layers.length>1 && <button onClick={() => { setLayers(p=>p.filter((_,j)=>j!==i)); setSel(Math.max(0,i-1)); }} style={{ padding:"4px 7px", borderRadius:5, border:"1px solid var(--border)", background:"transparent", color:"var(--muted)", fontSize:11, cursor:"pointer" }}>✕</button>}
                  </div>
                ))}
                <button onClick={() => { setLayers(p=>[...p,{...p[0],id:Date.now(),text:"New text",y:30}]); setSel(layers.length); }} style={{ padding:"4px", borderRadius:6, border:"1px dashed var(--border)", background:"transparent", color:"var(--muted)", fontSize:11, cursor:"pointer" }}>+ Add Layer</button>
              </div>
            </div>

            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Text</label>
              <textarea value={layer.text} onChange={e=>upd({text:e.target.value})} rows={2} style={{...iS, resize:"none"}} />
            </div>

            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Font</label>
              <select value={layer.fontFamily} onChange={e=>upd({fontFamily:e.target.value})} style={iS}>
                {FONTS.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>

            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Size: {layer.fontSize}px</label>
              <input type="range" min={10} max={200} value={layer.fontSize} onChange={e=>upd({fontSize:Number(e.target.value)})} style={{ width:"100%", accentColor:"var(--amber)" }} />
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Color</label>
                <input type="color" value={layer.color} onChange={e=>upd({color:e.target.value})} style={{ width:"100%", height:30, borderRadius:6, border:"1px solid var(--border)", cursor:"pointer" }} />
              </div>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Align</label>
                <div style={{ display:"flex", gap:3 }}>
                  {["left","center","right"].map(a=>(
                    <button key={a} onClick={()=>upd({align:a})} style={{ flex:1, padding:"4px", borderRadius:5, border:`1px solid ${layer.align===a?"var(--amber)":"var(--border)"}`, background:layer.align===a?"var(--amber-glow)":"transparent", color:layer.align===a?"var(--amber)":"var(--muted)", fontSize:11, cursor:"pointer" }}>
                      {a==="left"?"←":a==="center"?"↔":"→"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
              {[{k:"bold",label:"Bold"},{k:"italic",label:"Italic"},{k:"shadow",label:"Shadow"},{k:"bgBox",label:"BG Box"}].map(t=>(
                <button key={t.k} onClick={()=>upd({[t.k]:!layer[t.k]})} style={{ padding:"4px 10px", borderRadius:6, border:`1px solid ${layer[t.k]?"var(--amber)":"var(--border)"}`, background:layer[t.k]?"var(--amber-glow)":"transparent", color:layer[t.k]?"var(--amber)":"var(--text-secondary)", fontSize:11, cursor:"pointer", fontWeight:layer[t.k]?700:400 }}>
                  {t.label}
                </button>
              ))}
            </div>

            {layer.bgBox && (
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Box Color</label>
                <input type="color" value={layer.bgColor.slice(0,7)} onChange={e=>upd({bgColor:e.target.value+"aa"})} style={{ width:"100%", height:28, borderRadius:6, border:"1px solid var(--border)", cursor:"pointer" }} />
              </div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>X: {layer.x}%</label>
                <input type="range" min={0} max={100} value={layer.x} onChange={e=>upd({x:Number(e.target.value)})} style={{ width:"100%", accentColor:"var(--amber)" }} />
              </div>
              <div>
                <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Y: {layer.y}%</label>
                <input type="range" min={0} max={100} value={layer.y} onChange={e=>upd({y:Number(e.target.value)})} style={{ width:"100%", accentColor:"var(--amber)" }} />
              </div>
            </div>

            <div>
              <label style={{ display:"block", fontSize:10, fontWeight:700, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:5 }}>Quick Presets</label>
              {[
                { label:"Tagline", text:"Cast at Dawn. Sip at Dusk.", y:87, fontSize:28 },
                { label:"URL",     text:"caskandstream.com",          y:95, fontSize:16 },
                { label:"Quote",   text:'"The river knows."',         y:50, fontSize:42 },
                { label:"CTA",     text:"Link in bio →",              y:91, fontSize:22 },
              ].map((p,i)=>(
                <button key={i} onClick={()=>upd({text:p.text, y:p.y, fontSize:p.fontSize})} style={{ display:"block", width:"100%", padding:"4px 8px", marginBottom:3, borderRadius:5, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", textAlign:"left" }}>
                  {p.label}
                </button>
              ))}
            </div>

            <div style={{ display:"flex", flexDirection:"column", gap:5, paddingTop:6, borderTop:"1px solid var(--border)" }}>
              <button onClick={save} disabled={saving} style={{ padding:"9px", borderRadius:8, border:"none", background:saving?"var(--bg-elevated)":"#5cba6c", color:saving?"var(--muted)":"#fff", fontSize:12, fontWeight:700, cursor:saving?"not-allowed":"pointer" }}>
                {saving ? "Saving…" : "✓ Save to Library"}
              </button>
              <button onClick={()=>{ if(!canvasEl) return; const a=document.createElement("a"); a.href=canvasEl.toDataURL("image/png"); a.download=`${imageName||"image"}-overlay.png`; a.click(); }} style={{ padding:"9px", borderRadius:8, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer" }}>
                ↓ Download PNG
              </button>
            </div>
          </div>
        </div>
      )}
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

// ─── HEADLINE IMAGE ───────────────────────────────────────────────────────────

// Blog headline images use a wide 16:9 ratio
const HEADLINE_IMAGE_SPEC = {
  ratio: "16:9",
  label: "Blog Headline (16:9)",
  style: "cinematic editorial photography, moody atmospheric, fly fishing and whiskey lifestyle, amber and teal tones, wide landscape",
};

function HeadlineImagePanel({ title, body, activeProvider, activeModel, apiKeys, onImageSaved, existingImageUrl = null }) {
  const [imageUrl,    setImageUrl]    = useState(existingImageUrl);
  const [cloudUrl,    setCloudUrl]    = useState(existingImageUrl); // permanent GCS URL
  const [prompt,      setPrompt]      = useState("");
  const [loading,     setLoading]     = useState(false);
  const [uploading,   setUploading]   = useState(false);
  const [error,       setError]       = useState("");
  const [copied,      setCopied]      = useState(false);
  const [savedToLib,  setSavedToLib]  = useState(false);
  const [saveError,   setSaveError]   = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState("");

  const [imgProvider, setImgProvider] = useState(() => resolveImageProvider(apiKeys));
  const provider = imgProvider;
  const providerLabel = getImageProviderLabel(provider, apiKeys);
  const handleImgProviderChange = (id) => { setImgProvider(id); saveImageProviderPref(id); };

  useEffect(() => {
    setImageUrl(existingImageUrl);
    setCloudUrl(existingImageUrl);
  }, [existingImageUrl]);

  // Convert any image URL to a JPEG data URL via canvas before saving
  const toJpegDataUrl = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth  || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("Could not load image for conversion"));
    img.src = url;
  });

  const handleSaveToLibrary = async () => {
    if (!imageUrl) return;
    setSavedToLib(false); setSaveError("");
    try {
      let dataUrl = imageUrl;
      if (imageUrl.startsWith("blob:")) {
        const res  = await fetch(imageUrl);
        const blob = await res.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
      // Compress if needed
      if (dataUrl.length > 4_000_000) {
        dataUrl = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            const scale = Math.sqrt(4_000_000 / dataUrl.length) * 0.9;
            c.width  = Math.round(img.width  * scale);
            c.height = Math.round(img.height * scale);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.85));
          };
          img.onerror = () => reject(new Error("Compression failed"));
          img.src = dataUrl;
        });
      }
      // Get userId from window (set by Dashboard on mount)
      const userId = window.__bbUserId || "anonymous";
      const safeName = `headline-${(title || "image").toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`;
      const res = await fetch("/api/gcs", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId, dataUrl, name: safeName, tags: ["blog headline", "generated"], notes: prompt ? `Prompt: ${prompt.slice(0, 100)}` : "", source: "generated" }),
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      window.dispatchEvent(new CustomEvent("bb-media-updated"));
      setSavedToLib(true);
      setTimeout(() => setSavedToLib(false), 3000);
    } catch(e) {
      setSaveError(e.message);
      setTimeout(() => setSaveError(""), 4000);
    }
  };

  // Opens the preview modal with a pre-built prompt the user can edit before generating
  const openPromptPreview = async () => {
    setLoading(true); setError("");
    try {
      let draftedPrompt = prompt;
      if (!draftedPrompt) {
        // Build a prompt directly from the title — no extra AI call needed
        const guide = loadBrandGuide();
        const style = guide?.imageStyle || "cinematic editorial photography, moody atmospheric, fly fishing and whiskey lifestyle, amber and teal tones";
        const topic = (title || "").replace(/[#*\n]/g, " ").trim();
        draftedPrompt = `${topic}, ${style}, wide landscape banner, professional photography, golden hour lighting, 16:9 aspect ratio`;
      }
      setDraftPrompt(draftedPrompt);
      setPreviewOpen(true);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const generate = async (finalPrompt) => {
    setPreviewOpen(false);
    setLoading(true); setError(""); setImageUrl(null); setCloudUrl(null);
    try {
      setPrompt(finalPrompt);
      const blobUrl = await generateImage(finalPrompt, "facebook", apiKeys, imgProvider);
      setImageUrl(blobUrl);

      // Auto-upload to GCS so the image persists in the cloud
      setUploading(true);
      try {
        const userId   = window.__bbUserId || "anonymous";
        const safeName = `headline-${(title || "image").toLowerCase().replace(/\s+/g, "-").slice(0, 30)}-${Date.now()}`;

        // Convert blob URL to base64
        const res  = await fetch(blobUrl);
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        const uploadRes = await fetch("/api/gcs", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            userId,
            dataUrl,
            name:   safeName,
            tags:   ["blog headline", "generated"],
            notes:  `Prompt: ${finalPrompt.slice(0, 100)}`,
            source: "generated",
          }),
        });
        const uploadData = await uploadRes.json();
        if (uploadData.url) {
          setCloudUrl(uploadData.url);
          if (onImageSaved) onImageSaved(uploadData.url); // notify parent post record
        }
      } catch(e) {
        console.warn("Auto-upload to GCS failed:", e.message);
        // Not fatal — blob URL still works for display
      }
      setUploading(false);

    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const handleDownload = () => {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `headline-${(title||"blog").toLowerCase().replace(/\s+/g,"-").slice(0,30)}.jpg`;
    a.click();
  };

  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border)", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:14 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:14 }}>🖼 Headline Image</div>
          <div style={{ fontSize:11, color:"var(--text-secondary)", marginTop:2 }}>
            Wide banner image for your blog post header · {HEADLINE_IMAGE_SPEC.label}
          </div>
        </div>
        <ImageProviderPicker apiKeys={apiKeys} value={imgProvider} onChange={handleImgProviderChange} compact />
      </div>
      <div style={{ display:"flex", justifyContent:"flex-end" }}>
        <div style={{ display:"flex", gap:8 }}>
          {prompt && (
            <button onClick={() => { setDraftPrompt(prompt); setPreviewOpen(true); }}
              style={{ padding:"5px 12px", borderRadius:6, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:11, cursor:"pointer", fontFamily:"var(--font-body)" }}>
              View/Edit Prompt
            </button>
          )}
          <button onClick={openPromptPreview} disabled={loading || !title?.trim() || !provider}
            style={{ padding:"7px 18px", borderRadius:8, border:"none", background:loading||!title?.trim()||!provider?"var(--bg-elevated)":"#7c3aed", color:loading||!title?.trim()||!provider?"var(--muted)":"#fff", fontSize:12, fontWeight:700, cursor:loading||!title?.trim()||!provider?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6 }}>
            {loading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Working…</> : imageUrl ? "↻ Regenerate" : "▣ Generate Headline Image"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize:12, color:"var(--red)", padding:"8px 12px", borderRadius:6, background:"var(--red)11", border:"1px solid var(--red)33" }}>{error}</div>
      )}

      {/* Image output */}
      {imageUrl ? (
        <>
        <div style={{ position:"relative", borderRadius:10, overflow:"hidden", border:"1px solid var(--border)" }}>
          <img src={imageUrl} alt="Blog headline" style={{ width:"100%", display:"block", borderRadius:10 }} />
          <div style={{ position:"absolute", bottom:10, right:10, display:"flex", gap:6 }}>
            <button onClick={handleDownload}
              style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.75)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
              ↓ Download
            </button>
            <button onClick={openPromptPreview}
              style={{ padding:"6px 14px", borderRadius:6, border:"none", background:"rgba(0,0,0,0.75)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
              ↻ New
            </button>
            {cloudUrl ? (
              <span style={{ padding:"6px 14px", borderRadius:6, background:"rgba(92,186,108,0.85)", color:"#fff", fontSize:11, fontWeight:700, backdropFilter:"blur(4px)" }}>
                ✓ Saved to Cloud
              </span>
            ) : uploading ? (
              <span style={{ padding:"6px 14px", borderRadius:6, background:"rgba(0,0,0,0.5)", color:"#fff", fontSize:11, backdropFilter:"blur(4px)", display:"flex", alignItems:"center", gap:5 }}>
                <span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span> Saving…
              </span>
            ) : (
              <button onClick={handleSaveToLibrary}
                style={{ padding:"6px 14px", borderRadius:6, border:"none", background:savedToLib?"rgba(92,186,108,0.85)":"rgba(196,124,43,0.85)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)", backdropFilter:"blur(4px)" }}>
                {savedToLib ? "✓ Saved!" : "🖼 Save to Library"}
              </button>
            )}
          </div>
          {cloudUrl && (
            <div style={{ position:"absolute", top:8, left:8, fontSize:10, padding:"3px 8px", borderRadius:99, background:"rgba(0,0,0,0.65)", color:"#5cba6c", fontWeight:600 }}>
              ☁ Synced to GCS
            </div>
          )}
        </div>
        {saveError && <div style={{ fontSize:11, color:"var(--red)", marginTop:6 }}>{saveError}</div>}
        </>
      ) : !loading && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ height:130, borderRadius:10, border:"1px dashed var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8 }}>
            <span style={{ fontSize:28, opacity:0.25 }}>🖼</span>
            <span style={{ fontSize:12, color:"var(--muted)" }}>
              {!provider ? "Add Stability AI, OpenAI, or Gemini key in Settings" : !title?.trim() ? "Enter a title first" : "Click Generate to create your headline image"}
            </span>
          </div>
          {title?.trim() && <LibraryImagePicker onSelect={(url) => { setImageUrl(url); setPrompt("from library"); }} />}
        </div>
      )}

      {loading && (
        <div style={{ height:160, borderRadius:10, border:"1px solid var(--border)", background:"var(--bg-elevated)", display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
          <span style={{ animation:"spin 1s linear infinite", display:"inline-block", fontSize:20, opacity:0.4 }}>◌</span>
          <span style={{ fontSize:12, color:"var(--muted)" }}>{providerLabel ? `Generating headline image with ${providerLabel}…` : "Working…"}</span>
        </div>
      )}

      {previewOpen && (
        <PromptPreviewModal
          title="Review Image Prompt"
          systemPrompt={null}
          userPrompt={draftPrompt}
          onUserChange={setDraftPrompt}
          confirmLabel="Generate Image"
          accentColor="#7c3aed"
          onCancel={() => setPreviewOpen(false)}
          onConfirm={() => generate(draftPrompt)}
        />
      )}
    </div>
  );
}
// ─── MARKDOWN ↔ HTML CONVERTERS ──────────────────────────────────────────────
// Keeps the rest of the app (AI generation, Wix push, pipeline) working with
// plain markdown while the editor itself works with HTML.

function markdownToHtml(md) {
  if (!md) return "<p></p>";
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("### "))      { blocks.push(`<h3>${inlineMd(line.slice(4))}</h3>`); i++; continue; }
    if (line.startsWith("## "))       { blocks.push(`<h2>${inlineMd(line.slice(3))}</h2>`); i++; continue; }
    if (line.startsWith("# "))        { blocks.push(`<h1>${inlineMd(line.slice(2))}</h1>`); i++; continue; }
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(`<li>${inlineMd(lines[i].slice(2))}</li>`); i++; }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(`<li>${inlineMd(lines[i].replace(/^\d+\.\s/, ""))}</li>`); i++; }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push(`<p>${inlineMd(para.join(" "))}</p>`);
  }
  return blocks.join("\n") || "<p></p>";
}

function inlineMd(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

function htmlToMarkdown(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  const lines = [];

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { lines.push(child.textContent); continue; }
      const tag = child.tagName?.toLowerCase();
      const inner = () => inlineHtmlToMd(child);
      if (tag === "h1") lines.push(`\n# ${inner()}\n`);
      else if (tag === "h2") lines.push(`\n## ${inner()}\n`);
      else if (tag === "h3") lines.push(`\n### ${inner()}\n`);
      else if (tag === "p") lines.push(`\n${inner()}\n`);
      else if (tag === "ul") { for (const li of child.children) lines.push(`- ${inlineHtmlToMd(li)}\n`); lines.push(""); }
      else if (tag === "ol") { let n=1; for (const li of child.children) { lines.push(`${n++}. ${inlineHtmlToMd(li)}\n`); } lines.push(""); }
      else if (tag === "br") lines.push("\n");
      else walk(child);
    }
  };
  walk(div);
  return lines.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function inlineHtmlToMd(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += child.textContent; continue; }
    const tag = child.tagName?.toLowerCase();
    if (tag === "strong" || tag === "b") out += `**${inlineHtmlToMd(child)}**`;
    else if (tag === "em" || tag === "i") out += `*${inlineHtmlToMd(child)}*`;
    else if (tag === "a") out += `[${inlineHtmlToMd(child)}](${child.getAttribute("href")})`;
    else out += inlineHtmlToMd(child);
  }
  return out;
}

// ─── RICH TEXT EDITOR (TipTap) ────────────────────────────────────────────────

function RichTextToolbar({ editor }) {
  if (!editor) return null;
  const btn = (active) => ({
    width:32, height:32, borderRadius:6, border:"none",
    background: active ? "var(--amber)" : "transparent",
    color: active ? "#0e0f11" : "var(--text-secondary)",
    cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
    fontSize:13, fontWeight:700, fontFamily:"var(--font-body)",
  });
  const sep = { width:1, height:20, background:"var(--border)", margin:"0 4px" };

  const setLink = () => {
    const url = window.prompt("Link URL:", editor.getAttributes("link").href || "https://");
    if (url === null) return;
    if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div style={{ display:"flex", alignItems:"center", gap:2, padding:"6px 8px", borderBottom:"1px solid var(--border)", background:"var(--bg-elevated)", borderRadius:"8px 8px 0 0", flexWrap:"wrap" }}>
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} style={btn(editor.isActive("bold"))} title="Bold">B</button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} style={{...btn(editor.isActive("italic")), fontStyle:"italic"}} title="Italic">I</button>
      <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()} style={{...btn(editor.isActive("underline")), textDecoration:"underline"}} title="Underline">U</button>
      <div style={sep} />
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} style={btn(editor.isActive("heading", {level:1}))} title="Heading 1">H1</button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} style={btn(editor.isActive("heading", {level:2}))} title="Heading 2">H2</button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} style={btn(editor.isActive("heading", {level:3}))} title="Heading 3">H3</button>
      <div style={sep} />
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} style={btn(editor.isActive("bulletList"))} title="Bullet List">• ≡</button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} style={btn(editor.isActive("orderedList"))} title="Numbered List">1. ≡</button>
      <button type="button" onClick={() => editor.chain().focus().toggleBlockquote().run()} style={btn(editor.isActive("blockquote"))} title="Quote">"</button>
      <div style={sep} />
      <button type="button" onClick={setLink} style={btn(editor.isActive("link"))} title="Link">🔗</button>
      <button type="button" onClick={() => editor.chain().focus().undo().run()} style={btn(false)} title="Undo">↺</button>
      <button type="button" onClick={() => editor.chain().focus().redo().run()} style={btn(false)} title="Redo">↻</button>
    </div>
  );
}

function RichTextEditor({ value, onChange, placeholder = "Write your post here…", minHeight = 380, activeProvider, activeModel, apiKeys }) {
  const isInternalUpdate = useRef(false);
  const [aiPanel,     setAiPanel]     = useState(null); // { text, from, to }
  const [aiNote,      setAiNote]      = useState("");
  const [aiLoading,   setAiLoading]   = useState(false);
  const [aiResult,    setAiResult]    = useState("");
  const containerRef = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1,2,3] } }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder }),
    ],
    content: markdownToHtml(value || ""),
    onUpdate: ({ editor }) => {
      isInternalUpdate.current = true;
      const md = htmlToMarkdown(editor.getHTML());
      onChange(md);
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      if (from === to) { setAiPanel(null); setAiResult(""); setAiNote(""); return; }
      const selectedText = editor.state.doc.textBetween(from, to, " ").trim();
      if (selectedText.length < 10) { setAiPanel(null); return; }
      setAiPanel({ text: selectedText, from, to });
      setAiResult("");
    },
  });

  // Sync external changes into editor
  useEffect(() => {
    if (!editor) return;
    if (isInternalUpdate.current) { isInternalUpdate.current = false; return; }
    const currentMd = htmlToMarkdown(editor.getHTML());
    if (currentMd.trim() !== (value || "").trim()) {
      editor.commands.setContent(markdownToHtml(value || ""));
    }
  }, [value, editor]);

  const rewriteSelection = async () => {
    if (!aiPanel || !editor) return;
    setAiLoading(true); setAiResult("");
    try {
      const guide = loadBrandGuide();
      const brandCtx = buildBrandContext(guide);
      const result = await callAI(
        activeProvider || "anthropic",
        activeModel || "claude-sonnet-4-6",
        `${brandCtx}You are an editor. Rewrite the provided text based on the user's notes. Return ONLY the rewritten text — no explanation, no quotes around it, no preamble. Match the surrounding article's voice and style exactly.`,
        `Original text:\n"${aiPanel.text}"\n\nEditor notes: ${aiNote || "Improve clarity and flow"}`,
        apiKeys?.[activeProvider || "anthropic"],
        800
      );
      setAiResult(result.trim());
    } catch(e) { setAiResult(`Error: ${e.message}`); }
    setAiLoading(false);
  };

  const applyRewrite = () => {
    if (!editor || !aiResult || !aiPanel) return;
    // Replace selected range with rewritten text
    const { from, to } = aiPanel;
    editor.chain()
      .focus()
      .deleteRange({ from, to })
      .insertContentAt(from, aiResult)
      .run();
    setAiPanel(null); setAiResult(""); setAiNote("");
  };

  const dismissPanel = () => {
    setAiPanel(null); setAiResult(""); setAiNote("");
    editor?.commands.setTextSelection(editor.state.selection.from);
  };

  return (
    <div ref={containerRef} style={{ border:"1px solid var(--border)", borderRadius:8, overflow:"visible", background:"var(--bg-elevated)", position:"relative" }}>
      <RichTextToolbar editor={editor} />

      {/* AI Rewrite panel — appears when text is selected */}
      {aiPanel && (
        <div style={{ position:"sticky", top:8, zIndex:100, margin:"0 12px 8px", padding:"14px 16px", borderRadius:10, background:"var(--bg-surface)", border:"1px solid var(--amber)44", boxShadow:"0 4px 20px rgba(0,0,0,0.3)" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
            <span style={{ fontSize:13, fontWeight:700, color:"var(--amber)" }}>✦ AI Rewrite</span>
            <span style={{ fontSize:11, color:"var(--text-secondary)", flex:1 }}>"{aiPanel.text.slice(0,60)}{aiPanel.text.length>60?"…":""}"</span>
            <button onClick={dismissPanel} style={{ background:"none", border:"none", color:"var(--muted)", fontSize:16, cursor:"pointer", padding:2, lineHeight:1 }}>✕</button>
          </div>

          {!aiResult ? (
            <div style={{ display:"flex", gap:8 }}>
              <input
                value={aiNote}
                onChange={e => setAiNote(e.target.value)}
                onKeyDown={e => e.key === "Enter" && rewriteSelection()}
                placeholder="e.g. make it more concise, add more detail, use a fishing metaphor…"
                style={{ flex:1, padding:"8px 12px", borderRadius:7, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:12, fontFamily:"var(--font-body)", outline:"none" }}
                onFocus={e=>e.target.style.borderColor="var(--amber)"} onBlur={e=>e.target.style.borderColor="var(--border)"}
              />
              <button onClick={rewriteSelection} disabled={aiLoading}
                style={{ padding:"8px 16px", borderRadius:7, border:"none", background:aiLoading?"var(--bg-elevated)":"var(--amber)", color:aiLoading?"var(--muted)":"#0e0f11", fontSize:12, fontWeight:700, cursor:aiLoading?"not-allowed":"pointer", fontFamily:"var(--font-body)", display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
                {aiLoading ? <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>Rewriting…</> : "↻ Rewrite"}
              </button>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ padding:"10px 12px", borderRadius:7, background:"var(--bg-elevated)", border:"1px solid var(--border)", fontSize:13, lineHeight:1.7, color:"var(--text)", whiteSpace:"pre-wrap" }}>
                {aiResult}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={applyRewrite}
                  style={{ padding:"7px 18px", borderRadius:7, border:"none", background:"#5cba6c", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  ✓ Apply
                </button>
                <button onClick={() => { setAiResult(""); }}
                  style={{ padding:"7px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  ↻ Try again
                </button>
                <button onClick={dismissPanel}
                  style={{ padding:"7px 14px", borderRadius:7, border:"1px solid var(--border)", background:"transparent", color:"var(--text-secondary)", fontSize:12, cursor:"pointer", fontFamily:"var(--font-body)" }}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        onClick={() => editor?.chain().focus().run()}
        style={{ padding:"14px 16px", minHeight, cursor:"text", fontSize:14, lineHeight:1.8, color:"var(--text)" }}>
        <EditorContent editor={editor} />
      </div>
      <style>{`
        .ProseMirror { outline: none; }
        .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          color: var(--muted);
          float: left;
          pointer-events: none;
          height: 0;
        }
        .ProseMirror h1 { font-family: var(--font-display); font-size: 1.7em; font-weight: 700; margin: 0.6em 0 0.3em; }
        .ProseMirror h2 { font-family: var(--font-display); font-size: 1.4em; font-weight: 700; margin: 0.6em 0 0.3em; }
        .ProseMirror h3 { font-family: var(--font-display); font-size: 1.15em; font-weight: 700; margin: 0.5em 0 0.3em; }
        .ProseMirror p { margin: 0.5em 0; }
        .ProseMirror ul, .ProseMirror ol { margin: 0.5em 0; padding-left: 1.4em; }
        .ProseMirror blockquote { border-left: 3px solid var(--amber); padding-left: 14px; margin: 0.6em 0; color: var(--text-secondary); font-style: italic; }
        .ProseMirror a { color: var(--amber); text-decoration: underline; }
        .ProseMirror strong { font-weight: 700; }
        .ProseMirror ::selection { background: var(--amber-glow); }
      `}</style>
    </div>
  );
}

// Converts plain text / basic markdown → Wix rich content document format

function textToWixContent(text) {
  if (!text) return { nodes: [] };
  const lines = text.split("\n");
  const nodes = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      nodes.push({ type: "PARAGRAPH", nodes: [{ type: "TEXT", textData: { text: " ", decorations: [] } }] });
      continue;
    }
    // H1
    if (trimmed.startsWith("# ")) {
      nodes.push({ type: "HEADING", headingData: { level: 1 }, nodes: [{ type: "TEXT", textData: { text: trimmed.slice(2), decorations: [] } }] });
    // H2
    } else if (trimmed.startsWith("## ")) {
      nodes.push({ type: "HEADING", headingData: { level: 2 }, nodes: [{ type: "TEXT", textData: { text: trimmed.slice(3), decorations: [] } }] });
    // H3
    } else if (trimmed.startsWith("### ")) {
      nodes.push({ type: "HEADING", headingData: { level: 3 }, nodes: [{ type: "TEXT", textData: { text: trimmed.slice(4), decorations: [] } }] });
    // Bullet list
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      nodes.push({ type: "BULLETED_LIST", nodes: [{ type: "LIST_ITEM", nodes: [{ type: "PARAGRAPH", nodes: [{ type: "TEXT", textData: { text: trimmed.slice(2), decorations: [] } }] }] }] });
    // Regular paragraph — handle **bold** inline
    } else {
      const textNodes = [];
      const parts = trimmed.split(/(\*\*.*?\*\*)/g);
      for (const part of parts) {
        if (part.startsWith("**") && part.endsWith("**")) {
          textNodes.push({ type: "TEXT", textData: { text: part.slice(2,-2), decorations: [{ type: "BOLD" }] } });
        } else if (part) {
          textNodes.push({ type: "TEXT", textData: { text: part, decorations: [] } });
        }
      }
      nodes.push({ type: "PARAGRAPH", nodes: textNodes.length ? textNodes : [{ type: "TEXT", textData: { text: trimmed, decorations: [] } }] });
    }
  }

  return { nodes };
}

// Build the Wix create/update post body
function buildWixPostBody(form, status = "DRAFT") {
  return {
    title:   form.title,
    content: form.body || "",
    excerpt: (form.body || "").slice(0, 200).replace(/[#*\n]/g, " ").trim(),
    status,
  };
}

function getWixCfgWithAccount(cfg) {
  return { ...cfg, accountId: cfg.memberId || cfg.siteId || "" };
}

// Push post via Wix Velo HTTP function (runs as site identity — no memberId needed)
async function wixVeloPush(form, publishNow = false, cfg = {}) {
  // Use Wix JS SDK with OAuth token for blog post creation
  // SDK handles auth properly — no memberId needed
  const { createClient, OAuthStrategy } = await import("@wix/sdk");
  const { posts: blogPosts } = await import("@wix/blog");

  const client = createClient({
    modules: { blogPosts },
    auth: OAuthStrategy({
      clientId: "c6500272-f2ac-4fad-aeef-6cd500382297",
      tokens: {
        accessToken:  { value: cfg.oauthToken || "", expiresAt: 9999999999 },
        refreshToken: { role: "member", value: cfg.oauthRefresh || "" },
      },
    }),
  });

  // Create the post using SDK
  const richContent = textToWixContent(form.body);
  const result = await client.blogPosts.createDraftPost({
    draftPost: {
      title:       form.title,
      excerpt:     (form.body || "").slice(0, 200).replace(/[^a-zA-Z0-9 .,!?]/g, " ").trim(),
      richContent,
    }
  });

  const draftId = result?.draftPost?._id || result?._id;
  if (!draftId) throw new Error(`No draft ID returned: ${JSON.stringify(result).slice(0,200)}`);

  if (publishNow) {
    await client.blogPosts.publishDraftPost(draftId);
  }

  return { success: true, postId: draftId };
}

// ─── POST EDITOR MODAL ────────────────────────────────────────────────────────

const CATEGORIES = ["Culture", "Whiskey", "Gear", "Destinations", "Technique", "Lifestyle", "Reviews", "News"];

function PostEditor({ post, onSave, onClose, onDelete, wixConnected, apiKeys = {}, activeProvider = "anthropic", activeModel = "claude-sonnet-4-6" }) {
  const isNew = !post?.id;
  const [form, setForm] = useState({
    title:    post?.title    || "",
    body:     post?.body     || "",
    category: post?.category || "Culture",
    status:   post?.status   || "draft",
    date:     post?.date     || new Date().toISOString().split("T")[0],
    url:      post?.url      || "",
    headlineImageUrl: post?.headlineImageUrl || "",
  });
  const [saved,        setSaved]        = useState(false);
  const [saveStatus,   setSaveStatus]   = useState(""); // "saving" | "saved" | ""
  const [lastSaved,    setLastSaved]    = useState(null);
  const [wixStatus,    setWixStatus]    = useState("");
  const [wixLoading,   setWixLoading]   = useState(false);
  const [wixError,     setWixError]     = useState("");
  const autosaveTimer = useRef(null);

  // Autosave — debounced 2s after last change
  useEffect(() => {
    if (!form.title && !form.body) return;
    setSaveStatus("saving");
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      // Save to localStorage as a backup
      try {
        const key = `bb_post_autosave_${post?.id || "new"}`;
        localStorage.setItem(key, JSON.stringify({ ...form, autosavedAt: new Date().toISOString() }));
      } catch {}
      // Also call onSave to persist to cloud if editing an existing post
      if (post?.id) {
        onSave({ ...post, ...form }, true); // true = silent (no close)
      }
      setLastSaved(new Date());
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(""), 2500);
    }, 2000);
    return () => clearTimeout(autosaveTimer.current);
  }, [form.title, form.body, form.category, form.status]);

  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };

  const handleSave = (silent = false) => {
    if (!form.title.trim()) return;
    onSave({ ...post, ...form, id: post?.id || Date.now() });
    if (!silent) {
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 600);
    }
  };

  const handlePublishToWix = async (asDraft = false) => {
    if (!form.title.trim()) return;
    setWixLoading(true); setWixError(""); setWixStatus("");
    const wixCfg = loadWixConfig();

    try {
      // Use Velo HTTP function — runs as site identity, no memberId needed
      setWixStatus(asDraft ? "Saving draft to Wix…" : "Publishing to Wix…");
      const result = await wixVeloPush(form, !asDraft, wixCfg);
      const newWixId = result.postId;
      const updatedPost = { ...post, ...form, id: post?.id || Date.now(), wixId: newWixId, status: asDraft ? "draft" : "published", fromWix: true };
      onSave(updatedPost);
      setWixStatus(asDraft ? "✓ Saved as draft on Wix" : "✓ Published to caskandstream.com!");
    } catch(e) {
      setWixError(`Wix error: ${e.message}`);
      setWixStatus("");
    }
    setWixLoading(false);
  };

  return (
    <Modal title={isNew ? "New Post" : "Edit Post"} onClose={onClose} wide>
      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        {/* Autosave indicator */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", height:18 }}>
          {saveStatus === "saving" && (
            <span style={{ fontSize:11, color:"var(--muted)", display:"flex", alignItems:"center", gap:4 }}>
              <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>Saving…
            </span>
          )}
          {saveStatus === "saved" && (
            <span style={{ fontSize:11, color:"#5cba6c" }}>✓ Autosaved</span>
          )}
          {!saveStatus && lastSaved && (
            <span style={{ fontSize:11, color:"var(--muted)" }}>
              Last saved {lastSaved.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
            </span>
          )}
        </div>
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
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
            Published URL <span style={{textTransform:"none", fontWeight:400, color:"var(--text-secondary)"}}>— optional, once this post is live somewhere</span>
          </label>
          <input style={iS} placeholder="https://caskandstream.com/blog/your-post-slug" value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} />
          <div style={{ fontSize:11, color:"var(--muted)", marginTop:5, lineHeight:1.5 }}>
            Recording this lets other posts link to this one when you use Find Internal Links in the Pipeline.
          </div>
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>
            Body
          </label>
          <RichTextEditor value={form.body} onChange={(md)=>setForm(f=>({...f,body:md}))} placeholder="Write your post here…" minHeight={300} activeProvider={activeProvider} activeModel={activeModel} apiKeys={apiKeys} />
        </div>

        {/* Headline Image */}
        <HeadlineImagePanel
          title={form.title}
          body={form.body}
          activeProvider={activeProvider || "anthropic"}
          activeModel={activeModel || "claude-sonnet-4-6"}
          apiKeys={apiKeys || {}}
          onImageSaved={(url) => setForm(f => ({ ...f, headlineImageUrl: url }))}
          existingImageUrl={form.headlineImageUrl || null}
        />

        {/* Copy for blog host */}
        <div style={{ padding:"14px 16px", borderRadius:10, border:"1px solid var(--border)", background:"var(--bg-elevated)" }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--muted)", marginBottom:10 }}>
            📋 Copy for Your Blog
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button onClick={() => copyPostWithLinks(form.title, form.body, form.headlineImageUrl)}
              style={{ padding:"8px 16px", borderRadius:8, border:"none", background:"var(--amber)", color:"#0e0f11", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
              📋 Copy Post Text
            </button>
          </div>
          <p style={{ fontSize:11, color:"var(--text-secondary)", margin:"8px 0 0", lineHeight:1.5 }}>
            Copies with formatting and links intact — paste into your blog host's editor when you're ready to publish.
          </p>
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

// ─── ADD SOCIAL COMPETITOR MODAL ──────────────────────────────────────────────

function AddSocialCompetitorModal({ onSave, onClose, dark }) {
  const [form, setForm] = useState({ name:"", handle:"", platform:"Instagram", followers:"", posts:"", engagement:"", threat:"medium" });
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const valid = form.name.trim() && form.handle.trim();
  return (
    <Modal title="Add Social Competitor" onClose={onClose}>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Account Name *</label>
            <input style={iS} placeholder="Hatch Magazine" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} autoFocus />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Handle *</label>
            <input style={iS} placeholder="@hatchmag" value={form.handle} onChange={e=>setForm(f=>({...f,handle:e.target.value}))} />
          </div>
        </div>
        <div>
          <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Platform</label>
          <select style={{ ...iS, cursor:"pointer" }} value={form.platform} onChange={e=>setForm(f=>({...f,platform:e.target.value}))}>
            {["Instagram","Facebook","TikTok","X","Pinterest","Reddit","YouTube"].map(p=><option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Followers</label>
            <input style={iS} placeholder="45K" value={form.followers} onChange={e=>setForm(f=>({...f,followers:e.target.value}))} />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Post Freq</label>
            <input style={iS} placeholder="5/wk" value={form.posts} onChange={e=>setForm(f=>({...f,posts:e.target.value}))} />
          </div>
          <div>
            <label style={{ display:"block", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6 }}>Engagement</label>
            <input style={iS} placeholder="3.2%" value={form.engagement} onChange={e=>setForm(f=>({...f,engagement:e.target.value}))} />
          </div>
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
          <button onClick={()=>{ if(valid){ onSave({...form, id:Date.now()}); onClose(); }}} disabled={!valid}
            style={{ padding:"9px 24px", borderRadius:8, border:"none", background:valid?"var(--amber)":"var(--bg-elevated)", color:valid?(dark?"#0e0f11":"#fff"):"var(--muted)", fontSize:13, fontWeight:700, cursor:valid?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
            Add Competitor
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddCompetitorModal({ onSave, onClose }) {
  const [form, setForm] = useState({ name:"", url:"", posts:"", traffic:"", strengths:"", threat:"medium" });
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const valid = form.name.trim() && form.url.trim();
  const normalizeUrl = (u) => {
    const t = u.trim();
    if (!t) return t;
    return t.startsWith("http://") || t.startsWith("https://") ? t : `https://${t}`;
  };
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
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
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
          <button onClick={()=>{ if(valid){ onSave({...form, url: normalizeUrl(form.url), id:Date.now()}); onClose(); }}} disabled={!valid}
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
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
            {[
              { id:"article",   label:"Article",   icon:"📄" },
              { id:"instagram", label:"Instagram", icon:"📸" },
              { id:"facebook",  label:"Facebook",  icon:"👍" },
              { id:"tiktok",    label:"TikTok",    icon:"🎵" },
              { id:"twitter",   label:"X",         icon:"🐦" },
              { id:"pinterest", label:"Pinterest", icon:"📌" },
              { id:"youtube",   label:"YouTube",   icon:"▶" },
              { id:"podcast",   label:"Podcast",   icon:"🎙" },
              { id:"email",     label:"Email",     icon:"✉" },
              { id:"visual",    label:"Visual",    icon:"🖼" },
              { id:"thread",    label:"Thread",    icon:"💬" },
              { id:"keyword",   label:"Keyword",   icon:"◎" },
              { id:"video",     label:"Video",     icon:"🎬" },
            ].map(t => (
              <button key={t.id} onClick={()=>setForm(f=>({...f,type:t.id}))}
                style={{ padding:"5px 10px", borderRadius:99, border:form.type===t.id?"1px solid var(--amber)":"1px solid var(--border)", background:form.type===t.id?"var(--amber-glow)":"transparent", color:form.type===t.id?"var(--amber)":"var(--text-secondary)", fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:4 }}>
                <span>{t.icon}</span>{t.label}
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

function AddCalendarEventModal({ day, month, year, onSave, onClose }) {
  const today = new Date();
  const m = month ?? today.getMonth();
  const y = year  ?? today.getFullYear();
  const [form, setForm] = useState({ title:"", type:"idea", day: day || today.getDate() });
  const iS = { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-elevated)", color:"var(--text)", fontSize:13, fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box" };
  const valid = form.title.trim();
  return (
    <Modal title={day ? `Add Event — ${MONTH_NAMES[m]} ${day}, ${y}` : "Add Calendar Event"} onClose={onClose}>
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
          <button onClick={()=>{ if(valid){ onSave({ ...form, day: day||form.day, month: m, year: y }); onClose(); }}} disabled={!valid}
            style={{ padding:"9px 24px", borderRadius:8, border:"none", background:valid?"var(--amber)":"var(--bg-elevated)", color:valid?"#0e0f11":"var(--muted)", fontSize:13, fontWeight:700, cursor:valid?"pointer":"not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
            Add Event
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────

export default function Dashboard({ user, workspace }) {
  const { logout: onLogout } = useAuth();
  const isMobile = useIsMobile();
  const [dark,            setDark]           = useState(true);
  const [activeTab,       setActiveTab]      = useState("posts");
  const [postFilter,      setPostFilter]     = useState("all");
  const [researchTab,     setResearchTab]    = useState("competitors");
  const [blogTab,         setBlogTab]        = useState("pipeline");
  const [aiTool,          setAiTool]         = useState("writer");
  const [settingsSection, setSettingsSection]= useState("general");
  const [showUpgrade,     setShowUpgrade]    = useState(false);
  const [apiKeys,         setApiKeys]        = useState(loadKeys);
  const [activeProvider,  setActiveProvider] = useState(() => localStorage.getItem(ACTIVE_PROVIDER_STORAGE) || "anthropic");
  const [activeModel,     setActiveModel]    = useState(() => { const m = loadModels(); const p = AI_PROVIDERS.find(x=>x.id===(localStorage.getItem(ACTIVE_PROVIDER_STORAGE)||"anthropic"))||AI_PROVIDERS[0]; return m[p.id] || p.defaultModel; });

  // ── Persistent state (localStorage)
  const [posts,       setPosts]       = useState(() => { try { const s = localStorage.getItem("bb_posts"); return s ? JSON.parse(s) : DEFAULT_POSTS; } catch { return DEFAULT_POSTS; } });
  const [competitors, setCompetitors] = useState(() => { try { const s = localStorage.getItem("bb_competitors"); return s ? JSON.parse(s) : COMPETITORS; } catch { return COMPETITORS; } });
  const [socialCompetitors, setSocialCompetitors] = useState(() => { try { const s = localStorage.getItem("bb_social_competitors"); return s ? JSON.parse(s) : []; } catch { return []; } });
  const [inspiration, setInspiration] = useState(() => { try { const s = localStorage.getItem("bb_inspiration"); return s ? JSON.parse(s) : INSPIRATION; } catch { return INSPIRATION; } });
  const [socialInspiration, setSocialInspiration] = useState(() => { try { const s = localStorage.getItem("bb_social_inspiration"); return s ? JSON.parse(s) : []; } catch { return []; } });
  const [calEvents,   setCalEvents]   = useState(() => { try { const s = localStorage.getItem("bb_cal_events"); return s ? JSON.parse(s) : CALENDAR_EVENTS; } catch { return CALENDAR_EVENTS; } });
  const [wsSettings,  setWsSettings]  = useState(() => { try { const s = localStorage.getItem("bb_ws_settings"); return s ? JSON.parse(s) : null; } catch { return null; } });

  // ── Cloud sync (Netlify Blobs) — survives localStorage clearing ──────────
  const userId = user?.email || user?.id || "anonymous";
  // Make userId available to components deep in tree (HeadlineImagePanel etc.)
  window.__bbUserId = userId;
  const [cloudSynced, setCloudSynced] = useState(false);

  // Pull from cloud once on mount — cloud wins if it has data
  useEffect(() => {
    (async () => {
      const cloudPosts = await cloudGet("posts", userId);
      if (cloudPosts && Array.isArray(cloudPosts) && cloudPosts.length > 0) {
        setPosts(cloudPosts);
      }
      const cloudInspiration = await cloudGet("inspiration", userId);
      if (cloudInspiration && Array.isArray(cloudInspiration)) {
        setInspiration(cloudInspiration);
      }
      const cloudCompetitors = await cloudGet("competitors", userId);
      if (cloudCompetitors && Array.isArray(cloudCompetitors)) {
        setCompetitors(cloudCompetitors);
      }
      // Pull social posts
      const cloudSocialPosts = await cloudGet("social_posts", userId);
      if (cloudSocialPosts && Array.isArray(cloudSocialPosts)) {
        setSocialPosts(cloudSocialPosts);
        saveSocialPostsToStorage(cloudSocialPosts);
      }
      // Pull brand guide
      const cloudBrandGuide = await cloudGet("brand_guide", userId);
      if (cloudBrandGuide && typeof cloudBrandGuide === "object") {
        setBrandGuide(cloudBrandGuide);
        saveBrandGuide(cloudBrandGuide);
      }
      // Pull API keys
      const cloudApiKeys = await cloudGet("api_keys", userId);
      if (cloudApiKeys && typeof cloudApiKeys === "object") {
        setApiKeys(cloudApiKeys);
        try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(cloudApiKeys)); } catch {}
      }
      // Pull GSC config (tokens)
      const cloudGSC = await cloudGet("gsc_config", userId);
      if (cloudGSC && typeof cloudGSC === "object" && cloudGSC.refreshToken) {
        saveGSCConfig(cloudGSC);
      }
      // Pull Meta config
      const cloudMeta = await cloudGet("meta_config", userId);
      if (cloudMeta && typeof cloudMeta === "object" && cloudMeta.connected) {
        saveMetaConfig(cloudMeta);
        setMetaConfig(cloudMeta);
      }
      // Pull Buffer config
      const cloudBuffer = await cloudGet("buffer_config", userId);
      if (cloudBuffer && typeof cloudBuffer === "object" && cloudBuffer.apiKey) {
        saveBufferConfig(cloudBuffer);
      }
      setCloudSynced(true);
    })();
  }, []);

  // Refresh social posts when tab becomes visible again (catches scheduler updates)
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      const cloudSocialPosts = await cloudGet("social_posts", userId);
      if (cloudSocialPosts && Array.isArray(cloudSocialPosts)) {
        setSocialPosts(cloudSocialPosts);
        saveSocialPostsToStorage(cloudSocialPosts);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId]);

  // Re-pull social posts from cloud whenever Marketing tab is opened
  // (catches any auto-publishes that happened while the tab was closed)
  useEffect(() => {
    if (activeTab !== "social") return;
    (async () => {
      const cloudSocialPosts = await cloudGet("social_posts", userId);
      if (cloudSocialPosts && Array.isArray(cloudSocialPosts)) {
        setSocialPosts(cloudSocialPosts);
        saveSocialPostsToStorage(cloudSocialPosts);
      }
    })();
  }, [activeTab]);

  // Push to cloud whenever posts/inspiration/competitors change (debounced)
  useEffect(() => { if (cloudSynced) cloudSaveDebounced("posts", userId, posts); }, [posts, cloudSynced]);
  useEffect(() => { if (cloudSynced) cloudSaveDebounced("inspiration", userId, inspiration); }, [inspiration, cloudSynced]);
  useEffect(() => { if (cloudSynced) cloudSaveDebounced("competitors", userId, competitors); }, [competitors, cloudSynced]);
  // Push API keys to cloud (debounced — they change when user adds a key in settings)
  useEffect(() => { if (cloudSynced && Object.keys(apiKeys).length > 0) cloudSaveDebounced("api_keys", userId, apiKeys, 2000); }, [apiKeys, cloudSynced]);
  // Push GSC + Meta configs whenever they change (triggered manually after connect/save)
  const syncGSCToCloud  = (cfg)  => { if (cfg?.refreshToken) cloudSet("gsc_config",  userId, cfg);  };
  const syncMetaToCloud = (cfg)  => { if (cfg?.connected)    cloudSet("meta_config",  userId, cfg);  };

  // Persist whenever data changes
  useEffect(() => { try { localStorage.setItem("bb_posts",       JSON.stringify(posts));       } catch {} }, [posts]);
  useEffect(() => { try { localStorage.setItem("bb_competitors", JSON.stringify(competitors)); } catch {} }, [competitors]);
  useEffect(() => { try { localStorage.setItem("bb_inspiration", JSON.stringify(inspiration)); } catch {} }, [inspiration]);
  useEffect(() => { try { localStorage.setItem("bb_social_inspiration", JSON.stringify(socialInspiration)); } catch {} }, [socialInspiration]);
  useEffect(() => { try { localStorage.setItem("bb_social_competitors", JSON.stringify(socialCompetitors)); } catch {} }, [socialCompetitors]);
  useEffect(() => { try { localStorage.setItem("bb_cal_events",  JSON.stringify(calEvents));  } catch {} }, [calEvents]);

  // ── Modal state
  const [postEditorOpen,    setPostEditorOpen]    = useState(false);
  const [editingPost,       setEditingPost]       = useState(null);
  const [pipelineInitialPost, setPipelineInitialPost] = useState(null);
  const sendPostToPipeline = (post) => { setPipelineInitialPost(post); setActiveTab("blog"); setBlogTab("pipeline"); };
  const [socialPipelineHandoff, setSocialPipelineHandoff] = useState(null);
  const sendArticleToSocialPipeline = (article) => {
    setSocialPipelineHandoff({ title: article.title, source: "Blog article", headlineImageUrl: article.headlineImageUrl || null });
    setActiveTab("social");
  };
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
  const saveSocialCompetitor = (item) => setSocialCompetitors(all => [item, ...all]);
  const deleteSocialCompetitor = (name) => setSocialCompetitors(all => all.filter(c => c.name !== name));

  const saveInspiration = (item) => setInspiration(all => [item, ...all]);
  const deleteInspiration = (id) => setInspiration(all => all.filter(i => i.id !== id));
  const saveSocialInspiration = (item) => setSocialInspiration(all => [item, ...all]);
  const deleteSocialInspiration = (id) => setSocialInspiration(all => all.filter(i => i.id !== id));
  const inspirationToDraft = (item) => {
    const newPost = { id:Date.now(), title:item.title, body:`Source: ${item.source}\n\nNotes: ${item.notes}\n\n`, category:"Culture", status:"draft", date:new Date().toISOString().split("T")[0], views:0 };
    setPosts(all => [newPost, ...all]);
    setEditingPost(newPost);
    setPostEditorOpen(true);
    setActiveTab("blog");
    setBlogTab("posts");
  };

  const saveCalEvent = (ev) => setCalEvents(all => [...all, ev]);
  const deleteCalEvent = (idx) => setCalEvents(all => all.filter((_, i) => i !== idx));

  const [gscData,     setGscData]     = useState(loadGSCData);
  const [metaConfig,   setMetaConfig]   = useState(loadMetaConfig);
  const [brandGuide,   setBrandGuide]   = useState(loadBrandGuide);
  const [socialPosts,  setSocialPosts]  = useState(loadSocialPosts);

  const saveSocialPost = (post) => {
    setSocialPosts(all => {
      const idx = all.findIndex(p => p.id === post.id);
      const next = idx >= 0 ? all.map(p => p.id===post.id ? post : p) : [post, ...all];
      saveSocialPostsToStorage(next);
      // Sync to Blobs — strips blob: image URLs (can't serialize) but keeps data: URLs
      const forCloud = next.map(p => ({
        ...p,
        imageUrl: p.imageUrl?.startsWith("blob:") ? null : p.imageUrl,
      }));
      cloudSet("social_posts", userId, forCloud);
      // Also sync Meta credentials alongside so the scheduler can publish
      const meta = loadMetaConfig();
      if (meta?.connected) cloudSet("meta_config", userId, meta);
      return next;
    });
  };

  const deleteSocialPost = (id) => {
    setSocialPosts(all => {
      const next = all.filter(p => p.id !== id);
      saveSocialPostsToStorage(next);
      cloudSet("social_posts", userId, next);
      return next;
    });
  };
  const [wixConnected, setWixConnected] = useState(() => !!loadWixConfig().connected);

  // Re-check wix connection state whenever settings tab is visited
  useEffect(() => {
    setWixConnected(!!loadWixConfig().connected);
  }, [activeTab, settingsSection]);

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
  const [userTier, setUserTier] = useState(loadUserTier);
  const tierConfig = TIER_CONFIG[userTier] || TIER_CONFIG.scout;
  const planLabel = TIER_CONFIG[userTier]?.label || "Scout";
  const changeTier = (tier) => { setUserTier(tier); saveUserTier(tier); };
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
    { id:"blog",      label:"Blog",       icon:"◈", highlight:true },
    { id:"social",    label:"Marketing",  icon:"▣" },
    { id:"analytics", label:"Analytics",  icon:"◔" },
    { id:"calendar",  label:"Calendar",   icon:"▦" },
    { id:"settings",  label:"Settings",   icon:"⚙" },
  ];

  const SETTINGS_SECTIONS = [
    { id:"general",    label:"General"              },
    { id:"brand",      label:"Brand Guide"          },
    { id:"apikeys",    label:"API Keys"             },
    { id:"gsc",        label:"Search Console"       },
    { id:"meta",       label:"Facebook & Instagram" },
    { id:"buffer",     label:"Buffer (Social)"      },
    { id:"social",     label:"Social Media"         },
    { id:"publish",    label:"Publishing"           },
    { id:"billing",    label:"Billing & Plan"       },
    { id:"account",    label:"Account"              },
  ];

  return (
    <div className="bb-root" style={{...theme,fontFamily:"var(--font-body)",color:"var(--text)",background:"var(--bg)",minHeight:"100vh",display:"flex",fontSize:14,lineHeight:1.5}}>
      <style>{MOBILE_CSS}</style>
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* ── GLOBAL AI QUICK-SWITCHER ── */}
      <AIQuickSwitcher
        activeProvider={activeProvider}
        activeModel={activeModel}
        onProviderChange={handleProviderChange}
        onModelChange={handleModelChange}
        apiKeys={apiKeys}
      />
      {postEditorOpen && (
        <PostEditor
          post={editingPost}
          onSave={savePost}
          onClose={() => setPostEditorOpen(false)}
          onDelete={deletePost}
          wixConnected={wixConnected}
          apiKeys={apiKeys}
          activeProvider={activeProvider}
          activeModel={activeModel}
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
      <aside className="bb-sidebar" style={{width:220,minWidth:220,background:"var(--sidebar-bg)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"20px 20px 16px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:10}}>
          {(() => {
            const [sidebarLogo, setSidebarLogo] = useState(loadLogo);
            useEffect(() => {
              const handler = (e) => setSidebarLogo(e.detail || null);
              window.addEventListener("bb-logo-updated", handler);
              return () => window.removeEventListener("bb-logo-updated", handler);
            }, []);
            return sidebarLogo ? (
              <img src={sidebarLogo} alt="Logo" style={{height:32,maxWidth:100,objectFit:"contain",flexShrink:0}} />
            ) : (
              <div style={{width:32,height:32,borderRadius:8,background:"var(--amber)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:dark?"#0e0f11":"#fff",fontFamily:"var(--font-display)",flexShrink:0}}>B</div>
            );
          })()}
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
          <div style={{fontSize:10,marginTop:6,color:"var(--text-secondary)"}}>
            <span style={{color:fixedGreen}}>◈</span> {connectedProviders} AI · {connectedSocial} social
          </div>
          <div style={{fontSize:10,marginTop:4,color:cloudSynced?fixedGreen:"var(--muted)"}}>
            <span style={{width:6,height:6,borderRadius:99,background:cloudSynced?fixedGreen:"var(--muted)",display:"inline-block",marginRight:4}}/>
            {cloudSynced?"☁ Cloud synced":"☁ Syncing…"}
          </div>
        </div>

        <nav style={{padding:"12px 12px",flex:1}}>
          <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--muted)",padding:"0 8px 6px"}}>Modules</div>
          {TABS.map(t=>(
            <div key={t.id} onClick={()=>setActiveTab(t.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,cursor:"pointer",background:activeTab===t.id?"var(--bg-elevated)":t.highlight?"var(--amber-glow)":"transparent",color:activeTab===t.id?"var(--amber)":t.highlight?"var(--amber)":"var(--text-secondary)",fontWeight:activeTab===t.id||t.highlight?600:400,fontSize:13,marginBottom:2,transition:"all 0.15s",border:t.highlight&&activeTab!==t.id?"1px solid var(--amber)33":"1px solid transparent"}}>
              <span style={{fontSize:15,width:18,textAlign:"center"}}>{t.icon}</span>
              {t.label}
              {t.highlight&&activeTab!==t.id&&<span style={{marginLeft:"auto",fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:99,background:"var(--amber)",color:"#0e0f11"}}>NEW</span>}
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
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            {(() => {
              const [headerLogo, setHeaderLogo] = useState(loadLogo);
              useEffect(() => {
                const handler = (e) => setHeaderLogo(e.detail || null);
                window.addEventListener("bb-logo-updated", handler);
                return () => window.removeEventListener("bb-logo-updated", handler);
              }, []);
              return headerLogo ? (
                <img src={headerLogo} alt="Logo" style={{height:40,maxWidth:160,objectFit:"contain"}} />
              ) : null;
            })()}
            <div>
              <h1 style={{fontFamily:"var(--font-display)",fontSize:22,fontWeight:700,margin:0}}>{!loadLogo() ? "🥃 " : ""}{wsName}</h1>
              <p style={{margin:"2px 0 0",fontSize:12,color:"var(--text-secondary)"}}>
                {posts.length} posts · {wsTagline}
              </p>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button style={btnS} onClick={()=>{ const input = document.createElement("input"); input.type="file"; input.accept=".md,.txt,.html"; input.onchange = e => { const file = e.target.files[0]; if(!file) return; const reader = new FileReader(); reader.onload = ev => { const newPost = { id:Date.now(), title:file.name.replace(/\.[^/.]+$/,""), body:ev.target.result, category:"Culture", status:"draft", date:new Date().toISOString().split("T")[0], views:0 }; savePost(newPost); setEditingPost(newPost); setPostEditorOpen(true); }; reader.readAsText(file); }; input.click(); }}>Import</button>
            <button style={btnP} onClick={openNewPost}>+ New Post</button>
          </div>
        </header>

        {/* ── MOBILE BOTTOM NAV ── */}
        <nav className="bb-mobile-nav">
          {[
            { id:"blog",      icon:"◈", label:"Blog"    },
            { id:"social",    icon:"▣", label:"Market"   },
            { id:"analytics", icon:"◔", label:"Analytics"},
            { id:"calendar",  icon:"▦", label:"Calendar" },
            { id:"settings",  icon:"⚙", label:"Settings" },
          ].map(t => (
            <button key={t.id} className={activeTab===t.id?"active":""} onClick={() => setActiveTab(t.id)}>
              <span className="nav-icon">{t.icon}</span>
              <span className="nav-label">{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="bb-main-content" style={{flex:1,overflow:"auto",padding:28}}>

          {/* ══ BLOG ══ */}
          {activeTab==="blog"&&(
            <div>
              <div style={{display:"flex",gap:4,marginBottom:24,background:"var(--bg-surface)",borderRadius:10,padding:4,border:"1px solid var(--border)",width:"fit-content"}}>
                {[{id:"pipeline",label:"Article Pipeline",icon:"◈",highlight:true},{id:"posts",label:"Posts",icon:"▤"},{id:"research",label:"Research",icon:"◎"}].map(t=>(
                  <button key={t.id} onClick={()=>setBlogTab(t.id)} style={{padding:"8px 16px",borderRadius:8,border:"none",background:blogTab===t.id?"var(--amber)":"transparent",color:blogTab===t.id?(dark?"#0e0f11":"#fff"):"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",gap:6}}>
                    <span>{t.icon}</span>{t.label}
                  </button>
                ))}
              </div>

              {blogTab==="pipeline"&&(
                <ContentPipeline
              posts={posts}
              inspiration={inspiration}
              competitors={competitors}
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
              dark={dark}
              wixConnected={wixConnected}
              onSavePost={savePost}
              onAddInspiration={saveInspiration}
              onAddCalEvent={saveCalEvent}
              wsName={wsName}
              wsTagline={wsTagline}
              onProviderChange={handleProviderChange}
              onModelChange={handleModelChange}
              brandGuide={brandGuide}
              initialPost={pipelineInitialPost}
              onConsumedInitialPost={() => setPipelineInitialPost(null)}
              onSendToSocialPipeline={sendArticleToSocialPipeline}
            />
              )}

              {blogTab==="posts"&&(
                <PostsTab
              posts={posts}
              filteredPosts={filteredPosts}
              postFilter={postFilter}
              setPostFilter={setPostFilter}
              setPosts={setPosts}
              savePost={savePost}
              openEditPost={openEditPost}
              onSendToPipeline={sendPostToPipeline}
              card={card}
              btnP={btnP}
            />
              )}

              {blogTab==="research"&&(
            <div>
              <div style={{display:"flex",gap:4,marginBottom:24,background:"var(--bg-surface)",borderRadius:10,padding:4,border:"1px solid var(--border)",width:"fit-content"}}>
                {[{id:"competitors",label:"Competitors",icon:"⊞"},{id:"tracker",label:"Post Tracker",icon:"◉"},{id:"inspiration",label:"Inspiration",icon:"◐"},{id:"ideas",label:"AI Ideas",icon:"✦"}].map(t=>(
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
                        {["Competitor","Frequency","Est. Traffic","Strengths","Threat"].map(h=>(
                          <th key={h} style={{textAlign:"left",padding:"12px 16px",fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--muted)"}}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {competitors.map(c=>(
                          <tr key={c.name||c.id} style={{borderBottom:"1px solid var(--border)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="var(--bg-hover)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <td style={{padding:"14px 16px"}}><div style={{fontWeight:600,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:"var(--text-secondary)"}}>{c.url}</div></td>
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
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:16,marginTop:16}}>
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
                <InspirationBoard
                  inspiration={inspiration}
                  onAddNew={()=>setAddInspirationOpen(true)}
                  onDelete={deleteInspiration}
                  onToDraft={inspirationToDraft}
                  card={card}
                  btnS={btnS}
                  btnP={btnP}
                />
              )}
              {researchTab==="ideas"&&(
                <AIIdeaGenerator
                  posts={posts}
                  inspiration={inspiration}
                  onAddIdeas={saveInspiration}
                  activeProvider={activeProvider}
                  activeModel={activeModel}
                  apiKeys={apiKeys}
                  dark={dark}
                  onProviderChange={handleProviderChange}
                  onModelChange={handleModelChange}
                />
              )}
              {researchTab==="tracker"&&(
                <CompetitorTracker
                  competitors={competitors}
                  onAddInspiration={saveInspiration}
                  activeProvider={activeProvider}
                  activeModel={activeModel}
                  apiKeys={apiKeys}
                  dark={dark}
                  onProviderChange={handleProviderChange}
                  onModelChange={handleModelChange}
                />
              )}
            </div>
              )}
            </div>
          )}

          {/* ══ ANALYTICS ══ */}
          {activeTab==="analytics"&&(
            <AnalyticsDashboard
              posts={posts}
              gscData={gscData}
              metaConfig={metaConfig}
              socialPosts={socialPosts}
              dark={dark}
              userId={userId}
              onConnectGSC={()=>{ setActiveTab("settings"); setSettingsSection("gsc"); }}
              onGSCDataLoaded={(data)=>{ setGscData(data); saveGSCData(data); }}
              onConnectMeta={()=>{ setActiveTab("settings"); setSettingsSection("meta"); }}
              activeProvider={activeProvider}
              activeModel={activeModel}
              apiKeys={apiKeys}
            />
          )}

          {/* ══ CALENDAR ══ */}
          {activeTab==="calendar"&&(
            <CalendarTab
              calEvents={calEvents}
              deleteCalEvent={deleteCalEvent}
              setCalModalDay={setCalModalDay}
              setCalModalOpen={setCalModalOpen}
              btnP={btnP}
              fixedGreen={fixedGreen}
              dark={dark}
            />
          )}

          {/* ══ SOCIAL ══ */}
          {activeTab==="social"&&(
            <MarketingErrorBoundary>
              <MarketingStudio
                activeProvider={activeProvider}
                activeModel={activeModel}
                apiKeys={apiKeys}
                dark={dark}
                metaConfig={metaConfig}
                posts={posts}
                inspiration={inspiration}
                competitors={competitors}
                onAddInspiration={saveInspiration}
                handleProviderChange={handleProviderChange}
                handleModelChange={handleModelChange}
                brandGuide={brandGuide}
                socialPosts={socialPosts}
                onSaveSocialPost={saveSocialPost}
                onDeleteSocialPost={deleteSocialPost}
                userId={userId}
                socialInspiration={socialInspiration}
                onAddSocialInspiration={saveSocialInspiration}
                onDeleteSocialInspiration={deleteSocialInspiration}
                socialCompetitors={socialCompetitors}
                onAddSocialCompetitor={saveSocialCompetitor}
                onDeleteSocialCompetitor={deleteSocialCompetitor}
                externalInitialIdea={socialPipelineHandoff}
                onConsumedExternalInitialIdea={() => setSocialPipelineHandoff(null)}
                tierConfig={tierConfig}
              />
            </MarketingErrorBoundary>
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
                  <APIKeysSettings apiKeys={apiKeys} onSave={setApiKeys} byokEnabled={tierConfig.byok}/>
                )}

                {settingsSection==="brand"&&(
                  <BrandGuidePanel onSave={(g) => { setBrandGuide(g); cloudSet("brand_guide", userId, g); }} />
                )}

                {settingsSection==="gsc"&&(
                  <GSCPanel onDataLoaded={(data)=>{ setGscData(data); saveGSCData(data); }} />
                )}

                {settingsSection==="meta"&&(
                  <div>
                    <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Facebook & Instagram</h3>
                    <p style={{ fontSize:13, color:"var(--text-secondary)", margin:"0 0 20px", lineHeight:1.6 }}>
                      Connect your Facebook Page and Instagram Business account to publish directly from Blog Bunker.
                    </p>
                    <MetaConnectPanel onConnected={(cfg) => setMetaConfig(cfg)} />
                  </div>
                )}

                {settingsSection==="buffer"&&(
                  tierConfig.buffer ? <BufferSettings /> : <TierLockedNotice feature="Buffer integration" />
                )}

                {settingsSection==="tiktok"&&( tierConfig.buffer ? <BufferSettings /> : <TierLockedNotice feature="TikTok posting (via Buffer)" /> )}
                {settingsSection==="pinterest"&&( tierConfig.buffer ? <BufferSettings /> : <TierLockedNotice feature="Pinterest posting (via Buffer)" /> )}
                {settingsSection==="twitter"&&( tierConfig.buffer ? <BufferSettings /> : <TierLockedNotice feature="X posting (via Buffer)" /> )}
                {settingsSection==="reddit"&&( tierConfig.buffer ? <BufferSettings /> : <TierLockedNotice feature="Reddit posting (via Buffer)" /> )}

                {settingsSection==="social"&&(
                  <SocialSettings/>
                )}

                {settingsSection==="publish"&&(
                  <div>
                    <h3 style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:700, margin:"0 0 4px" }}>Publishing</h3>
                    <p style={{ fontSize:13, color:"var(--text-secondary)", margin:"0 0 20px", lineHeight:1.6 }}>
                      Blog Bunker doesn't publish directly to a blog host yet. Write and finish your article in the Pipeline, then copy it and paste it into whichever blog host you use — WordPress, Wix, Squarespace, Ghost, or anywhere else — when you're ready to go live.
                    </p>
                    <div style={{ fontSize:12, color:"var(--text-secondary)", padding:"12px 14px", borderRadius:8, background:"var(--bg-elevated)", border:"1px solid var(--border)" }}>
                      ✦ Direct social publishing to Facebook, Instagram, and other platforms via Buffer is already live — see <strong style={{color:"var(--text)"}}>Facebook & Instagram</strong> and <strong style={{color:"var(--text)"}}>Buffer (Social)</strong> in this menu. Direct blog-host publishing is still on the roadmap.
                    </div>
                  </div>
                )}

                {settingsSection==="billing"&&(
                  <div>
                    <h3 style={{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,margin:"0 0 8px"}}>Billing & Plan</h3>
                    <p style={{fontSize:13,color:"var(--text-secondary)",margin:"0 0 12px"}}>Current plan: <span style={{color:"var(--amber)",fontWeight:700}}>{planLabel}</span></p>
                    <div style={{fontSize:11,color:"var(--muted)",padding:"8px 12px",borderRadius:6,background:"var(--bg-elevated)",border:"1px solid var(--border)",marginBottom:16}}>
                      No payment processor is wired up yet — this switches your plan directly for testing. Once billing is built, this will be driven by your actual subscription instead.
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginBottom:24}}>
                      {PLANS.map(p=>(
                        <div key={p.name} style={{padding:20,borderRadius:10,border:planLabel===p.name?"2px solid var(--amber)":"1px solid var(--border)",background:planLabel===p.name?"var(--amber-glow)":"var(--bg-elevated)",textAlign:"center"}}>
                          <div style={{fontFamily:"var(--font-display)",fontSize:16,fontWeight:700,marginBottom:4}}>{p.name}</div>
                          <div style={{fontSize:22,fontWeight:700,color:"var(--amber)",fontFamily:"var(--font-display)",marginBottom:12}}>{p.price}</div>
                          {p.features.map((f,i)=><div key={i} style={{fontSize:12,color:"var(--text-secondary)",padding:"3px 0"}}>{f}</div>)}
                          <button onClick={()=>changeTier(p.name.toLowerCase())} style={{...(planLabel===p.name?btnP:btnS),marginTop:14,width:"100%"}}>{planLabel===p.name?"Current Plan":`Switch to ${p.name}`}</button>
                        </div>
                      ))}
                    </div>
                    <UsagePanel tierConfig={tierConfig} userId={userId} />
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
