# Dictate for Mac

The menu bar app behind Dictate (ARCHITECTURE §9). Build it on a Mac with the Xcode Command Line Tools:

1. Once per Mac: `scripts/create-signing-identity.sh` makes a stable self-signed signing identity, so updates keep their microphone and Accessibility permissions.
2. `scripts/build-app.sh` builds a universal app and writes `release/Hotsauce.dmg` and `.zip`.
3. Put both files in `apps/dictate-mac/release/` before building the server image. The Dockerfile copies them to `/downloads/`, where Settings → Install offers them.

Without a Developer ID, macOS asks each person to confirm the app once (System Settings → Privacy & Security → Open Anyway). Settings → Install explains this.

## Edge glow

While Dictate listens, a glow lines the edges of the focused window (found with the Accessibility API; the pointer's screen when there's no window or it's full screen), with flames along the bottom that follow the mic level. It pulses while the text is written up and fades after the paste. Settings → Dictation → "Edge glow while dictating" turns it off; Reduce motion makes it still. Colours, sizes and timings are constants in `EdgeGlowLook` (`Sources/DictateCore/EdgeGlow.swift`); the plan is `docs/PLAN-dictate-edge-glow.md`.

- `HotsauceDictate --render-edge-glow <folder>` draws it over a stand-in window to PNGs (no screen access needed).
- `HotsauceDictate --edge-glow-demo [seconds] [--reduce-motion]` shows it on screen with a made-up voice. A build without Accessibility permission frames the whole screen, and macOS may ask to grant that permission.

## First run

There is no built-in server address: one build serves every organization. On first run the setup window asks "Where does your team's Hotsauce live?", checks the address's `/api/health` answers as a Hotsauce server (showing its organization and sign-in domain), saves it, and offers Sign in with Google through the browser. Settings → Workspace → Address changes it later, and the "Can't reach" page has a Change workspace address button. Settings → Run setup again (also Run Setup Again… in the app menu and the menu bar icon) walks every setup step from the start without resetting anything. A Dictate connection code that names a server other than the workspace asks before connecting.
