# Plan: the Android app and its home-screen widgets

## Status

- 2026-11-25: decisions settled (Morgan: "yes to all"). Slice 0 merged (#238), slice 1 (server,
  R4–R7) merged (#248). `GET /api/dictation/devices` lists Macs unless `?kind=phone|all`, so the
  web's Mac checks keep reading it as "this member's Macs". Slice 2 in progress: /phone/connect,
  Settings → Apps → Android app (phones listed, Disconnect), and the app's connect flow and Today
  widget (R8–R11). No emulator in the cloud: the widget's logic is unit-tested, and its look is
  checked on Morgan's phone after slice 3.
- Google Play developer account: Morgan's personal account, verified 2026-11-24.

## Why

On Android, Hotsauce is the installed web app. It has long-press shortcuts and the share sheet,
but a web app can't put a live widget on the home screen. A small native app can: the next
meeting with a Join button, today's tasks to tick off, quick capture, a voice note button.

## Decisions (Morgan, 2026-11-25)

1. **A Chrome shell, not a built-in browser.** The app is a Trusted Web Activity: it opens the
   Hotsauce server in the phone's Chrome with no address bar. Sign-in (Google blocks it in
   embedded browsers), web push, the service worker and offline all behave as they do in Chrome.
   The widgets are native (Jetpack Glance).
2. **Any server.** First open asks for the server's address (prefilled when the app was opened
   from a link on a server). Every Hotsauce server serves `/.well-known/assetlinks.json` naming
   the app's signing fingerprint, so the shell opens full screen on any of them.
3. **Ships to Play internal testing** for Haven. A public listing is a later decision.
4. **Connecting the phone.** After sign-in the app asks "Show your Hotsauce on this phone's home
   screen?". Allow creates a device token like the Mac app's, listed with the member's other
   devices and revocable there. A phone token may only read the widget summary and do the
   widgets' few writes (tick a task, add a task or note, send a voice note).
5. **Today at a glance first**: next meeting with Join, top 3 tasks due today, weather. Refreshes
   about every 15 minutes (WorkManager's floor), when the app opens, and on tap.
6. **Then** Tasks checklist, Quick capture bar, Voice note button.
7. **Mac**: a Mac desktop widget with the same Today card follows in its own thread.
8. **Name and look**: "Hotsauce", the Tuned bottle icon, the app's colours, light and dark with
   the phone.
9. iPhone live widgets are out of scope until the Apple Developer account exists.

## Requirements

Each maps to a test named for it.

- R1. `apps/android` builds a signed release bundle (AAB) and a debug APK on GitHub Actions; the
  build fails on lint errors.
- R2. The app's package id is `work.hotsauce.app`; version code and name come from the release
  number, so every release builds a higher version code than the last.
- R3. First open asks for a server address, accepts `hotsauce.example.com` or a full `https://`
  URL, refuses anything else with a plain message, and remembers it.
- R4. The server serves `/.well-known/assetlinks.json` with the app's fingerprints (from the
  `ANDROID_CERT_SHA256` setting, comma-separated; the published app's fingerprint by default).
- R5. A signed-in session can create a phone device token (only after the member presses Allow
  on /phone/connect); the response is the only time the token is shown. It is listed with kind
  "phone" (`GET /api/dictation/devices?kind=phone`) and can be revoked there or from the phone;
  the device cap (20) is per kind.
- R6. A phone token can call only `GET /api/widgets/today` and `DELETE` of its own device
  (slices 4 to 6 add the task tick, capture and voice-note routes, each to this list); anything
  else, `/mcp` and `/ws/dictation` included, is refused with 401, and a Mac's token and a phone's
  are never interchangeable. Revoking the device, deleting the member or the domain lock refuses it.
- R7. `GET /api/widgets/today` returns the next meeting (title, start, end, join link), up to 3
  tasks due today or overdue (id, title, due) and how many are due, the weather for the phone's
  position or the team's place (or none), and the server's time, with no attendees, notes or
  docs. It never waits more than 2 s for a forecast MET hasn't given yet; otherwise it is one
  Today read (index and calendar cache, inside the API budget).
- R8. The Today widget renders that summary in 4×2 and resizes to 2×2 (meeting only) and 4×3
  (meeting + 5 tasks); it shows the last good data with "Updated 10:42" when offline, and "Open
  Hotsauce to connect" when there's no token.
- R9. Tapping Join opens the meeting's join link; tapping a task or the meeting opens it in the
  app; tapping the widget's refresh mark refreshes it.
- R10. A revoked token (401) clears the stored token and the widget asks to connect again.
- R11. The token is stored with Android Keystore-backed encryption, never in plain prefs, and is
  removed when the app's data is cleared.
- R12. GitHub uploads each release's bundle to Play internal testing when the Play secret exists,
  and skips that step (green) when it doesn't.

## Slices

0. Android project skeleton (TWA shell + server address screen + empty widget) and its GitHub
   build. No shared files.
1. Server: assetlinks, phone device kind, the widgets endpoint and the token's allow list
   (touches `api/middleware.ts`, so it waits for the shortcuts work and is announced first).
2. App: connect flow and the Today widget.
3. Play internal testing upload; Morgan installs from the testing link.
4. Tasks checklist widget. 5. Quick capture bar. 6. Voice note button.

## What Morgan does

- Google Play developer account ($25; steps page https://claude.ai/artifact/G1xD6RbESmqZsrFWAyz49w).
- After slice 3's first bundle: create the app entry in Play Console and let GitHub upload
  (added to the same page then).
