# Phone shortcuts: Android, iPhone and the Mac Dock

Learnings from `docs/PLAN-phone-shortcuts.md`.

- **One list feeds three places.** The manifest, the Settings card and the Mac menus all come from
  `apps/web/src/lib/phoneShortcuts.ts`. `vite.config.ts` imports it, so the file has no imports of
  its own. The Mac copy is checked by reading the Swift file in a vitest, the same way
  `macRail.test.ts` checks Brand.swift. There's no Swift compiler in a cloud container; the Swift
  tests run only in the Mac app CI job on pull requests.
- **"Open straight into it" is a query parameter, cleared at once.** Read it in an effect on the
  search params, act on it, then `setSearch(rest, { replace: true })`. That way Back and reload
  don't repeat it. Don't read it in a `useState` initializer: the Mac app (and an Android window
  that's already open) changes the address in place with `pushState`, so the component doesn't
  mount again.
- **One-shot props need a reset.** Quick add is keyed by the list, so a "start Ramble" flag left
  `true` would fire again on the next list. The page sets it, and quick add calls
  `onRambleStarted` to clear it.
- **Pages holding a finished state need a key.** For the same in-place reason, the save page is
  keyed by `location.search`, or a second Save Link would show the first one's "Saved".
- **A page can't read the clipboard without a tap.** And it shouldn't save whatever was copied
  anyway, so the phone shortcut offers Paste and save. The Mac app reads its own clipboard and
  passes `url=`, but the page still asks first. Keep a paste box for browsers that won't share
  the clipboard: plain http, and WKWebView.
- **iPhone shortcuts open Safari, not the Home Screen app.** Safari has its own sign-in and
  microphone permission. Say so wherever the steps are given.
- **Swift `CharacterSet.alphanumerics` includes non-ASCII letters.** Use an explicit ASCII set
  when percent-encoding a query value.
