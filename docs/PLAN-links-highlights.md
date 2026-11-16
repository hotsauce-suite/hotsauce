# Plan: highlights and notes in saved links

Status (2026-11-16): built; every requirement has a test (format unit, server integration, web, and the e2e journey "highlight a passage with a note…"). Step 3 of the Links roadmap Morgan accepted on 2026-11-15 (ideas
drawn from Omnivore, AGPL, so ideas only: no code from it). Built on the recommendations in the
thread (Q1 to Q8) while Morgan answers; change here if he picks otherwise.

Select text in a saved page to highlight it, optionally with a note. The highlights live in the
link's own file, so they are kept in its history, private while the link is private, and read by
search, Ask, Briefcast and connected AI tools. "Copy highlights to a Doc" turns a read into notes.

Recommended in the thread: everyone on a team link sees everyone's highlights, marked with who
made them, with "Show only mine" (Q1); Share with team takes your highlights along and says so
(Q2); one colour (Q3); a Highlights tab beside Unread and Archive, and "3 highlights" on list rows
(Q4); Copy highlights makes a new private doc each time (Q5); Briefcast reads your highlights on
the links it talks about (Q6); AI tools read highlights but can't add them (Q7); a note is your own
margin note with no @mentions or alerts, and conversations wait for comments (Q8).

## Requirements

R1. A highlight is an entry in the link file's frontmatter `highlights` list: `id` (ULID), `by`
    (the member's email, lower case), `at` (ISO instant), `quote` (the highlighted words, 1 to
    2,000 characters), `prefix` and `suffix` (up to 32 characters around it, to find it again),
    `block` (the top-level block it starts in), `note?` (up to 5,000 characters), `edited?`. A
    file keeps at most 500. Entries that don't parse are left in the file untouched and ignored.
R2. `POST /api/links/:space/:id/highlights {quote, prefix?, suffix?, block?, note?}` adds one as
    the calling member (201, the highlight). One commit `links: highlight "<title>"`. A space they
    can't see is 403, a link that isn't there 404, a bad body 400, the 501st 409.
R3. `PATCH …/highlights/:hid {note}` changes the note (empty removes it; sets `edited`);
    `DELETE …/highlights/:hid` removes it. Only the member who made it can change or delete it
    (403 otherwise). Commits `links: note|unhighlight "<title>"`.
R4. A fresh read of the page ("Get the page again", a better browser copy) never drops
    highlights; ones whose words are no longer in the copy still list, marked "not in the page
    any more".
R5. `GET /api/links/:space/:id` returns `highlights` (every one in the file, oldest first, each
    with its maker's `name`); every link view gives `highlightCount`. Share with team and Make private carry
    them along unchanged (they are in the file).
R6. `GET /api/links/highlights?q=&limit=` lists highlights across every link the member can see,
    newest first, each with its link's space, id, title and site.
R7. Search finds a link by the words of its highlights and notes (the index's text for a `link`
    adds them), so Ask and `search` see them too.
R8. MCP: `get_link` returns `highlights`; `list_links` gives the count; `list_highlights` (read
    only; `q`, `limit`) lists them like R6. Notes are described as the member's own words, quotes
    as someone else's page. No tool adds, changes or deletes a highlight.
R9. Briefcast's `<saved_links>` entries carry the listener's own highlights and notes on that
    link (up to 5, each cut to 300 characters), and the prompt says to lean on them, not read them
    out.
R10. `POST /api/links/:space/:id/highlights/doc` makes a new doc in the member's personal space:
    `docs/highlights-<title slug>.md` (a number added when taken), titled "Highlights: <title>",
    with links to the original page and the saved copy, then each highlight in page order as a
    quote, its note under it, and the name of a teammate who made it. 201 `{space, path}`. A link
    with no highlights is 409.
R11. Reader: selecting words in the copy shows "Highlight" and "Add note". Highlights show in the
    text (yours bright, teammates' softer); clicking one opens its note, Edit and Delete (yours) or
    who made it (theirs). A "Highlights" section under the article lists them with "Copy to a Doc" and, on a team
    link with others' highlights, "Show only mine". Works with a mouse, a finger and the keyboard.
R12. Links list: a Highlights tab beside Unread and Archive (R6), each opening the link at that
    passage; rows show "N highlights".
R13. Share with team on a link with your highlights says "Share with team (with your N
    highlights)".

## Slices

1. Format: schema, parse, add/patch/remove, search text, doc Markdown, finding a quote again
   (unit and fast-check tests).
2. Server: service, routes, index text, MCP, Briefcast (integration tests through the app).
3. Web: reader selection and marks, list tab and counts (web tests; Playwright for the journey).
4. Support: demo data, help page, landing page, ARCHITECTURE §23, STATUS, learnings.
