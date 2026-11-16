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
- **Per-member state on shared files doesn't belong in Git.** A reading place changes every few
  seconds and is one person's even on a team link; a commit per scroll would bury the history and
  share one place between everyone. A small SQLite file on the volume (like Dictate's) is backed
  up nightly and keyed by link id, so it survives a move between spaces.
- **Save a place by content, not pixels.** The same copy lays out differently on a phone and a
  laptop, so the place is the index of the block at the top of the screen, with a percent as the
  fallback when the copy changed.
- **You can't measure the page while unmounting.** React detaches refs and DOM before an effect's
  cleanup runs, so "save on leave" must send the place measured on the last scroll, not measure
  again.
- **jsdom lays nothing out and MSW drops `keepalive`.** Web tests check that a save was sent (spy
  on `fetch` for its `keepalive`), and the real place and scroll are checked in Playwright with a
  long stand-in page (`*.long.test` in `links/fake.ts`).
- **React Router reuses the page when only its address changes.** "Share with team" moves a link
  to `/links/team/:id` with the same reader, so anything keyed by `space/id` ran again: it
  restored the old place and sent the last save to the old space, which answered 404. Key by what
  really identifies the thing (the link id) and read the address from a ref.
- **A save sent as a page closes can lose the race to the next page's load.** The list keeps the
  places this tab sent lately and lays them over the server's when they're newer.
- **A pull request with a merge conflict runs no CI.** Pushes looked ignored; the PR was "dirty"
  because another release bumped `HOTSAUCE_VERSION`. Check `mergeable_state` before waiting on CI.

- **An address is an outbound channel.** Any server-side fetch of an address an AI tool chose can carry private text out in the query string, so "the agent saved it" must never mean "the server visits it". Key the rule on what is stored in the file (`source: mcp`, never fetched), not on the request, so it survives restarts and moves; and make every other path that schedules a read (re-save, move to team, the "lost after 3 minutes" fallback) check it too. The re-save path was the one that leaked first in the tests.
- **Fake only `Date` to test time-based states.** `vi.useFakeTimers({ toFake: ['Date'] })` plus `vi.setSystemTime` moves `new Date()` without freezing the git and fetch timers the integration tests need.

- **Draw highlights with the CSS Custom Highlight API, not `<mark>`.** The readable copy is React's
  DOM (react-markdown); splitting its text nodes into marks makes the next render throw or drop
  them. `CSS.highlights` paints live `Range`s with no DOM change, and a click is matched against
  `range.getClientRects()`. jsdom has neither `CSS.highlights` nor range boxes, so guard both and
  check the drawing in Playwright (`CSS.highlights.has(...)`).
- **Anchor a highlight by its words plus context, with the block as a tie-break.** The fake page
  repeats one sentence dozens of times; prefix/suffix alone can't tell copies apart at a
  paragraph start, the block index can. Text offsets come from `Range.toString()` lengths, which
  match a TreeWalker over text nodes exactly.
- **A new panel above the text moves the text.** Putting the Highlights list above the article
  pushed the page down the moment the first highlight saved, so a second click landed on the
  wrong line. It lives under the article now, with a jump link at the top.
- **`?? []` in a hook's dependency is a new array each render.** With a `setState(new Map())` in
  the effect it looped forever while the link loaded; use a module-level empty array and return
  the same state when nothing changed.
- **Playwright here needs `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`** in a cloud session:
  the repo pins a newer Playwright than the preinstalled browser.

- **bioRxiv and medRxiv refuse servers; their API doesn't.** From a cloud machine the
  `www.biorxiv.org` pages and PDFs answer with Cloudflare "error code: 1015" or a challenge, while
  `api.biorxiv.org/details/<server>/<doi>` and the `jatsxml` address it returns answer normally.
  Build on the API and JATS, and let the member add the PDF. Don't try a browser User-Agent to get
  past the robot check: it is evasion, and the session refuses it.
- **arXiv's API and web version answer servers fine.** `export.arxiv.org/api/query?id_list=` is
  Atom; an unknown id comes back as an entry titled "Error", not a 404. The web version
  (`arxiv.org/html/<id>vN`) is LaTeXML with MathML: flatten `<math>` to its `alttext` before
  Readability or formulas turn into strings of single letters.
- **linkedom's XML mode keeps the prefix in names.** `mml:math` and `arxiv:doi` don't match
  `querySelector('math')`; compare `localName` with the prefix cut off.
- **unpdf's document proxy has no `destroy()`** (call `cleanup()`), and pdf.js takes ownership of
  the buffer it's given, so pass a copy if you'll use the bytes again (to store them).
- **The API's 12 MB body limit rules out posting a 50 MB PDF.** Upload it through Files' chunked
  upload, then link to it by file id: one upload path, and the PDF lands in Files anyway.
- **Rebuilding a PDF's text needs positions, not just strings.** Paragraphs come from line gaps
  bigger than the page's usual gap, headings from size or numbering; drop lines repeated at the
  top or bottom of most pages, but never one that ends a sentence (a short repeated sentence is
  real text). Generate test PDFs in code (`links/test-pdf.ts`) rather than checking in binaries.
- **fast-check isn't a dependency here** (despite the plan template); a seeded loop over a few
  hundred generated ids covers round-trip properties well enough.
