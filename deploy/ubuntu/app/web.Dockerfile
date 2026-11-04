# syntax=docker/dockerfile:1
# Build context: repository root. Next.js standalone server (admin panel); /api/* is routed to isp-api by Caddy.
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Every workspace manifest, so the frozen lockfile matches the workspace exactly.
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/workers/package.json apps/workers/
COPY packages/radius-client/package.json packages/radius-client/
COPY packages/shared/package.json packages/shared/
COPY packages/db-mongo/package.json packages/db-mongo/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @isp/web
COPY apps/web apps/web
RUN pnpm --filter @isp/web build

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /src/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/livez || exit 1
CMD ["node", "apps/web/server.js"]
