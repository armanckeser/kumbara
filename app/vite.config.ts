import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "path";

export default defineConfig({
  // Static hosts that serve under a subpath (e.g. GitHub Pages project sites at /<repo>/) need the asset
  // base set at build time; Cloudflare Pages / Netlify / the real nginx prod path all serve at root, so the
  // default "/" keeps them unchanged. Set VITE_BASE=/kumbara/ only for a subpath deploy. The app reads the
  // resolved value back via import.meta.env.BASE_URL (see the router basepath in main.tsx).
  base: process.env.VITE_BASE ?? "/",
  plugins: [
    TanStackRouterVite({ autoCodeSplitting: true, target: "react" }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "127.0.0.1", // local-only by default (R0)
  },
});
