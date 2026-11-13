#!/bin/sh
# The checks at the end of hotsauce.work/install.md, for the install test workflow
# (.github/workflows/install-test.yml, docs/PLAN-one-click-install.md).
#
#   scripts/check-install.sh <url> [version] [wait-seconds]
#
# Waits for <url>/api/health to answer "ok":true, then checks it runs [version] (default: this
# checkout's HOTSAUCE_VERSION) and is still waiting for its setup wizard.
set -eu

url="${1:?usage: scripts/check-install.sh <url> [version] [wait-seconds]}"
url="${url%/}"
want="${2:-$(tr -d '[:space:]' < "$(dirname "$0")/../HOTSAUCE_VERSION")}"
wait_secs="${3:-300}"

health=''
waited=0
while [ "$waited" -lt "$wait_secs" ]; do
  health="$(curl -fsS --max-time 20 "$url/api/health" 2>/dev/null || true)"
  case "$health" in *'"ok":true'*) break ;; esac
  health=''
  sleep 10
  waited=$((waited + 10))
done
[ -n "$health" ] || { echo "FAIL: $url/api/health didn't answer \"ok\":true within ${wait_secs}s" >&2; exit 1; }
echo "$url/api/health: $health"

case "$health" in
  *"\"version\":\"$want\""*) echo "ok: runs $want" ;;
  *) echo "FAIL: expected version $want" >&2; exit 1 ;;
esac
case "$health" in
  *'"setupRequired":true'*) echo "ok: waiting for its setup wizard" ;;
  *) echo "FAIL: expected \"setupRequired\":true on a fresh install" >&2; exit 1 ;;
esac
code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 "$url/setup" || true)"
[ "$code" = 200 ] || { echo "FAIL: $url/setup answered $code" >&2; exit 1; }
echo "ok: $url/setup answers 200"
