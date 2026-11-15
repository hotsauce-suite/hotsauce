# Plan: remember where you are in a saved link

Status (2026-11-15): built for release 0.16.0; every requirement has a test (server integration, web, and the e2e journey "a long read picks up where you left off"). Not covered: a copy read again can move the place a little (it is by block). Step 2 of the Links roadmap Morgan accepted on 2026-11-15
(ideas drawn from Omnivore, AGPL, so ideas only: no code from it). Steps 3 and 4 (highlights,
PDFs) get their own plans.

Opening a long saved article starts at the top every time, and the list can't tell an article
you've read half of from one you've never opened. The reader now keeps each member's place and
the list shows how far they got.

Recommended to Morgan in the thread (Q1 to Q5) and built on: the place is kept per member on the
server's volume, not in the link's file; each member has their own place on a team link; opening
a started link goes back to the place with "Start from the top"; the list shows a bar and
"40% read", or "Read" at the end; reaching the end doesn't mark a link Done, and a Done button
waits at the end of the article.

## Requirements

R1. `PUT /api/links/:space/:id/reading {anchor, percent}` saves the calling member's place in a
    link they can see: `anchor` is the index of the block of the readable copy at the top of
    their screen (0 or more), `percent` how far through the copy the bottom of their screen is
    (0 to 100). 204. A space they can't see is 403; a link that isn't there is 404; a bad body is
    400.
R2. The place belongs to the member (by user id) and the link (by id), so it survives "Share
    with team" and "Make private", and two members on one team link each have their own.
R3. `GET /api/links` and `GET /api/links/:space/:id` give each link `reading: {anchor, percent,
    furthest, updated} | null` for the calling member only. `furthest` is the most of the copy
    they have ever reached (it never goes down); `percent` and `anchor` are where they are now.
R4. Places live in `DATA_DIR/links-reading.sqlite` (in the nightly backup, not in Git or the
    index): a place changes every few seconds of reading, which would make a commit each time
    and would be shared by everyone on a team link. Deleting a link forgets every place in it.
R5. Opening a link with a place (anchor above 0) scrolls the reader to that block, or to the same
    percent when the copy has fewer blocks now, and says "Picked up where you left off" with a
    "Start from the top" button that scrolls up and saves the top.
R6. While reading, the reader saves the place at most every 3 seconds after scrolling stops, and
    once more when the page is hidden or left (`keepalive`). A failed save is silent and never
    interrupts reading. Nothing is saved before the copy is shown or while it is being fetched.
R7. The Links list shows, on a link the member has started (furthest above 0) and not finished,
    a thin progress bar and "N% read" in its line; at 95% or more it says "Read". Links never
    opened look as before.
R8. The end of the readable copy has a Done button (Move to Unread on an archived link), the same
    as the one at the top. Reaching the end never marks a link done by itself.
R9. MCP `list_links` and `get_link` include the member's `reading` (so an agent can find
    half-read pages). Nobody else's place is ever returned.

## Slices

1. Server store and service (R2, R3, R4), API route (R1), MCP (R9): unit tests on the store,
   integration tests through the app.
2. Web: reader saves and restores (R5, R6, R8), list shows progress (R7): web tests with MSW and
   a real-browser check.
3. Docs: ARCHITECTURE §23, help page, learnings. Release 0.16.0.
