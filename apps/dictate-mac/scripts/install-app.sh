#!/usr/bin/env bash
# Installs the app scripts/build-app.sh just built (build/Hotsauce.app) into /Applications on this
# Mac, for checking a build before it's published: quits the running copy, replaces it, opens it.
# Refuses a build that isn't signed by the same identity as the installed copy, so the
# microphone, Accessibility and Speech Recognition permissions carry over.
#
#   apps/dictate-mac/scripts/install-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP_NAME="$(sed -n 's/.*static let name = "\(.*\)".*/\1/p' Sources/DictateCore/Brand.swift)"
NEW="build/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"
[[ -d "$NEW" ]] || { echo "No $NEW: run scripts/build-app.sh first" >&2; exit 1; }
codesign --verify --deep --strict "$NEW"
id_of() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }
signer_of() { codesign -dvv "$1" 2>&1 | sed -n 's/^Authority=//p' | head -1; }
if [[ -d "$DEST" ]]; then
  [[ "$(id_of "$NEW")" == "$(id_of "$DEST")" ]] || { echo "Different app id from the installed one" >&2; exit 1; }
  [[ "$(signer_of "$NEW")" == "$(signer_of "$DEST")" ]] || { echo "Signed by someone else than the installed one" >&2; exit 1; }
fi
osascript -e "tell application id \"$(id_of "$NEW")\" to quit" >/dev/null 2>&1 || true
sleep 1
ditto "$NEW" "${DEST}.installing"
rm -rf "$DEST"
mv "${DEST}.installing" "$DEST"
open "$DEST"
echo "Installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist") ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$DEST/Contents/Info.plist")) in $DEST"
