import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import fs from "node:fs";
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

// index.html pulls the display font from Fontshare's API, which hands every visitor's IP address to a third
// party. That is fine for an app only its owner opens and wrong for a public demo, so the demo build serves the
// font itself. The font's licence (ITF Free Font License) allows self-hosting and forbids redistribution, so the
// files cannot be committed to a public repository: they are downloaded here, at build time, straight into the
// build output. If Fontshare cannot be reached the link is dropped and headings fall back to the system font,
// rather than shipping the third-party request this exists to remove.
function selfHostedDisplayFont(enabled: boolean): Plugin {
  const LINK = /[ \t]*<link href="(https:\/\/api\.fontshare\.com\/[^"]+)" rel="stylesheet">\r?\n/;
  const STYLESHEET = "fonts/display.css";
  const assets = new Map<string, string | Uint8Array>();
  let base = "/";
  let root = process.cwd();
  return {
    name: "kumbara-self-hosted-display-font",
    apply: "build",
    configResolved(config) {
      base = config.base;
      root = config.root;
    },
    async buildStart() {
      if (!enabled) return;
      const link = LINK.exec(fs.readFileSync(path.resolve(root, "index.html"), "utf8"));
      if (!link) throw new Error("index.html no longer links the Fontshare stylesheet; update selfHostedDisplayFont");
      const href = link[1];
      const wanted = new Set([...href.matchAll(/f\[\]=([a-z0-9-]+)/g)].map((match) => match[1]));
      try {
        const css = await (await fetch(href)).text();
        const faces: string[] = [];
        for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
          const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
          const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
          const source = /url\('([^']+\.woff2)'\)/.exec(block)?.[1];
          if (!family || !weight || !source) continue;
          const slug = family.toLowerCase().replace(/\s+/g, "-");
          if (!wanted.has(slug)) continue;
          const response = await fetch(source.startsWith("//") ? `https:${source}` : source);
          if (!response.ok) throw new Error(`${response.status} for ${slug} ${weight}`);
          const file = `${slug}-${weight}.woff2`;
          assets.set(`fonts/${file}`, new Uint8Array(await response.arrayBuffer()));
          faces.push(
            `@font-face{font-family:'${family}';src:url('${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap}`,
          );
        }
        if (faces.length === 0) throw new Error("no font faces found");
        assets.set(STYLESHEET, `${faces.join("\n")}\n`);
      } catch (cause) {
        assets.clear();
        this.warn(`Could not fetch the display font, headings will use the system font: ${String(cause)}`);
      }
    },
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: "asset", fileName, source });
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (!enabled) return;
        const local = assets.has(STYLESHEET) ? `    <link href="${base}${STYLESHEET}" rel="stylesheet">\n` : "";
        return html.replace(LINK, local);
      },
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
    selfHostedDisplayFont(process.env.VITE_DEMO === "1"),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "127.0.0.1", // local-only by default (R0)
  },
});
