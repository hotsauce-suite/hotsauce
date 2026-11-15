# Links (saved pages)

Learnings from the read-later list's readable copies (`apps/server/src/links/`).

- **"The page is JavaScript, so we can't read it" is usually wrong.** EA Forum looked
  client-rendered, but the whole post was in the HTML we fetched. React 18+ streaming SSR (Next.js
  app router, ForumMagnum sites like EA Forum and LessWrong) sends slow parts at the end in
  `<div hidden id="S:x">` blocks and moves them in with `$RC`/`$RS` scripts. Readability drops
  hidden elements, so all that was left was the header's logo link. `grep` the raw HTML for a
  sentence from the article before reaching for an API or a headless browser.
- **Reproduce with the real page.** `curl` the URL with the fetcher's user agent to a file and run
  `readPage` on it in a scratch vitest file; the bug shows in seconds and the fix can be checked
  against the real thing, then pinned with a small synthetic test.
- **Turndown nests links.** A logo `<img>` inside an `<a>` became `[[Picture](..)Words](..)`, which
  Markdown can't render, so the reader showed raw brackets. The link rule keeps the words (or the
  picture's label when there are none).
- **A fix to the reader doesn't fix links already saved.** Existing copies only change on a re-read,
  so short copies (under 150 words) now offer "Get the page again".
