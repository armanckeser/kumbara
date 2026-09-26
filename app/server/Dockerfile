# API image — runs the LIVE server (index.prod.ts: real SimpleFIN sources + scheduled sync, R9).
#
# ⚠️  On the Pi this image binds the REAL feed. The agent MAY build/run it locally against a synthetic DB
#     to verify — R9 forbids binding a real SimpleFIN token or reading the deployed prod URL, not building. ⚠️
#
# Build context is the `app/` workspace root (compose sets `context: .`), NOT server/, because this is an
# npm workspace: deps hoist to app/node_modules and `effect` must resolve to ONE instance or Schema breaks
# across the server/domain boundary.
#
# Multi-stage: the BUILD stage esbuild-bundles our own source (server/** + domain/**) to plain JS; the
# RUNTIME stage runs it with `node`, not `tsx`. tsx transpiled the whole tree on every boot (~16s cold
# start); precompiling moves that to build time so the container starts in well under a second.

# ---------- build stage: bundle server + migrate to dist/ ----------
FROM node:24-alpine AS build
WORKDIR /app

# Full workspace install (incl. devDeps: esbuild) so the bundle can be built. `npm ci` uses the committed
# lockfile for a reproducible tree and dedupes effect to one instance.
COPY package*.json ./
COPY server/package.json ./server/package.json
RUN npm ci

# Copy the source the bundler needs: the server tree (entrypoints, features, migrations, seed) and the
# shared domain (imported across the boundary via relative paths). esbuild follows the imports.
COPY server ./server
COPY domain ./domain

# Emits server/dist/{index.prod.js,migrate.js} (+ sourcemaps) and copies the normalization seed/ next to
# the bundle (read at boot via import.meta.dirname/seed).
RUN npm --prefix server run build

# ---------- runtime stage: node on the bundle, prod deps only ----------
FROM node:24-alpine
WORKDIR /app

# Reproduce the workspace layout so the hoist resolves effect (and every external dep the bundle imports)
# to ONE node_modules. --omit=dev drops tsx/esbuild/vitest but keeps pg/web-push/effect/@effect/*/hono/
# yaml/dotenv (all regular dependencies of the server member).
COPY package*.json ./
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev

# The precompiled bundle + its seed assets. Nothing else from source is needed at runtime.
COPY --from=build /app/server/dist ./server/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000
EXPOSE 4000

# Apply pending migrations (idempotent; bootstraps a fresh DB incl. agent_reader) then start the live
# server — both now plain `node` on the precompiled bundle. --enable-source-maps keeps stack traces
# pointing at the .ts source via the shipped .map files.
CMD ["sh", "-c", "node --enable-source-maps server/dist/migrate.js && node --enable-source-maps server/dist/index.prod.js"]
