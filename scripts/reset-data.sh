#!/usr/bin/env bash
# Deletes local Hearth data in .data/: working clones, the local bare "remote"
# repos, the SQLite index, and the Forgejo token. Asks first; --yes skips that.
set -euo pipefail

cd "$(dirname "$0")/.."
data_dir="$(pwd)/.data"

if [ ! -d "$data_dir" ]; then
  echo "Nothing to reset: $data_dir does not exist."
  exit 0
fi

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Delete everything in $data_dir? This cannot be undone. [y/N] " answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "Aborted; nothing deleted."
      exit 1
      ;;
  esac
fi

rm -rf "$data_dir"
echo "Deleted $data_dir."
echo "Using Forgejo? Run 'docker compose down -v' to reset it as well; scripts/dev.sh recreates the token."
