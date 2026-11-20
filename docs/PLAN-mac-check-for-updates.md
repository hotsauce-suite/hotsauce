# Plan: Check for Updates… and the GitHub link in About

Status (2026-11-20): built, in review. The owner asked for "a check updates option in the main
application menu, like most apps have" and a link to the GitHub repo in About Hotsauce. The app
already updates itself (`docs/PLAN-mac-self-update.md`); this adds the standard way to ask it now.

## Requirements

C1. The Hotsauce menu has **Check for Updates…** right under About Hotsauce (the standard macOS
    place). It checks the workspace's `/downloads/mac-app.json` at once, the same check the app
    runs at launch and every six hours, and is greyed out while a check runs. [checked on a Mac]
C2. It always answers: "You're up to date" with the version and build; "Hotsauce X is ready" with
    **Restart Now** / Later; "Downloading Hotsauce X…" (then, once the download is checked, the
    ready message comes up by itself); "Hotsauce X is out" with **Download** / Later when this copy
    can't update itself. [UpdateCheckTests]
C3. It says why when it can't check: no workspace yet, the workspace didn't answer (or its
    answer wasn't a Mac app version, which then leaves a download or ready update alone), the
    workspace offers no Mac app (404), or a development build with no version. [UpdateCheckTests]
C6. The "ready" message that follows a download never pops up while dictating or recording (it
    would take the focus the text goes to), never stacks on another of these alerts, and replaces
    that version's Mac notification. [checked on a Mac]
C4. About Hotsauce shows "Open source on GitHub" and a working link to
    https://github.com/hotsauce-suite/hotsauce under the version. [UpdateCheckTests for the
    address; the panel checked on a Mac]
C5. Restart Now uses the existing update path, so it still waits while dictating or recording.
    [same code as the menu bar's Restart to update]

## Not in scope

The menu bar menu keeps showing an update entry only when there is one.
