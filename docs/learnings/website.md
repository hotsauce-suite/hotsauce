# Learnings: the hotsauce.work site

- **The app demo loops come from the tour scripts.** `scripts/tour-video/run.sh` records each app as its own short MP4. Re-encoded at 1280 wide (`-crf 27 -an -movflags +faststart`), all thirteen come to about 1.9 MB, small enough to keep in `site/public/video/apps/` and load only when a card's window opens.
- **Check every feature claim against the code, not the README.** Reviews caught the README promising things the code doesn't do: live co-editing in Docs (it merges on save), speaker names during the call (they're matched afterwards), folder sharing in Files (file only), and a Clips summary that needs an Anthropic key too.
- **Cloudflare deployments need R2 for media.** "Works out of the box" is only true on your own server; say so in any "what it needs" copy.
- **Biome lints the inline scripts in index.html.** Function declarations inside a `{ }` block fail `noInnerDeclarations`, and an empty `<h3>` fails `useHeadingContent`. Run `biome ci site/public/index.html` before pushing.
- **The desktop app's browser pane doesn't fire a `<dialog>`'s `close` event.** Test dialog behavior in Playwright's Chromium instead; it behaves like real browsers.
- **`.stove-h:first-of-type` resets the top margin of the first `<h3>` in a section.** A heading added there needs a more specific selector to keep its margin.
- **The live demo is the web app's mock API built with `--mode demo`.** The site deploy builds it through `build` in `site/wrangler.jsonc`. Wrangler runs that command from wherever it was started, not from the config's folder, so the command finds the repo root itself. Write it as `root=$(git rev-parse --show-toplevel) && cd "$root"`: a bare `cd "$(git rev-parse …)"` turns into `cd ""` outside a repository and carries on running `pnpm install` in the wrong place.
- **`wrangler dev` makes the worker see the production hostname** (the first route), whatever host you browse to. Test the demo host with `wrangler dev --host demo.hotsauce.work`. It doesn't hot-reload when the build command is slow, so restart it after changes.
- **Workers assets redirect `/x/index.html` to `/x/`.** Fetch the folder path, or every app route turns into a 307.
- **A sibling subdomain in an iframe is same-site but cross-origin.** Storage and service workers work, but the microphone and the clipboard need `allow="microphone; clipboard-write"` on the iframe. Once focus is inside the frame, Escape goes to the framed app, so don't focus the frame for the visitor.
- **The help center is plain static pages with one list in `help/help.js`.** The sidebar and next/previous links are drawn from that list, so a new page is one file plus one line, and `site/help.test.js` fails if a page, its card on the help home page and its "coming soon" note disagree. Links are written without `.html` (`/help/docs`): Workers assets serve `docs.html` for them and redirect the `.html` form.
- **Write help for an unreleased feature behind `soon: true`.** It shows a "Coming in the next release" note and badge, so the help can be ready the day a feature ships without describing something the live product can't do yet. Take the flag off in the PR that releases the feature.
- **Settings for OpenAI and Turnstile are server environment only.** The Settings page covers the Anthropic and Deepgram keys; don't tell people to add the others there.

## Help pages drift when a feature ships in pieces (2026-11-13)

- The shortcuts page was written ahead with everything under "Coming in the next release". Slice 1
  of the keyboard work (the `?` sheet, ⌘J, the single-key switch) shipped in 0.8.1 and 0.9.0, but
  the page still called them "coming", because the `soon` flag is per page and the page wasn't
  flagged. A partly shipped feature needs its help page checked against the code
  (`apps/web/src/keyboard/catalog.ts` is the one list of keys) at each release, not only when the
  last slice lands.

## GitHub publishes the site (2026-11-16)

- **Deploys come from `.github/workflows/deploy-site.yml`, not a laptop.** Don't run
  `wrangler deploy` for hotsauce.work by hand; merge to main, or use "Run workflow" on the
  Actions page. Two deploy paths mean one can silently overwrite the other with an older build.
- **`x-site-version` says which commit is live.** `curl -sI https://hotsauce.work | grep x-site`
  answers "is my merge out yet?" in one line. A deploy without `--var SITE_VERSION:…` drops it.
- **`wrangler deploy --dry-run` runs the build and lists bindings without any Cloudflare login,**
  so the whole deploy path can be checked from a cloud session.
- **The demo build is reproducible:** a fresh build's `demo/index.html` matched the live one byte
  for byte, so comparing it is a real check that the demo went out.

## README screenshots (Nov 16)

- **Re-shoot them from the mock web app, not a real server.** `cd apps/web && VITE_MOCK_API=1 npx vite --port 5191`, sign in at `/sign-in` as `ada@example.test`, and shoot at 1600×1000 with Playwright's `colorScheme` set to light, then dark. Install the page clock at 7:50 AM so Today says "Good morning" and the next meeting is a minute away.
- **Linux shows "Ctrl K" in the search box.** The sidebar reads `navigator.platform`, not the user agent: add an init script that makes it `MacIntel` so the shots show ⌘K and the placeholder doesn't wrap.
- **The branded shot needs a brand the mock doesn't have.** Patch the `/api/org/brand` answer in `apps/web/src/mocks/handlers.ts` for the one shot (green primary, `modern` fonts, a data-URL `markUrl`), then put the file back. Don't commit it: the live demo uses the same mock.
- **Links has no demo data.** The live demo's Links page says it couldn't load, so there is no Links screenshot yet.
