# Plan: the first-run tour and the Hotsauce 101 page

## Status

2026-11-19: decisions settled with the owner (plan page https://claude.ai/artifact/P6cuHvEqMBaBK6BNfG1qUa;
he accepted every recommendation, Q1 to Q10). Building. Slices 1 to 3 done (server, the tour, Hotsauce 101 with For you and Tables added to hotsauce.work); slice 4 is checks, review and the Mac check.

Asked for by the owner: "a tooltip walkthrough when the user logs in for the first time, on both web
and desktop, and enable them to trigger it again from settings", and "a page in settings that's a
built-in Hotsauce 101 page that explains briefly what each tool is, like the public website, with a
screenshot and the animation". Everything here works in the Mac app too: it shows the same web pages.

## Decisions

- A tooltip tour over the real controls, 13 stops, all on Today and the rail, so nothing navigates
  mid-tour. Stops that don't apply (no AI key, no For you tile, no Getting started tile) or whose
  control isn't on screen are skipped.
- Opens with a welcome card: **Show me around** / **Not now**. Everyone sees it once, including
  members from before it existed. Not on phones (under 768px): it waits for a computer visit.
- Seen is one fact per member in `account.sqlite` (backed up, mirrored, not in Git), so the web and
  the Mac app agree. Done, Skip, Not now, Esc and leaving mid-tour all count as seen.
- Replay: **Take the tour** in the account menu (under Help) and in Cmd-K. Opens Today at stop 1.
- Library: Driver.js (MIT, no dependencies), loaded only when the tour starts. Shepherd.js and
  Intro.js are AGPL and ruled out.
- Breaks (screen-break reminders, another thread, hotsauce #201) is a setting: the account-menu stop
  names it beside Music, and the Today card in Hotsauce 101 mentions it. Its own offer lives on the
  Getting started tile, owned by that thread.
- The live demo runs the tour on a visitor's first visit (remembered in that browser).
- **Hotsauce 101** is a Settings page for everyone, after Apps: a card per app with its picture, what
  it's for, whether it's ready here (or what it needs, in plain words), and Open. Every app shows,
  ready ones first. Clicking the picture plays that app's loop in place, muted.
- The loops ship inside the app (about 4 MB, loaded only on click; never fetched from hotsauce.work).
- hotsauce.work and Hotsauce 101 read one shared list of app descriptions. Tables and For you get
  cards and loops (on the site too).

## Requirements

Each maps to a test, named in brackets.

**Server**

- S1. `GET /api/tour` answers `{ seen: false }` for a member who hasn't seen it, including every
  member from before this release. [integration api.test]
- S2. `POST /api/tour/seen` marks it seen for that member only, and is safe to repeat; it survives a
  restart (it is in `account.sqlite`). [integration api.test, account store.test]

**The tour**

- T1. A not-seen member on a computer opening Today gets the welcome card; a seen member, a phone
  width, a recording meeting, shared links, sign-in and setup don't. [Tour.test, e2e tour.spec]
- T2. Show me around walks the stops in order; Back and the arrow keys go back; a stop that doesn't
  apply or whose control isn't on screen is skipped; the last shown stop says Done. [Tour.test]
- T3. Not now, Skip, Esc, Done and leaving mid-tour each mark it seen, once. [Tour.test]
- T4. The workspace's name comes from the server. In the Mac app the Dictate stop says Right Option
  and the menu stop mentions This Mac; on the web they don't. [Tour.test]
- T5. The tour's code isn't in the first page load. [build check]
- T6. Keyboard only can finish it; focus stays in the tooltip; no motion with reduced motion on.
  [Tour.test, e2e tour.spec]
- T7. The live demo runs it on a first visit, remembered in that browser. [mocks test]
- R1. "Take the tour" in the account menu and in Cmd-K opens Today and starts at stop 1, seen or not.
  [Tour.test, e2e tour.spec]

**Hotsauce 101**

- H1. Settings lists Hotsauce 101 for everyone, after Apps, with a card for every app in the suite.
  [settingsPages.test, Guide.test]
- H2. The site and the page read the same descriptions; a test fails when an app has no description,
  picture or video. [guide content test]
- H3. Each card shows Ready, or what it still needs in plain words, and an Open button; ready ones
  come first. [Guide.test]
- H4. Clicking the picture plays that app's video in place, muted; Esc or Close stops it; no video
  loads before the click. [Guide.test, e2e tour.spec]
- H5. Cmd-K has "Hotsauce 101" and finds each app's card by name. [Guide.test]

**Journeys**

- J1. Real browser: a new member walks the tour to the end, reloads and doesn't see it, replays it,
  opens Hotsauce 101 and plays a video. [e2e tour.spec]
- J2. In the Mac app on the owner's Mac: the tour after setup, the Mac-only stops, a video playing.
  [manual check]

**Support materials**

- M1. Help pages for Today and Settings, the FAQ, What's new, the live demo, new Tables and For you loops
  on hotsauce.work. [real-browser check]

## Slices

1. Server: the seen flag (S1, S2).
2. The tour, replay and the demo (T1 to T7, R1, J1 part).
3. Hotsauce 101 (H1 to H5, J1 part).
4. Tables and For you cards and loops, help pages, Mac check (M1, J2).
