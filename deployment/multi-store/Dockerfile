FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN npm run build --workspace @pos/contracts && npm run build --workspace @pos/api && npm run build --workspace @pos/web
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000 SERVE_WEB=true MULTI_STORE_HUB=true
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY apps/api/data/license-public-key.pem apps/api/data/license-public-key.pem
COPY database/migrations database/migrations
COPY deployment/multi-store/hub-entry.mjs deployment/multi-store/hub-entry.mjs
USER node
EXPOSE 4000
CMD ["node","deployment/multi-store/hub-entry.mjs"]
