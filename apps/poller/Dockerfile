FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/poller/package.json apps/poller/
COPY packages/shared/package.json packages/shared/
RUN npm install --omit=dev --workspace apps/poller --workspace packages/shared
COPY packages/shared packages/shared
COPY apps/poller apps/poller
CMD ["node", "apps/poller/src/index.js"]
