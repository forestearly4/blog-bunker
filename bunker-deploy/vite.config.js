import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // netlify-identity-widget references global in some paths
    global: "globalThis",
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
