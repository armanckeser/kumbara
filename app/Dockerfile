# Frontend image: build the SPA, serve it with nginx (which also proxies /api → the api container).
#
# Same house pattern as hearth/uscis-tracker. The build context is the `app/` workspace root because this
# is an npm workspace — deps hoist to app/node_modules and `effect` must resolve to ONE instance or Schema
# breaks across the server/domain boundary, so we install from the root before `vite build`.
#
# VITE_API_URL is left empty → the app calls relative /api and /api/electric, which nginx proxies to the
# api container (same origin, so no CORS and Electric's shapes ride the one connection Cosmos gives it).

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json ./server/package.json
RUN npm install
COPY . .
ENV VITE_API_URL=""
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
