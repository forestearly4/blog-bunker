import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Increase chunk size warning limit
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Split vendor libs into separate chunks.
        // IMPORTANT: react/react-dom must NOT be split into their own chunk here —
        // tiptap consumes React hooks (useCallback, etc.) at module-init time, and
        // separating vendor-react caused Rollup to emit a near-empty chunk with
        // broken load order, producing "useCallback is not defined" crashes.
        // React is left to bundle naturally with whatever pulls it in first.
        manualChunks: {
          "vendor-tiptap": [
            "@tiptap/react",
            "@tiptap/starter-kit",
            "@tiptap/extension-link",
            "@tiptap/extension-placeholder",
            "@tiptap/extension-underline",
          ],
        },
      },
    },
  },
  // Increase memory for dev server
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
  server: {
    fs: { strict: false },
  },
});
