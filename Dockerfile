# syntax=docker/dockerfile:1

# Hearth: one container serving the API, WebSockets, and the built web app.
# Stages: base → deps (pnpm fetch + offline install) → build → runtime.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm's version comes from "packageManager" in package.json.
RUN corepack enable
WORKDIR /repo


FROM base AS deps
# Compilers for native modules (better-sqlite3) when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# Fetch from the lockfile alone, so this layer is reused until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline


FROM deps AS build
# Vite inlines VITE_* variables at build time; .env.local never reaches the image,
# so the Clerk publishable key (public by design) comes in as a build arg from fly.toml.
ARG VITE_CLERK_PUBLISHABLE_KEY
# Packages without a build script are skipped; pnpm builds in dependency order.
RUN pnpm --filter @hearth/format --filter @hearth/web --filter @hearth/server run build
# The Chrome extension, built for any server: the server writes its own address and name into
# the zip it offers at /downloads/ (apps/server/src/extension), so one image serves everyone.
# The zip copied here is the unstamped fallback.
RUN pnpm --filter @hearth/extension run build \
 && mkdir -p apps/web/dist/downloads \
 && cp apps/extension/release/hearth-meetings-chrome.zip apps/web/dist/downloads/
# The Mac app can't be built on Linux: scripts/build-app.sh builds it on a Mac and the zip is
# committed, so this copies them as they are (Dictate → Download for Mac).
# A checkout without the built app (the public repository) simply offers no download.
# Hotsauce.dmg and .zip, also under their old names (Hearth.*, HearthDictate.*) so links already
# shared work.
RUN for ext in dmg zip; do \
      if [ -f "apps/dictate-mac/release/Hotsauce.$ext" ]; then \
        cp "apps/dictate-mac/release/Hotsauce.$ext" apps/web/dist/downloads/ \
        && cp "apps/dictate-mac/release/Hotsauce.$ext" "apps/web/dist/downloads/Hearth.$ext" \
        && cp "apps/dictate-mac/release/Hotsauce.$ext" "apps/web/dist/downloads/HearthDictate.$ext"; \
      fi; \
    done
# The server's production dependencies, with workspace packages copied in, not
# linked. pnpm 10's deploy reads the shared lockfile only when workspace
# packages are injected; setting that here alone leaves dev symlinks alone.
RUN pnpm --config.inject-workspace-packages=true --filter @hearth/server \
    deploy --prod --offline /prod/server


FROM node:22-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
# Same relative layout as the repo, so the server finds apps/web/dist either
# relative to its own file or to the working directory.
COPY --from=build /prod/server/package.json apps/server/package.json
COPY --from=build /prod/server/node_modules apps/server/node_modules
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY --from=build /repo/apps/extension/dist apps/extension/dist
# The release this image is, reported by /api/health and compared with newer releases.
COPY HOTSAUCE_VERSION ./HOTSAUCE_VERSION
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/hearth-entrypoint
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The entrypoint starts as root only to hand /data to the `node` user, then
# runs the server as `node` (see scripts/docker-entrypoint.sh).
ENTRYPOINT ["hearth-entrypoint"]
CMD ["node", "apps/server/dist/main.js"]
