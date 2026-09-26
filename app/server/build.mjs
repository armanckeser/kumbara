// Precompile the server for production: esbuild-bundle our OWN source (server/** + ../domain/**) into
// plain JS so the container boots with `node`, not `tsx`. tsx transpiles the whole tree on every start
// (~16s cold start); this moves that work to image-build time.
//
// Strategy: --packages=external. Bundle only our code; keep every node_modules dep external (resolved by
// Node at runtime from the image's node_modules). This (a) is all that's needed for boot speed — the cost
// was transpiling OUR ts, not loading deps; (b) sidesteps the `pg` "Dynamic require of \"events\"" crash
// that bundling CJS deps into ESM triggers; (c) preserves the single-`effect`-instance rule (R7) — our
// bundle and the external @effect/* packages all resolve the one hoisted node_modules/effect.
//
// Both entrypoints are bundled: index.prod.ts (the server) and migrate.ts (runs at container boot too, so
// it can't stay a tsx-only command against an --omit=dev image).

import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(serverDir, "dist");

// Emitted ESM references `require`/__dirname/__filename (our seed loader uses import.meta.dirname, and
// externalized CJS deps expect a real `require`). Define them at the top of the bundle. Without this,
// bundled-CJS code crashes with "require is not defined" / "__dirname is not defined".
const banner = {
  js: [
    'import { createRequire as topLevelCreateRequire } from "node:module";',
    'import { fileURLToPath as topLevelFileURLToPath } from "node:url";',
    'import { dirname as topLevelDirname } from "node:path";',
    "const require = topLevelCreateRequire(import.meta.url);",
    "const __filename = topLevelFileURLToPath(import.meta.url);",
    "const __dirname = topLevelDirname(__filename);",
  ].join("\n"),
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
  banner,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [join(serverDir, "index.prod.ts")],
  outfile: join(outDir, "index.prod.js"),
});

await build({
  ...common,
  entryPoints: [join(serverDir, "migrate.ts")],
  outfile: join(outDir, "migrate.js"),
});

// The normalization seed assets (7 yaml + 1 jsonl) are read at LAYER CONSTRUCTION on every boot via
// path.join(import.meta.dirname, "seed") in seed-loader.ts. esbuild does not trace/copy them (no static
// import), so ship them next to the bundle: import.meta.dirname of dist/index.prod.js is dist/, so the
// loader looks for dist/seed/*. Copy them there.
const seedSource = join(serverDir, "features", "normalization", "seed");
const seedDest = join(outDir, "seed");
mkdirSync(seedDest, { recursive: true });
cpSync(seedSource, seedDest, { recursive: true });

console.log(`\nBundled to ${outDir} (index.prod.js, migrate.js) + copied seed/ -> dist/seed/`);
