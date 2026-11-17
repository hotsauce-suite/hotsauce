# Plan: the Mac app updates itself

Status (2026-11-17): shipped in 0.47.0 (Mac app build 127). The first real one-click update happens on the next Mac app build. The owner asked for a one-click update ("I'm still confused about
how I update the macOS app"); this replaces decision 3 of `PLAN-mac-version-and-whats-new.md`
("self-updating waits for a Developer ID build"). The new information: download-and-drag confused
the owner himself, and a Developer ID build isn't needed to update safely, because the app checks
the new copy against its own code signature (below), the same check macOS uses to keep permissions.
The owner accepted both recommendations on 2026-11-17: download quietly, restart only on a click
(Q1), and one notification per version (Q2).

## How it works

1. The app already checks `/downloads/mac-app.json` at launch and every six hours (M7). When a
   newer build is out, it downloads `/downloads/Hotsauce.dmg` quietly into a private folder on the
   same disk as the installed app.
2. It mounts the disk image (read-only, hidden), copies the app out, unmounts it, and accepts the
   copy only when: it has the same bundle id, it is newer than the running app, and its code
   signature is valid and satisfies the running app's **designated requirement** (for our
   self-signed "Hotsauce Release Signing" builds that pins the exact certificate; for a Developer
   ID build, the team). An ad hoc build never satisfies another build's requirement, so it is
   never replaced automatically.
3. The menu bar menu and Settings → Apps then offer **Restart to update (X)**, and one Mac
   notification says so. Nothing restarts without a click.
4. The click starts a small helper (`/bin/sh` with fixed arguments, no string building) that waits
   for the app to quit, moves the old copy aside, moves the new one in (a rename on the same disk),
   reopens it, and deletes the old copy. If the move fails it puts the old copy back.
5. Anything that stops this (the app runs from the disk image, its folder isn't writable, the
   download or the signature check fails) falls back to today's "Update available (X)…", which
   downloads the installer.

macOS keeps Microphone, Accessibility, Speech Recognition and Location because the new copy has
the same bundle id and satisfies the same signature requirement.

Why not Sparkle: it needs its own EdDSA signing key as a new secret, an appcast feed and its
installer bundle; the app already has a version feed and a stable signature, and the custom part
is about 200 lines.

## Requirements

U1. `AppUpdate.destination` accepts the running app's own location only when it isn't on a disk
    image (`/Volumes/`) or translocated, and its folder is writable. [AppUpdateTests]
U2. `AppUpdate.verdict` refuses a copy with another bundle id, or one that isn't newer than the
    running app (version, then build). [AppUpdateTests]
U3. `AppUpdate.satisfies` accepts a validly signed app that satisfies the given requirement, and
    refuses one signed by another identity and one altered after signing. [AppUpdateTests, with
    real `codesign` on test bundles]
U4. `AppUpdate.prepare` downloads a disk image, mounts it, copies the app out, unmounts it, strips
    quarantine and runs U2 and U3; a missing app, a failed download or a failed check is a failure
    and leaves nothing mounted. [AppUpdateTests, with a real `hdiutil` disk image and a file URL]
U5. The swap helper waits for the given process to exit, swaps the copies, opens the new one, and
    removes the old; when the move fails the old copy is back in place. [AppUpdateTests run the
    script on temp folders]
U6. `UpdateState` gives the menu its entry: none; "Downloading update (X)…" (disabled); "Restart to
    update (X)"; "Update available (X)…" (the download) when it can't install. [AppUpdateTests]
U7. The window answers `hotsauceMacUpdate.postMessage('state' | 'install')` from the suite's own
    main frame only, with `{ state, version }`. [AppUpdateTests for parsing and replies; the
    main-frame check is the same one every bridge uses, checked on the owner's Mac]
U8. Settings → Apps inside a Mac app with the bridge: "Restart to update" when ready, "Downloading
    the update…" while it downloads, and the download button otherwise; older apps keep the
    download button. [SettingsRoute.test]
U9. Restarting waits while dictation is recording or still being written up, or the window
    is using the microphone (a meeting or clip being recorded), and says so. [checked on the owner's Mac]
U10. One notification per version when an update is ready (counted only when macOS shows it),
    with a "Restart to update" button; a click on the banner opens Settings → Apps instead.
    [checked on the owner's Mac]
U11. Right before the swap the staged copy is checked again (U2, U3); the copy waits in the app's
    Caches folder on the same disk, not a temporary folder that macOS cleans. [AppUpdateTests]
U12. A swap that didn't take (the app reopens on the old version) and failures a new download would
    hit again (wrong signer, not newer) aren't retried for that version: it offers the download.
    Downloads, mounts and copies time out. [AppUpdateTests for which failures are permanent]

## Slices

1. Core: U1-U7 in `DictateCore/AppUpdate.swift` with tests.
2. App: updater, menu, bridge, notification (U9, U10).
3. Web card (U8).
4. Help: README of the Mac app, help center page, FAQ, STATUS.md.

## Not doing

Delta updates; release channels; updating a copy outside its own folder; downgrades. Checking the
disk image's own signature before mounting it (the app inside is checked, which is what runs), and
Swift 6 strict-concurrency cleanups (the package builds in Swift 5 mode).
