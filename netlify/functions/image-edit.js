/**
 * netlify/functions/image-edit.js
 * Background function for AI Restyle (OpenAI/Gemini image edits).
 *
 * These edits can take longer than a normal function's ~10-26s sync timeout —
 * gpt-image-2 in particular reasons before it draws, and that was causing the
 * connection to get cut mid-response, leaving the client with a truncated body
 * ("Unexpected end of JSON input"). Background functions get up to 15 minutes
 * and respond with an empty 202 immediately, so the client polls
 * image-edit-status.js for the result instead of waiting on this response.
 *
 * POST /api/image-edit
 * { jobId, provider: "openai-edit"|"gemini-edit", prompt, apiKey, imageBase64, size, quality }
 * → 202 immediately (body discarded) — result written to the "image-jobs" Blobs store under jobId
 */

import { getStore } from "@netlify/blobs";

export default async (req) => {
  let body;
  try { body = await req.json(); }
  catch { return; } // nothing to report to — client is polling by jobId, so just bail

  const { jobId, provider, prompt, apiKey, imageBase64, size = "1024x1024", quality = "medium" } = body;
  if (!jobId) return;

  const store = getStore("image-jobs");

  try {
    if (!imageBase64) throw new Error(`imageBase64 required for ${provider}`);
    let b64, mimeType = "image/png";

    // ── OPENAI IMAGE EDIT ──────────────────────────────────────────────────
    if (provider === "openai-edit") {
      const byteChars = atob(imageBase64);
      const byteArr   = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const imageBlob = new Blob([byteArr], { type: "image/png" });

      const formData = new FormData();
      formData.append("model",   "gpt-image-2");
      formData.append("image",   imageBlob, "image.png");
      formData.append("prompt",  prompt);
      formData.append("n",       "1");
      formData.append("size",    size);
      formData.append("quality", quality);

      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body:    formData,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error("No image data returned from OpenAI edits");

    // ── GEMINI IMAGE EDIT ──────────────────────────────────────────────────
    } else if (provider === "gemini-edit") {
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
          b64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || "image/png";
          break;
        } catch(e) { lastErr = e.message; }
      }
      if (!b64) throw new Error(lastErr || "All Gemini models failed");

    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    await store.setJSON(jobId, { status: "done", b64, mimeType, completedAt: new Date().toISOString() });
  } catch(e) {
    console.error("[image-edit]", e.message);
    try { await store.setJSON(jobId, { status: "error", error: e.message }); } catch {}
  }
};

export const config = { path: "/api/image-edit", background: true };
