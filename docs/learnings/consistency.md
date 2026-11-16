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

