# Dictate for Mac

The menu bar app behind Dictate (ARCHITECTURE §9). Build it on a Mac with the Xcode Command Line Tools:

1. Once per Mac: `scripts/create-signing-identity.sh` makes a stable self-signed signing identity, so updates keep their microphone and Accessibility permissions.
2. `scripts/build-app.sh` builds a universal app and writes `release/Hotsauce.dmg`, `.zip` and `mac-app.json` (its version, numbered from `HOTSAUCE_VERSION`). Publish all three as a new prerelease tagged `mac-app-<build>` (`gh release create mac-app-111 --prerelease --title "Hotsauce Mac app 0.29.2 (111)" release/Hotsauce.dmg release/Hotsauce.zip release/mac-app.json`). Releases are immutable, so each build gets its own; servers use the one with the highest build. Servers read `mac-app.json` to tell members whether their Mac app is behind (Settings → Apps, and the menu bar's Update available item).
3. To try a build on this Mac before publishing it: `scripts/install-app.sh` quits the running app and puts the build in Applications (it refuses a different signer or app id, so permissions carry over).
4. For a self-built image, put the three files in `apps/dictate-mac/release/` before building the server image. The Dockerfile copies them to `/downloads/`, where Settings → Apps offers them.

Without a Developer ID, macOS asks each person to confirm the app once (System Settings → Privacy & Security → Open Anyway). Settings → Apps explains this.

## With no connection

When the Mac has no network, or the server didn't answer in the last minute, the dictation key records as usual and the text is written up by the Mac's own speech recognition (`SFSpeechRecognizer` with `requiresOnDeviceRecognition`), with "Offline: on-device" in the pill. A dictation whose stream and upload both fail to reach the server is written up the same way from the kept recording. Nothing is sent anywhere offline. The choice is `SpeechRouting` in `Sources/DictateCore/SpeechRoute.swift` (tested); the recognizer is `Sources/HotsauceDictate/OnDeviceSpeech.swift`. Plan: `docs/PLAN-offline.md`, step A2.

- `HotsauceDictate --on-device-file <16 kHz mono WAV> --out <result.json>` writes a file up the same way. Open it through Launch Services (`open -n -a build/Hotsauce.app --args …`) so the Speech Recognition permission is the app's own; `say -o x.wav --file-format=WAVE --data-format=LEI16@16000 "…"` makes a test file without playing anything.

## Edge glow

While Dictate listens, a glow lines the edges of the focused window (found with the Accessibility API; the pointer's screen when there's no window or it's full screen), with flames along the bottom that follow the mic level. It pulses while the text is written up and fades after the paste. Settings → Dictation → "Edge glow while dictating" turns it off; Reduce motion makes it still. Colours, sizes and timings are constants in `EdgeGlowLook` (`Sources/DictateCore/EdgeGlow.swift`); the plan is `docs/PLAN-dictate-edge-glow.md`.

- `HotsauceDictate --render-edge-glow <folder>` draws it over a stand-in window to PNGs (no screen access needed).
- `HotsauceDictate --edge-glow-demo [seconds] [--reduce-motion]` shows it on screen with a made-up voice. A build without Accessibility permission frames the whole screen, and macOS may ask to grant that permission.

## First run

There is no built-in server address: one build serves every organization. On first run the setup window asks "Where does your team's Hotsauce live?", checks the address's `/api/health` answers as a Hotsauce server (showing its organization and sign-in domain), saves it, and offers Sign in with Google through the browser. Settings → Workspace → Address changes it later, and the "Can't reach" page has a Change workspace address button. Settings → Run setup again (also Run Setup Again… in the app menu and the menu bar icon) walks every setup step from the start without resetting anything. A Dictate connection code that names a server other than the workspace asks before connecting.
