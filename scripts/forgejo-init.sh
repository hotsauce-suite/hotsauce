#!/usr/bin/env bash
# Starts the dev/test Forgejo (docker-compose.yml), creates an admin user if missing, mints a new
# API token, and writes it to .data/forgejo-token. Safe to re-run; each run mints a fresh token.
#
#   scripts/forgejo-init.sh
#   export FORGEJO_URL=http://localhost:3300 FORGEJO_TOKEN="$(cat .data/forgejo-token)"
set -euo pipefail

cd "$(dirname "$0")/.."

FORGEJO_URL="${FORGEJO_URL:-http://localhost:3300}"
ADMIN_USER="${FORGEJO_ADMIN_USER:-hearth-admin}"
# Dev-only container on localhost; not a secret.
ADMIN_PASSWORD="${FORGEJO_ADMIN_PASSWORD:-hearth-admin-password}"
ADMIN_EMAIL="${FORGEJO_ADMIN_EMAIL:-hearth-admin@localhost.test}"
TOKEN_FILE=".data/forgejo-token"

# The forgejo CLI refuses to run as root; the container's service user is `git`.
forgejo_cli() {
  docker compose exec -T -u git forgejo forgejo "$@"
}

docker compose up -d forgejo

printf 'Waiting for Forgejo at %s ' "$FORGEJO_URL"
for _ in $(seq 1 90); do
  if curl -fsS "$FORGEJO_URL/api/healthz" >/dev/null 2>&1; then
    break
  fi
  printf '.'
  sleep 1
done
if ! curl -fsS "$FORGEJO_URL/api/healthz" >/dev/null 2>&1; then
  echo
  echo "Forgejo did not become healthy; see: docker compose logs forgejo" >&2
  exit 1
fi
echo ' up'

if forgejo_cli admin user list --admin | awk 'NR > 1 { print $2 }' | grep -qx "$ADMIN_USER"; then
  echo "Admin user $ADMIN_USER already exists"
else
  forgejo_cli admin user create --admin \
    --username "$ADMIN_USER" \
    --password "$ADMIN_PASSWORD" \
    --email "$ADMIN_EMAIL" \
    --must-change-password=false
fi

TOKEN="$(forgejo_cli admin user generate-access-token \
  --username "$ADMIN_USER" \
  --token-name "hearth-$(date +%Y%m%d%H%M%S)-$$" \
  --scopes all \
  --raw | tr -d '[:space:]')"
if [ -z "$TOKEN" ]; then
  echo "Token generation returned nothing" >&2
  exit 1
fi

mkdir -p "$(dirname "$TOKEN_FILE")"
(umask 077 && printf '%s\n' "$TOKEN" >"$TOKEN_FILE")
echo "Wrote $TOKEN_FILE"
echo "Run Forgejo tests with:"
echo "  FORGEJO_URL=$FORGEJO_URL FORGEJO_TOKEN=\"\$(cat $TOKEN_FILE)\" pnpm --filter @hearth/server exec vitest run --config vitest.integration.config.ts"
