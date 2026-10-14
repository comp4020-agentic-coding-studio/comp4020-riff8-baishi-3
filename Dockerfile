# syntax = docker/dockerfile:1

# Node version pinned to match mise.toml. better-sqlite3@13 ships a
# prebuilt N-API binary for linux-x64 directly in the package (no
# node-gyp, no prebuild-install network fetch, no install/postinstall
# script at all — confirmed by inspecting the installed package) and
# N-API is ABI-stable across Node versions, so there's no native
# toolchain this image ever needs.
FROM node:24.21.0-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY README.md ./README.md

ENV HOST=0.0.0.0
ENV DB_PATH=/data/hollowfield.db
EXPOSE 8080
CMD ["node", "./dist/server/entry.mjs"]
