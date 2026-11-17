# One Settings: the Mac app's settings move into Settings → This Mac

Status (2026-11-17): building. Morgan answered the questions: Q1, Q2, Q4, Q6 as recommended; Q3 add the microphone picker now; Q5 move the Dictate window into the app next. Morgan (Nov 17): "It's confusing that we have settings
within the Hotsauce UI, but also a standalone settings for the app" → "do it".

## Why

The Mac app had two Settings: the web app's (in the main window) and its own native window (⌘,).
People couldn't tell which held what. Now there is one, the web app's. Inside the Mac app it gains a
"This Mac" page with everything the native window had. The values still live on the Mac (they are
about this Mac, not the member), read and written through a bridge, like "Any app on this Mac".

## Requirements

R1. Inside a Mac app that answers the settings bridge, Settings' menu starts with "This Mac"
(`/settings/mac`). In a browser, or an older Mac app, it isn't listed, and `/settings/mac` says the
page is in the Mac app and links Settings → Apps.

R2. The page shows the values the Mac reports, read when it opens and again when the window comes
back to the front. Every change goes to the Mac, and the page shows what the Mac answers back, not
what it asked for.

R3. Dictation: the shortcut (Right Option, Right Command, Fn / Globe, Right Control, Right Shift),
Clean up or Literal with a line explaining the chosen one, and Edge glow while dictating.

R4. Meetings: Meeting reminders and "Offer to take notes when a call starts". While macOS has
notifications off for the app and either is on, a note says so with a button to macOS's
Notifications settings.

R5. This Mac: Open at login, and Show in menu bar (with the notch hint while it's on but macOS hides
the icon).

R6. Permissions: Microphone, Accessibility, Location and Notifications, each showing whether it's
allowed, with an Allow button while it isn't; and "Run setup again".

R7. History: keep dictation history for 7, 30 or 90 days, and Clear history. Both confirm in a Mac
dialog first when they delete anything.

R8. Account: who this Mac's Dictate is connected as, and "Disconnect this Mac".

R9. The bridge (`hotsauceMacSettings`) answers only the suite's own page in its main frame, and
parses strictly: an unknown request, key or value changes nothing and gets no snapshot. Values are
validated against the same lists the native window used.

R10. ⌘, and the menu bar's Settings… open the main window at Settings → This Mac. The Dictate
window loses its Settings tab.

R11. When the main window can't show This Mac (no workspace yet, the workspace can't be reached, or
its web app is older than this page), ⌘, opens a small native window instead: the workspace address,
the permission rows, "Run setup again" and Clear history (dictation text is only on the Mac). The app knows the page exists because the page says hello
over the bridge when it loads.

R12. The first-launch "Set up Hotsauce" window is unchanged.

R13. Settings search covers every setting on This Mac (each section and each row), only inside the
Mac app (Morgan, Nov 17: "include all the stuff we're moving").

R14. Microphone for dictation: "Mac's default" or any input the Mac has, by its Core Audio UID. A
picked microphone that's unplugged shows as "Not connected", and dictation uses the default until
it's back. Meeting recording in the Mac app keeps the Mac's default (its echo cancelling is fussy
about devices); the page says so. (Morgan, Q3: "add microphone picker now".)

## Slices

1. Web: the page, its bridge client and the menu entry, tested against a fake bridge (R1–R8, web
   half of R9 and R11's hello).
2. Mac: `MacSettingsBridge` in DictateCore (parsing, snapshot; Swift tests), the handler in the
   suite window, ⌘, routing and the trimmed fallback (R9–R12). Built and signed on m5Box.
3. Support: help center, Mac app README, landing page's Mac app window, demo note, screenshots.

## Not in this change

- Dictate's voice model: kept per member on the server, edited in Settings → Apps (its own thread).
- The Dictate window's word counts and recent dictations: the next step (Morgan, Q5: "move all the
  dictate stuff into the app"). They go on the Dictate page inside the Mac app over the same kind of
  bridge, and the Dictate window retires. Word lists are already on the Dictate page.
