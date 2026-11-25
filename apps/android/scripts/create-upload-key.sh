#!/usr/bin/env bash
# Creates the Android app's upload key (docs/PLAN-android.md, slice 3) and hands it to GitHub, so
# the Android app workflow (.github/workflows/android-app.yml) signs every release bundle with it.
# Run it once, on a Mac or Linux machine with OpenSSL and the GitHub CLI signed in:
#
#   bash apps/android/scripts/create-upload-key.sh [owner/repo]
#
# It sets two repository secrets, ANDROID_UPLOAD_KEYSTORE (a PKCS#12 keystore, base64, alias
# "upload") and ANDROID_UPLOAD_PASSWORD, keeps a backup of the keystore in a private folder
# (~/.hotsauce/android-upload.p12, with its password next to it, readable only by you), and prints
# the key's SHA-256 fingerprint, which is public: it goes in apps/server/src/api/android.ts.
# Google Play re-signs the app with its own key, so a lost upload key can be reset in Play Console.
set -euo pipefail
REPO="${1:-hotsauce-suite/hotsauce}"
BACKUP="$HOME/.hotsauce"

if [ -e "$BACKUP/android-upload.p12" ]; then
  echo "There's already an upload key in $BACKUP, so GitHub should already have it."
  echo "To start over, move that folder away first."
  exit 0
fi
command -v gh >/dev/null || { echo "Install the GitHub CLI first: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign the GitHub CLI in first: gh auth login" >&2; exit 1; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
chmod 700 "$DIR"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 10950 -subj "/CN=Hotsauce Android upload/O=Hotsauce" \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
PASS="$(openssl rand -hex 24)"
openssl pkcs12 -export -name upload -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -out "$DIR/upload.p12" -passout "pass:$PASS"
FINGERPRINT="$(openssl x509 -in "$DIR/cert.pem" -noout -fingerprint -sha256 | sed 's/^.*=//')"

# GitHub first: if that fails, nothing is kept here and running again starts clean.
base64 < "$DIR/upload.p12" | tr -d '\n' | gh secret set ANDROID_UPLOAD_KEYSTORE -R "$REPO"
printf '%s' "$PASS" | gh secret set ANDROID_UPLOAD_PASSWORD -R "$REPO"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
cp "$DIR/upload.p12" "$BACKUP/android-upload.p12"
printf '%s\n' "$PASS" > "$BACKUP/android-upload.password"
echo "Done: GitHub's secrets for $REPO have the upload key, and $BACKUP has a backup."
echo "Upload key SHA-256 fingerprint (public): $FINGERPRINT"
