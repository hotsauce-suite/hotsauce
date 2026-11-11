#!/usr/bin/env bash
# Creates "Hotsauce Local Code Signing", a self-signed code-signing identity in your login
# keychain, once per build Mac. scripts/build-app.sh signs with it when there's no Developer ID,
# so every build has the same designated requirement and macOS keeps the Microphone and
# Accessibility permissions across updates (ad hoc signatures change with every build).
#
# The private key is generated into a private temp folder, imported, and deleted; it never
# leaves the login keychain. To recreate the identity (a new Mac, or after deleting it), run this
# again (the old key can't be exported, by design); members then re-grant Accessibility once for
# the first build signed with the new key.
set -euo pipefail
NAME="Hotsauce Local Code Signing"

if grep -q "\"$NAME\"" <<<"$(security find-identity -p codesigning 2>/dev/null)"; then
  echo "\"$NAME\" is already in your keychain."
  exit 0
fi

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
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$DIR/cert.cnf" \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
PASS="$(openssl rand -hex 16)"
# -legacy: macOS's keychain can't read the newer PKCS#12 encryption OpenSSL 3 writes by default.
openssl pkcs12 -export -legacy -name "$NAME" -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -out "$DIR/id.p12" -passout "pass:$PASS" 2>/dev/null \
  || openssl pkcs12 -export -name "$NAME" -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
       -out "$DIR/id.p12" -passout "pass:$PASS"
# -x: the private key can never be exported from the keychain.
security import "$DIR/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -x -T /usr/bin/codesign
echo "Created \"$NAME\". Build with scripts/build-app.sh; it signs with this identity from now on."
