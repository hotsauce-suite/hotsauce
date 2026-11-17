# Plan: open windows pick up a new release on their own

Status (2026-11-17): built in one slice; decided by Morgan on 2026-11-17 (all three
recommendations accepted).

## Why

A Hotsauce window left open (the Mac app's window, a pinned browser tab) keeps running the web
code it loaded. The service worker takes over open tabs when a new build installs, but the page
already running never re-reads its code, and a single-page app never navigates, so the browser
doesn't even look for the new worker. Haven's server self-updates hourly; on 2026-11-17 Morgan's
Mac window ran 0.39.1 code all night while the server moved to 0.44.0, and a shipped fix looked
broken.

## Requirements (each maps to a test)

R1. Every web build carries its release number (`HOTSAUCE_VERSION` at the repo root, baked in at
    build time). The demo build and the dev server never auto-reload.
    (`apps/web/src/lib/appUpdate.test.ts`, "build version")
R2. The page asks the server which release it runs (`/api/health` `version`) every 10 minutes
    while visible, when the window comes back to the front, and when the connection returns. A
    release different from the build's (newer, or a rollback) marks an update as waiting.
    (`appUpdate.test.ts`)
R3. A waiting update reloads only at a safe moment: the window goes to the background, nobody has
    typed, clicked or scrolled for 2 minutes, or 1.5 seconds after moving to another page.
    (`appUpdate.test.ts`)
R4. It never reloads while: a meeting is being recorded; anything on the page guards leaving
    (unsaved doc, table, form or board; a clip, dictation or Ramble recording; the same
    `beforeunload` guard that asks before closing the tab); a text field (outside the doc editor)
    holds text; a dialog is open. It tries again at the next safe moment.
    (`appUpdate.test.ts`, `safeToReload.test.ts`)
R5. Before reloading it asks the service worker for the new build and waits for it to take over
    (at most 10 seconds), so the reload opens the new code, not the cached old one.
    (`appUpdate.test.ts`)
R6. At most one reload per new release every 30 minutes, so a server whose build can't be
    fetched never makes a page loop. (`appUpdate.test.ts`)
R7. After a reload that brought the new release, a note says "Hotsauce updated to X" (the
    organization's product name) and goes away by itself. (`appUpdate.test.ts`, e2e
    `e2e/app-update.spec.ts`)
R8. Dictating into a text box and Ramble now guard leaving while they record, like Clips, so a
    reload or closing the tab never cuts a recording. (`safeToReload.test.ts`)

## Out of scope

The Mac app's own native update (one-click update and relaunch) is its own thread, "Update the
Mac app in one click".

## Slices

1. All of the above (small, one PR).
