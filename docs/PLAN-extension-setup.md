# Plan: the Chrome extension's setup page and instructions

**Status (2026-11-22):** building, extension 0.8.0. Morgan accepted the plan
(https://claude.ai/artifact/T3AXMcQVCptypmXaFYzi58) and all five recommendations: its own page
inside the extension, ship as 0.8.0 in place of the not-yet-uploaded 0.7.0, a test call step,
the Mac app stays quiet for browser calls (explained in the help), and a Getting started step.

## Why

The extension worked but explained itself badly: installing opened nothing, connecting was a
form in the popup, the shortcut and version were nowhere, and the how-to for recording a Meet
call was spread over three pages with no troubleshooting.

## Requirements

1. Installing the extension opens its setup page once. Updates and reloads don't.
2. The setup page is also the extension's options page (right-click the icon → Options) and the
   popup's Settings link.
3. The setup page shows three steps, each ticked from what is really so:
   - Connect to your workspace: done once a server is chosen (typed, or the copy's own).
   - Pin the icon: done when Chrome says the action is on the toolbar.
   - Try it on a Meet call: done once the popup has shown Take notes on a call. Its button
     opens a new Meet call (meet.google.com/new); nothing records.
4. Connecting from the setup page uses the same connect as the popup (Chrome asks for that site).
5. The settings part shows the connected workspace with Change, the keyboard shortcut Chrome has
   for the icon (or "not set") with a button to Chrome's shortcut screen, the version and how it
   updates (from the Web Store by itself, or by hand from the workspace), and help links.
6. The popup's footer has Settings, How it works and Change server.
7. The in-app page (Meetings → Chrome extension) shows whether the extension is found in this
   browser and its version, and says when a newer version is ready (the server's own build).
8. The in-app page shows Add to Chrome when the Web Store listing is set, with the by-hand install
   under it; until then the by-hand steps alone.
9. The in-app page and the help center give the steps for a Meet call, troubleshooting, and how
   the extension and the Mac app fit together on a Mac.
10. Today's Getting started offers "Get the Chrome extension" in desktop Chromium browsers (not
    the Mac app, not phones), ticked once the extension answers on the page.
11. The Mac app's Help menu has "Chrome Extension…", which opens the in-app page.
12. The help center page, the landing page FAQ, the extension README and docs/STATUS.md describe
    the new screens.

## Not doing

- A guard against recording one call twice from two places (the Mac app and Chrome). The "a
  meeting is being recorded" screen only knows about the page it's in. The help says to use one
  or the other; a server-side guard would be its own piece of work.
- The Mac app offering "Take notes?" for calls in a browser (Morgan, 2026-11-22: keep quiet).
- Detecting an open Hotsauce tab from the setup page (needs the `tabs` permission; the popup's
  one-click connect already covers it).
