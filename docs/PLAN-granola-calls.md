# Plan: calls like Granola (Mac app)

## Status
2026-11-23. Slice 1 (requirement 1) merged in #229; requirements 2 to 5 merged in #230 (0.65.2). Waiting on a real Google Meet check on Morgan's Mac.

## Why
A Google Meet in Chrome was recorded from the Start page inside the Mac app with "Meet tab + mic". The
app's WebKit window grants a window share with video and no audio track, so only the mic was
recorded, and the Mac app never offered "Take notes?" because browsers didn't count as calls.
Morgan asked for Granola's behaviour: any video call is noticed, one button starts the notes.

## Permissions (what can't be avoided)
macOS asks once for the Microphone and once for System Audio Recording (the process tap). Granola
asks for the same two. Nothing else is needed for calls: naming a browser call reads window
titles through Accessibility, which Dictate already has; without it the call is named for the
browser. Safari calls aren't noticed: Safari's mic runs in WebKit's shared GPU process, which the
app's own window uses too.

## Requirements
1. In the Mac app the Start page offers no "Meet tab + mic" choice and no extension hint
   (`StartMeeting.test.tsx`).
2. A browser holding the mic counts as a call: Chrome (and its helpers and installed web apps),
   Arc, Dia, Edge, Brave, Firefox, Vivaldi, Opera, Chromium; Safari doesn't (`MicAppsTests`).
3. A browser call is named for the service in its windows' titles: Google Meet, Microsoft Teams,
   Zoom, Webex, Whereby, Slack, Discord; otherwise the browser's name (`MicAppsTests`).
4. A call shows a card at the top right, "Meeting detected" (or the calendar meeting's title) and
   the app, with one Take notes button that opens the meeting, which listens to the Mac at once.
   It never takes focus, leaves after 90 s or when the call ends, and records nothing by itself.
5. The Chrome extension has no offer of its own (it only acts when its icon is clicked), so a
   Meet in Chrome gets one offer.
