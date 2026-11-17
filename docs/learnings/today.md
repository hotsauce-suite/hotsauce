# Learnings: Today

- **A stand-in layout must never be editable.** Today first showed the default layout while the saved one loaded, and Edit Today copied whatever was showing. A quick click (or a slow server) saved the default over the member's own layout. Hold editing until the real layout arrives, and make a failed load read-only.
- **`<Component />` is always truthy.** `const body = <TileBody />` followed by `body ? … : null` never hides anything, even when `TileBody` returns null. That left an empty wrapper (a 20 px gap) at the top of a column. Decide "hidden today" with a plain function before you make the element.
- **Capture `fetch` lazily in services that tests stub.** `deps.fetch ?? fetch` binds the real fetch when the app is built, so a later `vi.spyOn(globalThis, 'fetch')` doesn't take effect and the test quietly hits the network (here MET Norway really answered, which hid the bug). Use `(i, o) => globalThis.fetch(i, o)`.
- **MET Norway's Locationforecast is reachable from the cloud sandbox and needs no key.** It wants an identifying User-Agent and at most 4 decimals. It throttles per User-Agent, so a self-hosted instance's whole user base shares one budget: rate limit per member and cache failures.
- **`pointer-events-none` isn't "can't use".** Tab still reaches the links and inputs inside. Use `inert` (React 19 takes it as a boolean) for anything shown but not usable, such as tiles in edit mode.
- **Biome on main flags pre-existing problems** in `site/public/index.html`, `ramble.test.ts` and `briefHandlers.ts`. Lint the files you touched to see your own state, and don't "fix" theirs in a feature PR.

## Weather location (2026-11-14)

- **WebKit in a Mac app never asks for location.** `navigator.geolocation` in a WKWebView on macOS
  is turned down silently unless the app answers a private delegate call, and without a location
  usage description macOS has nothing to show. The Mac app answers the page itself
  (`hearthLocation` bridge, CoreLocation) instead of relying on that private API; check for the
  bridge before calling the browser's geolocation.
- **A refused permission must change the button, not repeat the request.** Retrying
  `getCurrentPosition` after a browser block fails instantly and looks like a dead click. Offer a
  way that doesn't need the permission (a typed city), and say where the switch is.
- **Don't open System Settings right after the person said no** in macOS's prompt. Open it only when
  the refusal is old and they asked again.
- **Old clients outlive the fix.** Detect a Mac app without the new bridge (it still has its
  sign-in bridge) and tell the member to update, rather than looping on a request it can't make.
- **On macOS, `requestWhenInUseAuthorization()` alone may never show the prompt.** The first
  Mac build waited on it and the owner saw nothing. Ask for a position (`requestLocation()`) at
  the same time: that reliably brings up the prompt and answers once they decide. The app now
  keeps its last steps in `defaults read dev.hotsauce.dictate locationSteps` for diagnosis.

## Free arranging on phones (2026-11-14)

- **A stacked layout is one list to the person, whatever the data says.** Below `lg` the two
  columns stack, so "move up" stopping at the top of the right column looked like a wall in the
  middle of the page. When a responsive layout changes what "next" means, the controls must follow
  what's on screen, not the stored structure. Swapping in the flat list while keeping each column's
  length keeps the desktop layout balanced.
- **A move across the break that only changes columns is invisible.** The first version moved the
  last left tile to the top of the right column: the phone order didn't change at all. Test
  stacked moves against the flat order, for every split, not against column contents.
- **HTML drag and drop is not a touch API.** iOS and Android won't drag a `draggable` element with a
  finger reliably. Use pointer events on a `touch-action: none` handle (the rest of the tile still
  scrolls the page), track one `pointerId`, use `elementFromPoint` for the target, and keep the last
  target when the finger is over a gap or the pinned bar, or letting go there silently drops
  nothing. Add `select-none` and `-webkit-touch-callout: none` near the handle: a long press that
  selects text cancels the pointer on iOS.
- **The dragged tile scrolls away from the finger.** Auto-scroll is needed for "free", and then the
  tile itself leaves the screen; a name tag that follows the finger keeps it clear what's held.
- **Real touch drags in Playwright:** CDP `Input.dispatchTouchEvent` (touchStart, touchMove,
  touchEnd) produces real pointer events with `pointerType: 'touch'` in Chromium; `page.touchscreen`
  only taps. It doesn't cover WebKit, so check iOS on a device.
- **This sandbox's Playwright browser path differs from the repo's pinned version.** A local,
  git-excluded config that spreads `playwright.config.ts` and sets
  `launchOptions.executablePath: '/opt/pw-browsers/chromium'` runs the e2e suite without a download.

## Getting started tile (2026-11-16)

- **A first-run prompt doesn't need its own state if it can be a thing the member already owns.**
  Getting started is a Today tile, so "skip" is removing a tile and "replay" is adding it back.
  The only new fact stored is a mark on a layout saved without the tile, and the serializer works
  that mark out from the tiles, so no caller can get it wrong.
- **"Offer it to everyone once" needs a way to tell "never saw it" from "removed it".** A saved
  layout without the tile is both. Writing the mark on every save from now on makes the files with
  neither tile nor mark exactly the ones from before the feature.
- **Calendars connect through Google sign-in; there is no connect button to send people to.** A
  member who signs in with an emailed code can't connect one. `meetings.connected` (false only for
  a missing grant) lets the page word that as a first step and keep "Google is down" as an error.
- **Adding to the default layout breaks every test that counts tiles.** Those tests are about a
  member arranging Today, so they now start by saving a layout (`todayApi.saveLayout(...)` in a
  `beforeEach`), which is what a member who hid the tile has. Put the new tile's own tests in a
  new file.
- **A step that ticks itself must know when it doesn't know.** `done: null` while a request is out
  keeps "all done" from firing on a guess, and a failed lookup counts as not done, never as done.
- **`src/routes/FeedbackScreenshots.test.tsx` (S7) times out in the cloud sandbox on unchanged
  main.** It passes in CI.
- **A setting that points at a doc should be resolved when read, not when saved.** The start-here
  doc is stored as a path and looked up on each read, so its title is always current and a doc
  that was deleted or moved reads as "none" (the step falls back to Docs) instead of a dead link.
  It doesn't follow a rename; the admin picks it again.
- **Pasting the doc's address beats building a doc picker** for a field one admin fills once. The
  server takes a full link or a bare address and says how to get one when it isn't a doc.
- **The Docs page opens in the editor**, so a browser test that opens a doc should look for the
  doc's text, not a heading role.
- **`page.waitForResponse` matches a request already on its way.** The journey test waited for
  "a layout PUT" before clicking, and on a slow runner got the answer to the save made a moment
  earlier, then reloaded and cut off the save it meant. It failed on every open pull request at
  once while passing locally. Match the request's body, not just its address.
- **That test was also pointing at a real race**: two saves in flight, and the older answer
  replaced the newer state. Today's saves now go out one at a time and only the newest answer is
  shown.
- **A browser test that changes a workspace-wide setting collides with itself** under
  `--repeat-each` with two workers. Run such a spec with `--workers=1` when repeating it.
- **hotsauce.work now redirects `/help/<page>.html` to `/help/<page>`.** A check of a help page
  after a site deploy needs `curl -L`, or it reads the empty redirect and reports the text missing.

## Weather forecast (2026-11-17)

- MET's compact forecast has no daily highs and lows and no 6-hour min/max: points are hourly
  for about 60 hours, then every 6 hours. A far-off day's high and low come from four samples, so
  they read a little milder than a full-day forecast. Good enough for a glance; don't promise more.
- Precipitation sits on each point for the period after it (1 hour or 6 hours). Pick the figure
  by the step to the next point, or a day's total double-counts where MET switches step.
- Group days in the browser, not on the server: the server doesn't know the member's time zone,
  and the cached answer is shared by everyone at that place.
- The demo's chip and its forecast come from one generated series, so they always agree. A fixed
  sample temperature next to a generated forecast looked broken in the first screenshot.
- After `pnpm install` in a fresh container, build `@hotsauce/format` before running web tests,
  or Vite can't resolve it.
