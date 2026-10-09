import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// LeoMox frontend build config.
// In production the Express server serves the built /dist folder directly,
// so the client uses relative "/api/..." paths (see src/services/api.js).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // During local dev, vite proxies API calls to the Express server on :10000
      "/api": {
        target: "http://localhost:10000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:10000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
