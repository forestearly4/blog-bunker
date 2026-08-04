/**
 * netlify/functions/image-generate.js
 * Server-side proxy for image generation — routes to OpenAI, Gemini, or Stability AI.
 * Avoids CORS issues with direct browser-to-provider calls.
 *
 * POST /api/image-generate
 * { provider, prompt, size, quality, apiKey, ... }
 */

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

  const { provider, prompt, size = "1024x1024", quality = "medium", apiKey } = body;
  if (!provider || !prompt || !apiKey) {
    return new Response(JSON.stringify({ error: "provider, prompt, and apiKey are required" }), { status: 400, headers: CORS });
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

    // ── OPENAI IMAGE EDIT (restyle uploaded image) ──────────────────────────────
    if (provider === "openai-edit") {
      const { imageBase64 } = body;
      if (!imageBase64) throw new Error("imageBase64 required for openai-edit");

      // Convert base64 to proper RGBA PNG using canvas-like processing
      // Build a valid PNG from the base64 data
      const byteChars = atob(imageBase64);
      const byteArr   = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const imageBlob = new Blob([byteArr], { type: "image/png" });

      const formData = new FormData();
      formData.append("model",  "gpt-image-2");
      formData.append("image",  imageBlob, "image.png");
      formData.append("prompt", prompt);
      formData.append("n",      "1");
      formData.append("size",   size || "1024x1024");

      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body:    formData,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error("No image data returned from OpenAI edits");
      return new Response(JSON.stringify({ b64, mimeType: "image/png" }), { status: 200, headers: CORS });
    }

    // ── GEMINI IMAGE EDIT (restyle uploaded image) ──────────────────────────────
    if (provider === "gemini-edit") {
      const { imageBase64 } = body;
      if (!imageBase64) throw new Error("imageBase64 required for gemini-edit");

      const models = ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"];
      let lastErr = "";
      for (const model of models) {
        try {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: "image/png", data: imageBase64 } },
                  { text: prompt },
                ],
              }],
              generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
            }),
          });
          const data = await res.json();
          if (data.error) { lastErr = data.error.message; continue; }
          const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
          if (!part) { lastErr = "No image returned"; continue; }
          return new Response(JSON.stringify({ b64: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" }), { status: 200, headers: CORS });
        } catch(e) { lastErr = e.message; }
      }
      throw new Error(lastErr || "All Gemini models failed");
    }

    return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), { status: 400, headers: CORS });

  } catch(e) {
    console.error("[image-generate]", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: "/api/image-generate" };
