/**
 * netlify/functions/get-image.js
 * Serves an image stored via upload-image.js as a real public URL.
 * This is what makes Instagram (and anything else needing a fetchable
 * image URL) able to actually retrieve the generated image.
 *
 * GET /api/get-image?id=img_xxx
 */

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const id  = url.searchParams.get("id");

  if (!id) {
    return new Response("Missing id parameter", { status: 400 });
  }

  try {
    const store = getStore("blog-bunker-images");
    const result = await store.getWithMetadata(id, { type: "arrayBuffer" });

    if (!result) {
      return new Response("Image not found", { status: 404 });
    }

    const mimeType = result.metadata?.mimeType || "image/png";
    return new Response(result.data, {
      status: 200,
      headers: {
        "Content-Type":  mimeType,
        "Cache-Control": "public, max-age=86400",
      },
    });

  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

export const config = { path: "/api/get-image" };
