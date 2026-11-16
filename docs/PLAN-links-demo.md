# Links in the live demo

## Status

Built 2026-11-16. demo.hotsauce.work/links said "Couldn't load your links" because the demo's mock
API (`apps/web/src/mocks/`) had no Links routes. It now has them, with sample links that show every
shipped Links feature, plus Links screenshots for the README and a Links card on hotsauce.work.

## Requirements

Each is a test in `apps/web/src/mocks/linkHandlers.test.ts` unless it says otherwise.

1. **R1** Links opens in the demo with saved links, newest first, in Unread and Archive, with tags.
   Every id is a valid Hotsauce id.
2. **R2** Reading progress shows in all three states: part read ("42% read" with its bar), read to
   the end ("Read"), and not started. Reading on moves the progress.
3. **R3** Highlights with notes from more than one teammate, each found in the page's copy; the
   Highlights tab lists them; Copy highlights to a Doc makes a doc in the member's private space.
4. **R4** An arXiv paper with its PDF kept in Files (folder Links), a bioRxiv paper without a PDF
   (so Add the PDF shows), and a PDF added from a computer (no address).
5. **R5** Saving a new address shows "fetching" and then a stand-in copy (the demo can't visit
   pages); a link an AI tool saved waits for Get the page, which brings its copy back.
6. **R6** (real browser, by hand) the list, the reader, Get the page, Archive, Highlights, a new
   save, the bioRxiv reader and Copy to a Doc work in the demo build with no page errors.
7. **R7** (support materials) `docs/screenshots/links-{light,dark}.webp`; a Links card and window
   on hotsauce.work with its loop (`site/public/video/apps/links.mp4`, shot `links` in
   `scripts/tour-video/shots.mjs`).

## Notes

- The sample pages are written for the demo and use reserved `.example` addresses, so nothing
  points at a real article or invents a real paper.
- The mock answers `/api/links` like the server (`apps/server/src/api/saved-links.ts`); its
  reading places are per member, as on the server.
