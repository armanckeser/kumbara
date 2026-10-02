import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "path";

// The public demo is the only build strangers land on, so it is the only one that gets a pitch: a title and
// description that say what Kumbara is, a canonical URL, and the Open Graph / Twitter tags a link preview is
// drawn from. Those need absolute URLs and only the deployment knows its own address, so the Pages workflow
// passes it as VITE_SITE_URL. Unset (dev, a self-hosted build) this does nothing: the installed app keeps its
// plain "Kumbara" tab title, and a private instance never advertises itself with someone else's host.
const SHARE_TITLE = "Kumbara: self-hosted budgeting built for your phone";
const SHARE_DESCRIPTION =
  "Self-hosted budgeting built for your phone: triage transactions by merchant, track stock plans and paychecks. Try the demo with a fake household, in your browser.";

function sharePreview(siteUrl: string | undefined): Plugin {
  return {
    name: "kumbara-share-preview",
    transformIndexHtml(html) {
      if (!siteUrl) return;
      const site = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
      const image = `${site}og.jpg`;
      const meta = (key: "property" | "name", id: string, content: string): HtmlTagDescriptor => ({
        tag: "meta",
        attrs: { [key]: id, content },
        injectTo: "head",
      });
      const pitched = html
        .replace(/<title>[^<]*<\/title>/, `<title>${SHARE_TITLE}</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${SHARE_DESCRIPTION}$2`);
      if (!pitched.includes(SHARE_TITLE) || !pitched.includes(SHARE_DESCRIPTION)) {
        throw new Error("index.html needs a <title> and a meta description for the share preview to replace");
      }
      return {
        html: pitched,
        tags: [
          { tag: "link", attrs: { rel: "canonical", href: site }, injectTo: "head" },
          meta("property", "og:type", "website"),
          meta("property", "og:site_name", "Kumbara"),
          meta("property", "og:title", SHARE_TITLE),
          meta("property", "og:description", SHARE_DESCRIPTION),
          meta("property", "og:url", site),
          meta("property", "og:image", image),
          meta("property", "og:image:width", "1200"),
          meta("property", "og:image:height", "600"),
          meta("property", "og:image:alt", "Kumbara: your bank feed, sorted. A phone showing the inbox, where one answer settles every charge from a merchant."),
          meta("name", "twitter:card", "summary_large_image"),
          meta("name", "twitter:title", SHARE_TITLE),
          meta("name", "twitter:description", SHARE_DESCRIPTION),
          meta("name", "twitter:image", image),
        ],
      };
    },
  };
}

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
    sharePreview(process.env.VITE_SITE_URL),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "127.0.0.1", // local-only by default (R0)
  },
});
