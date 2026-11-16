# Making the apps look and act the same

Plan: `docs/PLAN-consistency.md`. Shared pieces: `apps/web/src/components/LoadError.tsx`,
`EmptyState.tsx`, `apps/web/src/hooks/useLoad.ts`. Test: `e2e/consistency.spec.ts`.

- **Build a new list with the shared pieces from the start.** Fourteen apps each wrote their own
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
