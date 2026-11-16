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
