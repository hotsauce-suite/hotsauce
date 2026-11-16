# Plan: Mac app version and What's new

Status (2026-11-16): building. Decisions settled with the owner on 2026-11-16 (all five
recommendations accepted). The Mac app half needs one build on a Mac before Macs report their
version; until then Settings says "version not reported" rather than guessing.

Why: nothing in Hotsauce knew which Mac app a member had. The Mac app never updates itself, and
Settings offered "Download the newest version" whether or not it was newer. Release notes were
GitHub's list of pull request titles, internal ones included.

## Decisions (owner, 2026-11-16)

1. The version shows on the Mac app card in Settings → Apps, inside the Mac app and in a browser
   (from what each Mac last reported).
2. When an update exists the Mac app's menu bar menu also says "Update available…". The Mac app's
   own Settings window is unchanged.
3. Updating is still download and drag; self-updating waits for a Developer ID build.
4. Every pull request carries a "What's new" section: plain sentences, or "None" for changes
   nobody sees. A check fails a pull request without it.
5. The notes show on a What's new page in Settings (from the version under the menu) and on
   hotsauce.work. Mac app changes are in the same list, marked "Mac app". No pop-ups.

## Requirements

Latest Mac app
M1. The `mac-app` GitHub release carries `mac-app.json`: `{ "version", "build", "reportsVersion" }`,
    written by `apps/dictate-mac/scripts/build-app.sh` beside the DMG. [build script]
M2. A server serves it at `/downloads/mac-app.json` (cached like the DMG, last good copy kept; a
    DMG older than the version file is fetched again, so the update offered is the one handed out);
    without one it is a 404 and Settings shows no update state. [macApp.test]

What a Mac reports
M3. The Mac app sends `Hotsauce-App: mac/<version>+<build>` with its device-token requests (the
    build tells apart two builds of one release, since Mac-only changes make no release); the server
    keeps the newest such value on the device, and `GET /api/dictation/devices` returns it as
    `appVersion` (null until reported). A malformed value is ignored. [store.test, dictation
    integration test]
M4. The Mac app's window tells the page its version (`window.hotsauceMacApp.version`). [Swift
    test of the script]

Settings → Apps, Mac app card
M5. Inside the Mac app: "Version X" and either "Up to date" or "Update available: Y" with a
    Download button and a What's new link. An app too old to say its version shows "An older
    version" once the latest build reports versions, and no state before. [MacApp.test]
M6. In a browser: each of the member's connected Macs with its name, reported version and the same
    state. [MacApp.test]

Mac app menu
M7. When the server's `mac-app.json` names a newer version than the app's own, the menu bar menu
    shows "Update available (Y)…", which opens the download. Checked at launch and every six hours.
    [Swift test of the comparison]

What's new
N1. `WHATS_NEW.json` at the repository root holds every release's notes, newest first:
    `{ "releases": [{ "version", "date", "notes": [{ "text", "area"? }] }] }`. `area` is "Mac app"
    for Mac app notes. [whatsNew.test]
N2. A pull request's body has a `## What's new` section: lines starting `- ` (a line starting
    `- Mac app:` is a Mac app note), or the word None. `.github/workflows/whats-new.yml` fails a
    pull request without it. [release-notes test]
N3. The Release workflow collects the sections of the pull requests since the last release,
    writes them to `WHATS_NEW.json` in the "Release X.Y.Z" commit, and puts them at the top of the
    GitHub release. A release with no notes gets none. [release-notes test]
N4. `WHATS_NEW.json` alone never starts a release. [next-release test]
N5. Settings → What's new (`/settings/whats-new`), opened from the version under the Settings menu,
    lists releases newest first with "Mac app" marked, and says which version this server runs.
    [WhatsNewPage.test]
N6. hotsauce.work/changes shows the same notes, read from `WHATS_NEW.json` on `main`. [site]

## Slices

1. Server: `/downloads/mac-app.json`, device versions. 2. Web: the card. 3. Notes: file, check,
   workflow, page. 4. Site page, help and FAQ. 5. Mac app: header, page script, menu item (built on
   the owner's Mac).

## Not doing

Self-updating (needs a Developer ID build); pop-ups after an update; regrouping the Mac app's own
Settings window.
