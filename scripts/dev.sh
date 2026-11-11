#!/usr/bin/env bash
# Local development: starts Forgejo (for the Forgejo host adapter) when Docker
# is running, then the server and web app with `pnpm dev`. Forgejo is optional;
# the default HOST_KIND=local needs nothing but git.
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Starting Forgejo on http://localhost:3300"
  docker compose up -d --wait forgejo
  if [ ! -f .data/forgejo-token ]; then
    scripts/forgejo-init.sh
  fi
else
  echo "Docker isn't running, so Forgejo is skipped. HOST_KIND=local works without it."
fi

exec pnpm dev
