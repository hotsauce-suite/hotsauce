# Plan: help center and FAQ on hotsauce.work

Status: built 2026-11-13. Pages for features still in flight (phone install bar, Settings and
notifications, the AI assistant, one-click install, the new keyboard keys) are written ahead and
marked "coming soon"; each feature's PR removes the mark when it ships.

Before this there were no help docs: only eight FAQ entries at the bottom of the landing page and
the setup guides in the repository.

## Decisions (Morgan, 2026-11-13: "yes" to all four)

1. Help lives at `hotsauce.work/help` (a home page, one page per app, pages for the Mac app, the
   Chrome extension, agents and admins) and the FAQ at `hotsauce.work/faq`.
2. Written for teammates first; admins get their own section. Server setup stays in
   `docs/self-host.md` and `install.md`, linked from the help.
3. The landing page keeps its short FAQ and links to the full FAQ and the help center from the menu,
   under the FAQ and in the footer.
4. Features in flight get their pages now, marked "Coming in the next release" (Morgan: "write help
   docs for the new features now").

## Requirements (each checked by `site/help.test.js` unless noted)

1. Every page in `PAGES` (`site/public/help/help.js`) has a file `help/<slug>.html`, and every file is
   listed once.
2. Every page belongs to a group, and the help home page has exactly one card for it, in that group.
3. Every page has a title, a description, a canonical link, `data-page`, one `h1` and `help.js`.
4. A page marked `soon` shows the "Coming in the next release" note and a "Coming soon" card badge;
   a page not marked shows neither.
5. Every link to `/help/…` or `/faq` in the help and FAQ resolves to a page, and every `#section` to
   an `id` on it.
6. The FAQ's structured data lists every question, and each question has its own unique `id`.
7. The landing page links to `/help/` and `/faq`.
8. Search on the help home page hides cards that don't match and says so when nothing does
   (checked in a real browser).
9. Pages work at phone width with no sideways scrolling, in light and dark (checked in a real
   browser).

## Adding a page

See the comment at the top of `site/public/help/help.js`.
