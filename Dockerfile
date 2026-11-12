# syntax=docker/dockerfile:1
# Relay app image (see compose.yaml).

FROM node:22-bookworm-slim AS base
RUN npm install -g pnpm@12.16.1
WORKDIR /app

# Native modules (better-sqlite3, node-pty) may need compiling.
FROM base AS toolchain
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM toolchain AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client socat ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/server/src/db/migrations apps/server/src/db/migrations
# Reuses the deps stage's install (native modules already compiled) instead of downloading it all again.
# From `deps`, not `build`: this layer must stay cached when only the source changes.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY editions editions
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    DASHBOARD_HOST=127.0.0.1 \
    DASHBOARD_PORT=3000 \
    WEBHOOK_HOST=0.0.0.0 \
    WEBHOOK_PORT=3001

RUN mkdir -p /app/data /home/node/.relay && chown -R node:node /app/data /home/node
USER node
WORKDIR /app/apps/server
ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]
