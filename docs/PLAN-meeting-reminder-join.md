# Plan: join and take notes from the meeting reminder (Mac app)

About a minute before a calendar meeting, the Mac app's reminder offers to take notes. One click
opens the meeting's call link and starts the notes; "Just take notes" starts the notes only. When
the call itself starts, call detection doesn't add a second offer on top.

## Status

Both slices built on `claude/project-thread-xu6qxn` (PR #174): the reminder joins and starts notes,
and the call offer replaces a reminded meeting's reminder. `swift test` and the Mac build run on
the owner's Mac before merge; the notification buttons are checked there by hand.

## Decisions (owner, 2026-11-17)

- Timing stays about a minute before the start (`ReminderPlanner.lead`, 90 s window).
- Clicking the reminder opens the call link and the notes page for that event; a second button,
  "Just take notes", skips the link.
- Notes start by themselves after that click: the click is the member's "take notes". The same
  holds for the call notice ("Take notes on this Zoom call?").
- Reminded events: any with other people invited or a call link. Neither (a focus block): nothing.
- One offer at a time: notes already running means no call offer (already true); a reminder that
  was ignored is replaced by the call offer, named for the meeting, when the call starts.
- No new setting: all of it sits under the existing "Meeting reminders" switch.

## Requirements

1. **Linked events are reminded.** An event with a call link and nobody else invited is reminded;
   one with neither isn't. Same rule on the server's web push and in the Mac app.
   *(tests: `reminders.test.ts` "meeting link", `SuiteRouterTests` "call link")*
2. **Only web links are joined.** The link opened is `https`/`http` with a host; a `file:`,
   `javascript:` or app-scheme link in an invite is never opened. *(test: `joinsOnlyWebLinks`)*
3. **The reminder opens Start in notice mode.** Its page is
   `/meetings/start?event=<id>&via=mac-reminder`. *(test: `startPathEncodesTheId`)*
4. **Join and take notes.** A click on the reminder, or its "Join and take notes" button, shows
   the app's window on that page and then opens the link, so the call ends up in front;
   "Just take notes" opens only the page. A reminder without a link has only "Just take notes".
   *(Mac check on m5Box: notification actions can't run in `swift test`)*
5. **Notes start without a click.** In the Mac app, `via=mac-reminder` or `via=mac-call` listens to
   the Mac at once and starts recording as soon as the sound check settles and the event has
   loaded, titled for the event and linked to it. Silent call audio (nobody joined yet) doesn't
   hold it up. *(tests: `StartMeeting.test.tsx` "calendar reminder", "call notice")*
6. **Outside the Mac app, nothing records by itself.** The same link in a browser only fills in
   the page. *(test: "opened outside the Mac app")*
7. **One offer, not two** (slice 2). When a call starts from 5 minutes before a reminded meeting
   to its end (30 minutes when the invite has no end) and no notes are running, the reminder is
   withdrawn and the call offer is titled for the meeting, opening
   `/meetings/start?event=<id>&via=mac-call&app=<app>`: named for the event, started at once, and
   ending with the call. Notes already running: the reminder is withdrawn and nothing is offered.
   *(tests: `matchesACallToTheMeetingItWasRemindedFor`, `callStartPathNamesTheEventAndTheApp`,
   `StartMeeting.test.tsx` "call notice for a reminded meeting")*
