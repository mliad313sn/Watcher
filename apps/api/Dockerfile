FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm install --omit=dev --workspace apps/api --workspace packages/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
