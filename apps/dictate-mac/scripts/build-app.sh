#!/usr/bin/env bash
# Builds <Name>.app (universal, macOS 14+; the name from Brand.swift, "Hotsauce"), signs it, and
# packages it for the server's /downloads/: <Name>.dmg (the app and an Applications link) and
# <Name>.zip. The bundle id stays dev.hotsauce.dictate: macOS keys the Microphone and
# Accessibility permissions to it and the signature, not to the name.
# Signs with, in order: a "Developer ID Application" identity (hardened runtime, timestamp);
# "Hotsauce Local Code Signing" from scripts/create-signing-identity.sh (a stable self-signed
# identity, so macOS keeps permissions across updates); else ad hoc.
# With a Developer ID it also notarizes with Apple and staples the tickets, so the download opens
# without a Gatekeeper warning. That needs a notarytool keychain profile (default "mac-notary",
# override with NOTARY_PROFILE), saved once with
#   xcrun notarytool store-credentials mac-notary --apple-id <id> --team-id <team>
# which keeps the app-specific password in the login keychain; this script never sees it.
# The disk image window (background, icon spots) comes from Resources/dmg/ via dmgbuild, run with
# uvx; without uv it falls back to a plain window.
#
#   apps/dictate-mac/scripts/build-app.sh   → build/Hotsauce.app, release/Hotsauce.{dmg,zip}
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-0.5.0}"
BUILD_NUMBER="${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
# The display name and deep-link scheme live in one place, Sources/DictateCore/Brand.swift.
brand() { sed -n "s/.*static let $1 = \"\\(.*\\)\".*/\\1/p" Sources/DictateCore/Brand.swift; }
APP_NAME="$(brand name)"
URL_SCHEME="$(brand urlScheme)"
[[ -n "$APP_NAME" && -n "$URL_SCHEME" ]] || { echo "Couldn't read the name and URL scheme from Brand.swift" >&2; exit 1; }
APP="build/${APP_NAME}.app"
DMG="release/${APP_NAME}.dmg"
ZIP="release/${APP_NAME}.zip"

swift build -c release --arch arm64 --arch x86_64
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" release
cp "$BIN/HearthDictate" "$APP/Contents/MacOS/${APP_NAME}"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>dev.hotsauce.dictate</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Hotsauce contributors</string>
  <key>NSMicrophoneUsageDescription</key><string>${APP_NAME} listens while you hold the dictation key, and sends that audio to be written up; meetings and clips you record use it too.</string>
  <key>NSAudioCaptureUsageDescription</key><string>${APP_NAME} records the other side of a call (Zoom, Slack, FaceTime or any app) when you take meeting notes with “Any app on this Mac”.</string>
  <key>NSLocationUsageDescription</key><string>${APP_NAME} shows the weather where you are on Today. Your position is rounded to about a kilometre and used only to look up the weather.</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>${APP_NAME} shows the weather where you are on Today. Your position is rounded to about a kilometre and used only to look up the weather.</string>
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

NOTARY_PROFILE="${NOTARY_PROFILE:-mac-notary}"
NOTARIZE=0
if [[ -n "$IDENTITY" ]]; then
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    NOTARIZE=1
  else
    echo "WARNING: no working notarytool profile \"$NOTARY_PROFILE\": the build is signed but NOT notarized," >&2
    echo "         so Macs will still warn on first open. See the comment at the top of this script." >&2
  fi
fi
notarize() { # <file>: send to Apple, wait for the verdict, staple the ticket on success.
  local file="$1" target="${2:-$1}"
  echo "Notarizing $(basename "$file") (usually a few minutes)"
  xcrun notarytool submit "$file" --keychain-profile "$NOTARY_PROFILE" --wait --timeout 30m \
    | tee build/notary.log || true
  grep -q "status: Accepted" build/notary.log || { echo "Apple didn't accept $(basename "$file"); see the log above and 'xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE'" >&2; exit 1; }
  xcrun stapler staple "$target"
}

rm -f release/*.zip release/*.dmg
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
if (( NOTARIZE )); then
  # Notarize the app itself first and staple it, so a copy opened from the zip or dragged out of
  # the disk image carries its ticket even offline; then zip the stapled app again.
  notarize "$ZIP" "$APP"
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
fi

# The disk image: the app beside a link to Applications, to drag across, on the background from
# Resources/dmg/ (dmgbuild writes the window layout without driving Finder).
if command -v uvx >/dev/null 2>&1 && uvx --quiet dmgbuild==1.6.7 -s Resources/dmg/settings.py \
    -D app="$APP" -D background=Resources/dmg/background.tiff "$APP_NAME" "$DMG"; then
  :
else
  echo "dmgbuild unavailable (uv missing or offline): building a plain disk image"
  rm -f "$DMG"
  STAGE="build/dmg"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/${APP_NAME}.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
  # The staging folder's Applications link would let other tools (test runners) walk /Applications.
  rm -rf "$STAGE"
fi
if [[ -n "$IDENTITY" ]]; then
  codesign --force --timestamp -s "$IDENTITY" "$DMG"
elif [[ "$SIGNER" != "-" ]]; then
  codesign --force -s "$SIGNER" "$DMG"
fi
if (( NOTARIZE )); then
  notarize "$DMG"
  spctl -a -t open --context context:primary-signature -v "$DMG"
fi

echo "Built $APP, $DMG ($(du -h "$DMG" | cut -f1)) and $ZIP ($(du -h "$ZIP" | cut -f1))"
