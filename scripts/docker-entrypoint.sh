#!/usr/bin/env bash
# Container entrypoint. Fly mounts volumes owned by root, so the data dir can't
# be prepared at build time: give it to the unprivileged `node` user here, then
# run the command as `node`.
#
# The server exits with code 75 when an admin applies new settings (the setup
# wizard, Settings → Organization). This loop starts it again at once, so that
# works the same on Fly, Docker or anywhere else. Any other exit ends the
# container as before. SIGTERM and SIGINT go to the server, which shuts down
# cleanly.
set -uo pipefail

RESTART_CODE=75

if [ "$(id -u)" = "0" ] && id node >/dev/null 2>&1; then
  mkdir -p "${DATA_DIR:?DATA_DIR must be set}"
  chown node:node "$DATA_DIR"
  set -- setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

child=0
stopping=0
forward() {
  stopping=1
  if [ "$child" -ne 0 ]; then kill -TERM "$child" 2>/dev/null; fi
}
trap forward TERM INT

while true; do
  # A stop that arrived between two runs.
  if [ "$stopping" -eq 1 ]; then exit 0; fi
  "$@" &
  child=$!
  wait "$child"
  code=$?
  # `wait` returns early when a signal arrives; wait for the server to finish shutting down.
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    code=$?
  done
  if [ "$stopping" -eq 1 ] || [ "$code" -ne "$RESTART_CODE" ]; then
    exit "$code"
  fi
  echo "Restarting to apply new settings…"
  child=0
done
