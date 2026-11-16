# Offline mode

## Status

- **Step A (PR #102, `offline-step-a`): built, reviewed and tested; merging 2026-11-16.** The app opens with no connection,
  starts as the last signed-in member, shows an Offline bar, greys out what needs the server, and
  Docs never lose a save. A5: the Mac app's window runs the service worker (checked on
  2026-11-15 with a WKWebView configured like the app's, against a local server and against
  hotsauce.havenbiosec.com: registered, installed, controlling; with the server stopped, the
  window opened the cached app with the Offline bar, not the retry page). No Mac app change
  needed.
- Step A2 (Dictate on the Mac with no connection): built and tested (PR #143); on-device speech waits on the Speech Recognition permission on this Mac and the owner’s own check with Wi-Fi off.
- Step B (read recently used things offline): not started.
- Step C (edit offline, sync when back): not started.
- Approved by the owner on 2026-11-15 from the scope page (three steps, A then B then C; skip a
  full local-first rewrite).

## Why

Today the installed web app keeps its screens on the device but none of the data, and sign-in
needs the internet, so with no connection every page fails and the app can't even start. Hotsauce
is already half-built for offline: every doc is a file with a version, and the server already
merges a save made from an older version or sets a clash aside on a conflict branch. Offline work
needs the app to keep copies on the device, hold changes while offline, and send them on return.

## Step A: never lose what you typed

Each requirement maps to a test at a public boundary. Playwright offline tests
(`context.setOffline(true)`) cover the critical journeys only.

**A1. The installed app opens with no connection.** The service worker precaches every screen of
the app: the shell and every route chunk built from our own code, with their CSS and fonts.
Library extras loaded on demand (CodeMirror language modes, diagram renderers, Whiteboard's
locales and its WebAssembly) stay cache-on-first-use. Precaching happens in the worker's install,
after the page has loaded, so it doesn't slow the first load.
- A1.1 The precache list holds every chunk reachable from the entry and from our own lazy routes,
  and none of the on-demand library chunks (unit test on the selection).
- A1.2 After the worker is ready, a screen never opened before still opens offline (e2e).

**A2. Offline start past sign-in.** If the server (or Clerk) can't be reached at start, the app
starts as the last signed-in member instead of the error page or the sign-in screen.
- A2.1 The device remembers only the member's id, name, email and the workspace name, plus the
  instance's public start-up facts (sign-in mode, names, brand), after a successful start.
- A2.2 Signing out forgets the member (both sign-in modes).
- A2.3 A start that can't reach the server, with a remembered member, opens the app as that
  member; with no remembered member it shows "You're offline" with sign-in needing a connection,
  never the raw error. A start that can't reach the server and has nothing remembered keeps
  today's "isn't reachable, trying again" page.
- A2.4 When the connection comes back, the app reloads into the normal sign-in, so the real Clerk
  session takes over; if it expired, the member signs in again and everything held on the device
  (A4) is still there and sent after.
- A2.5 e2e: sign in, go offline, reload: the app opens as the member, no error page.

**A3. A clear Offline bar, and what needs the server says so.**
- A3.1 The app is offline when the browser says so, or when a request to the server fails to
  connect; it's back when the browser is online and the server answers again (unit test on the
  connection state).
- A3.2 While offline, a bar under the top of the app says "Offline" and what still works.
- A3.3 Actions that need the server (Ask, Briefcast, Enhance, sharing, the team chat link,
  uploads) are greyed out with "Needs a connection".
- A3.4 A screen opened while offline that has nothing on the device shows "Not available offline
  yet" (with a list of docs kept on this device), never a raw error. A screen already open when
  the connection drops keeps what it shows.
- A3.5 e2e: the bar appears offline, Ask is greyed out, and goes away online.

**A4. Docs never lose a save.**
- A4.1 A save that fails because the app is offline is kept on the device (the existing draft
  store, keyed with its base version, marked as waiting to send) and the save chip shows "Saved
  on this device" (`data-testid="save-state"`, new `data-state="offline"`).
- A4.2 When the connection is back, the open doc sends it at once with its base version, so the
  server's merge or conflict path applies.
- A4.3 A doc with a waiting save opens from it when offline, and sends it automatically when it
  opens online (no "restore" prompt for a waiting save).
- A4.4 Waiting saves for docs that aren't open are sent when the app starts online or the
  connection comes back. A conflict is kept on the server's conflict branch, as today, and the
  member is told; a doc deleted meanwhile keeps its text on the device.
- A4.5 e2e (the critical journey): open a doc, go offline, type, see "Saved on this device",
  reload offline, the doc opens with the text, go online, the text is committed.

**A5. The Mac app.** Check whether its window (WKWebView) runs the service worker for the remote
site. If it does, the window shows the cached app offline instead of its retry page. If it
doesn't, record it here as a step B item and leave the Mac app as it is.
- Result: it does (see Status). The window's own "can't reach" page appears only when a load
  fails, and a load the service worker answers doesn't fail, so nothing changes in the app.

**Hardening from two audits (2026-11-16).** Each has a test:
- A4.6 Drafts belong to one member and one tab (`hotsauce.draft:<owner>/<tab>/<space>/<path>/
  <blobOid>`). Another member on the same browser is never offered, shown, sent or able to erase
  them; two tabs never erase each other's. Drafts saved before this (`hearth.draft:`) are still
  read and offered for restore online, never opened offline or sent by themselves.
- A4.7 A draft's owner is never downgraded: a sign-in that expired offline (a 401 that signs the
  member out) leaves the text waiting as theirs, sent once they sign in again.
- A4.8 A write the device's storage refuses keeps the last good copy, says "Couldn't keep this on
  the device" instead of "Saved on this device", and keeps the leave-page warning.
- A4.9 A waiting save the server refuses for good (the doc was moved, renamed or deleted, or
  access changed) is kept as "stranded", named in a message with the reason, and listed in Docs →
  Kept on this device (copy or discard there); the doc's "isn't here" page points to it. Not
  followed to a moved doc's new place: there's no id lookup on the server yet (step C).
- A2.6 Sign out pressed offline is owed on the device and done as soon as sign-in loads again,
  before anything opens as that member. Settings (where Sign out is) opens offline.

**From the independent review before merge (2026-11-16).** Each has a test:
- A4.10 Only a save left *waiting* opens a doc offline and is sent by itself; an old copy left
  when a tab closed online is offered to restore once online, never sent on its own.
- A4.11 Stranded text is removed only by Discard in Kept on this device, never by later typing
  or saving at the same path.
- A4.12 A save another open tab is still typing into is left for that tab to send (open tabs
  write a heartbeat, `hotsauce.tab-alive:<tab>`); a closed tab's is sent by whichever tab is left.
- A4.13 A comment's kept draft belongs to the member who typed it, like a doc draft; offline,
  the comments under a doc say they need a connection.
- A1.4 The service worker leaves `/mcp` and `/.well-known/` (MCP sign-in) to the server.

Not in step A: an organization switch to turn offline off (step B, when real data is stored),
reading docs never opened on this device, new docs made offline.

## Step A2: Dictate on the Mac with no connection

Approved by the owner on 2026-11-15 as a small extra after step A. When the Hotsauce server
can't be reached, the Mac app's dictation key still types, using Apple's on-device speech
recognition (`SFSpeechRecognizer` with `requiresOnDeviceRecognition`; it runs on every macOS the
app supports, so there is one path, not two). When the server is reachable, nothing changes.

- A2.1 The app picks on-device speech at the key press when the Mac has no network, or when the
  server failed to answer in the last minute (`SpeechRoute.choose`, pure, in DictateCore).
- A2.2 A dictation sent to the server that can't reach it (the stream and the upload both fail
  with a network error) is written up on the device from the same recording instead of waiting
  for Retry; it is still kept for Retry if on-device speech can't write it up either.
- A2.3 The hotkey never waits on a dead connection: the key press starts recording at once in
  every case, and a stream that never got the server's "ready" gives up within 3 seconds of
  key-up (not 25), so the upload or the device takes over quickly.
- A2.4 While recording on the device, the pill says "Offline: on-device".
- A2.5 Speech Recognition permission is asked for only the first time on-device speech is needed,
  with a plain explanation (`NSSpeechRecognitionUsageDescription`). If it's refused, the pill says
  where to turn it on.
- A2.6 On-device dictation never sends audio anywhere: no stream, no upload, and the recognizer
  is told to stay on the device.
- A2.7 The language is the Mac's own (the app has no dictation language setting; the server
  picks one), falling back to English (US) when the Mac's language has no on-device model. Only
  languages whose model is on this Mac count; a language without its region picks the Mac's
  region, else the same one every time; Chinese picks by script (Simplified: zh-CN).
- A2.8 When no language the Mac could use has an on-device model, the pill says so and where to
  get one (System Settings → Keyboard → Dictation).
- A2.10 (from review) A server that's on the network but not answering costs seconds, not
  minutes: after a stream that never got "ready" the upload gives up after 10 s of silence; a
  "ready" that arrives after key-up gets the full 25 s (a short dictation is never sent twice).
  On-device recognition gets 30 s, or 1.5 times the dictation's length if longer. A recording
  kept for Retry stays kept until it is itself sent, and one the server couldn't take but this
  Mac heard nothing in is kept for Retry too.
- A2.9 On-device dictations are typed and kept in history like any other, marked "on this Mac",
  without the server's clean-up (that needs the connection) and without the word list.

## Step B: read anything you've used recently

- B1. A device copy for Tasks and Notes, refreshed in the background while online.
- B2. A device copy for Docs, Links and meeting notes opened in the last 30 days, plus pinned and
  starred.
- B3. Search over the device copy, labelled "Searching what's on this device".
- B4. "Keep offline" for a folder or space, with the space it uses shown in Settings.
- B5. Sign-out wipes the device copy; an organization switch turns offline copies off.

## Step C: edit offline, sync when back

- C1. Server: a change sent twice saves once; new items can arrive with their own id.
- C2. An outbox on the device and a "changes waiting" chip, with Tasks first.
- C3. Notes and Links on the outbox (a link saved offline keeps the URL; the page copy is fetched
  once back).
- C4. Docs on the outbox, including new docs made offline and the clash picker on reconnect.
- C5. The clash picker for Notes and Tasks; help docs, landing page FAQ and demo updated.
