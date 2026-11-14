# Learnings: the app rail

- **Bigger rail items cost apps above the fold.** Going from 20px to 30px icons (and a 68px rail) means a 1280x800 window shows about 8 of 15 apps instead of 12. The scrollbar is hidden, so the list now fades out at the bottom (`data-more` on `rail-apps`) while more apps sit below. Any future size change should check the fold at 800px tall.
- **Bounding boxes are not whole pixels.** Playwright returned 67.99999 for a 4.25rem rail and 30.000001 for a 30px icon. Use `toBeCloseTo` or round before comparing.
- **The cloud sandbox's Chromium doesn't match this repo's Playwright.** Run e2e with `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium` (playwright.config.ts reads it).
- **To look at the demo locally,** `pnpm --filter @hearth/web build:demo` writes `site/public/demo`; serve it with any static server and open `/` (deep links 404 without the site worker's fallback).
- **`e2e/checkins.spec.ts` takes about two minutes** and failed once on a full run while other builds shared the CPU, then passed three times alone. If it fails again, look at its run time before blaming your change.
- **Pinning changed what e2e can click.** Specs that clicked an unpinned app on the rail (Dictate, Clips, Whiteboard) now go through the `openApp(page, id)` fixture, which opens the launcher. Use it for any app that isn't one of the default pins.
- **Module-level stores leak between unit tests.** `apps/pins.ts` keeps the pins in a module variable; `src/test/setup.ts` calls `forgetPins()` after each test, the way the tests already clear localStorage. A new store like it needs the same line.
- **jsdom has no `setPointerCapture` or `elementFromPoint`.** userEvent's click fires pointerdown, so a drag handler that captures the pointer must call it optionally, or every click in edit mode throws.
- **Fewer rail items moved the fold test.** With five pins the list only overflows on a very short window; the fade test now uses 380px tall.
- **Two checkouts running e2e on one Mac share a server.** `reuseExistingServer` is on outside CI, so a second run on port 3999 silently tests the first checkout's build (old icons, no launcher). Run with `E2E_PORT=4099 E2E_SETUP_PORT=4098` when another thread may be testing, and don't run `build:demo` while e2e runs: it rewrites `apps/web/dist` with the mock build.
