# Kumbara's image: the built web app AND the live API on one port (SERVE_WEB=1), so an install is Postgres +
# Electric + this, and web, API and Electric shapes share one origin behind any reverse proxy. Built for
# linux/amd64 and linux/arm64 by .github/workflows/release.yml.
#
# ⚠️  This runs the LIVE server (index.prod.ts: real SimpleFIN sources + scheduled sync, R9). The agent MAY
#     build/run it locally against a synthetic DB to verify — R9 forbids binding a real SimpleFIN token or
#     reading the deployed prod URL, not building. ⚠️
#
# Build context is the `app/` workspace root: deps hoist to app/node_modules and `effect` must resolve to ONE
# instance or Schema breaks across the server/domain boundary. The server is esbuild-bundled to plain JS
# (build.mjs), so the container boots with `node`, not `tsx` (~16s → well under a second).

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json ./server/package.json
RUN npm ci
COPY . .
# Empty: the web app calls /api on its own origin.
ENV VITE_API_URL=""
RUN npm run build && npm --prefix server run build

FROM node:24-alpine
WORKDIR /app
# Production dependencies of the server member only, at the workspace root so the bundle and the external
# @effect/* packages resolve the one hoisted `effect`.
COPY package*.json ./
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app

USER node
WORKDIR /app/server
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SERVE_WEB=1 \
    WEB_ROOT=../dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# boot.js: wait for Postgres, migrate, create the instance secrets, then the live server. node directly (not
# npm) so SIGTERM reaches it.
CMD ["node", "--enable-source-maps", "dist/boot.js"]

LABEL org.opencontainers.image.title="Kumbara" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
