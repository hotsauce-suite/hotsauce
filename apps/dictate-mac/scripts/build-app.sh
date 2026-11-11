#!/usr/bin/env bash
# Builds HearthDictate.app (universal, macOS 14+), signs it, and packages it for the server's
# /downloads/: HearthDictate.dmg (the app and an Applications link) and HearthDictate.zip.
# Signs with, in order: a "Developer ID Application" identity (hardened runtime, timestamp);
# "Hotsauce Local Code Signing" from scripts/create-signing-identity.sh (a stable self-signed
# identity, so macOS keeps permissions across updates); else ad hoc.
#
#   apps/dictate-mac/scripts/build-app.sh   → build/HearthDictate.app, release/HearthDictate.{dmg,zip}
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-0.2.0}"
BUILD_NUMBER="${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
APP="build/HearthDictate.app"
# The display name and deep-link scheme live in one place, Sources/DictateCore/Brand.swift.
brand() { sed -n "s/.*static let $1 = \"\\(.*\\)\".*/\\1/p" Sources/DictateCore/Brand.swift; }
APP_NAME="$(brand name)"
URL_SCHEME="$(brand urlScheme)"
[[ -n "$APP_NAME" && -n "$URL_SCHEME" ]] || { echo "Couldn't read the name and URL scheme from Brand.swift" >&2; exit 1; }

swift build -c release --arch arm64 --arch x86_64
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" release
cp "$BIN/HearthDictate" "$APP/Contents/MacOS/HearthDictate"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>dev.hotsauce.dictate</string>
  <key>CFBundleExecutable</key><string>HearthDictate</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Hotsauce contributors</string>
  <key>NSMicrophoneUsageDescription</key><string>${APP_NAME} listens while you hold the dictation key, and sends that audio to be written up; meetings and clips you record use it too.</string>
  <key>NSCameraUsageDescription</key><string>${APP_NAME} uses the camera when you record a clip with your camera on.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>dev.hotsauce.dictate</string>
      <key>CFBundleURLSchemes</key><array><string>hearth-dictate</string><string>${URL_SCHEME}</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)"
INTERNAL="Hotsauce Local Code Signing"
SIGNER="-"
if [[ -n "$IDENTITY" ]]; then
  echo "Signing with $IDENTITY (hardened runtime)"
  SIGNER="$IDENTITY"
  codesign --force --deep --options runtime --timestamp \
    --entitlements Resources/HearthDictate.entitlements -s "$IDENTITY" "$APP"
elif grep -q "\"$INTERNAL\"" <<<"$(security find-identity -p codesigning 2>/dev/null)"; then
  echo "Signing with $INTERNAL (self-signed, stable across builds)"
  SIGNER="$INTERNAL"
  codesign --force --deep --options runtime \
    --entitlements Resources/HearthDictate.entitlements -s "$INTERNAL" "$APP"
else
  echo "No signing identity: signing ad hoc (run scripts/create-signing-identity.sh once to keep permissions across updates)"
  codesign --force --deep -s - "$APP"
fi
codesign --verify --deep --strict "$APP"

rm -f release/HearthDictate.zip release/HearthDictate.dmg
ditto -c -k --sequesterRsrc --keepParent "$APP" release/HearthDictate.zip

# The disk image: the app beside a link to Applications, to drag across.
STAGE="build/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/HearthDictate.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Hearth Dictate" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov release/HearthDictate.dmg
# The staging folder's Applications link would let other tools (test runners) walk /Applications.
rm -rf "$STAGE"
if [[ "$SIGNER" != "-" ]]; then codesign --force -s "$SIGNER" release/HearthDictate.dmg; fi

echo "Built $APP, release/HearthDictate.dmg ($(du -h release/HearthDictate.dmg | cut -f1)) and release/HearthDictate.zip ($(du -h release/HearthDictate.zip | cut -f1))"
