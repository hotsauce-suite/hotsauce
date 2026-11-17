#!/usr/bin/env bash
# Creates "Hotsauce Release Signing", the self-signed identity every Mac app build is signed with,
# and hands it to GitHub, so the Mac app workflow (.github/workflows/mac-app.yml) can build the app
# with each Hotsauce release (docs/PLAN-mac-download.md). Run it once, on the Mac that publishes
# builds by hand, with the GitHub CLI signed in:
#
#   bash apps/dictate-mac/scripts/create-release-signing.sh [owner/repo]
#
# It sets two repository secrets, MAC_SIGNING_P12 (the identity, base64) and MAC_SIGNING_PASSWORD,
# and adds the identity to this Mac's login keychain (not exportable from there), so builds from
# here and from GitHub have the same signature and macOS keeps their permissions across updates.
# The key is made in a private temp folder and deleted; it is never printed.
# Members grant Accessibility once more for the first build signed with it (a new signature).
set -euo pipefail
NAME="Hotsauce Release Signing"
REPO="${1:-hotsauce-suite/hotsauce}"

if grep -q "\"$NAME\"" <<<"$(security find-identity -p codesigning 2>/dev/null)"; then
  echo "\"$NAME\" is already in this Mac's keychain, so GitHub should already have it."
  echo "To start over, delete it in Keychain Access first."
  exit 0
fi
command -v gh >/dev/null || { echo "Install the GitHub CLI first: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign the GitHub CLI in first: gh auth login" >&2; exit 1; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
chmod 700 "$DIR"
umask 077
cat > "$DIR/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
O = Hotsauce
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$DIR/cert.cnf" \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
PASS="$(openssl rand -hex 24)"
# -legacy: macOS's keychain can't read the newer PKCS#12 encryption OpenSSL 3 writes by default.
openssl pkcs12 -export -legacy -name "$NAME" -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -out "$DIR/id.p12" -passout "pass:$PASS" 2>/dev/null \
  || openssl pkcs12 -export -name "$NAME" -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
       -out "$DIR/id.p12" -passout "pass:$PASS"

# GitHub first: if that fails, nothing has changed on this Mac.
base64 < "$DIR/id.p12" | tr -d '\n' | gh secret set MAC_SIGNING_P12 -R "$REPO"
printf '%s' "$PASS" | gh secret set MAC_SIGNING_PASSWORD -R "$REPO"
# -x: the private key can't be exported from the keychain again.
security import "$DIR/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -x -T /usr/bin/codesign
echo "Done: \"$NAME\" is in this Mac's keychain and in GitHub's secrets for $REPO."
