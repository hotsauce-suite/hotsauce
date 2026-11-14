# Dictate for Mac

The menu bar app behind Dictate (ARCHITECTURE §9). Build it on a Mac with the Xcode Command Line Tools:

1. Once per Mac: `scripts/create-signing-identity.sh` makes a stable self-signed signing identity, so updates keep their microphone and Accessibility permissions.
2. `scripts/build-app.sh` builds a universal app and writes `release/Hotsauce.dmg` and `.zip`.
3. Put both files in `apps/dictate-mac/release/` before building the server image. The Dockerfile copies them to `/downloads/`, where Settings → Install offers them.

Without a Developer ID, macOS asks each person to confirm the app once (System Settings → Privacy & Security → Open Anyway). Settings → Install explains this.

## First run

There is no built-in server address: one build serves every organization. On first run the setup window asks "Where does your team's Hotsauce live?", checks the address's `/api/health` answers as a Hotsauce server (showing its organization and sign-in domain), saves it, and offers Sign in with Google through the browser. Settings → Server changes it later, and the "Can't reach" page has a Change workspace address button. A Dictate connection code that names a server other than the workspace asks before connecting.
