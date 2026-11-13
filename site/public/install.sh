#!/bin/sh
# Installs Hotsauce on a Linux server with Docker, and prints the setup link.
# Guide: https://hotsauce.work/install.md   Source: https://github.com/hotsauce-suite/hotsauce
#
#   curl -fsSL https://hotsauce.work/install.sh | sh
#   curl -fsSL https://hotsauce.work/install.sh | HOTSAUCE_DOMAIN=hotsauce.acme.com sh
#
# HOTSAUCE_DOMAIN  a domain whose DNS points at this server: adds Caddy in front for HTTPS
#                  (ports 80 and 443 must be open). Without it the server listens on port 3000.
# HOTSAUCE_URL     the address people open, when it isn't https://<domain> or http://<this server>:3000
# HOTSAUCE_DIR     where its files go (default /opt/hotsauce)
# HOTSAUCE_IMAGE   the image to run (default the newest release)
#
# Safe to run again: it pulls the newest release and keeps the data, which lives in the Docker
# volume hotsauce_hotsauce-data. The server makes and keeps its own encryption key on that volume,
# so this script never handles a secret.
set -eu

dir="${HOTSAUCE_DIR:-/opt/hotsauce}"
domain="${HOTSAUCE_DOMAIN:-}"
image="${HOTSAUCE_IMAGE:-ghcr.io/hotsauce-suite/hotsauce:latest}"
wait_secs="${HOTSAUCE_WAIT:-180}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'hotsauce: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 ||
  fail "Docker isn't installed. Install it first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 ||
  fail "The Docker Compose plugin isn't installed: https://docs.docker.com/compose/install/linux/"
docker info >/dev/null 2>&1 ||
  fail "Can't reach Docker. Start it, or run this as a user in the docker group (or with sudo)."
command -v curl >/dev/null 2>&1 || fail "curl isn't installed."

case "$domain" in
  *[!A-Za-z0-9.-]* | .* | *.) fail "HOTSAUCE_DOMAIN should be a plain name like hotsauce.acme.com" ;;
esac

if [ -n "${HOTSAUCE_URL:-}" ]; then
  url="${HOTSAUCE_URL%/}"
elif [ -n "$domain" ]; then
  url="https://$domain"
else
  ip="$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)"
  url="http://${ip:-localhost}:3000"
fi

if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
  fail "Can't write to $dir. Run it with sudo (… | sudo sh), or set HOTSAUCE_DIR to a folder you own."
fi

say "Installing Hotsauce in $dir for $url"

# Compose reads .env for the values below. Rewritten on every run, and it holds no secrets.
cat >"$dir/.env" <<EOF
HOTSAUCE_IMAGE=$image
PUBLIC_URL=$url
HOTSAUCE_DOMAIN=$domain
EOF

if [ -n "$domain" ]; then
  # Caddy gets the certificate and passes WebSockets through; the server is only reachable via it.
  ports='      - "127.0.0.1:3000:3000"'
  # shellcheck disable=SC2016 # ${HOTSAUCE_DOMAIN} is for Compose to fill in from .env.
  caddy='
  caddy:
    image: caddy:2
    restart: unless-stopped
    command: caddy reverse-proxy --from ${HOTSAUCE_DOMAIN} --to hotsauce:3000
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - caddy-data:/data
    depends_on:
      - hotsauce'
  caddy_volume='
  caddy-data:'
else
  ports='      - "3000:3000"'
  caddy=''
  caddy_volume=''
fi

cat >"$dir/compose.yml" <<EOF
# Written by https://hotsauce.work/install.sh; running it again rewrites this file.
name: hotsauce

services:
  hotsauce:
    image: \${HOTSAUCE_IMAGE}
    restart: unless-stopped
    ports:
$ports
    environment:
      PUBLIC_URL: \${PUBLIC_URL}
    volumes:
      - hotsauce-data:/data
$caddy

volumes:
  hotsauce-data:$caddy_volume
EOF

compose() { docker compose --project-directory "$dir" -f "$dir/compose.yml" "$@"; }

compose pull --quiet
compose up -d --remove-orphans

say "Waiting for the server to start…"
health=''
waited=0
while [ "$waited" -lt "$wait_secs" ]; do
  health="$(curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  case "$health" in *'"ok":true'*) break ;; esac
  health=''
  sleep 3
  waited=$((waited + 3))
done
[ -n "$health" ] ||
  fail "The server didn't answer within ${wait_secs}s. See: docker compose -f $dir/compose.yml logs hotsauce"

version="$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
say "Hotsauce ${version:-} is running at $url"

case "$health" in
  *'"setupRequired":false'*)
    say "It's already set up. Open $url and sign in."
    exit 0
    ;;
esac

link="$(compose logs hotsauce 2>/dev/null | grep -o 'https\{0,1\}://[^ ]*/setup#token=[A-Za-z0-9_-]*' | tail -n 1 || true)"
say ""
if [ -n "$link" ]; then
  say "Open this link to set it up (it works once):"
  say ""
  say "  $link"
else
  say "Find the setup link with: docker compose -f $dir/compose.yml logs hotsauce | grep setup"
fi
if [ -z "$domain" ]; then
  say ""
  say "Before your team uses it, put it behind HTTPS: run this again with HOTSAUCE_DOMAIN=<your domain>."
fi
