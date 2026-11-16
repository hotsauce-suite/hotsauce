# Plan: a new member's first ten minutes ("Getting started" on Today)

## Status

2026-11-16: both slices built. Slice 1 (the tile, the Connect calendar button, the replay link,
help pages, the demo and the Today loop) merged as #119. Slice 2 (the start-here doc an admin
picks, H1 to H3) is its own pull request. Every requirement below has a passing test. Decisions
settled with the owner on 2026-11-15 (options page:
https://claude.ai/artifact/7aHzYDrEhJwGqT3dBKPgfY; he accepted every recommendation).

Why: a new member signed in and landed on a nearly empty Today with no hint of what to do. The
one step that fills Today (the calendar) read like an error, and the Mac app card was the last
thing on the page.

## Decisions

- A **Getting started** tile at the top of Today, not a welcome pop-up and not only better empty
  screens. The grey "calendar isn't connected" sentence becomes a proper button in the same change.
- Three steps: **Connect your calendar**, **Get the Mac app** (on a phone or tablet: **Add
  Hotsauce to your Home Screen**), **See where the team's work lives** (opens Docs; slice 2 lets
  an admin point it at one doc).
- Everyone sees it once, including members who joined before it existed. Steps already done arrive
  ticked.
- **Hide** removes it at once, on every device, with no confirmation. When every step is done it
  says "You're set" and is gone the next time Today opens.
- Replay: a **Getting started** link in the help strip under the Settings menu, and the tile is in
  Today's "+ Add tile" list.
- No new storage: the tile is a tile. Whether it has been dealt with lives in the member's Today
  layout file, in Git.

Known and accepted: a browser tab still running the previous release shows the tile as an unknown
kind, and its Edit Today fails until the tab reloads (new versions install themselves).

A fact found while building: a calendar is connected by signing in with Google and allowing
calendar access; there is no separate connect button. A member who signs in with an emailed code
can't connect one, so for them step 1 stays open until they hide the tile.

## Requirements

Each maps to a test, named in brackets.

**Format and server**

- F1. `start` is a tile kind, single-use. A `start` tile may carry `openedDocs: true`; other kinds
  drop it. [format today.test]
- F2. A saved layout with no `start` tile is written with `gettingStarted: "dismissed"`; one with
  the tile is written without it. Parsing reads the mark back. [format today.test]
- F3. `offerGettingStarted(layout)` puts a fresh `start` tile first in the left column unless the
  layout already has one, is marked dismissed, or is full. `showGettingStarted(layout)` does the
  same regardless of the mark (replay), and leaves a layout that has the tile alone.
  [format today.test]
- F4. `GET /api/today/layout` offers the tile on the default layout and on a saved layout from
  before this feature; a layout saved without the tile afterwards doesn't get it back. A member
  with no personal space, who couldn't save hiding it, isn't offered it.
  [integration today-layout.test]
- F5. `GET /api/today` says `meetings.connected: false` when the member has no calendar grant, and
  `true` otherwise (including a calendar that failed to load just now). [integration today.test]

**The tile**

- T1. The tile lists its steps with a count ("1 of 3"). Calendar is done when the calendar is
  connected. Mac app is done inside the Mac app or once a Mac is connected; on a touch device the
  step is "Add Hotsauce to your Home Screen", done in the installed app. A server with no Mac
  build has no Mac step on a computer. Docs is done once "Open Docs" was clicked. [StartTile.test]
- T2. "Open Docs" records the step in the layout and opens Docs. [StartTile.test]
- T3. "Hide" saves the layout without the tile; it disappears at once. [StartTile.test,
  e2e getting-started.spec]
- T4. With every step done the tile says "You're set", saves the layout without the tile once, and
  stays for this visit. A later save in that visit doesn't put it back. A calendar that is
  connected but failed to load just now is not known either way: it is neither ticked nor
  offered, and the tile doesn't finish on it. When "Open Docs" is the last step, the tile isn't
  saved away as the member leaves: "You're set" shows the next time Today opens. [StartTile.test,
  e2e getting-started.spec]
- T5. While the tile shows, the separate "Get the Mac app" card at the bottom of Today doesn't.
  [StartTile.test]
- T6. The Meetings tile, with no calendar connected, says what connecting gives you and has a
  "Connect calendar" button to Settings → Connections. Another calendar error keeps its sentence
  and its Settings link. The server's own sentence (which says how to connect) stays under the button. [StartTile.test, TodayPage.test T6]

**Replay**

- R1. The help strip under the Settings menu has "Getting started", linking to `/today?start=1`.
  [StartTile.test]
- R2. Opening `/today?start=1` puts the tile back at the top (fresh, nothing recorded) if it isn't
  showing, saves that, and drops `?start=1` from the address. [StartTile.test,
  e2e getting-started.spec]

**The start-here doc (slice 2)**

- H1. `GET /api/today/start-here` gives `{ doc: { path, title } | null }`: the Team-space doc an
  admin picked, with its title as it reads now; null when none is picked or the doc has gone.
  `PUT /api/today/start-here` with `{ link }` (a doc's link or address; null clears) is for
  admins only and refuses anything that isn't an existing Markdown doc in the Team space, keeping
  what was picked. [integration today-layout.test]
- H2. With a doc picked, the tile's last step says "Start with “<title>”." and its button, "Open
  it", records the step and opens that doc. With none, or when asking fails, it opens Docs as
  before. [StartTile.test, e2e getting-started.spec J2]
- H3. Settings → Workspace has a "Start-here doc" section after the weather city: what is picked
  (linked), a field to paste a doc's address, and Remove. The server's refusal shows as written.
  [StartTile.test, settingsPages.test]

Known and accepted: the picked doc doesn't follow a rename or move; it then reads as none and the
admin picks it again.

**Journey**

- J1. In a real browser: a new member opens Today and sees Getting started first; hides it; it
  stays gone after a reload; Settings → Getting started brings it back. [e2e getting-started.spec]

**Support materials**

- S1. The demo's sample data shows the tile; help pages (Today, Settings, Get started), the
  landing page's Today window and ARCHITECTURE §16 describe it. [grep, real-browser check]

## Shared files touched

`packages/format/src/today.ts`, `apps/server/src/today/{layout,service}.ts`,
`apps/web/src/apps/today/*`, `apps/web/src/routes/settings/SettingsLayout.tsx` (one link),
`apps/web/src/mocks/todayHandlers.ts`, `site/public/help/*`. Not `HOTSAUCE_VERSION`.

## Slices

1. Format and server (F1 to F5).
2. The tile, the Meetings button, the Mac card rule (T1 to T6).
3. Replay (R1, R2), the journey, mocks and support materials.
4. Own pull request: the admin's start-here doc (H1 to H3).
