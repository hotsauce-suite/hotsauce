#!/usr/bin/env bash
# Deploys a new Hotsauce to Fly.io and prints its setup link.
#
#   scripts/deploy-fly.sh <app-name> [region]      e.g. scripts/deploy-fly.sh acme-office ewr
#   PUBLIC_URL=https://hotsauce.acme.com scripts/deploy-fly.sh acme-office    (recommended address)
#
# Needs flyctl, signed in (`fly auth login`). Creates the app, a 3 GB volume and three
# generated secrets (the key that encrypts saved API keys, and the push notification keys),
# then deploys. Run it from the repository root. Safe to run again: it skips what exists.
set -euo pipefail

app="${1:?usage: scripts/deploy-fly.sh <app-name> [region]}"
region="${2:-ewr}"
url="${PUBLIC_URL:-https://${app}.fly.dev}"
config="fly.${app}.toml"

command -v fly >/dev/null || { echo "Install flyctl first: https://fly.io/docs/flyctl/install/" >&2; exit 1; }

sed -e "s|APP_NAME|${app}|" -e "s|REGION|${region}|" -e "s|PUBLIC_URL_VALUE|${url}|" \
  deploy/fly.example.toml > "$config"
echo "Wrote $config"

if ! fly status --app "$app" >/dev/null 2>&1; then
  fly apps create "$app"
fi
if ! fly volumes list --app "$app" 2>/dev/null | grep -q hotsauce_data; then
  fly volumes create hotsauce_data --app "$app" --region "$region" --size 3 --yes
fi

if ! fly secrets list --app "$app" 2>/dev/null | grep -q HOTSAUCE_MASTER_KEY; then
  master="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  vapid="$(cd apps/server && node -e "const k=require('web-push').generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")"
  fly secrets set --app "$app" --stage \
    "HOTSAUCE_MASTER_KEY=${master}" \
    "VAPID_PUBLIC_KEY=${vapid%% *}" \
    "VAPID_PRIVATE_KEY=${vapid##* }" >/dev/null
  echo "Set HOTSAUCE_MASTER_KEY and push notification keys as Fly secrets."
fi

fly deploy --config "$config" --app "$app"

# Your company's address (PUBLIC_URL=https://hotsauce.acme.com): Fly issues its certificate once
# the DNS record points at the app.
host="${url#https://}"; host="${host%%/*}"
if [[ "$host" != *.fly.dev ]]; then
  fly certs add "$host" --app "$app" >/dev/null 2>&1 || true
  echo
  echo "Add this DNS record at your DNS provider: CNAME ${host%%.*} → ${app}.fly.dev"
  echo "(if your DNS is on Cloudflare, set it to DNS only, the grey cloud)."
fi

echo
echo "Deployed to ${url}. The setup link:"
fly logs --app "$app" --no-tail 2>/dev/null | grep -o "${url}/setup#token=[A-Za-z0-9_-]*" | tail -1 \
  || echo "  (not in the log yet: run  fly logs --app ${app} | grep setup)"
