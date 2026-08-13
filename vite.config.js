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
    // NOTE: deliberately no manual chunk splitting (rollupOptions.output.manualChunks).
    // Hand-curated chunk splitting here has caused the SAME "useCallback is not
    // defined" crash twice — React (or a dependency needing React hooks at
    // module-init time, like tiptap) ending up in a separate chunk with broken
    // load order relative to whatever consumes it, as new components were added
    // over time and Rollup split things differently than when the config was
    // last hand-tuned. Letting Rollup's own automatic, dependency-graph-aware
    // chunking handle this is the robust fix — it exists specifically to avoid
    // this class of ordering bug, unlike a hand-rolled partial config that can
    // silently go stale as the app grows.
  },
  // Increase memory for dev server
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
  server: {
    fs: { strict: false },
  },
});
