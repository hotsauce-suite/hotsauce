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
- **A browser copy is the member's view, not the public page.** The first cut let a member's
  signed-in copy replace a thin *team* link's copy, which could publish their account page to the
  whole team. Anything taken from a member's session belongs in their personal space only.
- **Re-reading must never make a copy worse.** A second save can arrive mid cookie-wall, and the
  server's fetch can fail that time; compare word counts before writing over a good copy.
- **Testing an extension in headless Chromium:** load `dist/` with `launchPersistentContext`
  (`--load-extension`), sign in through the dev form (extra headers don't reach the app's own
  session), and reach the worker with `context.serviceWorkers()`. Context menus and the toolbar
  popup can't be clicked, and without the `tabs` permission `tab.url` is empty, so a scratch copy
  of the build that exposes the save function on `globalThis` and adds `http://localhost/*` to
  `host_permissions` (standing in for `activeTab`) drives the real flow end to end.
- **A Web Store copy can find its server from the open tab.** Opening the popup grants
  `activeTab`, so a same-origin `fetch('/api/health')` run in the tab tells whether it is a
  Hotsauce page; no store ID, deep link or new permission needed. Show the host, not the page's
  self-reported name, in what the person agrees to.

- One-click save (extension 0.7.0): keeping the popup and having it save on open was simpler than removing `default_popup` for `action.onClicked`, which would have lost the popup's Connect and Take notes screens and needed `setPopup` juggling per tab. Opening the popup still grants `activeTab`, so the page copy keeps working. To test a popup's messages in Playwright, the popup is opened as a tab, so the worker's `!sender.tab` check rejects it: patch that check in a scratch copy only.
