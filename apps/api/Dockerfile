# Pinned base for reproducibility (issue #7).
FROM node:22.12-alpine

WORKDIR /app

# npm ci needs the lockfile plus every workspace manifest referenced by the
# root "workspaces" globs, or it refuses to install. Copy manifests first so
# the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/poller/package.json apps/poller/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

# Reproducible install straight from the lockfile (no drift), prod deps only.
RUN npm ci --omit=dev

COPY packages/shared packages/shared
COPY apps/api apps/api

# Drop root — the API never needs it (issue #7).
USER node

EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
