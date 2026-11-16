# Making the apps look and act the same

Plan: `docs/PLAN-consistency.md`. Shared pieces: `apps/web/src/components/LoadError.tsx`,
`EmptyState.tsx`, `apps/web/src/hooks/useLoad.ts`. Test: `e2e/consistency.spec.ts`.

- **Build a new list with the shared pieces from the start.** Fifteen screens each wrote their own
  "couldn't load" line and empty message, and no two matched. A new app's list uses `useLoad`,
  `LoadError` and `EmptyState`, and gets a row in the `APPS` table of `e2e/consistency.spec.ts`.
- **Keep "the list failed" apart from "an action failed".** Most pages had one `error` string for
  both, so a failed load showed the server's sentence, and often the empty message under it
  ("No forms yet" when the forms simply hadn't loaded). The list's failure is its own boolean; the
  string stays for actions (create, delete, rename).
- **A failed load must never look empty.** Voice notes turned a failed request into an empty list
  and the Docs tree showed its loading bars for ever. Check the failed case of any list by hand:
  it is the one nobody sees while building.
- **Capturing every app's empty and failed screen needs no deploy.** In the e2e (a real server)
  `page.route` can fail or empty one GET; under the demo's mock service worker it cannot, so wrap
  `window.fetch` in an init script there.
- **The demo's sample data has no Clips, Tables, Links or Pages**, so those four can only be
  looked at against a real server.
- **The e2e needs the installed browser named**: `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`
  in a cloud session, or Playwright looks for the build the lockfile pins and every test fails
  at launch.
- **Files opens on the team space**, so its words are "the team files", not "your files".
- **A label lives in more places than the button.** Renaming "My files" meant the sidebar, the
  tabs, move menus, the file picker, an e2e role lookup, three help pages, the landing page's
  feature list and ARCHITECTURE. Grep the whole repository, not `apps/web`, before calling a
  wording change done.
- **Quick-add rows keep their verb.** The page's main button is "New task"; the inline row and
  the dialog's confirm button stay "Add task", because there you are adding the line you typed.
- **An app has two names.** `label` is the plain one people see (sidebar heading, page top bar,
  rail); `name` ("Hotsauce Tasks") stays for browser tab titles and accessible names, which read
  out of context. Use `label` for anything on screen inside the app.
- **Renaming an app is mostly outside the app.** "Whiteboard" to "Boards" touched the landing
  page card, the FAQ (twice, once in its search-engine data), llms.txt, four help pages, README
  and STATUS. The help page keeps its address (`/help/whiteboard`) so old links work.
- **A heading or button change means re-recording the site's app loops.** The loops in
  `site/public/video/apps/` show every app's sidebar heading and main button. They re-record
  headless in a cloud session in about ten minutes (`scripts/tour-video/README.md`, with
  `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`); `clipsPlayer` needs a prepared `DEMO_CLIP`
  and the narrated tour needs a voice key, so those two are separate jobs.

## Round 2: the top bar (Nov 16)

- **One shared piece per pattern, then move pages one at a time.** `PageHeader` (with `MainButton`,
  `MoreMenu`, `back`), `ShareButton` and the × in `Dialog` each landed in their own small PR with
  an e2e check that loops over every app. The loop is what found the stragglers; reading the code
  did not.
- **The "mobile" Playwright project runs only `mobile.spec.ts`.** Every other spec runs at
  computer width, so a control that moves behind More on a phone breaks no existing test and is
  covered by none. Phone behaviour needs its own tests with `test.use({ viewport })`
  (`e2e/consistency.spec.ts`, "a phone’s top bar").
- **A menu inside a pop-up: Escape must close one thing.** `Menu` and `Dialog` both listened for
  Escape on `document`, so a Share menu in the file pop-up closed both. `Menu` now takes Escape on
  the way down (capture) and stops it there. The same goes for a press on the button that opened
  the menu: the menu closes on pointerdown and the click reopens it unless the button remembers
  the menu was open when the press began (`openAtPress` in `ShareButton` and `MoreMenu`).
- **A menu unmounts what is inside it.** Anything that must outlive the menu (a dialog, a hidden
  file input, a confirm state) lives outside and the item only opens it. `SaveVersion` got
  `asked`/`onAsked` so the doc's More can open its dialog.
- **A toast that says who can open a link has to ask the server's rules.** The first Forms
  wording said "anyone with it" for team-only and closed forms; the independent review caught
  it by reading `forms/service.ts`. Write the wording from the access rule, and test it.
- **New spaces arrive after the page does.** Until `me` loads, `spaces` is a one-item stand-in, so
  a "New … in Team/Personal" button pressed early creates in the wrong place. Keep it disabled
  until `me` is there.
- **Titles on a phone: use the doc's heading.** `extractTitle` prefers the frontmatter title,
  which for a new doc is "Untitled" long after the heading changed. `DocumentView` already keeps
  the heading (`heading`, `openedHeading`) for the rename offer; the top bar reuses it.
- **Re-recording after a top-bar change** took about ten minutes for the fourteen loops, plus the
  eight README screenshots (`docs/learnings/website.md` has that recipe). `rec.mjs` needs
  `PLAYWRIGHT_CHROMIUM` even for a single shot, and a shot that presses a button by its old
  place or name fails loudly (Forms did), which is the reminder to update `shots.mjs`.

## Round 3: one row above every list (Nov 16)

- **One component, one loop of tests.** `components/ListBar.tsx` holds the row, the two widths
  (`ListColumn`), the list heading size and the All/Personal/Team tabs; `e2e/consistency.spec.ts`
  has a `LIST_ROWS` table that measures the row in every app on a computer and a phone. A new
  list page uses the component and adds one line to the table.
- **A filter in the address needs carrying.** Tabs kept in `?scope=` were lost the moment a note
  opened in its pop-up, because the pop-up changes the address. Anything that navigates from a
  filtered list has to pass the search part along (Notes keeps it in a ref).
- **Search and hidden filters multiply.** The first Meetings search looked only inside whatever
  the side list's filters had left, so a meeting could be "not found" while sitting in another
  space. A name search should look through everything and say when it is doing so. The same goes
  for what gets added while a search is on: clear the search, or the new thing is invisible.
- **Each filtered list needs three empty screens**: nothing at all (the intro), nothing under
  this tab, nothing matching the search. Guard every one with "not failed", or a load error and
  an empty message show together.
- **Tabs that are links must not act on arrow keys.** Moving focus with the arrows is fine;
  following the link on each press fills the Back history.
- **Where the big search went on a phone.** Moving a search field out of the top bar or side
  list can leave a phone with no way to the search that reads inside things. Check the phone
  after moving any search.
- **Two old tests failed on slow runs once this added load**, both for the same reason: they
  checked the screen the instant after changing something the page hears about a moment later.
  `Offline.test` saved a waiting draft while the app was still online, and the app's own
  start-up send took it; `LiveMeeting.test` read a notice before the page had drawn again.
  When a test fails once and passes alone, read the page dump in the CI log first: a stray
  notice in it named the cause. `console.log` is hidden in the web tests; write to a file to
  trace one.
- **Help search text is kept by hand.** `site/public/help/index.html` carries each page's words
  in `data-k`; a help page edit is not found by search until that line changes too.
- **Don't load the machine while recording.** A CPU-heavy job running beside `run.sh` made one
  loop fail without a clear error; it recorded fine alone.
- **Re-cutting the tour takes about half an hour of machine time** and no Mac: the five extra
  shots (`ask clipsRecorder clipsPlayer macSetup feedback`), then voice, captions, overlays and
  the cut. `DEMO_CLIP` has to be rebuilt each time (nothing keeps it): a generated face still
  with a slow zoom as the camera, `docs.mp4` as the screen, joined by the server's own
  `composite()`. Re-encode the cut at `-crf 27` for the site. YouTube cannot swap a video in
  place, so a new cut means a new upload and a new link in `site/public/index.html`.
