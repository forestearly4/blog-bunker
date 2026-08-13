/**
 * netlify/functions/image-generate.js
 * Server-side proxy for image generation — routes to OpenAI, Gemini, or Stability AI.
 * Avoids CORS issues with direct browser-to-provider calls.
 *
 * POST /api/image-generate
 * { provider, prompt, size, quality, apiKey, ... }             — BYOK (user's own key)
 * { provider: "stability-platform", prompt, size, userId }     — platform-managed (Blog Bunker's own key, tier-metered)
 */

import { getStore } from "@netlify/blobs";

// Same image caps as TIER_CONFIG in dashboard.jsx — keep in sync if changed there.
const IMAGE_CAPS = { scout: 20, operative: 100 };

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: CORS });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

  const { provider, prompt, size = "1024x1024", quality = "medium", apiKey, userId } = body;
  if (!provider || !prompt) {
    return new Response(JSON.stringify({ error: "provider and prompt are required" }), { status: 400, headers: CORS });
  }
  if (provider !== "stability-platform" && !apiKey) {
    return new Response(JSON.stringify({ error: "apiKey is required for this provider" }), { status: 400, headers: CORS });
  }

  try {
    // ── OPENAI gpt-image-2 ────────────────────────────────────────────────────
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model:  "gpt-image-2",
          prompt,
          n:      1,
          size,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error("No image data returned from OpenAI");
      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // ── GEMINI Imagen ─────────────────────────────────────────────────────────
    if (provider === "gemini") {
      const models = ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image", "imagen-3.0-generate-001"];
      let lastErr = "";
      for (const model of models) {
        try {
          const endpoint = model.startsWith("imagen")
            ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`
            : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const bodyPayload = model.startsWith("imagen")
            ? { instances: [{ prompt }], parameters: { sampleCount: 1 } }
            : { contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } };

          const res  = await fetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(bodyPayload) });
          const data = await res.json();
          if (data.error) { lastErr = data.error.message; continue; }

          const b64 = model.startsWith("imagen")
            ? data.predictions?.[0]?.bytesBase64Encoded
            : data.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
          if (!b64) { lastErr = "No image data returned"; continue; }
          return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
        } catch(e) { lastErr = e.message; }
      }
      throw new Error(lastErr || "All Gemini models failed");
    }

    // ── STABILITY AI — PLATFORM-MANAGED text-to-image (Blog Bunker's own key) ──
    // Uses Blog Bunker's own STABILITY_API_KEY, not the user's — metered against
    // their tier's monthly image quota. This is the only image path in the app
    // that doesn't require the user to bring their own key/account.
    if (provider === "stability-platform") {
      const platformKey = process.env.STABILITY_API_KEY;
      if (!platformKey) throw new Error("Platform image generation isn't configured yet (STABILITY_API_KEY not set) — use your own API key in Settings → API Keys instead.");

      const store  = getStore("blog-bunker-data");
      const period = new Date().toISOString().slice(0, 7); // YYYY-MM

      if (userId) {
        const tier  = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
        const cap   = IMAGE_CAPS[tier] || IMAGE_CAPS.scout;
        const usage = await store.get(`${userId}:usage_images_${period}`, { type: "json" }) || { images: 0 };
        if ((usage.images || 0) >= cap) {
          return new Response(JSON.stringify({
            error: `Monthly AI image limit reached (${cap} images on your current plan). Upgrade your plan, add your own Stability/OpenAI/Gemini key in Settings → API Keys, or wait until next month.`,
          }), { status: 429, headers: CORS });
        }
      }

      // Current Stable Image API (v2beta) — the BYOK case above still targets
      // the older SDXL 1.0 img2img endpoint for restyle; this uses Stability's
      // present-day Core model for straightforward text-to-image. Requesting
      // Accept: image/* and encoding the binary ourselves avoids any ambiguity
      // about Stability's JSON response field naming.
      const formData = new FormData();
      formData.append("prompt", prompt);
      formData.append("output_format", "png");
      formData.append("aspect_ratio", "1:1");

      const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${platformKey}`, "Accept": "image/*" },
        body:    formData,
      });
      if (!res.ok) {
        let errText;
        try { errText = (await res.json()).errors?.[0]; } catch { errText = await res.text(); }
        throw new Error(errText || `Stability error ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      if (!b64) throw new Error("No image returned from Stability AI");

      if (userId) {
        const usage = await store.get(`${userId}:usage_images_${period}`, { type: "json" }) || { images: 0 };
        await store.setJSON(`${userId}:usage_images_${period}`, { images: (usage.images || 0) + 1 });
      }

      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // ── STABILITY AI — shared image-to-image call (restyle) ─────────────────────
    // Confirmed via multiple independent sources: image-to-image needs the sd3
    // endpoint specifically (NOT core/ultra, which are text-to-image only),
    // with mode=image-to-image, an actual image file field, and strength (0-1,
    // 0=identical to input, 1=completely new). Binary response, same pattern as
    // the text-to-image cases above — avoids any JSON field-name ambiguity.
    async function stabilityImageToImage(key, promptText, imageBase64, strength) {
      const byteChars = atob(imageBase64);
      const byteArr   = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const imageBlob = new Blob([byteArr], { type: "image/png" });

      const formData = new FormData();
      formData.append("prompt", promptText);
      formData.append("mode", "image-to-image");
      formData.append("image", imageBlob, "image.png");
      formData.append("strength", String(strength ?? 0.65));
      formData.append("output_format", "png");

      const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/sd3", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${key}`, "Accept": "image/*" },
        body:    formData,
      });
      if (!res.ok) {
        let errText;
        try { errText = (await res.json()).errors?.[0]; } catch { errText = await res.text(); }
        throw new Error(errText || `Stability error ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      if (!b64) throw new Error("No image returned from Stability AI");
      return b64;
    }

    // ── STABILITY AI — PLATFORM-MANAGED restyle (image-to-image) ────────────────
    if (provider === "stability-restyle-platform") {
      const platformKey = process.env.STABILITY_API_KEY;
      if (!platformKey) throw new Error("Platform image generation isn't configured yet (STABILITY_API_KEY not set) — use your own API key in Settings → API Keys instead.");
      const { imageBase64, strength } = body;
      if (!imageBase64) throw new Error("imageBase64 required for restyle");

      const store  = getStore("blog-bunker-data");
      const period = new Date().toISOString().slice(0, 7);
      if (userId) {
        const tier  = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
        const cap   = IMAGE_CAPS[tier] || IMAGE_CAPS.scout;
        const usage = await store.get(`${userId}:usage_images_${period}`, { type: "json" }) || { images: 0 };
        if ((usage.images || 0) >= cap) {
          return new Response(JSON.stringify({
            error: `Monthly AI image limit reached (${cap} images on your current plan). Upgrade your plan, add your own Stability key in Settings → API Keys, or wait until next month.`,
          }), { status: 429, headers: CORS });
        }
      }

      const b64 = await stabilityImageToImage(platformKey, prompt, imageBase64, strength);

      if (userId) {
        const usage = await store.get(`${userId}:usage_images_${period}`, { type: "json" }) || { images: 0 };
        await store.setJSON(`${userId}:usage_images_${period}`, { images: (usage.images || 0) + 1 });
      }

      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // ── STABILITY AI — BYOK restyle (image-to-image) ─────────────────────────────
    if (provider === "stability-restyle") {
      const { imageBase64, strength } = body;
      if (!imageBase64) throw new Error("imageBase64 required for restyle");
      const b64 = await stabilityImageToImage(apiKey, prompt, imageBase64, strength);
      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // ── STABILITY AI — BYOK text-to-image (user's own key) ──────────────────────
    if (provider === "stability-text") {
      const formData = new FormData();
      formData.append("prompt", prompt);
      formData.append("output_format", "png");
      formData.append("aspect_ratio", "1:1");

      const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "image/*" },
        body:    formData,
      });
      if (!res.ok) {
        let errText;
        try { errText = (await res.json()).errors?.[0]; } catch { errText = await res.text(); }
        throw new Error(errText || `Stability error ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      if (!b64) throw new Error("No image returned from Stability AI");
      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // ── STABILITY AI img2img ──────────────────────────────────────────────────
    if (provider === "stability") {
      const { imageBase64 } = body;
      if (!imageBase64) throw new Error("imageBase64 required for Stability img2img");
      const strength = body.strength || 0.65;

      const byteChars = atob(imageBase64);
      const byteArr   = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const imgBlob = new Blob([byteArr], { type: "image/png" });

      const formData = new FormData();
      formData.append("init_image", imgBlob, "image.png");
      formData.append("text_prompts[0][text]", prompt + ", high quality");
      formData.append("text_prompts[0][weight]", "1");
      formData.append("text_prompts[1][text]", "blurry, low quality, distorted");
      formData.append("text_prompts[1][weight]", "-1");
      formData.append("image_strength", String(1 - strength));
      formData.append("cfg_scale", "7");
      formData.append("samples", "1");
      formData.append("steps", "30");

      const res  = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image", {
        method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" }, body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Stability error ${res.status}`);
      const b64 = data.artifacts?.[0]?.base64;
      if (!b64) throw new Error("No image returned from Stability AI");
      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // NOTE: openai-edit and gemini-edit (AI Restyle) moved to a background-job
    // architecture — see image-edit.js + image-edit-status.js. gpt-image-2 edits
    // can take longer than this function's ~10-26s sync timeout, which was
    // causing the connection to be cut mid-response ("Unexpected end of JSON
    // input" on the client). Background functions get up to 15 minutes.

    return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), { status: 400, headers: CORS });

  } catch(e) {
    console.error("[image-generate]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/image-generate" };
