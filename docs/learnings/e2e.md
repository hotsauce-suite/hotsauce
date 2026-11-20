# Learnings: the browser tests (e2e)

- **When many unrelated specs flake at once, look at the server's reply times first.** The
  Playwright report's traces hold every request with its duration: on the bad runs `/api/me`
  took 2 to 4 s and saves 2 to 6 s, so specs failed wherever they waited on a save, not where
  they clicked. Read `*-trace.network` in the report zip (one JSON line per request, `time` in ms)
  before guessing at overlays or timeouts.
- **Endless CSS animation is not free in a headless browser.** CI's Chromium has no GPU, so every
  frame of the rail's pepper (sway, blink, the sleeping "z") and Today's sky is drawn in software.
  Measured with `ps` around a 10 s idle page: Today cost about 0.6 CPU core, Docs about 0.1, and
  0 with reduced motion. Two workers of that on a 4-core runner starved the server. The suite now
  asks for reduced motion in `playwright.config.ts`; specs about motion (switch ripple, Easter
  eggs, Hotsauce 101's playing loop) opt back in with `test.use({ reducedMotion: 'no-preference' })`.
- **Chrome's per-page metrics hide this.** CDP `Performance.getMetrics` only counts the page's main
  thread (0.3 s per 10 s on Today); the raster and compositor work is in other processes. Measure
  the browser's processes, not the page.
- **Turning motion off can show layout that only worked by accident.** `.shell-main`'s entrance
  animation (`fill: both`) leaves a transform on it, which makes it the box `position: fixed`
  children are placed in. The iPad side panel's `top: var(--topbar-height)` relied on that; with
  reduced motion it was placed against the window and covered the top bar under the install bar.
  `contain: layout` on `.shell-main` at tablet widths now says it outright.
- **Don't edit spec files while a run is going.** Workers load each file when they reach it, so a
  mid-run edit runs half old, half new code and reports confusing line numbers.
- **A `page.route` callback can outlive its spec.** If the page is still polling when the spec ends,
  `route.fetch()` throws "Test ended" and Playwright pins the error on the next spec in that
  worker, which then looks flaky for no reason of its own. Unroute with
  `page.unrouteAll({ behavior: 'ignoreErrors' })` in an `afterEach` (`e2e/app-update.spec.ts`).
