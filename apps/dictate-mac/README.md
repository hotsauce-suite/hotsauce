# Dictate for Mac

The menu bar app behind Dictate (ARCHITECTURE §9). Build it on a Mac with the Xcode Command Line Tools:

1. Set your workspace's address as the default server: `ConnectLink.defaultServer` in `Sources/DictateCore/ConnectLink.swift` (it ships as `https://office.example.com`). The app still connects to any server, but it asks before sending dictations to one that isn't the default.
2. Once per Mac: `scripts/create-signing-identity.sh` makes a stable self-signed signing identity, so updates keep their microphone and Accessibility permissions.
3. `scripts/build-app.sh` builds a universal app and writes `release/HearthDictate.dmg` and `.zip`.
4. Put both files in `apps/dictate-mac/release/` before building the server image. The Dockerfile copies them to `/downloads/`, where the Dictate page offers them.

Without a Developer ID, macOS asks each person to confirm the app once (System Settings → Privacy & Security → Open Anyway). The Dictate page explains this.
