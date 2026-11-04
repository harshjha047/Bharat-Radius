# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Every workspace manifest, so the frozen lockfile matches the workspace exactly.
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/
COPY packages/radius-client/package.json packages/radius-client/
COPY packages/shared/package.json packages/shared/
COPY packages/db-mongo/package.json packages/db-mongo/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/radius-client packages/radius-client
COPY packages/shared packages/shared
COPY packages/db-mongo packages/db-mongo
COPY apps/workers apps/workers
RUN pnpm --filter "@isp/workers..." build \
 && pnpm --filter @isp/workers deploy --legacy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 4101
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:4101/healthz || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
