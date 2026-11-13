# Plan: Today header and tiles

## Status

Building, 2026-11-13. Branch `claude/project-thread-05iemt`. All slices are in progress in one PR.

## Decisions

These were settled with the owner on 2026-11-13. He accepted every recommendation and added weather.

- The header shows a live clock (in the computer's 12 or 24 hour setting), the weekday and date, a greeting, a "next up" line and the weather.
- The tiles are: Coming up, Tasks, From your meetings, Unfiled notes, Docs changed, Agent brief, Starred docs, Dictate, Record a clip, People, Recent files, Board and This week.
- Board is the only tile you can add more than once. Each copy shows the board you pick for it.
- Edit mode has "+ Add tile", a drag handle that moves tiles between the two columns, ✕ to remove, up and down arrows for phones and keyboards, and "Reset to default".
- The layout is per person and lives in Git, in the member's personal space at `.hearth/today.json`. It survives a reindex and follows the member to every device.
- The default layout is the one Today had before this change.
- Weather comes from MET Norway's free Locationforecast API, through the server, cached, with credit shown. The location is the browser's own position, asked for only when the member clicks "Show weather". It is kept on that device only, rounded to about 1 km.

## Requirements

Each requirement maps to a test, named in brackets.

**Header**

- H1: The header shows the time as hours and minutes, and the full weekday and date. It updates when the minute changes. [TodayHeader.test]
- H2: The greeting follows the hour of the day: morning before 12, afternoon before 17, evening otherwise. It uses the member's first name. [TodayHeader.test]
- H3: The next-up line names the next meeting that hasn't ended, as "Title in N min", "Title now", or "Title at 3:00 PM". A Join link appears when the meeting has a Meet link and starts within 15 minutes. With no more meetings, it says "No more meetings today". [TodayHeader.test]
- H4: The next-up line counts the tasks due today, and the overdue ones separately, for example "3 tasks due · 1 overdue". Zero shows nothing. [TodayHeader.test]
- H5: Weather is off until the member clicks "Show weather". The browser then asks for their location, and the header shows the current temperature, the conditions, and today's high and low. It uses °F for a US locale and °C everywhere else. If location is refused, the header says so quietly. [TodayHeader.test, weather.test]
- H6: `GET /api/today/weather?lat&lon` rounds the position to 2 decimals. It asks MET Norway with an identifying User-Agent and caches each place for 20 minutes. If MET fails, it answers 502 with a plain message. [server weather.test]

**Layout**

- L1: `packages/format` parses and serializes `.hearth/today.json`. It drops unknown tile kinds and duplicate single-use tiles, and keeps up to 40 tiles. Text that isn't a layout is an error. [format today.test]
- L2: `GET /api/today/layout` returns the member's saved layout, or the default when they have none. `PUT` validates and commits it to the member's personal space. A member with no personal space gets a clear 400. [integration today-layout.test]
- L3: With no saved layout, Today looks exactly as it did before. [TodayPage.test]

**Editing**

- E1: "Edit Today" turns on edit mode. "+ Add tile" lists only the tiles that aren't already shown, plus Board. Picking one adds it to the end of the shorter column. [TodayTiles.test]
- E2: ✕ removes a tile. The up and down arrows move it within its column, and "Move to other column" moves it across. Drag and drop does the same on a computer. [TodayTiles.test, layout logic test]
- E3: "Done" saves the layout. "Cancel" throws the changes away. "Reset to default" restores the default. A failed save shows an error and keeps edit mode open. [TodayTiles.test]
- E4: A Board tile with no board chosen asks you to pick one from your boards. [TodayTiles.test]

**New tiles**

- T1: Starred docs lists the member's starred items, linking to each one. [tiles test]
- T2: Dictate and Record a clip are one-click shortcuts to `/dictate` and `/clips/new`. [tiles test]
- T3: People lists up to 8 people, linking to their pages. Recent files lists up to 8 recent files. [tiles test]
- T4: Board shows the chosen board's title, when it was last changed, its first few words, and an Open link. [tiles test]
- T5: This week shows Monday to Sunday with meetings and due tasks on each day. Today is marked, and clicking a day shows that day's items. [tiles test]

**Journey**

- J1: In a real browser: open Today, check the clock is there, Edit Today, add Starred docs, move it up, Done, reload, and check the tile is still there. [e2e today-tiles.spec]

## Slices

1. Format and server: the layout file, the layout API and the weather API.
2. Web: the header.
3. Web: tiles split into their own files, the layout logic, edit mode, and the new tiles.
4. Mocks and demo sample data, the e2e journey, docs (ARCHITECTURE §16), and learnings.
