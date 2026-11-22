# Learnings: the Chrome extension

- **Playwright's pinned headless shell can't load extensions.** In the cloud container, launch
  `/opt/pw-browsers/chromium` with `--headless=new`, `--disable-extensions-except=<dist>` and
  `--load-extension=<dist>` via `launchPersistentContext`; the service worker then shows up in
  `ctx.serviceWorkers()` and `chrome-extension://<id>/setup.html` opens like any page. Seed state
  with `sw.evaluate(() => chrome.storage.local.set(...))`. Chrome's permission prompts can't be
  answered there, so test Connect with stubs, not the real dialog.
- **A `display` rule beats the `hidden` attribute.** `button { display: inline-block }` or
  `form { display: flex }` silently showed "hidden" elements on the setup page. Every extension
  page needs `[hidden] { display: none !important }`.
- **Extension pages test well in vitest with linkedom.** Load the static HTML with `parseHTML`,
  put `window`/`document` on `globalThis`, stub `chrome` with a plain object, `vi.resetModules()`
  and `await import()` the page script per test. Fake only `setInterval`, so polling doesn't keep
  the run alive while `setTimeout` still flushes promises (`src/pages.test.ts`).
- **`registerContentScripts` only reaches pages loaded afterwards.** After Connect, an already
  open Hotsauce tab doesn't see the extension until it reloads; say so in the copy.
- **`HeadlessChrome/` in the user agent fails a `\bChrome\/` test**, so a headless check of
  "Chrome only" UI needs a real Chrome user agent set on the page.
- **What's per page and what's per server.** The Start page's "A meeting is being recorded" guard
  only knows the meetings recording in that page, so the Mac app and Chrome can record one call
  twice. The help says to use one or the other; a real guard would need the server.
- `chrome.action.getUserSettings().isOnToolbar` (pinned or not) and `chrome.management.getSelf()`
  (`installType` "normal"/"admin" = Web Store, "development" = Load unpacked) need no extra
  permission; `chrome://extensions/shortcuts` opens only through `chrome.tabs.create`.
