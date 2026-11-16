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
- **A short team doc's middle is its comment box.** Since comments sit under every team doc,
  clicking the centre of `editor-content` on a two-line doc lands in the comment composer, and
  the test types into the wrong box with no error. Click the doc's own text instead.
- **A storage key that includes the member can change while the page is open** (the app learns
  who's signed in after the first render). Carry what's typed over from the blank owner to the
  real one, or the box empties mid-word.
- **Every tab shares localStorage, but "the doc open here" is per tab.** Anything that sends what
  another tab left waiting has to know whether that tab is still open; a heartbeat key per tab is
  the boring answer that works in every browser.
- **After reconnecting, wait for the server, not the chip.** The page can reload on reconnect,
  and a fresh page starts on its default state before it sends the waiting text; poll the server
  for the text.
- **Decide offline at the key press, from the network path, not a request.** `NWPathMonitor`
  answers at once when Wi-Fi is off; a request to a dead server takes its whole timeout. A server
  that's up on the network but not answering is caught by the first failed dictation, and the
  next minute goes straight to the device.
- **A WebSocket that never said "ready" is talking to nobody.** The Mac app's stream waited 25 s
  after key-up before giving up; keying the timeout on "ready" (3 s without it) makes a dead
  server cost seconds, not half a minute.
- **The Speech Recognition prompt belongs to whoever launched the binary.** Running the app's
  executable from a shell attributes the permission to the shell; `open -n -a Hotsauce.app --args`
  makes it the app's own, so a probe tests the real thing (and its prompt waits for a person).
- **`say -o … --data-format=LEI16@16000` makes a test recording without a sound**, already in
  the 16 kHz mono format the app records in.
- **An optional field is the cheap way to add to a Codable record** that's already saved on
  people's Macs: a new `Bool?` decodes old files as nil; a non-optional with a default doesn't.
