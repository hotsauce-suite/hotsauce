# Plan: save the page as you see it

Status (2026-11-15): building. Step 1 of the Links roadmap Morgan accepted on 2026-11-15 (ideas
drawn from Omnivore, AGPL, so ideas only: no code from it). Steps 2 to 4 (reading position,
highlights, PDFs) get their own plans.

The server reads saved pages signed out, so paywalled, signed-in and script-built pages came out
thin (ARCHITECTURE §23.7). The Chrome extension already has the person's page open, rendered and
signed in, so it sends that page along and the server makes the readable copy from it. The
extension already holds `activeTab` and `scripting`, so no new permission is asked for.

Decided (Morgan, 2026-11-15, Q1 and Q2 in the thread): saving again from the browser replaces a
copy that failed or came out short; "Save link" on a right-clicked link keeps the server fetch.

## Requirements

R1. `POST /api/links` takes an optional `page: { html }`: the page as the member's browser shows
    it. Old clients that don't send it work as before; an old server ignores it.
R2. A new link saved with a page copy gets its readable copy from that copy, read against the
    link's own address, with no fetch by the server.
R3. A copy over 2 MB (UTF-8), or one that gives under 150 words, makes the server fetch the page
    as before and keep whichever copy has more words; when that fetch fails, the browser copy is
    kept if it has any words.
R4. Saving a link that is already saved, with a page copy, re-reads it from the copy when its copy
    failed or is under 150 words. A good copy is left alone.
R5. The page copy is treated like a fetched page: same size limit, same parser and element limit,
    never run, never written to Git as HTML. It is held in memory only until it is read, with at
    most 40 MB held in all (beyond that the server fetches instead).
R6. The extension's "Save page" (toolbar popup, keyboard shortcut, right-click on the page) takes
    the rendered page from the tab, without scripts, styles, frames and media, and hands it to the
    save tab it opened. "Save link" on a right-clicked link sends no copy. A page it can't read
    (Chrome's own pages, the Web Store, a PDF) or a copy still over 2 MB after trimming sends none.
R7. Only the save tab the worker opened gets the copy, once, through its `may-save` answer on the
    server's own pages; a copy not taken within ten minutes is dropped.
R8. The save page sends the copy with the save.

## Slices

1. Server: R1 to R5 (integration tests in `apps/server/test/integration/links.test.ts`).
2. Extension and save page: R6 to R8 (unit tests for the trimming and the hand-over, web test for
   the save page), then a real-browser check with the built extension.
3. Docs, help, landing page, release, store resubmission page for Morgan.
