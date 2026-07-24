# Pinned base for reproducibility (issue #7).
FROM node:22.12-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/poller/package.json apps/poller/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

RUN npm ci --omit=dev

COPY packages/shared packages/shared
COPY apps/poller apps/poller

# Drop root (issue #7). Note: ICMP discovery uses the system `ping` binary,
# which is setuid on the base image, so it still works as a non-root user.
USER node

CMD ["node", "apps/poller/src/index.js"]
