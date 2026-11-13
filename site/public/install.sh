#!/bin/sh
# Installs Hotsauce on a Linux server with Docker, and prints the setup link.
# Guide: https://hotsauce.work/install.md   Source: https://github.com/hotsauce-suite/hotsauce
#
#   curl -fsSL https://hotsauce.work/install.sh | sudo sh
#   curl -fsSL https://hotsauce.work/install.sh | sudo HOTSAUCE_DOMAIN=hotsauce.acme.com sh
#
# Settings go after sudo (sudo drops the ones written before it):
# HOTSAUCE_DOMAIN  a domain whose DNS points at this server: adds Caddy in front for HTTPS
#                  (ports 80 and 443 must be open). Without it the server listens on port 3000.
#                  `none` removes a domain set by an earlier run.
# HOTSAUCE_URL     the address people open, when it isn't https://<domain> or
#                  http://<this server>:3000 (`none` removes it)
# HOTSAUCE_DIR     where its files go (default /opt/hotsauce)
# HOTSAUCE_IMAGE   the image to run (default the newest release)
#
# Run it again with no settings to update: it pulls the newest release, keeps the last run's
# settings and keeps the data, which lives in the Docker volume hotsauce_hotsauce-data. The server
# makes and keeps its own encryption key on that volume, so this script never handles a secret.
set -eu

say() { printf '%s\n' "$*"; }
fail() {
  printf 'hotsauce: %s\n' "$*" >&2
  exit 1
}

# A setting from the last run's .env (read as text, never run).
prev() { sed -n "s/^$1=//p" "$dir/.env" 2>/dev/null | tail -n 1; }

compose() { docker compose --project-directory "$dir" -f "$dir/compose.yml" "$@"; }

# The whole script is one function, called on the last line, so a download cut short runs nothing.
main() {
  dir="${HOTSAUCE_DIR:-/opt/hotsauce}"
  wait_secs="${HOTSAUCE_WAIT:-180}"

  # A setting not given now keeps its value from the last run, so updating never drops the domain.
  domain="${HOTSAUCE_DOMAIN:-$(prev HOTSAUCE_DOMAIN)}"
  if [ "$domain" = none ]; then domain=''; fi
  custom_url="${HOTSAUCE_URL:-$(prev HOTSAUCE_URL)}"
  if [ "$custom_url" = none ]; then custom_url=''; fi
  image="${HOTSAUCE_IMAGE:-$(prev HOTSAUCE_IMAGE)}"
  image="${image:-ghcr.io/hotsauce-suite/hotsauce:latest}"

  case "$domain" in
    *[!A-Za-z0-9.-]* | .* | *.) fail "HOTSAUCE_DOMAIN should be a plain name like hotsauce.acme.com" ;;
  esac
  case "$custom_url" in
    '' | http://* | https://*) ;;
    *) fail "HOTSAUCE_URL should start with http:// or https://" ;;
  esac
  case "$custom_url$image" in
    *[!A-Za-z0-9.:/_@-]*) fail "HOTSAUCE_URL and HOTSAUCE_IMAGE should be plain addresses and image names" ;;
  esac

  command -v docker >/dev/null 2>&1 ||
    fail "Docker isn't installed. Install it first: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 ||
    fail "The Docker Compose plugin isn't installed: https://docs.docker.com/compose/install/linux/"
  docker info >/dev/null 2>&1 || fail "Can't reach Docker. Start it, or run this with sudo."
  command -v curl >/dev/null 2>&1 || fail "curl isn't installed."

  if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
    again='curl -fsSL https://hotsauce.work/install.sh | sudo'
    if [ -n "$domain" ]; then again="$again HOTSAUCE_DOMAIN=$domain"; fi
    if [ -n "$custom_url" ]; then again="$again HOTSAUCE_URL=$custom_url"; fi
    fail "Can't write to $dir. Run it with sudo, with any settings after sudo:  $again sh"
  fi

  if [ -n "$custom_url" ]; then
    url="${custom_url%/}"
  elif [ -n "$domain" ]; then
    url="https://$domain"
  else
    ip="$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)"
    url="http://${ip:-localhost}:3000"
  fi

  say "Installing Hotsauce in $dir for $url"

  # Compose reads .env for the values below. Rewritten on every run, and it holds no secrets.
  {
    say "HOTSAUCE_IMAGE=$image"
    say "PUBLIC_URL=$url"
    say "HOTSAUCE_DOMAIN=$domain"
    say "HOTSAUCE_URL=$custom_url"
  } >"$dir/.env"

  # shellcheck disable=SC2016 # The ${…} are for Compose to fill in from .env.
  {
    say '# Written by https://hotsauce.work/install.sh; running it again rewrites this file.'
    say 'name: hotsauce'
    say ''
    say 'services:'
    say '  hotsauce:'
    say '    image: ${HOTSAUCE_IMAGE}'
    say '    restart: unless-stopped'
    say '    ports:'
    if [ -n "$domain" ]; then
      # Only Caddy is public; it gets the certificate and passes WebSockets through.
      say '      - "127.0.0.1:3000:3000"'
    else
      say '      - "3000:3000"'
    fi
    say '    environment:'
    say '      PUBLIC_URL: ${PUBLIC_URL}'
    say '    volumes:'
    say '      - hotsauce-data:/data'
    if [ -n "$domain" ]; then
      say '  caddy:'
      say '    image: caddy:2'
      say '    restart: unless-stopped'
      say '    command: caddy reverse-proxy --from ${HOTSAUCE_DOMAIN} --to hotsauce:3000'
      say '    ports:'
      say '      - "80:80"'
      say '      - "443:443"'
      say '      - "443:443/udp"'
      say '    volumes:'
      say '      - caddy-data:/data'
      say '    depends_on:'
      say '      - hotsauce'
    fi
    say ''
    say 'volumes:'
    say '  hotsauce-data:'
    if [ -n "$domain" ]; then say '  caddy-data:'; fi
  } >"$dir/compose.yml"

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

  if [ -n "$domain" ]; then
    # Caddy needs the DNS record and ports 80 and 443 for its certificate: check it got one.
    tries=0
    until curl -fsS --max-time 20 "https://$domain/api/health" >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "$tries" -ge 6 ]; then
        say ""
        say "Warning: https://$domain doesn't answer yet. Check that $domain points at this server,"
        say "that ports 80 and 443 are open, and: docker compose -f $dir/compose.yml logs caddy"
        break
      fi
      sleep 10
    done
  fi

  case "$health" in
    *'"setupRequired":false'*)
      say "It's already set up. Open $url and sign in."
      return 0
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
    if [ -z "$custom_url" ]; then
      say "If $url isn't an address your team can reach, run this again with"
      say "HOTSAUCE_URL=http://<the server's public address>:3000 after sudo."
    fi
    say "Before your team uses it, put it behind HTTPS: run this again with HOTSAUCE_DOMAIN=<your domain>."
  fi
}

main "$@"
