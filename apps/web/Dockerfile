# Multi-stage: build the static bundle with Node, then serve it with nginx.
# The runtime image carries no Node or source — just the built assets behind a
# tiny static server that also reverse-proxies the API and WebSocket, so the
# whole product is reachable from one origin (issue: functional deployment).

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22.12-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer caches independently of source.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/poller/package.json apps/poller/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN npm ci

COPY packages packages
COPY apps/web apps/web
RUN npm run build --workspace apps/web

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
