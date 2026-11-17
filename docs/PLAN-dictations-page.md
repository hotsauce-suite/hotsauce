# Dictations on the Dictate page: the Dictate window moves into the app

Status (2026-11-17): building. Step two of docs/PLAN-one-settings.md (Morgan, Q5: "can we move all
the dictate stuff into the app?"). Questions posted with recommended answers; building on those.

## Why

After One Settings, the Mac app's separate Dictate window still held the dictation numbers and
history, and a Dictionary tab that repeats the Dictate page's word lists. Two places for one app.
Now the Dictate page inside the Mac app shows them, read from the Mac, and the window is only a
fallback.

## Requirements

R1. Inside a Mac app that answers, the Dictate page starts with "On this Mac" (`#dictations`):
three tiles (Total words with the number of dictations, Time saved against typing at 40 wpm,
Average speed), Top sources (up to six apps with their words and a bar), the month's activity
grid (Monday first, five shades) with its active days, and Recent dictations. In a browser, or an
older Mac app, the section isn't there and the sidebar doesn't list it.

R2. A range picker (7 days, 30 days, All) sets what the tiles and Top sources count. The month
grid is always this calendar month. Recent dictations are the newest 200, newest first, filtered
by a search over the text and the app's name.

R3. Each dictation shows its app (icon and name), when, an "on this Mac" or "as spoken" tag like
the window had, and its text, with Copy and Paste. Paste goes back to the app the member was in
and pastes there. Copy puts the text on the clipboard.

R4. The numbers are the Mac's own (DictationStats, MonthActivity): the page shows what the Mac
computes, not its own sums.

R5. The page re-reads when the window comes back to the front, when the range or search changes,
and when the Mac says its history changed (a new dictation, Clear history, retention).

R6. The bridge is `hotsauceMacSettings`, the same handler as This Mac (main frame of the suite's
own page only). New requests: `{type:'helloDictations'}`, `{type:'dictations', range, search}`
and `{type:'dictation', id, action: 'copy'|'paste'}`. Parsing is strict; the search is at most
200 characters; an unknown id does nothing and gets no answer.

R7. The menu bar's "Dictate…" opens the main window at Dictate → On this Mac once the page loaded
now has said `helloDictations`; otherwise the old window, which keeps only its Dictations page
(and the Settings fallback). Its Dictionary tab goes: the words are on the Dictate page.

R8. App icons come from the Mac as small PNG data URLs, only for the apps on screen.

R9. An empty history says how to dictate (hold the shortcut, it stays on this Mac); a search with
no match says so.

## Slices

1. DictateCore: request parsing and the reply builder (Swift tests).
2. App: the handler, the history-changed event, the icons, "Dictate…" routing, the window trimmed.
3. Web: client and parser, the section, the sidebar item (vitest against a fake Mac).
4. Support: help center (Dictate, Mac app), Mac app README, STATUS.

## Not in this change

- Dictation text never leaves the Mac: the server and the demo don't see it, so the demo has no
  such section.
