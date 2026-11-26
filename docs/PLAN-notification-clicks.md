# Plan: notification clicks open Hotsauce

## Status

Built 2026-11-26. Morgan reported that clicking Chrome's "Your Briefcast is ready" notification
did nothing. Waiting on Morgan's real Chrome check (Settings → Notifications → Send test
notification, then click it).

## Problem

Every server notification (meeting and task reminders, check-ins, mentions, Briefcast) goes
through `apps/web/public/push-sw.js`. Its click handler took the first Hotsauce window the browser
listed, posted it a navigate message, and then tried to focus it, swallowing any failure. When the
window it picked couldn't be brought forward (a frame inside a page, a server page like an
`/api/` PDF, a tab Chrome refused to focus), the click did nothing, with no fallback.

## Requirements

1. A click with no Hotsauce tab open opens the notification's page in a new tab.
2. A click with a Hotsauce tab open brings that tab forward and moves it to the page in-app,
   never by a reload (a reload ends a meeting being recorded there).
3. Of several open tabs, the click uses the one in front, else one on screen, else the most
   recent. Frames inside a page and pages the server answers itself (`/api`, `/mcp`, …) are
   never used.
4. When the tab can't be brought forward, a new tab opens instead.
5. A click never leaves the site; a notification without a page opens Today.
6. The screen-break notification (shown while Hotsauce is in the background) brings Hotsauce
   forward when clicked.
7. Mac app notifications (meeting reminders, call offers, updates) already open the app at the
   right place (`Reminders.swift` delegate); unchanged.

## Tests

- R1–R5: `apps/web/src/lib/pushSw.test.ts` runs `push-sw.js` against a fake worker scope.
- R2 in a real browser: `e2e/notification-click.spec.ts` (inside the real service worker; a
  headless browser can't click a system notification).
- R6: a one-line `onclick` in `apps/web/src/breaks/breaks.ts`, checked by hand.
