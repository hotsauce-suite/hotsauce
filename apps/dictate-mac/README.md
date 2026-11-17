# Dictate for Mac

The menu bar app behind Dictate (ARCHITECTURE §9). Build it on a Mac with the Xcode Command Line Tools:

1. GitHub builds and publishes the app by itself after every Hotsauce release (`.github/workflows/mac-app.yml`), whenever main's version or the Mac app's sources differ from the newest build; "Run workflow" on the Mac app workflow builds one by hand. It signs with "Hotsauce Release Signing", made once with `scripts/create-release-signing.sh` on the owner's Mac (it puts the identity in that Mac's keychain and in the repository's secrets `MAC_SIGNING_P12` and `MAC_SIGNING_PASSWORD`), so builds from GitHub and from that Mac have one signature and updates keep their microphone and Accessibility permissions. Without those secrets the workflow builds nothing. (`scripts/create-signing-identity.sh` made the older "Hotsauce Local Code Signing", which can't leave its Mac.)
2. To build by hand, `scripts/build-app.sh` builds a universal app and writes `release/Hotsauce.dmg`, `.zip` and `mac-app.json` (its version, numbered from `HOTSAUCE_VERSION`; its build number is one above the newest `mac-app-<build>`, looked up with `gh`, or pass `BUILD_NUMBER`). Publish all three as a new prerelease tagged `mac-app-<build>` (`gh release create mac-app-112 --prerelease --title "Hotsauce Mac app 0.34.1 (112)" release/Hotsauce.dmg release/Hotsauce.zip release/mac-app.json`). Releases are immutable, so each build gets its own; servers and hotsauce.work/download/mac use the one with the highest build. Servers read `mac-app.json` to tell members whether their Mac app is behind (Settings → Apps, and the menu bar's Update available item); its `sameAppSince` names the first build with the same sources, so a build that only carries a new number offers no update.
3. To try a build on this Mac before publishing it: `scripts/install-app.sh` quits the running app and puts the build in Applications (it refuses a different signer or app id, so permissions carry over).
4. For a self-built image, put the three files in `apps/dictate-mac/release/` before building the server image. The Dockerfile copies them to `/downloads/`, where Settings → Apps offers them.

Without a Developer ID, macOS asks each person to confirm the app once (System Settings → Privacy & Security → Open Anyway). Settings → Apps explains this.

## Updating itself

The app checks the server's `/downloads/mac-app.json` at launch and every six hours. When a newer build is out it downloads `/downloads/Hotsauce.dmg` quietly, copies the app out of it, and keeps it only when it has the same bundle id, is newer, and satisfies the running app's designated code requirement (the same signing identity, so macOS keeps its permissions). Then the menu bar menu, Settings → Apps and one notification offer "Restart to update"; a small helper waits for the app to quit, swaps the copies and reopens it. It falls back to the download when the app runs from the disk image, can't write its folder, or the check fails (the reason is in `defaults read dev.hotsauce.dictate status.updateFailed`). See `docs/PLAN-mac-self-update.md`; the logic and its tests are `Sources/DictateCore/AppUpdate.swift`.

## With no connection

When the Mac has no network, or the server didn't answer in the last minute, the dictation key records as usual and the text is written up by the Mac's own speech recognition (`SFSpeechRecognizer` with `requiresOnDeviceRecognition`), with "Offline: on-device" in the pill. A dictation whose stream and upload both fail to reach the server is written up the same way from the kept recording. Nothing is sent anywhere offline. The choice is `SpeechRouting` in `Sources/DictateCore/SpeechRoute.swift` (tested); the recognizer is `Sources/HotsauceDictate/OnDeviceSpeech.swift`. Plan: `docs/PLAN-offline.md`, step A2.

- `HotsauceDictate --on-device-file <16 kHz mono WAV> --out <result.json>` writes a file up the same way. Open it through Launch Services (`open -n -a build/Hotsauce.app --args …`) so the Speech Recognition permission is the app's own; `say -o x.wav --file-format=WAVE --data-format=LEI16@16000 "…"` makes a test file without playing anything.

## Edge glow

While Dictate listens, a glow lines the edges of the focused window (found with the Accessibility API; the pointer's screen when there's no window or it's full screen), with flames along the bottom that follow the mic level. It pulses while the text is written up and fades after the paste. Settings → This Mac → "Edge glow while dictating" turns it off; Reduce motion makes it still. Colours, sizes and timings are constants in `EdgeGlowLook` (`Sources/DictateCore/EdgeGlow.swift`); the plan is `docs/PLAN-dictate-edge-glow.md`.

- `HotsauceDictate --render-edge-glow <folder>` draws it over a stand-in window to PNGs (no screen access needed).
- `HotsauceDictate --edge-glow-demo [seconds] [--reduce-motion]` shows it on screen with a made-up voice. A build without Accessibility permission frames the whole screen, and macOS may ask to grant that permission.

## First run

There is no built-in server address: one build serves every organization. On first run the setup window asks "Where does your team's Hotsauce live?", checks the address's `/api/health` answers as a Hotsauce server (showing its organization and sign-in domain), saves it, and offers Sign in with Google through the browser. The Dictate window's small Settings page (what ⌘, opens when the suite can't load) has the address under Workspace, and the "Can't reach" page has a Change workspace address button. Settings → This Mac → Run setup again (also Run Setup Again… in the app menu and the menu bar icon) walks every setup step from the start without resetting anything. A Dictate connection code that names a server other than the workspace asks before connecting.

## Settings

The app's settings are a page of the web app, Settings → This Mac (`apps/web/src/routes/settings/ThisMacPage.tsx`), shown only inside the app. The page reads and changes them over the `hotsauceMacSettings` script message handler (`MacSettingsBridge` in DictateCore, answered in `SuiteWindow.swift`, applied in `AppDelegate.wireMacSettings`); the values stay in this Mac's UserDefaults. ⌘, and the menu bar's Settings… open it once the loaded page has said hello over the bridge; otherwise they open the Dictate window's small fallback page (workspace address, permissions, Run setup again, Clear history). Plan: `docs/PLAN-one-settings.md`.

The dictation numbers and history are on the web app's Dictate page too, in its "On this Mac" section (`apps/web/src/apps/dictate/MacDictations.tsx`), shown only inside the app. It asks over the same handler (`{type: 'dictations', range, search}`, answered by `DictationsReply` in DictateCore with the Mac's own `DictationStats` and `MonthActivity`, the newest 200 matches and the apps' icons as PNG data URLs) and copies or pastes one with `{type: 'dictation', id, action}`. The app tells the page when the history changes with a `hotsauce:mac-dictations` event. Dictate… opens it once the loaded page has said `helloDictations`; otherwise the old Dictate window, now only Dictations and the Settings fallback. Plan: `docs/PLAN-dictations-page.md`.
