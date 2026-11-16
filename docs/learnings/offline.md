# Offline mode

Learnings from step A (`docs/PLAN-offline.md`): the app opens offline, starts as the last member,
and Docs keep saves on the device.

- **`navigator.onLine` has already moved when its event fires.** A store that compares "before"
  and "after" by reading it inside the `offline` handler sees no change. Keep the browser's
  answer in your own variable, updated by the events.
- **"Online" isn't "the server answers".** The `online` event fires as soon as Wi-Fi joins, often
  before DNS or a VPN is up. Treat the app as offline until a request (or a small `/api/health`
  check) gets any answer, and have every request report "reached" or "couldn't connect".
- **In unit tests the fake server keeps answering.** A test that marks the app offline sees it
  flip back online at the next background request (feedback status, recents). Cut the network in
  the fake server too (`http.all('*', () => HttpResponse.error())`), and reset the connection
  state between tests.
- **Precache by what the bundle says, not by file names.** Vite's chunk names are arbitrary, and
  the build has ~400 chunks, most of them CodeMirror modes, Mermaid diagrams and Whiteboard
  locales. A small plugin reads the finished bundle (entry plus every lazy chunk whose entry
  module is in `src/`, and what they import) and filters workbox's list with
  `manifestTransforms`: 166 files, 4 MB uncompressed, instead of 14 MB.
- **React Router's `lazy()` loads the chunk before it renders**, so "a never-opened screen opens
  offline" is a real test of the precache: a missing chunk would show the error page, not the
  route.
- **Playwright's `context.setOffline` is enough for service-worker tests in Chromium.** Wait for
  `navigator.serviceWorker.controller` before cutting the network; reloads and `page.goto` are
  then answered by the worker.
- **Don't warn "leave site?" offline.** The draft is already on the device, and the warning
  blocks the reload you'd use to check it.
- **A draft offered for restore and a save waiting to be sent are different things.** A crash
  leaves the first (offer it); a save that couldn't connect leaves the second (send it by itself).
  One flag on the stored draft (`waiting`) keeps them apart without a second store.
- **The Mac app's WKWebView runs service workers on macOS**, for a remote https site too, with
  no App-Bound Domains entry (that's an iOS rule). It takes a little longer than Safari to
  install the worker on first load (about 20 to 40 s on Haven's site), so a Mac that goes offline
  in its first minute may not have it yet. A small Swift harness (WKWebView with a persistent
  `WKWebsiteDataStore(forIdentifier:)`, `callAsyncJavaScript` to read
  `navigator.serviceWorker.getRegistrations()`) answers this in a minute without building the app.
- **"Saved on this device" is a promise; make the store keep it.** Two audits found four ways to
  lose text in the first version: an owner downgraded to nobody when an expired session signed the
  member out mid-save; a save refused for good (doc moved) turned silently into an ordinary draft
  nobody would see; `clearDrafts` then `setItem` in one try, so a full storage lost the old copy
  too; and one draft slot per doc, so another member or another tab erased it. The fixes are all
  in the key and the write order: owner and tab in the key, write new before removing old, a
  `stranded` state with a place to see it, and an owner captured once and never cleared.
- **Offline needs a way to sign out.** Settings first showed "Not available offline yet", so Sign
  out was unreachable; and signing out offline only forgot the name, so the still-valid session
  came back on reconnect. A sign-out owed on the device, honoured before sign-in renders, fixes
  both. An e2e that actually presses Sign out offline found the first one.
- **In tests, wait until the app knows who's signed in** before cutting the network: the member
  is remembered after `/api/me` answers, and a test that goes offline sooner starts signed out.
