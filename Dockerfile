# SPDX-License-Identifier: AGPL-3.0-only
# Image shared by the app and worker processes.
# Debian bookworm's git is 2.39, which meets the >= 2.38 requirement in ARCHITECTURE.md.

FROM node:24-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @oxybook/github --filter @oxybook/db --filter @oxybook/jobs build && pnpm --filter @oxybook/server --filter @oxybook/worker build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && git --version
WORKDIR /app
COPY --from=build /src /app
COPY deploy/oxybook /usr/local/bin/oxybook
RUN chmod 755 /usr/local/bin/oxybook \
  && chown -R node:node /app
USER node
# Compose supplies the command: ["oxybook", "server"] or ["oxybook", "worker"].
